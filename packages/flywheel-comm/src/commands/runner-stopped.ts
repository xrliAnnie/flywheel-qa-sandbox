import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CommDB } from "../db.js";
import { resolveRunnerStateDir } from "../runner-state.js";
import { truncateCodePoints } from "../text-truncate.js";

export type RunnerStopReason =
	| "done"
	| "blocked"
	| "awaiting_approval"
	| "quota"
	| "context_full"
	| "error";

export type RunnerStopSource =
	| "claude-stop"
	| "claude-stop-failure"
	| "codex-notify";

export interface StopFailureInput {
	error: string;
	errorDetails?: string | null;
	lastAssistantMessage?: string | null;
}

export interface RunnerStoppedArgs {
	dbPath: string;
	execId: string;
	envIssueId?: string;
	source: RunnerStopSource;
	ingressTs: string;
	prevIngress?: string;
	transcriptPath?: string;
	sessionId?: string;
	stopFailure?: StopFailureInput;
	lastMessage?: string;
	turnId?: string;
	stateDir?: string;
	env?: NodeJS.ProcessEnv;
	nowMs?: number;
	derivedAtMs?: number;
	retryDelayMs?: number;
}

export interface RunnerStoppedResult {
	status: "sent" | "duplicate" | "stale";
	questionId: string;
	reason?: RunnerStopReason;
	detail?: string;
	route?: string;
}

interface RunnerIdentity {
	issueId: string;
	leadId: string;
	session: ReturnType<CommDB["getSession"]>;
}

interface TranscriptStopInfo {
	turnId?: string;
	lowerBound?: string;
	lastAssistantMessage?: string;
}

interface CompletionBreadcrumb {
	v: 1;
	completionEventId: string;
	executionId: string;
	issueId: string;
	route: string;
	pr?: number;
	sanitizedSummary?: string;
	createdAt: string;
	consumedPath: string;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALID_ROUTE_RE = /^[a-z][a-z0-9_]{0,63}$/;

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

function validIdentity(value: string | null | undefined): value is string {
	return Boolean(value?.trim() && value.trim() !== "unknown");
}

function resolveIdentityPair(
	execId: string,
	session: ReturnType<CommDB["getSession"]>,
	lineage: ReturnType<CommDB["getSessionReceiptIdentity"]>,
	envIssueId?: string,
): RunnerIdentity | undefined {
	if (!session && !lineage) return undefined;
	if (
		session &&
		lineage &&
		((session.issue_id !== null &&
			lineage.issue_id !== null &&
			session.issue_id !== lineage.issue_id) ||
			(session.lead_id !== null &&
				lineage.lead_id !== null &&
				session.lead_id !== lineage.lead_id))
	) {
		throw new Error(`runner-stopped identity mismatch for ${execId}`);
	}
	const issueId = session?.issue_id ?? lineage?.issue_id;
	const leadId = session?.lead_id ?? lineage?.lead_id;
	if (!validIdentity(issueId) || !validIdentity(leadId)) {
		throw new Error(`runner-stopped identity incomplete for ${execId}`);
	}
	if (!validIdentity(envIssueId) || envIssueId !== issueId) {
		throw new Error(
			`runner-stopped environment identity mismatch for ${execId}`,
		);
	}
	return { issueId, leadId, session };
}

async function resolveIdentity(
	db: CommDB,
	args: RunnerStoppedArgs,
): Promise<RunnerIdentity> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const session = db.getSession(args.execId);
		const lineage = db.getSessionReceiptIdentity(args.execId);
		const resolved = resolveIdentityPair(
			args.execId,
			session,
			lineage,
			args.envIssueId,
		);
		if (resolved) return resolved;
		if (attempt < 2) await sleep(args.retryDelayMs ?? 300);
	}
	const lineage = db.getSessionReceiptIdentity(args.execId);
	const resolved = resolveIdentityPair(
		args.execId,
		undefined,
		lineage,
		args.envIssueId,
	);
	if (!resolved) {
		throw new Error(`runner-stopped identity unavailable for ${args.execId}`);
	}
	return resolved;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(item): item is { type: string; text?: string } =>
				typeof item === "object" && item !== null && "type" in item,
		)
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function pureToolResult(content: unknown): boolean {
	return (
		Array.isArray(content) &&
		content.length > 0 &&
		content.every(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				item.type === "tool_result",
		)
	);
}

