import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../dist/index.js");

function runCli(args: string[], env?: Record<string, string>): string {
	return execFileSync("node", [CLI_PATH, ...args], {
		encoding: "utf-8",
		env: { ...process.env, ...env },
	}).trim();
}

function runCliSafe(
	args: string[],
	env?: Record<string, string>,
): { stdout: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [CLI_PATH, ...args], {
			encoding: "utf-8",
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return { stdout, exitCode: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: string; status?: number };
		return {
			stdout: (e.stdout ?? "").toString().trim(),
			exitCode: e.status ?? 1,
		};
	}
}

describe("CLI", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-cli-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("ask", () => {
		it("should output question ID", () => {
			const result = runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"What should I do?",
			]);
			// Should be a UUID
			expect(result).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		});

		it("should output JSON with --json", () => {
			const result = runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"--json",
				"What should I do?",
			]);
			const parsed = JSON.parse(result);
			expect(parsed.question_id).toBeTruthy();
		});

		it("should fail without --lead", () => {
			const { exitCode } = runCliSafe(["ask", "--db", dbPath, "question"]);
			expect(exitCode).toBe(1);
		});
	});

	describe("check", () => {
		it("should output 'not yet' when no response", () => {
			const qId = runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"Q?",
			]);
			const result = runCli(["check", "--db", dbPath, qId]);
			expect(result).toBe("not yet");
		});

		it("should output answer when responded", () => {
			const qId = runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"Q?",
			]);
			runCli([
				"respond",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				qId,
				"Use REST.",
			]);
			const result = runCli(["check", "--db", dbPath, qId]);
			expect(result).toBe("Use REST.");
		});

		it("should always exit 0 regardless of answer status", () => {
			const qId = runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"Q?",
			]);
			// Not yet answered — should still exit 0
			const { exitCode } = runCliSafe(["check", "--db", dbPath, qId]);
			expect(exitCode).toBe(0);
		});

		it("should output JSON with --json", () => {
			const qId = runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"Q?",
			]);
			// Pending
			const pendingResult = JSON.parse(
				runCli(["check", "--db", dbPath, "--json", qId]),
			);
			expect(pendingResult.status).toBe("pending");

			// Answer
			runCli([
				"respond",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				qId,
				"Answer",
			]);
			const answeredResult = JSON.parse(
				runCli(["check", "--db", dbPath, "--json", qId]),
			);
			expect(answeredResult.status).toBe("answered");
			expect(answeredResult.content).toBe("Answer");
		});
	});

	describe("pending", () => {
		it("should list pending questions", () => {
			runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"First question",
			]);
			runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"Second question",
			]);

			const result = runCli([
				"pending",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
			]);
			expect(result).toContain("First question");
			expect(result).toContain("Second question");
		});

		it("should output JSON with --json", () => {
			runCli(["ask", "--lead", "product-lead", "--db", dbPath, "Q?"]);
			const result = JSON.parse(
				runCli(["pending", "--lead", "product-lead", "--db", dbPath, "--json"]),
			);
			expect(result).toHaveLength(1);
			expect(result[0].content).toBe("Q?");
		});
	});

	describe("respond", () => {
		it("should confirm response", () => {
			const qId = runCli([
				"ask",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				"Q?",
			]);
			const result = runCli([
				"respond",
				"--lead",
				"product-lead",
				"--db",
				dbPath,
				qId,
				"Answer here",
			]);
			expect(result).toContain("Responded to");
		});
	});

	describe("DB path resolution", () => {
		it("should resolve from FLYWHEEL_COMM_DB env var", () => {
			const qId = runCli(["ask", "--lead", "product-lead", "Q?"], {
				FLYWHEEL_COMM_DB: dbPath,
			});
			expect(qId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		});

		it("should resolve from --project flag", () => {
			const qId = runCli([
				"ask",
				"--lead",
				"product-lead",
				"--project",
				"test-project",
				"Q?",
			]);
			expect(qId).toBeTruthy();
		});

		it("should fail without any DB path", () => {
			const { exitCode } = runCliSafe(["ask", "--lead", "product-lead", "Q?"], {
				FLYWHEEL_COMM_DB: "",
			});
			expect(exitCode).toBe(1);
		});
	});

	describe("help", () => {
		it("should print usage with --help", () => {
			const result = runCli(["--help"]);
			expect(result).toContain("Usage:");
			expect(result).toContain("ask");
			expect(result).toContain("check");
		});
	});

	describe("send", () => {
		it("should output instruction ID", () => {
			const result = runCli([
				"send",
				"--from",
				"product-lead",
				"--to",
				"exec-123",
				"--db",
				dbPath,
				"Stop current work",
			]);
			expect(result).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
		});

		it("should output JSON with --json", () => {
			const result = runCli([
				"send",
				"--from",
				"product-lead",
				"--to",
				"exec-123",
				"--db",
				dbPath,
				"--json",
				"Stop current work",
			]);
			const parsed = JSON.parse(result);
			expect(parsed.instruction_id).toBeTruthy();
		});

		it("should fail without --from", () => {
			const { exitCode } = runCliSafe([
				"send",
				"--to",
				"exec-123",
				"--db",
				dbPath,
				"instruction",
			]);
			expect(exitCode).toBe(1);
		});

		it("should fail without --to", () => {
			const { exitCode } = runCliSafe([
				"send",
				"--from",
				"product-lead",
				"--db",
				dbPath,
				"instruction",
			]);
			expect(exitCode).toBe(1);
		});
	});

	describe("inbox", () => {
		it("should show instructions via send → inbox round-trip", () => {
			runCli([
				"send",
				"--from",
				"product-lead",
				"--to",
				"exec-456",
				"--db",
				dbPath,
				"Do the thing",
			]);

			const result = runCli(["inbox", "--exec-id", "exec-456", "--db", dbPath]);
			expect(result).toContain("Do the thing");
			expect(result).toContain("product-lead");
		});

		it("should output JSON with --json", () => {
			runCli([
				"send",
				"--from",
				"product-lead",
				"--to",
				"exec-789",
				"--db",
				dbPath,
				"Instruction text",
			]);

			const result = JSON.parse(
				runCli(["inbox", "--exec-id", "exec-789", "--db", dbPath, "--json"]),
			);
			expect(result).toHaveLength(1);
			expect(result[0].content).toBe("Instruction text");
			expect(result[0].from_agent).toBe("product-lead");
		});

		it("should show 'No instructions.' when empty", () => {
			const result = runCli([
				"inbox",
				"--exec-id",
				"exec-empty",
				"--db",
				dbPath,
			]);
			expect(result).toBe("No instructions.");
		});

		it("should fail without --exec-id", () => {
			const { exitCode } = runCliSafe(["inbox", "--db", dbPath]);
			expect(exitCode).toBe(1);
		});
	});

	describe("sessions", () => {
		it("should list sessions", () => {
			// Seed session data via CommDB
			const db = new CommDB(dbPath);
			db.registerSession("exec-1", "GEO-1:@0", "geoforge3d", "GEO-100");
			db.close();

			const result = runCli(["sessions", "--db", dbPath]);
			expect(result).toContain("exec-1");
			expect(result).toContain("GEO-1:@0");
			expect(result).toContain("GEO-100");
			expect(result).toContain("running");
		});

		it("should output JSON with --json", () => {
			const db = new CommDB(dbPath);
			db.registerSession("exec-1", "GEO-1:@0", "geoforge3d", "GEO-100");
			db.registerSession("exec-2", "GEO-2:@1", "geoforge3d", "GEO-101");
			db.close();

			const result = JSON.parse(runCli(["sessions", "--db", dbPath, "--json"]));
			expect(result).toHaveLength(2);
			expect(result[0].execution_id).toBe("exec-1");
			expect(result[1].execution_id).toBe("exec-2");
		});

		it("should filter active sessions with --active", () => {
			const db = new CommDB(dbPath);
			db.registerSession("exec-1", "GEO-1:@0", "geoforge3d");
			db.registerSession("exec-2", "GEO-2:@1", "geoforge3d");
			db.updateSessionStatus("exec-1", "completed");
			db.close();

			const result = JSON.parse(
				runCli(["sessions", "--db", dbPath, "--json", "--active"]),
			);
			expect(result).toHaveLength(1);
			expect(result[0].execution_id).toBe("exec-2");
		});

		it("should show 'No sessions.' when empty", () => {
			// Create DB but no sessions
			const db = new CommDB(dbPath);
			db.close();

			const result = runCli(["sessions", "--db", dbPath]);
			expect(result).toBe("No sessions.");
		});
	});

	describe("sessions --lead filter", () => {
		it("should filter sessions by --lead", () => {
			const db = new CommDB(dbPath);
			db.registerSession(
				"exec-1",
				"GEO-1:@0",
				"geoforge3d",
				"GEO-100",
				"product-lead",
			);
			db.registerSession(
				"exec-2",
				"GEO-2:@1",
				"geoforge3d",
				"GEO-101",
				"ops-lead",
			);
			db.close();

			const result = JSON.parse(
				runCli([
					"sessions",
					"--db",
					dbPath,
					"--json",
					"--lead",
					"product-lead",
				]),
			);
			expect(result).toHaveLength(1);
			expect(result[0].execution_id).toBe("exec-1");
		});
	});

	describe("cleanup", () => {
		it("should output cleaned count", () => {
			// Create DB with old read message
			const db = new CommDB(dbPath);
			const instId = db.insertInstruction("lead", "exec-1", "old msg");
			db.markInstructionRead(instId);
			(db as any).db
				.prepare(
					"UPDATE messages SET created_at = datetime('now', '-25 hours') WHERE id = ?",
				)
				.run(instId);
			db.close();

			const result = runCli(["cleanup", "--db", dbPath]);
			expect(result).toBe("Cleaned: 1");
		});

		it("should output JSON with --json", () => {
			const db = new CommDB(dbPath);
			db.close();

			const result = JSON.parse(
				runCli(["cleanup", "--db", dbPath, "--json"]),
			);
			expect(result.cleaned).toBe(0);
		});

		it("should respect --ttl flag", () => {
			const db = new CommDB(dbPath);
			const instId = db.insertInstruction("lead", "exec-1", "3h old");
			db.markInstructionRead(instId);
			(db as any).db
				.prepare(
					"UPDATE messages SET created_at = datetime('now', '-3 hours') WHERE id = ?",
				)
				.run(instId);
			db.close();

			// Default 24h: should not clean
			const result24 = runCli(["cleanup", "--db", dbPath, "--json"]);
			expect(JSON.parse(result24).cleaned).toBe(0);

			// 2h TTL: should clean
			const result2 = runCli([
				"cleanup",
				"--db",
				dbPath,
				"--ttl",
				"2",
				"--json",
			]);
			expect(JSON.parse(result2).cleaned).toBe(1);
		});
	});

	describe("search", () => {
		it("should fail without --exec-id", () => {
			const { exitCode } = runCliSafe([
				"search",
				"--pattern",
				"test",
				"--db",
				dbPath,
			]);
			expect(exitCode).toBe(1);
		});

		it("should fail without --pattern", () => {
			const { exitCode } = runCliSafe([
				"search",
				"--exec-id",
				"exec-1",
				"--db",
				dbPath,
			]);
			expect(exitCode).toBe(1);
		});

		it("should report error when session not found", () => {
			const db = new CommDB(dbPath);
			db.close();

			const { exitCode } = runCliSafe([
				"search",
				"--exec-id",
				"nonexistent",
				"--pattern",
				"test",
				"--db",
				dbPath,
			]);
			expect(exitCode).toBe(1);
		});

		it("should search tmux output via fake tmux", () => {
			const db = new CommDB(dbPath);
			db.registerSession("exec-search", "GEO-SEARCH:@0", "geoforge3d");
			db.close();

			const fakeTmuxDir = join(tmpDir, "bin-search");
			mkdirSync(fakeTmuxDir, { recursive: true });
			writeFileSync(
				join(fakeTmuxDir, "tmux"),
				'#!/bin/sh\necho "line one"\necho "ERROR: test failure"\necho "line three"',
				{ mode: 0o755 },
			);

			const result = runCli(
				[
					"search",
					"--exec-id",
					"exec-search",
					"--pattern",
					"ERROR",
					"--db",
					dbPath,
				],
				{ PATH: `${fakeTmuxDir}:${process.env.PATH}` },
			);
			expect(result).toContain("ERROR: test failure");
		});

		it("should output JSON with --json", () => {
			const db = new CommDB(dbPath);
			db.registerSession("exec-sjson", "GEO-SJSON:@0", "geoforge3d");
			db.close();

			const fakeTmuxDir = join(tmpDir, "bin-sjson");
			mkdirSync(fakeTmuxDir, { recursive: true });
			writeFileSync(
				join(fakeTmuxDir, "tmux"),
				'#!/bin/sh\necho "hello world"\necho "hello there"',
				{ mode: 0o755 },
			);

			const result = JSON.parse(
				runCli(
					[
						"search",
						"--exec-id",
						"exec-sjson",
						"--pattern",
						"hello",
						"--db",
						dbPath,
						"--json",
					],
					{ PATH: `${fakeTmuxDir}:${process.env.PATH}` },
				),
			);
			expect(result.matches).toHaveLength(2);
			expect(result.pattern).toBe("hello");
		});
	});

	describe("capture", () => {
		it("should fail without --exec-id", () => {
			const { exitCode } = runCliSafe(["capture", "--db", dbPath]);
			expect(exitCode).toBe(1);
		});

		it("should capture tmux output via fake tmux", () => {
			// Seed a session
			const db = new CommDB(dbPath);
			db.registerSession("exec-cap", "GEO-CAP:@0", "geoforge3d");
			db.close();

			// Create fake tmux script
			const fakeTmuxDir = join(tmpDir, "bin");
			mkdirSync(fakeTmuxDir, { recursive: true });
			writeFileSync(
				join(fakeTmuxDir, "tmux"),
				'#!/bin/sh\necho "captured tmux output line 1"\necho "captured tmux output line 2"',
				{ mode: 0o755 },
			);

			const result = runCli(
				["capture", "--exec-id", "exec-cap", "--db", dbPath],
				{ PATH: `${fakeTmuxDir}:${process.env.PATH}` },
			);
			expect(result).toContain("captured tmux output line 1");
			expect(result).toContain("captured tmux output line 2");
		});

		it("should pass --lines to tmux (NaN passthrough for non-numeric)", () => {
			// Seed a session
			const db = new CommDB(dbPath);
			db.registerSession("exec-nan", "GEO-NAN:@0", "geoforge3d");
			db.close();

			// Create fake tmux that echoes args for inspection
			const fakeTmuxDir = join(tmpDir, "bin-nan");
			mkdirSync(fakeTmuxDir, { recursive: true });
			writeFileSync(join(fakeTmuxDir, "tmux"), '#!/bin/sh\necho "args: $@"', {
				mode: 0o755,
			});

			const result = runCli(
				["capture", "--exec-id", "exec-nan", "--db", dbPath, "--lines", "foo"],
				{ PATH: `${fakeTmuxDir}:${process.env.PATH}` },
			);
			// Current behavior: parseInt("foo", 10) → NaN → tmux gets -S -NaN
			expect(result).toContain("-NaN");
		});
	});
});
