#!/usr/bin/env node
// FLY-1062 PR3 · license key lifecycle (issue / revoke / rotate) — all writes
// go through the endpoint's ops-admin routes (the single trusted write choke
// point; never a direct bucket write).
//
// Usage (token via env, NEVER argv):
//   FW_ENDPOINT=https://… FW_OPS_ADMIN_TOKEN=… node scripts/release/license-key.mjs \
//     issue  --customer <id> --entitlement customer|internal [--note "…"]
//     revoke --key-id <sha256-hex>            # non-secret key id
//     revoke --stdin                          # plaintext key on stdin (hashed locally)
//     rotate --key-id <sha256-hex> --customer <id> --entitlement … [--note "…"]
//
// Security posture (plan §B0-5):
//   • the plaintext key exists ONLY in the issuance moment: printed once to
//     stdout, never written to disk, never sent anywhere except sha256'd;
//   • storage holds sha256(key) as the object name — revocation uses the
//     NON-SECRET key id (also printed at issuance for the ops ledger);
//   • the ops-admin token rides env → Authorization header only.
import { createHash, randomBytes } from "node:crypto";
import process from "node:process";

const ENDPOINT = (process.env.FW_ENDPOINT || "").replace(/\/+$/, "");
const TOKEN = process.env.FW_OPS_ADMIN_TOKEN || "";

function die(msg) {
	console.error(`[license-key] ${msg}`);
	process.exit(1);
}

function sha256Hex(s) {
	return createHash("sha256").update(s).digest("hex");
}

function parseArgs(argv) {
	const [cmd, ...rest] = argv;
	const opts = { _: [] };
	for (let i = 0; i < rest.length; i++) {
		if (rest[i].startsWith("--")) {
			const name = rest[i].slice(2);
			if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
				opts[name] = rest[++i];
			} else {
				opts[name] = true;
			}
		} else {
			opts._.push(rest[i]);
		}
	}
	return { cmd, opts };
}

async function api(method, path, body) {
	const res = await fetch(`${ENDPOINT}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	let json = null;
	try {
		json = await res.json();
	} catch {}
	return { status: res.status, json };
}

async function readStdinLine() {
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return Buffer.concat(chunks).toString("utf8").trim();
}

async function preflightEntitlement(entitlement) {
	// pre-activation guard (plan §B0-4): never issue a key whose entitlement
	// has nothing published — the endpoint enforces it too; checking here
	// gives the operator a plain-words reason before anything is generated.
	const { status, json } = await api("GET", "/admin/manifest");
	if (status === 404)
		die("no manifest exists yet — publish a version first (pre-activation)");
	if (status !== 200) die(`cannot read manifest (HTTP ${status})`);
	const pointer =
		entitlement === "customer" ? "customer-release" : "internal-beta";
	if (!json?.channels?.[pointer] || json.channels[pointer].latest === null) {
		die(
			`entitlement '${entitlement}' has no published release yet (channel ${pointer} is empty) — publish first, then issue keys`,
		);
	}
}

async function issue(opts) {
	const customer = opts.customer;
	const entitlement = opts.entitlement;
	if (!customer || typeof customer !== "string")
		die("issue: --customer <id> required");
	if (entitlement !== "customer" && entitlement !== "internal") {
		die("issue: --entitlement customer|internal required");
	}
	await preflightEntitlement(entitlement);
	// fwk_ + 256-bit hex — matches the secret-scan pattern fwk_[0-9a-f]{32,}
	const plaintext = `fwk_${randomBytes(32).toString("hex")}`;
	const keyId = sha256Hex(plaintext);
	const { status, json } = await api("PUT", `/admin/key/${keyId}`, {
		customerId: customer,
		entitlement,
		revoked: false,
		note: typeof opts.note === "string" ? opts.note : "",
	});
	if (status !== 200)
		die(`issue failed (HTTP ${status}): ${json?.error ?? "unknown"}`);
	console.log(
		"license key issued — the PLAINTEXT below is shown ONCE and never stored:",
	);
	console.log("");
	console.log(`  key    : ${plaintext}`);
	console.log(`  key id : ${keyId}   (non-secret — keep for revocation)`);
	console.log("");
	console.log(
		"hand the key to the customer over a private channel; the system keeps only its hash.",
	);
	return keyId;
}

async function revoke(opts) {
	let keyId = opts["key-id"];
	if (opts.stdin) {
		const plaintext = await readStdinLine();
		if (!plaintext) die("revoke --stdin: no key on stdin");
		keyId = sha256Hex(plaintext);
	}
	if (!keyId || !/^[0-9a-f]{64}$/.test(keyId)) {
		die(
			"revoke: --key-id <64-hex sha256> required (or --stdin with the plaintext key)",
		);
	}
	const { status, json } = await api("POST", `/admin/key/${keyId}/revoke`, {});
	if (status === 404) die("revoke: no such key");
	if (status !== 200)
		die(`revoke failed (HTTP ${status}): ${json?.error ?? "unknown"}`);
	console.log(
		`revoked ${keyId} — takes effect on the customer's NEXT request (strong consistency).`,
	);
}

async function rotate(opts) {
	// rotation = issue the NEW key first, revoke the old only after (plan
	// §B0-7): the customer is never left without a working key.
	if (!opts["key-id"] || !/^[0-9a-f]{64}$/.test(opts["key-id"])) {
		die("rotate: --key-id <old key id> required");
	}
	await issue(opts);
	await revoke({ "key-id": opts["key-id"] });
	console.log("rotation complete: new key live, old key revoked.");
}

async function main() {
	if (!ENDPOINT) die("FW_ENDPOINT env required");
	if (!TOKEN)
		die("FW_OPS_ADMIN_TOKEN env required (never pass tokens as arguments)");
	const { cmd, opts } = parseArgs(process.argv.slice(2));
	if (cmd === "issue") return void (await issue(opts));
	if (cmd === "revoke") return void (await revoke(opts));
	if (cmd === "rotate") return void (await rotate(opts));
	die("usage: license-key.mjs issue|revoke|rotate (see file header)");
}

main().catch((e) => die(e.message));
