import { normalizeEtag } from "./etag.mjs";
import {
	deriveVetoBinding,
	MANIFEST_KEY,
	payloadObjectKey,
} from "./manifest.mjs";
import { applyPreparedReleaseCommit } from "./release-commit.mjs";
import { applyTransition } from "./transitions.mjs";
import { validateManifest } from "./validator.mjs";

const MAX_BYTES = 65536;
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
const permitFields = [
	...attemptFields,
	"decisionId",
	"action",
	"trigger",
	"actor",
	"verdictId",
	"evidenceRevision",
	"claimedAt",
	"notAfter",
];
const id = (value) =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
function exact(value, required, optional = []) {
	return (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every(
			(key) => required.includes(key) || optional.includes(key),
		)
	);
}
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])]),
		);
	return value;
}
function same(a, b) {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
function reply(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "private, no-store",
		},
	});
}
class ControlError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}
function requireCondition(
	condition,
	status = 400,
	message = "release control input invalid",
) {
	if (!condition) throw new ControlError(status, message);
}
async function readJson(source) {
	if (source.size > MAX_BYTES)
		throw new ControlError(413, "release control body too large");
	const reader = source.body?.getReader();
	requireCondition(reader);
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_BYTES) {
				await reader.cancel();
				throw new ControlError(413, "release control body too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new ControlError(400, "release control JSON invalid");
	}
}
function policy(value) {
	requireCondition(
		exact(value, [
			"projectId",
			"audience",
			"activationEpoch",
			"mode",
			"enabled",
		]) &&
			value.projectId === "flywheel" &&
			id(value.audience) &&
			integer(value.activationEpoch) &&
			["off", "observe", "canary"].includes(value.mode) &&
			typeof value.enabled === "boolean",
		503,
		"release control disabled",
	);
	return value;
}
function key(config, attemptId, object) {
	return `control/customer-release/${config.projectId}/${attemptId}/${object}.json`;
}
async function readRecord(bucket, objectKey, kind) {
	const obj = await bucket.get(objectKey);
	if (!obj) return null;
	const body = await readJson(obj);
	requireCondition(
		exact(body, ["schemaVersion", kind]) && body.schemaVersion === 1,
		503,
		"release control record invalid",
	);
	return body[kind];
}
async function persistOnce(bucket, objectKey, kind, value) {
	const bytes = JSON.stringify({ schemaVersion: 1, [kind]: value });
	const put = await bucket.put(objectKey, bytes, {
		onlyIf: { etagDoesNotMatch: "*" },
	});
	if (put) return true;
	const prior = await readRecord(bucket, objectKey, kind);
	requireCondition(same(prior, value), 409, "release control record conflict");
	return false;
}
function validAttempt(attempt) {
	return (
		exact(attempt, attemptFields) &&
		exact(attempt.fullBinding, bindingFields) &&
		[
			attempt.attemptId,
			attempt.cycleId,
			attempt.projectId,
			attempt.audience,
		].every(id) &&
		integer(attempt.activationEpoch) &&
		integer(attempt.readyAt) &&
		typeof attempt.nonce === "string" &&
		/^[a-f0-9]{64}$/.test(attempt.nonce) &&
		attempt.readbackSha256 === attempt.fullBinding.releasePayloadSha256
	);
}
function validatePermit(permit, attempt, config, now) {
	requireCondition(
		exact(permit, permitFields, ["manualRequestId", "readiness"]),
	);
	requireCondition(
		attemptFields.every((field) => same(permit[field], attempt[field])),
		409,
		"release permit binding mismatch",
	);
	requireCondition(
		attempt.activationEpoch === config.activationEpoch &&
			attempt.audience === config.audience &&
			attempt.projectId === config.projectId,
		409,
		"release activation changed",
	);
	requireCondition(
		[permit.decisionId, permit.actor, permit.verdictId].every(id) &&
			permit.action === "commit" &&
			integer(permit.evidenceRevision),
	);
	requireCondition(
		integer(now) &&
			integer(permit.claimedAt) &&
			integer(permit.notAfter) &&
			permit.claimedAt <= now + 5000 &&
			permit.claimedAt >= attempt.readyAt - 5000 &&
			Math.abs(permit.claimedAt - attempt.readyAt) <= 5000 &&
			permit.notAfter > now &&
			permit.notAfter > permit.claimedAt &&
			permit.notAfter - permit.claimedAt <= 30000,
	);
	if (permit.trigger === "silence_auto") {
		requireCondition(
			config.mode === "canary" &&
				config.enabled &&
				permit.actor === "system" &&
				!Object.hasOwn(permit, "manualRequestId") &&
				!Object.hasOwn(permit, "readiness"),
			409,
			"automatic release disabled",
		);
	} else {
		requireCondition(
			config.mode !== "observe" &&
				["founder_go", "founder_override"].includes(permit.trigger) &&
				permit.actor !== "system" &&
				id(permit.manualRequestId) &&
				exact(permit.readiness, ["state", "reasons"]) &&
				Array.isArray(permit.readiness.reasons),
		);
		requireCondition(
			permit.trigger === "founder_go"
				? permit.readiness.state === "green"
				: ["hold", "unknown"].includes(permit.readiness.state),
		);
	}
}

