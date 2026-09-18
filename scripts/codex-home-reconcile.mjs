#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	computeCodexHomeInventoryDigest,
	reserveCodexHomeAttemptIntent,
	updateCodexHomeMigrationState,
	writeCodexHomeAttemptReceipt,
} from "../packages/claude-runner/dist/index.js";
import { processAlive, withMkdirLock } from "../packages/config/dist/index.js";

const SOURCE_VALUES = new Set([
	"health",
	"updater",
	"restart-window",
	"manual",
]);
const BUILD_SHA_RE = /^[a-f0-9]{40}$/;
const HOME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message, code = 2) {
	process.stderr.write(`CODEX_HOME_RECONCILE unavailable reason=${message}\n`);
	process.exit(code);
}

function parseArgs(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (
			![
				"--approved-homes",
				"--state-root",
				"--source",
				"--home-id",
				"--overdue-days",
			].includes(
				key,
			) ||
			!value ||
			values.has(key)
		) {
			fail("usage");
		}
		values.set(key, value);
	}
	for (const key of ["--approved-homes", "--state-root", "--source"]) {
		if (!values.has(key)) fail("usage");
	}
	const approvedHomes = values.get("--approved-homes");
	const stateRoot = values.get("--state-root");
	const source = values.get("--source");
	const homeId = values.get("--home-id");
	const overdueDays = Number(values.get("--overdue-days") ?? "1");
	if (
		!isAbsolute(approvedHomes) ||
		resolve(approvedHomes) !== approvedHomes ||
		!isAbsolute(stateRoot) ||
		resolve(stateRoot) !== stateRoot ||
		!SOURCE_VALUES.has(source) ||
		!Number.isInteger(overdueDays) ||
		overdueDays < 1 ||
		overdueDays > 30 ||
		(homeId !== undefined &&
			(!HOME_ID_RE.test(homeId) || homeId.includes("..")))
	) {
		fail("arguments");
	}
	return { approvedHomes, stateRoot, source, homeId, overdueDays };
}

function plainFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
		throw new Error(`${label}_unsafe`);
	}
}

function loadInventory(path) {
	plainFile(path, "approved_inventory");
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	const rawHomes = Array.isArray(parsed) ? parsed : parsed?.homes;
	if (
		!Array.isArray(rawHomes) ||
		rawHomes.length === 0 ||
		rawHomes.length > 5000
	) {
		throw new Error("approved_inventory_invalid");
	}
	const ids = new Set();
	const paths = new Set();
	return rawHomes.map((entry) => {
		if (
			typeof entry?.id !== "string" ||
			!HOME_ID_RE.test(entry.id) ||
			entry.id.includes("..") ||
			typeof entry.home !== "string" ||
			!isAbsolute(entry.home) ||
			resolve(entry.home) !== entry.home ||
			!["managed", "independent"].includes(entry.ownership) ||
			ids.has(entry.id) ||
			paths.has(entry.home) ||
			(entry.pendingAt !== undefined &&
				!Number.isFinite(Date.parse(entry.pendingAt))) ||
			(entry.leadTuple !== undefined &&
				!/^[-A-Za-z0-9._]+\/[-A-Za-z0-9._]+$/.test(entry.leadTuple))
		) {
			throw new Error("approved_inventory_invalid");
		}
		ids.add(entry.id);
		paths.add(entry.home);
		return {
			id: entry.id,
			home: entry.home,
			ownership: entry.ownership,
			...(entry.pendingAt
				? { pendingAt: new Date(entry.pendingAt).toISOString() }
				: {}),
			...(entry.leadTuple ? { leadTuple: entry.leadTuple } : {}),
		};
	});
}

function parseInspect(output) {
	const lines = output.trim().split("\n");
	const value = JSON.parse(lines.at(-1));
	if (!["already", "requires-migration"].includes(value?.state)) {
		throw new Error("inspect_invalid");
	}
	return value;
}

function runLink(linkBin, entry, args, env) {
	const lead = entry.leadTuple ? ["--lead", entry.leadTuple] : [];
	return spawnSync(linkBin, [...lead, ...args, entry.home], {
		env,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	});
}

function linkedWithPending(home, canonicalAuth) {
	try {
		return (
			lstatSync(join(home, "auth.json")).isSymbolicLink() &&
			readlinkSync(join(home, "auth.json")) === canonicalAuth &&
			lstatSync(join(home, ".credential-copy-pending")).isFile()
		);
	} catch {
		return false;
	}
}

function failureReason(status, output) {
	if (status === 3) return "active_process";
	if (status === 5) {
		return /launchd|launch_fence|lead/i.test(output)
			? "launch_fence_unavailable"
			: "process_unknown";
	}
	if (status === 6) return "durability_uncertain";
	if (/unsafe|symlink|outside|mismatch|invalid/i.test(output))
		return "unsafe_path";
	return "mutation_failed";
}

