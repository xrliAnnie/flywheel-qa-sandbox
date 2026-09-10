// FLY-1062 PR3 · customer surface (RED start: valid customer key → the
// customer-release view). Auth matrix, entitlement views, visible-set payload
// fetch with byte-identical 404s, streaming, empty-state 503, and the
// zero-leak log/error assertion.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createSignGet } from "../src/presign.mjs";
import worker from "../src/worker.mjs";
import {
	edit,
	fixtureManifest,
	getManifest,
	makeClock,
	makeDeps,
	payloadKeyOf,
	postManifest,
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

function presignedDeps() {
	const fixture = seededDeps();
	// HEAD must match the manifest; seeded payloads are metadata fixtures.
	for (const [ver, entry] of Object.entries(fixture.manifest.versions)) {
		fixture.bucket.seed(entry.key, new Uint8Array(entry.size), {
			sha256: entry.sha256,
			ver,
		});
	}
	const calls = [];
	const sign = createSignGet({
		FW_R2_ACCOUNT_ID: "a".repeat(32),
		FW_R2_BUCKET: "flywheel-payloads",
		FW_R2_ACCESS_KEY_ID: "test-access",
		FW_R2_SECRET_ACCESS_KEY: "test-secret",
	});
	fixture.deps.delivery = {
		mode: "presigned",
		signGet: async (input) => {
			calls.push(input);
			return sign(input);
		},
	};
	return { ...fixture, calls };
}

test("presigned downloads redirect each entitlement without streaming and never sign forbidden versions", async () => {
	const { deps, calls, manifest } = presignedDeps();
	for (const [token, ver] of [
		[CUSTOMER_KEY, "1.55.0"],
		[INTERNAL_KEY, "1.55.0-beta.1"],
	]) {
		const res = await request(deps, "GET", `/payload/${ver}`, { token });
		assert.equal(res.status, 302);
		assert.equal(await res.text(), "");
		assert.equal(res.headers.get("cache-control"), "private, no-store");
		assert.equal(res.headers.get("referrer-policy"), "no-referrer");
		const url = new URL(res.headers.get("location"));
		assert.equal(
			url.pathname,
			`/flywheel-payloads/${manifest.versions[ver].key}`,
		);
		assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
		assert.equal(url.searchParams.get("X-Amz-Date"), "20260711T000000Z");
	}
	for (const [token, ver, expected] of [
		[CUSTOMER_KEY, "1.55.0-beta.1", 404],
		[CUSTOMER_KEY, "9.9.9", 404],
		[REVOKED_KEY, "1.55.0", 401],
		[null, "1.55.0", 401],
	]) {
		assert.equal(
			(await request(deps, "GET", `/payload/${ver}`, { token })).status,
			expected,
		);
	}
	assert.equal(calls.length, 2);
});

test("revocation and quarantine stop minting new presigned links", async () => {
	const { deps, calls } = presignedDeps();
	assert.equal(
		(await request(deps, "GET", "/payload/1.55.0", { token: CUSTOMER_KEY }))
			.status,
		302,
	);
	assert.equal(
		(
			await request(
				deps,
				"POST",
				`/admin/key/${sha256Hex(CUSTOMER_KEY)}/revoke`,
				{ token: TOKENS.ops },
			)
		).status,
		200,
	);
	assert.equal(
		(await request(deps, "GET", "/payload/1.55.0", { token: CUSTOMER_KEY }))
			.status,
		401,
	);
	const cur = await getManifest(deps);
	const quarantined = edit(cur.manifest, (m) => {
		m.versions["1.55.0"].status = "quarantined";
		m.channels["customer-release"].latest = null;
	});
	assert.equal(
		(await postManifest(deps, quarantined, cur.etag, TOKENS.release)).status,
		200,
	);
	assert.equal(
		(await request(deps, "GET", "/payload/1.55.0", { token: INTERNAL_KEY }))
			.status,
		404,
	);
	assert.equal(calls.length, 1);
});

test("beta history disappears at its exact 14-day deadline before cleanup", async () => {
	const manifest = fixtureManifest();
	const ver = "1.54.0-beta.1";
	const entry = {
		...manifest.versions["1.55.0-beta.1"],
		key: payloadKeyOf(ver, "a".repeat(64)),
		releaseId: "old-beta",
		retentionSince: "2026-07-01T00:00:00.000Z",
	};
	manifest.versions[ver] = entry;
	manifest.releaseOps[entry.releaseId] = {
		...manifest.releaseOps["op-beta-1"],
		ver,
		objectKey: entry.key,
	};
	manifest.releaseLedger["1.54.0"] = { nextBetaN: 2 };
	const { deps, clock } = seededDeps({ manifest });
	for (const [offset, status] of [
		[-1, 200],
		[0, 404],
		[1, 404],
	]) {
		clock.set(
			new Date(
				Date.parse(entry.retentionSince) + 14 * 86400000 + offset,
			).toISOString(),
		);
		assert.equal(
			(await request(deps, "GET", `/payload/${ver}`, { token: INTERNAL_KEY }))
				.status,
			status,
		);
	}
});

test("download mode and signing failures fail closed with fixed 503, never an implicit stream", async () => {
	for (const delivery of [
		undefined,
		{ mode: "unknown" },
		{ mode: "presigned" },
		{
			mode: "presigned",
			signGet: async () => {
				throw new Error("SECRET_URL");
			},
		},
	]) {
		const { deps, logLines } = presignedDeps();
		deps.delivery = delivery;
		const res = await request(deps, "GET", "/payload/1.55.0", {
			token: CUSTOMER_KEY,
		});
		assert.equal(res.status, 503);
		assert.equal(await res.text(), '{"error":"download unavailable"}');
		assert.equal(res.headers.get("cache-control"), "private, no-store");
		assert.equal(logLines.join("").includes("SECRET_URL"), false);
	}
});

test("link expiry is anchored before auth I/O and checked before and after signing", async () => {
	for (const phase of ["auth", "head", "sign"]) {
		const { deps, bucket, clock, calls } = presignedDeps();
		if (phase === "auth") {
			const get = bucket.get.bind(bucket);
			bucket.get = async (key) => {
				const object = await get(key);
				if (key.startsWith("keys/")) clock.tick(60000);
				return object;
			};
		} else if (phase === "head") {
			const head = bucket.head.bind(bucket);
			bucket.head = async (key) => {
				clock.tick(60000);
				return head(key);
			};
		} else {
			const sign = deps.delivery.signGet;
			deps.delivery.signGet = async (input) => {
				const url = await sign(input);
				clock.tick(60000);
				return url;
			};
		}
		const res = await request(deps, "GET", "/payload/1.55.0", {
			token: CUSTOMER_KEY,
		});
		assert.equal(res.status, 503, phase);
		assert.equal(await res.text(), '{"error":"download unavailable"}');
		assert.equal(calls.length, phase === "sign" ? 1 : 0);
	}
});

test("oversized keys and unreadable key storage return the same 401 without signing", async () => {
	const { deps, bucket, calls } = presignedDeps();
	const oversized = "x".repeat(513);
	seedKey(bucket, oversized);
	const tooLong = await request(deps, "GET", "/payload/1.55.0", {
		token: oversized,
	});
	assert.equal(tooLong.status, 401);
	const get = bucket.get.bind(bucket);
	bucket.get = async (key) => {
		if (key.startsWith("keys/")) throw new Error("PRIVATE_STORE_ERROR");
		return get(key);
	};
	for (const path of ["/manifest", "/payload/1.55.0"]) {
		const res = await request(deps, "GET", path, { token: CUSTOMER_KEY });
		assert.equal(res.status, 401);
		assert.equal(await res.text(), '{"error":"invalid or revoked key"}');
	}
	assert.equal(calls.length, 0);
});

test("Worker explicitly selects presigned mode and fails closed without signer credentials", async () => {
	const { bucket } = presignedDeps();
	const env = {
		PAYLOADS: bucket,
		FW_R2_ACCOUNT_ID: "a".repeat(32),
		FW_R2_BUCKET: "flywheel-payloads",
		FW_R2_ACCESS_KEY_ID: "test-access",
		FW_R2_SECRET_ACCESS_KEY: "test-secret",
	};
	const fetch = () =>
		worker.fetch(
			new Request("https://worker.test/payload/1.55.0", {
				headers: { authorization: `Bearer ${CUSTOMER_KEY}` },
			}),
			env,
		);
	assert.equal((await fetch()).status, 302);
	delete env.FW_R2_SECRET_ACCESS_KEY;
	const unavailable = await fetch();
	assert.equal(unavailable.status, 503);
	assert.equal(await unavailable.text(), '{"error":"download unavailable"}');
});

test("presign validates HEAD metadata and corrupt manifests; unsafe paths never reach signer", async () => {
	for (const change of [
		"missing",
		"size",
		"sha",
		"manifest-json",
		"manifest-shape",
	]) {
		const { deps, bucket, manifest, calls } = presignedDeps();
		const entry = manifest.versions["1.55.0"];
		if (change === "missing") await bucket.delete(entry.key);
		if (change === "size")
			bucket.seed(entry.key, "short", { sha256: entry.sha256 });
		if (change === "sha")
			bucket.seed(entry.key, new Uint8Array(entry.size), {
				sha256: "f".repeat(64),
			});
		if (change === "manifest-json")
			bucket.seed("manifest.json", "SECRET_CORRUPT{");
		if (change === "manifest-shape")
			bucket.seed("manifest.json", { ...manifest, schemaVersion: 99 });
		const res = await request(deps, "GET", "/payload/1.55.0", {
			token: CUSTOMER_KEY,
		});
		assert.equal(res.status, change.startsWith("manifest") ? 503 : 404, change);
		assert.equal(
			await res.text(),
			change.startsWith("manifest")
				? '{"error":"download unavailable"}'
				: '{"error":"not found"}',
		);
		assert.equal(calls.length, 0);
	}
	const { deps, calls } = presignedDeps();
	for (const path of [
		"/payload/%FF",
		"/payload/a%2fb",
		"/payload/%252e%252e",
		"/payload/v1.55.0",
	]) {
		const res = await request(deps, "GET", path, { token: CUSTOMER_KEY });
		assert.equal(res.status, 404);
		assert.equal(await res.text(), '{"error":"not found"}');
	}
	for (const method of ["HEAD", "PUT", "POST"]) {
		assert.equal(
			(await request(deps, method, "/payload/1.55.0", { token: CUSTOMER_KEY }))
				.status,
			404,
		);
	}
	assert.equal(calls.length, 0);
});

test("valid customer key → customer-release view (latest + release-only versions)", async () => {
	const { deps } = seededDeps();
	const res = await request(deps, "GET", "/manifest", { token: CUSTOMER_KEY });
	assert.equal(res.status, 200);
	const view = await res.json();
	assert.deepEqual(view, {
		latest: "1.55.0",
		versions: [{ ver: "1.55.0", sha256: "b".repeat(64) }],
	});
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
	// Active history past its retention deadline is hidden before cleanup runs.
	const iview = await (
		await request(deps, "GET", "/manifest", { token: INTERNAL_KEY })
	).json();
	assert.ok(!iview.versions.some((v) => v.ver === "1.54.0-beta.1"));
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
	const { deps, clock } = seededDeps({ manifest });
	const view = await (
		await request(deps, "GET", "/manifest", { token: CUSTOMER_KEY })
	).json();
	assert.equal(view.latest, "1.55.0");
	assert.ok(view.versions.some((v) => v.ver === "1.54.0"));
	const res = await request(deps, "GET", "/payload/1.54.0", {
		token: CUSTOMER_KEY,
	});
	assert.equal(res.status, 200);
	for (const [at, expected] of [
		["2026-07-28T23:59:59.999Z", 200],
		["2026-07-29T00:00:00.000Z", 404],
		["2026-07-29T00:00:00.001Z", 404],
	]) {
		clock.set(at);
		assert.equal(
			(await request(deps, "GET", "/payload/1.54.0", { token: CUSTOMER_KEY }))
				.status,
			expected,
		);
		const view = await (
			await request(deps, "GET", "/manifest", { token: CUSTOMER_KEY })
		).json();
		assert.equal(
			view.versions.some((v) => v.ver === "1.54.0"),
			expected === 200,
		);
	}
	const presigned = presignedDeps();
	deps.delivery = presigned.deps.delivery;
	const old = manifest.versions["1.54.0"];
	deps.bucket.seed(old.key, new Uint8Array(old.size), { sha256: old.sha256 });
	clock.set("2026-07-28T23:59:40.500Z");
	const short = await request(deps, "GET", "/payload/1.54.0", {
		token: CUSTOMER_KEY,
	});
	assert.equal(short.status, 302);
	const signedUrl = new URL(short.headers.get("location"));
	assert.equal(signedUrl.searchParams.get("X-Amz-Expires"), "20");
	assert.equal(signedUrl.searchParams.get("X-Amz-Date"), "20260728T235940Z");
	deps.delivery = { mode: "stream" };
	clock.set("2027-07-01T00:00:00.000Z");
	assert.equal(
		(await request(deps, "GET", "/payload/1.55.0", { token: CUSTOMER_KEY }))
			.status,
		200,
	);
	assert.equal(
		(
			await request(deps, "GET", "/payload/1.55.0-beta.1", {
				token: INTERNAL_KEY,
			})
		).status,
		200,
	);
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

test("paused customer channel returns the frozen no-release wire and refuses new customer keys", async () => {
	const { deps } = seededDeps();
	const before = await getManifest(deps);
	const paused = edit(before.manifest, (manifest) => {
		manifest.versions["1.55.0"].status = "quarantined";
		manifest.channels["customer-release"].latest = null;
	});
	const transition = await postManifest(
		deps,
		paused,
		before.etag,
		TOKENS.release,
	);
	assert.equal(transition.status, 200);

	const after = await getManifest(deps);
	assert.equal(
		after.manifest.versions["1.55.0"].quarantinedAt,
		"2026-07-11T00:00:00.000Z",
	);
	assert.equal(
		after.manifest.versions["1.55.0"].retentionSince,
		"2026-07-11T00:00:00.000Z",
	);

	const customerView = await request(deps, "GET", "/manifest", {
		token: CUSTOMER_KEY,
	});
	assert.equal(customerView.status, 503);
	assert.equal(await customerView.text(), '{"error":"no-release-available"}');

	const keyIssue = await request(deps, "PUT", `/admin/key/${"9".repeat(64)}`, {
		token: TOKENS.ops,
		body: {
			customerId: "paused-customer",
			entitlement: "customer",
			revoked: false,
		},
	});
	assert.equal(keyIssue.status, 409);
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
