#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { withManagedSnapshots } from "./flywheel-snapshot-control.mjs";

const STRICT_UTC_INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQL = resolve(
	SCRIPT_DIR,
	"../engineering/doc/FLY-2396-founder-gate-head-origin/retro-bind.sql",
);
const DEFAULT_ATTESTATION = resolve(
	SCRIPT_DIR,
	"../engineering/doc/FLY-2396-founder-gate-head-origin/legacy-attestation.json",
);
export const FLY2006_FOREIGN_KEY_BASELINE = Object.freeze(
	[
		"workflow_submission_credential|68|workflow_execution_binding|2",
		"workflow_submission_credential|69|workflow_execution_binding|2",
		"workflow_submission_credential|70|workflow_execution_binding|2",
		"workflow_submission_credential|71|workflow_execution_binding|2",
		"workflow_submission_credential|136|workflow_execution_binding|2",
		"workflow_submission_credential|137|workflow_execution_binding|2",
		"workflow_submission_credential|139|workflow_execution_binding|2",
	].sort(),
);

export function normalizeLegacyCutoff(value) {
	if (!STRICT_UTC_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
		throw new Error("cutoff must be a strict UTC ISO instant");
	}
	return new Date(value).toISOString();
}

export function parseFly2396RetroArgs(argv) {
	const parsed = {
		db: join(homedir(), ".flywheel", "teamlead.db"),
		sql: DEFAULT_SQL,
		attestation: DEFAULT_ATTESTATION,
		sqlite: "sqlite3",
		preDeployCutoff: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--help") return { ...parsed, help: true };
		if (
			flag !== "--db" &&
			flag !== "--sql" &&
			flag !== "--attestation" &&
			flag !== "--sqlite" &&
			flag !== "--pre-deploy-cutoff"
		) {
			throw new Error(`unknown argument: ${flag}`);
		}
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`missing value: ${flag}`);
		}
		index += 1;
		if (flag === "--db") parsed.db = value;
		if (flag === "--sql") parsed.sql = value;
		if (flag === "--attestation") parsed.attestation = value;
		if (flag === "--sqlite") parsed.sqlite = value;
		if (flag === "--pre-deploy-cutoff") {
			parsed.preDeployCutoff = normalizeLegacyCutoff(value);
		}
	}
	return parsed;
}

function sqlLiteral(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function loadAttestations(path) {
	const document = JSON.parse(readFileSync(path, "utf8"));
	if (!document || !Array.isArray(document.rows)) {
		throw new Error("legacy attestation must contain a rows array");
	}
	return document.rows.map((row, index) => {
		if (
			!row ||
			typeof row.run_id_prefix !== "string" ||
			!/^[0-9a-f]{8}$/.test(row.run_id_prefix) ||
			typeof row.requested_at !== "string" ||
			normalizeLegacyCutoff(row.requested_at) !== row.requested_at ||
			(row.founder_authored !== 0 && row.founder_authored !== 1) ||
			typeof row.attested_by !== "string" ||
			!row.attested_by.trim()
		) {
			throw new Error(`invalid legacy attestation row ${index + 1}`);
		}
		return {
			ordinal: index + 1,
			runIdPrefix: row.run_id_prefix,
			requestedAt: row.requested_at,
			founderAuthored: row.founder_authored,
			attestedBy: row.attested_by,
		};
	});
}

function attestationSql(rows) {
	const inserts = rows
		.map(
			(row) =>
				`(${row.ordinal}, ${sqlLiteral(row.runIdPrefix)}, ${sqlLiteral(row.requestedAt)}, ${row.founderAuthored}, ${sqlLiteral(row.attestedBy)})`,
		)
		.join(",\n");
	return `
DROP TABLE IF EXISTS temp.legacy_attestation;
CREATE TEMP TABLE legacy_attestation (
  ordinal INTEGER PRIMARY KEY,
  run_id_prefix TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  founder_authored INTEGER NOT NULL CHECK (founder_authored IN (0, 1)),
  attested_by TEXT NOT NULL
);
INSERT INTO legacy_attestation
  (ordinal, run_id_prefix, requested_at, founder_authored, attested_by)
VALUES
${inserts};`;
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
		const marker = `__FLY2396_END_${sequence++}__`;
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
				// Close the check/register race: SQLite may have emitted the marker
				// after the loop check but immediately before this waiter was installed.
				if (stdout.indexOf(`${marker}\n`, cursor) >= 0 || exitError) {
					resolveWake();
				}
			});
			wake = () => {};
		}
	};
	const close = async () => {
		if (!child.killed) child.stdin.end(".quit\n");
		await new Promise((resolveExit) => {
			if (child.exitCode !== null) return resolveExit();
			child.once("exit", resolveExit);
		});
		if (exitError) throw exitError;
	};
	return { run, close };
}

function requireRegularFile(path, label) {
	if (!existsSync(path) || !statSync(path).isFile()) {
		throw new Error(`${label} file not found: ${path}`);
	}
	return realpathSync(path);
}

