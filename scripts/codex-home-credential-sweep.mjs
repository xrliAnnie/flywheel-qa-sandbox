#!/usr/bin/env node

// FLY-2404: conservative, one-shot inventory and deletion of legacy Codex
// credential copies. Dry-run is the default. --apply owns an admission pause
// and re-proves every authority immediately before each unlink.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLY = process.argv.includes("--apply");
const JSON_OUTPUT = process.argv.includes("--json");
if (process.argv.slice(2).some((arg) => !["--apply", "--json"].includes(arg))) {
	process.stderr.write(
		"usage: codex-home-credential-sweep.mjs [--json] [--apply]\n",
	);
	process.exit(2);
}

class SweepError extends Error {
	constructor(message, code = 1) {
		super(message);
		this.exitCode = code;
	}
}

const userHome = homedir();
const homesRoot =
	process.env.FLYWHEEL_CODEX_HOMES_ROOT ||
	join(userHome, ".flywheel", "codex-homes");
const commRoot =
	process.env.FLYWHEEL_CODEX_SWEEP_COMM_ROOT ||
	join(userHome, ".flywheel", "comm");
const rootCommDb =
	process.env.FLYWHEEL_CODEX_SWEEP_ROOT_COMM_DB ||
	join(userHome, ".flywheel", "comm.db");
const bridgeUrl = (
	process.env.FLYWHEEL_CODEX_SWEEP_BRIDGE_URL || "http://127.0.0.1:3000"
).replace(/\/$/, "");
const psBin = process.env.FLYWHEEL_CODEX_SWEEP_PS_BIN || "/bin/ps";
const sqliteBin =
	process.env.FLYWHEEL_CODEX_SWEEP_SQLITE_BIN || "/usr/bin/sqlite3";
const reportRoot =
	process.env.FLYWHEEL_CODEX_SWEEP_REPORT_ROOT ||
	join(userHome, ".flywheel", "reports");
const backupRoot =
	process.env.FLYWHEEL_CODEX_SWEEP_BACKUP_ROOT ||
	join(userHome, ".flywheel", "codex-credential-backups");
const sourceHome =
	process.env.FLYWHEEL_CODEX_SOURCE_HOME || join(userHome, ".codex");
const rayaHome =
	process.env.FLYWHEEL_CODEX_SWEEP_RAYA_HOME ||
	join(userHome, ".flywheel", "raya", "codex-home");
const leadHomes = (process.env.FLYWHEEL_CODEX_SWEEP_LEAD_HOMES || "")
	.split(delimiter)
	.filter(Boolean);
const token = process.env.TEAMLEAD_API_TOKEN || "";
const quiescenceTimeoutMs = Number(
	process.env.FLYWHEEL_CODEX_SWEEP_QUIESCENCE_TIMEOUT_MS ?? 600_000,
);
const pollMs = Number(process.env.FLYWHEEL_CODEX_SWEEP_POLL_MS ?? 5_000);

