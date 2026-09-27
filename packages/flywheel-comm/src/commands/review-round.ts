/**
 * FLY-2891: write one local Codex review round back to the Bridge.
 *
 * Run by a Claude-author runner immediately after EACH Codex review round
 * (design or code), before editing any file:
 *
 *   flywheel-comm review-round <design|code> --exec-id <id> --round <n>
 *     --verdict APPROVED|CHANGES_REQUESTED --thread <codexThreadId>
 *     [--turn <turnId>] [--findings critical=N,high=N,medium=N,low=N]
 *     [--target <plan-path|pr-url>]
 *
 * The model/effort is read from the Codex rollout for the exact turn (never
 * self-declared). Delivery is one POST with a short timeout; any failure is
 * spooled for the Bridge's resident reconciler and the command still exits 0
 * so the review is never blocked. Exit 2 only for a malformed invocation.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { normalizeOptionalBearer } from "flywheel-config";
import { CODEX_ID_RE, readCodexTurnEvidence } from "../codex-rollout.js";
import {
	reviewRoundSpoolDir,
	writeReviewRoundSpoolRecord,
} from "../review-round-spool.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const POST_TIMEOUT_MS = 1_500;
const FINDING_KEYS = ["critical", "high", "medium", "low"] as const;

export interface ReviewRoundOpts {
	reviewType: string;
	execId: string;
	round: string;
	verdict: string;
	thread: string;
	turn?: string;
	findings?: string;
	target?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	spoolDir?: string;
	log?: (line: string) => void;
	error?: (line: string) => void;
}

class UsageError extends Error {}

function usage(message: string): never {
	throw new UsageError(message);
}

function parseFindings(
	raw: string | undefined,
): Partial<Record<(typeof FINDING_KEYS)[number], number>> | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const out: Partial<Record<(typeof FINDING_KEYS)[number], number>> = {};
	for (const part of raw.split(",")) {
		const [key, value] = part.split("=").map((piece) => piece?.trim());
		if (!key || !(FINDING_KEYS as readonly string[]).includes(key))
			usage(`--findings key must be one of ${FINDING_KEYS.join(", ")}`);
		if (!value || !/^\d{1,5}$/.test(value) || Number(value) > 10_000)
			usage(`--findings ${key} must be an integer from 0 to 10000`);
		out[key as (typeof FINDING_KEYS)[number]] = Number(value);
	}
	return out;
}

function normalizeVerdict(raw: string): "APPROVED" | "CHANGES_REQUESTED" {
	const verdict = raw
		.trim()
		.toUpperCase()
		.replace(/[\s-]+/g, "_");
	if (verdict !== "APPROVED" && verdict !== "CHANGES_REQUESTED")
		usage("--verdict must be APPROVED or CHANGES_REQUESTED");
	return verdict;
}

function git(cwd: string, args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
		{
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		},
	)
		.trim()
		.toLowerCase();
}

function readDesignRequest(
	cwd: string,
	execId: string,
): { requestId?: string; planPath?: string } {
	try {
		const parsed = JSON.parse(
			readFileSync(
				resolvePath(
					cwd,
					".flywheel",
					"runs",
					execId,
					"codex",
					"design-request.json",
				),
				"utf8",
			),
		) as Record<string, unknown>;
		return {
			requestId:
				typeof parsed.requestId === "string" && parsed.requestId.trim()
					? parsed.requestId.trim()
					: undefined,
			planPath:
				typeof parsed.planPath === "string" && parsed.planPath.trim()
					? parsed.planPath.trim()
					: undefined,
		};
	} catch {
		return {};
	}
}

/** Returns the process exit code (0 delivered/spooled, 2 malformed). */
export async function reviewRound(opts: ReviewRoundOpts): Promise<number> {
	const log = opts.log ?? ((line: string) => console.log(line));
	const error = opts.error ?? ((line: string) => console.error(line));
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? process.cwd();
	let body: Record<string, unknown>;
	let receipt: { turnId: string; model?: string; effort?: string };
	try {
		if (opts.reviewType !== "design" && opts.reviewType !== "code")
			usage("review type must be design or code");
		if (!UUID_RE.test(opts.execId ?? "")) usage("--exec-id must be a UUID");
		if (
			!/^\d{1,3}$/.test(opts.round ?? "") ||
			Number(opts.round) < 1 ||
			Number(opts.round) > 200
		)
			usage("--round must be an integer from 1 to 200");
		const round = Number(opts.round);
		const verdict = normalizeVerdict(opts.verdict ?? "");
		if (!CODEX_ID_RE.test(opts.thread ?? ""))
			usage("--thread must be the Codex thread id");
		if (opts.turn !== undefined && !CODEX_ID_RE.test(opts.turn))
			usage("--turn must be a Codex turn id");
		const findings = parseFindings(opts.findings);

		const evidence = readCodexTurnEvidence({
			threadId: opts.thread,
			turnId: opts.turn,
			env,
		});
		let modelFields: Record<string, unknown>;
		let reviewedAt: string;
		if (evidence.ok) {
			receipt = {
				turnId: evidence.evidence.turnId,
				model: evidence.evidence.model,
				effort: evidence.evidence.effort,
			};
			modelFields = {
				modelEvidence: "rollout_turn",
				observedModel: evidence.evidence.model,
				observedEffort: evidence.evidence.effort,
			};
			reviewedAt = evidence.evidence.completedAt;
		} else if (evidence.reason === "ambiguous") {
			usage(
				`a later Codex turn on thread ${opts.thread} is still running; report right after each round or pass --turn <turnId>`,
			);
		} else if (opts.turn) {
			error(
				`[review-round] model evidence unavailable for turn ${opts.turn} (${evidence.reason}); recording without a model`,
			);
			receipt = { turnId: opts.turn };
			modelFields = { modelEvidence: "unavailable" };
			reviewedAt = new Date().toISOString();
		} else {
			usage(
				`cannot identify the Codex turn (${evidence.reason}); pass --turn <turnId>`,
			);
		}

		let objectFields: Record<string, unknown>;
		if (opts.reviewType === "design") {
			const request = readDesignRequest(cwd, opts.execId);
			const planPath = opts.target?.trim() || request.planPath;
			if (!planPath)
				usage(
					"missing plan path: pass --target <plan-path> or run `flywheel-comm stage set design_review --plan <path>` first",
				);
			let blob: string;
			try {
				blob = git(cwd, ["hash-object", "--no-filters", "--", planPath]);
			} catch {
				usage(`cannot hash plan ${planPath}`);
			}
			if (!FULL_SHA_RE.test(blob)) usage(`cannot hash plan ${planPath}`);
			objectFields = {
				...(request.requestId ? { requestId: request.requestId } : {}),
				reviewedTarget: planPath,
				reviewedPlanBlobSha: blob,
			};
		} else {
			let head: string;
			try {
				head = git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
			} catch {
				usage("cannot resolve git HEAD for the code review round");
			}
			if (!FULL_SHA_RE.test(head))
				usage("cannot resolve git HEAD for the code review round");
			objectFields = {
				...(opts.target?.trim() ? { reviewedTarget: opts.target.trim() } : {}),
				reviewedHeadSha: head,
			};
		}
		const projectName = env.FLYWHEEL_PROJECT_NAME?.trim();
		body = {
			kind: "round",
			executionId: opts.execId,
			reviewType: opts.reviewType,
			round,
			verdict,
			codexThreadId: opts.thread,
			codexTurnId: receipt!.turnId,
			...(findings ? { findings } : {}),
			...modelFields!,
			...objectFields,
			reviewedAt: reviewedAt!,
			...(projectName ? { projectName } : {}),
		};
	} catch (caught) {
		if (caught instanceof UsageError) {
			error(`[review-round] ${caught.message}`);
			error(
				"Usage: flywheel-comm review-round <design|code> --exec-id <id> --round <n> --verdict APPROVED|CHANGES_REQUESTED --thread <codexThreadId> [--turn <turnId>] [--findings critical=N,high=N,medium=N,low=N] [--target <plan-path|pr-url>]",
			);
			return 2;
		}
		throw caught;
	}

	const turnLine = `turn=${receipt.turnId} thread=${opts.thread} round=${opts.round}`;
	const delivery = await deliverReviewRecord(body, {
		env,
		fetchImpl: opts.fetchImpl,
		spoolDir: opts.spoolDir,
		error,
	});
	if (delivery.status === "recorded") {
		const response = delivery.response;
		const required =
			typeof response.requiredModel === "string"
				? `${response.requiredModel}/${String(response.requiredEffort)}`
				: "none";
		const match =
			response.modelMatch === true
				? "yes"
				: response.modelMatch === false
					? "no"
					: "unknown";
		log(
			`review round recorded: ${opts.reviewType} r${opts.round} ${String(body.verdict)} model=${receipt.model ?? "unknown"}/${receipt.effort ?? "unknown"} required=${required} match=${match}${response.duplicate ? " (duplicate)" : ""}`,
		);
		if (response.modelMatch === false)
			error(
				`[review-round] WARNING: this round did not run on the required reviewer model (${required}); a final APPROVED from this thread will be rejected by the review gate. Start a fresh thread with --fresh --model ${String(response.requiredModel)} --effort ${String(response.requiredEffort)}.`,
			);
	} else if (delivery.status === "spooled") {
		log("WARN review round not delivered — queued for Bridge pickup");
	}
	log(turnLine);
	return 0;
}

