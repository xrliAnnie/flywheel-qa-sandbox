#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	executeFly2006Apply,
	executeFly2006Inventory,
	executeFly2006Vacuum,
} from "./lib/fly-2006-retention-engine.mjs";
import { writeSealedJson } from "./lib/fly-2006-retention-evidence.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const packageRequire = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = packageRequire("better-sqlite3");

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildIsolatedRehearsalAudit() {
	return {
		source: "isolated-rehearsal",
		purposeDigest: createHash("sha256")
			.update("FLY-2006 isolated rehearsal; not production authority")
			.digest("hex"),
	};
}

function parseArgs(argv) {
	const required = new Set(["--teamlead-db", "--comm-db", "--rehearsal-dir"]);
	const args = {};
	for (let index = 0; index < argv.length; index += 1) {
		const key = argv[index];
		if (!required.has(key) || index + 1 >= argv.length)
			throw new Error(`invalid_argument:${key}`);
		if (args[key]) throw new Error(`duplicate_argument:${key}`);
		args[key] = argv[++index];
	}
	for (const key of required) {
		if (!args[key]) throw new Error(`missing_argument:${key}`);
	}
	return args;
}

function criticalCounts(db) {
	const result = {};
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all()
		.map((row) => String(row.name));
	for (const table of ["session_events", "mailbox", "mailbox_log"]) {
		if (!tables.includes(table)) continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
			throw new Error("backup_count_identifier_invalid");
		result[table] = Number(
			db.prepare(`SELECT count(*) AS count FROM "${table}"`).get().count,
		);
	}
	return { tableCount: tables.length, critical: result };
}

async function backupAndVerify(sourcePath, backupPath) {
	const source = new Database(sourcePath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		source.pragma("query_only=ON");
		const sourceQuickCheck = source.pragma("quick_check", { simple: true });
		if (sourceQuickCheck !== "ok") throw new Error("source_quick_check_failed");
		const sourceCounts = criticalCounts(source);
		await source.backup(backupPath);
		chmodSync(backupPath, 0o600);
		const backup = new Database(backupPath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			const backupQuickCheck = backup.pragma("quick_check", { simple: true });
			if (backupQuickCheck !== "ok")
				throw new Error("backup_quick_check_failed");
			return {
				sourcePath: realpathSync(sourcePath),
				backupPath: realpathSync(backupPath),
				sourceQuickCheck,
				backupQuickCheck,
				sourceCounts,
				backupCounts: criticalCounts(backup),
			};
		} finally {
			backup.close();
		}
	} finally {
		source.close();
	}
}

