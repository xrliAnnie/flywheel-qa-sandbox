// FLY-1062 PR3 · customer surface (RED start: valid customer key → the
// customer-release view). Auth matrix, entitlement views, visible-set payload
// fetch with byte-identical 404s, streaming, empty-state 503, and the
// zero-leak log/error assertion.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	edit,
	fixtureManifest,
	makeClock,
	makeDeps,
	payloadKeyOf,
	request,
	seedBucketForManifest,
	seedKey,
	sha256Hex,
	TOKENS,
} from "./harness.mjs";
import { MemoryBucket } from "./memory-bucket.mjs";

const CUSTOMER_KEY = `fwk_${"1".repeat(32)}`;
const INTERNAL_KEY = `fwk_${"2".repeat(32)}`;
const REVOKED_KEY = `fwk_${"3".repeat(32)}`;

function seededDeps({ manifest = fixtureManifest(), realBytes } = {}) {
	const bucket = new MemoryBucket();
	seedBucketForManifest(bucket, manifest, { realBytes });
	seedKey(bucket, CUSTOMER_KEY, { entitlement: "customer" });
	seedKey(bucket, INTERNAL_KEY, { entitlement: "internal" });
	seedKey(bucket, REVOKED_KEY, { entitlement: "customer", revoked: true });
	return { ...makeDeps({ bucket, clock: makeClock() }), manifest };
}

test("valid customer key → customer-release view (latest + release-only versions)", async () => {
	const { deps } = seededDeps();
	const res = await request(deps, "GET", "/manifest", { token: CUSTOMER_KEY });
	assert.equal(res.status, 200);
	const view = await res.json();
	assert.equal(view.latest, "1.55.0");
	assert.deepEqual(
		view.versions.map((v) => v.ver),
		["1.55.0"],
	);
	assert.equal(view.versions[0].sha256, "b".repeat(64));
});

test("valid internal key → internal-beta view (all active versions)", async () => {
	const { deps } = seededDeps();
	const res = await request(deps, "GET", "/manifest", { token: INTERNAL_KEY });
	assert.equal(res.status, 200);
	const view = await res.json();
	assert.equal(view.latest, "1.55.0-beta.1");
	assert.deepEqual(view.versions.map((v) => v.ver).sort(), [
		"1.55.0",
		"1.55.0-beta.1",
	]);
});

test("auth matrix: no header / garbage key / revoked key → uniform 401 bytes", async () => {
	const { deps } = seededDeps();
	const noHeader = await request(deps, "GET", "/manifest");
	const garbage = await request(deps, "GET", "/manifest", {
		token: "fwk_deadbeef",
	});
	const revoked = await request(deps, "GET", "/manifest", {
		token: REVOKED_KEY,
	});
	const bodies = [];
	for (const res of [noHeader, garbage, revoked]) {
		assert.equal(res.status, 401);
		bodies.push(await res.text());
	}
	// anti-enumeration: all three rejections are byte-identical
	assert.equal(bodies[0], bodies[1]);
	assert.equal(bodies[1], bodies[2]);
});

test("revocation is immediate: key works, revoke lands, next request rejected", async () => {
	const { deps, bucket } = seededDeps();
	const ok = await request(deps, "GET", "/manifest", { token: CUSTOMER_KEY });
	assert.equal(ok.status, 200);
	// ops-admin revoke through the real route
	const rev = await request(
		deps,
		"POST",
		`/admin/key/${sha256Hex(CUSTOMER_KEY)}/revoke`,
		{
			token: TOKENS.ops,
		},
	);
	assert.equal(rev.status, 200);
	const after = await request(deps, "GET", "/manifest", {
		token: CUSTOMER_KEY,
	});
	assert.equal(after.status, 401);
	assert.ok(bucket); // bucket still consistent (no throw)
});

test("payload fetch: in-set version streams the exact object, sha256 matches manifest", async () => {
	const relBytes = Buffer.from("real-release-payload-bytes");
	const relSha = createHash("sha256").update(relBytes).digest("hex");
	const manifest = edit(fixtureManifest(), (m) => {
		m.versions["1.55.0"].sha256 = relSha;
		m.versions["1.55.0"].key = payloadKeyOf("1.55.0", relSha);
		m.versions["1.55.0"].size = relBytes.length;
		m.releaseOps["op-rel-1"].sha256 = relSha;
		m.releaseOps["op-rel-1"].objectKey = payloadKeyOf("1.55.0", relSha);
	});
	const { deps } = seededDeps({ manifest, realBytes: { "1.55.0": relBytes } });
	const res = await request(deps, "GET", "/payload/1.55.0", {
		token: CUSTOMER_KEY,
	});
	assert.equal(res.status, 200);
	const got = Buffer.from(await res.arrayBuffer());
	assert.equal(createHash("sha256").update(got).digest("hex"), relSha);
});

