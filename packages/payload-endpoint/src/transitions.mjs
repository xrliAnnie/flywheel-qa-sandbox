// FLY-1062 PR3 · transition classifier + server-owned stamping (plan §B0-6/
// B0-9/B0-10, Codex R3/R4/R5 rules).
//
// Given the CURRENT manifest and a CLIENT-submitted candidate, this module:
//   1. classifies the diff into named operations (the capability table's rows),
//      refusing every illegal shape (entry mutation, op state regression,
//      ledger drift not fused with a reservation, tombstone removal, …);
//   2. OVERWRITES every server-owned timestamp (publishedAt / retentionSince /
//      quarantinedAt / createdAt) from the injected clock — client-submitted
//      time values are never believed (Codex R4#3);
//   3. enforces the time-window guards (expire) with the same server clock.
//
// Output: { manifest (stamped, the version that gets persisted), ops, errs }.
import {
	baseOf,
	CHANNELS,
	isBetaSemver,
	latestSet,
	RETENTION_WINDOW_MS,
} from "./manifest.mjs";

const VERSION_CORE_FIELDS = [
	"sha256",
	"key",
	"size",
	"channel",
	"sourceCommit",
	"releaseId",
	"derivedFromBeta",
];

const OP_IDENTITY_FIELDS = ["kind", "ver", "betaVersion"];
const OP_TUPLE_FIELDS = ["sourceCommit", "sha256", "objectKey"];

const LEGAL_STATUS_MOVES = new Set([
	"active→quarantined",
	"active→expired",
	"quarantined→expired",
]);

const LEGAL_OP_MOVES = new Set([
	"reserved→prepared",
	"reserved→abandoned",
	"prepared→committed",
	"prepared→abandoned",
]);

