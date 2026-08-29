// FLY-1062 PR3 · loopback HTTP shell around the REAL handler (test-only).
//
// Two jobs:
//   1. CONTRACT MODE — speaks the exact env protocol of the PR2 stub
//      (packages/onboard-shell/__tests__/stub-endpoint.mjs): STUB_PAYLOAD_FILE
//      / STUB_VER / STUB_SHA / STUB_MODE / STUB_EXPECT_KEY / STUB_KEYLOG, and
//      prints "PORT <n>" first. The PR2 six suites re-run against the real
//      handler by pointing ONBOARD_ENDPOINT_IMPL at this file — same
//      fixtures, same assertion set (plan PR3-4 contract-consistency lock).
//   2. ADMIN MODE — the release/ops scripts' hermetic test server: capability
//      tokens via FW_TEST_*_TOKEN, an optional seed manifest, a settable fake
//      clock, and /__test__/* introspection routes (harness layer only — the
//      handler itself never sees them).
//
// State lives in ONE in-memory bucket for the life of the process, so a bash
// test can run several script invocations against a consistent world.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { handleRequest } from "../src/handler.mjs";
import { payloadObjectKey } from "../src/manifest.mjs";
import { MemoryBucket } from "./memory-bucket.mjs";

const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

const bucket = new MemoryBucket();

// ── clock: real by default, settable via /__test__/clock ─────────────────────
let fakeNowMs = null;
const now = () => (fakeNowMs === null ? new Date() : new Date(fakeNowMs));

// ── capability secrets (admin mode) ──────────────────────────────────────────
const secrets = {};
if (process.env.FW_TEST_BETA_TOKEN) {
	secrets.betaPublishTokenSha256 = sha256Hex(process.env.FW_TEST_BETA_TOKEN);
}
if (process.env.FW_TEST_RELEASE_TOKEN) {
	secrets.customerReleaseTokenSha256 = sha256Hex(
		process.env.FW_TEST_RELEASE_TOKEN,
	);
}
if (process.env.FW_TEST_OPS_TOKEN) {
	secrets.opsAdminTokenSha256 = sha256Hex(process.env.FW_TEST_OPS_TOKEN);
}

// ── contract-mode seeding (PR2 stub env protocol) ────────────────────────────
const STUB_MODE = process.env.STUB_MODE || "normal";
const EXPECT_KEY = process.env.STUB_EXPECT_KEY || "";
const KEYLOG = process.env.STUB_KEYLOG || "";

function seedKeyRecord(plaintext, entitlement = "customer") {
	bucket.seed(`keys/${sha256Hex(plaintext)}.json`, {
		customerId: "contract-fixture",
		entitlement,
		revoked: false,
		createdAt: new Date(0).toISOString(),
		note: "serve.mjs contract fixture",
	});
}

