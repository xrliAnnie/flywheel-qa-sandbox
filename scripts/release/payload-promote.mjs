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
//   commit   (customer-release action; FW_CUSTOMER_RELEASE_TOKEN is supplied
//             only by payload-promote-commit.yml's release environment, §3)
//     node payload-promote.mjs commit --release-id <id> --expected-sha256 <64hex>   (REQUIRED)
//     • ZERO BUILD: re-verifies the already-prepared artifact's sha via
//       streamed readback, then ONE CAS: release entry (full lineage) +
//       customer-release pointer + op→committed. The external B1 founder-go / B4
//       veto authority binds the candidate tuple's sha256 before dispatch;
//       nothing is rebuilt after that gate.
//
//   commit --cycle-id <id> --binding-digest <64hex> [--attempt-id <uuid>]
//     keeps --release-id and --expected-sha256 required, uses only
//     FW_AUTO_RELEASE_EXECUTOR_TOKEN, and requires a durable founder decision.
//
//   rebind-prepared-artifact --source-release-id <old> --release-id <new>
//     --source-binding-digest <64hex> (FW_BETA_PUBLISH_TOKEN)
//     reuses verified bytes from an abandoned op under a new manual identity.
//
//   withdraw (same environment-gated workflow and capability as commit)
//     node payload-promote.mjs withdraw --withdraw <ver> [--fallback <ver> | --allow-pause]
//     • quarantine + pointer to available previous-good (or explicit pause), ONE CAS; the
//       fallback re-pin resets its retention clock (server-stamped).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyPreparedReleaseCommit } from "../../packages/payload-endpoint/src/release-commit.mjs";
import {
	deriveVetoBinding,
	ENTITLEMENT_POINTER,
	isCleanSemver,
	RETENTION_WINDOW_MS,
	validateManifest,
} from "../../packages/release-contract/src/index.mjs";
import {
	baseOf,
	makeClient,
	payloadKeyOf,
	sha256File,
	testAbortPoint,
	tupleMatches,
} from "./lib/endpoint-client.mjs";
import { rebindPreparedArtifact } from "./lib/rebind-prepared-artifact.mjs";
import { isReleaseId } from "./lib/release-id.mjs";
import { runAutoReleaseCommand } from "./payload-auto-release.mjs";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const CUSTOMER_POINTER = ENTITLEMENT_POINTER.customer;

function die(msg) {
	console.error(`[payload-promote] ${msg}`);
	process.exit(1);
}
const log = (m) => console.log(`[payload-promote] ${m}`);

function emitResult(result) {
	const json = JSON.stringify(result);
	console.log(json);
	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `result=${json}\n`);
	}
}

function parseCommandArgs({
	valueFlags = [],
	booleanFlags = [],
	exclusive = [],
	requires = {},
}) {
	const argv = process.argv.slice(3);
	const allowed = [...valueFlags, ...booleanFlags];
	const known = () => allowed.map((a) => `--${a}`).join(" ");
	const seen = new Set();
	const parsed = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (!arg.startsWith("--")) {
			die(
				`unrecognized argument '${arg}' (known: ${known()}). ` +
					`Refusing rather than ignoring it — an argument that looks like a control but does nothing is worse than no control.`,
			);
		}
		if (arg.includes("=")) {
			die(
				`--flag=value is not supported (got ${arg}). Use the space-separated form: ${arg.split("=")[0]} <value>. ` +
					`Refusing rather than silently reading it as absent.`,
			);
		}
		const name = arg.slice(2);
		if (!allowed.includes(name)) {
			die(
				`unknown flag --${name} (known: ${known()}). ` +
					`Refusing rather than ignoring it — a flag that looks like a control but does nothing is worse than no control.`,
			);
		}
		if (seen.has(name))
			die(`--${name} given more than once — refusing an ambiguous value`);
		seen.add(name);

		if (booleanFlags.includes(name)) {
			parsed[name] = true;
			continue;
		}
		if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
			die(
				`--${name} requires a value but none followed it — refusing to read a dangling flag as absent`,
			);
		}
		parsed[name] = argv[++i];
	}

	for (const group of exclusive) {
		const present = group.filter((name) => seen.has(name));
		if (present.length > 1) {
			die(`--${present.join(" and --")} are mutually exclusive`);
		}
	}
	for (const [name, dependencies] of Object.entries(requires)) {
		if (!seen.has(name)) continue;
		for (const dependency of dependencies) {
			if (!seen.has(dependency)) {
				die(`--${name} requires --${dependency}`);
			}
		}
	}
	return parsed;
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

