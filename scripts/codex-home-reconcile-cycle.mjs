#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withMkdirLock } from "../packages/config/dist/index.js";
import { evaluateCodexHomeMigrationDeadlines } from "../packages/claude-runner/dist/index.js";
import { resolveCodexCredentialHomeRoster } from "../packages/teamlead/dist/codex-quota/credential-home-roster.js";
import { parseAndValidateProjects } from "../packages/teamlead/dist/ProjectConfig.js";

const SOURCES = new Set(["health", "updater", "restart-window", "manual"]);
const SHA40 = /^[a-f0-9]{40}$/;
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function fail(reason, code = 1) {
	process.stderr.write(
		`CODEX_HOME_RECONCILE_CYCLE unavailable reason=${reason}\n`,
	);
	process.exit(code);
}

class CycleError extends Error {
	constructor(message, exitCode) {
		super(message);
		this.exitCode = exitCode;
	}
}

function parseArgs(argv) {
	let source;
	let homeId;
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!value || !["--source", "--home-id"].includes(key)) fail("usage", 2);
		if (key === "--source" && source === undefined) source = value;
		else if (key === "--home-id" && homeId === undefined) homeId = value;
		else fail("usage", 2);
	}
	if (!SOURCES.has(source)) fail("source_invalid", 2);
	if (
		homeId !== undefined &&
		(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(homeId) ||
			homeId.includes(".."))
	)
		fail("home_id_invalid", 2);
	return { source, homeId };
}

function plainFile(path, maxSize = 1024 * 1024) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxSize)
		throw new Error("unsafe_file");
}

