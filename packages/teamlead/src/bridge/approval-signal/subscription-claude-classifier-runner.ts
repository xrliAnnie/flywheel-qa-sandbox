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

/**
 * FLY-1099 §7.3: manual Promise wrapper (NOT promisify) so we hold the child
 * handle and can `stdin.end()` IMMEDIATELY — `claude -p` sees an open stdin
 * pipe and waits 3s for data ("Warning: no stdin data received in 3s"),
 * which on a loaded machine ate a real chunk of the 20s budget and produced
 * tonight's `tier3_runner_failed` exec timeouts.
 */
const execFileAsync = (
	file: string,
	args: string[],
	options: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> =>
	new Promise((resolve, reject) => {
		const child = execFile(file, args, options, (err, stdout, stderr) =>
			err
				? reject(err)
				: resolve({ stdout: String(stdout), stderr: String(stderr) }),
		);
		child.stdin?.end();
	});

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
	/** FLY-1099 §7.3: delay before the single transient-failure retry (test: 0). */
	retryDelayMs?: number;
}

const DEFAULT_RETRY_DELAY_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** ENOENT (CLI missing) is permanent — a retry cannot help. */
function isPermanentExecError(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
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

	const execArgs: [string, string[], Record<string, unknown>] = [
		bin,
		["-p", prompt, "--model", model, "--output-format", "json"],
		{
			timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
			cwd: opts.cwd,
			env: opts.env,
		},
	];
	let stdout: string;
	try {
		stdout = (await run(...execArgs)).stdout;
	} catch (err) {
		// FLY-1099 §7.3: ONE transient retry after a short delay (tonight's 529 /
		// swap-storm windows produced flappy spawns); ENOENT is permanent — the
		// CLI is missing, retrying cannot help. Still fail-closed on the retry.
		if (isPermanentExecError(err)) {
			return { ok: false, reason: `exec_failed:${(err as Error).message}` };
		}
		await sleep(opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
		try {
			stdout = (await run(...execArgs)).stdout;
		} catch (retryErr) {
			// timeout / nonzero exit / login prompt / any throw — fail-closed
			return {
				ok: false,
				reason: `exec_failed:${(retryErr as Error).message}`,
			};
		}
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
