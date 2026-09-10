#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FLY2006_FOREIGN_KEY_BASELINE } from "./fly2396-retro-report.mjs";

const STRICT_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQL = resolve(
	SCRIPT_DIR,
	"../engineering/doc/FLY-2398-auto-merge-shadow-run/shadow-table.sql",
);
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1_000;
const REQUIRED_TABLES = Object.freeze([
	"auto_merge_shadow_declaration",
	"auto_merge_shadow_observation",
	"auto_narrow_decision_audit",
	"codex_review_record",
	"state_store_migration",
	"strength_two_evidence_record",
	"workflow_claims",
	"workflow_founder_gate_verdict",
	"workflow_gate_holder",
	"workflow_rework_request",
	"workflow_run",
	"workflow_run_node",
	"workflow_source_deadletter",
]);

export function normalizeShadowInstant(value) {
	if (
		typeof value !== "string" ||
		!STRICT_UTC_INSTANT.test(value) ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		throw new Error("window bounds must be canonical UTC milliseconds");
	}
	return value;
}

export function defaultShadowWindowStart(appliedAt) {
	const receipt = new Date(normalizeShadowInstant(appliedAt));
	return new Date(
		Date.UTC(
			receipt.getUTCFullYear(),
			receipt.getUTCMonth(),
			receipt.getUTCDate() + 1,
		),
	).toISOString();
}

