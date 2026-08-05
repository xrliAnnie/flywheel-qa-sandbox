import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
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
	const dbPath = join(
		mkdtempSync(join(tmpdir(), "fly1572-admission-")),
		"comm.db",
	);
	const db = new CommDB(dbPath);
	const queue = new MailboxQueue(dbPath);
	resources.push(db, queue);
	queue.acquireOrRenewOwner({
		ownerEpoch: "owner-1",
		now: "2026-08-05T12:00:00.000Z",
		leaseTtlMs: 60_000,
	});
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
	});
	resources.push(admission);
	return { admission, db, queue, store };
}

function claim(queue: MailboxQueue) {
	return queue.claimLeadBatch({
		toAgent: "lead-a",
		msgClass: "model",
		ownerEpoch: "owner-1",
		batchId: "batch-1",
		now: "2026-08-05T12:00:00.000Z",
		claimTtlMs: 60_000,
	})[0]!;
}

describe("QuestionAdmission mailbox claim service", () => {
	it("materializes an eligible gate on its existing mailbox row", async () => {
		const h = harness();
		const deadline = "2026-08-06T12:00:00.000Z";
		const id = h.db.insertQuestion("exec-1", "lead-a", "need approval", {
			checkpoint: "question",
			deadlineAt: deadline,
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: true,
		});
		expect(h.queue.getById(id)).toMatchObject({
			id,
			delivery_id: `question:lead-a:${id}`,
			type: "question",
			source_kind: "question",
			source_ref: "41",
			delivery_content: "rendered:need approval",
			relay_state: "protected",
			deadline_at: deadline,
		});
		expect(h.store.appendLeadEvent).toHaveBeenCalledTimes(1);
	});

	it("returns a retry verdict for a transient pre-materialization hold", async () => {
		const h = harness(["Operations"]);
		h.db.insertQuestion("exec-1", "lead-a", "misrouted", {
			checkpoint: "question",
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: false,
			disposition: "revoked_lead_scope",
			retry: true,
		});
		expect(h.store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("terminally revokes an answered question", async () => {
		const h = harness();
		const id = h.db.insertQuestion("exec-1", "lead-a", "answer me");
		expect(h.db.insertResponse(id, "lead-a", "answered")).toMatchObject({
			written: true,
		});
		expect(await h.admission.revalidate(claim(h.queue))).toEqual({
			deliver: false,
			disposition: "revoked_answered",
		});
	});

	it("reuses one CommDB connection across revalidation calls", async () => {
		const h = harness();
		h.db.insertQuestion("exec-1", "lead-a", "question");
		const row = claim(h.queue);
		const accessor = vi.spyOn(
			h.admission as unknown as { commDb: () => CommDB },
			"commDb",
		);
		await h.admission.revalidate(row);
		await h.admission.revalidate(h.queue.getById(row.id)!);
		expect(accessor.mock.results[1]?.value).toBe(
			accessor.mock.results[0]?.value,
		);
	});
});
