import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";
import { materializeWorkflowGateHolder } from "../gate-materializer.js";
import { TerminalGateRetirement } from "../terminal-gate-retirement.js";

const roots: string[] = [];
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("terminal gate retirement", () => {
	it("keeps an expired-but-answerable founder review for a terminal source", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-terminal-founder-gate-"));
		roots.push(root);
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(join(root, "state.db"));
		store.upsertSession({
			execution_id: "founder-exec",
			issue_id: "FLY-1940",
			project_name: "flywheel",
			status: "completed",
		});
		const comm = new CommDB(commPath);
		comm.registerSession(
			"founder-exec",
			"session",
			"flywheel",
			"FLY-1940",
			"flywheel-eng-lead",
			"codex",
		);
		const questionId = comm.insertQuestion(
			"founder-exec",
			"flywheel-eng-lead",
			"founder review",
			{ checkpoint: "founder_review" },
		);
		(comm as unknown as { db: import("better-sqlite3").Database }).db
			.prepare(
				"UPDATE mailbox SET expires_at = datetime('now', '-1 hour') WHERE id = ?",
			)
			.run(questionId);
		comm.close();

		await new TerminalGateRetirement({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
		}).pass();

		const result = CommDB.openReadonly(commPath);
		expect(result.getMessageById(questionId)).toMatchObject({
			relay_state: "open",
			resolved_at: null,
		});
		result.close();
		store.close();
	});

	it("keeps founder review answerable when its run is active after the producer ends", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-live-founder-gate-"));
		roots.push(root);
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(join(root, "state.db"));
		store.createWorkflowRun({
			runId: "run-live",
			issueId: "FLY-1940",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		store.upsertSession({
			execution_id: "founder-exec",
			issue_id: "FLY-1940",
			project_name: "flywheel",
			status: "blocked",
		});
		const comm = new CommDB(commPath);
		comm.registerSession(
			"founder-exec",
			"session",
			"flywheel",
			"FLY-1940",
			"flywheel-eng-lead",
			"codex",
		);
		const questionId = comm.insertQuestion(
			"founder-exec",
			"flywheel-eng-lead",
			JSON.stringify({
				version: 1,
				round: 1,
				runId: "run-live",
				artifactDigest: "a".repeat(64),
				hostedUrl: "https://example.test/review",
				paths: ["report.html"],
			}),
			{ checkpoint: "founder_review" },
		);
		comm.close();

		await new TerminalGateRetirement({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
		}).pass();

		const result = CommDB.openReadonly(commPath);
		expect(result.getMessageById(questionId)).toMatchObject({
			relay_state: "open",
			resolved_at: null,
		});
		result.close();
		store.close();
	});

	it("retires founder review from immutable run identity after source pruning", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-pruned-founder-gate-"));
		roots.push(root);
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(join(root, "state.db"));
		store.createWorkflowRun({
			runId: "run-pruned",
			issueId: "FLY-1758",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		const comm = new CommDB(commPath);
		const questionId = comm.insertQuestion(
			"pruned-exec",
			"flywheel-eng-lead",
			JSON.stringify({
				version: 1,
				round: 1,
				runId: "run-pruned",
				artifactDigest: "a".repeat(64),
				hostedUrl: "https://example.test/review",
				paths: ["report.html"],
			}),
			{ checkpoint: "founder_review" },
		);
		comm.close();

		await new TerminalGateRetirement({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
		}).retireIssueDone({
			projectName: "flywheel",
			canonicalIssueId: "FLY-1758",
			issueAliases: [],
			authorityCredential: "linear-current-state",
			revalidate: async () => "authorized",
		});

		const result = CommDB.openReadonly(commPath);
		expect(result.getMessageById(questionId)).toMatchObject({
			relay_state: "terminal_disposed",
			resolved_via: "superseded_issue_done",
		});
		result.close();
		store.close();
	});

	it("bounds and rotates terminal-session scans while reusing one project database", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-terminal-gate-cap-"));
		roots.push(root);
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(join(root, "state.db"));
		const comm = new CommDB(commPath);
		for (const executionId of ["exec-a", "exec-b"]) {
			store.upsertSession({
				execution_id: executionId,
				issue_id: "FLY-1645",
				project_name: "flywheel",
				status: "completed",
			});
			comm.registerSession(
				executionId,
				"session",
				"flywheel",
				"FLY-1645",
				"flywheel-eng-lead",
				"codex",
			);
			comm.insertQuestion(executionId, "flywheel-eng-lead", "ship?", {
				checkpoint: "approve_to_ship",
			});
		}
		comm.close();
		let opens = 0;
		const retirement = new TerminalGateRetirement({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
			maxSessionsPerPass: 1,
			openDb(path) {
				opens += 1;
				return new CommDB(path, false);
			},
		});

		await retirement.pass();
		expect(opens).toBe(1);
		let readonly = CommDB.openReadonly(commPath);
		expect(readonly.getPendingQuestions("flywheel-eng-lead")).toHaveLength(1);
		readonly.close();

		await retirement.pass();
		expect(opens).toBe(2);
		readonly = CommDB.openReadonly(commPath);
		expect(readonly.getPendingQuestions("flywheel-eng-lead")).toHaveLength(0);
		readonly.close();
		store.close();
	});

	it("contains a reopened external-authority verdict to its current session", async () => {
		const root = mkdtempSync(
			join(tmpdir(), "flywheel-terminal-gate-authority-"),
		);
		roots.push(root);
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(join(root, "state.db"));
		const comm = new CommDB(commPath);
		for (const executionId of ["exec-a", "exec-b"]) {
			store.upsertSession({
				execution_id: executionId,
				issue_id: "FLY-1645",
				project_name: "flywheel",
				status: "running",
			});
			comm.registerSession(
				executionId,
				"session",
				"flywheel",
				"FLY-1645",
				"flywheel-eng-lead",
				"codex",
			);
			comm.insertQuestion(executionId, "flywheel-eng-lead", "ship?", {
				checkpoint: "approve_to_ship",
			});
		}
		comm.close();
		const revalidate = vi
			.fn<() => Promise<"reopened" | "authorized">>()
			.mockResolvedValueOnce("reopened")
			.mockResolvedValueOnce("authorized");

		await new TerminalGateRetirement({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
		}).retireIssueDone({
			projectName: "flywheel",
			canonicalIssueId: "FLY-1645",
			issueAliases: [],
			authorityCredential: "authority",
			revalidate,
		});

		expect(revalidate).toHaveBeenCalledTimes(2);
		const readonly = CommDB.openReadonly(commPath);
		expect(
			readonly
				.getPendingQuestions("flywheel-eng-lead")
				.map((question) => question.from_agent),
		).toEqual(["exec-a"]);
		readonly.close();
		store.close();
	});

	it("keeps the authoritative engine gate answerable after its source session ends", async () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-terminal-gate-"));
		roots.push(root);
		mkdirSync(join(root, "agents"));
		writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
		const commPath = join(root, "comm.db");
		const store = await StateStore.create(join(root, "state.db"));
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl-terminal-gate", revision: 1 },
			canonicalRoot: root,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "craft",
						type: "generic",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "low",
						agent_file: "agents/generic.md",
					},
					{ id: "decision", type: "gate" },
					{ id: "publish", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "crafted",
						from: "craft",
						to: "decision",
						condition: "node_done",
					},
					{
						id: "approved",
						from: "decision",
						to: "publish",
						condition: "founder_approved",
					},
				],
				loops: [],
				approval_gate: {
					node: "decision",
					predicate: "founder_approved",
				},
				terminal_node: { node: "publish" },
				ship_claims: ["founder_approved"],
			},
		});
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1655",
			projectName: "flywheel",
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: true,
		});
		const rawStore = store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		rawStore.db.run(
			"UPDATE workflow_run SET engine_owned = 1, gate_carrier_epoch = 1, current_node_id = 'craft' WHERE run_id = 'run-1'",
		);
		rawStore.db.run(
			`INSERT INTO workflow_side_effect_ledger
			   (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state,
			    created_at, updated_at)
			 VALUES ('run-1', 'craft', 1, 'dispatch', 1, 'craft-exec',
			         'intent_recorded', '2026-08-10T04:44:00.000Z',
			         '2026-08-10T04:44:00.000Z')`,
		);
		store.upsertSession({
			execution_id: "craft-exec",
			issue_id: "FLY-1655",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "craft",
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "craft",
				executionId: "craft-exec",
				attempt: 1,
				expiresAt: "2026-08-10T05:44:00.000Z",
				absoluteDeadlineAt: "2026-08-11T04:44:00.000Z",
				now: "2026-08-10T04:44:00.000Z",
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });
		rawStore.db.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha,
			    target_repo_identity, probe_repo_slug, target_repo_path,
			    worktree_binding_generation, receipt_id, bound_at)
			 VALUES ('run-1', 'craft', 1, 82, ?, '__main__',
			         'xrliAnnie/flywheel-qa-sandbox', ?, 'generation-1',
			         'run-1:craft:1', '2026-08-10T04:48:30.000Z')`,
			["a".repeat(40), root],
		);
		expect(
			store.commitWorkflowTransitionTx({
				nodeReuseEnabled: false,
				runId: "run-1",
				nodeId: "craft",
				attempt: 1,
				executionId: "craft-exec",
				outcome: "node_done",
				subjectDigest: "a".repeat(40),
				now: "2026-08-10T04:48:34.000Z",
			}),
		).toMatchObject({ ok: true, targetNodeId: "decision", gateOpened: true });

		const holder = store.getCurrentWorkflowGateHolder("run-1", "decision");
		if (!holder) throw new Error("gate holder missing");
		const comm = new CommDB(commPath);
		comm.registerSession(
			"craft-exec",
			"session",
			"flywheel",
			"FLY-1655",
			"flywheel-eng-lead",
			"codex",
		);
		comm.close();
		expect(
			await materializeWorkflowGateHolder(
				{
					store,
					commDbPath: commPath,
					leadId: "flywheel-eng-lead",
					threadId: "thread-1",
					preflight: async () => ({ ok: true }),
					postCard: async () => ({ messageId: "card-1" }),
					now: () => "2026-08-10T04:48:36.000Z",
				},
				holder.question_id,
			),
		).toMatchObject({ ok: true, state: "awaiting_review" });
		const writableComm = new CommDB(commPath);
		const staleQuestionId = writableComm.insertQuestion(
			"craft-exec",
			"flywheel-eng-lead",
			"stale ship gate",
			{ checkpoint: "approve_to_ship" },
		);
		writableComm.close();
		store.upsertSession({
			execution_id: "craft-exec",
			issue_id: "FLY-1655",
			project_name: "flywheel",
			status: "completed",
			workflow_node_id: "craft",
		});

		expect(
			store.workflowGatePresentationDisposition({
				executionId: "craft-exec",
				checkpoint: "approve_to_ship",
				questionId: holder.question_id,
			}),
		).toEqual({ allow: true, reason: "holder_authoritative" });
		await new TerminalGateRetirement({
			store,
			projectNames: ["flywheel"],
			commDbPathForProject: () => commPath,
			now: () => Date.parse("2026-08-10T04:48:54.000Z"),
		}).pass();

		const result = CommDB.openReadonly(commPath);
		try {
			expect(result.getMessageById(holder.question_id)).toMatchObject({
				relay_state: "open",
				resolved_at: null,
			});
			expect(
				result.getPendingQuestions("flywheel-eng-lead").map((q) => q.id),
			).toEqual([holder.question_id]);
			expect(result.getMessageById(staleQuestionId)).toMatchObject({
				relay_state: "terminal_disposed",
				resolved_via: "superseded_session_terminal",
			});
		} finally {
			result.close();
			store.close();
		}
	});
});
