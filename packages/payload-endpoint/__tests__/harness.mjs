// FLY-1062 PR3 · shared test harness: capability tokens, seeded manifests,
// license keys, and a request helper that drives the pure handler in-process.
import { createHash } from "node:crypto";
import { handleRequest } from "../src/handler.mjs";
import { MemoryBucket } from "./memory-bucket.mjs";

export const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");

export const TOKENS = {
	beta: "beta-publish-token-fixture",
	release: "customer-release-token-fixture",
	ops: "ops-admin-token-fixture",
};

export function secretsFor(tokens = TOKENS) {
	return {
		betaPublishTokenSha256: sha256Hex(tokens.beta),
		customerReleaseTokenSha256: sha256Hex(tokens.release),
		opsAdminTokenSha256: sha256Hex(tokens.ops),
	};
}

// A fixed, controllable clock. now() returns the current fake time; advance
// with clock.tick(ms) / clock.set(iso).
export function makeClock(startIso = "2026-07-11T00:00:00.000Z") {
	let t = Date.parse(startIso);
	const clock = {
		now: () => new Date(t),
		tick: (ms) => {
			t += ms;
		},
		set: (iso) => {
			t = Date.parse(iso);
		},
	};
	return clock;
}

export const DAY = 24 * 60 * 60 * 1000;

export function makeDeps({
	bucket = new MemoryBucket(),
	clock = makeClock(),
	tokens,
} = {}) {
	const logLines = [];
	return {
		bucket,
		clock,
		logLines,
		deps: {
			bucket,
			secrets: secretsFor(tokens),
			now: clock.now,
			log: (line) => logLines.push(String(line)),
		},
	};
}

// request <deps> <method> <path> [opts] → Response from the pure handler.
export async function request(
	deps,
	method,
	path,
	{ token, body, headers = {} } = {},
) {
	const h = new Headers(headers);
	if (token) h.set("authorization", `Bearer ${token}`);
	let reqBody;
	if (body !== undefined) {
		reqBody =
			typeof body === "string" || body instanceof Uint8Array
				? body
				: JSON.stringify(body);
		if (
			!h.has("content-type") &&
			typeof body === "object" &&
			!(body instanceof Uint8Array)
		) {
			h.set("content-type", "application/json");
		}
	}
	const req = new Request(`https://endpoint.test${path}`, {
		method,
		headers: h,
		body: reqBody,
		...(reqBody !== undefined ? { duplex: "half" } : {}),
	});
	return handleRequest(req, deps);
}

// admin manifest helpers ------------------------------------------------------
export async function getManifest(deps, token = TOKENS.beta) {
	const res = await request(deps, "GET", "/admin/manifest", { token });
	if (res.status === 404) return { manifest: null, etag: null, status: 404 };
	const etag = res.headers.get("etag");
	return { manifest: await res.json(), etag, status: res.status };
}

export async function postManifest(deps, manifest, baseEtag, token) {
	return request(deps, "POST", "/admin/manifest", {
		token,
		body: { baseEtag, manifest },
	});
}

// structuredClone-based manifest editing: edit(m) mutates a deep copy.
export function edit(manifest, fn) {
	const copy = structuredClone(manifest);
	fn(copy);
	return copy;
}

export function emptyManifest() {
	return {
		schemaVersion: 1,
		channels: {
			"internal-beta": { latest: null },
			"customer-release": { latest: null },
		},
		versions: {},
		releaseOps: {},
		releaseLedger: {},
		tombstones: [],
	};
}

export function payloadKeyOf(ver, sha) {
	return `payloads/${ver}/${sha}.tgz`;
}

// A fully-consistent fixture manifest: one committed beta + one committed
// release (derived from the beta), both pointers set. Every timestamp is a
// fixed ISO in the past so pointer/tenure rules hold.
export function fixtureManifest({ withRelease = true } = {}) {
	const t0 = "2026-07-01T00:00:00.000Z";
	const betaVer = "1.55.0-beta.1";
	const relVer = "1.55.0";
	const betaSha = "a".repeat(64);
	const relSha = "b".repeat(64);
	const commit = "c".repeat(40);
	const m = emptyManifest();
	m.channels["internal-beta"].latest = betaVer;
	m.versions[betaVer] = {
		sha256: betaSha,
		key: payloadKeyOf(betaVer, betaSha),
		size: 1024,
		publishedAt: t0,
		channel: "beta",
		status: "active",
		sourceCommit: commit,
		releaseId: "op-beta-1",
		derivedFromBeta: null,
		retentionSince: null,
		quarantinedAt: null,
	};
	m.releaseOps["op-beta-1"] = {
		kind: "beta",
		state: "committed",
		ver: betaVer,
		betaVersion: null,
		sourceCommit: commit,
		sha256: betaSha,
		objectKey: payloadKeyOf(betaVer, betaSha),
		createdAt: t0,
	};
	m.releaseLedger["1.55.0"] = { nextBetaN: 2 };
	if (withRelease) {
		m.channels["customer-release"].latest = relVer;
		m.versions[relVer] = {
			sha256: relSha,
			key: payloadKeyOf(relVer, relSha),
			size: 2048,
			publishedAt: t0,
			channel: "release",
			status: "active",
			sourceCommit: commit,
			releaseId: "op-rel-1",
			derivedFromBeta: betaVer,
			retentionSince: null,
			quarantinedAt: null,
		};
		m.releaseOps["op-rel-1"] = {
			kind: "release",
			state: "committed",
			ver: relVer,
			betaVersion: betaVer,
			sourceCommit: commit,
			sha256: relSha,
			objectKey: payloadKeyOf(relVer, relSha),
			createdAt: t0,
		};
	}
	return m;
}

// Seed a bucket to MATCH a manifest: payload objects (bytes chosen so the
// registered sha256 is the REAL sha of the bytes when `realBytes` provides
// them, else metadata-only fixtures) + license keys.
export function seedBucketForManifest(
	bucket,
	manifest,
	{ realBytes = {} } = {},
) {
	bucket.seed("manifest.json", JSON.stringify(manifest));
	for (const [ver, e] of Object.entries(manifest.versions)) {
		const bytes = realBytes[ver] ?? Buffer.from(`payload-bytes-${ver}`);
		bucket.seed(e.key, bytes, { sha256: e.sha256, ver });
	}
}

export function seedKey(
	bucket,
	plaintextKey,
	{ entitlement = "customer", revoked = false } = {},
) {
	bucket.seed(`keys/${sha256Hex(plaintextKey)}.json`, {
		customerId: "cust-fixture",
		entitlement,
		revoked,
		createdAt: "2026-07-01T00:00:00.000Z",
		note: "test fixture",
	});
}
