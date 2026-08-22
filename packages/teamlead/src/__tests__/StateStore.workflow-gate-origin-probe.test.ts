import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const roots: string[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function fixture(dbPath = ":memory:") {
	const store = await StateStore.create(dbPath);
	stores.push(store);
	store.createWorkflowRun({
		runId: "run-origin",
		issueId: "FLY-1757",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.ensureWorkflowGateHolder({
		runId: "run-origin",
		gateNodeId: "founder_gate",
		attempt: 1,
		headSha: "a".repeat(40),
		sourceExecutionId: "qa-origin",
		questionId: "question-origin",
		now: "2099-08-21T19:00:00.000Z",
	});
	return store;
}

describe("workflow gate origin probe persistence", () => {
	it("persists backoff without drifting materialization progress and never defers reconciliation", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1757-origin-probe-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const store = await fixture(dbPath);

		expect(
			store.deferWorkflowGateOriginProbe({
				questionId: "question-origin",
				reason: "workflow_gate_origin_probe_unavailable",
				now: "2099-08-21T19:01:00.000Z",
				delayMs: 30_000,
			}),
		).toMatchObject({
			ok: true,
			attempts: 1,
			nextAt: "2099-08-21T19:01:30.000Z",
		});
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId("question-origin"),
		).toMatchObject({
			origin_probe_attempts: 1,
			origin_probe_next_at: "2099-08-21T19:01:30.000Z",
			origin_probe_last_reason: "workflow_gate_origin_probe_unavailable",
			updated_at: "2099-08-21T19:00:00.000Z",
		});
		expect(
			store
				.listWorkflowGateHoldersForMaterialization()
				.map((holder) => holder.question_id),
		).not.toContain("question-origin");

		expect(
			store.claimWorkflowGateCardPostIntent({
				questionId: "question-origin",
				correlationMarker: "gate:0123456789ab",
				now: "2099-08-21T19:01:01.000Z",
				reconcileNotBefore: "2099-08-21T19:02:01.000Z",
			}),
		).toMatchObject({ ok: true, created: true });
		expect(
			store
				.listWorkflowGateHoldersForMaterialization()
				.map((holder) => holder.question_id),
		).toContain("question-origin");

		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = await StateStore.create(dbPath);
		stores.push(reopened);
		expect(
			reopened.getCurrentWorkflowGateHolderByQuestionId("question-origin"),
		).toMatchObject({
			origin_probe_attempts: 1,
			origin_probe_next_at: "2099-08-21T19:01:30.000Z",
		});
		expect(
			reopened.markWorkflowGateOriginProbeVerified({
				questionId: "question-origin",
				now: "2099-08-21T19:01:31.000Z",
			}),
		).toEqual({ ok: true });
		expect(
			reopened.getCurrentWorkflowGateHolderByQuestionId("question-origin"),
		).toMatchObject({
			origin_probe_attempts: 0,
			origin_probe_next_at: null,
			origin_probe_last_reason: null,
			origin_probe_verified_at: "2099-08-21T19:01:31.000Z",
			updated_at: "2099-08-21T19:01:01.000Z",
		});
	});

	it("holds terminal failures once with a durable event and severe alert", async () => {
		const store = await fixture();
		const input = {
			questionId: "question-origin",
			reason: "workflow_gate_origin_probe_pr_closed",
			now: "2099-08-21T19:01:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			},
		};

		expect(store.holdWorkflowGateOriginProbeTerminal(input)).toEqual({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.getWorkflowRun("run-origin")?.status).toBe("held");
		expect(
			store
				.listWorkflowRunEvents("run-origin")
				.filter(
					(event) => event.kind === "workflow_gate_origin_preflight_terminal",
				),
		).toHaveLength(1);
		expect(
			store.getWorkflowAlertOutbox(
				"workflow_gate_origin_preflight_terminal:question-origin",
			),
		).toMatchObject({
			run_id: "run-origin",
			payload: {
				severity: "severe",
				metadata: {
					workflowEngine: {
						disposition: "workflow_gate_origin_preflight_terminal",
					},
				},
			},
		});
		expect(store.holdWorkflowGateOriginProbeTerminal(input)).toEqual({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			store.holdWorkflowGateOriginProbeTerminal({
				...input,
				reason: "workflow_gate_origin_probe_binding_missing",
			}),
		).toEqual({ ok: true, idempotentReplay: true });
		expect(
			store.getCurrentWorkflowGateHolderByQuestionId("question-origin"),
		).toMatchObject({
			origin_probe_last_reason: "workflow_gate_origin_probe_binding_missing",
		});
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
	});
});
