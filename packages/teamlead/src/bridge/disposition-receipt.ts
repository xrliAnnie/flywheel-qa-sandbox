/**
 * FLY-1282 Part D: Lead disposition receipts (founder 直令,Lead f2a70f9e).
 *
 * Detection alerts route Lead-only (INV-10). When the Lead disposes of an
 * episode, the pipeline itself — not Lead discretion — posts ONE visible
 * receipt into the founder-facing issue thread. Receipt facts are prepared
 * durably by the disposition routes (StateStore.ackDetectionEscalationWithReceipt /
 * applyStuckDispositionWithReceipts, same transaction as the ack); this module
 * is the single delivery consumer:
 *
 *   - runs on its OWN GatePoller piggyback stage;
 *   - in-process single-flight (the piggyback is fire-and-forget, so
 *     overlapping passes ARE possible) + bounded per-post AbortController
 *     timeout so one hung Discord request can never wedge the queue;
 *   - confirmed-post-only stamping via receipt_id + state='pending' guard —
 *     at-least-once across a crash (same contract as the C3 founder page);
 *   - fair rotation: failures stamp last_attempt_at_ms and fall to the back;
 *     rows older than 7 days expire loudly (the honest give-up).
 *
 * Delivery semantics of the copy: Chinese plain language, no mentions
 * (formatter strips + transport sends allowed_mentions:{parse:[]}), never any
 * pane content.
 */

import type { ProjectEntry } from "../ProjectConfig.js";
import type { DispositionReceiptRow, StateStore } from "../StateStore.js";
// Inventory contract (automated-message-inventory.test.ts): every direct
// Discord text POST sender marks its content as automated.
import { markAutomatedDiscordText } from "./automated-message.js";
import { resolveBotTokenForThread } from "./done-thread-archiver.js";

export const RECEIPT_BATCH_PER_PASS = 5;
export const RECEIPT_EXPIRY_MS = 7 * 24 * 3_600_000;
export const RECEIPT_POST_TIMEOUT_MS = 15_000;
/** Default cadence for the dedicated GatePoller stage (≈60s at 3s ticks). */
export const RECEIPT_TICK_CADENCE = 20;

// ── Copy (prepare-time; delivery never reconstructs semantics) ─────────────

const KIND_LABELS: Record<string, string> = {
	detection_stuck_confirmed: "会话疑似卡死",
	delivery_unconsumed: "指令疑似未消费",
	session_zombie_detected: "僵尸会话(窗口已死仍报 running)",
	session_stuck: "会话疑似卡死",
	fn4_delivery_failure: "Lead 通知投递失败",
};

export function kindLabel(kind: string): string {
	return KIND_LABELS[kind] ?? kind;
}

/** Full explicit + implicit disposition set (R17 #4 / R18 #1). */
const DISPOSITION_LABELS: Record<string, string> = {
	ack: "已接手在处理",
	resolve: "已解决",
	handled_remanaged: "已解决(已重新接管 Runner)",
	dismiss: "判定误报关闭",
	false_positive: "判定误报关闭",
	legitimate_wait: "判定为正常等待",
	needs_founder: "已转呈 founder 决定",
	snooze: "已挂起",
};

/** Strip mention syntax + cap length. Transport-level allowed_mentions is the
 * second line of defense; this keeps the stored content itself clean. */