export function applyTransition(oldM, clientM, now) {
	const errs = [];
	const ops = [];
	const err = (s) => errs.push(s);
	const nowIso = now().toISOString();

	// deep copy — we stamp onto this and never touch the caller's objects.
	const newM = structuredClone(clientM);
	if (!newM || typeof newM !== "object")
		return { manifest: newM, ops, errs: ["not an object"] };

	// ── channels → pointer ops ──────────────────────────────────────────────
	for (const ch of CHANNELS) {
		const oldLatest = oldM.channels?.[ch]?.latest ?? null;
		const newLatest = newM.channels?.[ch]?.latest ?? null;
		if (oldLatest !== newLatest) {
			ops.push({
				type: "pointer",
				channel: ch,
				from: oldLatest,
				to: newLatest,
			});
		}
	}

	// ── versions ────────────────────────────────────────────────────────────
	for (const ver of Object.keys(oldM.versions ?? {})) {
		if (!newM.versions?.[ver])
			err(`versions[${ver}]: entries are immutable (removal refused)`);
	}
	for (const [ver, nu] of Object.entries(newM.versions ?? {})) {
		const old = oldM.versions?.[ver];
		if (!old) {
			ops.push({ type: "addVersion", ver, channel: nu?.channel });
			continue;
		}
		for (const f of VERSION_CORE_FIELDS) {
			if (old[f] !== nu[f])
				err(`versions[${ver}]: core field ${f} is immutable`);
		}
		if (old.status !== nu.status) {
			const move = `${old.status}→${nu.status}`;
			if (!LEGAL_STATUS_MOVES.has(move)) {
				err(`versions[${ver}]: illegal status move ${move}`);
			} else if (nu.status === "quarantined") {
				ops.push({ type: "quarantine", ver });
			} else {
				ops.push({ type: "expire", ver, fromStatus: old.status });
			}
		}
	}

	// ── releaseOps ──────────────────────────────────────────────────────────
	for (const id of Object.keys(oldM.releaseOps ?? {})) {
		if (!newM.releaseOps?.[id])
			err(`releaseOps[${id}]: records are immutable (removal refused)`);
	}
	const reservedThisDiff = []; // beta reservations added in this diff (ledger fusion)
	for (const [id, nu] of Object.entries(newM.releaseOps ?? {})) {
		const old = oldM.releaseOps?.[id];
		if (!old) {
			if (nu?.state !== "reserved") {
				err(`releaseOps[${id}]: a new op must enter as reserved`);
				continue;
			}
			if (nu.kind === "beta") {
				ops.push({ type: "reserveBeta", id, ver: nu.ver });
				reservedThisDiff.push({ id, ver: nu.ver });
			} else {
				ops.push({ type: "reserveRelease", id, ver: nu.ver });
			}
			continue;
		}
		for (const f of OP_IDENTITY_FIELDS) {
			if (old[f] !== nu[f])
				err(`releaseOps[${id}]: identity field ${f} is immutable`);
		}
		const tupleChanged = OP_TUPLE_FIELDS.some((f) => old[f] !== nu[f]);
		if (tupleChanged) {
			if (old.state !== "reserved") {
				err(`releaseOps[${id}]: tuple registration only in reserved state`);
			}
			for (const f of OP_TUPLE_FIELDS) {
				if (old[f] !== null && old[f] !== nu[f]) {
					err(
						`releaseOps[${id}]: tuple field ${f} is write-once (was set, differs)`,
					);
				}
			}
			ops.push({ type: "registerTuple", id, kind: old.kind });
		}
		if (old.state !== nu.state) {
			const move = `${old.state}→${nu.state}`;
			if (!LEGAL_OP_MOVES.has(move)) {
				err(`releaseOps[${id}]: illegal state move ${move}`);
			} else if (nu.state === "prepared") {
				ops.push({ type: "toPrepared", id, kind: old.kind });
			} else if (nu.state === "abandoned") {
				ops.push({ type: "abandon", id, kind: old.kind });
			} else {
				ops.push({ type: "commitOp", id, kind: old.kind, ver: old.ver });
			}
		}
	}

	// ── releaseLedger: every change must be FUSED with a beta reservation ───
	// (plan §B0-9-1: reservation + increment in ONE CAS, so "ledger advanced
	// but reservation lost" is unrepresentable).
	const oldLedger = oldM.releaseLedger ?? {};
	const newLedger = newM.releaseLedger ?? {};
	for (const base of Object.keys(oldLedger)) {
		if (!(base in newLedger)) err(`releaseLedger[${base}]: removal refused`);
	}
	for (const [base, rec] of Object.entries(newLedger)) {
		const oldN = oldLedger[base]?.nextBetaN ?? 1;
		const newN = rec?.nextBetaN;
		if (!(base in oldLedger) || newN !== oldN) {
			// changed (or created) — must be exactly oldN+1 fused with a
			// reservation for `${base}-beta.${oldN}` in this same diff.
			const fused = reservedThisDiff.find(
				(r) => r.ver === `${base}-beta.${oldN}`,
			);
			if (!fused) {
				err(
					`releaseLedger[${base}]: change not fused with a beta reservation for N=${oldN}`,
				);
			} else if (newN !== oldN + 1) {
				err(
					`releaseLedger[${base}]: nextBetaN must advance exactly to ${oldN + 1}`,
				);
			}
		}
	}
	// every beta reservation must carry its ledger increment
	for (const r of reservedThisDiff) {
		if (!isBetaSemver(r.ver)) continue; // validator reports the grammar error
		const base = baseOf(r.ver);
		const oldN = oldLedger[base]?.nextBetaN ?? 1;
		if (r.ver !== `${base}-beta.${oldN}`) {
			err(
				`releaseOps[${r.id}]: reservation must take the ledger's next N (${oldN})`,
			);
		}
		if ((newLedger[base]?.nextBetaN ?? null) !== oldN + 1) {
			err(
				`releaseOps[${r.id}]: reservation must increment releaseLedger[${base}] in the same CAS`,
			);
		}
	}

	// ── tombstones: append-only set ─────────────────────────────────────────
	const oldT = new Set(oldM.tombstones ?? []);
	const newT = newM.tombstones ?? [];
	for (const t of oldT) {
		if (!newT.includes(t))
			err(`tombstones: removal of ${t} refused (monotonic)`);
	}
	for (const t of new Set(newT)) {
		if (!oldT.has(t)) ops.push({ type: "tombstone", key: t });
	}

	// ── server-owned stamping (Codex R4#3) ──────────────────────────────────
	const latestOld = latestSet(oldM);
	const latestNew = latestSet(newM);
	for (const [ver, e] of Object.entries(newM.versions ?? {})) {
		if (!e || typeof e !== "object") continue;
		const old = oldM.versions?.[ver];
		e.publishedAt = old ? old.publishedAt : nowIso;
		if (!old) {
			e.quarantinedAt = null;
		} else if (old.status === "active" && e.status === "quarantined") {
			e.quarantinedAt = nowIso;
		} else {
			e.quarantinedAt = old.quarantinedAt;
		}
		if (latestNew.has(ver)) {
			e.retentionSince = null; // current/pinned never expires (re-pin resets)
		} else if (!old) {
			e.retentionSince = nowIso; // born superseded
		} else if (latestOld.has(ver)) {
			e.retentionSince = nowIso; // left latest in THIS cas
		} else {
			e.retentionSince = old.retentionSince;
		}
	}
	for (const [id, op] of Object.entries(newM.releaseOps ?? {})) {
		if (!op || typeof op !== "object") continue;
		const old = oldM.releaseOps?.[id];
		op.createdAt = old ? old.createdAt : nowIso;
	}

	// ── expire window guard (server clock; plan §B0-10) ─────────────────────
	for (const op of ops) {
		if (op.type !== "expire") continue;
		const old = oldM.versions[op.ver];
		if (latestNew.has(op.ver)) {
			err(`versions[${op.ver}]: expire refused — still a channel latest`);
			continue;
		}
		const windowMs = RETENTION_WINDOW_MS[old.channel];
		const clockIso =
			old.status === "quarantined" ? old.quarantinedAt : old.retentionSince;
		if (!clockIso) {
			err(
				`versions[${op.ver}]: expire refused — no elapsed lifecycle clock (current/pinned?)`,
			);
			continue;
		}
		if (now().getTime() - Date.parse(clockIso) < windowMs) {
			err(`versions[${op.ver}]: expire refused — retention window not elapsed`);
		}
	}

	return { manifest: newM, ops, errs };
}

// capabilityAllows <capability> <op> — the B0-6 table, one row per op type.
export function capabilityAllows(capability, op) {
	switch (op.type) {
		case "pointer":
			return op.channel === "internal-beta"
				? capability === "beta-publish"
				: capability === "customer-release";
		case "addVersion":
			return op.channel === "beta"
				? capability === "beta-publish"
				: capability === "customer-release";
		case "commitOp":
			return op.kind === "beta"
				? capability === "beta-publish"
				: capability === "customer-release";
		case "reserveBeta":
		case "reserveRelease":
		case "registerTuple":
		case "toPrepared":
			return capability === "beta-publish";
		case "abandon":
			if (capability === "ops-admin") return true;
			return op.kind === "beta"
				? capability === "beta-publish"
				: capability === "customer-release";
		case "quarantine":
			return capability === "customer-release";
		case "expire":
		case "tombstone":
			return capability === "ops-admin";
		default:
			return false;
	}
}
