/**
 * FLY-1048 PR-C (C3-w): the PRODUCTION implementations of the two sinks that
 * `reconcileDetectionEscalations` (C3 core) takes as injected deps.
 *
 * - `createFounderPager` — the individual leg. An @founder note into the
 *   episode's own issue thread, deduped forever by `founder_page_ledger`.
 *   Returns true ONLY on a CONFIRMED posted page (plan C3 / Codex R1 #3): a
 *   missing thread or a failed POST returns false so the caller leaves the row
 *   LEAD_NOTIFIED for the next reconcile, and `onUndeliverable` closes the loop
 *   so the failure is never silent.
 *
 * - `createFleetSink` — the fleet leg (PRD §4.3 boundary). ≥K same-kind
 *   episodes overdue at once is ONE incident, not K: a single
 *   `detection_fleet_aggregate` ticket rides the FLY-915 alert lane, the
 *   founder is not paged, and the owner Leads are not spammed per-episode. It
 *   THROWS on sink failure — the caller's contract is that a throwing fleetSink
 *   leaves every row LEAD_NOTIFIED.
 *
 * Privacy contract (inherited from the C2 Lead leg): raw pane text NEVER
 * travels either path. Bodies carry kind + counts + target keys only.
 */

import { createHash } from "node:crypto";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { DetectionEscalationRow, StateStore } from "../StateStore.js";
import { addThreadMember } from "./chat-thread-utils.js";
import { emitIssueThreadInfraNotification } from "./founder-thread-notifier.js";
import { parseSessionLabels } from "./lead-scope.js";

/** Routing context for one episode's founder page. */
export interface FounderPageTarget {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	/**
	 * Owner Lead's chat channel — the `getChatThreadByIssue` lookup key.
	 * Required: an episode whose channel cannot be resolved cannot be addressed,
	 * so `resolveTarget` returns null (→ `onUndeliverable("no_target")`) rather
	 * than reaching this leg with a hole in it.
	 */
	chatChannel: string;
	/** Owner Lead's bot token; falls back to the Bridge token. */
	botToken?: string;
}

export interface FounderPagerDeps {
	store: Pick<
		StateStore,
		| "getChatThreadByIssue"
		| "recordFounderPaged"
		| "getFounderPaged"
		| "insertEvent"
	>;
	/**
	 * Resolve the episode's issue-thread routing. null ⇒ the page cannot be
	 * addressed at all (unknown session / unresolvable Lead) — surfaced through
	 * `onUndeliverable("no_target")`, never dropped.
	 */
	resolveTarget: (row: DetectionEscalationRow) => FounderPageTarget | null;
	/** The FOUNDER's Discord user id (config.discordOwnerUserId) — NOT the Lead. */
	discordOwnerUserId?: string;
	/** Bridge-wide fallback bot token. */
	discordBotToken?: string;
	fetchImpl?: typeof fetch;
	/** Fail-safe seam — invoked on ANY non-posted terminal outcome. */
	onUndeliverable: (
		row: DetectionEscalationRow,
		reason: string,
	) => void | Promise<void>;
	now?: () => number;
	logger?: (msg: string) => void;
	/** Test seam. Defaults to the real issue-thread notifier. */
	emit?: typeof emitIssueThreadInfraNotification;
	/** Test seam. Defaults to the real Discord thread-member add. */
	addMember?: typeof addThreadMember;
}

/** Stable, restart-durable page id for one episode (founder_page_ledger key). */
export function founderPageEventId(row: DetectionEscalationRow): string {
	return `detection-escalation-page-${row.target_key}-${row.kind}-${row.episode_fingerprint}`;
}

/**
 * The production `resolveTarget` for runner-keyed episodes: target_key is the
 * executionId, and the page routes to the OWNER Lead's chat channel via the
 * same dept-label resolution the stuck flow uses (resolveLeadForIssue —
 * PRD §4.5: owner Lead is label-resolved, 非一律 eng). Anything unresolvable
 * (vanished session, lead-keyed target, unconfigured project) returns null so
 * the pager surfaces `no_target` instead of addressing a page into a hole.
 */
export function createSessionTargetResolver(deps: {
	store: Pick<StateStore, "getSession">;
	projects: ProjectEntry[];
}): (row: DetectionEscalationRow) => FounderPageTarget | null {
	return (row) => {
		const session = deps.store.getSession(row.target_key);
		if (!session) return null;
		try {
			const { lead } = resolveLeadForIssue(
				deps.projects,
				session.project_name,
				parseSessionLabels(session),
			);
			return {
				executionId: session.execution_id,
				issueId: session.issue_id,
				issueIdentifier: session.issue_identifier,
				projectName: session.project_name,
				chatChannel: lead.chatChannel,
				botToken: lead.botToken,
			};
		} catch {
			return null; // unconfigured project — surfaced as no_target upstream
		}
	};
}

