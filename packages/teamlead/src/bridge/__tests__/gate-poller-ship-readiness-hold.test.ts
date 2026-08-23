import { describe, expect, it, vi } from "vitest";
import type { LeadConfig } from "../../ProjectConfig.js";
import type { Session } from "../../StateStore.js";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";
import type { ReviewHoldReason } from "../review-hold.js";

const HEAD = "a".repeat(40);

type PrivatePoller = {
	handleHeldReviewGate(
		lead: LeadConfig,
		session: Session,
		reason: ReviewHoldReason,
	): Promise<void>;
};

function makePoller() {
	const ensureShipRelevantDiff = vi.fn(async () => {});
	const alert = vi.fn(async () => ({ sent: true }));
	const poller = new GatePoller({
		pollIntervalMs: 3_000,
		projects: [],
		store: {} as GatePollerConfig["store"],
		runtimeRegistry: {} as GatePollerConfig["runtimeRegistry"],
		ensureShipRelevantDiff,
		leadAlertSink: { alert },
	} as GatePollerConfig) as unknown as PrivatePoller;
	return { poller, ensureShipRelevantDiff, alert };
}

const lead = {
	agentId: "eng-lead",
	chatChannel: "channel",
	match: { labels: ["engineering"] },
} satisfies LeadConfig;

const session = {
	execution_id: "exec-1",
	issue_id: "issue-1",
	issue_identifier: "FLY-1",
	project_name: "flywheel",
	status: "awaiting_review",
	session_role: "main",
	pr_head_sha: HEAD,
	pr_number: 42,
} satisfies Session;

describe("GatePoller FLY-1251 ship-readiness hold discovery", () => {
	it.each(["qa_evidence_missing", "qa_evidence_unknown"] as const)(
		"%s produces a deterministic Lead-only alert after the poll refresh",
		async (reason) => {
			const { poller, ensureShipRelevantDiff, alert } = makePoller();

			await poller.handleHeldReviewGate(lead, session, reason);
			await poller.handleHeldReviewGate(lead, session, reason);

			expect(ensureShipRelevantDiff).not.toHaveBeenCalled();
			expect(alert).toHaveBeenCalledTimes(2);
			const first = alert.mock.calls[0]![0];
			const second = alert.mock.calls[1]![0];
			expect(first.eventId).toBe(
				`ship-readiness-hold:exec-1:${HEAD}:${reason}`,
			);
			expect(second.eventId).toBe(first.eventId);
			expect(first.eventType).toBe("auto_qa_stuck");
			expect(first.body).toContain("cancel");
			expect(first.body).toContain("DAG");
			expect(first.body).toContain("redispatch");
			expect(first.body).not.toContain("/api/qa/");
		},
	);

	it("does not produce ship-diff work for an ordinary QA-in-progress hold", async () => {
		const { poller, ensureShipRelevantDiff, alert } = makePoller();

		await poller.handleHeldReviewGate(lead, session, "qa_not_green");

		expect(ensureShipRelevantDiff).not.toHaveBeenCalled();
		expect(alert).not.toHaveBeenCalled();
	});
});
