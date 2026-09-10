import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";

function read(path) {
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (
		value?.schemaVersion !== 1 ||
		!value.config ||
		!value.bodies ||
		!value.steps ||
		typeof value.steps !== "object" ||
		Array.isArray(value.steps) ||
		!Number.isFinite(Date.parse(value.createdAt))
	)
		throw new Error("manifest invalid");
	validateConfig(value.config);
	for (const label of ["B1", "B2", "B3"]) {
		const body = value.bodies[label];
		if (
			!body ||
			body.issueId !== value.config.issues[label] ||
			typeof body.idempotencyKey !== "string" ||
			!body.idempotencyKey.startsWith(
				`fly2456-${value.config.round}-${label}-`,
			) ||
			!/^[a-f0-9-]{36}$/.test(body.clientRequestId)
		)
			throw new Error("manifest body invalid");
	}
	if (value.auxiliaryBodies !== undefined) {
		const pre = value.auxiliaryBodies.PRE;
		if (
			Object.keys(value.auxiliaryBodies).join(",") !== "PRE" ||
			!pre ||
			!/^FLY-\d+$/.test(pre.issueId) ||
			typeof pre.idempotencyKey !== "string" ||
			!pre.idempotencyKey.startsWith(`fly2456-${value.config.round}-PRE-`) ||
			!/^[a-f0-9-]{36}$/.test(pre.clientRequestId)
		)
			throw new Error("auxiliary body invalid");
	}
	return value;
}
function locked(path, fn) {
	try {
		if (lstatSync(path).isSymbolicLink())
			throw new Error("manifest symlink refused");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const fd = openSync(`${path}.lock`, "wx", 0o600);
	try {
		return fn();
	} finally {
		closeSync(fd);
		unlinkSync(`${path}.lock`);
	}
}
function write(path, value) {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
		const fd = openSync(temp, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
		const directoryFd = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	} finally {
		if (existsSync(temp)) unlinkSync(temp);
	}
}
function requireEqual(actual, expected, reason) {
	if (!isDeepStrictEqual(actual, expected))
		throw new Error(`conflict: ${reason}`);
}
function validateConfig(config) {
	if (!isAbsolute(config.checkout))
		throw new Error("checkout must be absolute");
	if (!["r1", "r2"].includes(config.round)) throw new Error("round invalid");
	if (config.slot !== (config.round === "r1" ? 4 : 1))
		throw new Error("slot does not match round");
	if (!/^[a-f0-9]{40}$/.test(config.head)) throw new Error("head invalid");
	if (
		!config.issues ||
		Object.keys(config.issues).sort().join(",") !== "B1,B2,B3" ||
		!["B1", "B2", "B3"].every((label) =>
			/^FLY-\d+$/.test(config.issues[label]),
		) ||
		new Set(Object.values(config.issues)).size !== 3
	)
		throw new Error("issues invalid");
}
function init(path, config) {
	validateConfig(config);
	if (existsSync(path)) {
		const existing = read(path);
		requireEqual(existing.config, config, "manifest identity");
		return existing;
	}
	const bodies = Object.fromEntries(
		Object.entries(config.issues).map(([label, issueId]) => [
			label,
			{
				issueId,
				idempotencyKey: `fly2456-${config.round}-${label}-${randomUUID()}`,
				clientRequestId: randomUUID(),
			},
		]),
	);
	const manifest = {
		schemaVersion: 1,
		config,
		bodies,
		steps: {},
		createdAt: new Date().toISOString(),
	};
	write(path, manifest);
	return manifest;
}
function intent(path, step, detail) {
	if (!/^[a-zA-Z0-9_-]+$/.test(step)) throw new Error("step invalid");
	const manifest = read(path);
	if (manifest.steps[step]) {
		requireEqual(manifest.steps[step].intent.detail, detail, "intent");
		return manifest.steps[step].intent;
	}
	const body = detail.label
		? (manifest.bodies[detail.label] ??
			manifest.auxiliaryBodies?.[detail.label])
		: undefined;
	if (detail.label && !body) throw new Error("body invalid");
	if (body && detail.issueId !== undefined && detail.issueId !== body.issueId)
		throw new Error("intent issue conflict");
	validateCyclePreState(manifest, detail);
	const intent = {
		detail,
		createdAt: new Date().toISOString(),
		...(body
			? {
					idempotencyKey: body.idempotencyKey,
					clientRequestId: body.clientRequestId,
				}
			: {}),
	};
	manifest.steps[step] = { intent };
	write(path, manifest);
	return intent;
}
function receipt(path, step, result) {
	const manifest = read(path);
	const entry = manifest.steps[step];
	if (!entry?.intent) throw new Error("intent missing");
	if (entry.receipt) {
		requireEqual(entry.receipt.result, result, "receipt");
		return entry.receipt;
	}
	entry.receipt = { result, recordedAt: new Date().toISOString() };
	write(path, manifest);
	return entry.receipt;
}
export function manifestInit(path, config) {
	return locked(path, () => init(path, config));
}
export function manifestPreconditionBody(path, issueId) {
	return locked(path, () => {
		const manifest = read(path);
		if (!/^FLY-\d+$/.test(issueId)) throw new Error("auxiliary issue invalid");
		if (manifest.auxiliaryBodies?.PRE) {
			requireEqual(
				manifest.auxiliaryBodies.PRE.issueId,
				issueId,
				"precondition issue",
			);
			return manifest.auxiliaryBodies.PRE;
		}
		const body = {
			issueId,
			idempotencyKey: `fly2456-${manifest.config.round}-PRE-${randomUUID()}`,
			clientRequestId: randomUUID(),
		};
		manifest.auxiliaryBodies = { PRE: body };
		write(path, manifest);
		return body;
	});
}
export function manifestIntent(path, step, detail) {
	return locked(path, () => intent(path, step, detail));
}
export function manifestReceipt(path, step, result) {
	return locked(path, () => receipt(path, step, result));
}

export function validateCyclePreState(manifest, detail) {
	if (detail.kind === "cycle") {
		const p = detail.preState;
		if (
			!p ||
			!Number.isInteger(p.oldPid) ||
			p.oldPid <= 0 ||
			typeof p.oldLstart !== "string" ||
			!Number.isFinite(Date.parse(p.oldLstart)) ||
			!Array.isArray(p.listenerChain) ||
			!p.listenerChain.length ||
			!p.listenerChain.every(
				(x) =>
					Number.isInteger(x.pid) &&
					x.pid > 0 &&
					Number.isInteger(x.ppid) &&
					x.ppid > 0,
			) ||
			!Number.isInteger(p.logOffset) ||
			p.logOffset < 0 ||
			!Number.isInteger(p.bounds?.sessionEventsMaxId) ||
			p.bounds.sessionEventsMaxId < 0 ||
			!p.bounds.runEventMaxSeq ||
			typeof p.bounds.runEventMaxSeq !== "object" ||
			Array.isArray(p.bounds.runEventMaxSeq) ||
			!Object.keys(p.bounds.runEventMaxSeq).length ||
			!Object.values(p.bounds.runEventMaxSeq).every(
				(x) => Number.isInteger(x) && x >= 0,
			) ||
			!/^[a-f0-9]{64}$/.test(p.launchSpecSha256)
		)
			throw new Error("cycle pre-state incomplete");
		const runIds = ["B1", "B2", "B3"].map((label) => {
			const starts = Object.values(manifest.steps).filter(
				(entry) =>
					entry.intent.detail.kind === "start" &&
					entry.intent.detail.label === label &&
					entry.receipt,
			);
			if (
				starts.length !== 1 ||
				typeof starts[0].receipt.result.workflowRunId !== "string" ||
				!starts[0].receipt.result.workflowRunId
			)
				throw new Error("cycle body start receipt missing or ambiguous");
			return starts[0].receipt.result.workflowRunId;
		});
		if (
			new Set(runIds).size !== 3 ||
			!isDeepStrictEqual(
				[...runIds].sort(),
				Object.keys(p.bounds.runEventMaxSeq).sort(),
			)
		)
			throw new Error("cycle run bounds do not match body receipts");
	}
}