/** One-sentence, pane-free description of a detection kind. */
function describeKind(kind: string): string {
	switch (kind) {
		case "detection_stuck_confirmed":
			return "Runner 卡死已确认";
		case "runner_parked_unreported":
			return "Runner 已 park 但没上报";
		case "lead_ask_unanswered":
			return "Runner 的提问一直没人答";
		case "delivery_unconsumed":
			return "消息投递了但没被消费";
		case "delivery_failed_reconcile":
			return "投递失败且无人跟进";
		default:
			return `检测到异常(${kind})`;
	}
}

export function createFounderPager(
	deps: FounderPagerDeps,
): (row: DetectionEscalationRow) => Promise<boolean> {
	const emit = deps.emit ?? emitIssueThreadInfraNotification;
	const addMember = deps.addMember ?? addThreadMember;
	const logger =
		deps.logger ??
		((m: string) => console.log(`[detection-escalation-sinks] ${m}`));

	return async function pageFounder(
		row: DetectionEscalationRow,
	): Promise<boolean> {
		const eventId = founderPageEventId(row);
		// Monotonic ledger (FLY-818 M3 precedent): a real page already landed for
		// this episode ⇒ converge, never double-page the founder across restarts.
		if (deps.store.getFounderPaged(eventId) === true) return true;

		const target = deps.resolveTarget(row);
		if (!target) {
			logger(
				`cannot address founder page for ${row.kind} ${row.target_key} — no target`,
			);
			await deps.onUndeliverable(row, "no_target");
			deps.store.recordFounderPaged(eventId, false);
			return false;
		}

		const nowMs = deps.now?.() ?? Date.now();
		const elapsedMin = row.lead_notified_at_ms
			? Math.round((nowMs - row.lead_notified_at_ms) / 60_000)
			: 0;
		const label = target.issueIdentifier ?? target.issueId;
		const owner = row.owner_lead_id ?? "未解析";
		const content =
			`🚨 ${label} [Watchdog] ${describeKind(row.kind)}(target=${row.target_key})。` +
			`owner Lead(${owner})已在 ${elapsedMin} 分钟前收到通知,至今无处置 → 升级给你。`;

		const thread = deps.store.getChatThreadByIssue(
			target.issueId,
			target.chatChannel,
		);

		// FLY-1189: on a PRIVATE issue thread a <@founder> mention only pushes a
		// notification if the founder is a MEMBER. Add them via the OWNER-LEAD bot
		// (the bot that owns this thread). The shared Bridge bot is NOT a member of
		// a Lead-owned thread, so ITS add 403s — that is exactly the bug this closes,
		// so we NEVER fall back to deps.discordBotToken here: no owner-Lead bot ⇒
		// log-and-skip. Non-fatal by contract — a failed/absent add never wedges the
		// page (the mention still fires; the founder still sees the thread message).
		// addThreadMember is idempotent (Discord PUT thread-members ⇒ already-member
		// is a no-op success) and never throws.
		if (thread?.thread_id && deps.discordOwnerUserId) {
			if (target.botToken) {
				const outcome = await addMember(
					thread.thread_id,
					deps.discordOwnerUserId,
					target.botToken,
					{ fetchImpl: deps.fetchImpl },
				);
				if (outcome !== "added") {
					logger(
						`founder thread-member add ${outcome} for ${row.kind} ${row.target_key} (thread ${thread.thread_id}) — paging anyway`,
					);
				}
			} else {
				logger(
					`founder thread-member add skipped for ${row.kind} ${row.target_key} — no owner-Lead bot token (never using the shared Bridge bot to add members)`,
				);
			}
		}

		const result = await emit(
			{
				executionId: target.executionId,
				issueId: target.issueId,
				issueIdentifier: target.issueIdentifier,
				projectName: target.projectName,
				kind: row.kind,
				content,
				mentionUserId: deps.discordOwnerUserId,
				thread,
				botToken: target.botToken ?? deps.discordBotToken,
				// NEVER silent: every non-posted terminal outcome rides this seam.
				onUndeliverable: (reason) => deps.onUndeliverable(row, reason),
			},
			{ store: deps.store as StateStore, fetchImpl: deps.fetchImpl },
		);

		const posted = result.kind === "posted";
		// `false` never downgrades a prior `true` (recordFounderPaged is MAX-merged),
		// and it does not block a retry — the reconcile re-enters on the next tick.
		deps.store.recordFounderPaged(eventId, posted);
		return posted;
	};
}