async function cmdRebindPreparedArtifact() {
	const args = parseCommandArgs({
		valueFlags: ["source-release-id", "release-id", "source-binding-digest"],
	});
	const result = await rebindPreparedArtifact(
		clientFor("FW_BETA_PUBLISH_TOKEN"),
		{
			sourceReleaseId: args["source-release-id"],
			releaseId: args["release-id"],
			sourceBindingDigest: args["source-binding-digest"],
		},
	);
	emitResult({
		action: "rebind-prepared-artifact",
		sourceReleaseId: args["source-release-id"],
		...result,
	});
}

// ── prepare ──────────────────────────────────────────────────────────────────
async function cmdPrepare() {
	const args = parseCommandArgs({
		valueFlags: ["release-id", "beta", "repo-root"],
	});
	const releaseId = args["release-id"] ?? "";
	const betaVer = args.beta ?? "";
	if (!releaseId) die("prepare: --release-id required");
	if (!isReleaseId(releaseId)) die("prepare: invalid releaseId");
	if (!betaVer)
		die(
			"prepare: --beta <X.Y.Z-beta.N> required (the UNIQUE beta being promoted)",
		);
	const client = clientFor("FW_BETA_PUBLISH_TOKEN");
	const repoRoot = path.resolve(
		args["repo-root"] ?? path.join(SELF_DIR, "..", ".."),
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
	const args = parseCommandArgs({
		valueFlags: [
			"release-id",
			"expected-sha256",
			"cycle-id",
			"binding-digest",
			"attempt-id",
		],
		requires: {
			"cycle-id": ["binding-digest"],
			"binding-digest": ["cycle-id"],
			"attempt-id": ["cycle-id", "binding-digest"],
		},
	});
	const releaseId = args["release-id"] ?? "";
	if (!releaseId) die("commit: --release-id required");
	if (!isReleaseId(releaseId)) die("commit: invalid releaseId");
	// FLY-1323: binds THIS invocation to the exact tuple the founder approved.
	// REQUIRED, not optional — an unbound direct commit is precisely the hole the
	// founder-direct first publish opens. Nothing in the repo needs the unbound
	// form, so an optional flag would only preserve a footgun.
	const expectedSha = args["expected-sha256"] ?? "";
	if (!expectedSha)
		die(
			"commit: --expected-sha256 <64hex> required — the customer pointer only ever moves to an artifact someone explicitly approved by hash",
		);
	if (!/^[0-9a-f]{64}$/.test(expectedSha))
		die(
			`commit: --expected-sha256 must be a 64-char lowercase hex sha256 (got ${expectedSha})`,
		);
	if (args["cycle-id"]) {
		const result = await runAutoReleaseCommand(
			{
				cycleId: args["cycle-id"],
				releaseId,
				bindingDigest: args["binding-digest"],
				expectedSha256: expectedSha,
				...(args["attempt-id"] ? { attemptId: args["attempt-id"] } : {}),
			},
			{ requireManualDecision: true },
		);
		emitResult({ action: "commit", ...result });
		process.exitCode = result.kind === "published" ? 0 : 2;
		return;
	}
	const client = clientFor("FW_CUSTOMER_RELEASE_TOKEN");

	const { manifest } = await client.readManifest();
	if (!manifest) die("no manifest");
	const op = manifest.releaseOps[releaseId];
	if (!op || op.kind !== "release")
		die(`commit: no release candidate ${releaseId}`);
	if (expectedSha && op.sha256 !== expectedSha)
		die(
			`commit: --expected-sha256 ${expectedSha} does not match candidate ${releaseId} (${op.sha256}) — ` +
				`refusing fail-closed. The approval binds a specific artifact; this is not it.`,
		);
	if (op.state === "committed") {
		log(`releaseId ${releaseId} already committed — idempotent success`);
		emitResult({
			action: "commit",
			releaseId,
			ver: op.ver,
			sha256: expectedSha,
			outcome: "idempotent",
		});
		return;
	}
	if (op.state !== "prepared")
		die(`commit: candidate is ${op.state}, must be prepared`);

	// re-verify the EXACT artifact the founder approved (streamed hash)
	const { size } = await client.readbackVerify(op.ver, op.sha256);
	log(`artifact re-verified: ${op.ver} sha256=${op.sha256}`);

	// QA ff38290f F1 (defense in depth — NOT a live HIGH; severity corrected in R4,
	// confirmed by Codex): the binding above was checked on the snapshot read at
	// readManifest(), but casUpdate re-reads the manifest on EVERY attempt — so the
	// tuple that actually moves the pointer (`cur`) was never compared to what the
	// founder approved. QA demonstrated a swap via a STUB endpoint; the REAL endpoint
	// (packages/payload-endpoint/src/transitions.mjs) makes a prepared op's tuple
	// write-once with no transition back to `reserved`, so the swap cannot land in
	// production — see test P7a. This guard still matters: the CLI's approval contract
	// must not silently depend on a server-side invariant (if the endpoint ever
	// relaxed write-once, an unguarded CLI would move the pointer to an unapproved
	// artifact). And the success log printed the snapshot-A version while the
	// snapshot-B version was written — so the operator could not see a divergence
	// from the output.
	//
	// Re-check inside the mutate, where `cur` is the tuple being written. casUpdate's
	// own contract says "mutate may also THROW to fail closed", and payload-release.mjs
	// already fails closed this way on a mismatched tuple. Moving the customer pointer
	// is the highest-consequence write in the flow and was the one call site not doing
	// it.
	let committedVer = null;
	let outcome = "committed";
	await client.casUpdate((m) => {
		const cur = m.releaseOps[releaseId];
		if (!cur || cur.kind !== "release") {
			throw new Error(
				`commit: candidate ${releaseId} must still exist with kind release on the CAS retry`,
			);
		}
		// The binding is re-checked FIRST, unconditionally, against the tuple this
		// attempt actually observes — before any early return can skip it. A
		// concurrent commit of a DIFFERENT artifact must fail closed, not be
		// reported as idempotent success.
		if (cur.sha256 !== expectedSha)
			throw new Error(
				`commit: candidate ${releaseId} changed under us — approved sha256 ${expectedSha}, ` +
					`manifest now has ${cur.sha256} (version ${cur.ver}). Refusing fail-closed: the customer ` +
					`pointer only ever moves to the artifact that was explicitly approved by hash.`,
			);
		if (cur.state === "committed") {
			// Someone else committed the artifact we approved — genuinely idempotent.
			committedVer = cur.ver;
			outcome = "idempotent";
			return false;
		}
		if (cur.state !== "prepared")
			throw new Error(`cannot commit from ${cur.state}`);
		const binding = deriveVetoBinding(m, releaseId);
		if (binding.releasePayloadSha256 !== expectedSha) {
			throw new Error(
				`commit: candidate ${releaseId} veto binding changed under us — approved sha256 ${expectedSha}, ` +
					`binding now has ${binding.releasePayloadSha256}. Refusing fail-closed.`,
			);
		}
		committedVer = applyPreparedReleaseCommit(
			m,
			binding,
			size,
			new Date().toISOString(),
		);
		return true;
	}, "commit-release");
	// Report what was ACTUALLY written, not what we read before the write. The old
	// log printed op.ver (snapshot A) while the mutate wrote cur.ver (snapshot B):
	// in QA's repro the CLI said "COMMITTED 1.0.0" while the pointer went to 6.6.6.
	// The guard above now makes that divergence impossible, but a success line must
	// still be evidence of the write itself rather than of a stale read — otherwise
	// the next person to break the guard gets a reassuring lie instead of a symptom.
	log(
		`COMMITTED: ${CUSTOMER_POINTER}.latest = ${committedVer} (releaseId ${releaseId})`,
	);
	emitResult({
		action: "commit",
		releaseId,
		ver: committedVer,
		sha256: expectedSha,
		outcome,
	});
}

async function cmdWithdraw() {
	const args = parseCommandArgs({
		valueFlags: ["withdraw", "fallback"],
		booleanFlags: ["allow-pause"],
		exclusive: [["fallback", "allow-pause"]],
	});
	const ver = args.withdraw ?? "";
	const explicitFallback = args.fallback ?? null;
	if (!ver) die("withdraw: --withdraw <ver> required");
	if (
		!isCleanSemver(ver) ||
		(explicitFallback !== null && !isCleanSemver(explicitFallback))
	)
		die("withdraw: versions must be clean payload semvers");
	if (ver === explicitFallback)
		die("withdraw: withdrawn and fallback versions must differ");
	const client = clientFor("FW_CUSTOMER_RELEASE_TOKEN");
	let outcome = "withdrawn";
	let fallback = null;
	const expired = [];
	await client.casUpdate(
		(m, _current, { serverNowMs }) => {
			expired.length = 0;
			outcome = "withdrawn";
			const e = m.versions[ver];
			if (!e) throw new Error(`withdraw: no such version ${ver}`);
			const latest = m.channels[CUSTOMER_POINTER].latest;
			if (e.status === "quarantined") {
				if (explicitFallback !== null && latest !== explicitFallback)
					throw new Error(
						"withdraw: quarantined version is not bound to the requested fallback",
					);
				fallback = latest;
				outcome = "idempotent";
				return false;
			}
			if (e.channel !== "release" || e.status !== "active")
				throw new Error(`withdraw: ${ver} must be an ACTIVE release`);
			if (latest !== ver)
				throw new Error(
					`withdraw: ${ver} is not the current ${CUSTOMER_POINTER} pointer`,
				);
			const candidates = Object.entries(m.versions).filter(
				([v, entry]) =>
					v !== ver &&
					entry.channel === "release" &&
					entry.status === "active" &&
					(entry.retentionSince === null ||
						Date.parse(entry.retentionSince) + RETENTION_WINDOW_MS.release >
							serverNowMs),
			);
			if (
				explicitFallback !== null &&
				!candidates.some(([v]) => v === explicitFallback)
			)
				throw new Error(
					`withdraw: fallback ${explicitFallback} not re-pinnable (expired or not an active release)`,
				);
			candidates.sort(
				(a, b) =>
					(Date.parse(b[1].retentionSince) || 0) -
						(Date.parse(a[1].retentionSince) || 0) ||
					Date.parse(b[1].publishedAt) - Date.parse(a[1].publishedAt),
			);
			fallback = explicitFallback ?? candidates[0]?.[0] ?? null;
			if (fallback === null) {
				if (!args["allow-pause"])
					throw new Error(
						"withdraw: no re-pinnable previous-good; rerun with --allow-pause",
					);
				for (const [v, entry] of Object.entries(m.versions)) {
					if (
						v !== ver &&
						entry.channel === "release" &&
						entry.status === "active"
					) {
						entry.status = "expired";
						expired.push(v);
					}
				}
				outcome = "paused";
			}
			e.status = "quarantined";
			m.channels[CUSTOMER_POINTER].latest = fallback;
			return true;
		},
		"withdraw",
		{ requireServerTime: true, timeGuardRetries: 3 },
	);
	log(`WITHDRAWN: ${ver}; ${CUSTOMER_POINTER}.latest = ${fallback}`);
	emitResult({
		action: "withdraw",
		withdrawn: ver,
		fallback,
		latest: fallback,
		outcome,
		expired,
	});
}

async function cmdAbandon() {
	const args = parseCommandArgs({
		valueFlags: ["release-id", "stale-days"],
		booleanFlags: ["apply"],
		exclusive: [["release-id", "stale-days"]],
		requires: { apply: ["stale-days"] },
	});
	const releaseId = args["release-id"] ?? "";
	const staleDays = args["stale-days"] ?? "";
	if (!releaseId && !staleDays) {
		die("abandon: exactly one of --release-id or --stale-days is required");
	}
	if (releaseId && !isReleaseId(releaseId)) die("abandon: invalid releaseId");
	if (staleDays && !/^[1-9][0-9]*$/.test(staleDays)) {
		die("abandon: --stale-days must be a positive integer");
	}
	const client = clientFor("FW_CUSTOMER_RELEASE_TOKEN");
	if (releaseId) {
		let outcome = "abandoned";
		await client.casUpdate((m) => {
			const op = m.releaseOps[releaseId];
			if (!op || op.kind !== "release") {
				throw new Error(`abandon: no release candidate ${releaseId}`);
			}
			if (op.state === "abandoned") {
				outcome = "idempotent";
				return false;
			}
			if (op.state === "committed") {
				throw new Error(
					`abandon: ${releaseId} is already published; use withdraw instead`,
				);
			}
			if (op.state !== "reserved" && op.state !== "prepared") {
				throw new Error(`abandon: cannot abandon from ${op.state}`);
			}
			op.state = "abandoned";
			return true;
		}, `abandon ${releaseId}`);
		emitResult({ action: "abandon", releaseIds: [releaseId], outcome });
		return;
	}

	const cutoff = Date.now() - Number(staleDays) * 24 * 60 * 60 * 1000;
	const staleIds = (m) =>
		Object.entries(m.releaseOps)
			.filter(
				([, op]) =>
					op.kind === "release" &&
					(op.state === "reserved" || op.state === "prepared") &&
					Date.parse(op.createdAt) <= cutoff,
			)
			.map(([id]) => id)
			.sort();
	if (!args.apply) {
		const { manifest } = await client.readManifest();
		emitResult({
			action: "abandon",
			releaseIds: staleIds(manifest),
			outcome: "dry-run",
		});
		return;
	}
	let releaseIds = [];
	await client.casUpdate((m) => {
		releaseIds = staleIds(m);
		for (const id of releaseIds) m.releaseOps[id].state = "abandoned";
		return releaseIds.length > 0;
	}, `abandon releases stale for ${staleDays} day(s)`);
	emitResult({
		action: "abandon",
		releaseIds,
		outcome: releaseIds.length ? "abandoned" : "idempotent",
	});
}

async function cmdValidateSnapshot() {
	parseCommandArgs({});
	const client = clientFor("FW_CUSTOMER_RELEASE_TOKEN");
	const { manifest } = await client.readManifest();
	if (!manifest) die("validate-snapshot: no manifest");
	const violations = validateManifest(manifest);
	if (violations.length) {
		throw new Error(
			`validate-snapshot: contract violations: ${JSON.stringify(violations)}`,
		);
	}
	log(
		`snapshot valid: channels=${JSON.stringify(manifest.channels)} releaseOps=${Object.keys(manifest.releaseOps).length}`,
	);
}

async function main() {
	const mode = process.argv[2];
	if (mode === "prepare") return cmdPrepare();
	if (mode === "rebind-prepared-artifact") return cmdRebindPreparedArtifact();
	if (mode === "commit") return cmdCommit();
	if (mode === "abandon") return cmdAbandon();
	if (mode === "withdraw") return cmdWithdraw();
	if (mode === "validate-snapshot") return cmdValidateSnapshot();
	die(
		"usage: payload-promote.mjs prepare|rebind-prepared-artifact|commit|abandon|withdraw|validate-snapshot (see file header)",
	);
}

main().catch((e) => die(e.message));