test("payload negatives for customer: beta / quarantined / expired / unknown → byte-identical 404", async () => {
	const manifest = edit(fixtureManifest(), (m) => {
		// add a quarantined release + an expired release alongside the active one
		const qSha = "d".repeat(64);
		m.versions["1.54.0"] = {
			sha256: qSha,
			key: payloadKeyOf("1.54.0", qSha),
			size: 10,
			publishedAt: "2026-06-01T00:00:00.000Z",
			channel: "release",
			status: "quarantined",
			sourceCommit: "c".repeat(40),
			releaseId: "op-rel-q",
			derivedFromBeta: "1.54.0-beta.1",
			retentionSince: "2026-06-02T00:00:00.000Z",
			quarantinedAt: "2026-06-02T00:00:00.000Z",
		};
		const qbSha = "e".repeat(64);
		m.versions["1.54.0-beta.1"] = {
			sha256: qbSha,
			key: payloadKeyOf("1.54.0-beta.1", qbSha),
			size: 10,
			publishedAt: "2026-06-01T00:00:00.000Z",
			channel: "beta",
			status: "active",
			sourceCommit: "c".repeat(40),
			releaseId: "op-beta-q",
			derivedFromBeta: null,
			retentionSince: "2026-06-02T00:00:00.000Z",
			quarantinedAt: null,
		};
		m.releaseOps["op-rel-q"] = {
			kind: "release",
			state: "committed",
			ver: "1.54.0",
			betaVersion: "1.54.0-beta.1",
			sourceCommit: "c".repeat(40),
			sha256: qSha,
			objectKey: payloadKeyOf("1.54.0", qSha),
			createdAt: "2026-06-01T00:00:00.000Z",
		};
		m.releaseOps["op-beta-q"] = {
			kind: "beta",
			state: "committed",
			ver: "1.54.0-beta.1",
			betaVersion: null,
			sourceCommit: "c".repeat(40),
			sha256: qbSha,
			objectKey: payloadKeyOf("1.54.0-beta.1", qbSha),
			createdAt: "2026-06-01T00:00:00.000Z",
		};
		m.releaseLedger["1.54.0"] = { nextBetaN: 2 };
		// an expired old beta — must be exactly as invisible as the rest
		const xSha = "0".repeat(64);
		m.versions["1.53.0-beta.9"] = {
			sha256: xSha,
			key: payloadKeyOf("1.53.0-beta.9", xSha),
			size: 10,
			publishedAt: "2026-05-01T00:00:00.000Z",
			channel: "beta",
			status: "expired",
			sourceCommit: "c".repeat(40),
			releaseId: "op-beta-x",
			derivedFromBeta: null,
			retentionSince: "2026-05-02T00:00:00.000Z",
			quarantinedAt: null,
		};
		m.releaseOps["op-beta-x"] = {
			kind: "beta",
			state: "committed",
			ver: "1.53.0-beta.9",
			betaVersion: null,
			sourceCommit: "c".repeat(40),
			sha256: xSha,
			objectKey: payloadKeyOf("1.53.0-beta.9", xSha),
			createdAt: "2026-05-01T00:00:00.000Z",
		};
		m.releaseLedger["1.53.0"] = { nextBetaN: 10 };
	});
	const { deps } = seededDeps({ manifest });
	const responses = [];
	for (const ver of [
		"1.55.0-beta.1",
		"1.54.0",
		"9.9.9",
		"1.54.0-beta.1",
		"1.53.0-beta.9",
	]) {
		responses.push(
			await request(deps, "GET", `/payload/${ver}`, { token: CUSTOMER_KEY }),
		);
	}
	const bodies = [];
	for (const res of responses) {
		assert.equal(res.status, 404);
		bodies.push(await res.text());
	}
	for (const b of bodies.slice(1)) assert.equal(b, bodies[0]);
	// the quarantined release is invisible in the customer manifest view too
	const view = await (
		await request(deps, "GET", "/manifest", { token: CUSTOMER_KEY })
	).json();
	assert.deepEqual(
		view.versions.map((v) => v.ver),
		["1.55.0"],
	);
	// but internal sees the active beta of 1.54 (all active), NOT the quarantined release
	const iview = await (
		await request(deps, "GET", "/manifest", { token: INTERNAL_KEY })
	).json();
	assert.ok(iview.versions.some((v) => v.ver === "1.54.0-beta.1"));
	assert.ok(!iview.versions.some((v) => v.ver === "1.54.0"));
	assert.ok(
		!iview.versions.some((v) => v.ver === "1.53.0-beta.9"),
		"expired leaked to internal",
	);
});

