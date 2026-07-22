import { describe, expect, it, vi } from "vitest";
import { type LeadEventRow, StateStore } from "../../StateStore.js";
import type { WorkflowShipReadyNotice } from "../../workflow-ship-ready.js";
import { canonicalLeadEventDeliveryId } from "../lead-event-queue.js";
import {
	createWorkflowShipReadyArm,
	createWorkflowShipReadyHandledClassifier,
} from "../workflow-ship-ready-arm.js";

const HEAD = "a".repeat(40);

function notice(
	overrides: Partial<WorkflowShipReadyNotice> = {},
): WorkflowShipReadyNotice {
	return {
		runId: "run-1",
		issueId: "issue-1",
		issueIdentifier: "FLY-1424",
		projectName: "flywheel",
		templateId: "tpl_eng_heavy",
		gateNodeId: "founder_gate",
		attempt: 1,
		gateOpenedAt: "2026-07-22T01:00:00.000Z",
		sourceExecutionId: "qa-1",
		ageMinutes: 31,
		evidence: { headSha: HEAD, prNumber: 1424, qaPassed: true },
		pending: { lead: true, founder: true },
		...overrides,
	};
}

function journalStore() {
	let persisted: LeadEventRow | undefined;
	return {
		appendLeadEvent: vi.fn(
			(
				leadId: string,
				eventId: string,
				eventType: string,
				payload: string,
				sessionKey?: string,
			) => {
				persisted ??= {
					seq: 7,
					lead_id: leadId,
					event_id: eventId,
					event_type: eventType,
					payload,
					session_key: sessionKey,
					created_at: "2026-07-22 01:02:03",
				};
				return persisted.seq;
			},
		),
		getLeadEventBySeq: vi.fn(() => persisted ?? null),
		getChatThreadByIssue: vi.fn(() => ({
			thread_id: "thread-1",
			channel_id: "channel-1",
			lead_id: "flywheel-eng-lead",
			archived_at: null,
		})),
		hasWorkflowShipReadyFounderApproval: vi.fn(() => false),
	};
}

