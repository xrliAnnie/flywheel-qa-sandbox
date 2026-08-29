#!/usr/bin/env node
// FLY-1062 PR3 · retention cleanup (plan §B0-10) — dry-run by default.
//
// Usage (token via env, NEVER argv):
//   FW_ENDPOINT=… FW_OPS_ADMIN_TOKEN=… node scripts/release/payload-cleanup.mjs [--apply]
//
// THE ORDER IS THE PROTOCOL (Codex R4#1 / R5#1 — never reorder):
//   ① EXPIRE    status→expired via manifest CAS (exits every view; the
//               endpoint re-enforces the pointer + window guards with ITS
//               clock — this script only proposes);
//   ② TOMBSTONE append to manifest.tombstones via CAS (the durable guard:
//               from this point the validator refuses every new reference
//               and PUT refuses resurrection);
//   ③ DELETE    physical R2 delete — ONLY for tombstoned keys, plus a FULL
//               SWEEP over the entire tombstone set every run (R5#2: crashed
//               deletes and slow-PUT resurrections converge here).
// Dangling pointers are structurally impossible in this order; orphan objects
// are retryable, so ③ failures are reported, never fatal.
import process from "node:process";

const ENDPOINT = (process.env.FW_ENDPOINT || "").replace(/\/+$/, "");
const TOKEN = process.env.FW_OPS_ADMIN_TOKEN || "";
const APPLY = process.argv.includes("--apply");

const WINDOW_MS = {
	beta: 14 * 24 * 60 * 60 * 1000,
	release: 28 * 24 * 60 * 60 * 1000,
};
const CAS_RETRIES = 5;

function log(msg) {
	console.log(`[payload-cleanup]${APPLY ? "" : "[dry-run]"} ${msg}`);
}

function die(msg) {
	console.error(`[payload-cleanup] ${msg}`);
	process.exit(1);
}

