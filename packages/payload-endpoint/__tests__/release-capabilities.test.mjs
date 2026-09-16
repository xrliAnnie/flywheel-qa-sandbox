import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fixtureManifest,
	makeDeps,
	payloadKeyOf,
	request,
	seedBucketForManifest,
	sha256Hex,
	TOKENS,
} from "./harness.mjs";

const executor = "auto-executor-fixture";
const decision = "decision-writer-fixture";
function setup() {
	const { deps, bucket, logLines } = makeDeps({
		tokens: {
			...TOKENS,
			autoReleaseExecutor: executor,
			releaseDecision: decision,
		},
	});
	const manifest = fixtureManifest({ withRelease: false });
	manifest.releaseOps.candidate = {
		kind: "release",
		state: "prepared",
		ver: "1.55.0",
		betaVersion: "1.55.0-beta.1",
		sourceCommit: "c".repeat(40),
		sha256: "b".repeat(64),
		objectKey: payloadKeyOf("1.55.0", "b".repeat(64)),
		createdAt: "2026-07-01T00:00:00.000Z",
	};
	seedBucketForManifest(bucket, manifest);
	bucket.seed(manifest.releaseOps.candidate.objectKey, "prepared bytes", {
		sha256: "b".repeat(64),
		ver: "1.55.0",
	});
	return { deps, bucket, manifest, logLines };
}
test("new release capabilities are disabled when their hashes are absent", async () => {
	const { deps } = makeDeps();
	for (const token of [executor, decision])
		assert.equal(
			(await request(deps, "GET", "/admin/manifest", { token })).status,
			401,
		);
});
test("both narrow roles can read the manifest and executor reads only active prepared artifacts", async () => {
	const { deps, manifest, bucket } = setup();
	for (const token of [executor, decision])
		assert.equal(
			(await request(deps, "GET", "/admin/manifest", { token })).status,
			200,
		);
	const path = `/admin/payload/1.55.0/${"b".repeat(64)}`;
	assert.equal(
		(await request(deps, "GET", path, { token: executor })).status,
		200,
	);
	assert.equal(
		(await request(deps, "GET", path, { token: decision })).status,
		403,
	);
	assert.equal(
		(
			await request(
				deps,
				"GET",
				`/admin/payload/1.55.0-beta.1/${"a".repeat(64)}`,
				{ token: executor },
			)
		).status,
		403,
	);
	manifest.versions["1.55.0-beta.1"].status = "withdrawn";
	bucket.seed("manifest.json", JSON.stringify(manifest));
	assert.equal(
		(await request(deps, "GET", path, { token: executor })).status,
		403,
	);
});
for (const token of [executor, decision])
	test(`narrow role rejects old write surfaces including no-op manifest: ${token}`, async () => {
		const { deps, bucket, manifest, logLines } = setup();
		const before = await (await bucket.get("manifest.json")).json();
		for (const [method, path, body] of [
			[
				"POST",
				"/admin/manifest",
				{ baseEtag: (await bucket.get("manifest.json")).etag, manifest },
			],
			["PUT", `/admin/payload/1.55.0/${"b".repeat(64)}`, "bytes"],
			["DELETE", `/admin/payload/1.55.0/${"b".repeat(64)}`],
			["POST", "/admin/keys", {}],
			["GET", "/admin/keys"],
			["POST", "/admin/keys/key/revoke", {}],
		]) {
			assert.equal(
				(await request(deps, method, path, { token, body })).status,
				403,
			);
		}
		assert.deepEqual(await (await bucket.get("manifest.json")).json(), before);
		assert.ok(logLines.every((line) => !line.includes(token)));
	});
for (const broken of [
	"missing",
	"duplicate",
	"old-role-duplicate",
	"malformed",
])
	test(`invalid narrow-role configuration fails closed: ${broken}`, async () => {
		const { deps } = setup();
		if (broken === "missing") delete deps.secrets.releaseDecisionTokenSha256;
		if (broken === "duplicate")
			deps.secrets.releaseDecisionTokenSha256 =
				deps.secrets.autoReleaseExecutorTokenSha256;
		if (broken === "old-role-duplicate")
			deps.secrets.releaseDecisionTokenSha256 =
				deps.secrets.customerReleaseTokenSha256;
		if (broken === "malformed")
			deps.secrets.releaseDecisionTokenSha256 = "invalid";
		for (const token of [executor, decision, TOKENS.release])
			assert.equal(
				(await request(deps, "GET", "/admin/manifest", { token })).status,
				503,
			);
	});

test("Worker forwards both isolated role hashes without exposing old write authority", async () => {
	const worker = (await import("../src/worker.mjs")).default;
	const { bucket } = setup();
	const env = {
		PAYLOADS: bucket,
		FW_AUTO_RELEASE_EXECUTOR_TOKEN_SHA256: sha256Hex(executor),
		FW_RELEASE_DECISION_TOKEN_SHA256: sha256Hex(decision),
	};
	for (const token of [executor, decision]) {
		const response = await worker.fetch(
			new Request("https://endpoint.test/admin/manifest", {
				headers: { authorization: `Bearer ${token}` },
			}),
			env,
		);
		assert.equal(response.status, 200);
	}
	assert.equal(
		(
			await worker.fetch(
				new Request("https://endpoint.test/admin/manifest", {
					method: "POST",
					headers: { authorization: `Bearer ${decision}` },
					body: "{}",
				}),
				env,
			)
		).status,
		403,
	);
});
