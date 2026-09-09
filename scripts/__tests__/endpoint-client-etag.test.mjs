import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";

import * as endpointClient from "../release/lib/endpoint-client.mjs";

const vectors = JSON.parse(
	fs.readFileSync(
		new URL("./fixtures/etag-vectors.json", import.meta.url),
		"utf8",
	),
);

test("endpoint client exposes a transport ETag normalizer", () => {
	assert.equal(typeof endpointClient.normalizeEtag, "function");
	assert.equal(typeof endpointClient.EtagProtocolError, "function");
});

test("normalizeEtag accepts only canonical R2 or harness ETags", () => {
	for (const vector of vectors.valid) {
		assert.equal(
			endpointClient.normalizeEtag(vector.input),
			vector.expected,
			vector.name,
		);
	}
	for (const vector of vectors.invalid) {
		assert.throws(
			() => endpointClient.normalizeEtag(vector.input),
			(error) =>
				error instanceof endpointClient.EtagProtocolError &&
				error.message === "invalid manifest ETag",
			vector.name,
		);
	}
});

async function withFetch(fake, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = fake;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

test("readManifest normalizes a weak response ETag", async () => {
	await withFetch(
		async () =>
			new Response(JSON.stringify({ schemaVersion: 1 }), {
				status: 200,
				headers: {
					"content-type": "application/json",
					etag: `W/"${"a".repeat(32)}"`,
				},
			}),
		async () => {
			const client = endpointClient.makeClient({
				endpoint: "https://endpoint.test",
				token: "fixture-token",
			});
			const current = await client.readManifest();
			assert.equal(current.etag, "a".repeat(32));
		},
	);
});

test("readManifest rejects a 200 response without a usable ETag", async () => {
	await withFetch(
		async () =>
			new Response(JSON.stringify({ schemaVersion: 1 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		async () => {
			const client = endpointClient.makeClient({
				endpoint: "https://endpoint.test",
				token: "fixture-token",
			});
			await assert.rejects(
				client.readManifest(),
				(error) => error instanceof endpointClient.EtagProtocolError,
			);
		},
	);
});

test("casUpdate reports the endpoint's safe 412 reason before re-judging", async () => {
	const logs = [];
	let mutations = 0;
	await withFetch(
		async (_url, init) => {
			if (init.method === "GET") {
				return new Response(JSON.stringify({ schemaVersion: 1 }), {
					status: 200,
					headers: {
						"content-type": "application/json",
						etag: `W/"${"b".repeat(32)}"`,
					},
				});
			}
			return new Response(
				JSON.stringify({ error: "etag mismatch", secret: "do-not-log" }),
				{ status: 412, headers: { "content-type": "application/json" } },
			);
		},
		async () => {
			const client = endpointClient.makeClient({
				endpoint: "https://endpoint.test",
				token: "fixture-token",
				log: (line) => logs.push(line),
			});
			const result = await client.casUpdate(() => ++mutations === 1, "reserve");
			assert.equal(result.skipped, true);
		},
	);
	assert.deepEqual(logs, [
		"reserve: CAS conflict (etag mismatch) — re-reading and re-judging (attempt 1)",
	]);
	assert.doesNotMatch(logs.join("\n"), /do-not-log/);
});

test("readbackVerify returns the verified byte size from the same stream", async () => {
	const bytes = Buffer.from("verified payload bytes");
	const sha = createHash("sha256").update(bytes).digest("hex");
	await withFetch(
		async () => new Response(bytes, { status: 200 }),
		async () => {
			const client = endpointClient.makeClient({
				endpoint: "https://endpoint.test",
				token: "fixture-token",
			});
			assert.deepEqual(await client.readbackVerify("1.2.3", sha), {
				size: bytes.length,
			});
		},
	);
});
