#!/usr/bin/env node
// FLY-1062 broker PR · minimal REAL endpoint — a production-usable node server
// around the UNCHANGED pure handler, backed by the durable FsBucket.
//
// This is the smallest thing a customer install can actually be served from:
// the same handler the Cloudflare Worker binds (worker.mjs), same capability
// model (secrets are sha256 hashes of the tokens — the tokens themselves are
// never configured here), a real data directory. The Cloudflare/R2 deployment
// and its automation remain the target form (P5 / FLY-1143); this entry exists
// so the full customer chain is REAL end to end before that lands.
//
//   FW_SERVE_DATA_DIR                     — required, the bucket directory
//   FW_SERVE_PORT / FW_SERVE_HOST         — default 8787 / 127.0.0.1
//   FW_BETA_PUBLISH_TOKEN_SHA256          — optional; a capability whose hash
//   FW_CUSTOMER_RELEASE_TOKEN_SHA256        is unset is simply DISABLED
//   FW_OPS_ADMIN_TOKEN_SHA256               (fail-closed in the handler)
//
// Deliberately NO test/introspection routes (the __tests__/serve.mjs harness
// carries those) and ZERO per-request logging — a key or token can never leak
// through observability plumbing (same stance as worker.mjs).
import http from "node:http";
import process from "node:process";
import { Readable } from "node:stream";
import { FsBucket } from "./fs-bucket.mjs";
import { handleRequest } from "./handler.mjs";

const dataDir = process.env.FW_SERVE_DATA_DIR;
if (!dataDir) {
	console.error("[serve-node] FW_SERVE_DATA_DIR is required");
	process.exit(1);
}
const port = Number.parseInt(process.env.FW_SERVE_PORT ?? "8787", 10);
const host = process.env.FW_SERVE_HOST ?? "127.0.0.1";

const bucket = new FsBucket(dataDir);
const secrets = {
	betaPublishTokenSha256: process.env.FW_BETA_PUBLISH_TOKEN_SHA256,
	customerReleaseTokenSha256: process.env.FW_CUSTOMER_RELEASE_TOKEN_SHA256,
	opsAdminTokenSha256: process.env.FW_OPS_ADMIN_TOKEN_SHA256,
};

const server = http.createServer(async (req, res) => {
	try {
		const headers = new Headers();
		for (const [k, v] of Object.entries(req.headers)) {
			if (typeof v === "string") headers.set(k, v);
		}
		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		const request = new Request(`http://${host}${req.url}`, {
			method: req.method,
			headers,
			...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
		});
		const response = await handleRequest(request, {
			bucket,
			secrets,
			now: () => new Date(),
		});
		const resHeaders = {};
		for (const [k, v] of response.headers.entries()) resHeaders[k] = v;
		res.writeHead(response.status, resHeaders);
		if (response.body) {
			Readable.fromWeb(response.body).pipe(res);
		} else {
			res.end();
		}
	} catch {
		// terse + honest; never echoes the request, a key, or an internal path
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "internal error" }));
	}
});

server.listen(port, host, () => {
	const addr = server.address();
	console.log(`LISTENING ${addr.address}:${addr.port}`);
});
