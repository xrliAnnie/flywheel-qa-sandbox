import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { enqueueLeadEvent as enqueueIntoMailbox } from "../lead-event-queue.js";
import type { LeadEventEnvelope } from "../lead-runtime.js";
import { leadEventEnvelopeFromJournalRow } from "../legacy-lead-event-reconciler.js";
import { createWorkflowDecisionRouter } from "../workflow-decision-routes.js";

const T0 = "2026-07-14T00:00:00.000Z";
const T1 = "2026-07-14T01:00:00.000Z";
const T2 = "2026-07-14T02:00:00.000Z";

/**
 * FLY-2152 QA regression. An accepted verdict claim reaches the owning Lead's
 * mailbox through TWO production paths that both derive their envelope from the
 * same `lead_events` journal row, and therefore produce the same mailbox
 * delivery id:
 *
 *   1. `workflow-decision-routes.enqueueCommittedWorkflowClaim()` — the
 *      commit-time direct enqueue.
 *   2. `LeadInboxRuntime.admit()` — the per-tick redrive over
 *      `listUndeliveredLeadInboxEvents()`, which keeps returning the row for as
 *      long as `delivered_at IS NULL`.
 *
 * `enqueueLeadEvent()` folds `envelope.priority` into the mailbox identity
 * projection hash, so the two paths MUST agree on it. If they disagree, the
 * second enqueue throws `mailbox identity conflict` — and because `admit()` is
 * the first step of the Lead inbox tick, that throw aborts the whole tick. The
 * Lead then stops receiving ANY inbox traffic, `delivered_at` never advances,
 * and the redrive re-throws on every subsequent tick.
 */
function gitWorktree(): string {
	const path = mkdtempSync(join(tmpdir(), "fly2152-head-"));
	execFileSync("git", ["init", "-q", path]);
	execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
	writeFileSync(join(path, "README.md"), "head\n");
	mkdirSync(join(path, "agents"));
	execFileSync("git", ["-C", path, "add", "README.md"]);
	execFileSync("git", ["-C", path, "commit", "-qm", "head"]);
	return path;
}

describe("FLY-2152: both claim enqueue paths must agree on mailbox identity", () => {
	it("the admit() redrive can re-enqueue what the route already enqueued", async () => {
		const store = await StateStore.create(":memory:");
		const worktree = gitWorktree();
		store.upsertSession({
			execution_id: "impl-exec",
			issue_id: "FLY-2152",
			project_name: "flywheel",
			status: "awaiting_review",
			session_role: "implement",
			chat_thread_role: "implement",
			adapter_type: "codex-tmux",
			worktree_path: worktree,
		});
		store.upsertSession({
			execution_id: "qa-exec",
			issue_id: "FLY-2152",
			project_name: "flywheel",
			status: "running",
			session_role: "qa",
			chat_thread_role: "qa",
			adapter_type: "claude-tmux",
			runner_model: "opus",
			worktree_path: worktree,
		});
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-2152",
			projectName: "flywheel",
			claimsReadEnrolled: false,
		});
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "completed",
			executionId: "impl-exec",
		});
		const admission = store.admitWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: "qa-exec",
			attempt: 1,
			family: "qa_verdict",
			now: T0,
			expiresAt: T1,
			absoluteDeadlineAt: T2,
		});
		if (!admission.ok) throw new Error(admission.reason);

		const routeEnqueued: LeadEventEnvelope[] = [];
		const app = express();
		app.use(express.json());
		app.use(
			"/api/workflow",
			createWorkflowDecisionRouter({
				store,
				now: () => T0,
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved" as const,
				}),
				enqueueLeadEvent: (envelope) => {
					routeEnqueued.push(envelope);
				},
			}),
		);
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");

		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/workflow/decision`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: admission.credential,
					client_request_id: "fly2152-req-1",
					status: "fail",
					summary: "verdict must reach the Lead",
				}),
			},
		);
		expect(response.status).toBe(200);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		expect(routeEnqueued).toHaveLength(1);

		// Path 1, verbatim: the envelope the live route handed the registry.
		const queue = new MailboxQueue(
			join(mkdtempSync(join(tmpdir(), "fly2152-queue-")), "comm.db"),
		);
		const routeEnvelope = routeEnqueued[0] as LeadEventEnvelope;
		const content = "[claim] workflow_claim_recorded";
		enqueueIntoMailbox({ queue, envelope: routeEnvelope, content });

		// Path 2, verbatim: the next LeadInboxRuntime.admit() tick still sees the
		// row as undelivered and rebuilds the envelope with priority 2.
		const undelivered = store.listUndeliveredLeadInboxEvents({
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
		});
		expect(undelivered).toHaveLength(1);
		const redriveEnvelope = leadEventEnvelopeFromJournalRow(
			undelivered[0] as never,
			2,
		);
		expect(() =>
			enqueueIntoMailbox({ queue, envelope: redriveEnvelope, content }),
		).not.toThrow();
	});
});
