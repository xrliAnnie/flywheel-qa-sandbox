import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);
const script = join(
	repoRoot,
	"scripts",
	"fly-1995-session-events-residue-surgery.mjs",
);
const roots: string[] = [];

const COHORT_PREDICATE =
	"event_type = 'issue_thread_infra_notify_skipped' AND source = 'bridge.founder-thread-notifier' AND ts >= '2026-08-01 22:00:00' AND ts < '2026-08-05 04:00:00'";

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture(label: string): { root: string; dbPath: string } {
	const root = mkdtempSync(join(tmpdir(), `fly1995-surgery-${label}-`));
	roots.push(root);
	const dbPath = join(root, "teamlead.db");
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("wal_autocheckpoint = 0");
	db.exec(`
		CREATE TABLE session_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT UNIQUE NOT NULL,
			ts TEXT NOT NULL,
			execution_id TEXT NOT NULL,
			issue_id TEXT NOT NULL,
			project_name TEXT NOT NULL,
			event_type TEXT NOT NULL,
			severity TEXT NOT NULL DEFAULT 'info',
			payload JSON,
			source TEXT NOT NULL
		);
	`);
	const insert = db.prepare(`
		INSERT INTO session_events
			(event_id, ts, execution_id, issue_id, project_name, event_type, payload, source)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`);
	insert.run(
		"target-1",
		"2026-08-01 22:30:00",
		"exec-a",
		"FLY-1",
		"flywheel",
		"issue_thread_infra_notify_skipped",
		'{"reason":"no_chat_thread"}',
		"bridge.founder-thread-notifier",
	);
	insert.run(
		"target-2",
		"2026-08-05 03:59:59",
		"exec-b",
		"FLY-2",
		"geoforge3d",
		"issue_thread_infra_notify_skipped",
		'{"reason":"no_bot_token"}',
		"bridge.founder-thread-notifier",
	);
	insert.run(
		"decoy-time",
		"2026-08-05 04:00:00",
		"exec-a",
		"FLY-1",
		"flywheel",
		"issue_thread_infra_notify_skipped",
		"{}",
		"bridge.founder-thread-notifier",
	);
	insert.run(
		"decoy-source",
		"2026-08-02 00:00:00",
		"exec-a",
		"FLY-1",
		"flywheel",
		"issue_thread_infra_notify_skipped",
		"{}",
		"bridge.other",
	);
	db.close();
	return { root, dbPath };
}

