#!/usr/bin/env node
// FLY-1062 PR4 · promote a beta to customer-release — TWO-STAGE (plan PR4-3):
//
//   prepare  (no gate; FW_BETA_PUBLISH_TOKEN)
//     node payload-promote.mjs prepare --release-id <id> --beta <X.Y.Z-beta.N> [--repo-root <dir>]
//     • sourceCommit is DERIVED from the beta's manifest entry (an operator
//       cannot substitute it); the checkout must BE that commit (fail-closed);
//     • builds the clean version, proves BYTE EQUIVALENCE against the beta
//       payload (version stamps normalized; any other difference = fail-closed
//       back to design review — never a degraded pass);
//     • registers the durable candidate (reserved, full tuple, BEFORE upload),
//       uploads, readback-verifies → prepared.
//
//   commit   (FOUNDER GATE; FW_CUSTOMER_RELEASE_TOKEN — founder custody, §3)
//     node payload-promote.mjs commit --release-id <id>
//     • ZERO BUILD: re-verifies the already-prepared artifact's sha via
//       streamed readback, then ONE CAS: release entry (full lineage) +
//       customer-release pointer + op→committed. What the founder approved is
//       the candidate tuple's sha256 — nothing is rebuilt after the gate.
//
//   withdraw (FW_CUSTOMER_RELEASE_TOKEN)
//     node payload-promote.mjs withdraw --withdraw <ver> --fallback <ver>
//     • quarantine + pointer back to an explicit known-good, ONE CAS; the
//       fallback re-pin resets its retention clock (server-stamped).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	baseOf,
	makeClient,
	payloadKeyOf,
	sha256File,
	testAbortPoint,
	tupleMatches,
} from "./lib/endpoint-client.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function die(msg) {
	console.error(`[payload-promote] ${msg}`);
	process.exit(1);
}
const log = (m) => console.log(`[payload-promote] ${m}`);

