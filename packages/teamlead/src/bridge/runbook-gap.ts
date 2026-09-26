/**
 * FLY-1082 (Task 3.2): repeated escalations of one kind = a runbook gap —
 * the ONLY monotone-decreasing mechanism for N1 (founder interruptions).
 * When the same kind lands ESCALATED ≥ N times inside 7 days, auto-file ONE
 * eng issue ("this kind keeps reaching Annie — fix the runbook / root cause").
 *
 * Dedup: at most one OPEN runbook issue per kind (StateStore `runbook_issues`).
 * When the recorded issue is found CLOSED, the record AND the kind's
 * escalation window are cleared — counting starts over (a closed issue that
 * keeps escalating earns a fresh one). Founder-facing copy rules apply:
 * human words, never a PRD number in the title.
 */

import type { AlertEventType } from "../LeadAlertNotifier.js";
import type { StateStore } from "../StateStore.js";
import { FLEET_ESCALATION_COPY } from "./kind-contract.js";

export interface RunbookGapDeps {
	store: StateStore;
	/** Create the eng issue (FLY team / Flywheel project / Flywheel label —
	 * resolved by the plugin wiring). null = creation failed (fail-quiet). */
	createIssue: (input: {
		title: string;
		description: string;
	}) => Promise<{ id: string; identifier?: string } | null>;
	/** Is the recorded issue still open? null = cannot tell (keep dedup). */
	isIssueOpen: (issueId: string) => Promise<boolean | null>;
	env?: NodeJS.ProcessEnv;
	logger?: (msg: string) => void;
}

const WINDOW_DAYS = 7;

export type RunbookGapOutcome =
	| "recorded" // below threshold — just counted
	| "deduped" // threshold hit but an open runbook issue already exists
	| "created" // new runbook issue filed
	| "create_failed";

export async function noteTicketEscalated(
	kind: string,
	deps: RunbookGapDeps,
): Promise<RunbookGapOutcome> {
	const log = deps.logger ?? ((m) => console.log(`[runbook-gap] ${m}`));
	const env = deps.env ?? process.env;
	deps.store.recordTicketEscalation(kind);
	const raw = Number(env.FLYWHEEL_RUNBOOK_GAP_THRESHOLD);
	const threshold = Number.isFinite(raw) && raw > 0 ? raw : 3;
	const count = deps.store.countTicketEscalations(kind, WINDOW_DAYS);
	if (count < threshold) return "recorded";

	const existing = deps.store.getRunbookIssue(kind);
	if (existing) {
		const open = await deps.isIssueOpen(existing.issue_id);
		if (open !== false) return "deduped"; // open OR unknown — keep the dedup
		// Closed but the kind escalated again past the threshold — the window
		// restarts from THIS escalation (the plan's "issue 关闭后计数窗重新累计"):
		// clear the record + the old window; today's event re-seeds the count.
		deps.store.clearRunbookIssue(kind);
		deps.store.clearTicketEscalations(kind);
		deps.store.recordTicketEscalation(kind);
		return "recorded";
	}

	const label = FLEET_ESCALATION_COPY[kind as AlertEventType]?.label ?? kind;
	const created = await deps.createIssue({
		title: `告警「${label}」7 天内升级到 Annie ${count} 次 — 需要根治或补 runbook`,
		description: [
			`同一类告警（kind: \`${kind}\`）最近 ${WINDOW_DAYS} 天内 ${count} 次自动修复失败、升级到了 founder。`,
			"",
			"这说明这类故障目前「修不掉」是常态 — 要么补可执行的 runbook/自动修复动作,要么根治上游成因。",
			"",
			`- 阈值:${threshold} 次 / ${WINDOW_DAYS} 天(FLYWHEEL_RUNBOOK_GAP_THRESHOLD)`,
			"- 本单由告警工单系统自动创建(FLY-1082 升级链收口);同 kind 同时只会有一张 open 单。",
		].join("\n"),
	});
	if (!created?.id) {
		log(`runbook issue creation failed for kind=${kind}`);
		return "create_failed";
	}
	deps.store.setRunbookIssue(kind, created.id, created.identifier);
	log(
		`runbook issue filed for kind=${kind}: ${created.identifier ?? created.id}`,
	);
	return "created";
}
