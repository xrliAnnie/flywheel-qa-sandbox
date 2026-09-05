#!/usr/bin/env node

import { lstatSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MailboxQueue } from "../packages/flywheel-comm/dist/mailbox-queue.js";
import {
	archiveTerminalRows,
	installTerminalRowArchiveSchema,
	restoreTerminalRow,
} from "../packages/teamlead/dist/terminal-row-archive.js";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const require = createRequire(join(repoRoot, "packages/teamlead/package.json"));
const Database = require("better-sqlite3");
const TEAMLEAD_TABLES = ["session_events", "workflow_run_event", "lead_events"];

function databasePath(value, label) {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`${label} is required`);
	const path = resolve(value);
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink())
		throw new Error(`${label} must be a regular non-symlink file`);
	return path;
}

function count(db, table) {
	if (
		!db
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
			.get(table)
	)
		return 0;
	return Number(db.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n);
}

function inspect(path, hotTables, coldTable) {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		return {
			bytes: statSync(path).size,
			pageCount: Number(db.pragma("page_count", { simple: true })),
			freelistCount: Number(db.pragma("freelist_count", { simple: true })),
			quickCheck: String(db.pragma("quick_check", { simple: true })),
			hot: Object.fromEntries(
				hotTables.map((table) => [table, count(db, table)]),
			),
			cold: { [coldTable]: count(db, coldTable) },
		};
	} finally {
		db.close();
	}
}

export function executeFly2341Inventory(input) {
	const teamleadDbPath = databasePath(input?.teamleadDbPath, "teamlead-db");
	const commDbPath = databasePath(input?.commDbPath, "comm-db");
	return {
		teamlead: inspect(
			teamleadDbPath,
			TEAMLEAD_TABLES,
			"workflow_terminal_archive",
		),
		comm: inspect(
			commDbPath,
			["mailbox", "mailbox_identity", "mailbox_log"],
			"mailbox_terminal_archive",
		),
	};
}

