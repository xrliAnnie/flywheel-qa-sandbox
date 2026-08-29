// FLY-1062 PR3 · full-state manifest validator (plan §B0-2 invariants 1-8).
//
// Every write path runs this over the WHOLE candidate manifest — all the
// relational invariants live in one document, so they are machine-checkable
// and atomically true or the write is refused. Returns a list of violation
// strings (empty = valid). Pure: no clock (time-window judgments are
// transition concerns, see transitions.mjs).
import {
	baseOf,
	CHANNEL_OF_POINTER,
	CHANNELS,
	isBetaSemver,
	isCleanSemver,
	isHex,
	isIso,
	isPayloadSemver,
	latestSet,
	OP_KINDS,
	OP_STATES,
	payloadObjectKey,
	VERSION_STATUSES,
} from "./manifest.mjs";

function isPlainObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateManifest(m) {
	const errs = [];
	const err = (s) => errs.push(s);

	if (!isPlainObject(m)) return ["manifest is not an object"];
	if (m.schemaVersion !== 1) err("schemaVersion must be 1");
	if (!isPlainObject(m.channels)) err("channels missing");
	if (!isPlainObject(m.versions)) err("versions missing");
	if (!isPlainObject(m.releaseOps)) err("releaseOps missing");
	if (!isPlainObject(m.releaseLedger)) err("releaseLedger missing");
	if (!Array.isArray(m.tombstones)) err("tombstones missing");
	if (errs.length) return errs;

	const chKeys = Object.keys(m.channels).sort();
	if (chKeys.join(",") !== [...CHANNELS].sort().join(",")) {
		err(`channels must be exactly ${CHANNELS.join(" + ")}`);
	}

	// ── version entries ────────────────────────────────────────────────────
	const releaseIdToVer = new Map();
	for (const [ver, e] of Object.entries(m.versions)) {
		const at = `versions[${ver}]`;
		if (!isPayloadSemver(ver)) {
			err(`${at}: not a payload semver`);
			continue;
		}
		if (!isPlainObject(e)) {
			err(`${at}: not an object`);
			continue;
		}
		if (!isHex(e.sha256, 64)) err(`${at}: sha256 must be 64 hex`);
		if (e.key !== payloadObjectKey(ver, e.sha256)) {
			err(`${at}: key must be the derived payloads/<ver>/<sha256>.tgz form`);
		}
		if (!Number.isInteger(e.size) || e.size <= 0)
			err(`${at}: size must be a positive integer`);
		if (!isIso(e.publishedAt)) err(`${at}: publishedAt must be ISO`);
		if (e.channel !== "beta" && e.channel !== "release")
			err(`${at}: channel must be beta|release`);
		if (e.channel === "beta" && !isBetaSemver(ver))
			err(`${at}: beta entry must be X.Y.Z-beta.N`);
		if (e.channel === "release" && !isCleanSemver(ver))
			err(`${at}: release entry must be X.Y.Z`);
		if (!VERSION_STATUSES.includes(e.status)) err(`${at}: bad status`);
		if (!isHex(e.sourceCommit, 40)) err(`${at}: sourceCommit must be 40 hex`);
		if (typeof e.releaseId !== "string" || !e.releaseId)
			err(`${at}: releaseId required`);
		if (releaseIdToVer.has(e.releaseId)) {
			err(`${at}: releaseId ${e.releaseId} is not unique across versions`);
		}
		releaseIdToVer.set(e.releaseId, ver);
		if (e.channel === "beta") {
			if (e.derivedFromBeta !== null)
				err(`${at}: beta entry must have derivedFromBeta null`);
		} else {
			// lineage (invariant 6)
			const db = m.versions[e.derivedFromBeta];
			if (typeof e.derivedFromBeta !== "string" || !db) {
				err(`${at}: derivedFromBeta must reference an existing beta entry`);
			} else {
				if (db.channel !== "beta")
					err(`${at}: derivedFromBeta is not a beta entry`);
				if (baseOf(e.derivedFromBeta) !== ver)
					err(`${at}: derivedFromBeta base mismatch`);
				if (db.sourceCommit !== e.sourceCommit) {
					err(`${at}: sourceCommit differs from its beta (lineage broken)`);
				}
			}
		}
		if (e.retentionSince !== null && !isIso(e.retentionSince)) {
			err(`${at}: retentionSince must be null or ISO`);
		}
		if (e.quarantinedAt !== null && !isIso(e.quarantinedAt)) {
			err(`${at}: quarantinedAt must be null or ISO`);
		}
		if (e.status === "quarantined" && e.quarantinedAt === null) {
			err(`${at}: quarantined entry must carry quarantinedAt`);
		}
	}

	// ── channel pointers (invariant 1) ─────────────────────────────────────
	for (const ch of CHANNELS) {
		const spec = m.channels[ch];
		if (
			!isPlainObject(spec) ||
			(spec.latest !== null && typeof spec.latest !== "string")
		) {
			err(`channels[${ch}]: latest must be a string or null`);
			continue;
		}
		const wantChannel = CHANNEL_OF_POINTER[ch];
		if (spec.latest === null) {
			const any = Object.values(m.versions).some(
				(e) => e?.channel === wantChannel,
			);
			if (any)
				err(`channels[${ch}]: latest null but ${wantChannel} entries exist`);
			continue;
		}
		const e = m.versions[spec.latest];
		if (!e) {
			err(`channels[${ch}]: latest ${spec.latest} has no entry (dangling)`);
			continue;
		}
		if (e.status !== "active")
			err(`channels[${ch}]: latest ${spec.latest} is not active`);
		if (e.channel !== wantChannel)
			err(`channels[${ch}]: latest ${spec.latest} channel mismatch`);
	}

	// ── pointer-tenure (invariant 5) ───────────────────────────────────────
	const latest = latestSet(m);
	for (const [ver, e] of Object.entries(m.versions)) {
		if (!isPlainObject(e)) continue;
		if (latest.has(ver)) {
			if (e.retentionSince !== null) {
				err(
					`versions[${ver}]: is a latest but retentionSince is set (must be null)`,
				);
			}
		} else if (e.status === "active" && e.retentionSince === null) {
			err(`versions[${ver}]: active non-latest must carry retentionSince`);
		}
	}

	// ── releaseLedger (invariant 4 static half) ────────────────────────────
	for (const [base, rec] of Object.entries(m.releaseLedger)) {
		if (!isCleanSemver(base))
			err(`releaseLedger[${base}]: key must be a clean base semver`);
		if (
			!isPlainObject(rec) ||
			!Number.isInteger(rec.nextBetaN) ||
			rec.nextBetaN < 1
		) {
			err(`releaseLedger[${base}]: nextBetaN must be an integer ≥1`);
		}
	}

	// ── releaseOps (invariant 7) ───────────────────────────────────────────
	const committedOpIds = new Set();
	for (const [id, op] of Object.entries(m.releaseOps)) {
		const at = `releaseOps[${id}]`;
		if (!isPlainObject(op)) {
			err(`${at}: not an object`);
			continue;
		}
		if (!OP_KINDS.includes(op.kind)) err(`${at}: bad kind`);
		if (!OP_STATES.includes(op.state)) err(`${at}: bad state`);
		if (op.kind === "beta") {
			if (!isBetaSemver(op.ver)) err(`${at}: beta op ver must be X.Y.Z-beta.N`);
			if (op.betaVersion !== null)
				err(`${at}: beta op must have betaVersion null`);
		} else if (op.kind === "release") {
			if (!isCleanSemver(op.ver)) err(`${at}: release op ver must be X.Y.Z`);
			if (!isBetaSemver(op.betaVersion))
				err(`${at}: release op must pin its betaVersion`);
			else if (baseOf(op.betaVersion) !== op.ver)
				err(`${at}: betaVersion base mismatch`);
		}
		if (op.sourceCommit !== null && !isHex(op.sourceCommit, 40)) {
			err(`${at}: sourceCommit must be null or 40 hex`);
		}
		if (op.sha256 !== null && !isHex(op.sha256, 64))
			err(`${at}: sha256 must be null or 64 hex`);
		if ((op.sha256 === null) !== (op.objectKey === null)) {
			err(
				`${at}: sha256 and objectKey register together (paired or both null)`,
			);
		}
		if (op.objectKey !== null) {
			if (
				op.sha256 === null ||
				op.objectKey !== payloadObjectKey(op.ver, op.sha256)
			) {
				err(`${at}: objectKey must be the derived form of (ver, sha256)`);
			}
		}
		if (!isIso(op.createdAt)) err(`${at}: createdAt must be ISO`);
		if (op.state === "prepared" || op.state === "committed") {
			if (
				op.sourceCommit === null ||
				op.sha256 === null ||
				op.objectKey === null
			) {
				err(`${at}: ${op.state} op must carry the full tuple`);
			}
		}
		if (op.state === "committed") committedOpIds.add(id);
	}

	// committed ↔ entry bijection (invariant 7): each entry's releaseId is a
	// committed op with a byte-matching tuple; each committed op has an entry.
	for (const [id, ver] of releaseIdToVer) {
		const op = m.releaseOps[id];
		const e = m.versions[ver];
		if (!op) {
			err(`versions[${ver}]: releaseId ${id} has no releaseOps record`);
			continue;
		}
		if (op.state !== "committed") {
			err(
				`versions[${ver}]: releaseId ${id} op is ${op.state}, must be committed`,
			);
			continue;
		}
		if (op.ver !== ver) err(`releaseOps[${id}]: ver ${op.ver} != entry ${ver}`);
		if (op.sha256 !== e.sha256)
			err(`releaseOps[${id}]: sha256 differs from its entry`);
		if (op.objectKey !== e.key)
			err(`releaseOps[${id}]: objectKey differs from its entry`);
		if (op.sourceCommit !== e.sourceCommit) {
			err(`releaseOps[${id}]: sourceCommit differs from its entry`);
		}
		const kindChannel = op.kind === "beta" ? "beta" : "release";
		if (e.channel !== kindChannel)
			err(`releaseOps[${id}]: kind/channel mismatch with entry`);
		if (op.kind === "release" && op.betaVersion !== e.derivedFromBeta) {
			err(`releaseOps[${id}]: betaVersion differs from entry derivedFromBeta`);
		}
	}
	for (const id of committedOpIds) {
		if (!releaseIdToVer.has(id)) {
			err(`releaseOps[${id}]: committed but no versions entry references it`);
		}
	}

	// ── tombstones (invariant 8: set semantics + terminal-refs-only) ───────
	const seen = new Set();
	for (const t of m.tombstones) {
		if (typeof t !== "string" || !/^payloads\/.+\.tgz$/.test(t)) {
			err(`tombstones: bad entry ${JSON.stringify(t)}`);
			continue;
		}
		if (seen.has(t)) err(`tombstones: duplicate ${t} (set semantics)`);
		seen.add(t);
		for (const [ver, e] of Object.entries(m.versions)) {
			if (e?.key === t && e.status !== "expired") {
				err(
					`tombstones: ${t} still referenced by non-expired versions[${ver}]`,
				);
			}
		}
		for (const [id, op] of Object.entries(m.releaseOps)) {
			if (op?.objectKey !== t) continue;
			if (op.state === "abandoned") continue;
			if (op.state === "committed") {
				const ver = releaseIdToVer.get(id);
				const e = ver ? m.versions[ver] : null;
				if (e && e.status === "expired") continue;
			}
			err(
				`tombstones: ${t} still referenced by live releaseOps[${id}] (${op.state})`,
			);
		}
	}

	return errs;
}

// isEmptyInitialManifest — the ONLY shape conditional create accepts
// (plan §B0-7: dual-channel null + empty tables).
export function isEmptyInitialManifest(m) {
	return (
		validateManifest(m).length === 0 &&
		m.channels["internal-beta"].latest === null &&
		m.channels["customer-release"].latest === null &&
		Object.keys(m.versions).length === 0 &&
		Object.keys(m.releaseOps).length === 0 &&
		Object.keys(m.releaseLedger).length === 0 &&
		m.tombstones.length === 0
	);
}
