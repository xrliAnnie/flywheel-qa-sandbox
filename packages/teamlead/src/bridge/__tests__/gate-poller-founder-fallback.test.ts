import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";
const GRACE = 10 * 60_000;
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

function sqliteAgo(ms: number): string {
	return new Date(Date.now() - ms)
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

interface FakeEvent {
	event_id: string;
	event_type: string;
	payload?: unknown;
}

function makeStore(existingEvents: FakeEvent[] = []) {
	const events: FakeEvent[] = [...existingEvents];
	let founderReviewBinding:
		| {
				question_id: string;
				message_id: string;
				run_id: string;
				artifact_digest: string;
				created_at: string;
		  }
		| undefined;
	const store = {
		getChatThreadByIssue: vi.fn(() => ({
			thread_id: "T1",
			channel_id: "C1",
			lead_id: null,
			archived_at: null,
		})),
		getEventsByExecution: vi.fn(() => events.slice()),
		insertEvent: vi.fn((e: FakeEvent) => {
			events.push({
				event_id: e.event_id,
				event_type: e.event_type,
				payload: e.payload,
			});
			return true;
		}),
		getGeneralizedWorkflowNodeForExecution: vi.fn(() => ({
			run: { run_id: "run-1" },
			node: { id: "produce" },
			snapshot: {
				manifest: { nodes: [{ id: "produce", founder_review: true }] },
			},
		})),
		getFounderReviewCardBindingByQuestion: vi.fn(() => founderReviewBinding),
		bindFounderReviewCard: vi.fn((input) => {
			founderReviewBinding = {
				question_id: input.questionId,
				message_id: input.messageId,
				run_id: input.runId,
				artifact_digest: input.artifactDigest,
				created_at: input.createdAt,
			};
			return { status: "inserted" as const };
		}),
	} as unknown as GatePollerConfig["store"];
	return { store, events };
}

const LEAD = {
	agentId: "test-lead",
	chatChannel: "C1",
	botToken: "bot-token",
	match: { labels: ["x"] },
};

const PROJECTS = [
	{ projectName: "flywheel", projectRoot: REPO_ROOT, leads: [LEAD] },
] as unknown as GatePollerConfig["projects"];

function makeSession(over: Record<string, unknown> = {}) {
	return {
		execution_id: "exec1",
		issue_id: "FLY-605",
		issue_identifier: "FLY-605",
		project_name: "flywheel",
		status: "running",
		issue_labels: '["x"]',
		session_role: "main",
		...over,
	};
}

function makeQuestion(over: Record<string, unknown> = {}) {
	return {
		id: "q1",
		from_agent: "exec1",
		content: "my understanding…",
		created_at: sqliteAgo(60 * 60_000), // 1h ago → past grace
		checkpoint: "brainstorm",
		content_type: "text",
		content_ref: null,
		...over,
	};
}

function founderReviewQuestion(over: Record<string, unknown> = {}) {
	return makeQuestion({
		checkpoint: "founder_review",
		content: JSON.stringify({
			version: 1,
			round: 1,
			runId: "run-1",
			artifactDigest: "a".repeat(64),
			hostedUrl: "https://reports.example/prd",
			paths: ["review.html"],
		}),
		...over,
	});
}

function makePoller(
	over: Partial<GatePollerConfig> = {},
	store = makeStore().store,
) {
	return new GatePoller({
		pollIntervalMs: 3_000,
		projects: PROJECTS,
		store,
		runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
		chatThreadsEnabled: true,
		discordOwnerUserId: OWNER,
		founderThreadNotifyGraceMs: GRACE,
		...over,
	});
}

type Priv = {
	maybeEmitFounderThreadFallback(
		lead: unknown,
		session: unknown,
		question: unknown,
		dbPath: string,
	): Promise<void>;
};

async function fallback(
	poller: GatePoller,
	session: unknown,
	question: unknown,
) {
	await (poller as unknown as Priv).maybeEmitFounderThreadFallback(
		LEAD,
		session,
		question,
		"dbpath",
	);
}

describe("FLY-605 GatePoller founder-thread fallback (Part A)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("brainstorm gate past grace → posts once + writes durable marker", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			store,
		);
		await fallback(poller, makeSession(), makeQuestion());
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.event_id === "founder-thread-notify-q1")).toBe(
			true,
		);
	});

	it("approve_to_ship gate past grace → posts", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await fallback(
			poller,
			makeSession(),
			makeQuestion({ checkpoint: "approve_to_ship" }),
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("holder-backed approve gate yields to the materializer while a legacy gate still posts", async () => {
		const { store } = makeStore();
		store.workflowGatePresentationDisposition = vi.fn((input) =>
			input.questionId === "holder-q"
				? { allow: true, reason: "holder_authoritative" }
				: { allow: true, reason: "legacy" },
		) as never;
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			store,
		);

		await fallback(
			poller,
			makeSession(),
			makeQuestion({
				id: "holder-q",
				checkpoint: "approve_to_ship",
			}),
		);
		await fallback(
			poller,
			makeSession(),
			makeQuestion({ id: "legacy-q", checkpoint: "approve_to_ship" }),
		);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("founder_review becomes delivered only after the Discord card is immutably bound", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "card-1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const poller = makePoller(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			store,
		);
		await fallback(poller, makeSession(), founderReviewQuestion());
		expect(store.bindFounderReviewCard).toHaveBeenCalledWith(
			expect.objectContaining({
				questionId: "q1",
				messageId: "card-1",
				runId: "run-1",
				artifactDigest: "a".repeat(64),
			}),
		);
		expect(
			events.some((event) => event.event_id === "founder-thread-notify-q1"),
		).toBe(true);
	});

	it("founder_review 2xx without a message id is not delivered or counted", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			store,
		);
		await fallback(poller, makeSession(), founderReviewQuestion());
		expect(store.bindFounderReviewCard).not.toHaveBeenCalled();
		expect(
			events.some((event) => event.event_id === "founder-thread-notify-q1"),
		).toBe(false);
	});

	it("recovers the founder_review marker from an existing binding without reposting", async () => {
		const { store, events } = makeStore();
		store.getFounderReviewCardBindingByQuestion = vi.fn(() => ({
			question_id: "q1",
			message_id: "card-1",
			run_id: "run-1",
			artifact_digest: "a".repeat(64),
			created_at: "2026-08-14T00:00:00.000Z",
		})) as never;
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			store,
		);
		await fallback(poller, makeSession(), founderReviewQuestion());
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(
			events.some((event) => event.event_id === "founder-thread-notify-q1"),
		).toBe(true);
	});

	it("FLY-1238: MERGED approve gate is silent and gets no durable done marker", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const mergedGateGuard = vi.fn().mockResolvedValue({
			kind: "suppress_merged",
			cleanupComplete: true,
		});
		const poller = makePoller(
			{
				fetchImpl: fetchImpl as unknown as typeof fetch,
				mergedGateGuard,
			},
			store,
		);
		await fallback(
			poller,
			makeSession({
				status: "awaiting_review",
				review_question_id: "q1",
				pr_number: 588,
			}),
			makeQuestion({ checkpoint: "approve_to_ship" }),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(events.some((e) => e.event_id === "founder-thread-notify-q1")).toBe(
			false,
		);
	});

	it.each([
		{ kind: "retry_later", reason: "unknown" },
		{ kind: "terminal_unavailable", reason: "unknown_exhausted" },
	])(
		"FLY-1238: $kind is silent without a permanent done marker",
		async (guarded) => {
			const { store, events } = makeStore();
			const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
			const poller = makePoller(
				{
					fetchImpl: fetchImpl as unknown as typeof fetch,
					mergedGateGuard: vi.fn().mockResolvedValue(guarded),
				},
				store,
			);
			await fallback(
				poller,
				makeSession({
					status: "awaiting_review",
					review_question_id: "q1",
					pr_number: 588,
				}),
				makeQuestion({ checkpoint: "approve_to_ship" }),
			);
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(
				events.some((e) => e.event_id === "founder-thread-notify-q1"),
			).toBe(false);
		},
	);

	it("runner_question (null) and plain 'question' checkpoint → never triggers", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await fallback(poller, makeSession(), makeQuestion({ checkpoint: null }));
		await fallback(
			poller,
			makeSession(),
			makeQuestion({ checkpoint: "question" }),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("before grace → no POST; same gate across ticks → posts exactly once (in-proc dedup)", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await fallback(
			poller,
			makeSession(),
			makeQuestion({ created_at: sqliteAgo(60_000) }),
		); // 1min < grace
		expect(fetchImpl).not.toHaveBeenCalled();
		// now past grace, two ticks → one POST
		await fallback(poller, makeSession(), makeQuestion());
		await fallback(poller, makeSession(), makeQuestion());
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("transient failure = TIME budget: keeps retrying within budget, gives up only after it (Codex R1 #4)", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
		const poller = makePoller({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			founderThreadRetryBudgetMs: 100, // tiny budget for the test
		});
		await fallback(poller, makeSession(), makeQuestion()); // attempt 1 → transient, schedules retry
		// nextAttemptAt is in the future → an immediate re-call is suppressed by backoff
		await fallback(poller, makeSession(), makeQuestion());
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		// after the budget elapses it gives up (writes marker), never silently looping forever
		await new Promise((r) => setTimeout(r, 120));
		await fallback(poller, makeSession(), makeQuestion());
	});

	it("FLY-725: permanent (4xx) delivery failure escalates on the alert channel (never silent) + writes terminal marker", async () => {
		const { store, events } = makeStore();
		const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
		const alert = vi.fn(async () => ({ sent: true }));
		const poller = makePoller(
			{
				fetchImpl: fetchImpl as unknown as typeof fetch,
				leadAlertSink: {
					alert,
				} as unknown as GatePollerConfig["leadAlertSink"],
			},
			store,
		);
		await fallback(
			poller,
			makeSession(),
			makeQuestion({ checkpoint: "approve_to_ship" }),
		);
		// The founder was not pinged → alert-channel escalation fired.
		expect(alert).toHaveBeenCalledTimes(1);
		expect((alert.mock.calls[0]?.[0] as { eventType: string }).eventType).toBe(
			"founder_gate_delivery_failed",
		);
		// Terminal marker still written (a 4xx won't fix itself).
		expect(events.some((e) => e.event_id === "founder-thread-notify-q1")).toBe(
			true,
		);
	});

	it("FLY-725: no_chat_thread is transient — retries (no terminal marker / no escalation within budget)", async () => {
		const { store, events } = makeStore();
		store.getChatThreadByIssue = vi.fn(() => undefined) as never;
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const alert = vi.fn(async () => ({ sent: true }));
		const poller = makePoller(
			{
				fetchImpl: fetchImpl as unknown as typeof fetch,
				leadAlertSink: {
					alert,
				} as unknown as GatePollerConfig["leadAlertSink"],
			},
			store,
		);
		await fallback(
			poller,
			makeSession(),
			makeQuestion({ checkpoint: "approve_to_ship" }),
		);
		// No thread yet → skipped:no_chat_thread → transient retry, NOT terminal.
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(events.some((e) => e.event_id === "founder-thread-notify-q1")).toBe(
			false,
		);
		expect(alert).not.toHaveBeenCalled();
	});

	it("durable marker already present (Bridge restart) → no POST", async () => {
		const { store } = makeStore([
			{
				event_id: "founder-thread-notify-q1",
				event_type: "founder_thread_notify_done",
			},
		]);
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			store,
		);
		await fallback(poller, makeSession(), makeQuestion());
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("chatThreadsEnabled=false / missing owner → never triggers", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		await fallback(
			makePoller({
				chatThreadsEnabled: false,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
			makeSession(),
			makeQuestion(),
		);
		await fallback(
			makePoller({
				discordOwnerUserId: undefined,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
			makeSession(),
			makeQuestion(),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("session not active → never triggers", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await fallback(
			poller,
			makeSession({ status: "completed" }),
			makeQuestion(),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("FLY-1041 Chunk 6: ship-gate card promotion (15s grace)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("un-held ship gate 30s old → card posted NOW (15s ship grace, not the 10min fallback)", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await fallback(
			poller,
			makeSession(),
			makeQuestion({
				checkpoint: "approve_to_ship",
				created_at: sqliteAgo(30_000),
			}),
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("brainstorm gate 30s old → still waits the 10min grace (unchanged)", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller({
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		await fallback(
			poller,
			makeSession(),
			makeQuestion({ created_at: sqliteAgo(30_000) }),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps the explicit card-grace test seam", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const poller = makePoller({
			fetchImpl: fetchImpl as unknown as typeof fetch,
			shipGateCardGraceMs: 60_000,
		});
		await fallback(
			poller,
			makeSession(),
			makeQuestion({
				checkpoint: "approve_to_ship",
				created_at: sqliteAgo(30_000), // younger than the 60s override
			}),
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