export function parseFly2398ShadowArgs(argv) {
	const parsed = {
		db: join(homedir(), ".flywheel", "teamlead.db"),
		commDb: join(homedir(), ".flywheel", "comm", "flywheel", "comm.db"),
		sql: DEFAULT_SQL,
		sqlite: "sqlite3",
		format: "md",
		windowStart: undefined,
		windowEnd: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--help") return { ...parsed, help: true };
		if (
			flag !== "--db" &&
			flag !== "--comm-db" &&
			flag !== "--sql" &&
			flag !== "--sqlite" &&
			flag !== "--format" &&
			flag !== "--window-start" &&
			flag !== "--window-end"
		) {
			throw new Error(`unknown argument: ${flag}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`missing value: ${flag}`);
		}
		index += 1;
		if (flag === "--db") parsed.db = value;
		if (flag === "--comm-db") parsed.commDb = value;
		if (flag === "--sql") parsed.sql = value;
		if (flag === "--sqlite") parsed.sqlite = value;
		if (flag === "--format") {
			if (value !== "md" && value !== "json") {
				throw new Error("format must be md or json");
			}
			parsed.format = value;
		}
		if (flag === "--window-start") {
			parsed.windowStart = normalizeShadowInstant(value);
		}
		if (flag === "--window-end") {
			parsed.windowEnd = normalizeShadowInstant(value);
		}
	}
	return parsed;
}

function sqlLiteral(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function requireRegularFile(path, label) {
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`${label} file not found: ${path}`);
	}
	return realpathSync(path);
}

function openSqliteSession(sqlite, databaseUri) {
	const child = spawn(sqlite, ["-batch", databaseUri], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let cursor = 0;
	let sequence = 0;
	let wake = () => {};
	let exitError;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
		wake();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.on("error", (error) => {
		exitError = error;
		wake();
	});
	child.on("exit", (code, signal) => {
		if (code !== 0 || signal) {
			exitError = new Error(
				`sqlite session failed (${signal ?? code}): ${stderr.trim() || "no diagnostic"}`,
			);
		}
		wake();
	});

	const run = async (sql) => {
		const marker = `__FLY2398_END_${sequence++}__`;
		child.stdin.write(`${sql}\n.print ${marker}\n`);
		for (;;) {
			const markerAt = stdout.indexOf(`${marker}\n`, cursor);
			if (markerAt >= 0) {
				const block = stdout.slice(cursor, markerAt);
				cursor = markerAt + marker.length + 1;
				return block.replace(/\n$/, "").split("\n").filter(Boolean);
			}
			if (exitError) throw exitError;
			await new Promise((resolveWake) => {
				wake = resolveWake;
				if (stdout.indexOf(`${marker}\n`, cursor) >= 0 || exitError) {
					resolveWake();
				}
			});
			wake = () => {};
		}
	};
	const close = async () => {
		if (!child.killed && child.exitCode === null) child.stdin.end(".quit\n");
		await new Promise((resolveExit) => {
			if (child.exitCode !== null) return resolveExit();
			child.once("exit", resolveExit);
		});
		if (exitError) throw exitError;
	};
	return { run, close };
}

function sameStrings(left, right) {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

export async function runFly2398ShadowTable(options) {
	const progress = options.onProgress ?? (() => {});
	const now = options.now ?? (() => new Date().toISOString());
	const dbPath = requireRegularFile(options.db, "database");
	const commDbPath = requireRegularFile(
		options.commDb ?? options.db,
		"CommDB database",
	);
	const sqlPath = requireRegularFile(options.sql ?? DEFAULT_SQL, "report SQL");
	const sqlite = options.sqlite ?? "sqlite3";
	const scratch = mkdtempSync(join(tmpdir(), "fly2398-shadow-table-"));
	const snapshot = join(scratch, "teamlead-snapshot.db");
	const commSnapshot = join(scratch, "comm-snapshot.db");
	const snapshotStartedAt = normalizeShadowInstant(now());
	let commSnapshotStartedAt = snapshotStartedAt;
	let session;
	try {
		progress("creating WAL-safe online backup");
		const backup = spawnSync(
			sqlite,
			["-readonly", dbPath, `.backup ${sqlLiteral(snapshot)}`],
			{ encoding: "utf8" },
		);
		if (backup.error || backup.status !== 0) {
			throw new Error(
				`sqlite online backup failed: ${backup.error?.message ?? backup.stderr.trim()}`,
			);
		}
		commSnapshotStartedAt = normalizeShadowInstant(now());
		const commBackup = spawnSync(
			sqlite,
			["-readonly", commDbPath, `.backup ${sqlLiteral(commSnapshot)}`],
			{ encoding: "utf8" },
		);
		if (commBackup.error || commBackup.status !== 0) {
			throw new Error(
				`CommDB online backup failed: ${commBackup.error?.message ?? commBackup.stderr.trim()}`,
			);
		}
		progress("online backup complete; opening immutable snapshot");
		session = openSqliteSession(
			sqlite,
			`file:${encodeURI(snapshot)}?mode=ro&immutable=1`,
		);
		await session.run(".bail on\n.headers off\n.mode list");
		await session.run(
			`ATTACH DATABASE ${sqlLiteral(`file:${encodeURI(commSnapshot)}?mode=ro&immutable=1`)} AS comm;`,
		);
		const quickCheck = await session.run("PRAGMA quick_check;");
		if (quickCheck.length !== 1 || quickCheck[0] !== "ok") {
			throw new Error(`snapshot quick_check failed: ${quickCheck.join(" | ")}`);
		}
		const expectedForeignKeys = [
			...(options.expectedForeignKeyBaseline ?? FLY2006_FOREIGN_KEY_BASELINE),
		].sort();
		const observedForeignKeys = (
			await session.run("PRAGMA foreign_key_check;")
		).sort();
		if (!sameStrings(observedForeignKeys, expectedForeignKeys)) {
			throw new Error(
				`snapshot foreign_key_check baseline drift: expected [${expectedForeignKeys.join(", ")}], observed [${observedForeignKeys.join(", ")}]`,
			);
		}
		const schemaRows = await session.run(`
SELECT name FROM sqlite_master
WHERE type = 'table'
  AND name IN (${REQUIRED_TABLES.map(sqlLiteral).join(", ")})
ORDER BY name;`);
		if (!sameStrings(schemaRows, [...REQUIRED_TABLES].sort())) {
			const missing = REQUIRED_TABLES.filter(
				(name) => !schemaRows.includes(name),
			);
			throw new Error(
				`shadow report schema is incomplete: missing ${missing.join(", ")}`,
			);
		}
		const commSchemaRows = await session.run(`
SELECT name FROM comm.sqlite_master
WHERE type = 'table' AND name = 'workflow_source_event';`);
		if (!sameStrings(commSchemaRows, ["workflow_source_event"])) {
			throw new Error(
				"shadow report CommDB schema is incomplete: missing workflow_source_event",
			);
		}
		const receipts = await session.run(`
SELECT applied_at FROM state_store_migration
WHERE migration_id = 'fly-2398-shadow-observation-v1'
ORDER BY applied_at;`);
		if (receipts.length !== 1) {
			throw new Error(
				`shadow migration receipt count must be 1, observed ${receipts.length}`,
			);
		}
		const receipt = normalizeShadowInstant(receipts[0]);
		const windowStart = options.windowStart
			? normalizeShadowInstant(options.windowStart)
			: defaultShadowWindowStart(receipt);
		const windowEnd = options.windowEnd
			? normalizeShadowInstant(options.windowEnd)
			: new Date(Date.parse(windowStart) + TWO_WEEKS_MS).toISOString();
		if (windowStart < receipt) {
			throw new Error(
				"window start must not predate the shadow migration receipt",
			);
		}
		if (windowStart >= windowEnd) {
			throw new Error("window start must be earlier than window end");
		}
		const expectedWindowEnd = new Date(
			Date.parse(windowStart) + TWO_WEEKS_MS,
		).toISOString();
		if (windowEnd !== expectedWindowEnd) {
			throw new Error("window must be exactly 14 days");
		}
		if (normalizeShadowInstant(now()) < windowEnd) {
			throw new Error("window must be complete before reporting");
		}
		if (snapshotStartedAt < windowEnd) {
			throw new Error("snapshot must begin after the complete window");
		}
		const output = await session.run(`
.parameter init
.parameter set :window_start ${sqlLiteral(windowStart)}
.parameter set :window_end ${sqlLiteral(windowEnd)}
.read ${sqlLiteral(sqlPath)}`);
		const rows = output.map((line, index) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				throw new Error(
					`report SQL returned invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
		progress("report complete");
		return {
			windowStart,
			windowEnd,
			snapshotStartedAt,
			commSnapshotStartedAt,
			windowStartSource: options.windowStart
				? "explicit"
				: "receipt_next_utc_midnight",
			rows,
		};
	} finally {
		if (session) await session.close().catch(() => {});
		rmSync(scratch, { recursive: true, force: true });
	}
}

export function renderFly2398ShadowTable(report, format = "md") {
	if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
	const lines = [
		"# FLY-2398 auto-merge shadow table",
		"",
		`Window: \`${report.windowStart}\` to \`${report.windowEnd}\` (end exclusive; start source: ${report.windowStartSource})`,
		`Snapshot started: \`${report.snapshotStartedAt}\``,
		`CommDB snapshot started: \`${report.commSnapshotStartedAt}\``,
		"",
		"| Kind | Name | Result | Detail |",
		"| --- | --- | ---: | --- |",
	];
	for (const row of report.rows) {
		const result =
			row.numerator === null || row.denominator === null
				? "n/a"
				: `${row.numerator} / ${row.denominator}${row.denominator === 0 ? " (no population)" : ""}`;
		const detail = String(row.detail ?? "")
			.replaceAll("|", "\\|")
			.replaceAll("\n", " ");
		lines.push(`| ${row.kind} | ${row.name} | ${result} | ${detail} |`);
	}
	return `${lines.join("\n")}\n`;
}

function usage() {
	return `Usage: node scripts/fly-2398-shadow-table.mjs [options]

Options:
  --db <path>                 source teamlead.db (default: ~/.flywheel/teamlead.db)
  --comm-db <path>            source CommDB (default: ~/.flywheel/comm/flywheel/comm.db)
  --window-start <ISO>        configurable UTC start (default: first UTC midnight after receipt)
  --window-end <ISO>          exclusive UTC end (default: start + 14 days)
  --sql <path>                report SQL override (tests only)
  --sqlite <binary>           sqlite3 binary override (tests only)
  --format <md|json>          output format (default: md)`;
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const args = parseFly2398ShadowArgs(process.argv.slice(2));
		if (args.help) {
			process.stdout.write(`${usage()}\n`);
		} else {
			const report = await runFly2398ShadowTable({
				...args,
				onProgress: (message) =>
					process.stderr.write(`fly-2398-shadow-table: ${message}\n`),
			});
			process.stdout.write(renderFly2398ShadowTable(report, args.format));
		}
	} catch (error) {
		process.stderr.write(
			`fly-2398-shadow-table: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