export async function runFly2396RetroReport(options) {
	const progress = options.onProgress ?? (() => {});
	const snapshot = requireRegularFile(options.snapshot, "managed snapshot");
	const sqlPath = requireRegularFile(options.sql ?? DEFAULT_SQL, "report SQL");
	const attestationPath = requireRegularFile(
		options.attestation ?? DEFAULT_ATTESTATION,
		"attestation",
	);
	const sqlite = options.sqlite ?? "sqlite3";
	let session;
	try {
		progress("opening managed immutable snapshot");
		session = openSqliteSession(
			sqlite,
			`file:${encodeURI(snapshot)}?mode=ro&immutable=1`,
		);
		await session.run(".bail on\n.headers off\n.mode list\n.separator |");
		const quickCheck = await session.run("PRAGMA quick_check;");
		if (quickCheck.length !== 1 || quickCheck[0] !== "ok") {
			throw new Error(`snapshot quick_check failed: ${quickCheck.join(" | ")}`);
		}
		progress("quick_check passed; checking registered foreign-key baseline");
		const foreignKeys = await session.run("PRAGMA foreign_key_check;");
		const expectedForeignKeys = [
			...(options.expectedForeignKeyBaseline ?? FLY2006_FOREIGN_KEY_BASELINE),
		].sort();
		const observedForeignKeys = [...foreignKeys].sort();
		if (
			observedForeignKeys.length !== expectedForeignKeys.length ||
			observedForeignKeys.some(
				(fingerprint, index) => fingerprint !== expectedForeignKeys[index],
			)
		) {
			throw new Error(
				`snapshot foreign_key_check baseline drift: expected [${expectedForeignKeys.join(", ")}], observed [${observedForeignKeys.join(", ")}]`,
			);
		}
		progress("foreign-key baseline matched; resolving deployment cutoff");
		const schema = await session.run(`
SELECT
  (SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table' AND name = 'workflow_founder_gate_verdict') || '|' ||
  (SELECT COUNT(*) FROM state_store_migration
    WHERE migration_id = 'fly-2396-founder-gate-verdict-v1') || '|' ||
  COALESCE((SELECT applied_at FROM state_store_migration
    WHERE migration_id = 'fly-2396-founder-gate-verdict-v1'), '');`);
		if (schema.length !== 1) throw new Error("schema mode query was ambiguous");
		const [tableCount, receiptCount, receiptCutoff] = schema[0].split("|");
		let cutoff;
		let banner;
		if (tableCount === "1" && receiptCount === "1") {
			if (options.preDeployCutoff) {
				throw new Error("pre-deploy cutoff is forbidden after deployment");
			}
			cutoff = normalizeLegacyCutoff(receiptCutoff);
			banner = `DEPLOYED EVIDENCE (cutoff=${cutoff})`;
		} else if (tableCount === "0" && receiptCount === "0") {
			if (!options.preDeployCutoff) {
				throw new Error(
					"pre-deploy schema requires --pre-deploy-cutoff <UTC ISO instant>",
				);
			}
			cutoff = normalizeLegacyCutoff(options.preDeployCutoff);
			banner = `PRE-DEPLOY EVIDENCE (cutoff=${cutoff})`;
			await session.run(
				"CREATE TEMP TABLE workflow_founder_gate_verdict (claim_id INTEGER, rework_request_id TEXT);",
			);
		} else {
			throw new Error(
				`incomplete deployment schema: table=${tableCount}, receipt=${receiptCount}`,
			);
		}
		await session.run(attestationSql(loadAttestations(attestationPath)));
		progress("running bound-head and authorship report");
		const report = await session.run(`
.parameter init
.parameter set :legacy_cutoff ${sqlLiteral(cutoff)}
.read ${sqlLiteral(sqlPath)}`);
		progress("report complete");
		return `${banner}\nFOREIGN KEY BASELINE: ${observedForeignKeys.length} FLY-2006 registered / 0 outside baseline\n${report.join("\n")}\n`;
	} finally {
		if (session) await session.close().catch(() => {});
	}
}

function usage() {
	return `Usage: node scripts/fly2396-retro-report.mjs [options]

Options:
  --db <path>                 source teamlead.db (default: ~/.flywheel/teamlead.db)
  --pre-deploy-cutoff <ISO>   required only when table and receipt are both absent
  --sql <path>                report SQL override (tests only)
  --attestation <path>        attestation JSON override (tests only)
  --sqlite <binary>           sqlite3 binary override (tests only)`;
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const args = parseFly2396RetroArgs(process.argv.slice(2));
		if (args.help) {
			process.stdout.write(`${usage()}\n`);
		} else {
			process.stdout.write(
				await withManagedSnapshots(
					{
						label: "fly2396-retro-report",
						sources: [{ name: "teamlead", source: args.db, kind: "teamlead" }],
					},
					({ paths }) =>
						runFly2396RetroReport({
							...args,
							snapshot: paths.teamlead,
							onProgress: (message) =>
								process.stderr.write(`fly2396-retro-report: ${message}\n`),
						}),
				),
			);
		}
	} catch (error) {
		process.stderr.write(
			`fly2396-retro-report: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}