function run(
	dbPath: string,
	outputDir: string,
	extra: string[] = [],
): Record<string, unknown> {
	return JSON.parse(
		execFileSync(
			"node",
			[script, "--db", dbPath, "--output-dir", outputDir, ...extra],
			{ cwd: repoRoot, encoding: "utf8" },
		),
	) as Record<string, unknown>;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sourceHashes(dbPath: string): Record<string, string> {
	return Object.fromEntries(
		[dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
			.filter(existsSync)
			.map((path) => [path, sha256(path)]),
	);
}

describe("FLY-1995 session_events residue surgery", () => {
	it("creates a consistent WAL-aware baseline snapshot and receipt without changing the source triplet", () => {
		const { root, dbPath } = fixture("dry-run");
		// Prime SQLite's read marks before taking the physical-byte baseline.
		const prime = new Database(dbPath, { readonly: true, fileMustExist: true });
		expect(
			prime
				.prepare(
					`SELECT count(*) AS n FROM session_events WHERE ${COHORT_PREDICATE}`,
				)
				.get(),
		).toEqual({ n: 2 });
		prime.close();
		const before = sourceHashes(dbPath);

		const result = run(dbPath, join(root, "evidence"));
		expect(result).toMatchObject({ mode: "dry-run", status: "baseline_ready" });
		const receiptPath = String(result.receiptPath);
		const snapshotPath = String(result.snapshotPath);
		expect(existsSync(receiptPath)).toBe(true);
		expect(existsSync(snapshotPath)).toBe(true);
		expect(sourceHashes(dbPath)).toEqual(before);

		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		expect(receipt).toMatchObject({
			issue: "FLY-1995",
			schema_version: 1,
			source_db_realpath: realpathSync(dbPath),
			predicate: COHORT_PREDICATE,
			cohort: {
				count: 2,
				min_id: 1,
				max_id: 2,
				min_ts: "2026-08-01 22:30:00",
				max_ts: "2026-08-05 03:59:59",
			},
		});
		expect(receipt.snapshot.sha256).toBe(sha256(snapshotPath));
		expect(receipt.breakdown).toEqual([
			{ execution_id: "exec-b", project_name: "geoforge3d", count: 1 },
			{ execution_id: "exec-a", project_name: "flywheel", count: 1 },
		]);
		const snapshot = new Database(snapshotPath, {
			readonly: true,
			fileMustExist: true,
		});
		expect(
			snapshot
				.prepare(
					`SELECT count(*) AS n FROM session_events WHERE ${COHORT_PREDICATE}`,
				)
				.get(),
		).toEqual({ n: 2 });
		snapshot.close();
	});

	it("requires a bound baseline, deletes only the exact cohort, verifies its backup, and replays only from an applied receipt", () => {
		const { root, dbPath } = fixture("apply");
		const evidence = join(root, "evidence");
		const baseline = run(dbPath, evidence);
		const receiptPath = String(baseline.receiptPath);

		const missingBaseline = spawnSync(
			"node",
			[script, "--db", dbPath, "--output-dir", evidence, "--apply"],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(missingBaseline.status).toBe(1);
		expect(missingBaseline.stderr).toContain("baseline_required");

		const applied = run(dbPath, evidence, [
			"--apply",
			"--baseline",
			receiptPath,
		]);
		expect(applied).toMatchObject({
			mode: "apply",
			status: "applied",
			deleted: 2,
		});
		const backupPath = String(applied.backupPath);
		expect(existsSync(backupPath)).toBe(true);
		const backup = new Database(backupPath, {
			readonly: true,
			fileMustExist: true,
		});
		expect(backup.pragma("quick_check", { simple: true })).toBe("ok");
		expect(
			backup
				.prepare(
					`SELECT count(*) AS n FROM session_events WHERE ${COHORT_PREDICATE}`,
				)
				.get(),
		).toEqual({ n: 2 });
		backup.close();

		const live = new Database(dbPath, { readonly: true, fileMustExist: true });
		expect(
			live.prepare("SELECT event_id FROM session_events ORDER BY id").all(),
		).toEqual([{ event_id: "decoy-time" }, { event_id: "decoy-source" }]);
		live.close();

		const replay = run(dbPath, evidence, [
			"--apply",
			"--baseline",
			receiptPath,
		]);
		expect(replay).toMatchObject({
			mode: "apply",
			status: "already_applied",
			deleted: 0,
		});

		const appliedReceiptPath = `${receiptPath}.applied.json`;
		const preparedReceiptPath = `${appliedReceiptPath}.pending`;
		const receipt = JSON.parse(readFileSync(appliedReceiptPath, "utf8"));
		writeFileSync(
			preparedReceiptPath,
			JSON.stringify({ ...receipt, status: "prepared" }),
			{ flag: "wx", mode: 0o600 },
		);
		unlinkSync(appliedReceiptPath);
		const recovered = run(dbPath, evidence, [
			"--apply",
			"--baseline",
			receiptPath,
		]);
		expect(recovered).toMatchObject({
			mode: "apply",
			status: "already_applied",
			deleted: 0,
			recovered: true,
		});
		expect(existsSync(appliedReceiptPath)).toBe(true);
		expect(existsSync(preparedReceiptPath)).toBe(false);
	});

	it("fails closed on a missing database, an unbound zero cohort, and baseline drift", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1995-surgery-guards-"));
		roots.push(root);
		const missing = join(root, "missing.db");
		const missingResult = spawnSync(
			"node",
			[script, "--db", missing, "--output-dir", join(root, "missing-out")],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(missingResult.status).toBe(1);
		expect(missingResult.stderr).toContain("database_missing");
		expect(existsSync(missing)).toBe(false);

		const emptyPath = join(root, "empty.db");
		const empty = new Database(emptyPath);
		empty.exec(`
			CREATE TABLE session_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
				ts TEXT NOT NULL, execution_id TEXT NOT NULL, issue_id TEXT NOT NULL,
				project_name TEXT NOT NULL, event_type TEXT NOT NULL,
				severity TEXT NOT NULL DEFAULT 'info', payload JSON, source TEXT NOT NULL
			)
		`);
		empty.close();
		const emptyBaseline = run(emptyPath, join(root, "empty-out"));
		const targetMissing = spawnSync(
			"node",
			[
				script,
				"--db",
				emptyPath,
				"--output-dir",
				join(root, "empty-out"),
				"--apply",
				"--baseline",
				String(emptyBaseline.receiptPath),
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(targetMissing.status).toBe(1);
		expect(targetMissing.stderr).toContain("target_missing");

		const { dbPath } = fixture("drift");
		const driftOut = join(root, "drift-out");
		const driftBaseline = run(dbPath, driftOut);
		const changed = new Database(dbPath);
		changed
			.prepare(`
			INSERT INTO session_events
				(event_id, ts, execution_id, issue_id, project_name, event_type, payload, source)
			VALUES ('target-3', '2026-08-03 00:00:00', 'exec-c', 'FLY-3', 'flywheel',
				'issue_thread_infra_notify_skipped', '{}', 'bridge.founder-thread-notifier')
		`)
			.run();
		changed.close();
		const drift = spawnSync(
			"node",
			[
				script,
				"--db",
				dbPath,
				"--output-dir",
				driftOut,
				"--apply",
				"--baseline",
				String(driftBaseline.receiptPath),
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(drift.status).toBe(1);
		expect(drift.stderr).toContain("baseline_count_drift");
		const check = new Database(dbPath, { readonly: true });
		expect(
			check
				.prepare(
					`SELECT count(*) AS n FROM session_events WHERE ${COHORT_PREDICATE}`,
				)
				.get(),
		).toEqual({ n: 3 });
		check.close();
	});
});
