import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeadConfig, ProjectEntry } from "../../ProjectConfig.js";
import type { LeadRuntime } from "../lead-runtime.js";
import { QuestionAdmission } from "../question-admission.js";
import { RuntimeRegistry } from "../runtime-registry.js";

const resources: Array<{ close(): void }> = [];
afterEach(() => {
	for (const resource of resources.splice(0)) resource.close();
});

const lead: LeadConfig = {
	agentId: "lead-a",
	chatChannel: "chat-a",
	match: { labels: ["Engineering"] },
};
const projects: ProjectEntry[] = [
	{
		projectName: "project-a",
		projectRoot: "/tmp/project-a",
		leads: [
			lead,
			{
				agentId: "lead-b",
				chatChannel: "chat-b",
				match: { labels: ["Operations"] },
			},
		],
	},
];

function harness(labels = ["Engineering"]) {
	const dir = mkdtempSync(join(tmpdir(), "fly1373-admission-"));
	const dbPath = join(dir, "comm.db");
	const db = new CommDB(dbPath);
	resources.push(db);
	const queue = new LeadInboxQueue(dbPath);
	resources.push(queue);
	const session = {
		execution_id: "exec-1",
		issue_id: "issue-1",
		issue_identifier: "FLY-1",
		project_name: "project-a",
		status: "running",
		session_role: "main",
		issue_labels: JSON.stringify(labels),
	};
	const store = {
		getSession: vi.fn(() => session),
		isLeadEventDelivered: vi.fn(() => false),
		appendLeadEvent: vi.fn(() => 41),
	};
	const registry = new RuntimeRegistry();
	registry.register(lead, {
		type: "test",
		deliver: vi.fn(),
		renderEnvelope: (envelope) => `rendered:${envelope.event.summary}`,
		sendBootstrap: vi.fn(),
		health: vi.fn(),
		shutdown: vi.fn(),
	} as unknown as LeadRuntime);
	const admission = new QuestionAdmission({
		queue,
		dbPath,
		lead,
		projects,
		store: store as never,
		runtimeRegistry: registry,
		now: () => new Date("2026-07-19T12:00:00.000Z"),
	});
	return { db, queue, store, session, admission };
}

describe("QuestionAdmission", () => {
	it("materializes an eligible gate with content, deadline, and protection", async () => {
		const h = harness();
		const deadline = "2026-07-20T12:00:00.000Z";
		const qid = h.db.insertQuestion("exec-1", "lead-a", "need approval", {
			checkpoint: "question",
			deadlineAt: deadline,
		});
		expect(await h.admission.materializePending()).toBe(1);
		expect(h.queue.getById(`question:lead-a:${qid}`)).toMatchObject({
			type: "gate_question",
			priority: 1,
			content: "rendered:need approval",
			ref_message_id: qid,
			deadline_at: deadline,
			created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
		});
		expect(h.db.getMessageById(qid)).toMatchObject({
			relay_state: "protected",
			logical_event_id: "41",
		});
		expect(h.store.appendLeadEvent).toHaveBeenCalledTimes(1);
	});

	it("materializes reports at report priority and dedupes repeated scans", async () => {
		const h = harness();
		const qid = h.db.insertQuestion("exec-1", "lead-a", "DONE: shipped", {
			kind: "report",
		});
		expect(await h.admission.materializePending()).toBe(1);
		expect(await h.admission.materializePending()).toBe(1);
		expect(h.queue.getById(`question:lead-a:${qid}`)?.priority).toBe(2);
		expect(h.queue.countPending()).toBe(1);
	});

	it("rejects a gate whose source session resolves to another Lead", async () => {
		const h = harness(["Operations"]);
		h.db.insertQuestion("exec-1", "lead-a", "misrouted", {
			checkpoint: "question",
		});
		expect(await h.admission.materializePending()).toBe(0);
		expect(h.queue.countPending()).toBe(0);
	});

	it("revalidates an answered question as revoked before dispatch", async () => {
		const h = harness();
		const qid = h.db.insertQuestion("exec-1", "lead-a", "answer me");
		await h.admission.materializePending();
		expect(h.db.insertResponse(qid, "lead-a", "answered")).toMatchObject({
			written: true,
		});
		const row = h.queue.getById(`question:lead-a:${qid}`)!;
		expect(await h.admission.revalidate(row)).toEqual({
			deliver: false,
			disposition: "revoked_answered",
		});
	});
});

describe("FLY-1601 per-tick CommDB construction", () => {
	it("materializePending reuses one connection across calls (no per-tick migrations)", async () => {
		// CPU-profiled on the wedged 2026-08-02 Bridge: the #1 hotspot was the
		// CommDB constructor's migration replay, entered from materializePending
		// on EVERY tick of EVERY lead. The contract of the fix: repeated calls
		// construct at most one CommDB.
		const { admission } = harness();
		const ctor = vi.spyOn(
			admission as unknown as { commDb: () => CommDB },
			"commDb",
		);
		await admission.materializePending();
		await admission.materializePending();
		await admission.materializePending();
		expect(ctor).toHaveBeenCalledTimes(3);
		const first = ctor.mock.results[0]?.value;
		expect(ctor.mock.results[1]?.value).toBe(first);
		expect(ctor.mock.results[2]?.value).toBe(first);
		admission.close();
	});
});
