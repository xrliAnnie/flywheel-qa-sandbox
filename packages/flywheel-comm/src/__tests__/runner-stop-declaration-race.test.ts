import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DB = join(TEST_DIR, "..", "..", "dist", "db.js");
const EXEC_ID = "exec-fly2017-race";
const LEAD_ID = "flywheel-eng-lead";

interface WorkerResult {
	code: number | null;
	stderr: string;
	result?: {
		status: "sent" | "duplicate" | "stale";
		questionId: string;
		contentMatched: boolean;
	};
}

function runWorker(
	workerPath: string,
	input: {
		dbPath: string;
		content: string;
		questionId: string;
		derivedAtMs: number;
		startAtMs: number;
		delayMs?: number;
	},
): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [workerPath, JSON.stringify(input)], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			let result: WorkerResult["result"];
			try {
				result = stdout.trim() ? JSON.parse(stdout) : undefined;
			} catch {}
			resolve({ code, stderr, result });
		});
	});
}

describe("runner stop declaration true cross-process races", () => {
	let dir: string;
	let dbPath: string;
	let workerPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly2017-rstop-race-"));
		dbPath = join(dir, "comm.db");
		workerPath = join(dir, "worker.mjs");
		const parent = new CommDB(dbPath);
		parent.registerSession(
			EXEC_ID,
			"runner:race",
			"flywheel",
			"FLY-2017",
			LEAD_ID,
		);
		parent.close();
		writeFileSync(
			workerPath,
			`import { CommDB } from ${JSON.stringify(DIST_DB)};
const input = JSON.parse(process.argv[2]);
while (Date.now() < input.startAtMs) { /* shared barrier */ }
if (input.delayMs) await new Promise((resolve) => setTimeout(resolve, input.delayMs));
const db = new CommDB(input.dbPath, false);
try {
  const result = db.recordRunnerStopDeclaration({
    executionId: ${JSON.stringify(EXEC_ID)},
    leadId: ${JSON.stringify(LEAD_ID)},
    content: input.content,
    questionId: input.questionId,
    derivedAtMs: input.derivedAtMs,
  });
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
} finally {
  db.close();
}
`,
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const maybe = existsSync(DIST_DB) ? it : it.skip;
	const content = (detail: string) =>
		`RUNNER-STOPPED kind=runner_stopped reason=done issue=FLY-2017 exec=${EXEC_ID} route=- detail=${detail}`;
	const qid = (digit: string) => `rstop-${digit.repeat(32)}`;

	maybe(
		"serializes identical content to one sent edge without SQLITE_BUSY",
		async () => {
			const startAtMs = Date.now() + 400;
			const outcomes = await Promise.all(
				["1", "2", "3", "4", "5", "6"].map((digit) =>
					runWorker(workerPath, {
						dbPath,
						content: content("quiet-wait"),
						questionId: qid(digit),
						derivedAtMs: 100,
						startAtMs,
					}),
				),
			);
			expect(outcomes.every(({ code }) => code === 0)).toBe(true);
			expect(outcomes.map(({ stderr }) => stderr).join("\n")).not.toMatch(
				/SQLITE_BUSY|locked/i,
			);
			expect(
				outcomes.filter(({ result }) => result?.status === "sent"),
			).toHaveLength(1);
			expect(
				outcomes.filter(({ result }) => result?.status === "duplicate"),
			).toHaveLength(5);

			const raw = new Database(dbPath, { readonly: true });
			expect(
				raw
					.prepare("SELECT COUNT(*) AS count FROM runner_stop_declarations")
					.get(),
			).toEqual({ count: 1 });
			expect(
				raw
					.prepare(
						"SELECT COUNT(*) AS count FROM mailbox WHERE kind = 'report'",
					)
					.get(),
			).toEqual({ count: 1 });
			raw.close();
		},
		20_000,
	);

	maybe(
		"rejects an older derivation that commits after the newer edge",
		async () => {
			const startAtMs = Date.now() + 300;
			const [older, newer] = await Promise.all([
				runWorker(workerPath, {
					dbPath,
					content: content("older"),
					questionId: qid("a"),
					derivedAtMs: 100,
					startAtMs,
					delayMs: 150,
				}),
				runWorker(workerPath, {
					dbPath,
					content: content("newer"),
					questionId: qid("b"),
					derivedAtMs: 200,
					startAtMs,
				}),
			]);
			expect([older.code, newer.code]).toEqual([0, 0]);
			expect(older.result).toMatchObject({
				status: "stale",
				contentMatched: false,
				questionId: qid("b"),
			});
			expect(newer.result?.status).toBe("sent");
			const check = new CommDB(dbPath, false);
			expect(check.getMessageById(qid("a"))).toBeUndefined();
			expect(check.getMessageById(qid("b"))?.content).toContain("detail=newer");
			check.close();
		},
		20_000,
	);

	maybe(
		"keeps an undelivered older edge when the newer derivation commits second",
		async () => {
			const startAtMs = Date.now() + 300;
			const [older, newer] = await Promise.all([
				runWorker(workerPath, {
					dbPath,
					content: content("older"),
					questionId: qid("c"),
					derivedAtMs: 100,
					startAtMs,
				}),
				runWorker(workerPath, {
					dbPath,
					content: content("newer"),
					questionId: qid("d"),
					derivedAtMs: 200,
					startAtMs,
					delayMs: 150,
				}),
			]);
			expect([older.result?.status, newer.result?.status]).toEqual([
				"sent",
				"sent",
			]);
			const check = new CommDB(dbPath, false);
			expect(check.getPendingQuestions(LEAD_ID).map(({ id }) => id)).toEqual([
				qid("c"),
				qid("d"),
			]);
			check.close();
		},
		20_000,
	);
});