function readTranscriptStopInfo(path: string | undefined): TranscriptStopInfo {
	if (!path) return {};
	try {
		const rows = readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line): Array<Record<string, unknown>> => {
				try {
					const value = JSON.parse(line);
					return typeof value === "object" && value !== null ? [value] : [];
				} catch {
					return [];
				}
			});
		let lastAssistantMessage: string | undefined;
		for (let i = rows.length - 1; i >= 0; i -= 1) {
			const row = rows[i]!;
			const message =
				typeof row.message === "object" && row.message !== null
					? (row.message as Record<string, unknown>)
					: {};
			if (!lastAssistantMessage && row.type === "assistant") {
				lastAssistantMessage = textContent(message.content) || undefined;
			}
			if (
				row.type === "user" &&
				row.isMeta !== true &&
				message.isMeta !== true &&
				!pureToolResult(message.content)
			) {
				return {
					turnId: typeof row.uuid === "string" ? row.uuid : undefined,
					lowerBound:
						typeof row.timestamp === "string" ? row.timestamp : undefined,
					lastAssistantMessage,
				};
			}
		}
		return { lastAssistantMessage };
	} catch {
		return {};
	}
}

function validIso(value: string | undefined): value is string {
	return Boolean(
		value &&
			Number.isFinite(Date.parse(value)) &&
			new Date(value).toISOString() === value,
	);
}

function sqliteTimestampMs(value: string): number {
	return Date.parse(
		value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
	);
}

function lowerBoundBefore(
	candidate: string | undefined,
	ingressTs: string,
): string | undefined {
	if (!candidate || !Number.isFinite(sqliteTimestampMs(candidate)))
		return undefined;
	return sqliteTimestampMs(candidate) < Date.parse(ingressTs)
		? candidate
		: undefined;
}

function markerParentSafe(stateDir: string, name: "consumed" | "sent"): string {
	const parent = join(stateDir, name);
	if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
		throw new Error(`runner-stopped ${name} marker directory is a symlink`);
	}
	mkdirSync(parent, { recursive: true });
	return parent;
}

function readCompletion(
	stateDir: string,
	execId: string,
	issueId: string,
): CompletionBreadcrumb | undefined {
	try {
		const path = join(stateDir, "last-complete.json");
		if (!existsSync(path) || statSync(path).size > 65_536) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<
			string,
			unknown
		>;
		if (
			value.v !== 1 ||
			typeof value.completionEventId !== "string" ||
			!UUID_RE.test(value.completionEventId) ||
			value.executionId !== execId ||
			value.issueId !== issueId ||
			typeof value.route !== "string" ||
			!VALID_ROUTE_RE.test(value.route) ||
			typeof value.createdAt !== "string" ||
			!validIso(value.createdAt)
		) {
			return undefined;
		}
		const parent = markerParentSafe(stateDir, "consumed");
		const consumedPath = join(parent, value.completionEventId);
		if (resolve(consumedPath).startsWith(`${resolve(parent)}/`) === false) {
			return undefined;
		}
		if (existsSync(consumedPath)) return undefined;
		return {
			v: 1,
			completionEventId: value.completionEventId,
			executionId: execId,
			issueId,
			route: value.route,
			...(Number.isInteger(value.pr) && Number(value.pr) > 0
				? { pr: Number(value.pr) }
				: {}),
			...(typeof value.sanitizedSummary === "string"
				? { sanitizedSummary: value.sanitizedSummary }
				: {}),
			createdAt: value.createdAt,
			consumedPath,
		};
	} catch (error) {
		console.error(
			`[runner-stopped] ignored malformed completion breadcrumb: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function sanitizeDetail(value: string): string {
	const oneLine = value
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	return truncateCodePoints(oneLine || "no detail", 200).text;
}

function completionReason(breadcrumb: CompletionBreadcrumb): {
	reason: RunnerStopReason;
	detail: string;
	route: string;
} {
	const { route } = breadcrumb;
	if (route === "needs_review") {
		return {
			reason: "awaiting_approval",
			detail: breadcrumb.pr
				? `PR #${breadcrumb.pr} ready, awaiting founder approval`
				: "ready, awaiting founder approval",
			route,
		};
	}
	if (route === "blocked") {
		return {
			reason: "blocked",
			detail: breadcrumb.sanitizedSummary || "runner declared blocked",
			route,
		};
	}
	if (route === "ship_attempt_failed") {
		return {
			reason: "blocked",
			detail: breadcrumb.pr
				? `ship attempt failed, PR #${breadcrumb.pr}`
				: "ship attempt failed",
			route,
		};
	}
	return { reason: "done", detail: `completed via ${route}`, route };
}

