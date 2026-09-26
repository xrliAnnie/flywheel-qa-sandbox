import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { LeadDeliveryBatch } from "../lead-delivery-adapter.js";
import { LeadInboxRuntime } from "../lead-inbox-runtime.js";
import { RuntimeRegistry } from "../runtime-registry.js";

const runtimes: LeadInboxRuntime[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("FLY-2912 wires each runtime Lead to the scoped frozen summary and queue receipt", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2912-runtime-summary-"));
	roots.push(root);
	const projects: ProjectEntry[] = ["a", "b"].map((suffix) => ({
		projectName: `project-${suffix}`,
		projectRoot: join(root, suffix),
		leads: [
			{
				agentId: `lead-${suffix}`,
				summaryRole: "producer",
				chatChannel: `chat-${suffix}`,
				match: { labels: [] },
			},
		],
	}));
	const store = {
		isLeadEventAuditOnly: () => false,
		getActiveSessions: () => [],
		resolveRunnerRecipientState: () => ({ state: "terminal" }),
		listDeadLetterAlertCursors: () => [],
		createDeadLetterAlertIntent: vi.fn(),
		listDueDeadLetterAlerts: () => [],
		listUndeliveredLeadInboxEvents: () => [],
		getMailboxLedgerByEventId: () => undefined,
		getFlagValueRow: vi.fn(() => ({ hasOverride: true, raw: "1" })),
		getNotificationAuditGeneration: () => ({ generation: "generation-a" }),
		readLeadAuditSummary: vi.fn(
			(scope: { projectName: string; leadId: string }) => ({
				generation: "generation-a",
				startSeq: 0,
				startEventId: null,
				recovered: false,
				fromSeq: 0,
				throughSeq: 3,
				anchorEventId: `${scope.leadId}-event-3`,
				total: 3,
				counts: { stage_changed: 3 },
				representatives: [
					{
						seq: 3,
						event_id: `${scope.leadId}-event-3`,
						event_type: "stage_changed",
						payload: JSON.stringify({
							execution_id: `${scope.projectName}-exec`,
							stage: "test",
						}),
					},
				],
			}),
		),
	};
	const deliverBatch = vi.fn(async (batch: LeadDeliveryBatch) => ({
		batchId: batch.batchId,
		memberIds: batch.members.map(({ deliveryId }) => deliveryId),
		status: "accepted_new" as const,
	}));
	const runtime = new LeadInboxRuntime({
		projects,
		store: store as never,
		registry: new RuntimeRegistry(),
		commDbPathForProject: (project) => join(root, `${project}.db`),
		ownerEpoch: "owner-runtime",
		runLegacyCutover: () => {},
		adapterForLead: () => ({ deliverBatch }),
		runnerAdapterForProject: () => ({
			deliver: vi.fn(),
			resolveQuestion: () => undefined,
			close: vi.fn(),
		}),
	});
	runtimes.push(runtime);
	for (const target of runtime.healthTargets())
		target.queue.enqueue({
			id: `${target.leadId}-question`,
			fromAgent: "runner",
			toAgent: target.leadId,
			recipientKind: "lead",
			type: "regular",
			content: "real pending work",
			senderRef: encodeSenderRef(),
		});
	runtime.start();
	await vi.waitFor(() => expect(deliverBatch).toHaveBeenCalledTimes(2));
	for (const { projectName, leadId, queue } of runtime.healthTargets()) {
		const batch = deliverBatch.mock.calls
			.map(([value]) => value)
			.find((value) => value.leadId === leadId)!;
		expect(batch.modelPayload).toContain("只读账目概览");
		expect(batch.modelPayload).toContain(`execution=${projectName}-exec`);
		expect(store.readLeadAuditSummary).toHaveBeenCalledWith(
			{ projectName, leadId },
			undefined,
		);
		await vi.waitFor(() =>
			expect(
				queue.getLeadAuditSummaryCursor({
					projectName,
					leadId,
					storeEpoch: "generation-a",
					ownerEpoch: "owner-runtime",
					now: new Date().toISOString(),
				})?.offeredThroughSeq,
			).toBe(3),
		);
	}
});
