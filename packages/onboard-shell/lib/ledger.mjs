import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSafeVersion, versionPrefix } from "./config.mjs";
import { pkgRootOf, verifyPkgRoot } from "./install.mjs";

export function emptyLedger() {
	return {
		schemaVersion: 1,
		knownGood: [],
		holds: {},
		pendingVersion: null,
		applying: null,
		lastRun: null,
		runs: [],
	};
}

const object = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const iso = (value) =>
	typeof value === "string" &&
	Number.isFinite(Date.parse(value)) &&
	new Date(value).toISOString() === value;
const nullableVersion = (value) => value === null || isSafeVersion(value);
const trigger = (value) => value === "timer" || value === "manual";
const reasons = ["health_failed", "manual_rollback", "withdrawn_observed"];
const outcomes = [
	"updated",
	"up_to_date",
	"held",
	"deferred",
	"paused",
	"rolled_back",
	"degraded",
	"unauthorized",
	"error",
	"settled",
];
const keys = (value, allowed) =>
	Object.keys(value).every((key) => allowed.includes(key));

function validApplying(a) {
	if (
		!object(a) ||
		!keys(a, [
			"operation",
			"ver",
			"fromVer",
			"fromPkgRoot",
			"targetCreated",
			"phase",
			"holdOutgoingReason",
			"clearHoldOnVer",
			"startedAt",
			"trigger",
		]) ||
		!["update", "rollback", "install_version"].includes(a.operation) ||
		!isSafeVersion(a.ver) ||
		!nullableVersion(a.fromVer) ||
		!(
			a.fromPkgRoot === null ||
			(typeof a.fromPkgRoot === "string" && path.isAbsolute(a.fromPkgRoot))
		) ||
		typeof a.targetCreated !== "boolean" ||
		!["installing", "flipped", "recovering"].includes(a.phase) ||
		!iso(a.startedAt) ||
		!trigger(a.trigger)
	)
		return false;
	if (a.fromPkgRoot !== null && a.fromVer === null) return false;
	if (
		a.holdOutgoingReason !== null &&
		!(
			a.operation === "rollback" &&
			a.holdOutgoingReason === "manual_rollback" &&
			a.fromVer !== null
		)
	)
		return false;
	if (
		a.clearHoldOnVer !== null &&
		!(a.operation === "install_version" && a.clearHoldOnVer === a.ver)
	)
		return false;
	return true;
}

function validRun(run) {
	return (
		object(run) &&
		keys(run, ["at", "trigger", "outcome", "latest", "detail"]) &&
		iso(run.at) &&
		trigger(run.trigger) &&
		outcomes.includes(run.outcome) &&
		nullableVersion(run.latest) &&
		typeof run.detail === "string"
	);
}

function validLedger(value) {
	return (
		object(value) &&
		keys(value, [
			"schemaVersion",
			"knownGood",
			"holds",
			"pendingVersion",
			"applying",
			"lastRun",
			"runs",
			"nextApplyAt",
		]) &&
		value.schemaVersion === 1 &&
		Array.isArray(value.knownGood) &&
		value.knownGood.length <= 10 &&
		value.knownGood.every(
			(g) =>
				object(g) &&
				keys(g, ["ver", "at", "origin"]) &&
				isSafeVersion(g.ver) &&
				iso(g.at) &&
				["health", "outgoing"].includes(g.origin),
		) &&
		Array.isArray(value.runs) &&
		value.runs.length <= 30 &&
		value.runs.every(validRun) &&
		object(value.holds) &&
		Object.entries(value.holds).every(
			([ver, hold]) =>
				isSafeVersion(ver) &&
				object(hold) &&
				keys(hold, ["reason", "at", "attempts", "lastAttemptId"]) &&
				reasons.includes(hold.reason) &&
				iso(hold.at) &&
				Number.isSafeInteger(hold.attempts) &&
				hold.attempts >= 1 &&
				iso(hold.lastAttemptId),
		) &&
		nullableVersion(value.pendingVersion) &&
		(value.nextApplyAt === undefined ||
			value.nextApplyAt === null ||
			iso(value.nextApplyAt)) &&
		(value.applying === null || validApplying(value.applying)) &&
		(value.lastRun === null || validRun(value.lastRun))
	);
}

export function readLedger(cfg) {
	try {
		const ledger = JSON.parse(
			fs.readFileSync(path.join(cfg.stateDir, "update-ledger.json"), "utf8"),
		);
		return validLedger(ledger)
			? { state: "valid", ledger }
			: { state: "corrupt", ledger: null };
	} catch (error) {
		if (error.code === "ENOENT")
			return { state: "missing", ledger: emptyLedger() };
		return { state: "corrupt", ledger: null };
	}
}

