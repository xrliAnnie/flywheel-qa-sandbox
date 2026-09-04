import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	computeFounderArtifactDigest,
	createFounderReviewQuestionContent,
	inspectFounderReviewArtifactsAtCommit,
} from "flywheel-comm/founder-review";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";
import { commDbPathForProject } from "../commdb-path.js";
import { evaluateWorkflowFounderReviewPrecondition } from "../founder-review-authority.js";

const PROJECT = "fly2115-authority-test";
const RUN_ID = "run-fly2115";
const EXECUTION_ID = "exec-fly2115";
const FOUNDER_ID = "123456789012345678";
const REVIEW_PATH = "engineering/doc/FLY-2115/report.html";

describe("workflow founder review authority", () => {
	let root: string;
	let mainRepo: string;
	let worktree: string;
	let store: StateStore;
	let head: string;
	let snapshot: ReturnType<typeof buildWorkflowRunSnapshotV2>;
	let originalCommRoot: string | undefined;
	let originalCommDir: string | undefined;
	let originalProjects: string | undefined;

	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const removeWorktree = () =>
		execFileSync("git", [
			"-C",
			mainRepo,
			"worktree",
			"remove",
			"--force",
			worktree,
		]);
	const evaluate = (evaluationHead = head) =>
		evaluateWorkflowFounderReviewPrecondition({
			store,
			runId: RUN_ID,
			projectName: PROJECT,
			snapshot,
			head: evaluationHead,
			processEnv: { DISCORD_OWNER_USER_ID: FOUNDER_ID },
		});
	function recordReview(
		reviewHead: string,
		round: number,
		passed: boolean,
	): void {
		const artifacts = inspectFounderReviewArtifactsAtCommit({
			repoRoot: mainRepo,
			head: reviewHead,
			paths: [REVIEW_PATH],
		});
		const artifactDigest = computeFounderArtifactDigest(artifacts);
		const commDb = new CommDB(commDbPathForProject(PROJECT));
		try {
			const questionId = commDb.insertQuestion(
				EXECUTION_ID,
				"fly2115-lead",
				createFounderReviewQuestionContent({
					round,
					evidence: {
						runId: RUN_ID,
						founderId: FOUNDER_ID,
						hostedUrl: `https://example.test/fly2115/review-${round}`,
						artifacts,
					},
				}),
				{ checkpoint: "founder_review" },
			);
			store.bindFounderReviewCard({
				questionId,
				messageId: `card-fly2115-${round}`,
				runId: RUN_ID,
				artifactDigest,
				createdAt: `2026-09-03T00:0${round}:00.000Z`,
			});
			expect(
				commDb.insertFounderReviewResponseIfGateOpen({
					questionId,
					fromAgent: "bridge",
					founderId: FOUNDER_ID,
					expectedOwner: EXECUTION_ID,
					passed,
				}),
			).toBe(true);
		} finally {
			commDb.close();
		}
	}

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly2115-authority-"));
		mainRepo = join(root, "main");
		worktree = join(root, "worktree");
		const commRoot = join(root, "comm");
		originalCommRoot = process.env.FLYWHEEL_COMM_ROOT;
		originalCommDir = process.env.FLYWHEEL_COMM_DIR;
		originalProjects = process.env.FLYWHEEL_PROJECTS;
		process.env.FLYWHEEL_COMM_ROOT = commRoot;
		delete process.env.FLYWHEEL_COMM_DIR;
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: PROJECT,
				projectRoot: mainRepo,
				leads: [
					{
						agentId: "fly2115-lead",
						summaryRole: "producer",
						chatChannel: "fly2115-test",
						match: { labels: ["Engineering"] },
					},
				],
			},
		]);

		expect(commDbPathForProject(PROJECT).startsWith(`${commRoot}${sep}`)).toBe(
			true,
		);
		execFileSync("git", ["init", "-q", mainRepo]);
		git(
			mainRepo,
			"remote",
			"add",
			"origin",
			"https://example.test/fly2115.git",
		);
		mkdirSync(join(mainRepo, "agents"), { recursive: true });
		mkdirSync(join(mainRepo, "engineering", "doc", "FLY-2115"), {
			recursive: true,
		});
		writeFileSync(join(mainRepo, "agents", "produce.md"), "Produce.\n");
		writeFileSync(join(mainRepo, REVIEW_PATH), "<main>reviewed</main>\n");
		git(mainRepo, "add", ".");
		git(
			mainRepo,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"reviewed",
		);
		head = git(mainRepo, "rev-parse", "HEAD");
		execFileSync("git", ["-C", mainRepo, "worktree", "add", "-q", worktree]);

		snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "fly2115", revision: 1 },
			canonicalRoot: mainRepo,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "produce",
						type: "generic",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "low",
						agent_file: "agents/produce.md",
						founder_review: true,
					},
					{ id: "founder_gate", type: "gate" },
				],
				edges: [
					{
						id: "done",
						from: "produce",
						to: "founder_gate",
						condition: "node_done",
					},
				],
				loops: [],
				terminal_gate: {
					node: "founder_gate",
					predicate: "founder_approved",
				},
				ship_claims: ["founder_approved"],
			},
		});
		store = await StateStore.create(join(root, "state.db"));
		store.createWorkflowRun({
			runId: RUN_ID,
			issueId: "FLY-2115",
			projectName: PROJECT,
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: true,
		});
		store.upsertWorkflowRunNode({
			runId: RUN_ID,
			nodeId: "produce",
			attempt: 1,
			state: "done",
			executionId: EXECUTION_ID,
		});
		const sql = (
			store as unknown as {
				db: { run(statement: string, params?: unknown[]): void };
			}
		).db;
		sql.run(
			`INSERT INTO workflow_actor
			   (execution_id, project_name, issue_id, role, created_at)
			 VALUES (?, ?, 'FLY-2115', 'implement', '2026-09-03T00:00:00.000Z')`,
			[EXECUTION_ID, PROJECT],
		);
		sql.run(
			`INSERT INTO workflow_execution_binding
			   (activation_id, execution_id, run_id, node_id, attempt, mode, bound_at)
			 VALUES ('activation-fly2115', ?, ?, 'produce', 1, 'spawn',
			         '2026-09-03T00:00:00.000Z')`,
			[EXECUTION_ID, RUN_ID],
		);
		sql.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha,
			    target_repo_identity, probe_repo_slug, target_repo_path,
			    worktree_binding_generation, receipt_id, bound_at)
			 VALUES (?, 'produce', 1, 2115, ?, '__main__', 'example/fly2115', ?,
			         'generation-fly2115', 'receipt-fly2115',
			         '2026-09-03T00:00:00.000Z')`,
			[RUN_ID, head, realpathSync(worktree)],
		);

		mkdirSync(join(commRoot, PROJECT), { recursive: true });
		recordReview(head, 1, true);
	});

	afterEach(() => {
		store?.close();
		if (originalCommRoot === undefined) delete process.env.FLYWHEEL_COMM_ROOT;
		else process.env.FLYWHEEL_COMM_ROOT = originalCommRoot;
		if (originalCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = originalCommDir;
		if (originalProjects === undefined) delete process.env.FLYWHEEL_PROJECTS;
		else process.env.FLYWHEEL_PROJECTS = originalProjects;
		rmSync(root, { recursive: true, force: true });
	});

	it("uses the canonical repository to verify a reviewed head after its worktree is deleted", async () => {
		removeWorktree();

		await expect(evaluate()).resolves.toEqual({ eligible: true });
	});

	it("keeps using a live binding root when the project registry is unreadable", async () => {
		process.env.FLYWHEEL_PROJECTS = "{";

		await expect(evaluate()).resolves.toEqual({ eligible: true });
	});

	it("uses the canonical repository first while both roots are available", async () => {
		await expect(evaluate()).resolves.toEqual({ eligible: true });
	});

	it("does not fall back after an explicit negative verdict", async () => {
		recordReview(head, 2, false);
		removeWorktree();

		await expect(evaluate()).resolves.toEqual({
			eligible: false,
			reason: "founder_review_not_passed",
		});
	});

	it("rejects a stale reviewed artifact after the frozen head changes", async () => {
		writeFileSync(join(mainRepo, REVIEW_PATH), "<main>changed</main>\n");
		git(mainRepo, "add", REVIEW_PATH);
		git(
			mainRepo,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"changed",
		);
		const changedHead = git(mainRepo, "rev-parse", "HEAD");
		store.upsertWorkflowRunNode({
			runId: RUN_ID,
			nodeId: "produce",
			attempt: 2,
			state: "done",
		});
		(
			store as unknown as {
				db: { run(statement: string, params?: unknown[]): void };
			}
		).db.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha,
			    target_repo_identity, probe_repo_slug, target_repo_path,
			    worktree_binding_generation, receipt_id, bound_at)
			 VALUES (?, 'produce', 2, 2115, ?, '__main__', 'example/fly2115', ?,
			         'generation-fly2115-2', 'receipt-fly2115-2',
			         '2026-09-03T00:02:00.000Z')`,
			[RUN_ID, changedHead, realpathSync(worktree)],
		);
		removeWorktree();

		await expect(evaluate(changedHead)).resolves.toEqual({
			eligible: false,
			reason: "founder_review_stale_artifact",
		});
	});

	it("logs both failed roots before returning authority unavailable", async () => {
		const missingCanonical = join(root, "missing-canonical");
		process.env.FLYWHEEL_PROJECTS = JSON.stringify([
			{
				projectName: PROJECT,
				projectRoot: missingCanonical,
				leads: [
					{
						agentId: "fly2115-lead",
						summaryRole: "producer",
						chatChannel: "fly2115-test",
						match: { labels: ["Engineering"] },
					},
				],
			},
		]);
		removeWorktree();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(evaluate()).resolves.toEqual({
			eligible: false,
			reason: "founder_review_authority_unavailable",
		});
		expect(error).toHaveBeenCalledOnce();
		expect(error.mock.calls[0]?.[0]).toContain(missingCanonical);
		expect(error.mock.calls[0]?.[0]).toContain(worktree);
		expect(error.mock.calls[0]?.[0]).toContain('"errorType":"Error"');
	});

	it("keeps non-main bindings on their binding root", async () => {
		(
			store as unknown as {
				db: { run(statement: string, params?: unknown[]): void };
			}
		).db.run(
			"UPDATE workflow_node_pr_binding SET target_repo_identity = 'nested'",
		);
		process.env.FLYWHEEL_PROJECTS = "{";

		await expect(evaluate()).resolves.toEqual({ eligible: true });
	});
});
