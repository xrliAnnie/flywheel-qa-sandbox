import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { makeClient } from "../../../scripts/release/lib/endpoint-client.mjs";
import {
	downloadPayload,
	fetchManifest,
} from "../../onboard-shell/lib/endpoint.mjs";
import { handleRequest } from "../src/handler.mjs";
import { createSignGet } from "../src/presign.mjs";
import {
	fixtureManifest,
	makeDeps,
	payloadKeyOf,
	seedBucketForManifest,
	seedKey,
	sha256Hex,
	TOKENS,
} from "./harness.mjs";

async function listen(t, handler) {
	const server = http.createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(
		() =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	);
	return `http://127.0.0.1:${server.address().port}`;
}

test("real shell follows cross-origin 302 without license headers, validates bytes, and distinguishes object 403", async (t) => {
	const payload = Buffer.from("B1-B2 transport fixture bytes");
	const sha = sha256Hex(payload);
	const key = "local-license-fixture";
	const manifest = fixtureManifest();
	const entry = manifest.versions["1.55.0"];
	Object.assign(entry, {
		sha256: sha,
		size: payload.length,
		key: payloadKeyOf("1.55.0", sha),
	});
	Object.assign(manifest.releaseOps[entry.releaseId], {
		sha256: sha,
		objectKey: entry.key,
	});
	// Start before customer publication; use the real B1 client to publish.
	delete manifest.versions["1.55.0"];
	delete manifest.releaseOps[entry.releaseId];
	manifest.channels["customer-release"].latest = null;
	const { deps, bucket } = makeDeps();
	seedBucketForManifest(bucket, manifest, { realBytes: { "1.55.0": payload } });
	seedKey(bucket, key);
	let objectStatus = 200;
	const received = [];
	const objectOrigin = await listen(t, (req, res) => {
		received.push({
			authorization: req.headers.authorization,
			cookie: req.headers.cookie,
			url: req.url,
		});
		res.writeHead(
			req.headers.authorization || req.headers.cookie ? 400 : objectStatus,
		);
		const objectKey = new URL(req.url, "http://object.test").pathname.slice(
			"/flywheel-payloads/".length,
		);
		res.end(bucket.rawBytes(objectKey));
	});
	const sign = createSignGet({
		FW_R2_ACCOUNT_ID: "a".repeat(32),
		FW_R2_BUCKET: "flywheel-payloads",
		FW_R2_ACCESS_KEY_ID: "test-access",
		FW_R2_SECRET_ACCESS_KEY: "test-secret",
	});
	deps.delivery = {
		mode: "presigned",
		signGet: async (input) => {
			const url = new URL(await sign(input));
			// Replace only the transport origin. This fixture proves Fetch behavior,
			// not R2 signature enforcement (the production host remains signed).
			return `${objectOrigin}${url.pathname}${url.search}`;
		},
	};
	const endpoint = await listen(t, async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		const result = await handleRequest(
			new Request(`http://endpoint.test${req.url}`, {
				headers: req.headers,
				method: req.method,
				...(body.length ? { body, duplex: "half" } : {}),
			}),
			deps,
		);
		res.writeHead(result.status, Object.fromEntries(result.headers));
		res.end(Buffer.from(await result.arrayBuffer()));
	});
	const beta = makeClient({ endpoint, token: TOKENS.beta });
	const release = makeClient({ endpoint, token: TOKENS.release });
	await beta.casUpdate((m) => {
		m.releaseOps[entry.releaseId] = {
			kind: "release",
			state: "reserved",
			ver: "1.55.0",
			betaVersion: "1.55.0-beta.1",
			sourceCommit: entry.sourceCommit,
			sha256: sha,
			objectKey: entry.key,
			createdAt: "2000-01-01T00:00:00.000Z",
		};
		return true;
	}, "reserve test release");
	const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2389-upload-"));
	try {
		const upload = path.join(uploadDir, "payload.tgz");
		fs.writeFileSync(upload, payload);
		assert.equal(await beta.uploadPayload("1.55.0", sha, upload), 200);
		await beta.readbackVerify("1.55.0", sha);
	} finally {
		fs.rmSync(uploadDir, { recursive: true });
	}
	await beta.casUpdate((m) => {
		m.releaseOps[entry.releaseId].state = "prepared";
		return true;
	}, "prepare test release");
	assert.equal(
		(
			await fetch(`${endpoint}/payload/1.55.0`, {
				headers: { authorization: `Bearer ${key}` },
				redirect: "manual",
			})
		).status,
		404,
	);
	await release.casUpdate((m) => {
		m.versions["1.55.0"] = entry;
		m.channels["customer-release"].latest = "1.55.0";
		m.releaseOps[entry.releaseId].state = "committed";
		return true;
	}, "commit test release");
	const view = await fetchManifest(endpoint, key);
	assert.equal(view.latest, "1.55.0");
	assert.equal(view.versions[0].sha256, sha);
	const file = await downloadPayload(endpoint, key, view.latest, sha);
	try {
		assert.deepEqual(fs.readFileSync(file), payload);
	} finally {
		fs.rmSync(path.dirname(file), { recursive: true });
	}
	assert.equal(received.length, 1);
	assert.equal(received[0].authorization, undefined);
	assert.equal(received[0].cookie, undefined);
	assert.equal(
		new URL(received[0].url, objectOrigin).searchParams.get("X-Amz-Expires"),
		"60",
	);
	await assert.rejects(
		downloadPayload(endpoint, key, view.latest, "0".repeat(64)),
		(error) => error.kind === "checksum",
	);
	objectStatus = 403;
	await assert.rejects(
		downloadPayload(endpoint, key, view.latest, sha),
		(error) => error.kind === "network",
	);
	await assert.rejects(
		downloadPayload(endpoint, "wrong-key", view.latest, sha),
		(error) => error.kind === "unauthorized",
	);
	assert.equal(
		received.length,
		3,
		"rejected key must not reach the object origin",
	);
});

test("shell network exceptions do not expose signed URLs or response text", async () => {
	const marker = "PRIVATE_SIGNED_URL";
	const fetchImpl = async () => {
		throw new Error(marker);
	};
	for (const operation of [
		() => fetchManifest("https://endpoint.test", "key", { fetchImpl }),
		() =>
			downloadPayload(
				"https://endpoint.test",
				"key",
				"1.55.0",
				"a".repeat(64),
				{ fetchImpl },
			),
	]) {
		await assert.rejects(
			operation(),
			(error) => error.kind === "network" && !error.message.includes(marker),
		);
	}
	await assert.rejects(
		fetchManifest("https://endpoint.test", "key", {
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				json: async () => {
					throw new Error(marker);
				},
			}),
		}),
		(error) => error.kind === "protocol" && !error.message.includes(marker),
	);
	await assert.rejects(
		downloadPayload("https://endpoint.test", "key", "1.55.0", "a".repeat(64), {
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				arrayBuffer: async () => {
					throw new Error(marker);
				},
			}),
		}),
		(error) => error.kind === "network" && !error.message.includes(marker),
	);
});
