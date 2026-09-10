import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityAllows } from "../src/transitions.mjs";
import {
	edit,
	emptyManifest,
	fixtureManifest,
	getManifest,
	makeDeps,
	payloadKeyOf,
	postManifest,
	request,
	seedBucketForManifest,
	sha256Hex,
	TOKENS,
} from "./harness.mjs";

const cleanup = "cleanup-token-fixture";
function seeded() {
	const fixture = makeDeps();
	fixture.deps.secrets.cleanupTokenSha256 = sha256Hex(cleanup);
	const manifest = fixtureManifest();
	const ver = "1.54.0-beta.1";
	const entry = {
		...manifest.versions["1.55.0-beta.1"],
		sha256: "d".repeat(64),
		key: payloadKeyOf(ver, "d".repeat(64)),
		releaseId: "old-beta",
		retentionSince: "2026-01-01T00:00:00.000Z",
	};
	manifest.versions[ver] = entry;
	manifest.releaseOps[entry.releaseId] = {
		...manifest.releaseOps["op-beta-1"],
		ver,
		sha256: entry.sha256,
		objectKey: entry.key,
	};
	manifest.releaseLedger["1.54.0"] = { nextBetaN: 2 };
	seedBucketForManifest(fixture.bucket, manifest);
	return { ...fixture, ver, entry };
}

test("cleanup can expire, tombstone and delete history, replaying the barrier without touching current", async () => {
	const { deps, bucket, ver, entry } = seeded();
	const current = await getManifest(deps, cleanup);
	assert.equal(current.status, 200);
	const expired = edit(current.manifest, (m) => {
		m.versions[ver].status = "expired";
	});
	assert.equal(
		(await postManifest(deps, expired, current.etag, cleanup)).status,
		200,
	);
	let cur = await getManifest(deps, cleanup);
	const tombstoned = edit(cur.manifest, (m) => {
		m.tombstones.push(entry.key);
	});
	assert.equal(
		(await postManifest(deps, tombstoned, cur.etag, cleanup)).status,
		200,
	);
	const remove = bucket.delete.bind(bucket);
	bucket.delete = async () => {
		throw new Error("storage unavailable");
	};
	assert.equal(
		(
			await request(deps, "DELETE", `/admin/payload/${ver}/${entry.sha256}`, {
				token: cleanup,
			})
		).status,
		500,
	);
	assert.ok(bucket.rawBytes(entry.key));
	assert.ok(
		(await getManifest(deps, cleanup)).manifest.tombstones.includes(entry.key),
	);
	bucket.delete = remove;
	for (let i = 0; i < 2; i++)
		assert.equal(
			(
				await request(deps, "DELETE", `/admin/payload/${ver}/${entry.sha256}`, {
					token: cleanup,
				})
			).status,
			200,
		);
	assert.equal(bucket.rawBytes(entry.key), null);
	cur = await getManifest(deps, cleanup);
	assert.equal(
		(await postManifest(deps, cur.manifest, cur.etag, cleanup)).status,
		200,
	);
	assert.ok(bucket.rawBytes(cur.manifest.versions["1.55.0"].key));
	assert.ok(bucket.rawBytes(cur.manifest.versions["1.55.0-beta.1"].key));
});

test("cleanup cannot initialize, issue/revoke, upload/readback or perform publication operations", async () => {
	const { deps, bucket } = seeded();
	for (const [method, path] of [
		["PUT", `/admin/key/${"a".repeat(64)}`],
		["POST", `/admin/key/${"a".repeat(64)}/revoke`],
		["GET", `/admin/payload/1.55.0/${"b".repeat(64)}`],
		["PUT", `/admin/payload/1.55.0/${"b".repeat(64)}`],
	]) {
		assert.equal(
			(await request(deps, method, path, { token: cleanup })).status,
			403,
		);
	}
	const before = bucket.rawBytes("manifest.json");
	const cur = await getManifest(deps, cleanup);
	const quarantine = edit(cur.manifest, (m) => {
		m.versions["1.55.0"].status = "quarantined";
		m.channels["customer-release"].latest = null;
	});
	assert.equal(
		(await postManifest(deps, quarantine, cur.etag, cleanup)).status,
		403,
	);
	assert.deepEqual(bucket.rawBytes("manifest.json"), before);
	assert.equal(
		(
			await request(deps, "DELETE", `/admin/payload/1.55.0/${"b".repeat(64)}`, {
				token: cleanup,
			})
		).status,
		409,
	);
	for (const type of [
		"pointer",
		"addVersion",
		"reserveBeta",
		"reserveRelease",
		"registerTuple",
		"toPrepared",
		"commitOp",
		"abandon",
		"quarantine",
		"ledger",
		"unknown",
	]) {
		assert.equal(
			capabilityAllows("cleanup", {
				type,
				channel: "customer-release",
				kind: "release",
			}),
			false,
			type,
		);
	}
	await bucket.delete("manifest.json");
	assert.equal(
		(await postManifest(deps, emptyManifest(), null, cleanup)).status,
		403,
	);
	assert.equal(bucket.rawBytes("manifest.json"), null);
});

test("duplicate capability hashes reject every admin token with a fixed configuration error", async () => {
	const { deps, bucket } = seeded();
	deps.secrets.cleanupTokenSha256 =
		deps.secrets.opsAdminTokenSha256.toUpperCase();
	for (const token of [cleanup, TOKENS.ops, TOKENS.beta, TOKENS.release]) {
		const res = await request(deps, "GET", "/admin/manifest", { token });
		assert.equal(res.status, 503);
		assert.equal(
			await res.text(),
			'{"error":"capability configuration invalid"}',
		);
	}
	assert.equal(bucket.observations.puts.length, 0);
});
