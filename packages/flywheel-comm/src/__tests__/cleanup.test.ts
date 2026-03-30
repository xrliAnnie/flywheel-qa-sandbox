import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { cleanupStaleSessions } from "../cleanup.js";
import { CommDB } from "../db.js";

// Mock execFileSync to control tmux command behavior
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

const mockExecFileSync = execFileSync as unknown as Mock;

describe("cleanupStaleSessions", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-cleanup-test-"));
		vi.clearAllMocks();
		// Default: tmux server is running, sessions exist, no clients attached
		mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "list-sessions") return "";
			if (cmd === "tmux" && args[0] === "has-session") return "";
			if (cmd === "tmux" && args[0] === "list-clients") return "";
			if (cmd === "tmux" && args[0] === "kill-window") return "";
			return "";
		});
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Helper: create a CommDB with pre-populated sessions */
	function createDbWithSessions(
		sessions: Array<{
			execution_id: string;
			tmux_window: string;
			project_name: string;
			issue_id?: string;
			status: "running" | "completed" | "timeout";
			ended_at?: string;
		}>,
	): string {
		const dbPath = join(tmpDir, `comm-${Date.now()}-${Math.random()}.db`);
		const db = new CommDB(dbPath);
		for (const s of sessions) {
			db.registerSession(
				s.execution_id,
				s.tmux_window,
				s.project_name,
				s.issue_id,
			);
			if (s.status !== "running") {
				db.updateSessionStatus(s.execution_id, s.status);
			}
			if (s.ended_at) {
				// Override ended_at for precise timeout testing
				(db as unknown as { db: Database.Database }).db
					.prepare("UPDATE sessions SET ended_at = ? WHERE execution_id = ?")
					.run(s.ended_at, s.execution_id);
			}
		}
		db.close();
		return dbPath;
	}

	it("returns empty result when dbPaths is empty", () => {
		const result = cleanupStaleSessions({ dbPaths: [] });
		expect(result).toEqual({
			cleaned: 0,
			skipped: 0,
			warnings: [],
			errors: [],
		});
	});

	it("returns empty result when dbPath does not exist", () => {
		const result = cleanupStaleSessions({
			dbPaths: [join(tmpDir, "nonexistent.db")],
		});
		expect(result).toEqual({
			cleaned: 0,
			skipped: 0,
			warnings: [],
			errors: [],
		});
	});

	it("returns empty result when tmux server is not running", () => {
		mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "list-sessions") {
				throw new Error("no server running");
			}
			return "";
		});

		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		const result = cleanupStaleSessions({ dbPaths: [dbPath] });
		expect(result).toEqual({
			cleaned: 0,
			skipped: 0,
			warnings: [],
			errors: [],
		});
	});

	it("skips sessions that have not timed out", () => {
		const now = new Date()
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");
		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: now,
			},
		]);

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		expect(result.cleaned).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("cleans up timed-out sessions with no client attached", () => {
		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		expect(result.cleaned).toBe(1);
		expect(result.skipped).toBe(0);

		// Verify kill-window was called with correct target
		const killCalls = mockExecFileSync.mock.calls.filter(
			(c: unknown[]) =>
				c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "kill-window",
		);
		expect(killCalls).toHaveLength(1);
		expect(killCalls[0][1]).toEqual(["kill-window", "-t", "GEO-1:@0"]);
	});

	it("skips timed-out sessions with client attached", () => {
		mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "list-sessions") return "";
			if (cmd === "tmux" && args[0] === "has-session") return "";
			if (cmd === "tmux" && args[0] === "list-clients") {
				return "/dev/ttys001: GEO-1 [200x50]";
			}
			return "";
		});

		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		expect(result.cleaned).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("skips when tmux session no longer exists", () => {
		mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "list-sessions") return "";
			if (cmd === "tmux" && args[0] === "has-session") {
				throw new Error("session not found");
			}
			return "";
		});

		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		expect(result.cleaned).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("does not execute kill in dry-run mode", () => {
		const logs: string[] = [];
		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
			dryRun: true,
			log: (msg) => logs.push(msg),
		});
		expect(result.cleaned).toBe(0);
		expect(result.skipped).toBe(1);
		expect(logs.some((l) => l.toLowerCase().includes("dry"))).toBe(true);

		// Verify kill-window was NOT called
		const killCalls = mockExecFileSync.mock.calls.filter(
			(c: unknown[]) =>
				c[0] === "tmux" && Array.isArray(c[1]) && c[1][0] === "kill-window",
		);
		expect(killCalls).toHaveLength(0);
	});

	it("handles multiple CommDB files and merges results", () => {
		const dbPath1 = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "proj-a",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);
		const dbPath2 = createDbWithSessions([
			{
				execution_id: "exec-2",
				tmux_window: "GEO-2:@0",
				project_name: "proj-b",
				status: "timeout",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		const result = cleanupStaleSessions({
			dbPaths: [dbPath1, dbPath2],
			timeoutMinutes: 30,
		});
		expect(result.cleaned).toBe(2);
		expect(result.skipped).toBe(0);
	});

	it("records error and continues when CommDB open fails (non-legacy)", () => {
		const corruptDbPath = join(tmpDir, "corrupt.db");
		writeFileSync(corruptDbPath, "not a sqlite file");

		const goodDbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		const result = cleanupStaleSessions({
			dbPaths: [corruptDbPath, goodDbPath],
			timeoutMinutes: 30,
		});
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.cleaned).toBe(1);
	});

	it("records warning for legacy DB without sessions table", () => {
		const legacyDbPath = join(tmpDir, "legacy.db");
		const legacyDb = new Database(legacyDbPath);
		legacyDb.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)");
		legacyDb.close();

		const result = cleanupStaleSessions({
			dbPaths: [legacyDbPath],
			timeoutMinutes: 30,
		});
		expect(result.warnings.length).toBe(1);
		expect(result.warnings[0]).toContain("legacy");
		expect(result.errors).toHaveLength(0);
	});

	it("treats TOCTOU race (session/window disappears mid-cleanup) as skip, not error", () => {
		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "list-sessions") return "";
			if (cmd === "tmux" && args[0] === "has-session") return "";
			if (cmd === "tmux" && args[0] === "list-clients") return "";
			if (cmd === "tmux" && args[0] === "kill-window") {
				throw new Error("can't find window GEO-1:@0");
			}
			return "";
		});

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		// Window disappeared between has-session and kill-window — treated as skip
		expect(result.skipped).toBe(1);
		expect(result.errors).toHaveLength(0);
		expect(result.cleaned).toBe(0);
	});

	it("records real error when kill-window fails for non-TOCTOU reason", () => {
		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "list-sessions") return "";
			if (cmd === "tmux" && args[0] === "has-session") return "";
			if (cmd === "tmux" && args[0] === "list-clients") return "";
			if (cmd === "tmux" && args[0] === "kill-window") {
				throw new Error("permission denied");
			}
			return "";
		});

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain("permission denied");
	});

	it("closes db even when per-session operation throws", () => {
		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "list-sessions") return "";
			if (cmd === "tmux" && args[0] === "has-session") return "";
			if (cmd === "tmux" && args[0] === "list-clients") return "";
			if (cmd === "tmux" && args[0] === "kill-window") {
				throw new Error("unexpected failure");
			}
			return "";
		});

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		expect(result.errors.length).toBe(1);

		// Verify DB was properly closed — we can still open it
		const db = CommDB.openReadonly(dbPath);
		expect(db).toBeDefined();
		db.close();
	});

	it("handles both completed and timeout sessions, ignores running", () => {
		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
			{
				execution_id: "exec-2",
				tmux_window: "GEO-2:@0",
				project_name: "test",
				status: "timeout",
				ended_at: "2020-01-01 00:00:00",
			},
			{
				execution_id: "exec-3",
				tmux_window: "GEO-3:@0",
				project_name: "test",
				status: "running",
			},
		]);

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		expect(result.cleaned).toBe(2);
		expect(result.skipped).toBe(0);
	});

	it("uses default 30 minute timeout when not specified", () => {
		const tenMinAgo = new Date(Date.now() - 10 * 60_000)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");

		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "GEO-1:@0",
				project_name: "test",
				status: "completed",
				ended_at: tenMinAgo,
			},
		]);

		// No timeoutMinutes specified → default 30
		const result = cleanupStaleSessions({ dbPaths: [dbPath] });
		expect(result.cleaned).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("gracefully skips bare window ID format (has-session fails for non-session targets)", () => {
		const dbPath = createDbWithSessions([
			{
				execution_id: "exec-1",
				tmux_window: "@42", // legacy format — not a valid session name
				project_name: "test",
				status: "completed",
				ended_at: "2020-01-01 00:00:00",
			},
		]);

		// Realistic behavior: has-session fails for bare window IDs
		mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "list-sessions") return "";
			if (cmd === "tmux" && args[0] === "has-session") {
				throw new Error("can't find session @42");
			}
			return "";
		});

		const result = cleanupStaleSessions({
			dbPaths: [dbPath],
			timeoutMinutes: 30,
		});
		// Bare IDs are safely skipped — no crash, no error
		expect(result.cleaned).toBe(0);
		expect(result.skipped).toBe(1);
		expect(result.errors).toHaveLength(0);
	});
});
