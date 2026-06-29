/**
 * FLY-161: GatePoller tests — covers both gate_question (FLY-62) and
 * runner_question (FLY-161) flows, plus the active-session + lead-scope
 * gating that gate_question must continue to honor.
 *
 * Uses a real on-disk CommDB (via temp HOME redirect so
 * defaultGetCommDbPath() resolves to a tmp tree) + in-memory StateStore +
 * a stub LeadRuntime captured by RuntimeRegistry.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatePoller } from "../bridge/gate-poller.js";
import type {
	DeliveryResult,
	LeadEventEnvelope,
	LeadRuntime,
	LeadRuntimeHealth,
} from "../bridge/lead-runtime.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import { defaultGetCommDbPath } from "../bridge/session-capture.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

interface CapturedEnvelope {
	envelope: LeadEventEnvelope;
}

class StubLeadRuntime implements LeadRuntime {
	readonly type = "stub" as const;
	readonly captured: CapturedEnvelope[] = [];
	private nextResult: DeliveryResult = { delivered: true };

	async deliver(envelope: LeadEventEnvelope): Promise<DeliveryResult> {
		this.captured.push({ envelope });
		return this.nextResult;
	}

	async sendBootstrap(): Promise<void> {
		// not used in these tests
	}

	async health(): Promise<LeadRuntimeHealth> {
		return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 };
	}

	async shutdown(): Promise<void> {
		// no-op
	}

	queueResult(result: DeliveryResult): void {
		this.nextResult = result;
	}
}

const PROJECT_NAME = "fly-161-test";

const projects: ProjectEntry[] = [
	{
		projectName: PROJECT_NAME,
		projectRoot: "/tmp/fly-161-test-root",
		leads: [
			{
				agentId: "product-lead",
				chatChannel: "chat-product",
				match: { labels: ["product"] },
			},
			{
				agentId: "ops-lead",
				chatChannel: "chat-ops",
				match: { labels: ["ops"] },
			},
		],
	},
];

describe("GatePoller (FLY-161)", () => {
	let store: StateStore;
	let registry: RuntimeRegistry;
	let runtime: StubLeadRuntime;
	let opsRuntime: StubLeadRuntime;
	let originalHome: string | undefined;
	let tmpHome: string;
	let dbPath: string;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		// Redirect HOME so defaultGetCommDbPath() resolves to a temp tree.
		originalHome = process.env.HOME;
		tmpHome = join(tmpdir(), `gate-poller-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpHome, { recursive: true });
		process.env.HOME = tmpHome;
		dbPath = defaultGetCommDbPath(PROJECT_NAME);

		// Make a fresh CommDB at the expected path.
		const db = new CommDB(dbPath);
		db.close();

		store = await StateStore.create(":memory:");
		registry = new RuntimeRegistry();
		runtime = new StubLeadRuntime();
		opsRuntime = new StubLeadRuntime();
		registry.register(projects[0]!.leads[0]!, runtime); // product-lead
		registry.register(projects[0]!.leads[1]!, opsRuntime); // ops-lead

		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		store.close();
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		rmSync(tmpHome, { recursive: true, force: true });
		warnSpy.mockRestore();
	});

	function makePoller(opts?: {
		chatThreadsEnabled?: boolean;
		circuitThreshold?: number;
		circuitCooldownTicks?: number;
		evictionRetryTicks?: number;
		patrolEveryNTicks?: number;
		transport?: import("../bridge/gate-poller.js").MisroutePatrolTransport;
		misrouteArchiveDir?: string;
	}): GatePoller {
		return new GatePoller({
			pollIntervalMs: 60_000, // not auto-started in tests
			projects,
			store,
			runtimeRegistry: registry,
			chatThreadsEnabled: opts?.chatThreadsEnabled,
			circuitThreshold: opts?.circuitThreshold,
			circuitCooldownTicks: opts?.circuitCooldownTicks,
			evictionRetryTicks: opts?.evictionRetryTicks,
			patrolEveryNTicks: opts?.patrolEveryNTicks,
			transport: opts?.transport,
			misrouteArchiveDir: opts?.misrouteArchiveDir,
		});
	}

	/** Read still-pending questions for a lead directly from the on-disk CommDB. */
	function pendingFor(leadId: string): unknown[] {
		const db = new CommDB(dbPath);
		try {
			return db.getPendingQuestions(leadId);
		} finally {
			db.close();
		}
	}

	function insertSession(
		execId: string,
		opts: { status?: string; labels?: string[]; issueId?: string } = {},
	): void {
		store.upsertSession({
			execution_id: execId,
			issue_id: opts.issueId ?? `issue-${execId}`,
			issue_identifier: `FLY-${execId}`,
			project_name: PROJECT_NAME,
			status: opts.status ?? "running",
			issue_labels: JSON.stringify(opts.labels ?? ["product"]),
		});
	}

	function insertQuestion(opts: {
		execId: string;
		leadId: string;
		content: string;
		checkpoint?: string;
	}): string {
		const db = new CommDB(dbPath);
		try {
			return db.insertQuestion(opts.execId, opts.leadId, opts.content, {
				checkpoint: opts.checkpoint,
			});
		} finally {
			db.close();
		}
	}

	async function runPoll(poller: GatePoller): Promise<void> {
		// Access the private poll() directly through start/stop is timer-based.
		// Easier: cast to any and invoke the private method.
		await (poller as unknown as { poll: () => Promise<void> }).poll();
	}

	it("Case 1: emits gate_question for pending question with checkpoint and active session", async () => {
		insertSession("exec-1", { status: "running", labels: ["product"] });
		const qid = insertQuestion({
			execId: "exec-1",
			leadId: "product-lead",
			content: "Please review my plan",
			checkpoint: "brainstorm",
		});

		await runPoll(makePoller());

		expect(runtime.captured).toHaveLength(1);
		const env = runtime.captured[0]!.envelope;
		expect(env.event.event_type).toBe("gate_question");
		expect(env.event.checkpoint).toBe("brainstorm");
		expect(env.event.question_id).toBe(qid);
		expect(env.event.summary).toBe("Please review my plan");
	});

	it("Case 2: emits runner_question for pending question without checkpoint", async () => {
		insertSession("exec-2", { status: "running", labels: ["product"] });
		const qid = insertQuestion({
			execId: "exec-2",
			leadId: "product-lead",
			content: "Should we use UTC or local time?",
		});

		await runPoll(makePoller());

		expect(runtime.captured).toHaveLength(1);
		const env = runtime.captured[0]!.envelope;
		expect(env.event.event_type).toBe("runner_question");
		expect(env.event.checkpoint).toBeUndefined();
		expect(env.event.question_id).toBe(qid);
		expect(env.event.summary).toBe("Should we use UTC or local time?");
	});

	it("Case 3: partitions mixed pending questions by checkpoint presence", async () => {
		insertSession("exec-a", { status: "running", labels: ["product"] });
		insertSession("exec-b", { status: "running", labels: ["product"] });
		insertQuestion({
			execId: "exec-a",
			leadId: "product-lead",
			content: "checkpoint Q",
			checkpoint: "brainstorm",
		});
		insertQuestion({
			execId: "exec-b",
			leadId: "product-lead",
			content: "ask Q",
		});

		await runPoll(makePoller());

		expect(runtime.captured).toHaveLength(2);
		const types = runtime.captured.map((c) => c.envelope.event.event_type);
		expect(types).toContain("gate_question");
		expect(types).toContain("runner_question");
	});

	it("Case 4: does not re-deliver already-delivered events", async () => {
		insertSession("exec-d", { status: "running", labels: ["product"] });
		const qid = insertQuestion({
			execId: "exec-d",
			leadId: "product-lead",
			content: "First-pass content",
		});

		// First poll → delivered
		await runPoll(makePoller());
		expect(runtime.captured).toHaveLength(1);
		// Manually confirm delivered_at was set
		expect(store.isLeadEventDelivered("product-lead", `runner_q_${qid}`)).toBe(
			true,
		);

		// Second poll → must NOT re-deliver
		runtime.captured.length = 0;
		await runPoll(makePoller());
		expect(runtime.captured).toHaveLength(0);
	});

	it("Case 5: re-attempts delivery on next poll when runtime.deliver returns delivered=false", async () => {
		insertSession("exec-r", { status: "running", labels: ["product"] });
		const qid = insertQuestion({
			execId: "exec-r",
			leadId: "product-lead",
			content: "Retryable",
		});

		runtime.queueResult({ delivered: false, error: "stub-fail" });
		const poller = makePoller();
		await runPoll(poller);
		expect(runtime.captured).toHaveLength(1);
		// delivered_at not set → not marked delivered
		expect(store.isLeadEventDelivered("product-lead", `runner_q_${qid}`)).toBe(
			false,
		);

		runtime.queueResult({ delivered: true });
		await runPoll(poller);
		expect(runtime.captured).toHaveLength(2);
		// Now marked delivered
		expect(store.isLeadEventDelivered("product-lead", `runner_q_${qid}`)).toBe(
			true,
		);
	});

	it("Case 6: still emits runner_question for question from completed session", async () => {
		// Insert a session that is NOT active (completed).
		insertSession("exec-c", { status: "completed", labels: ["product"] });
		insertQuestion({
			execId: "exec-c",
			leadId: "product-lead",
			content: "Should I retry?",
		});

		await runPoll(makePoller());

		expect(runtime.captured).toHaveLength(1);
		expect(runtime.captured[0]!.envelope.event.event_type).toBe(
			"runner_question",
		);
	});

	it("Case 7: skips and warns when from_agent has no session record (orphan)", async () => {
		insertQuestion({
			execId: "unknown-exec",
			leadId: "product-lead",
			content: "I am orphaned",
		});

		await runPoll(makePoller());

		expect(runtime.captured).toHaveLength(0);
		const warnedOrphan = warnSpy.mock.calls.some((args: unknown[]) =>
			JSON.stringify(args).includes("orphan question"),
		);
		expect(warnedOrphan).toBe(true);
	});

	it("Case 8 (FLY-307 A): EVICTS gate_question when source session is terminal", async () => {
		insertSession("exec-stale", { status: "completed", labels: ["product"] });
		const qid = insertQuestion({
			execId: "exec-stale",
			leadId: "product-lead",
			content: "Stale gate",
			checkpoint: "brainstorm",
		});
		expect(pendingFor("product-lead")).toHaveLength(1);

		await runPoll(makePoller());

		// No delivery, and the gate is now expired in CommDB (resolveGate(qid,0)).
		expect(runtime.captured).toHaveLength(0);
		expect(pendingFor("product-lead")).toHaveLength(0);
		const warnedEvict = warnSpy.mock.calls.some((args: unknown[]) =>
			JSON.stringify(args).includes(`evicting stale gate_question qid=${qid}`),
		);
		expect(warnedEvict).toBe(true);
	});

	it("Case 8b (FLY-307 A): second poll is silent — no re-warn, no getSession for evicted gate", async () => {
		insertSession("exec-stale2", { status: "completed", labels: ["product"] });
		insertQuestion({
			execId: "exec-stale2",
			leadId: "product-lead",
			content: "Stale gate 2",
			checkpoint: "brainstorm",
		});

		const poller = makePoller();
		await runPoll(poller); // first poll evicts (getPendingQuestions still returned it)

		// Re-insert is NOT possible (it's expired). Now spy getSession and poll again:
		// the evicted gate must never reach getSession again, and never re-warn.
		const getSessionSpy = vi.spyOn(store, "getSession");
		warnSpy.mockClear();
		await runPoll(poller);
		await runPoll(poller);

		expect(getSessionSpy).not.toHaveBeenCalled();
		const reWarned = warnSpy.mock.calls.some((args: unknown[]) =>
			JSON.stringify(args).includes("stale gate_question"),
		);
		expect(reWarned).toBe(false);
		getSessionSpy.mockRestore();
	});

	it("Case 8c (FLY-307 A): write-failure → suppress getSession, retry cleanup after backoff", async () => {
		insertSession("exec-stale3", { status: "completed", labels: ["product"] });
		insertQuestion({
			execId: "exec-stale3",
			leadId: "product-lead",
			content: "Stale gate 3",
			checkpoint: "brainstorm",
		});

		// Make the first eviction write throw (simulated DB lock).
		const resolveSpy = vi
			.spyOn(CommDB.prototype, "resolveGate")
			.mockImplementationOnce(() => {
				throw new Error("database is locked");
			});

		const getSessionSpy = vi.spyOn(store, "getSession");
		const poller = makePoller({ evictionRetryTicks: 2 });

		await runPoll(poller); // tick 1: getSession called, resolveGate throws → retryAt = tick1 + 2
		expect(getSessionSpy).toHaveBeenCalledTimes(1);
		expect(pendingFor("product-lead")).toHaveLength(1); // still pending (write failed)

		await runPoll(poller); // tick 2: within retry window → suppressed (no getSession)
		expect(getSessionSpy).toHaveBeenCalledTimes(1);

		await runPoll(poller); // tick 3: retry window elapsed → retries cleanup directly,
		// WITHOUT another getSession() (we already know it's a terminal stale gate).
		expect(getSessionSpy).toHaveBeenCalledTimes(1);
		expect(pendingFor("product-lead")).toHaveLength(0); // evicted on retry

		resolveSpy.mockRestore();
		getSessionSpy.mockRestore();
	});

	it("Case 8d (FLY-307 A): runner_question from terminal session is NOT evicted (FLY-161 boundary)", async () => {
		insertSession("exec-rq", { status: "completed", labels: ["product"] });
		insertQuestion({
			execId: "exec-rq",
			leadId: "product-lead",
			content: "Ask from finished session",
			// no checkpoint → runner_question
		});

		const resolveSpy = vi.spyOn(CommDB.prototype, "resolveGate");
		await runPoll(makePoller());

		// Delivered as runner_question, and resolveGate was NEVER called.
		expect(runtime.captured).toHaveLength(1);
		expect(runtime.captured[0]!.envelope.event.event_type).toBe(
			"runner_question",
		);
		expect(resolveSpy).not.toHaveBeenCalled();
		expect(pendingFor("product-lead")).toHaveLength(1); // still pending
		resolveSpy.mockRestore();
	});

	it("Case 10 (FLY-307 B): circuit opens after N consecutive failures and skips the lead", async () => {
		insertSession("exec-trap", { status: "running", labels: ["product"] });
		insertQuestion({
			execId: "exec-trap",
			leadId: "product-lead",
			content: "Trips the WASM trap",
		});

		// Simulate the sql.js poison: getSession throws on every touch.
		const getSessionSpy = vi
			.spyOn(store, "getSession")
			.mockImplementation(() => {
				// Neutral non-corruption fault: these FLY-307 circuit tests only
				// need getSession to FAIL repeatedly; the cause is irrelevant to
				// circuit counting. (Avoid a sql.js-corruption signature so the
				// FLY-639 self-heal does not rebuild the :memory: store mid-test.)
				throw new Error("simulated getSession failure (FLY-307 circuit)");
			});

		const poller = makePoller({ circuitThreshold: 3, circuitCooldownTicks: 5 });
		await runPoll(poller); // fail 1 (getSession call 1)
		await runPoll(poller); // fail 2 (call 2)
		await runPoll(poller); // fail 3 → circuit OPEN (call 3)
		expect(getSessionSpy).toHaveBeenCalledTimes(3);

		await runPoll(poller); // circuit open → lead skipped, getSession NOT called
		await runPoll(poller);
		expect(getSessionSpy).toHaveBeenCalledTimes(3);

		const warnedOpen = warnSpy.mock.calls.some((args: unknown[]) =>
			JSON.stringify(args).includes("circuit OPEN"),
		);
		expect(warnedOpen).toBe(true);
		getSessionSpy.mockRestore();
	});

	it("Case 10b (FLY-307 B): circuit resets after cooldown + a successful probe poll", async () => {
		insertSession("exec-recover", { status: "running", labels: ["product"] });
		insertQuestion({
			execId: "exec-recover",
			leadId: "product-lead",
			content: "Recoverable",
		});

		const getSessionSpy = vi
			.spyOn(store, "getSession")
			.mockImplementation(() => {
				// Neutral non-corruption fault: these FLY-307 circuit tests only
				// need getSession to FAIL repeatedly; the cause is irrelevant to
				// circuit counting. (Avoid a sql.js-corruption signature so the
				// FLY-639 self-heal does not rebuild the :memory: store mid-test.)
				throw new Error("simulated getSession failure (FLY-307 circuit)");
			});

		const poller = makePoller({ circuitThreshold: 3, circuitCooldownTicks: 2 });
		await runPoll(poller); // fail 1
		await runPoll(poller); // fail 2
		await runPoll(poller); // fail 3 → open at tick3, cooldownUntil = 3 + 2 = 5
		expect(getSessionSpy).toHaveBeenCalledTimes(3);
		await runPoll(poller); // tick4 < 5 → skipped
		expect(getSessionSpy).toHaveBeenCalledTimes(3);

		// Recover: stop throwing. tick5 → probe poll succeeds → circuit resets.
		getSessionSpy.mockRestore();
		await runPoll(poller); // tick5: probe (cooldown elapsed) → succeeds → reset
		expect(runtime.captured).toHaveLength(1); // delivered on the probe
	});

	it("Case 10c (FLY-307 B): FLYWHEEL_GATEPOLLER_CIRCUIT=0 never skips a failing lead", async () => {
		const prev = process.env.FLYWHEEL_GATEPOLLER_CIRCUIT;
		process.env.FLYWHEEL_GATEPOLLER_CIRCUIT = "0";
		try {
			insertSession("exec-nocirc", { status: "running", labels: ["product"] });
			insertQuestion({
				execId: "exec-nocirc",
				leadId: "product-lead",
				content: "Always fails",
			});
			const getSessionSpy = vi
				.spyOn(store, "getSession")
				.mockImplementation(() => {
					// Neutral non-corruption fault: these FLY-307 circuit tests only
					// need getSession to FAIL repeatedly; the cause is irrelevant to
					// circuit counting. (Avoid a sql.js-corruption signature so the
					// FLY-639 self-heal does not rebuild the :memory: store mid-test.)
					throw new Error("simulated getSession failure (FLY-307 circuit)");
				});

			const poller = makePoller({ circuitThreshold: 2 });
			await runPoll(poller);
			await runPoll(poller);
			await runPoll(poller);
			await runPoll(poller);
			// Circuit disabled → every poll still reaches getSession (never skipped).
			expect(getSessionSpy).toHaveBeenCalledTimes(4);
			getSessionSpy.mockRestore();
		} finally {
			if (prev === undefined) delete process.env.FLYWHEEL_GATEPOLLER_CIRCUIT;
			else process.env.FLYWHEEL_GATEPOLLER_CIRCUIT = prev;
		}
	});

	it("Case 10d (FLY-307 B): a relay failure skips the misroute patrol in the same tick", async () => {
		insertSession("exec-patrolskip", {
			status: "running",
			labels: ["product"],
		});
		insertQuestion({
			execId: "exec-patrolskip",
			leadId: "product-lead",
			content: "fails before patrol",
		});
		const getSessionSpy = vi
			.spyOn(store, "getSession")
			.mockImplementation(() => {
				// Neutral non-corruption fault: these FLY-307 circuit tests only
				// need getSession to FAIL repeatedly; the cause is irrelevant to
				// circuit counting. (Avoid a sql.js-corruption signature so the
				// FLY-639 self-heal does not rebuild the :memory: store mid-test.)
				throw new Error("simulated getSession failure (FLY-307 circuit)");
			});
		const readUnread = vi.fn(async () => []);
		const transport = {
			readUnread,
			ack: vi.fn(async () => {}),
		};
		const archiveDir = join(tmpHome, "misroute-archive");

		// patrolEveryNTicks=2 → patrol due on ticks 1,3,... — exactly the ticks
		// where the relay fails (and on tick 3 the circuit also opens).
		const poller = makePoller({
			circuitThreshold: 3,
			patrolEveryNTicks: 2,
			transport,
			misrouteArchiveDir: archiveDir,
		});
		await runPoll(poller); // tick1: patrolDue, relay fails → patrol skipped
		await runPoll(poller); // tick2
		await runPoll(poller); // tick3: patrolDue + circuit opens → patrol skipped

		// The failing lead's patrol must never run (it would re-touch sql.js).
		// Other leads (ops-lead, whose relay did NOT fail) still patrol normally —
		// proving the skip is scoped to the failing lead, not a global disable.
		const calls = readUnread.mock.calls.map(
			(c) => (c[0] as { leadName: string }).leadName,
		);
		expect(calls.filter((l) => l === "product-lead")).toHaveLength(0);
		expect(calls.filter((l) => l === "ops-lead").length).toBeGreaterThan(0);
		getSessionSpy.mockRestore();
	});

	it("Case 9: skips gate_question when source session resolves to a different Lead (lead-scope check)", async () => {
		// Question is addressed to product-lead, but source session's labels
		// resolve to ops-lead — label-routing wins over to_agent for gate.
		insertSession("exec-misrouted", {
			status: "running",
			labels: ["ops"], // → ops-lead via resolveLeadForIssue
		});
		insertQuestion({
			execId: "exec-misrouted",
			leadId: "product-lead",
			content: "Lead-scope mismatch",
			checkpoint: "brainstorm",
		});

		await runPoll(makePoller());

		// product-lead must NOT see this gate event.
		expect(runtime.captured).toHaveLength(0);
		const warnedScope = warnSpy.mock.calls.some((args: unknown[]) =>
			JSON.stringify(args).includes("resolves to a different Lead"),
		);
		expect(warnedScope).toBe(true);

		// Sanity: ops-lead also doesn't see it because the question's
		// to_agent is product-lead, so ops-lead's CommDB pending list is empty.
		expect(opsRuntime.captured).toHaveLength(0);
	});

	// --- FLY-639: StateStore corruption containment + self-heal ---

	it("FLY-639: a StateStore throw during poll is contained — poll resolves, circuit records a failure, and self-heal is attempted", async () => {
		insertSession("exec-639", { status: "running", labels: ["product"] });
		insertQuestion({
			execId: "exec-639",
			leadId: "product-lead",
			content: "ping",
		});

		// Simulate sql.js corruption surfacing through the per-lead StateStore touch.
		const getSessionSpy = vi
			.spyOn(store, "getSession")
			.mockImplementation(() => {
				throw new Error("no such table: sessions");
			});
		const recoverSpy = vi.spyOn(store, "recoverFromCorruption");

		const poller = makePoller({ circuitThreshold: 5 });

		// MUST NOT throw — a thrown poll() is the production Bridge crash.
		await expect(runPoll(poller)).resolves.toBeUndefined();

		// Best-effort self-heal invoked with the corruption error.
		expect(recoverSpy).toHaveBeenCalled();
		expect(recoverSpy.mock.calls[0]![0]).toBeInstanceOf(Error);
		// No event delivered on the failed poll.
		expect(runtime.captured).toHaveLength(0);

		getSessionSpy.mockRestore();
		recoverSpy.mockRestore();
	});

	it("FLY-639: a StateStore throw inside relayToLead (inner catch) is contained + self-heals (Codex code R1 HIGH)", async () => {
		insertSession("exec-639b", { status: "running", labels: ["product"] });
		insertQuestion({
			execId: "exec-639b",
			leadId: "product-lead",
			content: "ping",
		});
		// Corruption surfacing in lead_events, swallowed by relayToLead's INNER catch
		// (not the outer per-lead catch). Must still self-heal.
		const appendSpy = vi
			.spyOn(store, "appendLeadEvent")
			.mockImplementation(() => {
				throw new Error("no such table: lead_events");
			});
		const recoverSpy = vi
			.spyOn(store, "recoverFromCorruption")
			.mockReturnValue(true);

		await expect(
			runPoll(makePoller({ circuitThreshold: 5 })),
		).resolves.toBeUndefined();

		expect(recoverSpy).toHaveBeenCalled();
		expect(recoverSpy.mock.calls[0]![0]).toBeInstanceOf(Error);

		appendSpy.mockRestore();
		recoverSpy.mockRestore();
	});
});