function resultIdentity(permit, kind, extra = {}) {
	return {
		attemptId: permit.attemptId,
		decisionId: permit.decisionId,
		nonce: permit.nonce,
		baseEtag: permit.baseEtag,
		kind,
		...extra,
	};
}
function exactTerminal(manifest, binding, state) {
	const op = manifest?.releaseOps?.[binding.releaseId];
	const beta = manifest?.versions?.[binding.betaVersion];
	if (
		!op ||
		op.kind !== "release" ||
		op.state !== state ||
		op.ver !== binding.releaseVersion ||
		op.betaVersion !== binding.betaVersion ||
		op.sourceCommit !== binding.sourceCommit ||
		op.sha256 !== binding.releasePayloadSha256 ||
		op.objectKey !==
			payloadObjectKey(binding.releaseVersion, binding.releasePayloadSha256) ||
		beta?.sha256 !== binding.betaPayloadSha256 ||
		beta?.sourceCommit !== binding.sourceCommit
	)
		return false;
	if (state === "abandoned") return true;
	const entry = manifest?.versions?.[binding.releaseVersion];
	return (
		entry?.releaseId === binding.releaseId &&
		entry.channel === "release" &&
		entry.sourceCommit === binding.sourceCommit &&
		entry.sha256 === binding.releasePayloadSha256 &&
		entry.derivedFromBeta === binding.betaVersion &&
		entry.key === op.objectKey
	);
}
async function resultFor(deps, config, attempt, permit) {
	if (!permit) return null;
	const obj = await deps.bucket.get(MANIFEST_KEY);
	if (obj) {
		const manifest = await obj.json();
		if (
			validateManifest(manifest).length === 0 &&
			obj.etag !== attempt.baseEtag
		) {
			for (const [state, kind] of [
				["committed", "published"],
				["abandoned", "fenced"],
			]) {
				if (exactTerminal(manifest, attempt.fullBinding, state))
					return resultIdentity(permit, kind, {
						manifest,
						manifestEtag: obj.etag,
					});
			}
		}
	}
	const recorded = await readRecord(
		deps.bucket,
		key(config, attempt.attemptId, "result"),
		"result",
	);
	if (recorded) {
		requireCondition(
			same(
				recorded,
				resultIdentity(permit, "no_write", { reason: recorded.reason }),
			) && ["guard_rejected", "cas_conflict"].includes(recorded.reason),
			503,
			"release result invalid",
		);
		return recorded;
	}
	const started = await readRecord(
		deps.bucket,
		key(config, attempt.attemptId, "started"),
		"started",
	);
	return started ? resultIdentity(permit, "unknown") : null;
}
async function executeAttempt(deps, config, attempt, permit) {
	requireCondition(permit, 409, "release permit missing");
	const prior = await resultFor(deps, config, attempt, permit);
	if (prior) return reply(200, prior);
	// This one create-only object owns the only permitted manifest PUT. A crash
	// after it becomes visible is unknown, never evidence that no write occurred.
	const started = {
		attemptId: attempt.attemptId,
		decisionId: permit.decisionId,
		nonce: attempt.nonce,
	};
	const won = await deps.bucket.put(
		key(config, attempt.attemptId, "started"),
		JSON.stringify({ schemaVersion: 1, started }),
		{ onlyIf: { etagDoesNotMatch: "*" } },
	);
	if (!won)
		return reply(
			200,
			(await resultFor(deps, config, attempt, permit)) ??
				resultIdentity(permit, "unknown"),
		);
	let manifestPutStarted = false;
	try {
		validatePermit(permit, attempt, config, deps.now().getTime());
		const obj = await deps.bucket.get(MANIFEST_KEY);
		requireCondition(
			obj && obj.etag === attempt.baseEtag,
			409,
			"release manifest changed",
		);
		const manifest = await obj.json();
		requireCondition(
			validateManifest(manifest).length === 0,
			409,
			"release manifest invalid",
		);
		let binding;
		try {
			binding = deriveVetoBinding(manifest, attempt.fullBinding.releaseId);
		} catch {
			throw new ControlError(409, "release artifact unavailable");
		}
		requireCondition(
			same(binding, attempt.fullBinding),
			409,
			"release artifact changed",
		);
		const artifact = await deps.bucket.head(
			payloadObjectKey(binding.releaseVersion, binding.releasePayloadSha256),
		);
		requireCondition(
			artifact &&
				integer(artifact.size) &&
				artifact.customMetadata?.sha256 === binding.releasePayloadSha256,
			409,
			"release artifact unavailable",
		);
		const next = structuredClone(manifest);
		applyPreparedReleaseCommit(
			next,
			binding,
			artifact.size,
			deps.now().toISOString(),
		);
		const transition = applyTransition(manifest, next, deps.now);
		requireCondition(
			transition.errs.length === 0 &&
				validateManifest(transition.manifest).length === 0,
			409,
			"release transition invalid",
		);
		const bytes = JSON.stringify(transition.manifest);
		// No further awaits between the final eligibility check and the sole CAS.
		validatePermit(
			permit,
			attempt,
			policy(deps.releaseControl),
			deps.now().getTime(),
		);
		manifestPutStarted = true;
		const put = await deps.bucket.put(MANIFEST_KEY, bytes, {
			onlyIf: { etagMatches: attempt.baseEtag },
		});
		if (!put) {
			const result = resultIdentity(permit, "no_write", {
				reason: "cas_conflict",
			});
			await persistOnce(
				deps.bucket,
				key(config, attempt.attemptId, "result"),
				"result",
				result,
			);
			return reply(200, result);
		}
		// The manifest is the durable success receipt. Recovery derives the same
		// fact after a lost reply, including after the release is later withdrawn.
		return reply(
			200,
			resultIdentity(permit, "published", {
				manifest: transition.manifest,
				manifestEtag: put.etag,
			}),
		);
	} catch (error) {
		if (!manifestPutStarted && error instanceof ControlError) {
			const result = resultIdentity(permit, "no_write", {
				reason: "guard_rejected",
			});
			await persistOnce(
				deps.bucket,
				key(config, attempt.attemptId, "result"),
				"result",
				result,
			);
			return reply(200, result);
		}
		return reply(200, resultIdentity(permit, "unknown"));
	}
}