function structuredResult(output) {
	for (const line of output.split("\n")) {
		if (!line.startsWith("CODEX_HOME_LINK_RESULT ")) continue;
		return JSON.parse(line.slice("CODEX_HOME_LINK_RESULT ".length));
	}
	throw new Error("structured_result_missing");
}

function emitReceipt(stateRoot, receipt) {
	writeCodexHomeAttemptReceipt({ stateRoot, receipt });
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function ensureLockRoot(stateRoot, name) {
	const lockRoot = join(stateRoot, "codex-quota", "home-migration", name);
	try {
		mkdirSync(lockRoot, { mode: 0o700 });
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
	}
	const stat = lstatSync(lockRoot);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error("unsafe reconcile lock root");
	}
	chmodSync(lockRoot, 0o700);
	return lockRoot;
}

function fsyncDirectory(path) {
	const fd = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function readProcessStart(pid) {
	const psBin = process.env.FLYWHEEL_CODEX_FENCE_PS_BIN?.trim() || "/bin/ps";
	const result = spawnSync(psBin, ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: 2_000,
		maxBuffer: 64 * 1024,
	});
	return result.status === 0 && !result.error
		? result.stdout.trim() || null
		: null;
}

function inspectLeadLaunchLease(leaseRoot, entry) {
	const key = createHash("sha256").update(entry.home).digest("hex");
	const path = join(leaseRoot, `${key}.json`);
	let value;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
			return "unknown";
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return "inactive";
		return "unknown";
	}
	if (
		value?.schemaVersion !== 1 ||
		!Number.isInteger(value.pid) ||
		value.pid <= 0 ||
		typeof value.processStartTime !== "string" ||
		!value.processStartTime ||
		value.home !== entry.home ||
		value.lead !== entry.leadTuple
	)
		return "unknown";
	if (processAlive(value.pid)) {
		const liveStart = readProcessStart(value.pid);
		if (liveStart === null) return "unknown";
		if (liveStart === value.processStartTime) return "active";
	}
	try {
		unlinkSync(path);
		fsyncDirectory(leaseRoot);
		return "inactive";
	} catch {
		return "unknown";
	}
}

function reconcileUnderLock({
	common,
	entry,
	linkBin,
	canonicalAuth,
	env,
	stateRoot,
	leadLeaseRoot,
}) {
	if (entry.leadTuple) {
		const lease = inspectLeadLaunchLease(leadLeaseRoot, entry);
		if (lease !== "inactive") {
			return {
				failed: false,
				receipt: {
					...common,
					result: "skipped",
					reason:
						lease === "active" ? "active_lease" : "launch_fence_unavailable",
					satisfied: false,
					backupRef: null,
					postcondition: null,
				},
			};
		}
	}
	const inspect = runLink(linkBin, entry, ["--inspect"], env);
	if (inspect.status !== 0 || inspect.error) {
		return {
			failed: true,
			receipt: {
				...common,
				result: "failed",
				reason: "unsafe_path",
				satisfied: false,
				backupRef: null,
				postcondition: null,
			},
		};
	}
	let observed;
	try {
		observed = parseInspect(inspect.stdout);
	} catch {
		return {
			failed: true,
			receipt: {
				...common,
				result: "failed",
				reason: "unsafe_path",
				satisfied: false,
				backupRef: null,
				postcondition: null,
			},
		};
	}
	if (observed.state === "already") {
		return {
			failed: false,
			receipt: {
				...common,
				result: "already-satisfied",
				reason: "canonical_link_verified",
				satisfied: true,
				backupRef: null,
				postcondition: {
					credentialShared: true,
					pending: false,
					mutation: false,
				},
			},
		};
	}
	const markerOnly = linkedWithPending(entry.home, canonicalAuth);
	const mutation = runLink(linkBin, entry, ["--keep-backup"], env);
	const combinedOutput = `${mutation.stdout || ""}\n${mutation.stderr || ""}`;
	if (mutation.status !== 0 || mutation.error) {
		const reason = failureReason(mutation.status, combinedOutput);
		const skipped = mutation.status === 3 || mutation.status === 5;
		return {
			failed: !skipped,
			receipt: {
				...common,
				result: skipped ? "skipped" : "failed",
				reason,
				satisfied: false,
				backupRef: null,
				postcondition: null,
			},
		};
	}
	let linkResult;
	try {
		linkResult = structuredResult(mutation.stdout);
		const verified = runLink(linkBin, entry, ["--inspect"], env);
		if (
			verified.status !== 0 ||
			parseInspect(verified.stdout).state !== "already"
		) {
			throw new Error("postcondition_failed");
		}
	} catch {
		return {
			failed: true,
			receipt: {
				...common,
				result: "failed",
				reason: "durability_uncertain",
				satisfied: false,
				backupRef: null,
				postcondition: null,
			},
		};
	}
	let backupRef = null;
	if (linkResult.backupPath) {
		backupRef = relative(stateRoot, linkResult.backupPath);
		if (!backupRef || backupRef === ".." || backupRef.startsWith("../")) {
			return {
				failed: true,
				receipt: {
					...common,
					result: "failed",
					reason: "durability_uncertain",
					satisfied: false,
					backupRef: null,
					postcondition: null,
				},
			};
		}
	}
	return {
		failed: false,
		receipt: {
			...common,
			result: "done",
			reason: markerOnly ? "marker_cleared" : "linked",
			satisfied: true,
			backupRef,
			postcondition: {
				credentialShared: true,
				pending: false,
				mutation: true,
			},
		},
	};
}

