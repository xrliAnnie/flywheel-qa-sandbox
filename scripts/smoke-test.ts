#!/usr/bin/env npx tsx
/**
 * Flywheel Smoke Test — real end-to-end verification.
 *
 * Creates a temp git repo with buggy code, then runs the full Flywheel
 * pipeline (DAG → PreHydrator → Blueprint → Claude Code CLI) to fix it.
 *
 * Cost: ~$0.05-0.20 (two small Claude Haiku sessions)
 *
 * Usage (from a REGULAR TERMINAL — not inside Claude Code):
 *   cd /path/to/flywheel
 *   pnpm build
 *   packages/edge-worker/node_modules/.bin/tsx scripts/smoke-test.ts
 *
 * Or if tsx is globally available:
 *   pnpm build && npx tsx scripts/smoke-test.ts
 *
 * Prerequisites:
 *   - `claude` CLI installed and authenticated
 *   - Run from project root (not from inside a Claude Code session)
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Import from compiled dist ──
import { DagResolver } from "../packages/dag-resolver/dist/DagResolver.js";
import { Blueprint } from "../packages/edge-worker/dist/Blueprint.js";
import { PreHydrator } from "../packages/edge-worker/dist/PreHydrator.js";
import { DagDispatcher } from "../packages/edge-worker/dist/DagDispatcher.js";
import { GitResultChecker } from "../packages/edge-worker/dist/GitResultChecker.js";

import type { DagNode } from "../packages/dag-resolver/dist/types.js";
import type {
	FlywheelRunRequest,
	FlywheelRunResult,
	IFlywheelRunner,
} from "../packages/core/dist/flywheel-runner-types.js";

// ── Helpers ──────────────────────────────────────────────────

function log(msg: string) {
	const time = new Date().toLocaleTimeString();
	console.log(`[${time}] ${msg}`);
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

// ── Direct Claude Runner (bypasses ClaudeCodeRunner's env issues) ──

class DirectClaudeRunner implements IFlywheelRunner {
	readonly name = "claude";

	async run(request: FlywheelRunRequest): Promise<FlywheelRunResult> {
		// Use -p (not --print) with json output — proven to work
		const args = [
			"-p", request.prompt,
			"--output-format", "json",
			"--model", "haiku",
			"--max-turns", String(request.maxTurns ?? 5),
			"--permission-mode", "bypassPermissions",
		];

		if (request.maxCostUsd !== undefined) {
			args.push("--max-budget-usd", String(request.maxCostUsd));
		}
		if (request.allowedTools?.length) {
			args.push("--allowedTools", ...request.allowedTools);
		}
		if (request.sessionId) {
			args.push("--resume", request.sessionId);
		}

		log(`  Running claude -p (haiku, max ${request.maxTurns ?? 5} turns, cwd: ${request.cwd})`);
		log(`  Waiting for Claude to fix the code... (no live output in -p mode)`);

		try {
			const stdout = execFileSync("claude", args, {
				cwd: request.cwd,
				encoding: "utf-8",
				timeout: 180_000, // 3 min timeout
				maxBuffer: 10 * 1024 * 1024,
			});

			const json = JSON.parse(stdout.trim());
			const success = !json.is_error && json.subtype === "success";
			log(`  Done: ${success ? "SUCCESS" : json.subtype} — $${(json.total_cost_usd ?? 0).toFixed(4)} — ${json.num_turns ?? 0} turns — ${((json.duration_ms ?? 0) / 1000).toFixed(1)}s`);
			if (json.result) {
				log(`  Claude says: "${json.result.slice(0, 120)}"`);
			}

			return {
				success,
				costUsd: json.total_cost_usd ?? 0,
				sessionId: json.session_id ?? "",
				durationMs: json.duration_ms,
				numTurns: json.num_turns,
				resultText: json.result,
			};
		} catch (error: any) {
			if (error.stdout) {
				try {
					const json = JSON.parse(error.stdout.trim());
					log(`  Partial result: $${(json.total_cost_usd ?? 0).toFixed(4)}`);
					return {
						success: false,
						costUsd: json.total_cost_usd ?? 0,
						sessionId: json.session_id ?? "",
					};
				} catch { /* not JSON */ }
			}
			log(`  ERROR: ${error.message?.slice(0, 100)}`);
			return { success: false, costUsd: 0, sessionId: "" };
		}
	}
}

// ── Setup: create a temp repo with a buggy file ─────────────

function setupTempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-smoke-"));
	log(`Created temp repo: ${dir}`);

	git(["init"], dir);
	git(["config", "user.email", "smoke-test@flywheel.dev"], dir);
	git(["config", "user.name", "Flywheel Smoke Test"], dir);

	writeFileSync(
		join(dir, "math.ts"),
		`/**
 * Calculate the average of an array of numbers.
 */
export function average(numbers: number[]): number {
  const nonZero = numbers.filter(n => n !== 0);
  return nonZero.reduce((sum, n) => sum + n, 0) / numbers.length;
}

/**
 * FizzBuzz
 */
export function fizzBuzz(n: number): string {
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  return String(n);
}
`,
	);

	writeFileSync(
		join(dir, "math.test.ts"),
		`import { average, fizzBuzz } from "./math";

const tests = [
  { name: "average([1,0,3])", actual: average([1, 0, 3]), expected: 2 },
  { name: "average([10,20,30])", actual: average([10, 20, 30]), expected: 20 },
  { name: "fizzBuzz(15)", actual: fizzBuzz(15), expected: "FizzBuzz" },
  { name: "fizzBuzz(3)", actual: fizzBuzz(3), expected: "Fizz" },
  { name: "fizzBuzz(5)", actual: fizzBuzz(5), expected: "Buzz" },
  { name: "fizzBuzz(7)", actual: fizzBuzz(7), expected: "7" },
];

let pass = 0, fail = 0;
for (const t of tests) {
  const ok = t.actual === t.expected;
  console.log(\`\${ok ? "PASS" : "FAIL"} \${t.name} = \${t.actual}\${ok ? "" : \` (expected \${t.expected})\`}\`);
  ok ? pass++ : fail++;
}
console.log(\`\\n\${pass}/\${tests.length} passed\`);
process.exit(fail > 0 ? 1 : 0);
`,
	);

	git(["add", "."], dir);
	git(["commit", "-m", "initial: add buggy math module"], dir);

	log("Created buggy math.ts with 2 bugs");
	return dir;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
	console.log("\n========================================");
	console.log("  Flywheel Smoke Test");
	console.log("========================================\n");

	// 1. Check environment
	if (process.env.CLAUDECODE) {
		console.error("WARNING: Running inside Claude Code session.");
		console.error("The nested claude CLI may hang. Run from a regular terminal instead.\n");
	}

	try {
		const ver = execFileSync("claude", ["--version"], { encoding: "utf-8" }).trim();
		log(`Claude CLI: ${ver}`);
	} catch {
		console.error("ERROR: `claude` CLI not found.");
		process.exit(1);
	}

	// 2. Setup temp repo
	const repoDir = setupTempRepo();

	log("\n--- Before fix ---");
	try {
		execFileSync("npx", ["tsx", "math.test.ts"], { cwd: repoDir, encoding: "utf-8" });
	} catch (e: any) {
		console.log(e.stdout || "(tests failed as expected)");
	}

	// 3. Build DAG
	const nodes: DagNode[] = [
		{ id: "SMOKE-1", blockedBy: [] },
		{ id: "SMOKE-2", blockedBy: ["SMOKE-1"] },
	];
	const resolver = new DagResolver(nodes);
	log(`\nDAG: ${resolver.remaining()} nodes`);
	log(`Ready: [${resolver.getReady().map(n => n.id).join(", ")}]`);
	log(`Blocked: SMOKE-2 (waiting on SMOKE-1)\n`);

	// 4. Wire components
	const runner = new DirectClaudeRunner();

	const issueData: Record<string, { title: string; description: string }> = {
		"SMOKE-1": {
			title: "Fix average() — wrong divisor",
			description:
				"In math.ts, average() divides by numbers.length but should divide by nonZero.length. Fix this one line. Do NOT create new files. Do NOT run git push or create PRs.",
		},
		"SMOKE-2": {
			title: "Fix fizzBuzz() — missing FizzBuzz case",
			description:
				"In math.ts, fizzBuzz() is missing the case for numbers divisible by both 3 AND 5. Add a check for n%15===0 BEFORE the n%3 and n%5 checks. Do NOT create new files. Do NOT run git push or create PRs.",
		},
	};

	const hydrator = new PreHydrator(
		async (id: string) => issueData[id] ?? { title: "Unknown", description: "" },
	);

	const gitChecker = new GitResultChecker(
		async (cmd: string, args: string[], cwd: string) => {
			const result = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
			return { stdout: result };
		},
	);

	const shell = {
		async execFile(cmd: string, args: string[], cwd: string) {
			if (cmd === "tmux") {
				// Ignore tmux kill-window — no tmux in smoke test
				return { stdout: "", exitCode: 0 };
			}
			const result = execFileSync(cmd, args, { cwd, encoding: "utf-8" });
			return { stdout: result, exitCode: 0 };
		},
	};

	const blueprint = new Blueprint(hydrator, gitChecker, () => runner, shell);

	const dispatcher = new DagDispatcher(resolver, blueprint, repoDir, () => ({
		teamName: "test",
		runnerName: "claude",
	}));

	dispatcher.onNodeComplete = async (nodeId, result) => {
		const cost = result.costUsd?.toFixed(4) ?? "N/A";
		log(`[${result.success ? "OK" : "FAIL"}] ${nodeId} — $${cost}`);
	};

	// 5. Dispatch!
	log("Starting Flywheel dispatch...\n");
	const startTime = Date.now();
	const result = await dispatcher.dispatch();
	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

	// 6. Report
	console.log("\n========================================");
	console.log("  Results");
	console.log("========================================\n");
	console.log(`Completed: ${result.completed.join(", ") || "(none)"}`);
	console.log(`Shelved:   ${result.shelved.join(", ") || "(none)"}`);
	console.log(`Halted:    ${result.halted}`);
	console.log(`Time:      ${elapsed}s`);

	// 7. Verify
	console.log("\n--- Final math.ts ---\n");
	console.log(readFileSync(join(repoDir, "math.ts"), "utf-8"));

	console.log("--- After fix ---\n");
	try {
		const out = execFileSync("npx", ["tsx", "math.test.ts"], {
			cwd: repoDir,
			encoding: "utf-8",
			timeout: 10_000,
		});
		console.log(out);
		log("ALL TESTS PASSED — Flywheel works!");
	} catch (e: any) {
		console.log(e.stdout || e.message);
		log("Some tests still failing.");
	}

	console.log("--- Git history ---\n");
	console.log(git(["log", "--oneline"], repoDir));

	console.log(`\nTemp repo: ${repoDir}\n`);
}

main().catch((err) => {
	console.error("Smoke test crashed:", err);
	process.exit(1);
});