async function fenceAttempt(deps, config, attempt, permit) {
	requireCondition(permit, 409, "release permit missing");
	const intent = await readRecord(
		deps.bucket,
		key(config, attempt.attemptId, "fence-intent"),
		"intent",
	);
	requireCondition(intent, 409, "release fence intent missing");
	requireCondition(
		intent.decisionId === permit.decisionId &&
			intent.nonce === attempt.nonce &&
			intent.baseEtag === attempt.baseEtag &&
			same(intent.fullBinding, attempt.fullBinding),
		503,
		"release fence intent invalid",
	);
	const prior = await resultFor(deps, config, attempt, permit);
	if (prior?.kind === "published" || prior?.kind === "fenced")
		return reply(200, prior);
	const obj = await deps.bucket.get(MANIFEST_KEY);
	requireCondition(obj, 409, "release manifest missing");
	const manifest = await obj.json();
	requireCondition(
		validateManifest(manifest).length === 0,
		409,
		"release manifest invalid",
	);
	const binding = attempt.fullBinding;
	const op = manifest.releaseOps?.[binding.releaseId];
	// Use the terminal tuple checker without requiring the beta to remain active:
	// revocation must still be able to fence a prepared op after beta withdrawal.
	const check = structuredClone(manifest);
	if (op?.state === "prepared")
		check.releaseOps[binding.releaseId].state = "abandoned";
	requireCondition(
		op?.state === "prepared" && exactTerminal(check, binding, "abandoned"),
		409,
		"release fence binding mismatch",
	);
	const transition = applyTransition(manifest, check, deps.now);
	requireCondition(
		transition.errs.length === 0 &&
			validateManifest(transition.manifest).length === 0,
		409,
		"release fence transition invalid",
	);
	try {
		const put = await deps.bucket.put(
			MANIFEST_KEY,
			JSON.stringify(transition.manifest),
			{ onlyIf: { etagMatches: obj.etag } },
		);
		if (put)
			return reply(
				200,
				resultIdentity(permit, "fenced", {
					manifest: transition.manifest,
					manifestEtag: put.etag,
				}),
			);
		// If commit won, return published. If neither exact fact is visible, retain
		// unknown and permit another exact fence; a failed CAS never claims success.
		const result = await resultFor(deps, config, attempt, permit);
		return reply(
			200,
			result?.kind === "published" || result?.kind === "fenced"
				? result
				: resultIdentity(permit, "unknown"),
		);
	} catch {
		return reply(200, resultIdentity(permit, "unknown"));
	}
}

