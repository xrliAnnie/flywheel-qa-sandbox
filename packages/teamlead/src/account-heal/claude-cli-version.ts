/**
 * FLY-2864 — the locally installed Claude Code CLI version.
 *
 * The usage endpoint only reports reset grants to a caller that identifies as
 * a current Claude Code CLI, so the account-detail probe declares the version
 * actually installed here instead of a hardcoded one. Read-only: runs
 * `--version` with a hard wall clock and capped output; any failure is null.
 */

import {
	type BoundedRunOptions,
	type BoundedRunResult,
	resolveBinary,
	runBounded,
} from "./opus-model-sync.js";

const VERSION_TIMEOUT_MS = 5_000;
const VERSION_MAX_BYTES = 4_096;
const VERSION = /^(\d{1,4}\.\d{1,4}\.\d{1,6})(?:\s|$)/;

export interface ReadClaudeCliVersionOptions {
	bin?: string;
	run?: (
		bin: string,
		args: readonly string[],
		opts: BoundedRunOptions,
	) => Promise<BoundedRunResult>;
}

export async function readClaudeCliVersion(
	options: ReadClaudeCliVersionOptions = {},
): Promise<string | null> {
	const bin =
		options.bin ?? (process.env.FLYWHEEL_CLAUDE_BIN?.trim() || "claude");
	try {
		const result = await (options.run ?? runBounded)(
			resolveBinary(bin),
			["--version"],
			{ timeoutMs: VERSION_TIMEOUT_MS, maxBytes: VERSION_MAX_BYTES },
		);
		if (
			result.spawnErrorCode !== undefined ||
			result.timedOut ||
			result.overflowed ||
			result.code !== 0
		) {
			return null;
		}
		return VERSION.exec(result.stdout.trim())?.[1] ?? null;
	} catch {
		return null;
	}
}
