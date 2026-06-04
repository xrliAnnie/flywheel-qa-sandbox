/**
 * FLY-208 A2: black-hole inbox patrol tests.
 *
 * Production incident: Runners "reported" via stock SendMessage to
 * "team-lead" — a recipient that does not exist in Flywheel's lead-named
 * teams; the stock tool auto-creates the inbox file and returns success
 * (product-lead's black hole held 184 reports). The patrol surfaces unread
 * entries as `runner_misrouted_report` advisories.
 *
 * Key semantics under test (Codex design review R1 #1/#2/#6):
 *  - ack retry is DECOUPLED from delivery dedupe: deliver-ok + ack-throw →
 *    next patrol re-acks WITHOUT re-delivering;
 *  - backlog (> threshold) archives the FULL batch as JSONL BEFORE ack, with
 *    a content-addressed (deterministic) aggregate id;
 *  - `lead.agentId === "team-lead"` is skipped (that file is a real inbox);
 *  - no transport / archiveDir / env=0 → patrol no-op;
 *  - transport read errors never break the question-relay main duty.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	MisrouteMailboxMessage,
	MisroutePatrolTransport,
} from "../bridge/gate-poller.js";
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

class StubLeadRuntime implements LeadRuntime {
	readonly type = "stub" as const;
	readonly captured: LeadEventEnvelope[] = [];
	private nextResult: DeliveryResult = { delivered: true };

	async deliver(envelope: LeadEventEnvelope): Promise<DeliveryResult> {
		this.captured.push(envelope);
		return this.nextResult;
	}
	async sendBootstrap(): Promise<void> {}
	async health(): Promise<LeadRuntimeHealth> {
		return { status: "healthy", lastDeliveryAt: null, lastDeliveredSeq: 0 };
	}
	async shutdown(): Promise<void> {}
	queueResult(result: DeliveryResult): void {
		this.nextResult = result;
	}
}

class StubTransport implements MisroutePatrolTransport {
	/** key = `${leadName}/${agentName}` */
	readonly inboxes = new Map<string, MisrouteMailboxMessage[]>();
	readonly ackCalls: Array<{ leadName: string; messageIds: string[] }> = [];
	ackError: Error | null = null;
	readError: Error | null = null;

	seed(leadName: string, messages: MisrouteMailboxMessage[]): void {
		this.inboxes.set(`${leadName}/team-lead`, messages);
	}

	async readUnread(args: {
		leadName: string;
		agentName: string;
	}): Promise<MisrouteMailboxMessage[]> {
		if (this.readError) throw this.readError;
		return (
			this.inboxes.get(`${args.leadName}/${args.agentName}`) ?? []
		).filter((m) => !m.read);
	}

	async ack(args: {
		leadName: string;
		agentName: string;
		messageIds: string[];
	}): Promise<void> {
		if (this.ackError) throw this.ackError;
		this.ackCalls.push({
			leadName: args.leadName,
			messageIds: [...args.messageIds],
		});
		const key = `${args.leadName}/${args.agentName}`;
		const box = this.inboxes.get(key) ?? [];
		const ids = new Set(args.messageIds);
		for (const m of box) if (ids.has(m.id)) m.read = true;
	}
}

const PROJECT_NAME = "fly-208-test";

function msg(
	from: string,
	ts: number,
	content = `report from ${from}`,
): MisrouteMailboxMessage {
	return {
		id: `${from}:${new Date(ts).toISOString()}`,
		from,
		content,
		ts,
		read: false,
	};
}