if (!token) {
	process.stderr.write("[codex-sweep] TEAMLEAD_API_TOKEN is required\n");
	process.exit(2);
}
for (const [label, value] of [
	["homes root", homesRoot],
	["comm root", commRoot],
	["root comm database", rootCommDb],
	["report root", reportRoot],
	["backup root", backupRoot],
	["credential source home", sourceHome],
	["Raya home", rayaHome],
	...leadHomes.map((home) => ["Lead home", home]),
]) {
	if (!isAbsolute(value)) {
		process.stderr.write(`[codex-sweep] ${label} must be absolute\n`);
		process.exit(2);
	}
}
if (
	!Number.isFinite(quiescenceTimeoutMs) ||
	quiescenceTimeoutMs < 0 ||
	!Number.isFinite(pollMs) ||
	pollMs < 0
) {
	process.stderr.write(
		"[codex-sweep] poll and quiescence timeouts must be non-negative numbers\n",
	);
	process.exit(2);
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function lstatOrNull(path) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

function isUnder(child, parent) {
	const rel = relative(parent, child);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

function sha8(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function readCredentialSummary(path) {
	const before = lstatSync(path);
	if (before.isSymbolicLink()) return { classification: "symlink" };
	if (!before.isFile()) return { classification: "non-regular" };
	if ((before.mode & 0o777) !== 0o600) return { classification: "wrong-mode" };
	const noFollow = fsConstants.O_NOFOLLOW ?? 0;
	const fd = openSync(path, fsConstants.O_RDONLY | noFollow);
	try {
		const opened = fstatSync(fd);
		if (opened.dev !== before.dev || opened.ino !== before.ino)
			throw new Error("identity drift");
		const parsed = JSON.parse(readFileSync(fd, "utf8"));
		const after = fstatSync(fd);
		if (
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			after.size !== opened.size
		)
			throw new Error("credential changed during read");
		const refresh = parsed?.tokens?.refresh_token;
		const idToken = parsed?.tokens?.id_token;
		if (typeof refresh !== "string" || typeof idToken !== "string")
			throw new Error("credential fields absent");
		const payload = JSON.parse(
			Buffer.from(idToken.split(".")[1] || "", "base64url").toString("utf8"),
		);
		const accountId =
			payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof accountId !== "string") throw new Error("account id absent");
		return {
			classification: "valid",
			chain: `${sha8(accountId)}:${sha8(refresh)}`,
			mtimeMs: before.mtimeMs,
		};
	} catch {
		return { classification: "malformed" };
	} finally {
		closeSync(fd);
	}
}

function walk(root, visit, depth = 0) {
	const rootStat = lstatOrNull(root);
	if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
	if (depth > 8) return;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink()) {
			if (entry.name === "auth.json") visit(path);
			continue;
		}
		if (entry.isDirectory()) walk(path, visit, depth + 1);
		else if (entry.name === "auth.json") visit(path);
	}
}

function inventoryCredentials() {
	const paths = new Set();
	const historicalHomes = [];
	const homeStat = lstatOrNull(userHome);
	if (homeStat?.isDirectory() && !homeStat.isSymbolicLink()) {
		for (const entry of readdirSync(userHome, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith(".codex-")) {
				historicalHomes.push(join(userHome, entry.name));
			}
		}
	}
	for (const root of [
		homesRoot,
		join(sourceHome, "profiles"),
		rayaHome,
		...historicalHomes,
		...leadHomes,
	]) {
		walk(root, (path) => paths.add(path));
	}
	const sourceTruth = join(sourceHome, "auth.json");
	if (lstatOrNull(sourceTruth)) paths.add(sourceTruth);
	const backupStat = lstatOrNull(backupRoot);
	if (backupStat?.isDirectory() && !backupStat.isSymbolicLink()) {
		for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
			if (entry.isFile() || entry.isSymbolicLink())
				paths.add(join(backupRoot, entry.name));
		}
	}
	const categories = {
		valid: 0,
		malformed: 0,
		symlink: 0,
		"wrong-mode": 0,
		"non-regular": 0,
	};
	const chains = new Map();
	for (const path of [...paths].sort()) {
		const summary = readCredentialSummary(path);
		categories[summary.classification] += 1;
		if (summary.classification === "valid") {
			const current = chains.get(summary.chain) || {
				chain: summary.chain,
				homes: 0,
				latestMtimeMs: 0,
			};
			current.homes += 1;
			current.latestMtimeMs = Math.max(current.latestMtimeMs, summary.mtimeMs);
			chains.set(summary.chain, current);
		}
	}
	const truth = lstatOrNull(sourceTruth)
		? readCredentialSummary(sourceTruth)
		: { classification: "missing" };
	return {
		count: paths.size,
		categories,
		chains: [...chains.values()].map((chain) => ({
			...chain,
			matchesTruth: truth.chain === chain.chain,
		})),
	};
}

function legacyHomes() {
	const rootStat = lstatOrNull(homesRoot);
	if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink())
		throw new SweepError("legacy homes root is unavailable or unsafe");
	return readdirSync(homesRoot, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				!entry.isSymbolicLink() &&
				UUID_RE.test(entry.name),
		)
		.map((entry) => ({
			executionId: entry.name,
			home: join(homesRoot, entry.name),
			path: join(homesRoot, entry.name, "auth.json"),
			kind: "legacy",
		}));
}

