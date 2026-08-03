import { describe, expect, it, vi } from "vitest";
import { type LeadEventRow, StateStore } from "../../StateStore.js";
import type {
	WorkflowRunnerShipMergeCandidate,
	WorkflowShipReadyNotice,
} from "../../workflow-ship-ready.js";
import { canonicalLeadEventDeliveryId } from "../lead-event-queue.js";
import {
	createWorkflowRunnerShipMergedClassifier,
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

function mergeCandidate(
	overrides: Partial<WorkflowRunnerShipMergeCandidate> = {},
): WorkflowRunnerShipMergeCandidate {
	return {
		runId: "run-1",
		issueId: "issue-1",
		projectName: "flywheel",
		templateId: "tpl_eng_heavy",
		gateNodeId: "founder_gate",
		attempt: 1,
		questionId: "question-1",
		holderState: "approved",
		carrierBindingState: "bound",
		subjectDigest: HEAD,
		sourceExecutionId: "implement-1",
		gateOpenedAt: "2026-07-22T01:00:00.000Z",
		authority: {
			status: "resolved",
			repoIdentity: "__main__",
			probeRepoSlug: "xrliAnnie/flywheel",
			prNumber: 1624,
			source: "ship_target",
		},
		fingerprint: "__main__:xrliAnnie/flywheel:1624",
		prNumber: 1624,
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

describe("runner-ship merged classifier", () => {
	it("pins a current merged observation and passes the resolved repository explicitly", async () => {
		const checkPrMerge = vi.fn(async () => ({
			state: "merged" as const,
			headRefOid: HEAD,
			rawHeadRefOid: HEAD,
		}));
		const enrichPrHead = vi.fn(async () => ({
			ok: true as const,
			headSha: HEAD,
			mergedAt: "2026-07-22T01:00:00.000Z",
		}));
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			enrichPrHead,
			now: () => 0,
		});

		expect(await classify([mergeCandidate()])).toEqual(
			new Map([
				[
					"question-1",
					{
						state: "merged",
						headRefOid: HEAD,
						rawHeadRefOid: HEAD,
						evidence: "current",
						fingerprint: "__main__:xrliAnnie/flywheel:1624",
					},
				],
			]),
		);
		await classify([mergeCandidate()]);
		await classify([
			mergeCandidate({ mergedObserved: { status: "valid", headSha: HEAD } }),
		]);
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
		expect(checkPrMerge).toHaveBeenCalledWith(
			"/repo/flywheel",
			1624,
			2_500,
			"xrliAnnie/flywheel",
		);
		expect(enrichPrHead).not.toHaveBeenCalled();
		await classify([]);
		await classify([
			mergeCandidate({ mergedObserved: { status: "valid", headSha: HEAD } }),
		]);
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
		expect(enrichPrHead).toHaveBeenCalledOnce();
	});

	it("revalidates a hydrated valid head once before making it actionable", async () => {
		const checkPrMerge = vi.fn();
		const enrichPrHead = vi.fn(async () => ({
			ok: true as const,
			headSha: HEAD,
			mergedAt: "2026-07-22T01:00:00.000Z",
		}));
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			enrichPrHead,
			now: () => 0,
		});
		const candidate = mergeCandidate({
			mergedObserved: { status: "valid", headSha: HEAD },
		});

		expect(await classify([candidate])).toEqual(
			new Map([
				[
					"question-1",
					{
						state: "merged",
						headRefOid: HEAD,
						rawHeadRefOid: HEAD,
						evidence: "verified",
						fingerprint: "__main__:xrliAnnie/flywheel:1624",
					},
				],
			]),
		);
		await classify([candidate]);
		expect(checkPrMerge).not.toHaveBeenCalled();
		expect(enrichPrHead).toHaveBeenCalledTimes(1);
	});

	it("uses REST only to enrich a persisted merged observation without a head", async () => {
		const checkPrMerge = vi.fn();
		const enrichPrHead = vi.fn(async () => ({
			ok: true as const,
			headSha: "b".repeat(40),
			mergedAt: "2026-07-22T01:00:00.000Z",
		}));
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			enrichPrHead,
			now: () => 0,
		});

		expect(
			await classify([
				mergeCandidate({ mergedObserved: { status: "needs_rest" } }),
			]),
		).toEqual(
			new Map([
				[
					"question-1",
					{
						state: "merged",
						headRefOid: "b".repeat(40),
						rawHeadRefOid: "b".repeat(40),
						evidence: "current",
						fingerprint: "__main__:xrliAnnie/flywheel:1624",
					},
				],
			]),
		);
		expect(checkPrMerge).not.toHaveBeenCalled();
		expect(enrichPrHead).toHaveBeenCalledTimes(1);
	});

	it("keeps a legacy merged observation pinned for the boot across an empty batch", async () => {
		const checkPrMerge = vi.fn(async () => ({
			state: "merged" as const,
			headRefOid: HEAD,
			rawHeadRefOid: HEAD,
		}));
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			enrichPrHead: vi.fn(),
			now: () => 0,
		});
		const legacy = mergeCandidate({
			fingerprint: undefined,
			mergedObserved: undefined,
			authority: { status: "legacy_missing", prNumber: 1624 },
		});

		await classify([legacy]);
		await classify([]);
		await classify([legacy]);
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
	});

	it("holds open results for sixty seconds and backs unknown results off per key", async () => {
		let now = 0;
		const checkPrMerge = vi
			.fn()
			.mockResolvedValueOnce({ state: "open" })
			.mockResolvedValueOnce({ state: "open" })
			.mockResolvedValueOnce({ state: "unknown" })
			.mockResolvedValueOnce({ state: "open" });
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			enrichPrHead: vi.fn(),
			now: () => now,
		});
		await classify([mergeCandidate()]);
		now = 59_999;
		await classify([mergeCandidate()]);
		expect(checkPrMerge).toHaveBeenCalledTimes(1);
		now = 60_000;
		await classify([mergeCandidate()]);
		expect(checkPrMerge).toHaveBeenCalledTimes(2);

		const other = mergeCandidate({
			questionId: "question-2",
			fingerprint: "__main__:xrliAnnie/flywheel:1625",
			authority: {
				status: "resolved",
				repoIdentity: "__main__",
				probeRepoSlug: "xrliAnnie/flywheel",
				prNumber: 1625,
				source: "ship_target",
			},
			prNumber: 1625,
		});
		await classify([other]);
		now = 89_999;
		await classify([other]);
		expect(checkPrMerge).toHaveBeenCalledTimes(3);
		now = 90_000;
		await classify([other]);
		expect(checkPrMerge).toHaveBeenCalledTimes(3);
		now = 120_000;
		await classify([other]);
		expect(checkPrMerge).toHaveBeenCalledTimes(4);
	});

	it("pins a headless merged result before REST succeeds and never returns to GraphQL", async () => {
		let now = 0;
		const checkPrMerge = vi.fn(async () => ({
			state: "merged" as const,
			rawHeadRefOid: "not-a-sha",
		}));
		const enrichPrHead = vi
			.fn()
			.mockResolvedValueOnce({ ok: false as const, reason: "nonzero" as const })
			.mockResolvedValueOnce({
				ok: true as const,
				headSha: HEAD,
				mergedAt: "2026-07-22T01:00:00.000Z",
			});
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			enrichPrHead,
			now: () => now,
		});
		expect(await classify([mergeCandidate()])).toEqual(
			new Map([
				[
					"question-1",
					{
						state: "merged",
						rawHeadRefOid: "not-a-sha",
						evidence: "current",
						fingerprint: "__main__:xrliAnnie/flywheel:1624",
						failure: {
							kind: "head_enrichment",
							reason: "nonzero",
							notify: false,
						},
					},
				],
			]),
		);
		now = 29_999;
		await classify([mergeCandidate()]);
		expect(checkPrMerge).toHaveBeenCalledOnce();
		expect(enrichPrHead).toHaveBeenCalledOnce();

		now = 30_000;
		const hydrated = mergeCandidate({
			mergedObserved: { status: "needs_rest" },
		});
		expect(await classify([hydrated])).toEqual(
			new Map([
				[
					"question-1",
					expect.objectContaining({
						state: "merged",
						headRefOid: HEAD,
						evidence: "current",
					}),
				],
			]),
		);
		expect(checkPrMerge).toHaveBeenCalledOnce();
		expect(enrichPrHead).toHaveBeenCalledTimes(2);
		await classify([hydrated]);
		expect(checkPrMerge).toHaveBeenCalledOnce();
		expect(enrichPrHead).toHaveBeenCalledTimes(2);
	});

	it("single-flights every holder sharing one resolved fingerprint", async () => {
		let resolveProbe:
			| ((value: { state: "merged"; headRefOid: string }) => void)
			| undefined;
		const checkPrMerge = vi.fn(
			() =>
				new Promise<{ state: "merged"; headRefOid: string }>((resolve) => {
					resolveProbe = resolve;
				}),
		);
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			enrichPrHead: vi.fn(),
			now: () => 0,
		});
		const pending = classify([
			mergeCandidate({ questionId: "question-a" }),
			mergeCandidate({ questionId: "question-b", runId: "run-b" }),
		]);
		await vi.waitFor(() => expect(resolveProbe).toBeTypeOf("function"));
		resolveProbe?.({ state: "merged", headRefOid: HEAD });
		expect(await pending).toEqual(
			new Map([
				["question-a", expect.objectContaining({ state: "merged" })],
				["question-b", expect.objectContaining({ state: "merged" })],
			]),
		);
		expect(checkPrMerge).toHaveBeenCalledOnce();
	});

	it("shares a six-per-minute project budget fairly across GraphQL and REST work", async () => {
		let now = 0;
		const gqlPrs: number[] = [];
		const restPrs: number[] = [];
		const checkPrMerge = vi.fn(async (_root: string, prNumber: number) => {
			gqlPrs.push(prNumber);
			return { state: "open" as const };
		});
		const enrichPrHead = vi.fn(
			async (_root: string, _slug: string | null, prNumber: number) => {
				restPrs.push(prNumber);
				return { ok: false as const, reason: "nonzero" as const };
			},
		);
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge,
			enrichPrHead,
			now: () => now,
		});
		const batch = Array.from({ length: 8 }, (_, index) => {
			const prNumber = 1700 + index;
			return mergeCandidate({
				questionId: `question-${index}`,
				fingerprint: `__main__:xrliAnnie/flywheel:${prNumber}`,
				authority: {
					status: "resolved",
					repoIdentity: "__main__",
					probeRepoSlug: "xrliAnnie/flywheel",
					prNumber,
					source: "ship_target",
				},
				prNumber,
				...(index % 2 === 0
					? { mergedObserved: { status: "needs_rest" as const } }
					: {}),
			});
		});
		await classify(batch);
		expect(gqlPrs.length + restPrs.length).toBe(6);
		now = 61_000;
		await classify(batch);
		expect(new Set([...gqlPrs, ...restPrs]).size).toBe(8);
	});

	it("keeps REST failure backoff separate and only notifies on the fifth crossing", async () => {
		let now = 0;
		const enrichPrHead = vi.fn(async () => ({
			ok: false as const,
			reason: "nonzero" as const,
		}));
		const classify = createWorkflowRunnerShipMergedClassifier({
			projectRootFor: () => "/repo/flywheel",
			checkPrMerge: vi.fn(),
			enrichPrHead,
			now: () => now,
		});
		const hydrated = mergeCandidate({
			mergedObserved: { status: "valid", headSha: HEAD },
		});
		for (const [index, at] of [0, 30_000, 90_000, 210_000, 450_000].entries()) {
			now = at;
			const result = (await classify([hydrated])).get("question-1");
			expect(result).toMatchObject({
				state: "unknown",
				failure: {
					kind: "hydration_revalidation",
					reason: "nonzero",
					notify: index === 4,
				},
			});
		}
		expect(enrichPrHead).toHaveBeenCalledTimes(5);
	});
});