function failureReason(failure: StopFailureInput): {
	reason: RunnerStopReason;
	detail: string;
} {
	const error = failure.error.trim() || "unknown";
	const supplement = failure.errorDetails ?? failure.lastAssistantMessage ?? "";
	if (error === "rate_limit") {
		return {
			reason: "quota",
			detail: sanitizeDetail(`${error}: ${supplement}`),
		};
	}
	if (
		error === "invalid_request" &&
		failure.errorDetails?.toLowerCase().includes("prompt is too long")
	) {
		return {
			reason: "context_full",
			detail: sanitizeDetail(`${error}: ${failure.errorDetails}`),
		};
	}
	return { reason: "error", detail: sanitizeDetail(`${error}: ${supplement}`) };
}

function codexMessageReason(
	message: string | undefined,
): { reason: RunnerStopReason; detail: string } | undefined {
	if (!message) return undefined;
	if (
		/\b(rate limit|usage limit|quota exceeded|too many requests)\b/i.test(
			message,
		)
	) {
		return { reason: "quota", detail: sanitizeDetail(message) };
	}
	if (
		/\b(context window|context length|context full|prompt is too long)\b/i.test(
			message,
		)
	) {
		return { reason: "context_full", detail: sanitizeDetail(message) };
	}
	return undefined;
}

