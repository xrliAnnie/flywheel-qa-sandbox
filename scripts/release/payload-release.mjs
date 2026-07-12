#!/usr/bin/env node
// FLY-1062 PR4 · beta payload release (plan §B0-9, the beta line).
//
// Usage (tokens via env, NEVER argv):
//   FW_ENDPOINT=… FW_BETA_PUBLISH_TOKEN=… node scripts/release/payload-release.mjs \
//     [--release-id <id>] [--repo-root <dir>]
//
// releaseId is the FIRST input of every publish operation (CI default:
// gh-run-<GITHUB_RUN_ID>; a local retry passes the SAME id explicitly). Every
// step is one manifest CAS; a rerun with the same id is idempotent end to end:
//   1. RESERVE   op {kind:beta, state:reserved, ver: base-beta.N} + ledger
//                N→N+1, ONE CAS (same id ⇒ same pinned ver, forever)
//   2. REGISTER  tuple (sourceCommit/sha256/objectKey) BEFORE the upload —
//                every staging object is discoverable from the manifest
//                (Codex R4#2: crash orphans have zero blind spots)
//   3. UPLOAD    immutable PUT (409 tolerated) + streamed readback verify
//                → reserved→prepared
//   4. COMMIT    versions entry + internal-beta pointer + op→committed, ONE
//                CAS (the single commit point; retention stamps are
//                server-owned)
// Failure at any point leaves zero half-published state; the packer's own
// release gates run inside the build step.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	baseOf,
	makeClient,
	payloadKeyOf,
	sha256File,
	testAbortPoint,
	tupleMatches,
} from "./lib/endpoint-client.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function die(msg) {
	console.error(`[payload-release] ${msg}`);
	process.exit(1);
}
const log = (m) => console.log(`[payload-release] ${m}`);