export type ReviewRecordDelivery =
	| { status: "recorded"; response: Record<string, unknown> }
	| { status: "spooled"; path: string }
	| { status: "quarantined"; path: string; reason: string }
	| { status: "unrecorded"; reason: string };

/**
 * One POST to /review-rounds; spool on any recoverable failure, quarantine a
 * Bridge-declared permanent refusal. Shared by `review-round` and the review
 * gate's acceptance write-back. Never throws.
 */
export async function deliverReviewRecord(
	body: Record<string, unknown>,
	opts: {
		env?: NodeJS.ProcessEnv;
		fetchImpl?: typeof fetch;
		spoolDir?: string;
		error?: (line: string) => void;
	} = {},
): Promise<ReviewRecordDelivery> {
	const env = opts.env ?? process.env;
	const error = opts.error ?? ((line: string) => console.error(line));
	const spoolDir = opts.spoolDir ?? reviewRoundSpoolDir(env);
	const bridgeUrl = env.FLYWHEEL_BRIDGE_URL?.trim().replace(/\/+$/, "");
	const token = normalizeOptionalBearer(env.FLYWHEEL_INGEST_TOKEN);
	let lastError: string;
	if (!bridgeUrl) {
		lastError = "FLYWHEEL_BRIDGE_URL not set";
	} else {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
		timer.unref?.();
		try {
			const response = await (opts.fetchImpl ?? globalThis.fetch)(
				`${bridgeUrl}/review-rounds`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				},
			);
			let parsed: Record<string, unknown> = {};
			try {
				const value: unknown = await response.json();
				if (value && typeof value === "object" && !Array.isArray(value))
					parsed = value as Record<string, unknown>;
			} catch {
				/* non-JSON body: classified by status alone */
			}
			if (response.ok) return { status: "recorded", response: parsed };
			const errorType = parsed.errorType;
			const reason =
				typeof parsed.reason === "string"
					? parsed.reason
					: `HTTP ${response.status}`;
			if (
				(response.status === 400 && errorType === "invalid_payload") ||
				(response.status === 409 &&
					(errorType === "conflict" || errorType === "project_mismatch"))
			) {
				error(
					`[review-round] Bridge refused the record (${String(errorType)}): ${reason}`,
				);
				try {
					const path = writeReviewRoundSpoolRecord(spoolDir, body, {
						quarantineReason: `${String(errorType)}: ${reason}`,
					});
					return { status: "quarantined", path, reason };
				} catch (spoolError) {
					return unrecorded(body, spoolError, error);
				}
			}
			lastError = `HTTP ${response.status}: ${reason}`;
		} catch (fetchError) {
			lastError =
				fetchError instanceof Error ? fetchError.message : String(fetchError);
		} finally {
			clearTimeout(timer);
		}
	}
	try {
		const path = writeReviewRoundSpoolRecord(spoolDir, body, { lastError });
		return { status: "spooled", path };
	} catch (spoolError) {
		return unrecorded(body, spoolError, error);
	}
}

function unrecorded(
	body: Record<string, unknown>,
	spoolError: unknown,
	error: (line: string) => void,
): ReviewRecordDelivery {
	const reason =
		spoolError instanceof Error ? spoolError.message : String(spoolError);
	error(
		`[review-round] UNRECORDED: Bridge delivery failed and the spool write failed (${reason}); record follows so it can be replayed:`,
	);
	error(JSON.stringify(body));
	return { status: "unrecorded", reason };
}