function createMarker(path: string): void {
	try {
		closeSync(openSync(path, "wx"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			console.error(
				`[runner-stopped] marker write failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function markSent(stateDir: string, turnHash: string): void {
	try {
		const parent = markerParentSafe(stateDir, "sent");
		createMarker(join(parent, turnHash));
		const entries = readdirSync(parent)
			.map((name) => ({ name, mtime: statSync(join(parent, name)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		for (const old of entries.slice(50)) unlinkSync(join(parent, old.name));
	} catch (error) {
		console.error(
			`[runner-stopped] sent marker maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function runnerStopped(
	args: RunnerStoppedArgs,
): Promise<RunnerStoppedResult> {
	if (!validIso(args.ingressTs)) {
		throw new Error("runner-stopped --ingress-ts must be strict UTC ISO");
	}
	const db = new CommDB(args.dbPath, false);
	try {
		const identity = await resolveIdentity(db, args);
		const transcript = readTranscriptStopInfo(args.transcriptPath);
		const anchoredTurn =
			args.source === "codex-notify"
				? args.turnId
				: (transcript.turnId ?? args.turnId);
		if (args.source === "codex-notify" && !anchoredTurn) {
			throw new Error("runner-stopped Codex source requires --turn-id");
		}
		const turnKey = anchoredTurn
			? `${args.source}:${args.sessionId ?? args.execId}:${anchoredTurn}`
			: `${args.source}:unanchored:${randomUUID()}`;
		const turnHash = createHash("sha256")
			.update(`${args.execId}\0${turnKey}`)
			.digest("hex");
		const questionId = `rstop-${turnHash.slice(0, 32)}`;
		const stateDir =
			args.stateDir ??
			resolveRunnerStateDir(args.execId, args.env ?? process.env);
		const breadcrumb = readCompletion(stateDir, args.execId, identity.issueId);
		let usedCompletionBreadcrumb = false;
		let reasonDetail:
			| { reason: RunnerStopReason; detail: string; route?: string }
			| undefined;
		let stateKey: string | undefined;
		if (args.source === "claude-stop-failure" && args.stopFailure) {
			reasonDetail = failureReason(args.stopFailure);
			stateKey = `stop_failure\0${args.stopFailure.error.trim() || "unknown"}\0${reasonDetail.reason}`;
		} else if (breadcrumb) {
			reasonDetail = completionReason(breadcrumb);
			stateKey = `completion\0${breadcrumb.completionEventId}\0${breadcrumb.route}\0${breadcrumb.pr ?? "-"}`;
			usedCompletionBreadcrumb = true;
		} else if (identity.session?.status === "completed") {
			reasonDetail = { reason: "done", detail: "session terminal" };
			stateKey = "session\0completed";
		} else if (identity.session?.status === "blocked") {
			reasonDetail = { reason: "blocked", detail: "session blocked" };
			stateKey = "session\0blocked";
		} else if (
			identity.session?.status === "failed" ||
			identity.session?.status === "timeout"
		) {
			reasonDetail = {
				reason: "error",
				detail: `session ${identity.session.status}`,
			};
			stateKey = `session\0${identity.session.status}`;
		}

		if (!reasonDetail) {
			const ingress = args.ingressTs;
			const anchorLower =
				args.source === "codex-notify"
					? undefined
					: lowerBoundBefore(transcript.lowerBound, ingress);
			const prevLower = lowerBoundBefore(args.prevIngress, ingress);
			const sessionLower = identity.session?.started_at
				? lowerBoundBefore(identity.session.started_at, ingress)
				: undefined;
			const lowerBound = anchorLower ?? prevLower ?? sessionLower;
			const pending = db.getPendingRunnerQuestion(
				args.execId,
				identity.leadId,
				lowerBound,
			);
			if (pending) {
				if (pending.checkpoint) {
					reasonDetail = {
						reason: "awaiting_approval",
						detail: `waiting on gate ${pending.id}`,
					};
					stateKey = `pending_gate\0${pending.id}\0${pending.checkpoint}`;
				} else {
					reasonDetail = {
						reason: "blocked",
						detail: `waiting on answer to ${pending.id}`,
					};
					stateKey = `pending_question\0${pending.id}`;
				}
			}
		}

		if (!reasonDetail) {
			const declared = db.getEffectiveDeclaredState(
				args.execId,
				args.nowMs ?? Date.now(),
			);
			if (declared?.kind === "parked") {
				reasonDetail = {
					reason: "done",
					detail: `parked${declared.reason ? `: ${declared.reason}` : ""}`,
				};
				stateKey = "declared\0parked";
			}
		}

		const lastMessage =
			args.lastMessage ??
			args.stopFailure?.lastAssistantMessage ??
			transcript.lastAssistantMessage;
		if (!reasonDetail) {
			const classified =
				args.source === "codex-notify"
					? codexMessageReason(lastMessage)
					: undefined;
			if (classified) {
				reasonDetail = classified;
				stateKey = `codex_classification\0${classified.reason}`;
			} else {
				reasonDetail = {
					reason: "blocked",
					detail: lastMessage
						? `idle without declared completion: ${lastMessage}`
						: "idle without declared completion",
				};
				stateKey = "fallback\0idle_without_declared_completion";
			}
		}
		if (!stateKey) throw new Error("runner-stopped state key unavailable");
		const detail = sanitizeDetail(reasonDetail.detail);
		const route = reasonDetail.route;
		const content =
			`RUNNER-STOPPED kind=runner_stopped reason=${reasonDetail.reason} ` +
			`issue=${identity.issueId} exec=${args.execId} route=${route ?? "-"} detail=${detail}`;

		let contentMatched = true;
		let status: RunnerStoppedResult["status"] = "sent";
		let resultQuestionId = questionId;
		try {
			const declaration = db.recordRunnerStopDeclaration({
				executionId: args.execId,
				leadId: identity.leadId,
				stateKey,
				content,
				questionId,
				derivedAtMs: args.derivedAtMs ?? Date.now(),
			});
			status = declaration.status;
			resultQuestionId = declaration.questionId;
			contentMatched = declaration.contentMatched;
		} catch (error) {
			const existing = db.getMessageById(questionId);
			const expectedConflict =
				(error instanceof Error &&
					error.message ===
						`deterministic question identity conflict: ${questionId}`) ||
				((error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT") &&
					error instanceof Error &&
					error.message.includes("UNIQUE constraint failed: mailbox.id"));
			if (!expectedConflict || !existing || existing.kind !== "report")
				throw error;
			contentMatched =
				existing.from_agent === args.execId &&
				existing.to_agent === identity.leadId &&
				existing.content === content;
			status = "duplicate";
		}

		markSent(stateDir, turnHash);
		if (breadcrumb && usedCompletionBreadcrumb && contentMatched) {
			createMarker(breadcrumb.consumedPath);
		}
		return {
			status,
			questionId: resultQuestionId,
			reason: reasonDetail.reason,
			detail,
			...(route ? { route } : {}),
		};
	} finally {
		db.close();
	}
}