function argValue(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function clientFor(envName) {
	const endpoint = process.env.FW_ENDPOINT || "";
	const token = process.env[envName] || "";
	if (!endpoint) die("FW_ENDPOINT env required");
	if (!token) die(`${envName} env required (never pass tokens as arguments)`);
	return makeClient({ endpoint, token, log });
}

// ── equivalence proof (plan PR4-3 prepare) ───────────────────────────────────
// Unpack both npm tarballs, normalize ONLY the version stamps (package.json
// .version + the .flywheel-prebuilt sentinel), then require every path and
// every byte to be identical. NOT equivalent = fail-closed, no downgrade path.
function untar(tarball, destDir) {
	fs.mkdirSync(destDir, { recursive: true });
	execFileSync("tar", ["-xzf", tarball, "-C", destDir], { stdio: "pipe" });
	return path.join(destDir, "package");
}

function normalizeVersionStamps(treeRoot) {
	const pj = path.join(treeRoot, "package.json");
	if (fs.existsSync(pj)) {
		const parsed = JSON.parse(fs.readFileSync(pj, "utf8"));
		parsed.version = "0.0.0-EQUIVALENCE";
		fs.writeFileSync(pj, JSON.stringify(parsed, null, 2));
	}
	const sentinel = path.join(treeRoot, ".flywheel-prebuilt");
	if (fs.existsSync(sentinel)) fs.writeFileSync(sentinel, "EQUIVALENCE\n");
}

function walkFiles(root) {
	const out = [];
	(function walk(dir) {
		for (const name of fs.readdirSync(dir).sort()) {
			const p = path.join(dir, name);
			const st = fs.lstatSync(p);
			if (st.isDirectory()) walk(p);
			else out.push(path.relative(root, p));
		}
	})(root);
	return out;
}

export function proveEquivalence(betaTarball, cleanTarball, workDir) {
	const betaTree = untar(betaTarball, path.join(workDir, "beta"));
	const cleanTree = untar(cleanTarball, path.join(workDir, "clean"));
	normalizeVersionStamps(betaTree);
	normalizeVersionStamps(cleanTree);
	const a = walkFiles(betaTree);
	const b = walkFiles(cleanTree);
	const diffs = [];
	const setA = new Set(a);
	const setB = new Set(b);
	for (const f of a) if (!setB.has(f)) diffs.push(`only-in-beta: ${f}`);
	for (const f of b) if (!setA.has(f)) diffs.push(`only-in-clean: ${f}`);
	for (const f of a) {
		if (!setB.has(f)) continue;
		const ba = fs.readFileSync(path.join(betaTree, f));
		const bb = fs.readFileSync(path.join(cleanTree, f));
		if (!ba.equals(bb)) diffs.push(`bytes-differ: ${f}`);
	}
	return diffs;
}

// ── prepare ──────────────────────────────────────────────────────────────────
async function cmdPrepare() {
	const client = clientFor("FW_BETA_PUBLISH_TOKEN");
	const releaseId = argValue("release-id", "");
	const betaVer = argValue("beta", "");
	if (!releaseId) die("prepare: --release-id required");
	if (!betaVer)
		die(
			"prepare: --beta <X.Y.Z-beta.N> required (the UNIQUE beta being promoted)",
		);
	const repoRoot = path.resolve(
		argValue("repo-root", path.join(SELF_DIR, "..", "..")),
	);
	const packer =
		process.env.FW_PACKER ||
		path.join(repoRoot, "scripts", "package-onboard.sh");
	const cleanVer = baseOf(betaVer);

	const { manifest } = await client.readManifest();
	if (!manifest) die("no manifest — nothing published yet");
	const betaEntry = manifest.versions[betaVer];
	if (!betaEntry || betaEntry.channel !== "beta") {
		die(`prepare: beta ${betaVer} does not exist in the manifest`);
	}
	// sourceCommit is DERIVED from the entry — and the working tree must BE it.
	const sourceCommit = betaEntry.sourceCommit;
	const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
	if (head !== sourceCommit) {
		die(
			`prepare: checkout is ${head} but the beta was built from ${sourceCommit} — check out the beta's sourceCommit first (fail-closed)`,
		);
	}

	// durable candidate — identity registered at reservation (B0-9-1 release line)
	await client.casUpdate((m) => {
		const op = m.releaseOps[releaseId];
		if (op) {
			if (
				op.kind !== "release" ||
				op.ver !== cleanVer ||
				op.betaVersion !== betaVer
			) {
				throw new Error(
					`releaseId ${releaseId} exists with a different identity — fail-closed`,
				);
			}
			return false;
		}
		m.releaseOps[releaseId] = {
			kind: "release",
			state: "reserved",
			ver: cleanVer,
			betaVersion: betaVer,
			sourceCommit,
			sha256: null,
			objectKey: null,
			createdAt: new Date().toISOString(), // server re-stamps
		};
		return true;
	}, "reserve-candidate");
	log(`candidate reserved: ${releaseId} → ${cleanVer} (from ${betaVer})`);
	testAbortPoint("reserve");

	{
		const { manifest: m } = await client.readManifest();
		if (m.releaseOps[releaseId].state === "committed") {
			log("already committed — idempotent success");
			return;
		}
	}

	// build the clean version at the SAME commit
	const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-payload-promote-"));
	let cleanTarball;
	try {
		const stdout = execFileSync(
			"bash",
			[packer, "--repo-root", repoRoot, "--out", outDir],
			{
				encoding: "utf8",
				env: { ...process.env, PO_RELEASE_VERSION: cleanVer },
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		cleanTarball = stdout.trim().split("\n").pop();
	} catch (e) {
		die(`clean build failed (packer gates are fail-closed): ${e.message}`);
	}
	const sha = await sha256File(cleanTarball);
	const size = fs.statSync(cleanTarball).size;
	const objectKey = payloadKeyOf(cleanVer, sha);
	log(`clean build ${cleanVer}: sha256=${sha} size=${size}`);

	// EQUIVALENCE PROOF against the beta payload actually in distribution
	const betaLocal = path.join(outDir, "beta-payload.tgz");
	await client.downloadPayload(betaVer, betaEntry.sha256, betaLocal);
	const diffs = proveEquivalence(
		betaLocal,
		cleanTarball,
		path.join(outDir, "equiv"),
	);
	if (diffs.length) {
		console.error(
			"[payload-promote] EQUIVALENCE PROOF FAILED — the clean build is NOT the beta:",
		);
		for (const d of diffs.slice(0, 20)) console.error(`  ${d}`);
		die(
			"fail-closed: promote stops here; take this back to design review (never a degraded pass)",
		);
	}
	log("equivalence proven: clean tree ≡ beta tree (version stamps normalized)");
	testAbortPoint("equivalence");

	// register tuple → upload → readback → prepared
	await client.casUpdate((m) => {
		const op = m.releaseOps[releaseId];
		if (op.state === "committed") return false;
		const tuple = { sourceCommit, sha256: sha, objectKey };
		if (op.sha256 !== null) {
			if (!tupleMatches(op, tuple)) {
				throw new Error(
					`releaseId ${releaseId} already carries a different tuple — fail-closed`,
				);
			}
			return false;
		}
		op.sha256 = sha;
		op.objectKey = objectKey;
		return true;
	}, "register-candidate-tuple");
	testAbortPoint("register");
	{
		const { manifest: m } = await client.readManifest();
		if (m.releaseOps[releaseId].state === "reserved") {
			const st = await client.uploadPayload(cleanVer, sha, cleanTarball);
			log(
				st === 409
					? "object already present (retry) — verifying via readback"
					: "uploaded",
			);
			await client.readbackVerify(cleanVer, sha);
			await client.casUpdate((mm) => {
				const op = mm.releaseOps[releaseId];
				if (op.state !== "reserved") return false;
				op.state = "prepared";
				return true;
			}, "to-prepared");
		}
	}
	log(
		`PREPARED: candidate ${releaseId} — ver=${cleanVer} sha256=${sha} (this tuple is what the founder approves; commit rebuilds NOTHING)`,
	);
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMIT PATH — ZERO BUILD BELOW THIS LINE (structural contract, plan PR4-3:
// the founder gate approves the candidate tuple's sha256; nothing below this
// marker may invoke the packer, inject a version, or unpack/compare trees —
// the pipeline test greps this region for those tokens).
// ═════════════════════════════════════════════════════════════════════════════

async function cmdCommit() {
	const client = clientFor("FW_CUSTOMER_RELEASE_TOKEN");
	const releaseId = argValue("release-id", "");
	if (!releaseId) die("commit: --release-id required");

	const { manifest } = await client.readManifest();
	if (!manifest) die("no manifest");
	const op = manifest.releaseOps[releaseId];
	if (!op || op.kind !== "release")
		die(`commit: no release candidate ${releaseId}`);
	if (op.state === "committed") {
		log(`releaseId ${releaseId} already committed — idempotent success`);
		return;
	}
	if (op.state !== "prepared")
		die(`commit: candidate is ${op.state}, must be prepared`);

	// re-verify the EXACT artifact the founder approved (streamed hash)
	await client.readbackVerify(op.ver, op.sha256);
	log(`artifact re-verified: ${op.ver} sha256=${op.sha256}`);

	// object size for the entry (identity metadata; endpoint HEAD-checks it)
	const head = await client.api(
		"GET",
		`/admin/payload/${encodeURIComponent(op.ver)}/${op.sha256}`,
	);
	const bytes = Buffer.from(await head.arrayBuffer());
	const size = bytes.length;

	await client.casUpdate((m) => {
		const cur = m.releaseOps[releaseId];
		if (cur.state === "committed") return false;
		if (cur.state !== "prepared")
			throw new Error(`cannot commit from ${cur.state}`);
		m.versions[cur.ver] = {
			sha256: cur.sha256,
			key: cur.objectKey,
			size,
			publishedAt: new Date().toISOString(), // server re-stamps
			channel: "release",
			status: "active",
			sourceCommit: cur.sourceCommit,
			releaseId,
			derivedFromBeta: cur.betaVersion,
			retentionSince: null,
			quarantinedAt: null,
		};
		m.channels["customer-release"].latest = cur.ver;
		cur.state = "committed";
		return true;
	}, "commit-release");
	log(
		`COMMITTED: customer-release.latest = ${op.ver} (releaseId ${releaseId})`,
	);
}

async function cmdWithdraw() {
	const client = clientFor("FW_CUSTOMER_RELEASE_TOKEN");
	const ver = argValue("withdraw", "");
	const fallback = argValue("fallback", "");
	if (!ver || !fallback)
		die("withdraw: --withdraw <ver> --fallback <ver> required");
	await client.casUpdate((m) => {
		const e = m.versions[ver];
		if (!e) throw new Error(`withdraw: no such version ${ver}`);
		if (
			e.status === "quarantined" &&
			m.channels["customer-release"].latest === fallback
		) {
			return false; // already withdrawn to this fallback (idempotent)
		}
		const f = m.versions[fallback];
		if (!f || f.channel !== "release" || f.status !== "active") {
			throw new Error(
				`withdraw: fallback ${fallback} must be an ACTIVE release (fail-closed)`,
			);
		}
		e.status = "quarantined";
		m.channels["customer-release"].latest = fallback;
		return true;
	}, "withdraw");
	log(
		`WITHDRAWN: ${ver} quarantined; customer-release.latest = ${fallback} (fallback re-pin resets its retention clock server-side)`,
	);
}

async function main() {
	const mode = process.argv[2];
	if (mode === "prepare") return cmdPrepare();
	if (mode === "commit") return cmdCommit();
	if (mode === "withdraw") return cmdWithdraw();
	die("usage: payload-promote.mjs prepare|commit|withdraw (see file header)");
}

main().catch((e) => die(e.message));
