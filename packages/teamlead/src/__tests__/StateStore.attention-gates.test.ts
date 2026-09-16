import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { readFounderAttentionFacts } from "../bridge/founder-attention-facts.js";
import { readAttentionSources } from "../epic-page/attention-sources.js";
import type { StateStore } from "../StateStore.js";
import {
	buildWorkflowRunSnapshotV1,
	buildWorkflowRunSnapshotV2,
	parseWorkflowRunSnapshot,
	resolveWorkflowGateAuthority,
} from "../workflow-run-snapshot.js";
import {
	createAttentionGateStore,
	landSnapshot,
} from "./fixtures/attention-gate-store.js";
import { legacyEngineeringManifest } from "./fixtures/legacy-workflow-manifests.js";

const roots: string[] = [];
const stores: StateStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function db(s: StateStore) {
	return (s as unknown as { db: { raw: Database.Database } }).db.raw;
}
async function fixture() {
	const s = await createAttentionGateStore();
	stores.push(s);
	return s;
}

describe("StateStore attention gate facts", () => {
	it("excludes an intermediate code_review holder through real authority facts and the page", async () => {
		const s = await fixture();
		// Keep the pinned approval node founder_gate; only the current holder is intermediate.
		db(s).exec(
			"UPDATE workflow_run SET current_node_id='code_review'; UPDATE workflow_run_node SET node_id='code_review'; UPDATE workflow_gate_holder SET gate_node_id='code_review'",
		);
		expect(s.listAttentionGateFacts("flywheel")).toMatchObject({
			rawCount: 1,
			facts: [],
		});
		const now = new Date("2026-09-01T11:00:00Z");
		const empty = {
			items: [],
			rawCount: 0,
			missing: null,
			fetchedAt: now.toISOString(),
		};
		const page = await readAttentionSources(
			{
				stateStore: s,
				openCommReadonly: () => ({
					listAttentionQuestions: () => ({
						questions: [],
						rawCount: 0,
						nextCursor: null,
					}),
					isQuestionPending: () => true,
					close: () => {},
				}),
				fetchFounderReview: async () => empty,
				fetchIssueMetadata: async () => empty,
			},
			{
				projectName: "flywheel",
				binding: { team: "FLY" },
				apiKey: "test",
				channelIds: [],
				now,
			},
		);
		expect(page.reads.gates.value).toEqual({ count: 0 });
		expect(page.candidates).toEqual([]);
	});

	it("projects a snapshot-defined approval node through the shared attention reader", async () => {
		const s = await fixture();
		const customSnapshot = JSON.stringify(
			buildWorkflowRunSnapshotV1({
				template: { id: "custom-approval", revision: 1 },
				manifest: JSON.parse(
					landSnapshot().replaceAll("founder_gate", "custom_approval"),
				).manifest,
			}),
		);
		db(s)
			.prepare("UPDATE workflow_run SET snapshot=?,current_node_id=?")
			.run(customSnapshot, "custom_approval");
		db(s)
			.prepare("UPDATE workflow_run_node SET node_id=?")
			.run("custom_approval");
		db(s)
			.prepare("UPDATE workflow_gate_holder SET gate_node_id=?")
			.run("custom_approval");
		expect(s.listAttentionGateFacts("flywheel").facts).toMatchObject([
			{ node_id: "custom_approval", kind: "ship" },
		]);
		const facts = readFounderAttentionFacts(
			{
				stateStore: s,
				openCommReadonly: () => ({
					listAttentionQuestions: () => ({
						questions: [],
						rawCount: 0,
						nextCursor: null,
					}),
					isQuestionPending: () => true,
					close: () => {},
				}),
			},
			{ projectName: "flywheel", now: new Date("2026-09-01T11:00:00Z") },
		);
		expect(facts.available).toBe(true);
		expect(facts.reads.gates.value).toEqual({ count: 1 });
		expect(facts.pending).toMatchObject([
			{
				key: "holder:full-question-123456789",
				issue: "issue",
				source: { fact: { value: { kind: "ship" } } },
			},
		]);
	});
	it("reads a current pinned authority without requiring a live source session and normalizes UTC", async () => {
		const s = await fixture();
		expect(s.listAttentionGateFacts("flywheel")).toMatchObject({
			truncated: false,
			rawCount: 1,
			facts: [
				{
					question_id: "full-question-123456789",
					execution_id: "ended-execution",
					run_id: "run",
					node_id: "founder_gate",
					attempt: 1,
					issue_id: "issue",
					kind: "ship",
					authority_mode: "land",
					since: "2026-09-01T10:00:00Z",
				},
			],
		});
		expect(s.listAttentionGateFacts("other").facts).toEqual([]);
	});
	it.each([
		"UPDATE workflow_run SET status='completed'",
		"UPDATE workflow_run SET current_node_id='qa'",
		"UPDATE workflow_run SET snapshot='{}'",
		"UPDATE workflow_run SET engine_owned=0",
		"UPDATE workflow_run_node SET ended_at='2026-09-02'",
		"UPDATE workflow_run_node SET state='done'",
		"UPDATE workflow_run_node SET attempt=2",
		"UPDATE workflow_gate_holder SET state='approved'",
		"UPDATE workflow_gate_holder SET state='materializing'",
		"UPDATE workflow_gate_holder SET state='superseded'",
		"UPDATE workflow_gate_holder SET card_void_state='pending'",
	])("excludes stale/unauthorized candidate: %s", async (sql) => {
		const s = await fixture();
		db(s).exec(sql);
		expect(s.listAttentionGateFacts("flywheel").facts).toEqual([]);
	});
	it("a newer holder suppresses the old head", async () => {
		const s = await fixture();
		db(s).exec("UPDATE workflow_gate_holder SET state='superseded'");
		db(s)
			.prepare(
				"INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,state,created_at,updated_at) VALUES('run','founder_gate',1,?,'other-exec','new-question','materializing','2026-09-02','2026-09-02')",
			)
			.run("b".repeat(40));
		expect(s.listAttentionGateFacts("flywheel").facts).toEqual([]);
	});
	it("classifies bound stale mailbox gates as excluded and never resurrects legacy", async () => {
		const s = await fixture();
		expect(s.classifyAttentionMailboxGate("flywheel", "never-bound")).toBe(
			"legacy",
		);
		expect(
			s.classifyAttentionMailboxGate("flywheel", "full-question-123456789"),
		).toBe("current");
		db(s).exec("UPDATE workflow_gate_holder SET state='superseded'");
		expect(
			s.classifyAttentionMailboxGate("flywheel", "full-question-123456789"),
		).toBe("excluded");
		expect(
			s.classifyAttentionMailboxGate("other", "full-question-123456789"),
		).toBe("excluded");
	});

	it("counts raw candidates before authority filtering and reports cap+1", async () => {
		const s = await fixture();
		s.createWorkflowRun({
			runId: "run2",
			issueId: "second",
			projectName: "flywheel",
			snapshotJson: landSnapshot(),
			claimsReadEnrolled: true,
		});
		db(s).exec(
			"UPDATE workflow_run SET engine_owned=1,current_node_id='founder_gate'; UPDATE workflow_run SET snapshot='{}' WHERE run_id='run'",
		);
		s.upsertWorkflowRunNode({
			runId: "run2",
			nodeId: "founder_gate",
			attempt: 1,
			state: "review",
			executionId: "exec2",
		});
		db(s)
			.prepare(
				"INSERT INTO workflow_gate_holder(run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,state,created_at,updated_at) VALUES('run2','founder_gate',1,?,'exec2','q2','awaiting_review','2026-09-02','2026-09-02')",
			)
			.run("b".repeat(40));
		expect(s.listAttentionGateFacts("flywheel", { limit: 1 })).toEqual({
			facts: [],
			truncated: true,
			rawCount: 2,
		});
		expect(s.classifyAttentionMailboxGate("flywheel", "q2")).toBe("current");
	});
	it.each(["runner_ship", "engine_terminal"] as const)(
		"derives %s using the pinned authority resolver",
		async (mode) => {
			const s = await fixture();
			const manifest = legacyEngineeringManifest();
			const root = mkdtempSync(join(tmpdir(), "attention-mode-"));
			roots.push(root);
			writeFileSync(join(root, "agent.md"), "Bounded design task.");
			mkdirSync(join(root, ".flywheel", "menus"), { recursive: true });
			writeFileSync(
				join(root, ".flywheel", "config.yaml"),
				"project: fixture\n",
			);
			writeFileSync(
				join(root, ".flywheel", "menus", "ic-roster.yaml"),
				"design: agent.md\n",
			);

			const snapshot =
				mode === "engine_terminal"
					? buildWorkflowRunSnapshotV2({
							template: { id: "attention-mode", revision: 1 },
							canonicalRoot: root,
							manifest: {
								schema_version: 2,
								nodes: [
									{
										id: "produce",
										type: "design",
										role: "design",
										vendor: "codex",
										model: "gpt-5.6-sol",
										effort: "high",
									},
									{ id: "founder_gate", type: "gate" },
								],
								edges: [
									{
										id: "done",
										from: "produce",
										to: "founder_gate",
										condition: "design_done",
									},
								],
								loops: [],
								terminal_gate: {
									node: "founder_gate",
									predicate: "founder_approved",
								},
								ship_claims: ["founder_approved"],
							},
						})
					: buildWorkflowRunSnapshotV1({
							template: { id: "attention-mode", revision: 1 },
							manifest,
						});
			expect(
				resolveWorkflowGateAuthority(
					parseWorkflowRunSnapshot(JSON.stringify(snapshot)),
				).mode,
			).toBe(mode);
			db(s)
				.prepare("UPDATE workflow_run SET snapshot=?")
				.run(JSON.stringify(snapshot));
			db(s)
				.prepare(
					"UPDATE workflow_gate_holder SET authority_mode=?,subject_kind=?,carrier_binding_state='bound'",
				)
				.run(mode, mode === "engine_terminal" ? "snapshot_digest" : "git_head");
			expect(s.listAttentionGateFacts("flywheel").facts).toMatchObject([
				{
					authority_mode: mode,
					kind: mode === "engine_terminal" ? "founder_gate" : "ship",
				},
			]);
			if (mode === "runner_ship") {
				db(s).exec(
					"UPDATE workflow_gate_holder SET carrier_binding_state='unbound'",
				);
				expect(s.listAttentionGateFacts("flywheel").facts).toEqual([]);
			}
		},
	);
});
