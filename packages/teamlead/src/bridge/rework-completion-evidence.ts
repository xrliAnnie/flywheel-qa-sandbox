/**
 * FLY-2921 C7 (FLY-2202 / FLY-2472): server-side evidence that a rework
 * completion carries a new commit with a product change.
 *
 * The Bridge computes this once per completion, from the already-captured
 * immutable `completionHead`, and hands it to the StateStore transition. Two
 * independent facts are reported:
 *
 * - `headSource`: whether the server could resolve the completion head at all;
 * - `delta`: whether `git diff <base> <head>` contains at least one path that
 *   is not a progress ledger (`engineering/doc/<slug>/progress.md`).
 *
 * The ledger is excluded at the Git pathspec layer, so "200 progress files
 * followed by one product file" can never read as zero. Any diff failure,
 * timeout, or an output budget exhausted before one complete NUL-terminated
 * path was seen is `unverified` — never a silent "no change".
 */
import { execFile } from "node:child_process";
import type {
	WorkflowReworkCompletionDelta,
	WorkflowReworkCompletionEvidence,
} from "../StateStore.js";

export const REWORK_LEDGER_EXCLUDE_PATHSPEC =
	":(exclude)engineering/doc/*/progress.md";

export const DEFAULT_REWORK_DELTA_TIMEOUT_MS = 15_000;
/** Enough for tens of thousands of paths; one qualifying path is all we need. */
export const DEFAULT_REWORK_DELTA_MAX_BUFFER_BYTES = 1024 * 1024;

const GIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Operator-tunable diff timeout (`FLYWHEEL_REWORK_DELTA_TIMEOUT_MS`). Only a
 * positive safe integer is honoured; anything else keeps the default.
 */
export function reworkDeltaTimeoutMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env.FLYWHEEL_REWORK_DELTA_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_REWORK_DELTA_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_REWORK_DELTA_TIMEOUT_MS;
}

/**
 * Classify `git diff --name-only -z <base> <head>` minus the progress ledger.
 * Resolves (never rejects): every failure mode is `unverified`.
 */
export function classifyReworkProductDelta(input: {
	repoPath: string;
	baseRevision: string;
	head: string;
	timeoutMs?: number;
	maxBufferBytes?: number;
}): Promise<WorkflowReworkCompletionDelta> {
	const base = input.baseRevision.trim().toLowerCase();
	const head = input.head.trim().toLowerCase();
	if (!GIT_SHA.test(base) || !GIT_SHA.test(head)) {
		return Promise.resolve("unverified");
	}
	return new Promise((resolve) => {
		execFile(
			"git",
			[
				"-C",
				input.repoPath,
				"diff",
				"--name-only",
				"-z",
				base,
				head,
				"--",
				".",
				REWORK_LEDGER_EXCLUDE_PATHSPEC,
			],
			{
				timeout: input.timeoutMs ?? DEFAULT_REWORK_DELTA_TIMEOUT_MS,
				maxBuffer:
					input.maxBufferBytes ?? DEFAULT_REWORK_DELTA_MAX_BUFFER_BYTES,
				encoding: "buffer",
				windowsHide: true,
			},
			(error, stdout) => {
				const output = Buffer.isBuffer(stdout)
					? stdout
					: Buffer.from(stdout ?? "");
				// One complete NUL-terminated path outside the ledger proves a
				// product change even when the process was killed for exceeding
				// the output budget afterwards.
				if (output.indexOf(0) > 0) {
					resolve("product_change");
					return;
				}
				if (error) {
					// Timeout, missing object, truncation with zero complete entries,
					// or any other failure: the delta cannot be asserted either way.
					resolve("unverified");
					return;
				}
				resolve("ledger_only");
			},
		);
	});
}

/**
 * Build the evidence for one completion. `head` is the server-captured
 * immutable completion head (or undefined when the server could not resolve
 * it); `repoPath` is the repository the head was resolved in.
 */
export async function buildReworkCompletionEvidence(input: {
	requestId: string;
	baseRevision: string;
	head: string | undefined;
	repoPath: string | undefined;
	timeoutMs?: number;
}): Promise<WorkflowReworkCompletionEvidence> {
	const head = input.head?.trim().toLowerCase();
	if (!head || !GIT_SHA.test(head)) {
		return {
			requestId: input.requestId,
			baseRevision: input.baseRevision,
			headSource: "unresolved",
			delta: "unverified",
		};
	}
	const base = input.baseRevision.trim().toLowerCase();
	const delta =
		input.repoPath && GIT_SHA.test(base)
			? await classifyReworkProductDelta({
					repoPath: input.repoPath,
					baseRevision: base,
					head,
					...(input.timeoutMs !== undefined
						? { timeoutMs: input.timeoutMs }
						: {}),
				})
			: "unverified";
	return {
		requestId: input.requestId,
		baseRevision: input.baseRevision,
		head,
		headSource: "server",
		delta,
	};
}
