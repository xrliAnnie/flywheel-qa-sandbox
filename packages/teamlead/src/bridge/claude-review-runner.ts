/**
 * FLY-1188 §7.2 — Claude reviewer subprocess (the cross-family reviewer for
 * codex-authored work).
 *
 * Spawns `claude -p <prompt> --session-id <uuid>|--resume <uuid>
 * --output-format json --model <model>` once per review round. Every round
 * carries its full prompt (R1 = complete contract; R2+ = delta + prior
 * findings); rerounds resume the same session so Claude keeps its read of the
 * codebase.
 *
 * Failure semantics (§7.2, fail-close): anything that is not a parseable
 * structured verdict — spawn failure, timeout, non-zero exit, refusal,
 * malformed JSON — is `kind: "failed"`, NEVER a verdict. The caller keeps the
 * review gate closed and alerts the Lead; recovery is a same-requestId retry
 * or the sanctioned codex-skip governance path. A missing reviewer must never
 * silently become a same-family pass.
 *
 * Process hygiene (watchdog-judge precedent): detached process group so
 * timeout/shutdown kills the WHOLE tree; stdin closed immediately (a `-p`
 * child left with an open stdin pipe can hang forever); stdout bounded.
 * Live children are registered so Bridge shutdown can kill them all.
 */

import { spawn } from "node:child_process";
import { washJudgeEnv } from "./watchdog-judge.js";

export interface ClaudeReviewFinding {
	severity?: string;
	file?: string;
	line?: number;
	title?: string;
	detail?: string;
}

export type ClaudeReviewOutcome =
	| {
			kind: "verdict";
			verdict: "APPROVED" | "CHANGES_REQUESTED";
			findings: ClaudeReviewFinding[];
			reviewedHeadSha: string | null;
			/** Raw assistant text the verdict was parsed from (audit copy). */
			raw: string;
	  }
	| {
			kind: "failed";
			reason:
				| "spawn_error"
				| "timeout"
				| "nonzero_exit"
				| "stdout_overflow"
				| "no_verdict";
			detail: string;
			exitCode: number | null;
			timedOut: boolean;
			raw?: string;
	  };

export interface ClaudeReviewInvocation {
	/** Full prompt for THIS round (every round is self-contained). */
	prompt: string;
	/** Review-session uuid — `--session-id` on round 1, `--resume` after. */
	sessionId: string;
	/** true = reround (`--resume`), false = first round (`--session-id`). */
	resume: boolean;
	/** Fixed working directory (the reviewed repo / worktree). */
	cwd: string;
	model?: string;
	timeoutMs?: number;
	maxStdoutBytes?: number;
	env?: NodeJS.ProcessEnv;
	binary?: string;
}

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_TIMEOUT_MS = 30 * 60_000; // §7.2: 30min per round
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1_048_576; // 8MB

/** Live children (pid → kill fn) so Bridge shutdown can reap every reviewer. */
const liveChildren = new Map<number, () => void>();

export function killAllClaudeReviewChildren(): number {
	const n = liveChildren.size;
	for (const kill of liveChildren.values()) kill();
	liveChildren.clear();
	return n;
}

export function buildClaudeReviewArgv(
	inv: Pick<ClaudeReviewInvocation, "prompt" | "sessionId" | "resume"> & {
		model?: string;
	},
): string[] {
	return [
		"-p",
		inv.prompt,
		inv.resume ? "--resume" : "--session-id",
		inv.sessionId,
		"--output-format",
		"json",
		"--model",
		inv.model ?? DEFAULT_MODEL,
	];
}

interface SpawnResult {
	code: number | null;
	stdout: string;
	timedOut: boolean;
	overflowed: boolean;
	spawnError: string | null;
}

export type ClaudeReviewSpawner = (opts: {
	binary: string;
	argv: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	maxStdoutBytes: number;
}) => Promise<SpawnResult>;

/** Real spawner — never rejects; every failure lands in the result shape. */
export const defaultClaudeReviewSpawner: ClaudeReviewSpawner = (opts) =>
	new Promise((resolve) => {
		let stdout = "";
		let done = false;
		let timedOut = false;
		let overflowed = false;
		let spawnError: string | null = null;
		const child = spawn(opts.binary, opts.argv, {
			cwd: opts.cwd,
			stdio: ["pipe", "pipe", "ignore"],
			env: opts.env,
			detached: true, // own group → tree kill reaps grandchildren
		});
		const killTree = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already dead */
				}
			}
		};
		if (child.pid) liveChildren.set(child.pid, killTree);
		const finish = (code: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (child.pid) liveChildren.delete(child.pid);
			resolve({ code, stdout, timedOut, overflowed, spawnError });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, opts.timeoutMs);
		let stdoutBytes = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
			stdoutBytes += chunk.length; // real BYTES (R12 LOW: not code units)
			if (stdoutBytes > opts.maxStdoutBytes) {
				overflowed = true;
				killTree();
			}
		});
		child.on("error", (err) => {
			spawnError = err instanceof Error ? err.message : String(err);
			finish(127);
		});
		child.on("close", (code) => finish(code));
		try {
			// -p mode must not be left waiting on stdin (classifier precedent)
			child.stdin.end();
		} catch {
			/* close event carries the failure */
		}
	});

/**
 * Extract the structured verdict from the claude CLI output.
 *
 * `--output-format json` wraps the assistant text in a result envelope
 * (`{"type":"result","result":"<text>",...}`); the verdict JSON object lives
 * inside that text (optionally fenced). Tolerant extraction, strict
 * validation: anything that does not yield a well-formed verdict object with
 * a recognized `verdict` value is NOT a verdict (fail-close).
 */
