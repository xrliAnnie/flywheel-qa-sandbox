import assert from "node:assert/strict";
import { test } from "node:test";
import {
	edit,
	fixtureManifest,
	getManifest,
	makeDeps,
	postManifest,
	seedBucketForManifest,
	TOKENS,
} from "./harness.mjs";

function seeded(channel = "release", elapsed = true) {
	const fixture = makeDeps();
	const manifest = fixtureManifest();
	const ver = channel === "release" ? "1.55.0" : "1.55.0-beta.1";
	manifest.channels[
		channel === "release" ? "customer-release" : "internal-beta"
	].latest = null;
	manifest.versions[ver].retentionSince = elapsed
		? "2026-06-01T00:00:00.000Z"
		: "2026-07-10T00:00:00.000Z";
	seedBucketForManifest(fixture.bucket, manifest);
	return { ...fixture, ver };
}

test("release capability expires elapsed release history and replay is idempotent", async () => {
	const { deps, ver } = seeded();
	const current = await getManifest(deps);
	const expired = edit(current.manifest, (m) => {
		m.versions[ver].status = "expired";
	});
	const response = await postManifest(
		deps,
		expired,
		current.etag,
		TOKENS.release,
	);
	assert.equal(response.status, 200, await response.text());
	const after = await getManifest(deps);
	assert.equal(after.manifest.versions[ver].status, "expired");
	assert.equal(
		(await postManifest(deps, after.manifest, after.etag, TOKENS.release))
			.status,
		200,
	);
});

for (const [channel, elapsed, status] of [
	["release", false, 422],
	["beta", true, 403],
]) {
	test(`release capability refuses expire channel=${channel} elapsed=${elapsed} without writes`, async () => {
		const { deps, bucket, ver } = seeded(channel, elapsed);
		const before = bucket.rawBytes("manifest.json");
		const current = await getManifest(deps);
		const expired = edit(current.manifest, (m) => {
			m.versions[ver].status = "expired";
		});
		const response = await postManifest(
			deps,
			expired,
			current.etag,
			TOKENS.release,
		);
		assert.equal(response.status, status, await response.text());
		assert.deepEqual(bucket.rawBytes("manifest.json"), before);
	});
}

test("release capability cannot tombstone expired release history", async () => {
	const { deps, bucket, ver } = seeded();
	const current = await getManifest(deps);
	const expired = edit(current.manifest, (m) => {
		m.versions[ver].status = "expired";
	});
	assert.equal(
		(await postManifest(deps, expired, current.etag, TOKENS.ops)).status,
		200,
	);
	const after = await getManifest(deps);
	const before = bucket.rawBytes("manifest.json");
	const tombstoned = edit(after.manifest, (m) => {
		m.tombstones.push(m.versions[ver].key);
	});
	assert.equal(
		(await postManifest(deps, tombstoned, after.etag, TOKENS.release)).status,
		403,
	);
	assert.deepEqual(bucket.rawBytes("manifest.json"), before);
});
