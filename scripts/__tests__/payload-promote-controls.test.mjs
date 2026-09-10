import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
	emptyManifest,
	fixtureManifest,
	payloadKeyOf,
} from "../../packages/payload-endpoint/__tests__/harness.mjs";
import { MemoryBucket } from "../../packages/payload-endpoint/__tests__/memory-bucket.mjs";
import { handleRequest } from "../../packages/payload-endpoint/src/handler.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const CLI = path.join(ROOT, "scripts/release/payload-promote.mjs");
const RELEASE_TOKEN = "customer-release-controls-token";
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

function addCommittedPair(manifest, base, char) {
	const beta = `${base}-beta.1`;
	const sourceCommit = char.repeat(40);
	const betaSha = char.repeat(64);
	const releaseChar =
		char === "f" ? "0" : String.fromCharCode(char.charCodeAt(0) + 1);
	const releaseSha = releaseChar.repeat(64);
	const createdAt = "2026-01-01T00:00:00.000Z";
	manifest.versions[beta] = {
		sha256: betaSha,
		key: payloadKeyOf(beta, betaSha),
		size: 5,
		publishedAt: createdAt,
		channel: "beta",
		status: "active",
		sourceCommit,
		releaseId: `beta-${base}`,
		derivedFromBeta: null,
		retentionSince: "2026-09-01T00:00:00.000Z",
		quarantinedAt: null,
	};
	manifest.releaseOps[`beta-${base}`] = {
		kind: "beta",
		state: "committed",
		ver: beta,
		betaVersion: null,
		sourceCommit,
		sha256: betaSha,
		objectKey: payloadKeyOf(beta, betaSha),
		createdAt,
	};
	manifest.versions[base] = {
		sha256: releaseSha,
		key: payloadKeyOf(base, releaseSha),
		size: 5,
		publishedAt: createdAt,
		channel: "release",
		status: "active",
		sourceCommit,
		releaseId: `rel-${base}`,
		derivedFromBeta: beta,
		retentionSince: "2026-09-01T00:00:00.000Z",
		quarantinedAt: null,
	};
	manifest.releaseOps[`rel-${base}`] = {
		kind: "release",
		state: "committed",
		ver: base,
		betaVersion: beta,
		sourceCommit,
		sha256: releaseSha,
		objectKey: payloadKeyOf(base, releaseSha),
		createdAt,
	};
	manifest.releaseLedger[base] = { nextBetaN: 2 };
}

function abandonManifest() {
	const manifest = fixtureManifest();
	const preparedSha = "d".repeat(64);
	manifest.releaseOps["rel-prepared"] = {
		kind: "release",
		state: "prepared",
		ver: "1.56.0",
		betaVersion: "1.56.0-beta.1",
		sourceCommit: "d".repeat(40),
		sha256: preparedSha,
		objectKey: payloadKeyOf("1.56.0", preparedSha),
		createdAt: "2026-09-08T00:00:00.000Z",
	};
	manifest.releaseOps["rel-stale"] = {
		kind: "release",
		state: "reserved",
		ver: "1.57.0",
		betaVersion: "1.57.0-beta.1",
		sourceCommit: null,
		sha256: null,
		objectKey: null,
		createdAt: "2020-01-01T00:00:00.000Z",
	};
	return manifest;
}