const DISCOVERY_BUCKET_MS = 5000;
function discoveryPrefix(config, bucket) {
	return `control/customer-release-ready/${config.projectId}/${config.activationEpoch}/${bucket}/`;
}
function discoveryCursor(bucket, slot, native = "") {
	const cursor = `v1:${bucket}:${slot}:${native}`;
	requireCondition(
		cursor.length <= 1024,
		503,
		"release listing cursor too long",
	);
	return cursor;
}
async function pendingAttempts(request, deps, config) {
	const params = new URL(request.url).searchParams;
	requireCondition(
		[...params.keys()].every((key) => ["limit", "cursor"].includes(key)) &&
			params.getAll("limit").length <= 1 &&
			params.getAll("cursor").length <= 1,
	);
	const limitText = params.get("limit") ?? "50";
	requireCondition(/^(?:[1-9][0-9]?|100)$/.test(limitText));
	const limit = Number(limitText),
		cursor = params.get("cursor");
	requireCondition(
		cursor === null ||
			(cursor.length >= 1 &&
				cursor.length <= 1024 &&
				/^[\x21-\x7e]+$/.test(cursor)),
	);
	requireCondition(
		typeof deps.bucket.list === "function",
		503,
		"release listing unavailable",
	);
	const now = deps.now().getTime();
	requireCondition(integer(now), 503, "release clock invalid");
	const current = Math.floor(now / DISCOVERY_BUCKET_MS);
	// At most three time partitions intersect the unchanged +/-5s freshness
	// window. Historical authority objects never consume this discovery budget.
	const buckets = [current, current - 1, current + 1].filter((b) => b >= 0);
	let slot = 0,
		native;
	if (cursor !== null) {
		const parsed = /^v1:([0-9]+):([0-2]):([\x21-\x7e]*)$/.exec(cursor);
		requireCondition(parsed && integer(Number(parsed[1])));
		// A cursor cannot pin the pump to an expired time partition.
		if (Number(parsed[1]) === current) {
			slot = Number(parsed[2]);
			native = parsed[3] || undefined;
		}
	}
	const attempts = [];
	let remaining = limit;
	while (slot < buckets.length && remaining > 0) {
		const prefix = discoveryPrefix(config, buckets[slot]);
		const page = await deps.bucket.list({
			prefix,
			delimiter: "/",
			limit: remaining,
			...(native === undefined ? {} : { cursor: native }),
		});
		requireCondition(
			page &&
				Array.isArray(page.objects) &&
				Array.isArray(page.delimitedPrefixes) &&
				typeof page.truncated === "boolean" &&
				page.objects.length + page.delimitedPrefixes.length <= remaining &&
				(!page.truncated ||
					(typeof page.cursor === "string" &&
						page.cursor.length > 0 &&
						page.cursor.length <= 1024 &&
						/^[\x21-\x7e]+$/.test(page.cursor) &&
						page.cursor !== native)),
			503,
			"release listing invalid",
		);
		remaining -= page.objects.length + page.delimitedPrefixes.length;
		for (const dir of page.delimitedPrefixes) {
			requireCondition(
				typeof dir === "string" && dir.startsWith(prefix),
				503,
				"release listing invalid",
			);
			const attemptId = dir.slice(prefix.length).replace(/\/$/, "");
			requireCondition(
				/^[a-f0-9-]{36}$/.test(attemptId),
				503,
				"release listing invalid",
			);
			const attempt = await readRecord(
				deps.bucket,
				key(config, attemptId, "attempt"),
				"attempt",
			);
			if (!attempt) continue;
			requireCondition(
				validAttempt(attempt) &&
					attempt.attemptId === attemptId &&
					attempt.projectId === config.projectId,
				503,
				"release attempt invalid",
			);
			const observedNow = deps.now().getTime();
			if (
				attempt.activationEpoch !== config.activationEpoch ||
				!integer(observedNow) ||
				attempt.audience !== config.audience ||
				Math.floor(attempt.readyAt / DISCOVERY_BUCKET_MS) !== buckets[slot] ||
				Math.abs(observedNow - attempt.readyAt) > 5000
			)
				continue;
			const permit = await deps.bucket.head(key(config, attemptId, "permit"));
			const started = await deps.bucket.head(key(config, attemptId, "started"));
			if (!permit && !started) attempts.push(attempt);
		}
		if (page.truncated)
			return reply(200, {
				attempts,
				cursor: discoveryCursor(current, slot, page.cursor),
			});
		slot++;
		native = undefined;
	}
	return reply(200, {
		attempts,
		cursor: slot < buckets.length ? discoveryCursor(current, slot) : null,
	});
}

