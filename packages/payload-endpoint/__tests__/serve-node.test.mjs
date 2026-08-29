// FLY-1062 broker PR · serve-node.mjs — the minimal REAL endpoint entry.
// Boots the production server (FsBucket + unchanged handler) on a seeded data
// dir and asserts the customer contract over real HTTP, that NO test routes
// exist, and that unconfigured capabilities fail closed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FsBucket } from "../src/fs-bucket.mjs";
import { payloadObjectKey } from "../src/manifest.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");

const CUSTOMER_KEY = `fwk_${"a".repeat(32)}`;
const OPS_TOKEN = "ops-secret-token";
const VER = "1.2.3";
const PAYLOAD = Buffer.from("real-endpoint-payload-bytes");

async function seed(dataDir) {
	const bucket = new FsBucket(dataDir);
	const sha = sha256Hex(PAYLOAD);
	const objectKey = payloadObjectKey(VER, sha);
	const t0 = new Date(0).toISOString();
	const releaseId = "seed-release-1";
	await bucket.put(
		"manifest.json",
		JSON.stringify({
			schemaVersion: 1,
			channels: {
				"internal-beta": { latest: null },
				"customer-release": { latest: VER },
			},
			versions: {
				[VER]: {
					sha256: sha,
					key: objectKey,
					size: PAYLOAD.length,
					publishedAt: t0,
					channel: "release",
					status: "active",
					sourceCommit: "0".repeat(40),
					releaseId,
					derivedFromBeta: `${VER}-beta.1`,
					retentionSince: null,
					quarantinedAt: null,
				},
			},
			releaseOps: {
				[releaseId]: {
					kind: "release",
					state: "committed",
					ver: VER,
					betaVersion: `${VER}-beta.1`,
					sourceCommit: "0".repeat(40),
					sha256: sha,
					objectKey,
					createdAt: t0,
				},
			},
			releaseLedger: {},
			tombstones: [],
		}),
	);
	await bucket.put(objectKey, PAYLOAD, {
		customMetadata: { sha256: sha, ver: VER },
	});
	await bucket.put(
		`keys/${sha256Hex(CUSTOMER_KEY)}.json`,
		JSON.stringify({
			customerId: "test",
			entitlement: "customer",
			revoked: false,
			createdAt: t0,
			note: "serve-node test",
		}),
	);
	return sha;
}

function startServer(dataDir, env = {}) {
	const child = spawn(
		process.execPath,
		[path.join(SELF_DIR, "..", "src", "serve-node.mjs")],
		{
			env: {
				...process.env,
				FW_SERVE_DATA_DIR: dataDir,
				FW_SERVE_PORT: "0",
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	return new Promise((resolve, reject) => {
		let out = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`serve-node did not start: ${out}`));
		}, 10_000);
		child.stdout.on("data", (c) => {
			out += String(c);
			const m = /LISTENING [^:]+:(\d+)/.exec(out);
			if (m) {
				clearTimeout(timer);
				resolve({ child, port: Number(m[1]) });
			}
		});
		child.stderr.on("data", (c) => {
			out += String(c);
		});
		child.on("exit", () => {
			clearTimeout(timer);
			reject(new Error(`serve-node exited early: ${out}`));
		});
	});
}

const children = [];
after(() => {
	for (const c of children) c.kill();
});

test("serve-node: real customer chain + no test routes + fail-closed admin", async () => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-serve-node-"));
	const sha = await seed(dataDir);
	// ops capability configured via its sha256 ONLY (never the token)
	const { child, port } = await startServer(dataDir, {
		FW_OPS_ADMIN_TOKEN_SHA256: sha256Hex(OPS_TOKEN),
	});
	children.push(child);
	const base = `http://127.0.0.1:${port}`;
	const auth = { authorization: `Bearer ${CUSTOMER_KEY}` };

	// customer manifest view
	const mres = await fetch(`${base}/manifest`, { headers: auth });
	assert.equal(mres.status, 200);
	const view = await mres.json();
	assert.equal(view.latest, VER);
	assert.deepEqual(view.versions, [{ ver: VER, sha256: sha }]);

	// payload bytes with sha integrity
	const pres = await fetch(`${base}/payload/${VER}`, { headers: auth });
	assert.equal(pres.status, 200);
	const bytes = Buffer.from(await pres.arrayBuffer());
	assert.equal(sha256Hex(bytes), sha);

	// no key → 401
	assert.equal((await fetch(`${base}/manifest`)).status, 401);

	// unknown route → uniform 404
	assert.equal(
		(await fetch(`${base}/whatever`, { headers: auth })).status,
		404,
	);

	// the harness-only introspection routes DO NOT exist on the real server
	assert.equal(
		(await fetch(`${base}/__test__/objects`, { headers: auth })).status,
		404,
	);

	// admin surface: configured ops capability works…
	const ares = await fetch(`${base}/admin/manifest`, {
		headers: { authorization: `Bearer ${OPS_TOKEN}` },
	});
	assert.equal(ares.status, 200);
	assert.ok((await ares.json()).versions[VER]);

	// …while UNCONFIGURED capabilities fail closed (beta token guess → 401)
	const bres = await fetch(`${base}/admin/manifest`, {
		headers: { authorization: "Bearer some-beta-guess" },
	});
	assert.equal(bres.status, 401);

	child.kill();
});

test("serve-node: refuses to boot without FW_SERVE_DATA_DIR", async () => {
	const child = spawn(
		process.execPath,
		[path.join(SELF_DIR, "..", "src", "serve-node.mjs")],
		{
			env: { ...process.env, FW_SERVE_DATA_DIR: "", FW_SERVE_PORT: "0" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 1);
});
