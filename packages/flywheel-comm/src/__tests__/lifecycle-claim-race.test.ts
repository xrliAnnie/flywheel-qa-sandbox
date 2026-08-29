/**
 * FLY-245 D-b / Codex code-review R1 LOW-11 (R2: still not closed) — a TRUE
 * cross-PROCESS race on `claimLifecycleConsent`. better-sqlite3 is synchronous
 * and single-threaded per process, so two sequential calls in one JS thread only
 * prove the SQL predicate, not contention. This spawns N independent OS
 * processes CONCURRENTLY that each open the SAME db file and race to claim the
 * SAME question, synchronized on a shared wall-clock start barrier. SQLite's
 * `UPDATE ... WHERE resolved_at IS NULL` + `changes===1` must yield EXACTLY ONE
 * winner — the irreversible lifecycle action is authorized at most once.
 *
 * Uses the BUILT dist (`dist/db.js`) so the child `node` workers need no TS
 * loader; skips if the dist isn't present.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
// packages/flywheel-comm/src/__tests__ → packages/flywheel-comm/dist/db.js
const DIST_DB = join(TEST_DIR, "..", "..", "dist", "db.js");

/** Launch one worker (async) and resolve with its trimmed stdout. */
function runWorker(workerPath: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [workerPath, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => {
			out += c;
		});
		child.stderr.on("data", (c) => {
			err += c;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`worker exited ${code}: ${err}`));
			else resolve(out.trim());
		});
	});
}

describe("claimLifecycleConsent — true cross-PROCESS race (R1 LOW-11 / R2)", () => {
	let dir: string;
	let dbPath: string;
	let workerPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly245-claim-race-"));
		dbPath = join(dir, "comm.db");
		workerPath = join(dir, "claim-worker.mjs");
		// Each worker: busy-wait to the shared barrier, then claim ONCE → WIN/LOSE.
		writeFileSync(
			workerPath,
			`import { CommDB } from ${JSON.stringify(DIST_DB)};
const [dbPath, qid, checkpoint, startAtMs] = process.argv.slice(2);
while (Date.now() < Number(startAtMs)) { /* spin to the barrier */ }
const db = new CommDB(dbPath);
let won = false;
try { won = db.claimLifecycleConsent(qid, checkpoint); } finally { db.close(); }
process.stdout.write(won ? "WIN" : "LOSE");
`,
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const maybe = existsSync(DIST_DB) ? it : it.skip;

	maybe(
		"exactly ONE of N concurrent processes wins the claim",
		async () => {
			const checkpoint = "runner_lifecycle:terminate";
			const db = new CommDB(dbPath);
			const qid = db.insertQuestion("lead", "founder", "stop FLY-1", {
				checkpoint,
				ttlSeconds: 300,
			});
			db.close();

			const N = 8;
			// Barrier ~400ms out so every child is spawned + spinning before the gun.
			const startAt = Date.now() + 400;
			const outcomes = await Promise.all(
				Array.from({ length: N }, () =>
					runWorker(workerPath, [dbPath, qid, checkpoint, String(startAt)]),
				),
			);
			const wins = outcomes.filter((o) => o === "WIN");
			const loses = outcomes.filter((o) => o === "LOSE");
			expect(wins).toHaveLength(1);
			expect(loses).toHaveLength(N - 1);

			// The question is now durably consumed for everyone (cross-connection).
			const after = new CommDB(dbPath);
			expect(after.claimLifecycleConsent(qid, checkpoint)).toBe(false);
			after.close();
		},
		20_000,
	);
});