describe("workflow ship-ready delivery arm", () => {
	it("uses a real appendLeadEvent SQLite timestamp and replays byte-identically", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertChatThread(
			"thread-real",
			"channel-real",
			"issue-1",
			"flywheel-eng-lead",
		);
		const captured: Array<Parameters<typeof canonicalLeadEventDeliveryId>[0]> =
			[];
		const arm = createWorkflowShipReadyArm({
			store,
			resolveLead: () => ({
				leadId: "flywheel-eng-lead",
				chatChannel: "channel-real",
				botToken: "bot-token",
			}),
			enqueueLeadEvent: (envelope) => {
				captured.push(envelope);
				return {
					queued: true,
					deliveryId: canonicalLeadEventDeliveryId(envelope),
					seq: envelope.seq,
				};
			},
			emitFounderThreadNotification: vi.fn(),
			ownerUserId: "123456789012345678",
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge: vi.fn(),
		});
		await arm.queueLeadNotice(notice());
		await arm.queueLeadNotice(notice());
		expect(captured[0]).toEqual(captured[1]);
		expect(captured[0]?.timestamp).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/,
		);
		expect(captured[0]?.event.chat_thread_id).toBe("thread-real");
		store.close();
	});

	it("rebuilds the canonical Lead envelope from the journal on crash replay", async () => {
		const store = journalStore();
		const captured: Array<Parameters<typeof canonicalLeadEventDeliveryId>[0]> =
			[];
		let crash = true;
		const enqueueLeadEvent = vi.fn((envelope) => {
			captured.push(envelope);
			if (crash) {
				crash = false;
				throw new Error("crash after appendLeadEvent");
			}
			return {
				queued: true,
				deliveryId: canonicalLeadEventDeliveryId(envelope),
				seq: envelope.seq,
			};
		});
		const arm = createWorkflowShipReadyArm({
			store,
			resolveLead: () => ({
				leadId: "flywheel-eng-lead",
				chatChannel: "channel-1",
				botToken: "bot-token",
			}),
			enqueueLeadEvent,
			emitFounderThreadNotification: vi.fn(),
			ownerUserId: "123456789012345678",
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge: vi.fn(),
		});

		await expect(arm.queueLeadNotice(notice())).rejects.toThrow(
			"crash after appendLeadEvent",
		);
		await expect(arm.queueLeadNotice(notice())).resolves.toEqual({
			queued: true,
		});
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(2);
		expect(captured).toHaveLength(2);
		expect(captured[0]).toEqual(captured[1]);
		expect(captured[1]).toMatchObject({
			seq: 7,
			eventId: "workflow_ship_ready:run-1:founder_gate:1",
			leadId: "flywheel-eng-lead",
			sessionKey: "qa-1",
			timestamp: "2026-07-22T01:02:03.000Z",
			priority: 1,
			event: {
				event_type: "workflow_ship_ready",
				execution_id: "qa-1",
				status: "ship_ready",
				pr_number: 1424,
				chat_thread_id: "thread-1",
			},
		});
		expect(canonicalLeadEventDeliveryId(captured[1]!)).toBe(
			"lead_event:flywheel-eng-lead:workflow_ship_ready:run-1:founder_gate:1",
		);
	});

	it("maps every founder notifier outcome and renders evidence honestly", async () => {
		const store = journalStore();
		const outcomes = [
			{ kind: "posted" as const },
			{ kind: "transient_failed" as const, retryAfterMs: 2_000 },
			{ kind: "skipped" as const, skipReason: "no_chat_thread" as const },
			{ kind: "skipped" as const, skipReason: "no_owner" as const },
			{ kind: "permanent_failed" as const },
		];
		const emit = vi.fn(async () => outcomes.shift()!);
		const arm = createWorkflowShipReadyArm({
			store,
			resolveLead: () => ({
				leadId: "flywheel-eng-lead",
				chatChannel: "channel-1",
				botToken: "bot-token",
			}),
			enqueueLeadEvent: vi.fn(),
			emitFounderThreadNotification: emit,
			ownerUserId: "123456789012345678",
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge: vi.fn(),
		});

		await expect(arm.postFounderCard(notice())).resolves.toEqual({
			kind: "posted",
		});
		await expect(arm.postFounderCard(notice())).resolves.toEqual({
			kind: "transient",
			reason: "transient_failed",
			retryAfterMs: 2_000,
		});
		await expect(arm.postFounderCard(notice())).resolves.toEqual({
			kind: "transient",
			reason: "no_chat_thread",
		});
		await expect(arm.postFounderCard(notice())).resolves.toEqual({
			kind: "permanent",
			reason: "no_owner",
		});
		await expect(arm.postFounderCard(notice())).resolves.toEqual({
			kind: "permanent",
			reason: "permanent_failed",
		});
		expect(emit.mock.calls[0]?.[0]).toMatchObject({
			checkpoint: "ship_ready",
			questionId: "run-1:founder_gate:1",
			summary: expect.stringContaining("PR #1424 (head aaaaaaaa) · QA passed"),
		});

		outcomes.push({ kind: "posted" });
		await arm.postFounderCard(notice({ evidence: { qaPassed: false } }));
		expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({
			summary: expect.stringContaining("⚠️ 证据缺失（无 qa_passed claim）"),
		});
	});
});