export function parseClaudeReviewOutput(stdout: string): {
	verdict: "APPROVED" | "CHANGES_REQUESTED";
	findings: ClaudeReviewFinding[];
	reviewedHeadSha: string | null;
	raw: string;
} | null {
	let text = stdout.trim();
	// unwrap the CLI json envelope when present. R12/R13 HIGH: anything
	// envelope-SHAPED (an object carrying a string `result`) must match the
	// REAL success schema exactly — type "result", subtype "success", not
	// is_error, no api_error_status — or it is NOT a verdict, even if the
	// error text happens to contain verdict JSON. A bare verdict object (no
	// `result` field) is a separate format and falls through to extraction.
	try {
		const envelope = JSON.parse(text) as {
			type?: unknown;
			subtype?: unknown;
			is_error?: unknown;
			api_error_status?: unknown;
			result?: unknown;
		};
		if (
			envelope &&
			typeof envelope === "object" &&
			typeof envelope.result === "string"
		) {
			if (
				envelope.type !== "result" ||
				envelope.subtype !== "success" ||
				envelope.is_error === true ||
				// R14: null and undefined both mean "no API error" (matches the
				// classifier-runner precedent); any other value is an error.
				envelope.api_error_status != null
			) {
				return null;
			}
			text = envelope.result.trim();
		}
	} catch {
		/* not an envelope — treat stdout as assistant text */
	}
	const candidate = extractJsonObject(text);
	if (!candidate) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const obj = parsed as Record<string, unknown>;
	const verdictRaw =
		typeof obj.verdict === "string" ? obj.verdict.toUpperCase() : null;
	if (verdictRaw !== "APPROVED" && verdictRaw !== "CHANGES_REQUESTED") {
		return null;
	}
	const findings: ClaudeReviewFinding[] = Array.isArray(obj.findings)
		? obj.findings.filter(
				(f): f is ClaudeReviewFinding => typeof f === "object" && f !== null,
			)
		: [];
	const reviewedHeadSha =
		typeof obj.reviewedHeadSha === "string" && obj.reviewedHeadSha.length > 0
			? obj.reviewedHeadSha.toLowerCase()
			: null;
	return { verdict: verdictRaw, findings, reviewedHeadSha, raw: text };
}

/** Find the outermost {...} block in assistant text (handles code fences). */
function extractJsonObject(text: string): string | null {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fence?.[1] ?? text;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	return body.slice(start, end + 1);
}

export interface RunClaudeReviewDeps {
	spawner?: ClaudeReviewSpawner;
	logger?: (msg: string) => void;
}

/** Run ONE review round. Never throws; every failure is a fail-close outcome. */
export async function runClaudeReviewRound(
	inv: ClaudeReviewInvocation,
	deps: RunClaudeReviewDeps = {},
): Promise<ClaudeReviewOutcome> {
	const spawner = deps.spawner ?? defaultClaudeReviewSpawner;
	const logger =
		deps.logger ?? ((m: string) => console.log(`[claude-review] ${m}`));
	const argv = buildClaudeReviewArgv(inv);
	const res = await spawner({
		binary: inv.binary ?? "claude",
		argv,
		cwd: inv.cwd,
		// Codex full-PR review HIGH-5: the reviewer is a model-driven claude
		// subprocess that actively explores the author's worktree — it must NOT
		// inherit the Bridge's third-party creds (Discord/Linear/DB/API keys).
		// Wash them out (washJudgeEnv precedent). Claude auth is CLAUDE_CONFIG_DIR
		// (kept — not secret-shaped); the worktree's git credential helper covers
		// git; the diff is local (git diff in-worktree). The coordinator collects
		// the reviewer's stdout, so it needs no FLYWHEEL_ posting token.
		env: washJudgeEnv(inv.env ?? process.env),
		timeoutMs: inv.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		maxStdoutBytes: inv.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
	});
	if (res.spawnError !== null) {
		logger(`spawn failed: ${res.spawnError}`);
		return {
			kind: "failed",
			reason: "spawn_error",
			detail: res.spawnError,
			exitCode: res.code,
			timedOut: false,
		};
	}
	if (res.timedOut) {
		logger(`review round timed out (session ${inv.sessionId})`);
		return {
			kind: "failed",
			reason: "timeout",
			detail: `timed out after ${inv.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
			exitCode: res.code,
			timedOut: true,
		};
	}
	if (res.overflowed) {
		return {
			kind: "failed",
			reason: "stdout_overflow",
			detail: "reviewer stdout exceeded the bounded buffer",
			exitCode: res.code,
			timedOut: false,
		};
	}
	if (res.code !== 0) {
		return {
			kind: "failed",
			reason: "nonzero_exit",
			detail: `claude exited ${res.code}`,
			exitCode: res.code,
			timedOut: false,
			raw: res.stdout.slice(0, 4000),
		};
	}
	const parsed = parseClaudeReviewOutput(res.stdout);
	if (!parsed) {
		// refusal / malformed output — NOT a verdict (§7.2: never degrade to
		// a same-family pass, never treat reviewer_unavailable as a review)
		return {
			kind: "failed",
			reason: "no_verdict",
			detail: "no parseable structured verdict in reviewer output",
			exitCode: res.code,
			timedOut: false,
			raw: res.stdout.slice(0, 4000),
		};
	}
	return { kind: "verdict", ...parsed };
}
