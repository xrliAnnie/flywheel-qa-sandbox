import assert from "node:assert/strict";
import { test } from "node:test";
import { makeClient } from "../release/lib/endpoint-client.mjs";

const iso = "2026-09-13T03:04:05.678Z";
const client = () =>
	makeClient({ endpoint: "https://endpoint.test", token: "fixture" });
function manifestResponse(time = iso) {
	return new Response(JSON.stringify({ schemaVersion: 1 }), {
		headers: {
			etag: `"${"a".repeat(32)}"`,
			...(time === null ? {} : { "x-fw-server-time": time }),
		},
	});
}
async function withFetch(fake, fn) {
	const original = globalThis.fetch;
	globalThis.fetch = fake;
	try {
		await fn();
	} finally {
		globalThis.fetch = original;
	}
}

test("readManifest parses optional canonical server time, preserving headerless clients", async () => {
	for (const time of [iso, null]) {
		await withFetch(
			async () => manifestResponse(time),
			async () => {
				assert.equal(
					(await client().readManifest()).serverNowMs,
					time === null ? null : Date.parse(iso),
				);
			},
		);
	}
});

test("required missing time and any malformed time fail before mutation or POST", async () => {
	for (const time of [
		null,
		"invalid",
		"2026-09-13",
		"2026-02-30T00:00:00.000Z",
	]) {
		for (const requireServerTime of [true, false]) {
			if (time === null && !requireServerTime) continue;
			let posts = 0;
			await withFetch(
				async (_url, init) => {
					if (init.method === "POST") posts++;
					return manifestResponse(time);
				},
				async () => {
					await assert.rejects(
						client().casUpdate(
							() => {
								throw new Error("mutate called");
							},
							"withdraw",
							{ requireServerTime },
						),
						/server time/,
					);
				},
			);
			assert.equal(posts, 0);
		}
	}
});

for (const guard of [
	"re-pin refused — retention deadline passed",
	"expire refused — retention window not elapsed",
]) {
	test(`time guard re-reads and derives with fresh server time: ${guard}`, async () => {
		let gets = 0;
		let posts = 0;
		const seen = [];
		await withFetch(
			async (_url, init) => {
				if (init.method === "GET")
					return manifestResponse(
						new Date(Date.parse(iso) + gets++ * 1000).toISOString(),
					);
				posts++;
				return new Response(
					JSON.stringify({ violations: [`versions[1.2.3]: ${guard}`] }),
					{ status: 422 },
				);
			},
			async () => {
				const result = await client().casUpdate(
					(_copy, _current, context) => {
						seen.push(context?.serverNowMs);
						return seen.length === 1;
					},
					"withdraw",
					{ requireServerTime: true, timeGuardRetries: 3 },
				);
				assert.equal(result.skipped, true);
			},
		);
		assert.deepEqual(seen, [Date.parse(iso), Date.parse(iso) + 1000]);
		assert.equal(posts, 1);
	});
}

for (const [violations, retries, expectedPosts] of [
	[["versions[1.2.3]: re-pin refused — retention deadline passed"], 3, 4],
	[["versions[1.2.3]: re-pin refused — retention deadline passed"], 0, 1],
	[["versions[1.2.3]: expire refused — still a channel latest"], 3, 1],
	[
		[
			"versions[1.2.3]: re-pin refused — retention deadline passed",
			"unrelated violation",
		],
		3,
		1,
	],
]) {
	test(`422 retry bound=${retries}, expected requests=${expectedPosts}: ${violations}`, async () => {
		let posts = 0;
		await withFetch(
			async (_url, init) => {
				if (init.method === "GET") return manifestResponse();
				posts++;
				return new Response(JSON.stringify({ violations }), { status: 422 });
			},
			async () => {
				await assert.rejects(
					client().casUpdate(() => true, "withdraw", {
						requireServerTime: true,
						timeGuardRetries: retries,
					}),
					/HTTP 422/,
				);
			},
		);
		assert.equal(posts, expectedPosts);
	});
}
