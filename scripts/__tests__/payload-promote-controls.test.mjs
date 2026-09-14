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

async function startEndpoint(
	manifest,
	{ now = () => new Date("2026-09-08T12:00:00.000Z"), beforeRequest } = {},
) {
	const bucket = new MemoryBucket();
	bucket.seed("manifest.json", JSON.stringify(manifest));
	const deps = {
		bucket,
		secrets: {
			customerReleaseTokenSha256: sha256Hex(RELEASE_TOKEN),
		},
		now,
		delivery: { mode: "stream" },
	};
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		await beforeRequest?.(request, bucket);
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

async function invoke(endpoint, args, { githubOutput, nodeArgs = [] } = {}) {
	try {
		const result = await execFileAsync(
			process.execPath,
			[...nodeArgs, CLI, ...args],
			{
				env: {
					...process.env,
					FW_ENDPOINT: endpoint,
					FW_CUSTOMER_RELEASE_TOKEN: RELEASE_TOKEN,
					...(githubOutput ? { GITHUB_OUTPUT: githubOutput } : {}),
				},
			},
		);
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
			latest: "1.54.9",
			expired: [],
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

test("W3a auto withdraw selects the most recently unpinned release and replays without writes", async () => {
	const seed = fixtureManifest();
	addCommittedPair(seed, "1.54.9", "d");
	addCommittedPair(seed, "1.54.8", "f");
	seed.versions["1.54.8"].retentionSince = "2026-09-02T00:00:00.000Z";
	const endpoint = await startEndpoint(seed);
	try {
		const args = ["withdraw", "--withdraw", "1.55.0"];
		const result = await invoke(endpoint.endpoint, args);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(resultFrom(result.stdout), {
			action: "withdraw",
			withdrawn: "1.55.0",
			fallback: "1.54.8",
			latest: "1.54.8",
			expired: [],
			outcome: "withdrawn",
		});
		const after = manifest(endpoint.bucket);
		assert.equal(after.versions["1.54.8"].retentionSince, null);
		assert.equal(after.versions["1.55.0"].status, "quarantined");
		const before = rawManifest(endpoint.bucket);
		const replay = await invoke(endpoint.endpoint, args);
		assert.equal(replay.code, 0, replay.stderr);
		assert.equal(resultFrom(replay.stdout).outcome, "idempotent");
		assert.equal(rawManifest(endpoint.bucket), before);
	} finally {
		await endpoint.close();
	}
});

for (const oldVersion of [true, false]) {
	test(`W3b/c/d/g no usable previous-good (${oldVersion ? "expired" : "first release"}) requires explicit pause and replays`, async () => {
		const seed = fixtureManifest();
		if (oldVersion) {
			addCommittedPair(seed, "1.54.9", "d");
			seed.versions["1.54.9"].retentionSince = "2026-07-01T00:00:00.000Z";
		}
		const endpoint = await startEndpoint(seed);
		try {
			const before = rawManifest(endpoint.bucket);
			const args = ["withdraw", "--withdraw", "1.55.0"];
			const refused = await invoke(endpoint.endpoint, args);
			assert.notEqual(refused.code, 0);
			assert.match(refused.stderr, /no re-pinnable previous-good/);
			assert.equal(rawManifest(endpoint.bucket), before);
			const result = await invoke(endpoint.endpoint, [
				...args,
				"--allow-pause",
			]);
			assert.equal(result.code, 0, result.stderr);
			assert.deepEqual(resultFrom(result.stdout), {
				action: "withdraw",
				withdrawn: "1.55.0",
				fallback: null,
				latest: null,
				expired: oldVersion ? ["1.54.9"] : [],
				outcome: "paused",
			});
			const after = manifest(endpoint.bucket);
			assert.equal(after.channels["customer-release"].latest, null);
			assert.equal(after.versions["1.55.0"].status, "quarantined");
			if (oldVersion) assert.equal(after.versions["1.54.9"].status, "expired");
			const replayBefore = rawManifest(endpoint.bucket);
			const replay = await invoke(endpoint.endpoint, args);
			assert.equal(replay.code, 0, replay.stderr);
			assert.equal(resultFrom(replay.stdout).outcome, "idempotent");
			assert.equal(rawManifest(endpoint.bucket), replayBefore);
		} finally {
			await endpoint.close();
		}
	});
}

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

for (const conflict of [false, true]) {
	test(`W3i/j server deadline crosses before POST (CAS conflict=${conflict}), re-derives paused`, async () => {
		const seed = fixtureManifest();
		addCommittedPair(seed, "1.54.9", "d");
		let nowMs = Date.parse("2026-09-28T23:59:59.999Z");
		let posts = 0;
		const endpoint = await startEndpoint(seed, {
			now: () => new Date(nowMs),
			beforeRequest: (request, bucket) => {
				if (request.method !== "POST") return;
				if (++posts !== 1) return;
				nowMs++;
				if (conflict) {
					// Same valid manifest, different ETag: concurrent storage write.
					bucket.seed("manifest.json", `${JSON.stringify(seed)}\n`);
				}
			},
		});
		try {
			const result = await invoke(endpoint.endpoint, [
				"withdraw",
				"--withdraw",
				"1.55.0",
				"--allow-pause",
			]);
			assert.equal(result.code, 0, result.stderr);
			assert.equal(posts, 2);
			assert.equal(resultFrom(result.stdout).outcome, "paused");
			assert.deepEqual(resultFrom(result.stdout).expired, ["1.54.9"]);
			assert.equal(
				manifest(endpoint.bucket).versions["1.54.9"].status,
				"expired",
			);
			assert.equal(
				manifest(endpoint.bucket).channels["customer-release"].latest,
				null,
			);
		} finally {
			await endpoint.close();
		}
	});
}

test("W3 explicit expired fallback and conflicting options are zero-write refusals; allow-pause still prefers a candidate", async () => {
	const seed = fixtureManifest();
	addCommittedPair(seed, "1.54.9", "d");
	addCommittedPair(seed, "1.54.8", "f");
	seed.versions["1.54.8"].retentionSince = "2026-07-01T00:00:00.000Z";
	const endpoint = await startEndpoint(seed);
	try {
		for (const extra of [
			["--fallback", "1.54.8"],
			["--fallback", "1.54.9", "--allow-pause"],
		]) {
			const before = rawManifest(endpoint.bucket);
			const result = await invoke(endpoint.endpoint, [
				"withdraw",
				"--withdraw",
				"1.55.0",
				...extra,
			]);
			assert.notEqual(result.code, 0);
			assert.equal(rawManifest(endpoint.bucket), before);
		}
		const result = await invoke(endpoint.endpoint, [
			"withdraw",
			"--withdraw",
			"1.55.0",
			"--allow-pause",
		]);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(resultFrom(result.stdout).fallback, "1.54.9");
		assert.equal(resultFrom(result.stdout).outcome, "withdrawn");
		assert.equal(manifest(endpoint.bucket).versions["1.54.8"].status, "active");
	} finally {
		await endpoint.close();
	}
});

test("W3h runner clock skew of either sign does not change fallback selection", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-clock-"));
	try {
		for (const days of [-30, 30]) {
			const preload = path.join(dir, `clock-${days}.mjs`);
			fs.writeFileSync(
				preload,
				`const Original = Date; const fixed = ${Date.parse("2026-09-08T12:00:00.000Z")} + ${days} * 86400000; globalThis.Date = class extends Original { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };`,
			);
			const seed = fixtureManifest();
			addCommittedPair(seed, "1.54.9", "d");
			const endpoint = await startEndpoint(seed);
			try {
				const result = await invoke(
					endpoint.endpoint,
					["withdraw", "--withdraw", "1.55.0", "--allow-pause"],
					{ nodeArgs: ["--import", preload] },
				);
				assert.equal(result.code, 0, result.stderr);
				assert.equal(resultFrom(result.stdout).fallback, "1.54.9");
			} finally {
				await endpoint.close();
			}
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("W3e auto withdraw refuses a concurrently advanced pointer", async () => {
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
		]);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /not the current customer-release pointer/);
		assert.equal(manifest(endpoint.bucket).versions["1.55.0"].status, "active");
		assert.equal(
			manifest(endpoint.bucket).channels["customer-release"].latest,
			"1.54.8",
		);
	} finally {
		await proxy.close();
		await endpoint.close();
	}
});

test("W3f auto replay reports the current latest after a later withdrawal", async () => {
	const seed = fixtureManifest();
	addCommittedPair(seed, "1.54.9", "d");
	addCommittedPair(seed, "1.54.8", "f");
	const endpoint = await startEndpoint(seed);
	try {
		for (const [withdraw, fallback] of [
			["1.55.0", "1.54.9"],
			["1.54.9", "1.54.8"],
		]) {
			const result = await invoke(endpoint.endpoint, [
				"withdraw",
				"--withdraw",
				withdraw,
				"--fallback",
				fallback,
			]);
			assert.equal(result.code, 0, result.stderr);
		}
		const before = rawManifest(endpoint.bucket);
		const replay = await invoke(endpoint.endpoint, [
			"withdraw",
			"--withdraw",
			"1.55.0",
		]);
		assert.equal(replay.code, 0, replay.stderr);
		assert.equal(resultFrom(replay.stdout).latest, "1.54.8");
		assert.equal(resultFrom(replay.stdout).outcome, "idempotent");
		assert.equal(rawManifest(endpoint.bucket), before);
	} finally {
		await endpoint.close();
	}
});