export async function executeFly2006Rehearsal(input) {
	if (existsSync(input.rehearsalDir))
		throw new Error("rehearsal_dir_already_exists");
	mkdirSync(input.rehearsalDir, { mode: 0o700 });
	const copiesDir = join(input.rehearsalDir, "copies");
	const evidenceDir = join(input.rehearsalDir, "evidence");
	mkdirSync(copiesDir, { mode: 0o700 });
	const teamleadDbPath = join(copiesDir, "teamlead.db");
	const commDbPath = join(copiesDir, "comm.db");
	const backups = {
		teamlead: await backupAndVerify(input.teamleadDbPath, teamleadDbPath),
		comm: await backupAndVerify(input.commDbPath, commDbPath),
	};
	const inventory = await executeFly2006Inventory({
		teamleadDbPath,
		commDbPath,
		evidenceDir,
		allowFixturePaths: true,
	});
	const manifestSha256 = sha256File(inventory.manifestPath);
	const applied = await executeFly2006Apply({
		manifestPath: inventory.manifestPath,
		allowFixturePaths: true,
		founderGateAudit: buildIsolatedRehearsalAudit(),
	});
	for (const [key, target] of Object.entries(inventory.manifest.targets)) {
		if (applied.deleted[key] !== target.candidateCount)
			throw new Error(`rehearsal_count_mismatch:${key}`);
		if (target.candidateCount > 0 && !target.restoreVerified)
			throw new Error(`rehearsal_restore_not_verified:${key}`);
	}
	const bindingSummaryPath = join(evidenceDir, "rehearsal-binding.json");
	writeSealedJson(bindingSummaryPath, {
		issue: "FLY-2006",
		status: "complete",
		purpose: "fixture-only vacuum binding; final timings are sealed separately",
		vacuumDurationsMs: { teamlead: 0, comm: 0 },
	});
	const bindingSha256 = sha256File(bindingSummaryPath);
	const vacuums = {};
	for (const database of ["teamlead", "comm"]) {
		const ackPath = join(evidenceDir, `${database}-rehearsal-quiescence.json`);
		writeSealedJson(ackPath, {
			issue: "FLY-2006",
			database,
			manifestSha256,
			rehearsalSummarySha256: bindingSha256,
			maxDurationMs: 300_000,
			token: randomBytes(32).toString("hex"),
			acknowledgedAt: new Date().toISOString(),
		});
		vacuums[database] = await executeFly2006Vacuum({
			manifestPath: inventory.manifestPath,
			database,
			quiescenceAckPath: ackPath,
			rehearsalSummaryPath: bindingSummaryPath,
			maxDurationMs: 300_000,
			allowFixturePaths: true,
		});
		if (vacuums[database].after.mainBytes >= vacuums[database].before.mainBytes)
			throw new Error(`rehearsal_file_not_smaller:${database}`);
	}
	const receiptFiles = readdirSync(join(evidenceDir, "receipts")).filter(
		(name) => name.endsWith(".json"),
	);
	const sessionReceiptCount = receiptFiles.filter((name) =>
		name.startsWith("sessionEvents-"),
	).length;
	if (sessionReceiptCount > 120)
		throw new Error("session_event_receipt_ceiling_exceeded");
	const summary = {
		issue: "FLY-2006",
		status: "complete",
		manifestPath: realpathSync(inventory.manifestPath),
		manifestSha256,
		backups,
		targetCounts: Object.fromEntries(
			Object.entries(inventory.manifest.targets).map(([key, target]) => [
				key,
				target.candidateCount,
			]),
		),
		deleted: applied.deleted,
		restoreVerifiedTargets: Object.values(inventory.manifest.targets).filter(
			(target) => target.candidateCount > 0 && target.restoreVerified,
		).length,
		receipts: {
			total: receiptFiles.length,
			sessionEvents: sessionReceiptCount,
		},
		vacuumDurationsMs: {
			teamlead: vacuums.teamlead.durationMs,
			comm: vacuums.comm.durationMs,
		},
		vacuumBytes: {
			teamlead: {
				before: vacuums.teamlead.before.mainBytes,
				after: vacuums.teamlead.after.mainBytes,
			},
			comm: {
				before: vacuums.comm.before.mainBytes,
				after: vacuums.comm.after.mainBytes,
			},
		},
		completedAt: new Date().toISOString(),
	};
	const summaryPath = join(input.rehearsalDir, "rehearsal-summary.json");
	writeSealedJson(summaryPath, summary);
	return { ...summary, summaryPath };
}

async function runCli() {
	try {
		const args = parseArgs(process.argv.slice(2));
		const result = await executeFly2006Rehearsal({
			teamleadDbPath: args["--teamlead-db"],
			commDbPath: args["--comm-db"],
			rehearsalDir: args["--rehearsal-dir"],
		});
		process.stdout.write(
			`${JSON.stringify({
				status: result.status,
				summaryPath: result.summaryPath,
				manifestSha256: result.manifestSha256,
				targetCounts: result.targetCounts,
				vacuumDurationsMs: result.vacuumDurationsMs,
				vacuumBytes: result.vacuumBytes,
				receipts: result.receipts,
			})}\n`,
		);
	} catch (error) {
		process.stderr.write(
			`fly2006_rehearsal_error: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await runCli();