async function api(method, path, body) {
	const res = await fetch(`${ENDPOINT}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	let json = null;
	try {
		json = await res.json();
	} catch {}
	return { status: res.status, json, etag: res.headers.get("etag") };
}

async function readManifest() {
	const { status, json, etag } = await api("GET", "/admin/manifest");
	if (status !== 200) die(`cannot read manifest (HTTP ${status})`);
	return { manifest: json, etag };
}

function latestSet(m) {
	const s = new Set();
	for (const ch of Object.values(m.channels ?? {})) {
		if (typeof ch?.latest === "string") s.add(ch.latest);
	}
	return s;
}

// ── ① candidates: superseded past their window (endpoint re-enforces) ───────
function expireCandidates(m, nowMs) {
	const latest = latestSet(m);
	const out = [];
	for (const [ver, e] of Object.entries(m.versions ?? {})) {
		if (latest.has(ver)) continue; // current/pinned never expires
		const clockIso =
			e.status === "quarantined" ? e.quarantinedAt : e.retentionSince;
		if (e.status !== "active" && e.status !== "quarantined") continue;
		if (!clockIso) continue;
		if (nowMs - Date.parse(clockIso) >= WINDOW_MS[e.channel]) out.push(ver);
	}
	return out;
}

// ── ② candidates: object keys referenced ONLY by terminal records ────────────
function tombstoneCandidates(m) {
	const already = new Set(m.tombstones ?? []);
	const terminal = new Set();
	const live = new Set();
	for (const e of Object.values(m.versions ?? {})) {
		(e.status === "expired" ? terminal : live).add(e.key);
	}
	for (const [id, op] of Object.entries(m.releaseOps ?? {})) {
		if (!op.objectKey) continue;
		if (op.state === "abandoned") {
			terminal.add(op.objectKey);
		} else if (op.state === "committed") {
			// a committed op is terminal-deletable only when ITS entry expired —
			// which the versions loop above already classified by entry status.
			void id;
		} else {
			live.add(op.objectKey); // reserved / prepared
		}
	}
	return [...terminal].filter((k) => !live.has(k) && !already.has(k)).sort();
}

// CAS write with bounded re-read/re-judge retries (plan §B0-8).
async function casPost(mutate, describe) {
	for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
		const { manifest, etag } = await readManifest();
		const candidate = structuredClone(manifest);
		if (!mutate(candidate)) return { ok: true, skipped: true }; // no longer applicable
		const { status, json } = await api("POST", "/admin/manifest", {
			baseEtag: etag,
			manifest: candidate,
		});
		if (status === 200) return { ok: true };
		if (status === 412) continue; // lost the race — re-read and re-judge
		return {
			ok: false,
			status,
			error: json?.error,
			violations: json?.violations,
		};
	}
	return { ok: false, error: `CAS retries exhausted for ${describe}` };
}

async function main() {
	if (!ENDPOINT) die("FW_ENDPOINT env required");
	if (!TOKEN)
		die("FW_OPS_ADMIN_TOKEN env required (never pass tokens as arguments)");
	const nowMs = Date.now();
	const summary = { expired: 0, tombstoned: 0, deleted: 0, failures: [] };

	// ── phase ①: EXPIRE ───────────────────────────────────────────────────────
	{
		const { manifest } = await readManifest();
		const candidates = expireCandidates(manifest, nowMs);
		log(
			`expire candidates: ${candidates.length ? candidates.join(", ") : "(none)"}`,
		);
		if (APPLY) {
			for (const ver of candidates) {
				const res = await casPost((m) => {
					const e = m.versions[ver];
					if (!e || e.status === "expired") return false;
					e.status = "expired";
					return true;
				}, `expire ${ver}`);
				if (res.ok && !res.skipped) summary.expired++;
				if (!res.ok) {
					summary.failures.push(`expire ${ver}: ${res.error ?? res.status}`);
					log(
						`expire ${ver} REFUSED by endpoint (its clock/pointer guard wins): ${res.error ?? res.status}`,
					);
				}
			}
		}
	}

	// ── phase ②: TOMBSTONE (the durable guard — always before any delete) ────
	{
		const { manifest } = await readManifest();
		const candidates = tombstoneCandidates(manifest);
		log(
			`tombstone candidates: ${candidates.length ? candidates.join(", ") : "(none)"}`,
		);
		if (APPLY) {
			for (const key of candidates) {
				const res = await casPost((m) => {
					if ((m.tombstones ?? []).includes(key)) return false;
					// re-judge on the FRESH manifest: a concurrent prepare may have
					// re-claimed this key while we were working (barrier race) —
					// the validator would refuse anyway; skipping is the clean loss.
					if (!tombstoneCandidates(m).includes(key)) return false;
					m.tombstones.push(key);
					return true;
				}, `tombstone ${key}`);
				if (res.ok && !res.skipped) summary.tombstoned++;
				if (!res.ok)
					summary.failures.push(`tombstone ${key}: ${res.error ?? res.status}`);
			}
		}
	}

	// ── phase ③: DELETE — FULL SWEEP over the entire tombstone set ───────────
	// (not just this run's additions: R5#2 — crashed deletes and slow-PUT
	// resurrections are converged by replaying every tombstone every run.)
	{
		const { manifest } = await readManifest();
		const sweep = manifest.tombstones ?? [];
		log(`delete sweep over ${sweep.length} tombstone(s)`);
		if (APPLY) {
			for (const key of sweep) {
				const m = /^payloads\/([^/]+)\/([0-9a-f]{64})\.tgz$/.exec(key);
				if (!m) {
					summary.failures.push(`sweep: unparseable tombstone key ${key}`);
					continue;
				}
				const { status, json } = await api(
					"DELETE",
					`/admin/payload/${encodeURIComponent(m[1])}/${m[2]}`,
				);
				if (status === 200) summary.deleted++;
				else
					summary.failures.push(
						`delete ${key}: HTTP ${status} ${json?.error ?? ""}`,
					);
			}
		}
	}

	log(
		`done — expired=${summary.expired} tombstoned=${summary.tombstoned} deleted(sweep)=${summary.deleted} failures=${summary.failures.length}`,
	);
	for (const f of summary.failures) log(`  failure: ${f} (retryable next run)`);
	if (!APPLY) log("dry-run only — rerun with --apply to execute");
	process.exit(summary.failures.length ? 2 : 0);
}

main().catch((e) => die(e.message));