// ── fleet aggregate (PRD §4.3 boundary) ──

export interface FleetSinkDeps {
	alertSink: { alert(payload: AlertPayload): Promise<AlertResult> };
	/**
	 * Resolve a row's PROJECT name (Codex code R1 #3: issue_id is a Linear
	 * UUID/identifier, never project-prefixed — deriving from it routed every
	 * fleet aggregate to unknown-lead/deadletter). The plugin wires this to
	 * the session row; null → "unknown".
	 */
	resolveProject?: (row: DetectionEscalationRow) => string | null;
	/** How many target keys to name in the body before eliding. */
	maxNamedTargets?: number;
	logger?: (msg: string) => void;
}

/**
 * Deterministic id over the episode SET: the same group retried after a sink
 * failure reuses its id (claims-dedup safe), while a group that gained or lost
 * an episode is a genuinely different incident and gets a new one.
 */
export function fleetAggregateEventId(
	kind: string,
	rows: DetectionEscalationRow[],
): string {
	const fingerprints = rows
		.map((r) => `${r.target_key}:${r.episode_fingerprint}`)
		.sort()
		.join("|");
	const digest = createHash("sha256")
		.update(`${kind}\u0000${fingerprints}`)
		.digest("hex")
		.slice(0, 16);
	return `detection-fleet-aggregate:${kind}:${digest}`;
}

export function createFleetSink(
	deps: FleetSinkDeps,
): (kind: string, rows: DetectionEscalationRow[]) => Promise<void> {
	const maxNamed = deps.maxNamedTargets ?? 5;

	return async function fleetSink(
		kind: string,
		rows: DetectionEscalationRow[],
	): Promise<void> {
		const targets = rows.map((r) => r.target_key).sort();
		const named = targets.slice(0, maxNamed).join(", ");
		const elided = targets.length > maxNamed ? ` 等 ${targets.length} 个` : "";

		// The most common owner Lead / project carries the ticket — deterministic
		// (ties broken by sort) so a retry produces a byte-identical payload.
		// Codex code R2 #2: the (projectName, leadId) pair must come from the
		// SAME row — independent per-field modes can compose a pair that exists
		// nowhere (LeadAlertNotifier requires an exact valid pairing and would
		// dead-letter the aggregate forever). Prefer the most common FULLY
		// VALID pair; if no row resolves both fields, fall back to the most
		// common partial values — the alert then fails LOUDLY through the
		// sink's own dead-letter path instead of silently.
		const pairs = rows.map((r) => ({
			leadId: r.owner_lead_id,
			projectName: deps.resolveProject?.(r) ?? null,
		}));
		const validPairs = pairs.filter(
			(p): p is { leadId: string; projectName: string } =>
				p.leadId != null && p.projectName != null,
		);
		let leadId: string;
		let projectName: string;
		if (validPairs.length > 0) {
			const winner = mostCommon(
				validPairs.map((p) => `${p.projectName}\u0000${p.leadId}`),
			).split("\u0000");
			projectName = winner[0] as string;
			leadId = winner[1] as string;
		} else {
			leadId = mostCommon(pairs.map((p) => p.leadId ?? "unassigned"));
			projectName = mostCommon(pairs.map((p) => p.projectName ?? "unknown"));
		}

		const payload: AlertPayload = {
			leadId,
			projectName,
			eventId: fleetAggregateEventId(kind, rows),
			eventType: "detection_fleet_aggregate",
			title: `Fleet-scale detection incident (${kind})`,
			body:
				`${rows.length} 个同类检测 episode(kind=${kind})同时超时未处置 —— ` +
				`按 fleet 事件聚合上报,未逐条 page founder。targets: ${named}${elided}。` +
				`排查共因(Bridge / 传输 / fleet 级 runner 状态)。`,
			severity: "warning",
		};

		// Throws on failure BY DESIGN: the caller leaves every row LEAD_NOTIFIED so
		// the next reconcile retries the whole group.
		await deps.alertSink.alert(payload);
	};
}

function mostCommon(values: string[]): string {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best = "";
	let bestCount = -1;
	for (const key of [...counts.keys()].sort()) {
		const count = counts.get(key) ?? 0;
		if (count > bestCount) {
			best = key;
			bestCount = count;
		}
	}
	return best;
}
