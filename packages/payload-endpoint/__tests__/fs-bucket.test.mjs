// FLY-1062 broker PR · FsBucket — durable filesystem bucket with the SAME R2
// binding subset + semantics the handler relies on (MemoryBucket parity):
// conditional put returns null (nothing written), storage-side sha256 rejects,
// etag = sha256(bytes), reads strongly consistent, durable across re-open.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FsBucket } from "../src/fs-bucket.mjs";

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

function tmpDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "fw-fs-bucket-"));
}

test("put/get roundtrip: bytes, etag=sha256, customMetadata, size", async () => {
	const bucket = new FsBucket(tmpDir());
	const bytes = Buffer.from("payload-bytes");
	const put = await bucket.put("payloads/1.0.0/abc.tgz", bytes, {
		customMetadata: { sha256: "abc", ver: "1.0.0" },
	});
	assert.equal(put.etag, sha256Hex(bytes));
	const got = await bucket.get("payloads/1.0.0/abc.tgz");
	assert.equal(got.size, bytes.length);
	assert.equal(got.etag, sha256Hex(bytes));
	assert.equal(got.httpEtag, `"${sha256Hex(bytes)}"`);
	assert.deepEqual(got.customMetadata, { sha256: "abc", ver: "1.0.0" });
	assert.equal(
		Buffer.from(await got.arrayBuffer()).toString(),
		"payload-bytes",
	);
});

test("get/head on a missing key → null", async () => {
	const bucket = new FsBucket(tmpDir());
	assert.equal(await bucket.get("nope.json"), null);
	assert.equal(await bucket.head("nope.json"), null);
});

test("json()/text() and body stream read", async () => {
	const bucket = new FsBucket(tmpDir());
	await bucket.put("manifest.json", JSON.stringify({ a: 1 }));
	const got = await bucket.get("manifest.json");
	assert.deepEqual(await got.json(), { a: 1 });
	const got2 = await bucket.get("manifest.json");
	const chunks = [];
	for await (const c of got2.body) chunks.push(Buffer.from(c));
	assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { a: 1 });
});

test("onlyIf etagDoesNotMatch '*': second put returns null, nothing written", async () => {
	const bucket = new FsBucket(tmpDir());
	const first = await bucket.put("obj", "v1", {
		onlyIf: { etagDoesNotMatch: "*" },
	});
	assert.ok(first);
	const second = await bucket.put("obj", "v2", {
		onlyIf: { etagDoesNotMatch: "*" },
	});
	assert.equal(second, null);
	assert.equal(await (await bucket.get("obj")).text(), "v1");
});

test("onlyIf etagMatches: wrong etag → null; right etag → written", async () => {
	const bucket = new FsBucket(tmpDir());
	const v1 = await bucket.put("obj", "v1");
	const miss = await bucket.put("obj", "v2", {
		onlyIf: { etagMatches: "not-the-etag" },
	});
	assert.equal(miss, null);
	assert.equal(await (await bucket.get("obj")).text(), "v1");
	const hit = await bucket.put("obj", "v2", {
		onlyIf: { etagMatches: v1.etag },
	});
	assert.ok(hit);
	assert.equal(await (await bucket.get("obj")).text(), "v2");
});

test("onlyIf etagMatches on a MISSING key → null (precondition fails)", async () => {
	const bucket = new FsBucket(tmpDir());
	const res = await bucket.put("obj", "v1", { onlyIf: { etagMatches: "x" } });
	assert.equal(res, null);
	assert.equal(await bucket.get("obj"), null);
});

test("storage-side sha256 verification: mismatch throws, nothing written", async () => {
	const bucket = new FsBucket(tmpDir());
	await assert.rejects(
		bucket.put("obj", "some-bytes", { sha256: "0".repeat(64) }),
		/sha256 mismatch/,
	);
	assert.equal(await bucket.get("obj"), null);
});

test("streaming put (async iterable body) hashes and stores without preload", async () => {
	const bucket = new FsBucket(tmpDir());
	const parts = [Buffer.from("part-1|"), Buffer.from("part-2")];
	const whole = Buffer.concat(parts);
	async function* gen() {
		for (const p of parts) yield p;
	}
	const put = await bucket.put("streamed", gen(), {
		sha256: sha256Hex(whole),
	});
	assert.equal(put.etag, sha256Hex(whole));
	assert.equal(await (await bucket.get("streamed")).text(), "part-1|part-2");
});

test("delete removes object and its metadata", async () => {
	const bucket = new FsBucket(tmpDir());
	await bucket.put("obj", "v1");
	await bucket.delete("obj");
	assert.equal(await bucket.get("obj"), null);
	assert.equal(await bucket.head("obj"), null);
});

test("durability: a NEW FsBucket over the same dir sees the data + metadata", async () => {
	const dir = tmpDir();
	const a = new FsBucket(dir);
	await a.put("keys/deadbeef.json", JSON.stringify({ revoked: false }), {
		customMetadata: { kind: "key" },
	});
	const b = new FsBucket(dir);
	const got = await b.get("keys/deadbeef.json");
	assert.deepEqual(await got.json(), { revoked: false });
	assert.deepEqual(got.customMetadata, { kind: "key" });
});

test("path traversal / absolute keys are rejected (fail-closed)", async () => {
	const bucket = new FsBucket(tmpDir());
	for (const bad of ["../escape", "a/../../b", "/abs/path", "a\\..\\b", ""]) {
		await assert.rejects(bucket.put(bad, "x"), /invalid key/);
		await assert.rejects(bucket.get(bad), /invalid key/);
	}
});

test("concurrent conditional creates: exactly one wins", async () => {
	const bucket = new FsBucket(tmpDir());
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) =>
			bucket.put("manifest.json", `writer-${i}`, {
				onlyIf: { etagDoesNotMatch: "*" },
			}),
		),
	);
	const winners = results.filter(Boolean);
	assert.equal(winners.length, 1);
});