function expiredBackups(nowMs = Date.now()) {
	const rootStat = lstatOrNull(backupRoot);
	if (!rootStat) return [];
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
		throw new SweepError("backup root is unsafe");
	const cutoff = nowMs - 7 * 24 * 60 * 60_000;
	return readdirSync(backupRoot, { withFileTypes: true }).flatMap((entry) => {
		if (
			!entry.isFile() ||
			entry.isSymbolicLink() ||
			!entry.name.endsWith(".json")
		)
			return [];
		const path = join(backupRoot, entry.name);
		const stat = lstatSync(path);
		return stat.mtimeMs < cutoff &&
			readCredentialSummary(path).classification === "valid"
			? [{ path, kind: "backup" }]
			: [];
	});
}

function commDbPaths() {
	const paths = [];
	const root = lstatOrNull(commRoot);
	if (root) {
		if (!root.isDirectory() || root.isSymbolicLink())
			throw new SweepError("comm shard root is unsafe");
		for (const entry of readdirSync(commRoot, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const db = join(commRoot, entry.name, "comm.db");
			const stat = lstatOrNull(db);
			if (stat) paths.push(db);
		}
	}
	if (lstatOrNull(rootCommDb)) paths.push(rootCommDb);
	if (paths.length === 0)
		throw new SweepError("no comm database authority found");
	return [...new Set(paths)].sort();
}

function readCommExecutions() {
	const ids = new Set();
	for (const db of commDbPaths()) {
		const stat = lstatSync(db);
		if (!stat.isFile() || stat.isSymbolicLink())
			throw new SweepError(`comm shard is unsafe: ${db}`);
		try {
			const schema = execFileSync(
				sqliteBin,
				[
					"-readonly",
					db,
					"SELECT name FROM pragma_table_info('sessions') WHERE name='execution_id';",
				],
				{ encoding: "utf8", timeout: 3_000 },
			).trim();
			if (schema !== "execution_id")
				throw new Error("sessions.execution_id absent");
			const rows = execFileSync(
				sqliteBin,
				["-readonly", db, "SELECT execution_id FROM sessions;"],
				{ encoding: "utf8", timeout: 3_000 },
			);
			for (const id of rows.split(/\r?\n/).filter(Boolean)) ids.add(id);
		} catch {
			throw new SweepError(`comm shard unreadable or schema drifted: ${db}`);
		}
	}
	return ids;
}

async function api(path, { method = "GET", body } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3_000);
	try {
		const response = await fetch(`${bridgeUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403)
			throw new SweepError("Bridge bearer rejected", 2);
		if (!response.ok)
			throw new SweepError(`Bridge ${path} returned ${response.status}`);
		return await response.json();
	} catch (error) {
		if (error instanceof SweepError) throw error;
		throw new SweepError(`Bridge ${path} unavailable`);
	} finally {
		clearTimeout(timer);
	}
}

async function bridgeExecutions() {
	const value = await api("/api/sessions?mode=live&limit=200");
	if (
		!Array.isArray(value?.sessions) ||
		!Number.isInteger(value?.count) ||
		value.count !== value.sessions.length
	)
		throw new SweepError(
			"Bridge session authority schema or pagination drifted",
		);
	const ids = new Set();
	for (const session of value.sessions) {
		if (typeof session?.execution_id !== "string")
			throw new SweepError("Bridge session authority omitted execution_id");
		ids.add(session.execution_id);
	}
	return ids;
}

function processSnapshot() {
	try {
		return execFileSync(psBin, ["-E", "-axo", "command="], {
			encoding: "utf8",
			timeout: 3_000,
			maxBuffer: 16 * 1024 * 1024,
		});
	} catch {
		throw new SweepError("process authority unavailable");
	}
}

function hasLease(home) {
	const leaseRoot = join(home, ".flywheel-leases");
	const stat = lstatOrNull(leaseRoot);
	if (!stat) return false;
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new SweepError(`lease authority unsafe: ${home}`);
	return readdirSync(leaseRoot).length > 0;
}

async function authoritySnapshot() {
	return {
		comm: readCommExecutions(),
		bridge: await bridgeExecutions(),
		processes: processSnapshot(),
	};
}

function activeReason(target, authority) {
	if (target.kind !== "legacy") return null;
	if (authority.comm.has(target.executionId)) return "comm-session";
	if (authority.bridge.has(target.executionId)) return "bridge-session";
	if (authority.processes.includes(target.home)) return "process";
	if (hasLease(target.home)) return "lease";
	return null;
}

async function pause(leaseId) {
	const value = await api("/api/admission/pause", {
		method: "POST",
		body: {
			durationSeconds: 900,
			reason: "fly2404-sweep",
			...(leaseId ? { leaseId } : {}),
		},
	});
	const actual = value?.admissionPause?.leaseId;
	if (
		value?.ok !== true ||
		value?.admissionPause?.active !== true ||
		typeof actual !== "string" ||
		(leaseId && actual !== leaseId)
	)
		throw new SweepError("owned admission pause response is invalid");
	return actual;
}

async function resume(leaseId) {
	const value = await api("/api/admission/resume", {
		method: "POST",
		body: { leaseId },
	});
	if (value?.ok !== true) throw new SweepError("owned admission resume failed");
}

async function proveMutationFence(leaseId) {
	const renewed = await pause(leaseId);
	if (renewed !== leaseId)
		throw new SweepError("owned admission pause changed identity");
	const quiet = await api("/api/admission/quiescence");
	if (quiet?.quiescent !== true)
		throw new SweepError("Bridge is not quiescent");
	const health = await api("/health");
	// The renewal above is the ownership proof: Bridge rejects a foreign lease
	// id. The read-only health contract intentionally exposes pause activity and
	// remaining time, but not the private owner lease id.
	if (
		health?.ok !== true ||
		typeof health?.uptime !== "number" ||
		health.uptime < 300 ||
		health?.admissionPause?.active !== true
	)
		throw new SweepError("Bridge uptime or owned-pause health fence failed");
}

async function waitForQuiescence(leaseId) {
	const deadline = Date.now() + quiescenceTimeoutMs;
	while (true) {
		const quiet = await api("/api/admission/quiescence");
		if (quiet?.quiescent === true) return;
		if (Date.now() >= deadline) throw new SweepError("quiescence timed out");
		await pause(leaseId);
		await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
	}
}

function receiptAppend(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const rootStat = lstatSync(dirname(path));
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new SweepError("report root became unsafe");
	}
	const fd = openSync(
		path,
		fsConstants.O_APPEND |
			fsConstants.O_CREAT |
			fsConstants.O_WRONLY |
			(fsConstants.O_NOFOLLOW ?? 0),
		0o600,
	);
	try {
		writeSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function fsyncDirectory(path) {
	const fd = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function receiptPath() {
	return join(
		reportRoot,
		`fly2404-sweep-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.jsonl`,
	);
}

function loadRecovery() {
	const stat = lstatOrNull(reportRoot);
	if (!stat) return { events: [], ambiguous: new Set() };
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new SweepError("report root is unsafe");
	const intents = new Map();
	const closed = new Set();
	for (const entry of readdirSync(reportRoot, { withFileTypes: true })) {
		if (
			!entry.isFile() ||
			!entry.name.startsWith("fly2404-sweep-") ||
			!entry.name.endsWith(".jsonl")
		)
			continue;
		for (const line of readFileSync(join(reportRoot, entry.name), "utf8")
			.split(/\r?\n/)
			.filter(Boolean)) {
			try {
				const event = JSON.parse(line);
				if (event?.phase === "intent" && typeof event.opId === "string")
					intents.set(event.opId, event);
				if (
					[
						"applied",
						"recovered:applied",
						"recovered:not-applied",
						"ambiguous",
						"skipped:active",
					].includes(event?.phase)
				)
					closed.add(event.opId);
			} catch {
				throw new SweepError(`receipt is malformed: ${entry.name}`);
			}
		}
	}
	const events = [];
	const ambiguous = new Set();
	for (const [opId, intent] of intents) {
		if (closed.has(opId)) continue;
		const statNow = lstatOrNull(intent.path);
		if (!statNow)
			events.push({
				...intent,
				phase: "recovered:applied",
				recoveredAt: new Date().toISOString(),
			});
		else if (statNow.dev === intent.dev && statNow.ino === intent.ino)
			events.push({
				...intent,
				phase: "recovered:not-applied",
				recoveredAt: new Date().toISOString(),
			});
		else {
			events.push({
				...intent,
				phase: "ambiguous",
				recoveredAt: new Date().toISOString(),
			});
			ambiguous.add(intent.path);
		}
	}
	return { events, ambiguous };
}

function validateDeletionTarget(target) {
	const parentRoot =
		target.kind === "legacy"
			? realpathSync(homesRoot)
			: realpathSync(backupRoot);
	const parent = realpathSync(dirname(target.path));
	if (
		!isUnder(parent, parentRoot) ||
		(parent === parentRoot && target.kind === "legacy")
	)
		throw new SweepError(
			`deletion target escaped authority root: ${target.path}`,
		);
	const stat = lstatOrNull(target.path);
	if (
		!stat ||
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o777) !== 0o600
	)
		return null;
	if (readCredentialSummary(target.path).classification !== "valid")
		return null;
	return stat;
}

async function main() {
	const inventory = inventoryCredentials();
	const legacy = legacyHomes();
	const initialAuthority = await authoritySnapshot();
	const activeLegacy = legacy
		.filter((target) => activeReason(target, initialAuthority))
		.map((target) => target.executionId);
	const candidates = legacy.filter(
		(target) =>
			!activeReason(target, initialAuthority) && validateDeletionTarget(target),
	);
	const backups = expiredBackups();
	const dryResult = {
		mode: APPLY ? "apply" : "dry-run",
		inventory,
		activeLegacy,
		deletionCandidates: [...candidates, ...backups]
			.slice(0, 20)
			.map((target) => target.path),
	};
	if (!APPLY) {
		process.stdout.write(
			JSON_OUTPUT
				? `${JSON.stringify(dryResult)}\n`
				: `[codex-sweep] dry-run inventory=${inventory.count} candidates=${dryResult.deletionCandidates.length} activeLegacy=${activeLegacy.length}\n`,
		);
		return;
	}

	const recovery = loadRecovery();
	let leaseId = "";
	let applied = 0;
	let skipped = legacy.length - candidates.length;
	let abortedAt = "";
	let operationError;
	const receipt = receiptPath();
	try {
		leaseId = await pause();
		await waitForQuiescence(leaseId);
		await proveMutationFence(leaseId);
		for (const event of recovery.events) receiptAppend(receipt, event);
		for (const target of [...candidates, ...backups]) {
			abortedAt = target.path;
			if (recovery.ambiguous.has(target.path)) {
				skipped += 1;
				continue;
			}
			await proveMutationFence(leaseId);
			const currentAuthority = await authoritySnapshot();
			if (activeReason(target, currentAuthority)) {
				skipped += 1;
				continue;
			}
			const stat = validateDeletionTarget(target);
			if (!stat) {
				skipped += 1;
				continue;
			}
			const credential = readCredentialSummary(target.path);
			const opId = randomUUID();
			const intent = {
				v: 1,
				phase: "intent",
				opId,
				path: target.path,
				kind: target.kind,
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				chainSha8: credential.chain || null,
				ts: new Date().toISOString(),
			};
			receiptAppend(receipt, intent);
			await proveMutationFence(leaseId);
			const finalAuthority = await authoritySnapshot();
			if (activeReason(target, finalAuthority)) {
				receiptAppend(receipt, {
					...intent,
					phase: "skipped:active",
					skippedAt: new Date().toISOString(),
				});
				skipped += 1;
				continue;
			}
			const finalStat = validateDeletionTarget(target);
			if (
				!finalStat ||
				finalStat.dev !== stat.dev ||
				finalStat.ino !== stat.ino
			)
				throw new SweepError(
					`target identity drifted before unlink: ${target.path}`,
				);
			unlinkSync(target.path);
			fsyncDirectory(dirname(target.path));
			receiptAppend(receipt, {
				...intent,
				phase: "applied",
				appliedAt: new Date().toISOString(),
			});
			applied += 1;
		}
		abortedAt = "";
	} catch (error) {
		operationError = error;
	} finally {
		if (leaseId) {
			try {
				await resume(leaseId);
			} catch (error) {
				operationError ??= error;
			}
		}
		const summary = {
			...dryResult,
			applied,
			skipped,
			ambiguous: recovery.ambiguous.size,
			abortedAt,
		};
		process.stdout.write(
			JSON_OUTPUT
				? `${JSON.stringify(summary)}\n`
				: `[codex-sweep] applied=${applied} skipped=${skipped} ambiguous=${recovery.ambiguous.size} aborted_at=${abortedAt || "none"}\n`,
		);
	}
	if (operationError) throw operationError;
}

main().catch((error) => {
	const code = error instanceof SweepError ? error.exitCode : 1;
	process.stderr.write(
		`[codex-sweep] ${error instanceof Error ? error.message : "unexpected failure"}\n`,
	);
	process.exitCode = code;
});
