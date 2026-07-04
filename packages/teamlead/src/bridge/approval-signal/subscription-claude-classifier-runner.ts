/**
 * FLY-799 Part A-3 — SubscriptionClaudeClassifierRunner.
 *
 * The fail-closed process seam for the on-demand headless Haiku classifier
 * (Codex R7 #2 / Annie: on subscription, not paid API). Runs one-shot
 * `claude -p <prompt> --model <haiku> --output-format json` via `execFile`
 * (NO shell), parses the Claude Code result envelope, and returns the model's
 * verdict JSON. It is NOT a persistent daemon — one spawn per classification,
 * exits immediately.
 *
 * Fail-closed contract: EVERY failure — exec error / timeout / CLI missing /
 * login required / rate limit / `is_error` envelope / unparseable envelope /
 * unparseable verdict — returns `{ ok: false }`. It NEVER throws and NEVER
 * fail-opens, so the caller degrades to "unclear" → WAKE-only (no approval).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Default subscription model (Haiku, model-tiers trivial, verified on-sub). */
export const DEFAULT_CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 1_000_000; // 1 MB

export type RunnerResult =
	| { ok: true; verdict: unknown }
	| { ok: false; reason: string };

/** Injectable execFile (promise form) for tests; matches promisify(execFile). */
export type ExecFileAsync = (
	file: string,
	args: string[],
	options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

export interface SubscriptionClassifierOpts {
	model?: string;
	/** Resolved `claude` binary path (production wires the real path). */
	claudeBin?: string;
	timeoutMs?: number;
	maxBuffer?: number;
	/** Fixed cwd for the child (no ambient state). */
	cwd?: string;
	/** Minimal env for the child (subscription auth via CLAUDE_CONFIG_DIR/HOME). */
	env?: NodeJS.ProcessEnv;
	/** Test seam. */
	execFileImpl?: ExecFileAsync;
}

/** Strip an optional ```json / ``` fence around a JSON payload. */
function defence(text: string): string {
	const t = text.trim();
	const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
	return (m ? (m[1] as string) : t).trim();
}

export async function runSubscriptionClassifier(
	prompt: string,
	opts: SubscriptionClassifierOpts = {},
): Promise<RunnerResult> {
	const run = opts.execFileImpl ?? (execFileAsync as unknown as ExecFileAsync);
	const bin = opts.claudeBin ?? "claude";
	const model = opts.model ?? DEFAULT_CLASSIFIER_MODEL;

	let stdout: string;
	try {
		const out = await run(
			bin,
			["-p", prompt, "--model", model, "--output-format", "json"],
			{
				timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
				cwd: opts.cwd,
				env: opts.env,
			},
		);
		stdout = out.stdout;
	} catch (err) {
		// timeout / nonzero exit / ENOENT (CLI missing) / login prompt / any throw
		return { ok: false, reason: `exec_failed:${(err as Error).message}` };
	}

	// Parse the Claude Code result envelope.
	let envelope: {
		is_error?: boolean;
		subtype?: string;
		api_error_status?: unknown;
		result?: unknown;
	};
	try {
		envelope = JSON.parse(stdout);
	} catch {
		return { ok: false, reason: "envelope_unparseable" };
	}
	if (
		envelope.is_error === true ||
		envelope.subtype !== "success" ||
		(envelope.api_error_status !== null &&
			envelope.api_error_status !== undefined) ||
		typeof envelope.result !== "string"
	) {
		return { ok: false, reason: "claude_error" };
	}

	// Extract the model's verdict JSON from the (possibly fenced) result text.
	try {
		const verdict = JSON.parse(defence(envelope.result));
		return { ok: true, verdict };
	} catch {
		return { ok: false, reason: "verdict_unparseable" };
	}
}
