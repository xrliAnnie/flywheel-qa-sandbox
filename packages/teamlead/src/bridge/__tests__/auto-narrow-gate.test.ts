import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	reconcileAutoNarrowGate,
	resolveAutoNarrowGateDeliveryContext,
} from "../auto-narrow-gate.js";

const METRICS = {
	sampleN: 1,
	agreeN: 1,
	precisionA: 1,
	precisionB: 1,
	confidenceLower: null,
	sampleStartAt: "2026-09-08T03:00:00.000Z",
	sampleEndAt: "2026-09-08T03:00:00.000Z",
	lastEligibleHumanAt: "2026-09-08T03:00:00.000Z",
};

function metricsStore() {
	return { getAutoNarrowOpinionMetrics: vi.fn(() => METRICS) };
}

describe("auto narrow GatePoller rider", () => {
	it("isolates candidates and closes every CommDB handle", () => {
		const close = vi.fn();
		const insert = vi.fn(() => ({ written: true, replayed: false }));
		const commit = vi.fn(({ questionId, writeSource }) => {
			if (questionId === "q-bad") throw new Error("fixture failure");
			writeSource({
				expectedOwner: "implement-1",
				envelope: { question_id: questionId },
			});
			return { status: "written" as const, envelope: {} as never };
		});
		const result = reconcileAutoNarrowGate({
			store: {
				...metricsStore(),
				listPendingAutoNarrowCandidates: () => ["q-1", "q-bad", "q-2"],
				getAutoNarrowOpinionDelivery: () => ({
					issueThreadId: "thread-1",
					state: "pending" as const,
				}),
				refreshAutoNarrowOpinion: vi.fn(),
				commitAutoNarrowSourceIfEligible: commit,
			},
			openCommDb: () => ({ insertAutoNarrowApprovalWithSource: insert, close }),
			opinionControl: { mode: "auto" },
			now: () => "2026-09-09T03:01:00.000Z",
			log: vi.fn(),
		});
		expect(result).toEqual({
			scanned: 3,
			written: 2,
			replayed: 0,
			skipped: 0,
			failed: 1,
			cursor: "q-2",
		});
		expect(insert).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledTimes(3);
	});

	it("keeps dry_run and degraded control out of the approval writer", () => {
		const close = vi.fn();
		const insert = vi.fn();
		const refresh = vi.fn();
		const result = reconcileAutoNarrowGate({
			store: {
				...metricsStore(),
				listPendingAutoNarrowCandidates: () => ["q-1"],
				getAutoNarrowOpinionDelivery: () => ({
					issueThreadId: "thread-1",
					state: "pending" as const,
				}),
				refreshAutoNarrowOpinion: refresh,
				commitAutoNarrowSourceIfEligible: vi.fn(() => ({
					status: "written" as const,
				})),
			},
			openCommDb: () => ({ insertAutoNarrowApprovalWithSource: insert, close }),
			opinionControl: { mode: "dry_run" },
			now: () => "2026-09-09T03:01:00.000Z",
		});
		expect(result).toMatchObject({ scanned: 1, written: 0, skipped: 1 });
		expect(refresh).toHaveBeenCalledOnce();
		expect(insert).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it("bootstraps a missing opinion delivery row before auto approval", () => {
		let delivery: { issueThreadId: string; state: "pending" } | undefined;
		const order: string[] = [];
		const refresh = vi.fn((input: { issueThreadId: string }) => {
			order.push("refresh");
			delivery = { issueThreadId: input.issueThreadId, state: "pending" };
		});
		const commit = vi.fn(() => {
			order.push("commit");
			return { status: "written" as const };
		});
		const result = reconcileAutoNarrowGate({
			store: {
				...metricsStore(),
				listPendingAutoNarrowCandidates: () => ["q-legacy"],
				getAutoNarrowOpinionDelivery: () => delivery,
				refreshAutoNarrowOpinion: refresh,
				commitAutoNarrowSourceIfEligible: commit,
			},
			resolveDeliveryContext: () => ({
				issueThreadId: "1517000000000000050",
			}),
			openCommDb: () => ({
				insertAutoNarrowApprovalWithSource: vi.fn(() => ({
					written: true,
					replayed: false,
				})),
				close: vi.fn(),
			}),
			opinionControl: {
				mode: "auto",
				controlAppliedAt: "2026-09-09T03:00:00.000Z",
			},
			now: () => "2026-09-09T03:01:00.000Z",
		});
		expect(result).toMatchObject({ written: 1, failed: 0 });
		expect(refresh).toHaveBeenCalledWith({
			questionId: "q-legacy",
			issueThreadId: "1517000000000000050",
			mode: "auto",
			controlAppliedAt: "2026-09-09T03:00:00.000Z",
			at: "2026-09-09T03:01:00.000Z",
			metrics: METRICS,
		});
		expect(order).toEqual(["refresh", "commit"]);
	});

	it("fails closed before auto approval when opinion bootstrap cannot persist", () => {
		const commit = vi.fn(() => ({ status: "written" as const }));
		const close = vi.fn();
		const result = reconcileAutoNarrowGate({
			store: {
				...metricsStore(),
				listPendingAutoNarrowCandidates: () => ["q-legacy"],
				getAutoNarrowOpinionDelivery: () => undefined,
				refreshAutoNarrowOpinion: () => {
					throw new Error("shadow facts unavailable");
				},
				commitAutoNarrowSourceIfEligible: commit,
			},
			resolveDeliveryContext: () => ({
				issueThreadId: "1517000000000000050",
			}),
			openCommDb: () => ({
				insertAutoNarrowApprovalWithSource: vi.fn(() => ({
					written: true,
					replayed: false,
				})),
				close,
			}),
			opinionControl: { mode: "auto" },
			now: () => "2026-09-09T03:01:00.000Z",
			log: vi.fn(),
		});
		expect(result).toMatchObject({ written: 0, failed: 1 });
		expect(commit).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it("keeps off mode silent without trying to bootstrap an opinion trace", () => {
		const refresh = vi.fn();
		const commit = vi.fn(() => ({ status: "written" as const }));
		const result = reconcileAutoNarrowGate({
			store: {
				...metricsStore(),
				listPendingAutoNarrowCandidates: () => ["q-off"],
				getAutoNarrowOpinionDelivery: () => undefined,
				refreshAutoNarrowOpinion: refresh,
				commitAutoNarrowSourceIfEligible: commit,
			},
			resolveDeliveryContext: () => ({
				issueThreadId: "1517000000000000050",
			}),
			openCommDb: vi.fn(),
			opinionControl: { mode: "off" },
		});
		expect(result).toMatchObject({ skipped: 1, failed: 0, written: 0 });
		expect(refresh).not.toHaveBeenCalled();
		expect(commit).not.toHaveBeenCalled();
	});

	it("resolves the gate-card owner in a two-lead project instead of leads[0]", () => {
		const projects = [
			{
				projectName: "flywheel",
				projectRoot: "/repo",
				leads: [
					{
						agentId: "flywheel-cos-lead",
						summaryRole: "cos",
						chatChannel: "1516209289406971965",
						botToken: "cos-token",
						match: { labels: ["COS"] },
					},
					{
						agentId: "flywheel-eng-lead",
						summaryRole: "engineering",
						chatChannel: "1516209714097291335",
						botToken: "eng-token",
						match: { labels: ["Flywheel"] },
					},
				],
			},
		] as ProjectEntry[];
		const store = {
			getCurrentWorkflowGateHolderByQuestionId: () => ({
				run_id: "run-1",
				source_execution_id: "exec-eng",
			}),
			getWorkflowRun: () => ({
				run_id: "run-1",
				issue_id: "issue-1",
				project_name: "flywheel",
			}),
			getSession: () => ({ execution_id: "exec-eng" }),
			getSessionLabels: () => ["Flywheel"],
			getChatThreadByIssue: vi.fn((issueId: string, channelId: string) =>
				issueId === "issue-1" && channelId === "1516209714097291335"
					? {
							thread_id: "1517000000000000050",
							channel_id: channelId,
							lead_id: "flywheel-eng-lead",
						}
					: undefined,
			),
		};

		expect(
			resolveAutoNarrowGateDeliveryContext({
				store,
				projects,
				questionId: "q-eng",
				defaultBotToken: "default-token",
			}),
		).toEqual({
			leadId: "flywheel-eng-lead",
			issueThreadId: "1517000000000000050",
			botToken: "eng-token",
		});
		expect(store.getChatThreadByIssue).toHaveBeenCalledWith(
			"issue-1",
			"1516209714097291335",
		);
		store.getSessionLabels = () => [];
		expect(
			resolveAutoNarrowGateDeliveryContext({
				store,
				projects,
				questionId: "q-unowned",
				defaultBotToken: "default-token",
			}),
		).toBeUndefined();
	});

	it("rotates after the last processed candidate and computes metrics once per tick", () => {
		const getMetrics = vi.fn(() => METRICS);
		const list = vi.fn((_limit: number, after?: string) =>
			after === "q-1" ? ["q-2", "q-3", "q-1"] : ["q-1", "q-2", "q-3"],
		);
		const refreshed: string[] = [];
		const store = {
			listPendingAutoNarrowCandidates: list,
			getAutoNarrowOpinionMetrics: getMetrics,
			getAutoNarrowOpinionDelivery: () => ({
				issueThreadId: "thread-1",
				state: "pending" as const,
			}),
			refreshAutoNarrowOpinion: ({ questionId }: { questionId: string }) => {
				refreshed.push(questionId);
			},
			commitAutoNarrowSourceIfEligible: vi.fn(() => ({
				status: "not_candidate" as const,
			})),
		};
		// The shared metric snapshot may consume the whole nominal budget. The
		// rider must still advance one candidate so the cursor cannot stick.
		const firstClock = [0, 250, 250];
		const first = reconcileAutoNarrowGate({
			store,
			openCommDb: () => ({
				insertAutoNarrowApprovalWithSource: vi.fn(),
				close: vi.fn(),
			}),
			opinionControl: { mode: "dry_run" },
			now: () => "2026-09-09T03:01:00.000Z",
			monotonicNow: () => firstClock.shift() ?? 250,
		});
		expect(first.cursor).toBe("q-1");

		const second = reconcileAutoNarrowGate({
			store,
			openCommDb: () => ({
				insertAutoNarrowApprovalWithSource: vi.fn(),
				close: vi.fn(),
			}),
			opinionControl: { mode: "dry_run" },
			scanAfterQuestionId: first.cursor ?? undefined,
			now: () => "2026-09-09T03:01:03.000Z",
			monotonicNow: () => 0,
		});
		expect(list).toHaveBeenNthCalledWith(2, 20, "q-1");
		expect(second.cursor).toBe("q-1");
		expect(refreshed).toEqual(["q-1", "q-2", "q-3", "q-1"]);
		expect(getMetrics).toHaveBeenCalledTimes(2);
	});
});
