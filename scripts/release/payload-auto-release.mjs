#!/usr/bin/env node
// Zero-build, narrow-capability executor. Dispatch inputs identify a candidate;
// only the Bridge's durable decision deposited at the endpoint permits a CAS.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	deriveVetoBinding,
	payloadObjectKey,
	validateManifest,
} from "../../packages/release-contract/src/index.mjs";
import { normalizeEtag } from "./lib/endpoint-client.mjs";
import { isReleaseId } from "./lib/release-id.mjs";

const bindingFields = [
	"releaseId",
	"betaVersion",
	"betaPayloadSha256",
	"releaseVersion",
	"releasePayloadSha256",
	"sourceCommit",
];
const attemptFields = [
	"attemptId",
	"cycleId",
	"projectId",
	"audience",
	"activationEpoch",
	"nonce",
	"baseEtag",
	"readyAt",
	"fullBinding",
	"readbackSha256",
];
const id = (value) =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const hex = (value) =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = (value) =>
	typeof value === "string" &&
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function need(condition) {
	if (!condition) throw Error("release executor validation failed");
}
function orderedBinding(binding) {
	need(
		binding &&
			Object.keys(binding).length === bindingFields.length &&
			bindingFields.every((k) => Object.hasOwn(binding, k)),
	);
	return Object.fromEntries(bindingFields.map((k) => [k, binding[k]]));
}
function digest(binding) {
	return createHash("sha256")
		.update(JSON.stringify(orderedBinding(binding)))
		.digest("hex");
}
function bound(attempt, input) {
	need(
		attempt &&
			Object.keys(attempt).length === attemptFields.length &&
			attemptFields.every((k) => Object.hasOwn(attempt, k)) &&
			uuid(attempt.attemptId) &&
			attempt.cycleId === input.cycleId &&
			attempt.projectId === "flywheel" &&
			id(attempt.audience) &&
			Number.isSafeInteger(attempt.activationEpoch) &&
			attempt.activationEpoch >= 0 &&
			hex(attempt.nonce) &&
			Number.isSafeInteger(attempt.readyAt) &&
			attempt.fullBinding?.releaseId === input.releaseId &&
			digest(attempt.fullBinding) === input.bindingDigest &&
			attempt.readbackSha256 === attempt.fullBinding.releasePayloadSha256,
	);
	need(normalizeEtag(attempt.baseEtag) === attempt.baseEtag);
	if (input.attemptId) need(input.attemptId === attempt.attemptId);
	if (input.expectedSha256)
		need(input.expectedSha256 === attempt.fullBinding.releasePayloadSha256);
	return attempt;
}
async function json(response, max = 8 * 1024 * 1024) {
	need(response.body);
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.byteLength;
		need(size <= max);
		chunks.push(Buffer.from(chunk));
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw Error("release executor response invalid");
	}
}
function client(endpoint, token, fetchImpl) {
	const url = new URL(endpoint);
	need(
		!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			url.pathname === "/" &&
			(url.protocol === "https:" ||
				(url.protocol === "http:" &&
					["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))),
	);
	need(
		typeof token === "string" &&
			token.length > 0 &&
			token.length <= 4096 &&
			!/[\r\n]/.test(token),
	);
	return async (method, route, body) => {
		try {
			return await fetchImpl(`${url.origin}${route}`, {
				method,
				redirect: "error",
				signal: AbortSignal.timeout(10000),
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw Error("release executor transport unavailable");
		}
	};
}
function summary(input, kind, attempt, extra = {}) {
	return {
		kind,
		cycleId: input.cycleId,
		releaseId: input.releaseId,
		...(attempt ? { attemptId: attempt.attemptId } : {}),
		...extra,
	};
}
function resultSummary(result, attempt, permit, input) {
	need(
		result &&
			permit &&
			result.attemptId === attempt.attemptId &&
			result.decisionId === permit.decisionId &&
			result.nonce === attempt.nonce &&
			result.baseEtag === attempt.baseEtag,
	);
	need(["published", "fenced", "unknown", "no_write"].includes(result.kind));
	if (result.kind === "no_write")
		need(["guard_rejected", "cas_conflict"].includes(result.reason));
	if (["published", "fenced"].includes(result.kind)) {
		const m = result.manifest,
			b = attempt.fullBinding,
			op = m?.releaseOps?.[b.releaseId];
		need(
			m &&
				validateManifest(m).length === 0 &&
				normalizeEtag(result.manifestEtag) !== attempt.baseEtag &&
				op?.kind === "release" &&
				op.state ===
					(result.kind === "published" ? "committed" : "abandoned") &&
				op.ver === b.releaseVersion &&
				op.betaVersion === b.betaVersion &&
				op.sourceCommit === b.sourceCommit &&
				op.sha256 === b.releasePayloadSha256 &&
				op.objectKey ===
					payloadObjectKey(b.releaseVersion, b.releasePayloadSha256) &&
				m.versions[b.betaVersion]?.sha256 === b.betaPayloadSha256,
		);
		if (result.kind === "published")
			need(
				m.versions[b.releaseVersion]?.releaseId === b.releaseId &&
					m.versions[b.releaseVersion]?.sha256 === b.releasePayloadSha256,
			);
	}
	return summary(
		input,
		result.kind,
		attempt,
		result.reason ? { reason: result.reason } : {},
	);
}
export async function runAutoRelease({
	endpoint,
	token,
	input,
	fetchImpl = fetch,
	now = Date.now,
	sleep = delay,
	waitMs = 60000,
	onAttempt,
	requireManualDecision = false,
}) {
	need(
		input &&
			Object.keys(input).every((k) =>
				[
					"cycleId",
					"releaseId",
					"bindingDigest",
					"attemptId",
					"expectedSha256",
					"operation",
				].includes(k),
			) &&
			id(input.cycleId) &&
			isReleaseId(input.releaseId) &&
			hex(input.bindingDigest) &&
			(!input.attemptId || uuid(input.attemptId)),
	);
	need(
		Number.isSafeInteger(waitMs) &&
			waitMs >= 1000 &&
			waitMs <= 120000 &&
			typeof onAttempt === "function",
	);
	need(input.expectedSha256 === undefined || hex(input.expectedSha256));
	const operation = input.operation ?? "execute";
	need(["execute", "fence"].includes(operation));
	need(operation !== "fence" || uuid(input.attemptId));
	need(typeof requireManualDecision === "boolean");
	const checkDecision = (permit) => {
		if (requireManualDecision)
			need(
				permit &&
					["founder_go", "founder_override"].includes(permit.trigger) &&
					id(permit.actor) &&
					permit.actor !== "system" &&
					id(permit.manualRequestId),
			);
	};
	const api = client(endpoint, token, fetchImpl);
	let attempt;
	const readAttempt = async () => {
		const r = await api("GET", `/admin/release-attempts/${attempt.attemptId}`);
		need(r.status === 200);
		const state = await json(r);
		bound(state.attempt, { ...input, attemptId: attempt.attemptId });
		need(JSON.stringify(state.attempt) === JSON.stringify(attempt));
		return state;
	};
	if (input.attemptId) {
		const r = await api("GET", `/admin/release-attempts/${input.attemptId}`);
		need(r.status === 200);
		const state = await json(r);
		attempt = bound(state.attempt, input);
		if (state.result) {
			checkDecision(state.permit);
			const observed = resultSummary(
				state.result,
				attempt,
				state.permit,
				input,
			);
			if (operation !== "fence" || state.result.kind !== "unknown")
				return observed;
		}
	} else {
		const r = await api("GET", "/admin/manifest");
		need(r.status === 200);
		const serverTime = r.headers.get("x-fw-server-time"),
			serverNow = Date.parse(serverTime);
		need(
			Number.isFinite(serverNow) &&
				new Date(serverNow).toISOString() === serverTime &&
				Math.abs(now() - serverNow) <= 5000,
		);
		const etag = normalizeEtag(r.headers.get("etag")),
			m = await json(r);
		need(validateManifest(m).length === 0);
		const binding = deriveVetoBinding(m, input.releaseId);
		need(digest(binding) === input.bindingDigest);
		if (input.expectedSha256)
			need(input.expectedSha256 === binding.releasePayloadSha256);
		const payload = await api(
			"GET",
			`/admin/payload/${encodeURIComponent(binding.releaseVersion)}/${binding.releasePayloadSha256}`,
		);
		need(payload.status === 200 && payload.body);
		const hash = createHash("sha256");
		for await (const chunk of payload.body) hash.update(chunk);
		need(hash.digest("hex") === binding.releasePayloadSha256);
		let created;
		try {
			created = await api("POST", "/admin/release-attempts", {
				cycleId: input.cycleId,
				baseEtag: etag,
				fullBinding: binding,
				readbackSha256: binding.releasePayloadSha256,
			});
		} catch {
			return summary(input, "unknown", null, { phase: "attempt_create" });
		}
		need(created.status === 201);
		attempt = bound(await json(created), input);
		// Persist before waiting for a decision or sending execute. Failure here is
		// not a reason to create another attempt; Bridge will reconcile/fence this id.
		await onAttempt({
			...summary(input, "ready", attempt),
			bindingDigest: input.bindingDigest,
		});
	}
	if (operation === "fence")
		await onAttempt({
			...summary(input, "fence_requested", attempt),
			bindingDigest: input.bindingDigest,
		});
	const until = now() + waitMs;
	for (let poll = 0; poll <= Math.ceil(waitMs / 1000); poll++) {
		const state = await readAttempt();
		if (state.result) {
			checkDecision(state.permit);
			const observed = resultSummary(
				state.result,
				attempt,
				state.permit,
				input,
			);
			if (operation !== "fence" || state.result.kind !== "unknown")
				return observed;
		}
		if (state.permit) {
			const p = state.permit;
			checkDecision(p);
			need(
				attemptFields.every(
					(k) => JSON.stringify(p[k]) === JSON.stringify(attempt[k]),
				) &&
					p.action === "commit" &&
					id(p.decisionId),
			);
			let outcome;
			try {
				const r = await api(
					"POST",
					`/admin/release-attempts/${attempt.attemptId}/${operation}`,
					{},
				);
				if (r.status === 200) outcome = await json(r);
			} catch {
				/* An ambiguous POST may have committed; only read this exact id. */
			}
			if (outcome) return resultSummary(outcome, attempt, p, input);
			try {
				const reconciled = await readAttempt();
				if (reconciled.result)
					return resultSummary(
						reconciled.result,
						attempt,
						reconciled.permit,
						input,
					);
			} catch {}
			return summary(input, "unknown", attempt);
		}
		if (now() >= until) return summary(input, "awaiting_permit", attempt);
		await sleep(1000);
	}
	return summary(input, "awaiting_permit", attempt);
}
function cliInput(argv) {
	const flags = {
		"cycle-id": "cycleId",
		"release-id": "releaseId",
		"binding-digest": "bindingDigest",
		"attempt-id": "attemptId",
		"expected-sha256": "expectedSha256",
		operation: "operation",
	};
	const input = {};
	for (let i = 0; i < argv.length; i += 2) {
		const name = argv[i]?.slice(2);
		need(
			argv[i]?.startsWith("--") &&
				flags[name] &&
				argv[i + 1] &&
				!argv[i + 1].startsWith("--") &&
				!Object.hasOwn(input, flags[name]),
		);
		input[flags[name]] = argv[i + 1];
	}
	return input;
}
export async function runAutoReleaseCommand(
	input,
	{ env = process.env, requireManualDecision = false } = {},
) {
	try {
		const receipt = env.FW_AUTO_RELEASE_RECEIPT_FILE;
		need(typeof receipt === "string" && path.isAbsolute(receipt));
		return await runAutoRelease({
			endpoint: env.FW_ENDPOINT,
			token: env.FW_AUTO_RELEASE_EXECUTOR_TOKEN,
			input,
			requireManualDecision,
			onAttempt: async (value) => {
				const fd = fs.openSync(
					receipt,
					fs.constants.O_CREAT |
						fs.constants.O_APPEND |
						fs.constants.O_WRONLY |
						fs.constants.O_NOFOLLOW,
					0o600,
				);
				try {
					fs.writeSync(fd, `${JSON.stringify(value)}\n`);
					fs.fsyncSync(fd);
				} finally {
					fs.closeSync(fd);
				}
				if (env.GITHUB_OUTPUT)
					fs.appendFileSync(
						env.GITHUB_OUTPUT,
						`attempt_id=${value.attemptId}\n`,
					);
			},
		});
	} catch {
		throw Error(
			"release executor refused or unavailable; reconcile the saved attempt before retrying",
		);
	}
}
async function main() {
	try {
		const result = await runAutoReleaseCommand(cliInput(process.argv.slice(2)));
		console.log(JSON.stringify(result));
		if (process.env.GITHUB_OUTPUT)
			fs.appendFileSync(
				process.env.GITHUB_OUTPUT,
				`result=${JSON.stringify(result)}\n`,
			);
		process.exitCode =
			result.kind === "published" || result.kind === "fenced" ? 0 : 2;
	} catch {
		console.error(
			"[payload-auto-release] refused or unavailable; reconcile the saved attempt before retrying",
		);
		process.exitCode = 1;
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	await main();