async function startEndpoint(manifest) {
	const bucket = new MemoryBucket();
	bucket.seed("manifest.json", JSON.stringify(manifest));
	const deps = {
		bucket,
		secrets: {
			customerReleaseTokenSha256: sha256Hex(RELEASE_TOKEN),
		},
		now: () => new Date("2026-09-08T12:00:00.000Z"),
		delivery: { mode: "stream" },
	};
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		const headers = new Headers();
		for (const [name, value] of Object.entries(request.headers)) {
			if (typeof value === "string") headers.set(name, value);
		}
		const result = await handleRequest(
			new Request(`http://127.0.0.1${request.url}`, {
				method: request.method,
				headers,
				...(body.length ? { body, duplex: "half" } : {}),
			}),
			deps,
		);
		const responseHeaders = {};
		result.headers.forEach((value, name) => {
			responseHeaders[name] = value;
		});
		response.writeHead(result.status, responseHeaders);
		response.end(Buffer.from(await result.arrayBuffer()));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const endpoint = `http://127.0.0.1:${server.address().port}`;
	return {
		bucket,
		endpoint,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function startWithdrawRaceProxy(target) {
	let raced = false;
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		if (
			!raced &&
			request.method === "POST" &&
			request.url === "/admin/manifest"
		) {
			raced = true;
			const current = await fetch(`${target}/admin/manifest`, {
				headers: { authorization: `Bearer ${RELEASE_TOKEN}` },
			});
			const baseEtag = current.headers.get("etag");
			const concurrent = await current.json();
			concurrent.channels["customer-release"].latest = "1.54.8";
			const advanced = await fetch(`${target}/admin/manifest`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${RELEASE_TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ baseEtag, manifest: concurrent }),
			});
			assert.equal(advanced.status, 200, await advanced.text());
		}
		const upstream = await fetch(`${target}${request.url}`, {
			method: request.method,
			headers: {
				authorization: request.headers.authorization,
				...(request.headers["content-type"]
					? { "content-type": request.headers["content-type"] }
					: {}),
			},
			...(body.length ? { body } : {}),
		});
		const headers = {};
		upstream.headers.forEach((value, name) => {
			headers[name] = value;
		});
		response.writeHead(upstream.status, headers);
		response.end(Buffer.from(await upstream.arrayBuffer()));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		endpoint: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function invoke(endpoint, args, { githubOutput } = {}) {
	try {
		const result = await execFileAsync(process.execPath, [CLI, ...args], {
			env: {
				...process.env,
				FW_ENDPOINT: endpoint,
				FW_CUSTOMER_RELEASE_TOKEN: RELEASE_TOKEN,
				...(githubOutput ? { GITHUB_OUTPUT: githubOutput } : {}),
			},
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		return {
			code: error.code,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
		};
	}
}

function rawManifest(bucket) {
	return bucket.rawBytes("manifest.json").toString("utf8");
}

function manifest(bucket) {
	return JSON.parse(rawManifest(bucket));
}

function resultFrom(output) {
	const line = output
		.split("\n")
		.find((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
	assert.ok(line, `missing result JSON in: ${output}`);
	return JSON.parse(line);
}

test("P9 abandon supports exact-id, idempotent replay, stale dry-run/apply, and committed refusal", async () => {
	const endpoint = await startEndpoint(abandonManifest());
	const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2388-result-"));
	const outputFile = path.join(outputDir, "out");
	try {
		const exact = await invoke(
			endpoint.endpoint,
			["abandon", "--release-id", "rel-prepared"],
			{ githubOutput: outputFile },
		);
		assert.equal(exact.code, 0, exact.stderr);
		assert.deepEqual(resultFrom(exact.stdout), {
			action: "abandon",
			releaseIds: ["rel-prepared"],
			outcome: "abandoned",
		});
		assert.equal(
			manifest(endpoint.bucket).releaseOps["rel-prepared"].state,
			"abandoned",
		);

		const beforeReplay = rawManifest(endpoint.bucket);
		const replay = await invoke(endpoint.endpoint, [
			"abandon",
			"--release-id",
			"rel-prepared",
		]);
		assert.equal(replay.code, 0, replay.stderr);
		assert.equal(resultFrom(replay.stdout).outcome, "idempotent");
		assert.equal(rawManifest(endpoint.bucket), beforeReplay);

		const committedBefore = rawManifest(endpoint.bucket);
		const committed = await invoke(endpoint.endpoint, [
			"abandon",
			"--release-id",
			"op-rel-1",
		]);
		assert.notEqual(committed.code, 0);
		assert.match(committed.stderr, /committed|published/i);
		assert.equal(rawManifest(endpoint.bucket), committedBefore);

		const dryBefore = rawManifest(endpoint.bucket);
		const dry = await invoke(endpoint.endpoint, [
			"abandon",
			"--stale-days",
			"14",
		]);
		assert.equal(dry.code, 0, dry.stderr);
		assert.deepEqual(resultFrom(dry.stdout), {
			action: "abandon",
			releaseIds: ["rel-stale"],
			outcome: "dry-run",
		});
		assert.equal(rawManifest(endpoint.bucket), dryBefore);

		const apply = await invoke(endpoint.endpoint, [
			"abandon",
			"--stale-days",
			"14",
			"--apply",
		]);
		assert.equal(apply.code, 0, apply.stderr);
		assert.equal(resultFrom(apply.stdout).outcome, "abandoned");
		assert.equal(
			manifest(endpoint.bucket).releaseOps["rel-stale"].state,
			"abandoned",
		);
		assert.match(fs.readFileSync(outputFile, "utf8"), /^result=\{/m);
	} finally {
		await endpoint.close();
		fs.rmSync(outputDir, { recursive: true, force: true });
	}
});

test("P9e validate-snapshot accepts a valid manifest and rejects an invalid one without writing", async () => {
	const valid = await startEndpoint(fixtureManifest());
	try {
		const before = rawManifest(valid.bucket);
		const result = await invoke(valid.endpoint, ["validate-snapshot"]);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /snapshot valid/);
		assert.equal(rawManifest(valid.bucket), before);
	} finally {
		await valid.close();
	}

	const invalidManifest = emptyManifest();
	invalidManifest.channels["customer-release"].latest = "9.9.9";
	const invalid = await startEndpoint(invalidManifest);
	try {
		const before = rawManifest(invalid.bucket);
		const result = await invoke(invalid.endpoint, ["validate-snapshot"]);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /C-1/);
		assert.equal(rawManifest(invalid.bucket), before);
	} finally {
		await invalid.close();
	}
});

test("W2 withdraw binds the current release pointer and has one exact idempotent state", async () => {
	const seed = fixtureManifest();
	addCommittedPair(seed, "1.54.9", "d");
	addCommittedPair(seed, "1.54.8", "f");
	const endpoint = await startEndpoint(seed);
	try {
		for (const args of [
			["withdraw", "--withdraw", "1.54.9", "--fallback", "1.54.8"],
			["withdraw", "--withdraw", "1.55.0-beta.1", "--fallback", "1.54.8"],
			["withdraw", "--withdraw", "1.55.0", "--fallback", "1.55.0"],
		]) {
			const before = rawManifest(endpoint.bucket);
			const result = await invoke(endpoint.endpoint, args);
			assert.notEqual(result.code, 0, args.join(" "));
			assert.equal(rawManifest(endpoint.bucket), before, args.join(" "));
		}

		const withdrawn = await invoke(endpoint.endpoint, [
			"withdraw",
			"--withdraw",
			"1.55.0",
			"--fallback",
			"1.54.9",
		]);
		assert.equal(withdrawn.code, 0, withdrawn.stderr);
		assert.deepEqual(resultFrom(withdrawn.stdout), {
			action: "withdraw",
			withdrawn: "1.55.0",
			fallback: "1.54.9",
			outcome: "withdrawn",
		});

		const beforeReplay = rawManifest(endpoint.bucket);
		const replay = await invoke(endpoint.endpoint, [
			"withdraw",
			"--withdraw",
			"1.55.0",
			"--fallback",
			"1.54.9",
		]);
		assert.equal(replay.code, 0, replay.stderr);
		assert.equal(resultFrom(replay.stdout).outcome, "idempotent");
		assert.equal(rawManifest(endpoint.bucket), beforeReplay);

		const differentBefore = rawManifest(endpoint.bucket);
		const differentFallback = await invoke(endpoint.endpoint, [
			"withdraw",
			"--withdraw",
			"1.55.0",
			"--fallback",
			"1.54.8",
		]);
		assert.notEqual(differentFallback.code, 0);
		assert.equal(rawManifest(endpoint.bucket), differentBefore);
	} finally {
		await endpoint.close();
	}
});

test("W2d a CAS retry re-judges a concurrently advanced customer pointer", async () => {
	const seed = fixtureManifest();
	addCommittedPair(seed, "1.54.9", "d");
	addCommittedPair(seed, "1.54.8", "f");
	const endpoint = await startEndpoint(seed);
	const proxy = await startWithdrawRaceProxy(endpoint.endpoint);
	try {
		const result = await invoke(proxy.endpoint, [
			"withdraw",
			"--withdraw",
			"1.55.0",
			"--fallback",
			"1.54.9",
		]);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /not the current customer-release pointer/);
		const after = manifest(endpoint.bucket);
		assert.equal(after.channels["customer-release"].latest, "1.54.8");
		assert.equal(after.versions["1.55.0"].status, "active");
	} finally {
		await proxy.close();
		await endpoint.close();
	}
});
