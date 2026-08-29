import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { leadEventEnvelopeFromJournalRow } from "./legacy-lead-event-reconciler.js";
import type { DurableQueueReceipt } from "./runtime-registry.js";

export const SUMMARY_ABSORPTION_SESSION_KEY = "summary-absorption";

export function summaryAbsorptionRoundId(slotStartMs: number): string {
	if (!Number.isSafeInteger(slotStartMs) || slotStartMs < 0) {
		throw new Error(`invalid summary absorption slot: ${slotStartMs}`);
	}
	return `summary-absorption:${new Date(slotStartMs).toISOString()}`;
}

export interface SummaryAbsorptionPassDeps {
	projects: readonly ProjectEntry[];
	store: Pick<StateStore, "appendLeadEvent" | "getLeadEventBySeq">;
	enqueueLeadEvent(
		envelope: ReturnType<typeof leadEventEnvelopeFromJournalRow>,
	): DurableQueueReceipt;
	/** Named call-time flag accessor; the DB value is intentionally not cached. */
	cadenceMs(): number;
	now?: () => number;
}

function resolveRaya(
	projects: readonly ProjectEntry[],
): { projectName: string; leadId: string } | null {
	const matches = projects.flatMap((project) =>
		project.leads
			.filter((lead) => lead.agentId === "raya")
			.map(() => ({ projectName: project.projectName, leadId: "raya" })),
	);
	if (matches.length > 1) {
		throw new Error(
			"summary absorption requires exactly one canonical Raya Lead",
		);
	}
	return matches[0] ?? null;
}

function runSummaryAbsorptionPass(deps: SummaryAbsorptionPassDeps): void {
	const raya = resolveRaya(deps.projects);
	if (!raya) return;
	const cadenceMs = deps.cadenceMs();
	if (!Number.isSafeInteger(cadenceMs) || cadenceMs <= 0) {
		throw new Error(`invalid summary absorption cadence: ${cadenceMs}`);
	}
	const nowMs = deps.now?.() ?? Date.now();
	const slotStartMs = Math.floor(nowMs / cadenceMs) * cadenceMs;
	const roundId = summaryAbsorptionRoundId(slotStartMs);
	const generatedAt = new Date(nowMs).toISOString();
	const payload = {
		event_type: "summary_absorption_round",
		execution_id: roundId,
		issue_id: "FLY-2131",
		project_name: raya.projectName,
		status: "scheduled",
		generated_at: generatedAt,
		summary:
			`[${roundId}] 开始一轮 summary review/吸收：先对账已 merge summary 与 MEMORY.md provenance，` +
			"review 未读 PR；看不懂时按 roundId+PR 聚合追问该项目 Lead；" +
			"有 review/吸收/追问活动时在 #raya 发可见汇报。",
		notification_context:
			`This event id is the roundId: ${roundId}. Carry it through summary merge --round, ` +
			"MEMORY.md provenance/commit, Lead questions, the durable round ledger, and the #raya report.",
	};
	const seq = deps.store.appendLeadEvent(
		raya.leadId,
		roundId,
		"summary_absorption_round",
		JSON.stringify(payload),
		SUMMARY_ABSORPTION_SESSION_KEY,
	);
	const durable = deps.store.getLeadEventBySeq(seq);
	if (!durable) {
		throw new Error(
			`summary absorption journal row missing after append seq=${seq}`,
		);
	}
	deps.enqueueLeadEvent(leadEventEnvelopeFromJournalRow(durable, 2));
}

/** Independent single-flight on the existing GatePoller timer. */
export function createSummaryAbsorptionPass(
	deps: SummaryAbsorptionPassDeps,
): () => Promise<void> {
	let inFlight: Promise<void> | null = null;
	return () => {
		if (inFlight) return inFlight;
		const pass = Promise.resolve().then(() => runSummaryAbsorptionPass(deps));
		const guarded = pass.finally(() => {
			if (inFlight === guarded) inFlight = null;
		});
		inFlight = guarded;
		return guarded;
	};
}