export function sanitizeReceiptNote(note: string | null | undefined): string {
	if (!note) return "";
	const cleaned = note
		.replace(/<@[!&]?\d+>/g, "＠")
		.replace(/@(everyone|here)/g, "＠$1")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

export function formatDispositionReceipt(input: {
	actorLeadId: string;
	kind: string;
	rawDisposition: string;
	note?: string | null;
	/** Server-clamped snooze expiry (only for disposition=snooze). */
	snoozeUntilMs?: number | null;
}): string {
	let verdict =
		DISPOSITION_LABELS[input.rawDisposition] ?? input.rawDisposition;
	if (input.rawDisposition === "snooze" && input.snoozeUntilMs) {
		verdict = `${verdict}(至 ${new Date(input.snoozeUntilMs).toISOString()})`;
	}
	const note = sanitizeReceiptNote(input.note);
	const noteSuffix = note ? `(${note})` : "";
	return `🧾 处置回执:${input.actorLeadId} 已处理「${kindLabel(input.kind)}」— 判定:${verdict}${noteSuffix}`;
}

// ── Bounded Discord post (self-contained sender; R17 #3 / R18 #4) ──────────

/**
 * POST a thread message with a REAL AbortController timeout (a bare
 * Promise.race would leave the underlying request running — a late POST
 * racing the retry widens the duplicate window). allowed_mentions is empty
 * at the transport layer regardless of content.
 */
export async function postThreadMessage(
	botToken: string,
	threadId: string,
	content: string,
	opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
	const fetchFn = opts.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		opts.timeoutMs ?? RECEIPT_POST_TIMEOUT_MS,
	);
	(timer as { unref?: () => void }).unref?.();
	try {
		const res = await fetchFn(
			`https://discord.com/api/v10/channels/${threadId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: markAutomatedDiscordText(content),
					allowed_mentions: { parse: [] },
				}),
				signal: controller.signal,
			},
		);
		if (!res.ok) {
			throw new Error(`discord post failed: ${res.status}`);
		}
	} finally {
		clearTimeout(timer);
	}
}

// ── The single consumer pass ────────────────────────────────────────────────

export interface DispositionReceiptPassDeps {
	store: Pick<
		StateStore,
		| "getPendingDispositionReceipts"
		| "markDispositionReceiptPosted"
		| "markDispositionReceiptAttempt"
		| "expireDispositionReceiptWithAudit"
		| "getChatThreadByIssue"
		| "getSessionLabels"
		| "getSession"
	>;
	projects: ProjectEntry[];
	globalBotToken?: string;
	fetchImpl?: typeof fetch;
	now?: () => number;
	/** Test seam — defaults to postThreadMessage. */
	postFn?: typeof postThreadMessage;
	log?: (msg: string) => void;
}

/**
 * Build the pass with its own single-flight latch. GatePoller fires this
 * fire-and-forget on the dedicated cadence; an overlapping invocation while a
 * previous pass is still awaiting Discord simply returns (rows stay pending —
 * the next tick retries).
 */
export function createDispositionReceiptPass(
	deps: DispositionReceiptPassDeps,
): () => Promise<void> {
	let inFlight = false;
	const log =
		deps.log ?? ((m: string) => console.log(`[disposition-receipt] ${m}`));
	return async function runDispositionReceiptPass(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		try {
			const nowMs = deps.now?.() ?? Date.now();
			const rows = deps.store.getPendingDispositionReceipts(
				RECEIPT_BATCH_PER_PASS,
			);
			for (const row of rows) {
				try {
					await deliverOneReceipt(row, deps, nowMs, log);
				} catch (err) {
					// Failure (thread unresolvable / token missing / post throw or
					// timeout): stamp the attempt so the row rotates to the back —
					// never a zero-stamp NULLS-FIRST squatter (R17 #4 / R19 #2).
					deps.store.markDispositionReceiptAttempt(
						row.receipt_id,
						deps.now?.() ?? Date.now(),
					);
					log(
						`receipt ${row.receipt_id} (${row.target_key}/${row.kind}) attempt failed: ${(err as Error).message}`,
					);
				}
			}
		} finally {
			inFlight = false;
		}
	};
}

async function deliverOneReceipt(
	row: DispositionReceiptRow,
	deps: DispositionReceiptPassDeps,
	nowMs: number,
	log: (msg: string) => void,
): Promise<void> {
	if (nowMs - row.created_at_ms > RECEIPT_EXPIRY_MS) {
		// Annie 铁律(Lead 29e7508a): every suppression path must answer "who
		// definitely sees this". Expiry is a give-up on the founder-visible leg,
		// so the state flip and its durable audit row commit in ONE transaction
		// (code R1 #3) — a failed audit leaves the receipt pending for retry.
		deps.store.expireDispositionReceiptWithAudit(row.receipt_id, {
			executionId: row.target_key,
			issueId: row.issue_id ?? "",
			projectName:
				deps.store.getSession(row.target_key)?.project_name ?? "unknown",
			kind: row.kind,
			episodeFingerprint: row.episode_fingerprint,
			actorLeadId: row.actor_lead_id,
			disposition: row.disposition,
			attempts: row.attempts,
		});
		log(
			`RECEIPT EXPIRED (>7d) for ${row.target_key}/${row.kind} receipt_id=${row.receipt_id} — giving up (thread never resolvable or delivery switched off too long)`,
		);
		return;
	}
	const issueId = row.issue_id;
	if (!issueId) {
		// Defensive: pending rows always carry issue_id (empty ⇒ unroutable at
		// prepare). Treat as a failed attempt.
		throw new Error("pending receipt without issue_id");
	}
	// Locate the issue thread through the ACTOR lead's chat channel(s); the
	// TOKEN then follows the thread row's creation-time lead (R19 #2 — the
	// actor's bot may not even be a member of the private thread).
	let found:
		| {
				thread: { thread_id: string; lead_id: string | null };
				projectName: string;
		  }
		| undefined;
	for (const project of deps.projects) {
		for (const lead of project.leads ?? []) {
			if (lead.agentId !== row.actor_lead_id || !lead.chatChannel) continue;
			const thread = deps.store.getChatThreadByIssue(issueId, lead.chatChannel);
			if (thread) {
				found = { thread, projectName: project.projectName };
				break;
			}
		}
		if (found) break;
	}
	if (!found) {
		throw new Error(
			`no issue thread resolvable via actor lead ${row.actor_lead_id}`,
		);
	}
	const botToken = resolveBotTokenForThread(deps.projects, {
		projectName: found.projectName,
		// Creation-time thread owner first; helper falls back to the current
		// label-resolved lead, then global (the real three-step chain).
		leadId: found.thread.lead_id,
		labels: safeSessionLabels(deps.store, row.target_key),
		fallbackBotToken: deps.globalBotToken,
	});
	if (!botToken) {
		throw new Error("no bot token resolvable for receipt thread");
	}
	const post = deps.postFn ?? postThreadMessage;
	await post(botToken, found.thread.thread_id, row.content, {
		fetchImpl: deps.fetchImpl,
	});
	// Confirmed 2xx only; receipt_id + pending guard (ABA closed). A crash
	// right here re-posts next pass — documented at-least-once.
	deps.store.markDispositionReceiptPosted(
		row.receipt_id,
		deps.now?.() ?? Date.now(),
	);
}

function safeSessionLabels(
	store: Pick<StateStore, "getSessionLabels">,
	targetKey: string,
): string[] {
	try {
		return store.getSessionLabels(targetKey);
	} catch {
		return [];
	}
}