if (process.env.STUB_PAYLOAD_FILE) {
	const ver = process.env.STUB_VER || "1.0.0";
	const advertisedSha = process.env.STUB_SHA || "";
	let bytes = fs.readFileSync(process.env.STUB_PAYLOAD_FILE);
	if (STUB_MODE === "corrupt") {
		bytes = Buffer.from(bytes);
		bytes[0] = bytes[0] ^ 0xff; // stored bytes no longer match the manifest sha
	}
	const objectKey = payloadObjectKey(ver, advertisedSha);
	const sourceCommit = "0".repeat(40);
	const releaseId = `contract-${randomUUID().slice(0, 8)}`;
	const t0 = new Date(0).toISOString();
	bucket.seed("manifest.json", {
		schemaVersion: 1,
		channels: {
			"internal-beta": { latest: null },
			"customer-release": { latest: ver },
		},
		versions: {
			[ver]: {
				sha256: advertisedSha,
				key: objectKey,
				size: bytes.length,
				publishedAt: t0,
				channel: "release",
				status: "active",
				sourceCommit,
				releaseId,
				derivedFromBeta: `${ver}-beta.1`,
				retentionSince: null,
				quarantinedAt: null,
			},
		},
		releaseOps: {
			[releaseId]: {
				kind: "release",
				state: "committed",
				ver,
				betaVersion: `${ver}-beta.1`,
				sourceCommit,
				sha256: advertisedSha,
				objectKey,
				createdAt: t0,
			},
		},
		releaseLedger: {},
		tombstones: [],
	});
	bucket.seed(objectKey, bytes, { sha256: advertisedSha, ver });
	if (STUB_MODE !== "unauthorized" && EXPECT_KEY) seedKeyRecord(EXPECT_KEY);
} else if (process.env.SERVE_SEED_MANIFEST) {
	const seedJson = fs.readFileSync(process.env.SERVE_SEED_MANIFEST, "utf8");
	bucket.seed("manifest.json", seedJson);
	// seed a placeholder object per version entry so DELETE effects are
	// observable (bytes are fixtures; identity metadata matches the entry).
	const seed = JSON.parse(seedJson);
	for (const [ver, e] of Object.entries(seed.versions ?? {})) {
		bucket.seed(e.key, Buffer.from(`seed-payload-${ver}`), {
			sha256: e.sha256,
			ver,
		});
	}
	if (process.env.SERVE_SEED_KEY) {
		// SERVE_SEED_KEY=<plaintext>:<entitlement> — a pre-issued license key
		const [plaintext, entitlement] = process.env.SERVE_SEED_KEY.split(":");
		seedKeyRecord(plaintext, entitlement || "customer");
	}
}

// ── HTTP shell ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
	try {
		if (KEYLOG) {
			try {
				fs.appendFileSync(
					KEYLOG,
					`${req.url}\tauth=${req.headers.authorization || ""}\n`,
				);
			} catch {}
		}
		// PR2-stub compatibility: with no EXPECT_KEY configured the stub accepts
		// ANY bearer key — emulate by lazily registering the first key seen.
		if (
			process.env.STUB_PAYLOAD_FILE &&
			STUB_MODE !== "unauthorized" &&
			!EXPECT_KEY &&
			req.headers.authorization
		) {
			const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization);
			if (m) seedKeyRecord(m[1]);
		}
		// harness-only introspection routes (NOT part of the handler surface)
		if (req.url === "/__test__/objects") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ keys: [...bucket.objects.keys()].sort() }));
			return;
		}
		if (req.url === "/__test__/corrupt" && req.method === "POST") {
			// flip the first byte of a stored object — simulates a swapped/damaged
			// artifact so the commit path's readback re-verification can be tested
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const { key } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const rec = bucket.objects.get(key);
			if (rec) rec.bytes[0] = rec.bytes[0] ^ 0xff;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: Boolean(rec) }));
			return;
		}
		if (req.url === "/__test__/clock" && req.method === "POST") {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			fakeNowMs = body.iso ? Date.parse(body.iso) : null;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, now: now().toISOString() }));
			return;
		}

		// bridge node's IncomingMessage → fetch Request → real handler
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (typeof v === "string") headers.set(k, v);
		}
		const request = new Request(`http://127.0.0.1${req.url}`, {
			method: req.method,
			headers,
			...(body.length && req.method !== "GET" && req.method !== "HEAD"
				? { body }
				: {}),
		});
		const response = await handleRequest(request, { bucket, secrets, now });
		const resHeaders = {};
		for (const [k, v] of response.headers.entries()) resHeaders[k] = v;
		res.writeHead(response.status, resHeaders);
		const buf = Buffer.from(await response.arrayBuffer());
		res.end(buf);
	} catch (e) {
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "serve shell error" }));
		console.error(`[serve] ${e?.message}`);
	}
});

server.listen(0, "127.0.0.1", () => {
	const { port } = server.address();
	process.stdout.write(`PORT ${port}\n`);
});
