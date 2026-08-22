import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { materializeWorkflowGateWithFailLoud } from "../workflow-gate-materialization-alert.js";

const stores: StateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

async function fixture() {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1772",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	const holder = store.ensureWorkflowGateHolder({
		runId: "run-1",
		gateNodeId: "founder_gate",
		attempt: 1,
		headSha: "a".repeat(40),
		sourceExecutionId: "exec-1",
		questionId: "question-1",
		now: "2026-08-14T19:00:00.000Z",
	});
	return { store, holder };
}

const identity = {
	leadId: "flywheel-eng-lead",
	projectName: "flywheel",
	leadResolution: "resolved" as const,
};

describe("workflow gate materialization fail-loud", () => {
	it.each([
		[
			"returned failure",
			async () => ({ ok: false as const, reason: "no_thread" }),
			"no_thread",
		],
		[
			"thrown failure",
			async () => Promise.reject(new Error("discord_down")),
			"discord_down",
		],
	])(
		"alerts for an old holder after a %s",
		async (_label, materialize, expectedReason) => {
			const { store, holder } = await fixture();
			const log = vi.fn();

			await materializeWorkflowGateWithFailLoud({
				store,
				holder,
				materialize,
				alertIdentity: identity,
				now: () => "2026-08-14T19:10:00.001Z",
				log,
			});

			const alert = store.getWorkflowAlertOutbox(
				"gate_materialization_stuck:question-1",
			);
			expect(alert).toMatchObject({ run_id: "run-1" });
			expect(alert?.payload).toEqual({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				eventId: "gate_materialization_stuck:question-1",
				eventType: "workflow_engine_escalation",
				severity: "severe",
				sessionKey: "wf:run-1",
				title: "【需人工】FLY-1772 的 ship 卡发不出来(卡在 materializing)",
				body: `FLY-1772 的 ship gate founder_gate 无法 materialize。question_id=question-1, head=aaaaaaaa, failure_reason=${expectedReason}。请检查 Discord thread/card binding 与 materializer 日志,修复后引擎会自动重试。`,
				metadata: {
					workflowEngine: {
						runId: "run-1",
						issueId: "FLY-1772",
						nodeId: "founder_gate",
						executionId: "exec-1",
						disposition: "gate_materialization_stuck",
						questionId: "question-1",
						leadResolution: "resolved",
					},
				},
			});
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("materialization failed for question-1"),
			);
		},
	);

	it("does not alert when the failed attempt is too young", async () => {
		const { store, holder } = await fixture();
		await materializeWorkflowGateWithFailLoud({
			store,
			holder,
			materialize: async () => ({ ok: false, reason: "no_thread" }),
			alertIdentity: identity,
			now: () => "2026-08-14T19:10:00.000Z",
		});
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
	});

	it("alerts when a completed holder has a durable audit conflict", async () => {
		const { store, holder } = await fixture();
		for (const [stage, cardMessageId] of [
			["card_posted", "card-1"],
			["card_bound", "card-1"],
			["completed", undefined],
		] as const) {
			store.advanceWorkflowGateHolderMaterialization({
				questionId: holder.question_id,
				stage,
				...(cardMessageId ? { cardMessageId } : {}),
				now: "2026-08-14T19:00:00.000Z",
			});
		}

		await materializeWorkflowGateWithFailLoud({
			store,
			holder,
			materialize: async () => ({
				ok: false,
				reason: "workflow_gate_card_audit_conflict",
			}),
			alertIdentity: identity,
			now: () => "2026-08-14T19:10:00.001Z",
		});

		expect(
			store.getWorkflowAlertOutbox("gate_materialization_stuck:question-1"),
		).toMatchObject({ run_id: "run-1" });
	});

	it("starts the stuck window from the holder's latest materialization progress", async () => {
		const { store, holder } = await fixture();
		expect(
			store.advanceWorkflowGateHolderMaterialization({
				questionId: holder.question_id,
				stage: "question_written",
				now: "2026-08-14T19:09:00.000Z",
			}),
		).toMatchObject({ ok: true });

		await materializeWorkflowGateWithFailLoud({
			store,
			holder,
			materialize: async () => ({ ok: false, reason: "discord_busy" }),
			alertIdentity: identity,
			now: () => "2026-08-14T19:10:00.001Z",
		});

		expect(store.listWorkflowAlertOutbox()).toEqual([]);
	});

	it("keeps the fail-loud clock anchored while probe bookkeeping defers for twelve minutes", async () => {
		const { store, holder } = await fixture();
		for (const [now, delayMs] of [
			["2026-08-14T19:01:00.000Z", 30_000],
			["2026-08-14T19:01:30.000Z", 60_000],
			["2026-08-14T19:02:30.000Z", 120_000],
			["2026-08-14T19:04:30.000Z", 240_000],
		] as const) {
			store.deferWorkflowGateOriginProbe({
				questionId: holder.question_id,
				reason: "workflow_gate_origin_probe_unavailable",
				now,
				delayMs,
			});
		}
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId(holder.question_id)
				?.updated_at,
		).toBe("2026-08-14T19:00:00.000Z");

		await materializeWorkflowGateWithFailLoud({
			store,
			holder,
			materialize: async () => ({
				ok: false,
				reason: "workflow_gate_origin_probe_unavailable",
			}),
			alertIdentity: identity,
			now: () => "2026-08-14T19:12:00.000Z",
		});

		expect(
			store.getWorkflowAlertOutbox("gate_materialization_stuck:question-1")
				?.payload.body,
		).toContain("failure_reason=workflow_gate_origin_probe_unavailable");
	});

	it("treats SQLite datetime progress timestamps as UTC", async () => {
		const { store, holder } = await fixture();
		expect(
			store.advanceWorkflowGateHolderMaterialization({
				questionId: holder.question_id,
				stage: "question_written",
				now: "2026-08-14 19:00:00",
			}),
		).toMatchObject({ ok: true });

		await materializeWorkflowGateWithFailLoud({
			store,
			holder,
			materialize: async () => ({ ok: false, reason: "discord_busy" }),
			alertIdentity: identity,
			now: () => "2026-08-14T19:10:00.001Z",
		});

		expect(
			store.getWorkflowAlertOutbox("gate_materialization_stuck:question-1"),
		).toMatchObject({ run_id: "run-1" });
	});

	it("re-reads after await and suppresses an alert when the holder was superseded", async () => {
		const { store, holder } = await fixture();
		await materializeWorkflowGateWithFailLoud({
			store,
			holder,
			materialize: async () => {
				store.ensureWorkflowGateHolder({
					runId: "run-1",
					gateNodeId: "founder_gate",
					attempt: 2,
					headSha: "b".repeat(40),
					sourceExecutionId: "exec-2",
					questionId: "question-2",
					now: "2026-08-14T19:10:00.001Z",
				});
				return { ok: false, reason: "raced" };
			},
			alertIdentity: identity,
			now: () => "2026-08-14T19:10:00.001Z",
		});
		expect(store.listWorkflowAlertOutbox()).toEqual([]);
	});

	it("deduplicates across restart-style retries even when alert identity changes", async () => {
		const { store, holder } = await fixture();
		const firstPayload = async () => ({ ok: false as const, reason: "first" });
		await materializeWorkflowGateWithFailLoud({
			store,
			holder,
			materialize: firstPayload,
			alertIdentity: identity,
			now: () => "2026-08-14T19:10:00.001Z",
		});
		await expect(
			materializeWorkflowGateWithFailLoud({
				store,
				holder,
				materialize: async () => ({ ok: false, reason: "second" }),
				alertIdentity: {
					...identity,
					leadId: "replacement-lead",
					leadResolution: "fallback",
				},
				now: () => "2026-08-14T19:11:00.000Z",
			}),
		).resolves.toBeUndefined();
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(
			store.getWorkflowAlertOutbox("gate_materialization_stuck:question-1")
				?.payload.leadId,
		).toBe("flywheel-eng-lead");
	});
});