/** Authenticated narrow transport. It does not decide readiness or manufacture founder authority. */
export async function handleReleaseAttempt(request, deps, capability) {
	try {
		const executor = capability === "release-auto-executor";
		const writer = capability === "release-decision-writer";
		requireCondition(executor || writer, 403, "forbidden");
		const { pathname } = new URL(request.url);
		if (pathname === "/admin/release-attempts/pending") {
			requireCondition(writer && request.method === "GET", 403, "forbidden");
			return await pendingAttempts(request, deps, policy(deps.releaseControl));
		}
		const isCreate =
			pathname === "/admin/release-attempts" && request.method === "POST";
		const match =
			/^\/admin\/release-attempts\/([a-f0-9-]{36})(?:\/(permit|execute|fence-intent|fence))?$/.exec(
				pathname,
			);
		requireCondition(isCreate || match, 404, "not found");
		requireCondition(!isCreate || executor, 403, "forbidden");
		if (["permit", "fence-intent"].includes(match?.[2]))
			requireCondition(writer && request.method === "PUT", 403, "forbidden");
		if (["execute", "fence"].includes(match?.[2]))
			requireCondition(executor && request.method === "POST", 403, "forbidden");
		if (match && !match[2])
			requireCondition(request.method === "GET", 403, "forbidden");
		const config = policy(deps.releaseControl);
		if (isCreate) {
			requireCondition(
				config.mode !== "observe",
				409,
				"release control observing",
			);
			const input = await readJson(request);
			requireCondition(
				exact(input, [
					"cycleId",
					"fullBinding",
					"baseEtag",
					"readbackSha256",
				]) &&
					id(input.cycleId) &&
					exact(input.fullBinding, bindingFields),
			);
			let baseEtag;
			try {
				baseEtag = normalizeEtag(input.baseEtag);
			} catch {
				throw new ControlError(400, "release base ETag invalid");
			}
			const obj = await deps.bucket.get(MANIFEST_KEY);
			requireCondition(
				obj && obj.etag === baseEtag,
				412,
				"release manifest changed",
			);
			const manifest = await obj.json();
			requireCondition(
				validateManifest(manifest).length === 0,
				409,
				"release manifest invalid",
			);
			let binding;
			try {
				binding = deriveVetoBinding(manifest, input.fullBinding.releaseId);
			} catch {
				throw new ControlError(409, "release binding unavailable");
			}
			requireCondition(
				same(input.fullBinding, binding) &&
					input.readbackSha256 === binding.releasePayloadSha256,
				409,
				"release binding mismatch",
			);
			const artifact = await deps.bucket.head(
				payloadObjectKey(binding.releaseVersion, binding.releasePayloadSha256),
			);
			requireCondition(
				artifact &&
					integer(artifact.size) &&
					artifact.customMetadata?.sha256 === binding.releasePayloadSha256,
				409,
				"release artifact unavailable",
			);
			// The executor streams and hashes before this request. The endpoint derives the
			// same tuple from the manifest and checks immutable storage metadata again.
			const readyAt = deps.now().getTime();
			requireCondition(integer(readyAt), 503, "release clock invalid");
			const attempt = {
				attemptId: crypto.randomUUID(),
				cycleId: input.cycleId,
				projectId: config.projectId,
				audience: config.audience,
				activationEpoch: config.activationEpoch,
				nonce: [...crypto.getRandomValues(new Uint8Array(32))]
					.map((b) => b.toString(16).padStart(2, "0"))
					.join(""),
				baseEtag,
				readyAt,
				fullBinding: binding,
				readbackSha256: input.readbackSha256,
			};
			await persistOnce(
				deps.bucket,
				key(config, attempt.attemptId, "attempt"),
				"attempt",
				attempt,
			);
			// Publish discovery only after the immutable attempt is durable. This index
			// never grants authority; pending re-reads and validates the original record.
			await persistOnce(
				deps.bucket,
				`${discoveryPrefix(config, Math.floor(readyAt / DISCOVERY_BUCKET_MS))}${attempt.attemptId}/ready.json`,
				"ready",
				{ attemptId: attempt.attemptId, readyAt },
			);
			return reply(201, attempt);
		}
		const attempt = await readRecord(
			deps.bucket,
			key(config, match[1], "attempt"),
			"attempt",
		);
		requireCondition(attempt, 404, "not found");
		requireCondition(
			validAttempt(attempt) &&
				attempt.attemptId === match[1] &&
				attempt.projectId === config.projectId,
			503,
			"release attempt invalid",
		);
		const prior = await readRecord(
			deps.bucket,
			key(config, attempt.attemptId, "permit"),
			"permit",
		);
		if (!match[2])
			return reply(200, {
				attempt,
				permit: prior,
				result: await resultFor(deps, config, attempt, prior),
			});
		if (match[2] === "fence-intent") {
			requireCondition(prior, 409, "release permit missing");
			const intent = await readJson(request);
			requireCondition(
				exact(intent, [
					"decisionId",
					"nonce",
					"baseEtag",
					"fullBinding",
					"reason",
				]) && id(intent.reason),
			);
			requireCondition(
				intent.decisionId === prior.decisionId &&
					intent.nonce === attempt.nonce &&
					intent.baseEtag === attempt.baseEtag &&
					same(intent.fullBinding, attempt.fullBinding),
				409,
				"release fence binding mismatch",
			);
			const created = await persistOnce(
				deps.bucket,
				key(config, attempt.attemptId, "fence-intent"),
				"intent",
				intent,
			);
			return reply(created ? 201 : 200, { ok: true });
		}
		if (match[2] === "fence") {
			requireCondition(exact(await readJson(request), []));
			return await fenceAttempt(deps, config, attempt, prior);
		}
		if (match[2] === "execute") {
			requireCondition(exact(await readJson(request), []));
			return await executeAttempt(deps, config, attempt, prior);
		}
		const permit = await readJson(request);
		// Replays return the original durable receipt without extending its deadline.
		if (prior) {
			requireCondition(same(prior, permit), 409, "release permit conflict");
			return reply(200, { ok: true });
		}
		validatePermit(permit, attempt, config, deps.now().getTime());
		const created = await persistOnce(
			deps.bucket,
			key(config, attempt.attemptId, "permit"),
			"permit",
			permit,
		);
		return reply(created ? 201 : 200, { ok: true });
	} catch (error) {
		if (error instanceof ControlError)
			return reply(error.status, { error: error.message });
		return reply(503, { error: "release control unavailable" });
	}
}