function argValue(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
	const endpoint = process.env.FW_ENDPOINT || "";
	const token = process.env.FW_BETA_PUBLISH_TOKEN || "";
	if (!endpoint) die("FW_ENDPOINT env required");
	if (!token)
		die("FW_BETA_PUBLISH_TOKEN env required (never pass tokens as arguments)");
	const repoRoot = path.resolve(
		argValue("repo-root", path.join(SELF_DIR, "..", "..")),
	);
	const packer =
		process.env.FW_PACKER ||
		path.join(repoRoot, "scripts", "package-onboard.sh");

	const client = makeClient({ endpoint, token, log });
	const base = fs
		.readFileSync(path.join(repoRoot, "doc", "VERSION"), "utf8")
		.trim()
		.replace(/^v/, "");
	const sourceCommit = execFileSync(
		"git",
		["-C", repoRoot, "rev-parse", "HEAD"],
		{
			encoding: "utf8",
		},
	).trim();

	// releaseId (plan §3 ⑤): a DISPATCH may force a fresh beta with an explicit
	// --release-id; a SCHEDULED run derives a DETERMINISTIC id keyed on the HEAD
	// sourceCommit (beta-<sourceCommit>), so any scheduled fire / crash-retry
	// for the same commit reuses the same reservation → B0-9 idempotency
	// converges (no second beta.N; a mid-flight crash resumes, not duplicates).
	const releaseId = argValue("release-id", `beta-${sourceCommit}`);

	// dedup (plan §3 ⑤ fast path): if this exact sourceCommit already has a
	// COMMITTED beta, an idle-main scheduled run does nothing. A --release-id
	// dispatch is an explicit force and skips the dedup.
	if (!argValue("release-id", "")) {
		const { manifest } = await client.readManifest();
		const already = Object.values(manifest?.releaseOps ?? {}).find(
			(op) =>
				op.kind === "beta" &&
				op.state === "committed" &&
				op.sourceCommit === sourceCommit,
		);
		if (already) {
			log(
				`sourceCommit ${sourceCommit} already published as ${already.ver} — nothing to do (dedup)`,
			);
			return;
		}
	}

	// ── 1. RESERVE (or reuse — same releaseId always yields the same ver) ────
	let pinnedVer = null;
	await client.casUpdate((m) => {
		const op = m.releaseOps[releaseId];
		if (op) {
			if (op.kind !== "beta")
				throw new Error(`releaseId ${releaseId} is a ${op.kind} op`);
			if (op.state === "abandoned")
				throw new Error(`releaseId ${releaseId} was abandoned`);
			if (baseOf(op.ver) !== base) {
				throw new Error(
					`releaseId ${releaseId} pinned ${op.ver}, but doc/VERSION base is ${base}`,
				);
			}
			pinnedVer = op.ver;
			return false; // reservation already durable
		}
		const n = m.releaseLedger[base]?.nextBetaN ?? 1;
		pinnedVer = `${base}-beta.${n}`;
		m.releaseOps[releaseId] = {
			kind: "beta",
			state: "reserved",
			ver: pinnedVer,
			betaVersion: null,
			sourceCommit: null,
			sha256: null,
			objectKey: null,
			createdAt: new Date().toISOString(), // server re-stamps
		};
		m.releaseLedger[base] = { nextBetaN: n + 1 };
		return true;
	}, "reserve");
	log(`reservation: ${releaseId} → ${pinnedVer}`);
	testAbortPoint("reserve");

	// short-circuit: already committed (rerun after a lost final response)
	{
		const { manifest } = await client.readManifest();
		const op = manifest.releaseOps[releaseId];
		if (op.state === "committed") {
			log(
				`releaseId ${releaseId} already committed as ${op.ver} — idempotent success`,
			);
			return;
		}
	}

	// ── 2. BUILD (packer gates inside) + REGISTER the tuple pre-upload ──────
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-payload-release-"));
	let tarball;
	try {
		const stdout = execFileSync(
			"bash",
			[packer, "--repo-root", repoRoot, "--out", outDir],
			{
				encoding: "utf8",
				env: { ...process.env, PO_RELEASE_VERSION: pinnedVer },
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		tarball = stdout.trim().split("\n").pop();
	} catch (e) {
		die(`build failed (packer gates are fail-closed): ${e.message}`);
	}
	if (!tarball || !fs.existsSync(tarball))
		die(`packer did not produce a tarball (${tarball})`);
	const sha = await sha256File(tarball);
	const size = fs.statSync(tarball).size;
	const objectKey = payloadKeyOf(pinnedVer, sha);
	log(`built ${pinnedVer}: sha256=${sha} size=${size}`);

	await client.casUpdate((m) => {
		const op = m.releaseOps[releaseId];
		if (op.state === "committed") return false;
		const tuple = { sourceCommit, sha256: sha, objectKey };
		if (op.sha256 !== null || op.sourceCommit !== null) {
			if (!tupleMatches(op, tuple)) {
				throw new Error(
					`releaseId ${releaseId} already registered a DIFFERENT tuple — fail-closed (never overwrite a durable claim)`,
				);
			}
			return false; // already registered, byte-equal
		}
		Object.assign(op, tuple);
		return true;
	}, "register-tuple");
	log("tuple registered (staging object now discoverable from the manifest)");
	testAbortPoint("register");

	// ── 3. UPLOAD (immutable; 409 tolerated) + readback → prepared ──────────
	{
		const { manifest } = await client.readManifest();
		if (manifest.releaseOps[releaseId].state === "reserved") {
			const st = await client.uploadPayload(pinnedVer, sha, tarball);
			log(
				st === 409
					? "object already present (retry) — verifying via readback"
					: "uploaded",
			);
			testAbortPoint("upload");
			await client.readbackVerify(pinnedVer, sha);
			log("readback verified (streamed hash matches)");
			await client.casUpdate((m) => {
				const op = m.releaseOps[releaseId];
				if (op.state !== "reserved") return false; // already advanced
				op.state = "prepared";
				return true;
			}, "to-prepared");
		}
	}
	testAbortPoint("prepared");

	// ── 4. COMMIT — entry + pointer + op, ONE CAS ────────────────────────────
	await client.casUpdate((m) => {
		const op = m.releaseOps[releaseId];
		if (op.state === "committed") {
			if (!tupleMatches(op, { sourceCommit, sha256: sha, objectKey })) {
				throw new Error(
					`releaseId ${releaseId} committed with a different tuple — fail-closed`,
				);
			}
			return false; // lost-response rerun: already done
		}
		if (op.state !== "prepared")
			throw new Error(`cannot commit from state ${op.state}`);
		m.versions[pinnedVer] = {
			sha256: sha,
			key: objectKey,
			size,
			publishedAt: new Date().toISOString(), // server re-stamps
			channel: "beta",
			status: "active",
			sourceCommit,
			releaseId,
			derivedFromBeta: null,
			retentionSince: null,
			quarantinedAt: null,
		};
		m.channels["internal-beta"].latest = pinnedVer;
		op.state = "committed";
		return true;
	}, "commit");
	log(
		`COMMITTED: internal-beta.latest = ${pinnedVer} (releaseId ${releaseId})`,
	);
}

main().catch((e) => die(e.message));
