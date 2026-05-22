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

	function makePoller(opts?: { chatThreadsEnabled?: boolean }): GatePoller {
		return new GatePoller({
			pollIntervalMs: 60_000, // not auto-started in tests
			projects,
			store,
			runtimeRegistry: registry,
			chatThreadsEnabled: opts?.chatThreadsEnabled,
		});
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

	it("Case 8: skips gate_question when source session is completed (active-session check)", async () => {
		insertSession("exec-stale", { status: "completed", labels: ["product"] });
		insertQuestion({
			execId: "exec-stale",
			leadId: "product-lead",
			content: "Stale gate",
			checkpoint: "brainstorm",
		});

		await runPoll(makePoller());

		expect(runtime.captured).toHaveLength(0);
		const warnedStale = warnSpy.mock.calls.some((args: unknown[]) =>
			JSON.stringify(args).includes("not active"),
		);
		expect(warnedStale).toBe(true);
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
});
