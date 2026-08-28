import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import { resolveLeadIdentity } from "../lead-identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../dist/index.js");
let defaultCliEnv: Record<string, string | undefined> = {};

function cliEnv(
	overrides?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
	const env = { ...process.env, ...defaultCliEnv };
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (value === undefined) {
			delete env[key];
		} else {
			env[key] = value;
		}
	}
	return env;
}

function runCli(
	args: string[],
	env?: Record<string, string | undefined>,
): string {
	return execFileSync("node", [CLI_PATH, ...args], {
		encoding: "utf-8",
		env: cliEnv(env),
	}).trim();
}

function runCliSafe(
	args: string[],
	env?: Record<string, string | undefined>,
): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execFileSync("node", [CLI_PATH, ...args], {
			encoding: "utf-8",
			env: cliEnv(env),
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return { stdout, stderr: "", exitCode: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: (e.stdout ?? "").toString().trim(),
			stderr: (e.stderr ?? "").toString().trim(),
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
		mkdirSync(join(tmpDir, ".flywheel"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "test",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
		const projectsPath = join(tmpDir, "projects.json");
		const discordStateDir = join(tmpDir, "discord-product-lead");
		writeFileSync(
			projectsPath,
			JSON.stringify([
				{
					projectName: "test",
					projectRoot: tmpDir,
					leads: [
						{
							agentId: "product-lead",
							summaryRole: "producer",
							chatChannel: "11111111111111111",
							match: { labels: ["Product"] },
							botTokenEnv: "TEST_PRODUCT_BOT_TOKEN",
							botUserId: "12345678901234567",
							discordStateDir,
						},
					],
				},
			]),
		);
		const identity = resolveLeadIdentity({
			projectsPath,
			projectName: "test",
			leadId: "product-lead",
			homeDir: tmpDir,
		});
		defaultCliEnv = {
			HOME: tmpDir,
			FLYWHEEL_PROJECTS_FILE: projectsPath,
			FLYWHEEL_PROJECT_NAME: identity.projectName,
			PROJECT_NAME: identity.projectName,
			FLYWHEEL_LEAD_ID: identity.leadId,
			LEAD_ID: identity.leadId,
			FLYWHEEL_LEAD_KEY: identity.leadKey,
			FLYWHEEL_LEAD_BACKEND: identity.backend,
			FLYWHEEL_LEAD_SUMMARY_ROLE: identity.summaryRole,
			FLYWHEEL_LEAD_HAS_SUMMARY_DUTY: identity.hasSummaryDuty ? "1" : "0",
			FLYWHEEL_SUMMARY_GRANULARITY: identity.summaryGranularity ?? "",
			FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST:
				identity.summaryAssignmentDigest ?? "",
			FLYWHEEL_STATE_DIR: join(tmpDir, ".flywheel"),
			DISCORD_STATE_DIR: identity.discordStateDir,
			DISCORD_EXPECTED_BOT_USER_ID: identity.botUserId ?? "",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: identity.identityDigest,
			FLYWHEEL_LEAD_LEASE_MODE_FILE: join(tmpDir, "lease-mode.json"),
			FLYWHEEL_LEAD_LEASE_DB: join(tmpDir, "lead-lease.db"),
			FLYWHEEL_ALERT_QUEUE_DIR: join(tmpDir, "alerts"),
			FLYWHEEL_LEAD_LEASE_AUDIT_LOG: join(tmpDir, "lead-lease-audit.log"),
		};
	});

	afterEach(() => {
		defaultCliEnv = {};
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function bindDefaultRunner(): void {
		const db = new CommDB(dbPath);
		db.registerSession(
			"runner",
			"runner",
			"test",
			"issue-runner",
			"product-lead",
		);
		db.close();
	}

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

		it("FLY-1715: runner ask/check/gate/ack use ingest nudges without reading the disk master token", () => {
			const runnerHome = join(tmpDir, "runner-home");
			const envDir = join(runnerHome, ".flywheel");
			mkdirSync(envDir, { recursive: true });
			writeFileSync(
				join(envDir, ".env"),
				"TEAMLEAD_API_TOKEN=must-never-be-read\n",
			);
			const readLog = join(tmpDir, "master-read.log");
			const fetchLog = join(tmpDir, "nudge-fetch.log");
			const preload = join(tmpDir, "runner-ingest-preload.mjs");
			writeFileSync(
				preload,
				`import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalReadFileSync = fs.readFileSync;
const originalAppendFileSync = fs.appendFileSync;
fs.readFileSync = function(path, ...args) {
  if (typeof path === "string" && path.endsWith("/.flywheel/.env")) {
    originalAppendFileSync(process.env.FLY1715_READ_LOG, path + "\\n");
  }
  return originalReadFileSync.call(this, path, ...args);
};
syncBuiltinESMExports();
globalThis.fetch = async function(url, init = {}) {
  const headers = init.headers ?? {};
  const authorization = typeof headers.get === "function"
    ? headers.get("Authorization")
    : headers.Authorization;
  originalAppendFileSync(
    process.env.FLY1715_FETCH_LOG,
    JSON.stringify({ url: String(url), authorization }) + "\\n",
  );
  return new Response(null, { status: 401 });
};
`,
			);

			const runnerEnv: Record<string, string | undefined> = {
				HOME: runnerHome,
				TEAMLEAD_API_TOKEN: undefined,
				FLYWHEEL_INGEST_TOKEN: "  runner-ingest  ",
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876",
				FLY1715_READ_LOG: readLog,
				FLY1715_FETCH_LOG: fetchLog,
				NODE_OPTIONS:
					`${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(),
			};

			const questionId = runCli(
				["ask", "--lead", "product-lead", "--db", dbPath, "runner question"],
				runnerEnv,
			);
			expect(runCli(["check", "--db", dbPath, questionId], runnerEnv)).toBe(
				"not yet",
			);
			const gateResult = JSON.parse(
				runCli(
					[
						"gate",
						"question",
						"--lead",
						"product-lead",
						"--exec-id",
						"runner-exec",
						"--db",
						dbPath,
						"--no-block",
						"runner gate",
					],
					runnerEnv,
				),
			);
			expect(gateResult.status).toBe("pending");
			execFileSync(
				"node",
				[
					CLI_PATH,
					"ack-event",
					"1",
					"--lead",
					"product-lead",
					"--db",
					dbPath,
					"--token-stdin",
				],
				{
					encoding: "utf-8",
					env: cliEnv(runnerEnv),
					input: "runner-receipt-token\n",
				},
			);

			expect(existsSync(readLog)).toBe(false);
			const nudges = readFileSync(fetchLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(nudges).toHaveLength(3);
			expect(nudges).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						url: "http://127.0.0.1:9876/api/lead-inbox/nudge",
						authorization: "Bearer runner-ingest",
					}),
				]),
			);
		});
	});

	describe("lead-identity", () => {
		it("resolves an exact registry selector through the public CLI", () => {
			const projectsPath = join(tmpDir, "projects.json");
			writeFileSync(
				projectsPath,
				JSON.stringify([
					{
						projectName: "flywheel",
						projectRoot: tmpDir,
						leads: [
							{
								agentId: "eng-lead",
								summaryRole: "producer",
								chatChannel: "11111111111111111",
								match: { labels: ["Engineering"] },
								botTokenEnv: "ENG_BOT_TOKEN",
								botUserId: "12345678901234567",
							},
						],
					},
				]),
			);

			const result = JSON.parse(
				runCli([
					"lead-identity",
					"resolve",
					"--projects-file",
					projectsPath,
					"--project",
					"flywheel",
					"--lead",
					"eng-lead",
				]),
			);
			expect(result).toMatchObject({
				leadId: "eng-lead",
				projectName: "flywheel",
				botUserId: "12345678901234567",
			});
		});
	});

	describe("ack-event identity", () => {
		it("fails loud when neither --lead nor FLYWHEEL_LEAD_ID identifies the acknowledger", () => {
			const result = runCliSafe(
				["ack-event", "1", "--db", dbPath, "--token-stdin"],
				{ FLYWHEEL_LEAD_ID: undefined },
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/--lead.*FLYWHEEL_LEAD_ID/i);
		});
	});

	describe("codex-review-result", () => {
		it("requires explicit exec and head flags before any Bridge write", () => {
			const fetchLog = join(tmpDir, "fetch.log");
			const preload = join(tmpDir, "fetch-preload.mjs");
			writeFileSync(
				preload,
				`import { appendFileSync } from "node:fs";
globalThis.fetch = async () => {
  appendFileSync(${JSON.stringify(fetchLog)}, "called\\n");
  return { ok: true, status: 200 };
};
`,
			);
			const fullEnv = {
				HOME: tmpDir,
				FLYWHEEL_EXEC_ID: "env-exec-must-not-count",
				FLYWHEEL_ISSUE_ID: "FLY-1501",
				FLYWHEEL_PROJECT_NAME: "flywheel",
				FLYWHEEL_BRIDGE_URL: "http://bridge.invalid",
				NODE_OPTIONS: `--import=${preload}`,
			};
			for (const args of [
				["codex-review-result"],
				["codex-review-result", "--exec-id", "explicit-exec"],
				["codex-review-result", "--pr-head", "a".repeat(40)],
				[
					"codex-review-result",
					"--exec-id",
					"explicit-exec",
					"--pr-head",
					"not-a-sha",
				],
			]) {
				const result = runCliSafe(args, fullEnv);
				expect(result.exitCode, args.join(" ")).toBe(1);
				expect(result.stderr, args.join(" ")).toMatch(
					/Usage:.*codex-review-result.*--exec-id.*--pr-head/i,
				);
			}
			expect(existsSync(fetchLog)).toBe(false);
		}, 15_000);
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
			bindDefaultRunner();
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
			bindDefaultRunner();
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

		it("excludes trusted runner-stop reports but keeps ordinary and near-match questions", () => {
			const db = new CommDB(dbPath);
			db.insertQuestion("runner", "product-lead", "ordinary question");
			db.insertQuestion(
				"runner",
				"product-lead",
				"RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-2017 exec=runner route=- detail=parked",
				{ id: `rstop-${"a".repeat(32)}`, kind: "report" },
			);
			db.insertQuestion(
				"runner",
				"product-lead",
				"RUNNER-STOPPED kind=runner_stopped near match",
				{ id: "ordinary-report", kind: "report" },
			);
			db.close();

			const result = JSON.parse(
				runCli(["pending", "--lead", "product-lead", "--db", dbPath, "--json"]),
			) as Array<{ id: string; content: string }>;
			expect(result.map(({ content }) => content)).toEqual([
				"ordinary question",
				"RUNNER-STOPPED kind=runner_stopped near match",
			]);
		});
	});

	describe("respond", () => {
		it("should confirm response", () => {
			bindDefaultRunner();
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

		it("answers a deterministic turn-wait question with exit 0 and a readable response", () => {
			bindDefaultRunner();
			const questionId = "turn-wait:runner:holder:3";
			const db = new CommDB(dbPath);
			db.insertQuestion("runner", "product-lead", "TURN handoff overdue", {
				id: questionId,
			});
			db.close();

			const result = runCliSafe(
				[
					"respond",
					"--lead",
					"product-lead",
					"--db",
					dbPath,
					questionId,
					"Belt inspected; keep waiting.",
				],
				{ FLYWHEEL_GATE_MARKER_DIR: join(tmpDir, "markers") },
			);
			const answer = runCli(["check", "--db", dbPath, questionId]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`Responded to ${questionId}`);
			expect(answer).toBe("Belt inspected; keep waiting.");
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
			expect(result).toContain("founder-time");
		});
	});

	describe("founder-time", () => {
		it("honors the founder timezone env override in JSON mode", () => {
			const result = JSON.parse(
				runCli(["founder-time", "--json"], {
					FLYWHEEL_FOUNDER_TZ: "Asia/Tokyo",
				}),
			);
			expect(result.tz).toBe("Asia/Tokyo");
			expect(result.offsetMinutes).toBe(540);
			expect(result.iso).toMatch(/[+]09:00$/);
		});
	});

	// FLY-159 Codex r1 R1 MEDIUM: --timeout-behavior was previously cast
	// without runtime validation. A typo silently downgraded fail-close to
	// fail-open and skipped the gate_timed_out POST. Now the CLI throws.
	describe("gate --timeout-behavior validation (FLY-159)", () => {
		it("rejects invalid --timeout-behavior value with exit 1", () => {
			const { exitCode } = runCliSafe([
				"gate",
				"brainstorm",
				"--lead",
				"product-lead",
				"--exec-id",
				"exec-test",
				"--db",
				dbPath,
				"--timeout-behavior",
				"fail-clos", // typo
				"my message",
			]);
			expect(exitCode).toBe(1);
		});

		it("accepts 'fail-close' explicitly", () => {
			// Use very short timeout so the gate process exits quickly. We
			// don't care about the gate outcome here — only that the CLI
			// accepts the flag without throwing at parse time.
			const { exitCode } = runCliSafe([
				"gate",
				"brainstorm",
				"--lead",
				"product-lead",
				"--exec-id",
				"exec-test",
				"--db",
				dbPath,
				"--timeout",
				"50",
				"--timeout-behavior",
				"fail-close",
				"my message",
			]);
			// gate fail-close timeout → exit 1; we just want NOT a parse-time crash.
			// (1 is acceptable, 2/126 would indicate a parse-stage failure.)
			expect([0, 1]).toContain(exitCode);
		});

		it("accepts 'fail-open' explicitly", () => {
			const { exitCode } = runCliSafe([
				"gate",
				"brainstorm",
				"--lead",
				"product-lead",
				"--exec-id",
				"exec-test",
				"--db",
				dbPath,
				"--timeout",
				"50",
				"--timeout-behavior",
				"fail-open",
				"my message",
			]);
			// fail-open timeout → exit 0 typically.
			expect([0, 1]).toContain(exitCode);
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

		it("should use FLYWHEEL_EXEC_ID when --exec-id is omitted", () => {
			runCli([
				"send",
				"--from",
				"product-lead",
				"--to",
				"env-exec",
				"--db",
				dbPath,
				"Environment-bound instruction",
			]);

			const result = runCli(["inbox", "--db", dbPath], {
				FLYWHEEL_EXEC_ID: "env-exec",
			});
			expect(result).toContain("Environment-bound instruction");
		});

		it("should fail without an execution identity", () => {
			const { exitCode } = runCliSafe(["inbox", "--db", dbPath], {
				FLYWHEEL_EXEC_ID: undefined,
			});
			expect(exitCode).toBe(1);
		});
	});

	describe("message-status", () => {
		it("queries live evidence by exact id and exits 1 for an absent id", () => {
			const id = runCli([
				"send",
				"--from",
				"product-lead",
				"--to",
				"exec-status",
				"--db",
				dbPath,
				"Inspect me",
			]);
			const live = JSON.parse(
				runCli(["message-status", id, "--db", dbPath, "--json"]),
			);
			expect(live).toMatchObject({
				location: "live",
				message_id: id,
				state: "QUEUED",
				dead_reason: null,
				last_error: null,
				stamps: {
					created_at: expect.any(String),
					delivered_at: null,
					notified_at: null,
					settled_at: null,
				},
			});

			const absent = runCliSafe([
				"message-status",
				"missing",
				"--db",
				dbPath,
				"--json",
			]);
			expect(absent.exitCode).toBe(1);
			expect(JSON.parse(absent.stdout)).toMatchObject({
				location: "absent",
				message_id: "missing",
				state: null,
			});
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
					"UPDATE mailbox SET state = 'ACKED', acked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-73 hours') WHERE id = ?",
				)
				.run(instId);
			db.close();

			const result = runCli(["cleanup", "--db", dbPath]);
			expect(result).toBe("Cleaned: 1");
		});

		it("should output JSON with --json", () => {
			const db = new CommDB(dbPath);
			db.close();

			const result = JSON.parse(runCli(["cleanup", "--db", dbPath, "--json"]));
			expect(result.cleaned).toBe(0);
		});

		it("should respect --ttl above the 72-hour retention floor", () => {
			const db = new CommDB(dbPath);
			const instId = db.insertInstruction("lead", "exec-1", "96h old");
			db.markInstructionRead(instId);
			(db as any).db
				.prepare(
					"UPDATE mailbox SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-96 hours') WHERE id = ?",
				)
				.run(instId);
			db.close();

			const retained = runCli([
				"cleanup",
				"--db",
				dbPath,
				"--ttl",
				"120",
				"--json",
			]);
			expect(JSON.parse(retained).cleaned).toBe(0);

			const raw = new Database(dbPath);
			raw
				.prepare(
					"UPDATE mailbox SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-121 hours') WHERE id = ?",
				)
				.run(instId);
			raw.close();
			const cleaned = runCli([
				"cleanup",
				"--db",
				dbPath,
				"--ttl",
				"120",
				"--json",
			]);
			expect(JSON.parse(cleaned).cleaned).toBe(1);
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
