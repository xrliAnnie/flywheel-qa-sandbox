import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	fixtureManifest,
	makeDeps,
	payloadKeyOf,
	seedBucketForManifest,
	TOKENS,
} from "../../packages/payload-endpoint/__tests__/harness.mjs";
import { handleRequest } from "../../packages/payload-endpoint/src/handler.mjs";

const exec = promisify(execFile);
test(
	"manual CLI uses the shared commit diff and preserves bound idempotent replay",
	{ timeout: 180_000 },
	async () => {
		const { deps, bucket } = makeDeps();
		const m = fixtureManifest({ withRelease: false });
		const bytes = Buffer.from("verified prepared customer payload");
		const sha = createHash("sha256").update(bytes).digest("hex");
		m.releaseOps.candidate = {
			kind: "release",
			state: "prepared",
			ver: "1.55.0",
			betaVersion: "1.55.0-beta.1",
			sourceCommit: "c".repeat(40),
			sha256: sha,
			objectKey: payloadKeyOf("1.55.0", sha),
			createdAt: "2026-07-01T00:00:00.000Z",
		};
		seedBucketForManifest(bucket, m);
		bucket.seed(m.releaseOps.candidate.objectKey, bytes, {
			sha256: sha,
			ver: "1.55.0",
		});
		let manifestWrites = 0;
		const server = http.createServer(async (req, res) => {
			try {
				const parts = [];
				for await (const part of req) parts.push(part);
				const body = Buffer.concat(parts);
				if (req.method === "POST" && req.url === "/admin/manifest")
					manifestWrites++;
				const response = await handleRequest(
					new Request(`http://endpoint.test${req.url}`, {
						method: req.method,
						headers: req.headers,
						...(body.length ? { body } : {}),
					}),
					deps,
				);
				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(Buffer.from(await response.arrayBuffer()));
			} catch {
				res.writeHead(500);
				res.end();
			}
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		try {
			const env = {
				...process.env,
				FW_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
				FW_CUSTOMER_RELEASE_TOKEN: TOKENS.release,
				GITHUB_OUTPUT: "",
			};
			const command = fileURLToPath(
				new URL("../release/payload-promote.mjs", import.meta.url),
			);
			const run = (hash) =>
				exec(
					process.execPath,
					[
						command,
						"commit",
						"--release-id",
						"candidate",
						"--expected-sha256",
						hash,
					],
					{
						env,
						timeout: 60_000,
						maxBuffer: 1024 * 1024,
					},
				);
			const first = await run(sha);
			assert.match(first.stdout, /"outcome":"committed"/);
			assert.equal(manifestWrites, 1);
			const stored = await (await bucket.get("manifest.json")).json();
			assert.equal(stored.channels["customer-release"].latest, "1.55.0");
			assert.equal(stored.versions["1.55.0"].sha256, sha);
			assert.equal(stored.releaseOps.candidate.state, "committed");
			assert.match((await run(sha)).stdout, /"outcome":"idempotent"/);
			assert.equal(manifestWrites, 1);
			await assert.rejects(run("f".repeat(64)));
			assert.equal(manifestWrites, 1);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	},
);