describe("workflow ship-ready handled classifier", () => {
	it("distinguishes founder approval, a merged PR, and missing-PR unhandled", async () => {
		const approved = new Set(["run-approved"]);
		const checkPrMerge = vi.fn(async (_root: string, pr: number) => ({
			state: pr === 1 ? ("merged" as const) : ("open" as const),
		}));
		const classify = createWorkflowShipReadyHandledClassifier({
			hasFounderApproval: (runId) => approved.has(runId),
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			now: () => 0,
		});
		const batch = [
			notice({
				runId: "run-approved",
				evidence: { prNumber: 9, qaPassed: true },
			}),
			notice({
				runId: "run-merged",
				evidence: { prNumber: 1, qaPassed: true },
			}),
			notice({ runId: "run-no-pr", evidence: { qaPassed: true } }),
		];
		await expect(classify(batch)).resolves.toEqual(
			new Map([
				[
					"run-approved:founder_gate:1",
					{ kind: "handled", reason: "founder_approved" },
				],
				["run-merged:founder_gate:1", { kind: "handled", reason: "pr_merged" }],
				["run-no-pr:founder_gate:1", { kind: "unhandled" }],
			]),
		);
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
	});

	it("rechecks founder approval after a pending non-merge probe", async () => {
		let founderApproved = false;
		let resolveProbe: ((value: { state: "open" }) => void) | undefined;
		const classify = createWorkflowShipReadyHandledClassifier({
			hasFounderApproval: () => founderApproved,
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge: () =>
				new Promise((resolve) => {
					resolveProbe = resolve;
				}),
			now: () => 0,
		});
		const pending = classify([notice()]);
		await vi.waitFor(() => expect(resolveProbe).toBeTypeOf("function"));
		founderApproved = true;
		resolveProbe?.({ state: "open" });
		expect(await pending).toEqual(
			new Map([
				[
					"run-1:founder_gate:1",
					{ kind: "handled", reason: "founder_approved" },
				],
			]),
		);
	});

	it("isolates one rejected probe while classifying its peer", async () => {
		const classify = createWorkflowShipReadyHandledClassifier({
			hasFounderApproval: () => false,
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge: async (_root, pr) => {
				if (pr === 1) throw new Error("gh exploded");
				return { state: "open" };
			},
			now: () => 0,
		});
		expect(
			await classify([
				notice({
					runId: "run-poison",
					evidence: { prNumber: 1, qaPassed: true },
				}),
				notice({
					runId: "run-good",
					evidence: { prNumber: 2, qaPassed: true },
				}),
			]),
		).toEqual(
			new Map([
				["run-poison:founder_gate:1", { kind: "unknown" }],
				["run-good:founder_gate:1", { kind: "unhandled" }],
			]),
		);
	});

	it("shares in-flight probes, caches definitive results, and prunes per-key backoff on an empty batch", async () => {
		let now = 0;
		let resolveProbe:
			| ((value: { state: "open" | "unknown" }) => void)
			| undefined;
		const checkPrMerge = vi.fn(
			() =>
				new Promise<{ state: "open" | "unknown" }>((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const classify = createWorkflowShipReadyHandledClassifier({
			hasFounderApproval: () => false,
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			now: () => now,
		});
		const first = classify([
			notice({ runId: "run-a" }),
			notice({ runId: "run-b" }),
		]);
		await vi.waitFor(() => expect(resolveProbe).toBeTypeOf("function"));
		resolveProbe?.({ state: "open" });
		await first;
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
		await classify([notice({ runId: "run-a" })]);
		expect(checkPrMerge).toHaveBeenCalledTimes(1);

		now = 16_000;
		const unknown = classify([
			notice({
				runId: "run-backoff",
				evidence: { prNumber: 99, qaPassed: true },
			}),
		]);
		await vi.waitFor(() => expect(checkPrMerge).toHaveBeenCalledTimes(2));
		resolveProbe?.({ state: "unknown" });
		await unknown;
		await classify([
			notice({
				runId: "run-backoff",
				evidence: { prNumber: 99, qaPassed: true },
			}),
		]);
		expect(checkPrMerge).toHaveBeenCalledTimes(2);
		await classify([]);
		const fresh = classify([
			notice({
				runId: "run-backoff",
				evidence: { prNumber: 99, qaPassed: true },
			}),
		]);
		await vi.waitFor(() => expect(checkPrMerge).toHaveBeenCalledTimes(3));
		resolveProbe?.({ state: "open" });
		await fresh;
	});

	it("gives every never-probed key a turn before any old key probes twice", async () => {
		let now = 0;
		const rawPrs: number[] = [];
		const classify = createWorkflowShipReadyHandledClassifier({
			hasFounderApproval: () => false,
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge: async (_root, pr) => {
				rawPrs.push(pr);
				return { state: "unknown" };
			},
			now: () => now,
		});
		const batch = Array.from({ length: 7 }, (_, index) =>
			notice({
				runId: `run-${index + 1}`,
				evidence: { prNumber: index + 1, qaPassed: true },
			}),
		);
		await classify(batch);
		expect(rawPrs).toEqual([1, 2, 3, 4, 5, 6]);
		now = 61_000;
		await classify(batch);
		expect(rawPrs[6]).toBe(7);
		expect(rawPrs.indexOf(7)).toBeLessThan(rawPrs.lastIndexOf(1));
	});
});