describe("GatePoller misroute patrol (FLY-208 A2)", () => {
	let store: StateStore;
	let registry: RuntimeRegistry;
	let runtime: StubLeadRuntime;
	let transport: StubTransport;
	let originalHome: string | undefined;
	let originalEnv: string | undefined;
	let tmpHome: string;
	let archiveDir: string;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	const projects: ProjectEntry[] = [
		{
			projectName: PROJECT_NAME,
			projectRoot: "/tmp/fly-208-test-root",
			leads: [
				{
					agentId: "sub-lead",
					chatChannel: "chat-sub",
					match: { labels: ["sub"] },
				},
			],
		},
	];

	beforeEach(async () => {
		originalHome = process.env.HOME;
		originalEnv = process.env.FLYWHEEL_MISROUTE_PATROL;
		delete process.env.FLYWHEEL_MISROUTE_PATROL;
		tmpHome = join(tmpdir(), `misroute-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpHome, { recursive: true });
		process.env.HOME = tmpHome;
		archiveDir = join(tmpHome, "misroute-archive");

		// CommDB must exist so the question-relay loop is quiet.
		const db = new CommDB(defaultGetCommDbPath(PROJECT_NAME));
		db.close();

		store = await StateStore.create(":memory:");
		registry = new RuntimeRegistry();
		runtime = new StubLeadRuntime();
		registry.register(projects[0]!.leads[0]!, runtime);
		transport = new StubTransport();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		store.close();
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalEnv !== undefined)
			process.env.FLYWHEEL_MISROUTE_PATROL = originalEnv;
		else delete process.env.FLYWHEEL_MISROUTE_PATROL;
		rmSync(tmpHome, { recursive: true, force: true });
		warnSpy.mockRestore();
	});

	function makePoller(
		opts: {
			transport?: MisroutePatrolTransport;
			archiveDir?: string;
			backlogThreshold?: number;
			projectsOverride?: ProjectEntry[];
		} = {},
	): GatePoller {
		return new GatePoller({
			pollIntervalMs: 60_000,
			projects: opts.projectsOverride ?? projects,
			store,
			runtimeRegistry: registry,
			transport: "transport" in opts ? opts.transport : transport,
			misrouteArchiveDir: "archiveDir" in opts ? opts.archiveDir : archiveDir,
			backlogThreshold: opts.backlogThreshold,
		});
	}

	async function pollOnce(poller: GatePoller): Promise<void> {
		await (poller as unknown as { poll: () => Promise<void> }).poll();
	}

	it("surfaces an unread misrouted message as a runner_misrouted_report advisory and acks it", async () => {
		transport.seed("sub-lead", [msg("runner-433d4078", 1_780_000_000_000)]);
		const poller = makePoller();
		await pollOnce(poller);

		expect(runtime.captured).toHaveLength(1);
		const event = runtime.captured[0]!.event;
		expect(event.event_type).toBe("runner_misrouted_report");
		expect(event.misroute_from).toBe("runner-433d4078");
		expect(event.summary).toContain("report from runner-433d4078");
		expect(event.misroute_hint).toContain("flywheel-comm send");

		// Acked after successful delivery.
		expect(transport.ackCalls).toHaveLength(1);
		expect(transport.ackCalls[0]!.messageIds).toEqual([
			`runner-433d4078:${new Date(1_780_000_000_000).toISOString()}`,
		]);
	});

	it("delivery dedupe survives a new poller instance (stable eventId) without re-delivering", async () => {
		const m = msg("runner-aaaa1111", 1_780_000_100_000);
		transport.seed("sub-lead", [m]);
		await pollOnce(makePoller());
		expect(runtime.captured).toHaveLength(1);

		// Same message somehow still unread (e.g. ack raced) — new poller
		// instance, same store: no duplicate advisory.
		m.read = false;
		transport.ackCalls.length = 0;
		await pollOnce(makePoller());
		expect(runtime.captured).toHaveLength(1); // no re-delivery
		// ...but it IS re-acked (ack retry decoupled from delivery dedupe).
		expect(transport.ackCalls).toHaveLength(1);
	});

	it("deliver-ok + ack-throw → next patrol re-acks WITHOUT re-delivering (Codex R1 #1)", async () => {
		transport.seed("sub-lead", [msg("runner-bbbb2222", 1_780_000_200_000)]);
		transport.ackError = new Error("EACCES lockfile");
		const poller = makePoller();
		await pollOnce(poller);
		expect(runtime.captured).toHaveLength(1);
		expect(transport.ackCalls).toHaveLength(0); // ack failed

		transport.ackError = null;
		await pollOnce(makePoller()); // fresh instance — dedupe must come from the store
		expect(runtime.captured).toHaveLength(1); // STILL one delivery
		expect(transport.ackCalls).toHaveLength(1); // ack retried and succeeded
	});

	it("delivery failure → recordDeliveryFailure, NO ack, retried next patrol", async () => {
		transport.seed("sub-lead", [msg("runner-cccc3333", 1_780_000_300_000)]);
		runtime.queueResult({ delivered: false, error: "lead offline" });
		const poller = makePoller();
		await pollOnce(poller);
		expect(transport.ackCalls).toHaveLength(0);

		runtime.queueResult({ delivered: true });
		await pollOnce(makePoller());
		expect(transport.ackCalls).toHaveLength(1); // delivered + acked on retry
	});

	it("backlog > threshold → JSONL archive BEFORE ack + ONE aggregate advisory (Codex R1 #2/#6)", async () => {
		const batch = Array.from({ length: 12 }, (_, i) =>
			msg(
				`runner-${i.toString().padStart(8, "0")}`,
				1_780_000_000_000 + i * 1000,
			),
		);
		transport.seed("sub-lead", batch);
		const poller = makePoller(); // default threshold 10
		await pollOnce(poller);

		// ONE aggregate advisory, not 12.
		expect(runtime.captured).toHaveLength(1);
		const event = runtime.captured[0]!.event;
		expect(event.event_type).toBe("runner_misrouted_report");
		expect(event.misroute_count).toBe(12);
		expect(event.summary).toContain("12 misrouted runner report(s)");

		// Archive exists, has all 12 originals, and its path is in the event.
		const archivePath = event.misroute_archive_path!;
		expect(existsSync(archivePath)).toBe(true);
		const lines = readFileSync(archivePath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(12);
		expect(JSON.parse(lines[0]!).content).toContain("runner-00000000");

		// Deterministic aggregate id: filename derived from batch content.
		const files = readdirSync(join(archiveDir, "sub-lead"));
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^misroute_agg_[0-9a-f]{16}\.jsonl$/);

		// Whole batch acked.
		expect(transport.ackCalls).toHaveLength(1);
		expect(transport.ackCalls[0]!.messageIds).toHaveLength(12);
	});

	it("aggregate ack-throw → retry overwrites the SAME archive file (idempotent) and re-acks without re-delivering", async () => {
		const batch = Array.from({ length: 11 }, (_, i) =>
			msg(
				`runner-${i.toString().padStart(8, "0")}`,
				1_780_000_000_000 + i * 1000,
			),
		);
		transport.seed("sub-lead", batch);
		transport.ackError = new Error("lock contention");
		await pollOnce(makePoller());
		expect(runtime.captured).toHaveLength(1);

		transport.ackError = null;
		await pollOnce(makePoller());
		expect(runtime.captured).toHaveLength(1); // no duplicate aggregate advisory
		expect(transport.ackCalls).toHaveLength(1); // ack retried
		expect(readdirSync(join(archiveDir, "sub-lead"))).toHaveLength(1); // same file
	});

	it('skips a lead actually named "team-lead" (that file is a real inbox)', async () => {
		const tlProjects: ProjectEntry[] = [
			{
				projectName: PROJECT_NAME,
				projectRoot: "/tmp/fly-208-test-root",
				leads: [
					{
						agentId: "team-lead",
						chatChannel: "chat-tl",
						match: { labels: ["x"] },
					},
				],
			},
		];
		registry.register(tlProjects[0]!.leads[0]!, runtime);
		transport.seed("team-lead", [msg("runner-dddd4444", 1_780_000_400_000)]);
		await pollOnce(makePoller({ projectsOverride: tlProjects }));
		expect(runtime.captured).toHaveLength(0);
		expect(transport.ackCalls).toHaveLength(0);
	});

	it("no transport → patrol no-op (commdb/rollback mode)", async () => {
		transport.seed("sub-lead", [msg("runner-eeee5555", 1_780_000_500_000)]);
		await pollOnce(makePoller({ transport: undefined }));
		expect(runtime.captured).toHaveLength(0);
	});

	it("transport without archiveDir → patrol no-op + one warning", async () => {
		transport.seed("sub-lead", [msg("runner-ffff6666", 1_780_000_600_000)]);
		const poller = makePoller({ archiveDir: undefined });
		await pollOnce(poller);
		await pollOnce(poller);
		expect(runtime.captured).toHaveLength(0);
		const archiveWarnings = warnSpy.mock.calls.filter((c) =>
			String(c[0]).includes("misrouteArchiveDir missing"),
		);
		expect(archiveWarnings).toHaveLength(1); // warned once, not per tick
	});

	it("FLYWHEEL_MISROUTE_PATROL=0 bypasses the patrol", async () => {
		process.env.FLYWHEEL_MISROUTE_PATROL = "0";
		transport.seed("sub-lead", [msg("runner-aaaa7777", 1_780_000_700_000)]);
		await pollOnce(makePoller());
		expect(runtime.captured).toHaveLength(0);
		expect(transport.ackCalls).toHaveLength(0);
	});

	it("transport read errors are warned and do NOT break the question relay", async () => {
		transport.readError = new Error("inbox file corrupt");
		// A pending runner_question that must still be relayed.
		const db = new CommDB(defaultGetCommDbPath(PROJECT_NAME));
		db.registerSession("exec-q1", "w:1", PROJECT_NAME, "LEARN-1", "sub-lead");
		const qid = db.insertQuestion("exec-q1", "sub-lead", "still works?");
		db.close();
		store.upsertSession({
			execution_id: "exec-q1",
			issue_id: "issue-q1",
			issue_identifier: "LEARN-1",
			project_name: PROJECT_NAME,
			status: "completed",
			issue_labels: JSON.stringify(["sub"]),
		});

		await pollOnce(makePoller());

		const questionEvents = runtime.captured.filter(
			(c) => c.event.event_type === "runner_question",
		);
		expect(questionEvents).toHaveLength(1);
		expect(questionEvents[0]!.event.question_id).toBe(qid);
		const patrolWarnings = warnSpy.mock.calls.filter((c) =>
			String(c[0]).includes("misroute patrol error"),
		);
		expect(patrolWarnings.length).toBeGreaterThanOrEqual(1);
	});

	it("patrol cadence: runs on tick 1, then not again until tick N+1", async () => {
		transport.seed("sub-lead", [msg("runner-cad1", 1_780_000_800_000)]);
		const poller = makePoller();
		await pollOnce(poller); // tick 1 — patrol runs, message delivered+acked
		expect(runtime.captured).toHaveLength(1);

		// Seed a NEW message; ticks 2..20 must not patrol.
		transport.seed("sub-lead", [msg("runner-cad2", 1_780_000_900_000)]);
		for (let i = 0; i < 19; i++) await pollOnce(poller);
		expect(runtime.captured).toHaveLength(1);

		await pollOnce(poller); // tick 21 — patrol due again
		expect(runtime.captured).toHaveLength(2);
	});
});
