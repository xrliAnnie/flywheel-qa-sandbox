#!/usr/bin/env node
/**
 * FLY-1185 — lifecycle cleanup sweep CLI (deliverable 18).
 *
 * The CLI is a SUBMITTER only (plan R10#3): both passes execute inside the
 * Bridge process (shared issue mutex / repo lock / CAS drift rejection).
 *
 *   --dry-run --project <name> [--out <file>]
 *       Read-only manifest pass via POST /api/lifecycle/dry-run. Prints the
 *       canonical manifest (writes it to --out when given) + its sha256.
 *       Approval binds those EXACT bytes.
 *
 *   --apply --manifest <file> --approved-hash <sha256> [--include-unowned]
 *       Submits {manifestJson, approvedHash} to POST /api/lifecycle-apply.
 *       The local file is re-hashed first — any post-approval edit refuses
 *       before the network. Bridge unavailable → fail-closed (non-zero exit,
 *       nothing deleted).
 *
 * Env: FLYWHEEL_BRIDGE_URL (default http://localhost:9876) + FLYWHEEL_API_TOKEN.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function fail(msg) {
	console.error(`[cleanup-sweep-cli] ${msg}`);
	process.exit(1);
}

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => {
	const i = args.indexOf(f);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const bridgeUrl = (
	process.env.FLYWHEEL_BRIDGE_URL ?? "http://localhost:9876"
).replace(/\/$/, "");
const apiToken = process.env.FLYWHEEL_API_TOKEN ?? "";

function canonicalHash(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

async function post(path, body) {
	if (!apiToken) {
		fail(
			"FLYWHEEL_API_TOKEN not set (fail-closed — the Bridge api requires it)",
		);
	}
	let res;
	try {
		res = await fetch(`${bridgeUrl}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiToken}`,
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		fail(
			`Bridge unavailable (${err.message}) — fail-closed, nothing was deleted`,
		);
	}
	const text = await res.text();
	if (!res.ok) {
		fail(`Bridge rejected ${path} (${res.status}): ${text}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		fail(`Bridge returned non-JSON from ${path}: ${text.slice(0, 200)}`);
	}
}

if (has("--dry-run")) {
	const projectName = val("--project");
	if (!projectName) fail("--dry-run requires --project <name>");
	const out = val("--out");
	// --include-unowned is bound INSIDE the hashed manifest (Codex R1#6): the
	// approver sees exactly what scope they authorize.
	const resp = await post("/api/lifecycle/dry-run", {
		project: projectName,
		includeUnowned: has("--include-unowned"),
	});
	const { manifestJson, sha256 } = resp;
	if (typeof manifestJson !== "string" || typeof sha256 !== "string") {
		fail("unexpected dry-run response shape");
	}
	const localHash = canonicalHash(manifestJson);
	if (localHash !== sha256) {
		fail(`hash disagreement: bridge=${sha256} local=${localHash}`);
	}
	if (out) {
		writeFileSync(out, manifestJson, "utf8");
		console.log(`manifest written: ${out}`);
	} else {
		console.log(manifestJson);
	}
	console.log(`\ncanonical sha256: ${sha256}`);
	console.log(
		"approve this hash, then: --apply --manifest <file> --approved-hash <sha256>",
	);
	process.exit(0);
}

if (has("--apply")) {
	const manifestPath = val("--manifest");
	const approvedHash = val("--approved-hash");
	if (!manifestPath || !approvedHash) {
		fail("--apply requires --manifest <file> --approved-hash <sha256>");
	}
	let manifestJson;
	try {
		manifestJson = readFileSync(manifestPath, "utf8");
	} catch (err) {
		fail(`cannot read manifest: ${err.message}`);
	}
	const localHash = canonicalHash(manifestJson);
	if (localHash !== approvedHash) {
		fail(
			`local manifest hash ${localHash} != approved ${approvedHash} — file changed since approval; re-run --dry-run`,
		);
	}
	// Consistency assertion only — the AUTHORITATIVE includeUnowned lives
	// inside the hashed manifest (set at dry-run time, seen by the approver).
	try {
		const parsed = JSON.parse(manifestJson);
		if (has("--include-unowned") && parsed.includeUnowned !== true) {
			fail(
				"--include-unowned passed but the approved manifest has includeUnowned=false — re-run --dry-run --include-unowned and re-approve",
			);
		}
	} catch (err) {
		if (err?.code) throw err;
		fail("manifest is not valid JSON");
	}
	const resp = await post("/api/lifecycle-apply", {
		manifestJson,
		approvedHash,
	});
	console.log(JSON.stringify(resp, null, 2));
	process.exit(0);
}

console.error(
	"usage: cleanup-sweep-cli.mjs --dry-run --project <name> [--include-unowned] [--out <file>]\n" +
		"       cleanup-sweep-cli.mjs --apply --manifest <file> --approved-hash <sha256> [--include-unowned]",
);
process.exit(1);