const args = parseArgs(process.argv.slice(2));
const buildSha = process.env.FLYWHEEL_BUILD_SHA?.trim();
if (!buildSha || !BUILD_SHA_RE.test(buildSha)) fail("build_sha_invalid");
const homeRoot = process.env.HOME?.trim();
if (!homeRoot || !isAbsolute(homeRoot)) fail("user_home_invalid");
const canonicalHome =
	process.env.FLYWHEEL_CODEX_SOURCE_HOME?.trim() || join(homeRoot, ".codex");
const canonicalAuth = realpathSync(join(canonicalHome, "auth.json"));
const linkBin =
	process.env.FLYWHEEL_CODEX_LINK_TRUTH_BIN?.trim() ||
	join(repoRoot, "scripts", "codex-home-link-truth.sh");

let inventory;
try {
	inventory = loadInventory(args.approvedHomes);
} catch (error) {
	fail(error instanceof Error ? error.message : "approved_inventory_invalid");
}
const inventoryDigest = computeCodexHomeInventoryDigest(inventory);
const selected = args.homeId
	? inventory.filter((entry) => entry.id === args.homeId)
	: inventory;
if (selected.length !== (args.homeId ? 1 : inventory.length))
	fail("home_id_unknown");

try {
	updateCodexHomeMigrationState({
		stateRoot: args.stateRoot,
		inventoryDigest,
		overdueDays: args.overdueDays,
		now: new Date(),
		homes: inventory,
	});
} catch (error) {
	fail(error instanceof Error ? error.message : "control_state_unavailable");
}

let lockRoot;
let leadFenceRoot;
let leadLeaseRoot;
try {
	lockRoot = ensureLockRoot(args.stateRoot, "locks");
	leadFenceRoot = ensureLockRoot(args.stateRoot, "lead-fences");
	leadLeaseRoot = ensureLockRoot(args.stateRoot, "lead-leases");
} catch {
	fail("lock_root_unavailable", 6);
}
let failed = false;
for (const entry of selected) {
	const common = {
		schemaVersion: 1,
		attemptId: randomUUID(),
		at: new Date().toISOString(),
		homeId: entry.id,
		home: entry.home,
		inventoryDigest,
		source: args.source,
		buildSha,
	};
	try {
		reserveCodexHomeAttemptIntent({
			stateRoot: args.stateRoot,
			intent: { ...common, status: "started" },
		});
	} catch {
		fail("intent_unavailable", 6);
	}
	const env = { ...process.env, FLYWHEEL_CODEX_LINK_STRUCTURED: "1" };
	const lockPath = join(
		entry.leadTuple ? leadFenceRoot : lockRoot,
		createHash("sha256").update(entry.home).digest("hex"),
	);
	let outcome;
	try {
		outcome = await withMkdirLock(
			lockPath,
			async () =>
				reconcileUnderLock({
					common,
					entry,
					linkBin,
					canonicalAuth,
					env,
					stateRoot: args.stateRoot,
					leadLeaseRoot,
				}),
			{ timeoutMs: 0, bare: Boolean(entry.leadTuple) },
		);
	} catch (error) {
		const lockBusy =
			error instanceof Error &&
			error.message === `withMkdirLock: timeout acquiring ${lockPath}`;
		outcome = {
			failed: !lockBusy,
			receipt: {
				...common,
				result: lockBusy ? "skipped" : "failed",
				reason: lockBusy ? "lock_busy" : "mutation_failed",
				satisfied: false,
				backupRef: null,
				postcondition: null,
			},
		};
	}
	emitReceipt(args.stateRoot, outcome.receipt);
	if (outcome.failed) failed = true;
}

if (failed) process.exitCode = 1;