function immediate() {
	return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

export async function executeFly2341Archive(input) {
	const teamleadDbPath = databasePath(input?.teamleadDbPath, "teamlead-db");
	const commDbPath = databasePath(input?.commDbPath, "comm-db");
	if (!Number.isFinite(Date.parse(input?.now)))
		throw new Error("now must be an ISO timestamp");
	const teamlead = new Database(teamleadDbPath);
	const comm = new Database(commDbPath);
	const queue = new MailboxQueue(comm);
	const archived = { teamlead: 0, commFamilies: 0, commIdentities: 0 };
	const commIdentityFailures = new Map();
	let batches = 0;
	let maxBatchDurationMs = 0;
	let consecutiveEmptyPasses = 0;
	try {
		installTerminalRowArchiveSchema(teamlead);
		for (;;) {
			const activeComm = comm
				.prepare(
					"SELECT execution_id,issue_id FROM sessions WHERE status='running'",
				)
				.all();
			let moved = 0;
			for (const sourceTable of TEAMLEAD_TABLES) {
				const started = performance.now();
				const result = archiveTerminalRows(teamlead, {
					now: input.now,
					limit: 100,
					sourceTable,
					activeExecutionIds: activeComm.map((row) => row.execution_id),
					activeIssueIds: activeComm.map((row) => row.issue_id),
				});
				maxBatchDurationMs = Math.max(
					maxBatchDurationMs,
					performance.now() - started,
				);
				archived.teamlead += result.archived;
				moved += result.archived;
				batches++;
				await immediate();
			}
			const started = performance.now();
			const families = queue.archiveDueFamilies({
				now: input.now,
				maxFamilies: 5,
			});
			const failuresBefore = commIdentityFailures.size;
			const identities = queue.compactArchivedIdentities({
				now: input.now,
				limit: 25,
				onIdentityError: (id, error) =>
					commIdentityFailures.set(
						id,
						error instanceof Error ? error.message : String(error),
					),
			});
			maxBatchDurationMs = Math.max(
				maxBatchDurationMs,
				performance.now() - started,
			);
			archived.commFamilies += families.archivedMessages;
			archived.commIdentities += identities;
			moved +=
				families.archivedMessages +
				identities +
				(commIdentityFailures.size - failuresBefore);
			batches++;
			consecutiveEmptyPasses = moved === 0 ? consecutiveEmptyPasses + 1 : 0;
			if (consecutiveEmptyPasses === 2) break;
			await immediate();
		}
		return {
			archived,
			commIdentityFailures: [...commIdentityFailures]
				.map(([id, error]) => ({ id, error }))
				.sort((left, right) => left.id.localeCompare(right.id)),
			batches,
			maxBatchDurationMs: Math.ceil(maxBatchDurationMs),
		};
	} finally {
		queue.close();
		comm.close();
		teamlead.close();
	}
}

export function executeFly2341Restore(input) {
	const dbPath = databasePath(input?.dbPath, "db");
	if (input?.dbKind === "comm") {
		const queue = new MailboxQueue(dbPath);
		try {
			return { outcome: queue.restoreTerminalIdentity(input.key) };
		} finally {
			queue.close();
		}
	}
	if (input?.dbKind !== "teamlead")
		throw new Error("db-kind must be teamlead or comm");
	const separator = String(input.key ?? "").indexOf(":");
	const sourceTable = String(input.key ?? "").slice(0, separator);
	const sourceIdentity = String(input.key ?? "").slice(separator + 1);
	if (
		!TEAMLEAD_TABLES.includes(sourceTable) ||
		separator < 1 ||
		!sourceIdentity
	)
		throw new Error("teamlead key must be <source-table>:<source-identity>");
	const db = new Database(dbPath);
	try {
		installTerminalRowArchiveSchema(db);
		return restoreTerminalRow(db, { sourceTable, sourceIdentity });
	} finally {
		db.close();
	}
}

export function executeFly2341Vacuum(input) {
	const dbPath = databasePath(input?.dbPath, "db");
	const before = statSync(dbPath).size;
	const db = new Database(dbPath);
	try {
		db.exec("VACUUM");
	} finally {
		db.close();
	}
	return { beforeBytes: before, afterBytes: statSync(dbPath).size };
}

export function parseFly2341Args(argv) {
	const command = argv[0];
	if (!new Set(["inventory", "archive", "restore", "vacuum"]).has(command))
		throw new Error("command must be inventory, archive, restore, or vacuum");
	const allowed = {
		inventory: new Set(["--teamlead-db", "--comm-db"]),
		archive: new Set(["--teamlead-db", "--comm-db", "--now"]),
		restore: new Set(["--db-kind", "--db", "--key"]),
		vacuum: new Set(["--db"]),
	}[command];
	const values = {};
	for (let index = 1; index < argv.length; index += 2) {
		const name = argv[index];
		if (!allowed.has(name)) throw new Error(`unknown argument: ${name}`);
		const value = argv[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`missing value: ${name}`);
		if (values[name] !== undefined)
			throw new Error(`duplicate argument: ${name}`);
		values[name] = value;
	}
	if (command === "inventory" || command === "archive") {
		if (!values["--teamlead-db"]) throw new Error("teamlead-db is required");
		if (!values["--comm-db"]) throw new Error("comm-db is required");
		if (command === "archive" && !values["--now"])
			throw new Error("now is required");
		return {
			command,
			teamleadDbPath: values["--teamlead-db"],
			commDbPath: values["--comm-db"],
			...(command === "archive" ? { now: values["--now"] } : {}),
		};
	}
	if (!values["--db"]) throw new Error("db is required");
	if (
		command === "restore" &&
		(!new Set(["teamlead", "comm"]).has(values["--db-kind"]) ||
			!values["--key"])
	)
		throw new Error("restore requires db-kind and key");
	return {
		command,
		dbPath: values["--db"],
		...(command === "restore"
			? { dbKind: values["--db-kind"], key: values["--key"] }
			: {}),
	};
}

async function main() {
	const args = parseFly2341Args(process.argv.slice(2));
	const result =
		args.command === "inventory"
			? executeFly2341Inventory(args)
			: args.command === "archive"
				? await executeFly2341Archive(args)
				: args.command === "restore"
					? executeFly2341Restore(args)
					: executeFly2341Vacuum(args);
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	main().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