export function writeLedger(cfg, ledger, { fsImpl = fs } = {}) {
	if (!validLedger(ledger)) throw new Error("invalid update ledger");
	fsImpl.mkdirSync(cfg.stateDir, { recursive: true });
	const file = path.join(cfg.stateDir, "update-ledger.json");
	const temp = `${file}.tmp-${randomUUID()}`;
	try {
		fsImpl.writeFileSync(temp, `${JSON.stringify(ledger)}\n`, {
			mode: 0o644,
			flag: "wx",
		});
		fsImpl.renameSync(temp, file);
	} finally {
		fsImpl.rmSync(temp, { force: true });
	}
}

export function setHold(
	ledger,
	ver,
	reason,
	at = new Date().toISOString(),
	attemptId = at,
) {
	if (
		!isSafeVersion(ver) ||
		!reasons.includes(reason) ||
		!iso(at) ||
		!iso(attemptId)
	)
		throw new Error("invalid hold receipt");
	const previous = Object.hasOwn(ledger.holds, ver) ? ledger.holds[ver] : null;
	if (previous?.lastAttemptId === attemptId) return;
	ledger.holds[ver] = {
		reason,
		at,
		attempts: (previous?.attempts ?? 0) + 1,
		lastAttemptId: attemptId,
	};
}

export function clearHold(ledger, ver) {
	delete ledger.holds[ver];
}

export function holdBlocks(ledger, ver, now = Date.now()) {
	const hold = Object.hasOwn(ledger.holds, ver) ? ledger.holds[ver] : null;
	if (!hold) return false;
	return (
		hold.reason !== "health_failed" ||
		hold.attempts >= 2 ||
		Number(now) - Date.parse(hold.at) < 3600000
	);
}

export function addKnownGood(
	ledger,
	ver,
	origin,
	at = new Date().toISOString(),
) {
	if (
		!isSafeVersion(ver) ||
		!["health", "outgoing"].includes(origin) ||
		!iso(at)
	)
		throw new Error("invalid known-good record");
	ledger.knownGood = [
		...ledger.knownGood.filter((g) => g.ver !== ver),
		{ ver, origin, at },
	].slice(-10);
}

export function recordRun(ledger, run) {
	if (!validRun(run)) throw new Error("invalid update run");
	ledger.lastRun = { ...run };
	ledger.runs = [...ledger.runs, { ...run }].slice(-30);
}

// Success replays only the durable intent, never caller-supplied transient flags.
export function commitApplySuccess(
	cfg,
	ledger,
	{ at = new Date().toISOString(), outcome = "updated", fsImpl = fs } = {},
) {
	const stored = readLedger(cfg);
	if (stored.state !== "valid" || !stored.ledger.applying)
		throw new Error("missing durable apply intent");
	const next = stored.ledger;
	const applying = next.applying;
	if (applying.holdOutgoingReason !== null)
		setHold(
			next,
			applying.fromVer,
			applying.holdOutgoingReason,
			at,
			applying.startedAt,
		);
	if (applying.clearHoldOnVer !== null)
		clearHold(next, applying.clearHoldOnVer);
	if (
		applying.fromVer !== null &&
		applying.fromVer !== applying.ver &&
		!Object.hasOwn(next.holds, applying.fromVer)
	)
		addKnownGood(next, applying.fromVer, "outgoing", at);
	addKnownGood(next, applying.ver, "health", at);
	next.applying = null;
	next.pendingVersion = null;
	next.nextApplyAt = null;
	recordRun(next, {
		at,
		trigger: applying.trigger,
		outcome,
		latest: applying.ver,
		detail: "",
	});
	writeLedger(cfg, next, { fsImpl });
	Object.assign(ledger, next);
}

export function previousGood(cfg, ledger, current) {
	if (!validLedger(ledger)) throw new Error("invalid update ledger");
	for (const known of [...ledger.knownGood].reverse()) {
		if (known.ver === current || Object.hasOwn(ledger.holds, known.ver))
			continue;
		const pkgRoot = pkgRootOf(versionPrefix(cfg, known.ver));
		if (!pkgRoot) continue;
		try {
			verifyPkgRoot(pkgRoot, known.ver);
		} catch {
			continue;
		}
		return { ver: known.ver, pkgRoot };
	}
	return null;
}

export function setApplying(cfg, ledger, applying, options = {}) {
	const next = { ...ledger, applying: structuredClone(applying) };
	writeLedger(cfg, next, options);
	ledger.applying = next.applying;
}

export function clearApplying(cfg, ledger, options = {}) {
	setApplying(cfg, ledger, null, options);
}
