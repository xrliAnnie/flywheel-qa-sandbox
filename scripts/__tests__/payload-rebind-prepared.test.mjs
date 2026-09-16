import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	fixtureManifest,
	makeDeps,
	payloadKeyOf,
	seedBucketForManifest,
	TOKENS,
} from "../../packages/payload-endpoint/__tests__/harness.mjs";
import { handleRequest } from "../../packages/payload-endpoint/src/handler.mjs";
import { deriveVetoBinding } from "../../packages/payload-endpoint/src/manifest.mjs";
import { makeClient } from "../release/lib/endpoint-client.mjs";
import { rebindPreparedArtifact } from "../release/lib/rebind-prepared-artifact.mjs";

function setup(t) {
	const ctx = makeDeps(),
		m = fixtureManifest({ withRelease: false });
	const bytes = Buffer.from("same immutable customer artifact"),
		sha = createHash("sha256").update(bytes).digest("hex");
	m.releaseOps.source = {
		kind: "release",
		state: "prepared",
		ver: "1.55.0",
		betaVersion: "1.55.0-beta.1",
		sourceCommit: "c".repeat(40),
		sha256: sha,
		objectKey: payloadKeyOf("1.55.0", sha),
		createdAt: "2026-07-01T00:00:00.000Z",
	};
	const binding = deriveVetoBinding(m, "source");
	m.releaseOps.source.state = "abandoned";
	seedBucketForManifest(ctx.bucket, m);
	ctx.bucket.seed(m.releaseOps.source.objectKey, bytes, {
		sha256: sha,
		ver: "1.55.0",
	});
	const methods = [];
	t.mock.method(globalThis, "fetch", async (url, options) => {
		methods.push([options.method, new URL(url).pathname]);
		return handleRequest(new Request(url, options), ctx.deps);
	});
	const client = makeClient({
		endpoint: "https://endpoint.test",
		token: TOKENS.beta,
	});
	const input = {
		sourceReleaseId: "source",
		releaseId: "manual-new",
		sourceBindingDigest: createHash("sha256")
			.update(JSON.stringify(binding))
			.digest("hex"),
	};
	return { ...ctx, m, bytes, sha, methods, client, input };
}
test("rebind preserves abandoned source and identical bytes, creates a new prepared identity, replay writes nothing", async (t) => {
	const c = setup(t);
	const original = structuredClone(c.m.releaseOps.source);
	const result = await rebindPreparedArtifact(c.client, c.input);
	assert.equal(result.binding.releaseId, "manual-new");
	assert.equal(result.binding.releasePayloadSha256, c.sha);
	const m = await (await c.bucket.get("manifest.json")).json();
	assert.deepEqual(m.releaseOps.source, original);
	assert.equal(m.releaseOps["manual-new"].state, "prepared");
	assert.equal(m.releaseOps["manual-new"].objectKey, original.objectKey);
	assert.equal(m.channels["customer-release"].latest, null);
	assert.equal(
		c.methods.some(([method]) => method === "PUT"),
		false,
	);
	const writes = c.bucket.observations.puts.length;
	await rebindPreparedArtifact(c.client, c.input);
	assert.equal(c.bucket.observations.puts.length, writes);
});
for (const fault of [
	"source-live",
	"digest",
	"corrupt",
	"missing",
	"beta-inactive",
	"tombstone",
	"target-abandoned",
	"target-conflict",
])
	test(`rebind rejects ${fault} without reviving or publishing`, async (t) => {
		const c = setup(t);
		if (fault === "source-live") c.m.releaseOps.source.state = "prepared";
		if (fault === "digest") c.input.sourceBindingDigest = "f".repeat(64);
		if (fault === "corrupt")
			c.bucket.seed(c.m.releaseOps.source.objectKey, "corrupt", {
				sha256: c.sha,
			});
		if (fault === "missing")
			await c.bucket.delete(c.m.releaseOps.source.objectKey);
		if (fault === "beta-inactive")
			c.m.versions["1.55.0-beta.1"].status = "quarantined";
		if (fault === "tombstone")
			c.m.tombstones.push(c.m.releaseOps.source.objectKey);
		if (fault === "target-abandoned")
			c.m.releaseOps["manual-new"] = { ...c.m.releaseOps.source };
		if (fault === "target-conflict")
			c.m.releaseOps["manual-new"] = {
				...c.m.releaseOps.source,
				state: "reserved",
				sourceCommit: "f".repeat(40),
			};
		c.bucket.seed("manifest.json", JSON.stringify(c.m));
		const before = c.bucket.rawBytes("manifest.json");
		await assert.rejects(rebindPreparedArtifact(c.client, c.input));
		assert.deepEqual(c.bucket.rawBytes("manifest.json"), before);
	});