test("superseded-but-active old release stays visible (install <old> window)", async () => {
	const manifest = edit(fixtureManifest(), (m) => {
		const oldSha = "f".repeat(64);
		m.versions["1.54.0"] = {
			sha256: oldSha,
			key: payloadKeyOf("1.54.0", oldSha),
			size: 10,
			publishedAt: "2026-06-01T00:00:00.000Z",
			channel: "release",
			status: "active",
			sourceCommit: "c".repeat(40),
			releaseId: "op-rel-old",
			derivedFromBeta: "1.54.0-beta.1",
			retentionSince: "2026-07-01T00:00:00.000Z",
			quarantinedAt: null,
		};
		const obSha = "9".repeat(64);
		m.versions["1.54.0-beta.1"] = {
			sha256: obSha,
			key: payloadKeyOf("1.54.0-beta.1", obSha),
			size: 10,
			publishedAt: "2026-06-01T00:00:00.000Z",
			channel: "beta",
			status: "active",
			sourceCommit: "c".repeat(40),
			releaseId: "op-beta-old",
			derivedFromBeta: null,
			retentionSince: "2026-06-02T00:00:00.000Z",
			quarantinedAt: null,
		};
		m.releaseOps["op-rel-old"] = {
			kind: "release",
			state: "committed",
			ver: "1.54.0",
			betaVersion: "1.54.0-beta.1",
			sourceCommit: "c".repeat(40),
			sha256: oldSha,
			objectKey: payloadKeyOf("1.54.0", oldSha),
			createdAt: "2026-06-01T00:00:00.000Z",
		};
		m.releaseOps["op-beta-old"] = {
			kind: "beta",
			state: "committed",
			ver: "1.54.0-beta.1",
			betaVersion: null,
			sourceCommit: "c".repeat(40),
			sha256: obSha,
			objectKey: payloadKeyOf("1.54.0-beta.1", obSha),
			createdAt: "2026-06-01T00:00:00.000Z",
		};
		m.releaseLedger["1.54.0"] = { nextBetaN: 2 };
	});
	const { deps } = seededDeps({ manifest });
	const view = await (
		await request(deps, "GET", "/manifest", { token: CUSTOMER_KEY })
	).json();
	assert.equal(view.latest, "1.55.0");
	assert.ok(view.versions.some((v) => v.ver === "1.54.0"));
	const res = await request(deps, "GET", "/payload/1.54.0", {
		token: CUSTOMER_KEY,
	});
	assert.equal(res.status, 200);
});

test("payload GET streams from the bucket (handler never buffers the body)", async () => {
	const { deps, bucket } = seededDeps();
	const res = await request(deps, "GET", "/payload/1.55.0", {
		token: CUSTOMER_KEY,
	});
	assert.equal(res.status, 200);
	// the handler must hand back the object's stream, not a buffered copy:
	// MemoryObjectBody.body is a ReadableStream; Response(body) keeps it lazy.
	assert.ok(res.body instanceof ReadableStream);
	await res.arrayBuffer(); // drain
	assert.ok(bucket.observations.puts.length === 0); // sanity: read-only path
});

test("empty state: entitlement with null latest → 503 on /manifest (both sides)", async () => {
	// customer-release empty, internal-beta present
	const m1 = fixtureManifest({ withRelease: false });
	const bucket1 = new MemoryBucket();
	seedBucketForManifest(bucket1, m1);
	seedKey(bucket1, CUSTOMER_KEY, { entitlement: "customer" });
	seedKey(bucket1, INTERNAL_KEY, { entitlement: "internal" });
	const d1 = makeDeps({ bucket: bucket1 });
	assert.equal(
		(await request(d1.deps, "GET", "/manifest", { token: CUSTOMER_KEY }))
			.status,
		503,
	);
	assert.equal(
		(await request(d1.deps, "GET", "/manifest", { token: INTERNAL_KEY }))
			.status,
		200,
	);

	// fully empty manifest → internal side 503 too
	const bucket2 = new MemoryBucket();
	bucket2.seed("manifest.json", {
		schemaVersion: 1,
		channels: {
			"internal-beta": { latest: null },
			"customer-release": { latest: null },
		},
		versions: {},
		releaseOps: {},
		releaseLedger: {},
		tombstones: [],
	});
	seedKey(bucket2, INTERNAL_KEY, { entitlement: "internal" });
	const d2 = makeDeps({ bucket: bucket2 });
	assert.equal(
		(await request(d2.deps, "GET", "/manifest", { token: INTERNAL_KEY }))
			.status,
		503,
	);
});

test("zero-leak: keys, key hashes, and capability tokens never appear in logs or error bodies", async () => {
	const { deps, logLines } = seededDeps();
	const probes = [
		await request(deps, "GET", "/manifest", { token: CUSTOMER_KEY }),
		await request(deps, "GET", "/manifest", { token: "fwk_bogus" }),
		await request(deps, "GET", "/payload/9.9.9", { token: CUSTOMER_KEY }),
		await request(deps, "GET", "/admin/manifest", { token: TOKENS.beta }),
		await request(deps, "GET", "/admin/manifest", {
			token: "wrong-admin-token",
		}),
	];
	const errorBodies = [];
	for (const res of probes) {
		if (res.status >= 400) errorBodies.push(await res.text());
	}
	const forbidden = [
		CUSTOMER_KEY,
		INTERNAL_KEY,
		REVOKED_KEY,
		sha256Hex(CUSTOMER_KEY),
		TOKENS.beta,
		TOKENS.release,
		TOKENS.ops,
	];
	const haystack = [...logLines, ...errorBodies].join("\n");
	for (const secret of forbidden) {
		assert.ok(!haystack.includes(secret), `leak: ${secret.slice(0, 8)}…`);
	}
	// error bodies carry no internal paths
	for (const body of errorBodies) {
		assert.ok(!body.includes("/Users/"), "internal path leaked");
		assert.ok(!body.includes("node_modules"), "internal path leaked");
	}
});