function ensureDirectory(path) {
	try {
		const stat = lstatSync(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("unsafe_directory");
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		mkdirSync(path, { mode: 0o700 });
	}
	chmodSync(path, 0o700);
}

function fsyncDirectory(path) {
	const fd = openSync(path, fsConstants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function atomicJson(path, value) {
	const directory = dirname(path);
	try {
		plainFile(path);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const temporary = join(
		directory,
		`.${path.split("/").at(-1)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
	);
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		const fd = openSync(temporary, fsConstants.O_RDONLY);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
		chmodSync(path, 0o600);
		fsyncDirectory(directory);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

function readJson(path, label) {
	plainFile(path);
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`${label}_invalid`);
	}
}

function readAttemptReceipts(migrationRoot) {
	const attemptsPath = join(migrationRoot, "attempts");
	let entries;
	try {
		const stat = lstatSync(attemptsPath);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("attempts_unsafe");
		}
		entries = readdirSync(attemptsPath).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	if (entries.length > 50_000) throw new Error("attempts_unbounded");
	return entries.sort().map((name) => {
		const path = join(attemptsPath, name);
		plainFile(path, 64 * 1024);
		return readJson(path, "attempt_receipt");
	});
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function repairCommand({ reconcileBin, approvedPath, stateRoot, homeId }) {
	return `node ${shellQuote(reconcileBin)} --approved-homes ${shellQuote(approvedPath)} --state-root ${shellQuote(stateRoot)} --source manual --home-id ${homeId}`;
}

function alertOverdueHomes({
	migrationRoot,
	now,
	alertBin,
	reconcileBin,
	approvedPath,
	stateRoot,
	env,
}) {
	const statuses = evaluateCodexHomeMigrationDeadlines(
		readJson(join(migrationRoot, "state.json"), "migration_state"),
		readAttemptReceipts(migrationRoot),
		now,
	);
	const overdue = statuses.filter((status) => status.overdue);
	if (overdue.length === 0) return;
	const outstanding = statuses.filter((status) => !status.satisfied);
	const lines = outstanding.map((status) => {
		const last = status.lastAttemptAt
			? `${status.lastAttemptAt} ${status.lastResult}/${status.lastReason}`
			: "never attempted";
		return `- ${status.homeId}: pending=${status.pendingDays}d; last=${last}; repair=${repairCommand({ reconcileBin, approvedPath, stateRoot, homeId: status.homeId })}`;
	});
	const utcDay = now.toISOString().slice(0, 10).replaceAll("-", "");
	let failed = false;
	for (const status of overdue) {
		const result = spawnSync(
			alertBin,
			[
				"--lead",
				"flywheel-eng-lead",
				"--project",
				"flywheel",
				"--kind",
				"codex_home_migration_overdue",
				"--severity",
				"severe",
				"--title",
				"Codex credential home migration overdue",
				"--body",
				`FLY-2523 remains incomplete after ${status.overdueDays}d. Outstanding approved homes:\n${lines.join("\n")}`,
				"--signature",
				`${status.inventoryDigest}:${status.homeId}:${status.dueAt}:${utcDay}`,
				"--strict-delivery",
			],
			{ env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
		);
		process.stdout.write(result.stdout || "");
		process.stderr.write(result.stderr || "");
		const receipt = (result.stdout || "").trim().split("\n").at(-1) ?? "";
		if (
			result.error ||
			!(/^(sent|duplicate)(?: |$)/.test(receipt) ||
				(result.status === 2 && receipt === "queued_transient"))
		) {
			failed = true;
		}
	}
	if (failed) throw new Error("overdue_alert_delivery_failed");
}

function loadPolicy(path) {
	const value = readJson(path, "policy");
	if (
		value?.schemaVersion !== 1 ||
		value.enabled !== true ||
		!Number.isInteger(value.overdueDays) ||
		value.overdueDays < 1 ||
		value.overdueDays > 30 ||
		!Array.isArray(value.runnerHomes) ||
		value.runnerHomes.length === 0
	)
		throw new Error("policy_invalid");
	for (const entry of value.runnerHomes) {
		if (
			typeof entry?.id !== "string" ||
			typeof entry.project !== "string" ||
			typeof entry.role !== "string" ||
			typeof entry.relativeHome !== "string" ||
			(entry.pendingAt !== undefined &&
				new Date(entry.pendingAt).toISOString() !== entry.pendingAt)
		)
			throw new Error("policy_invalid");
	}
	return value;
}

function resolveAuthority(authorityBin, target, env) {
	const result = spawnSync(
		authorityBin,
		["--project", target.projectName, "--lead", target.leadId, "--authority"],
		{ env, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
	);
	if (result.status !== 0 || result.error) throw new Error("authority_failed");
	const parsed = JSON.parse(result.stdout);
	if (typeof parsed?.codexHome !== "string")
		throw new Error("authority_home_missing");
	return { codexHome: parsed.codexHome };
}

const args = parseArgs(process.argv.slice(2));
const userHome = process.env.HOME?.trim();
if (!userHome || !isAbsolute(userHome) || resolve(userHome) !== userHome)
	fail("home_invalid", 2);
const stateRoot = join(userHome, ".flywheel");
const projectsPath =
	process.env.FLYWHEEL_CODEX_PROJECTS_FILE?.trim() ||
	join(stateRoot, "projects.json");
const policyPath =
	process.env.FLYWHEEL_CODEX_HOME_POLICY?.trim() ||
	join(root, "scripts/config/codex-quota-home-policy.json");
const approvedPath =
	process.env.FLYWHEEL_CODEX_APPROVED_HOMES?.trim() ||
	join(stateRoot, "codex-quota/approved-homes.json");
const authorityBin =
	process.env.FLYWHEEL_CODEX_LEAD_AUTHORITY_BIN?.trim() ||
	join(root, "scripts/resident-codex-lead-recover.sh");
const reconcileBin =
	process.env.FLYWHEEL_CODEX_RECONCILE_BIN?.trim() ||
	join(root, "scripts/codex-home-reconcile.mjs");
const alertBin =
	process.env.FLYWHEEL_CODEX_ALERT_BIN?.trim() ||
	join(root, "scripts/lead-alert.sh");
const processManagerBin =
	process.env.FLYWHEEL_CODEX_RECONCILE_PROCESS_BIN?.trim() ||
	join(root, "scripts/lib/codex-home-reconcile-process.mjs");
for (const path of [
	projectsPath,
	policyPath,
	approvedPath,
	authorityBin,
	reconcileBin,
	alertBin,
	processManagerBin,
])
	if (!isAbsolute(path) || resolve(path) !== path) fail("path_invalid", 2);

ensureDirectory(stateRoot);
const quotaRoot = join(stateRoot, "codex-quota");
ensureDirectory(quotaRoot);
const migrationRoot = join(quotaRoot, "home-migration");
ensureDirectory(migrationRoot);
const lockPath = join(migrationRoot, "cycle.lock");
let ran = false;
try {
	await withMkdirLock(
		lockPath,
		async () => {
			const nowMs = process.env.FLYWHEEL_CODEX_RECONCILE_NOW_MS
				? Number(process.env.FLYWHEEL_CODEX_RECONCILE_NOW_MS)
				: Date.now();
			if (!Number.isFinite(nowMs)) throw new Error("now_invalid");
			const schedulePath = join(migrationRoot, "schedule.json");
			let previous;
			try {
				previous = readJson(schedulePath, "schedule");
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
			if (previous !== undefined) {
				if (
					previous?.schemaVersion !== 1 ||
					!Number.isFinite(Date.parse(previous.lastAttemptStartedAt)) ||
					!SOURCES.has(previous.source)
				)
					throw new Error("schedule_invalid");
				if (
					args.source === "health" &&
					nowMs < Date.parse(previous.lastAttemptStartedAt) + 3_600_000
				) {
					process.stdout.write(
						"CODEX_HOME_RECONCILE_CYCLE skipped reason=not_due\n",
					);
					return;
				}
			}
			atomicJson(schedulePath, {
				schemaVersion: 1,
				lastAttemptStartedAt: new Date(nowMs).toISOString(),
				source: args.source,
			});
			const policy = loadPolicy(policyPath);
			const projects = parseAndValidateProjects(
				readJson(projectsPath, "projects"),
			);
			const homes = await resolveCodexCredentialHomeRoster(projects, {
				homeDir: userHome,
				runnerHomes: policy.runnerHomes,
				resolveLeadAuthority: (target) =>
					resolveAuthority(authorityBin, target, process.env),
			});
			atomicJson(approvedPath, homes);
			let buildSha = process.env.FLYWHEEL_BUILD_SHA?.trim();
			if (!buildSha) {
				const deployed = join(stateRoot, "deployed-sha");
				plainFile(deployed, 256);
				buildSha = readFileSync(deployed, "utf8").trim();
			}
			if (!SHA40.test(buildSha)) throw new Error("build_sha_invalid");
			const childArgs = [
				"--approved-homes",
				approvedPath,
				"--state-root",
				stateRoot,
				"--source",
				args.source,
				"--overdue-days",
				String(policy.overdueDays),
			];
			if (args.homeId) childArgs.push("--home-id", args.homeId);
			const result = spawnSync(processManagerBin, [
				"--fence",
				join(migrationRoot, "reconcile-process-fence"),
				"--timeout-ms",
				"25000",
				"--kill-grace-ms",
				"1000",
				"--proof-ms",
				"4000",
				"--",
				reconcileBin,
				...childArgs,
			], {
				env: { ...process.env, FLYWHEEL_BUILD_SHA: buildSha },
				encoding: "utf8",
				timeout: 32_000,
				maxBuffer: 4 * 1024 * 1024,
			});
			process.stdout.write(result.stdout || "");
			process.stderr.write(result.stderr || "");
			const reconcileFailed = result.status !== 0 || result.error;
			alertOverdueHomes({
				migrationRoot,
				now: new Date(nowMs),
				alertBin,
				reconcileBin,
				approvedPath,
				stateRoot,
				env: process.env,
			});
			if (result.status === 75) {
				throw new CycleError("reconcile_exit_unproven", 75);
			}
			if (reconcileFailed) throw new Error("reconcile_failed");
			ran = true;
		},
		{ timeoutMs: 0, bare: true },
	);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	if (message === `withMkdirLock: timeout acquiring ${lockPath}`) {
		process.stdout.write(
			"CODEX_HOME_RECONCILE_CYCLE skipped reason=lock_busy\n",
		);
		process.exit(0);
	}
	fail(
		message.replace(/[\r\n]/g, " "),
		error instanceof CycleError ? error.exitCode : 1,
	);
}
if (ran) process.stdout.write("CODEX_HOME_RECONCILE_CYCLE done\n");