test("crash after reserve recovers same target with fresh readback and no new identity", async (t) => {
	const c = setup(t);
	const original = c.client.readbackVerify;
	let reads = 0;
	c.client.readbackVerify = async (...args) => {
		if (++reads === 2) throw Error("interrupted");
		return original(...args);
	};
	await assert.rejects(rebindPreparedArtifact(c.client, c.input));
	let m = await (await c.bucket.get("manifest.json")).json();
	assert.equal(m.releaseOps["manual-new"].state, "reserved");
	c.client.readbackVerify = original;
	await rebindPreparedArtifact(c.client, c.input);
	m = await (await c.bucket.get("manifest.json")).json();
	assert.equal(m.releaseOps["manual-new"].state, "prepared");
	assert.equal(Object.keys(m.releaseOps).length, 3);
});

test("promote CLI exposes rebind using only beta capability, with no package build or payload upload", async (t) => {
	const { execFile } = await import("node:child_process"),
		{ promisify } = await import("node:util"),
		http = await import("node:http");
	const c = setup(t);
	const methods = [];
	const server = http.createServer(async (req, res) => {
		try {
			const parts = [];
			for await (const part of req) parts.push(part);
			const body = Buffer.concat(parts);
			methods.push(req.method);
			assert.equal(req.headers.authorization, `Bearer ${TOKENS.beta}`);
			const r = await handleRequest(
				new Request(`http://endpoint.test${req.url}`, {
					method: req.method,
					headers: req.headers,
					...(body.length ? { body } : {}),
				}),
				c.deps,
			);
			res.writeHead(r.status, Object.fromEntries(r.headers));
			res.end(Buffer.from(await r.arrayBuffer()));
		} catch {
			res.writeHead(503);
			res.end("{}");
		}
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	try {
		const args = [
			new URL("../release/payload-promote.mjs", import.meta.url).pathname,
			"rebind-prepared-artifact",
			"--source-release-id",
			"source",
			"--release-id",
			"manual-new",
			"--source-binding-digest",
			c.input.sourceBindingDigest,
		];
		const opts = {
			env: {
				...process.env,
				FW_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
				FW_BETA_PUBLISH_TOKEN: TOKENS.beta,
				FW_PACKER: "/must-not-build",
				GITHUB_OUTPUT: "",
			},
			timeout: 15000,
		};
		await promisify(execFile)(process.execPath, args, opts);
		const count = methods.filter((m) => m === "POST").length;
		await promisify(execFile)(process.execPath, args, opts);
		assert.equal(methods.filter((m) => m === "POST").length, count);
		assert.equal(methods.includes("PUT"), false);
		const m = await (await c.bucket.get("manifest.json")).json();
		assert.equal(m.releaseOps["manual-new"].state, "prepared");
		assert.equal(m.releaseOps.source.state, "abandoned");
	} finally {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
	}
});

test("cleanup winning the reservation CAS prevents rebinding a tombstoned artifact", async (t) => {
	const c = setup(t);
	c.bucket.hooks.beforePut = async (key) => {
		assert.equal(key, "manifest.json");
		const current = await (await c.bucket.get("manifest.json")).json();
		current.tombstones.push(current.releaseOps.source.objectKey);
		c.bucket.seed("manifest.json", JSON.stringify(current));
	};
	await assert.rejects(rebindPreparedArtifact(c.client, c.input));
	const m = await (await c.bucket.get("manifest.json")).json();
	assert.equal(m.releaseOps["manual-new"], undefined);
	assert.equal(m.releaseOps.source.state, "abandoned");
	assert.equal(m.channels["customer-release"].latest, null);
});
