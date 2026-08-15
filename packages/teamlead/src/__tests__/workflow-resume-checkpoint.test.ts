import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	GitWorkflowResumeCheckpointStore,
	reconcileWorkflowResumeCheckpoint,
	type WorkflowResumeCheckpointStateStore,
} from "../bridge/workflow-resume-checkpoint.js";
import type {
	WorkflowResumeAttachmentRow,
	WorkflowResumeAttachmentStateRow,
} from "../StateStore.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync("/usr/bin/git", ["-C", cwd, ...args], {
		encoding: "utf8",
	}).trim();
}

function makeRepo(): { root: string; first: string; second: string } {
	const root = mkdtempSync(join(tmpdir(), "flywheel-checkpoint-repo-"));
	roots.push(root);
	git(root, "init", "--quiet");
	git(root, "config", "user.name", "Flywheel Test");
	git(root, "config", "user.email", "test@flywheel.local");
	writeFileSync(join(root, "tracked"), "one");
	git(root, "add", "tracked");
	git(root, "commit", "--quiet", "-m", "one");
	const first = git(root, "rev-parse", "HEAD");
	writeFileSync(join(root, "tracked"), "onetwo");
	git(root, "add", "tracked");
	git(root, "commit", "--quiet", "-m", "two");
	return { root, first, second: git(root, "rev-parse", "HEAD") };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("GitWorkflowResumeCheckpointStore", () => {
	it("creates a local checkpoint ref once and adopts an identical replay", () => {
		const repo = makeRepo();
		const storeRoot = mkdtempSync(join(tmpdir(), "flywheel-checkpoint-store-"));
		roots.push(storeRoot);
		const checkpoints = new GitWorkflowResumeCheckpointStore({ storeRoot });
		const ref = "refs/flywheel/checkpoints/run-1/attachment-1";

		expect(
			checkpoints.prepareLocalRef({
				projectRoot: repo.root,
				ref,
				anchor: repo.first,
			}),
		).toEqual({ adopted: false });
		expect(
			checkpoints.prepareLocalRef({
				projectRoot: repo.root,
				ref,
				anchor: repo.first,
			}),
		).toEqual({ adopted: true });
		expect(git(repo.root, "rev-parse", ref)).toBe(repo.first);
		expect(() =>
			checkpoints.prepareLocalRef({
				projectRoot: repo.root,
				ref,
				anchor: repo.second,
			}),
		).toThrow("checkpoint_ref_conflict");
	});

	it("pushes create-only into a private bare store and rejects a different winner", () => {
		const repo = makeRepo();
		const rival = makeRepo();
		const storeRoot = mkdtempSync(join(tmpdir(), "flywheel-checkpoint-store-"));
		roots.push(storeRoot);
		const checkpoints = new GitWorkflowResumeCheckpointStore({ storeRoot });
		const ref = "refs/flywheel/checkpoints/run-1/attachment-1";
		checkpoints.prepareLocalRef({
			projectRoot: repo.root,
			ref,
			anchor: repo.first,
		});

		const first = checkpoints.pushToStore({
			project: "flywheel",
			projectRoot: repo.root,
			ref,
			anchor: repo.first,
		});
		expect(first.adopted).toBe(false);
		expect(JSON.parse(first.storeLocator)).toMatchObject({
			ref,
			generation: 1,
		});
		expect(statSync(first.storePath).mode & 0o777).toBe(0o700);
		expect(
			checkpoints.pushToStore({
				project: "flywheel",
				projectRoot: repo.root,
				ref,
				anchor: repo.first,
			}).adopted,
		).toBe(true);

		git(rival.root, "update-ref", ref, rival.second);
		expect(() =>
			checkpoints.pushToStore({
				project: "flywheel",
				projectRoot: rival.root,
				ref,
				anchor: rival.second,
			}),
		).toThrow("checkpoint_store_ref_conflict");
	});

	it("restores a missing local ref from the store after the source repository is gone", () => {
		const source = makeRepo();
		const storeRoot = mkdtempSync(join(tmpdir(), "flywheel-checkpoint-store-"));
		roots.push(storeRoot);
		const checkpoints = new GitWorkflowResumeCheckpointStore({ storeRoot });
		const ref = "refs/flywheel/checkpoints/run-1/attachment-1";
		checkpoints.prepareLocalRef({
			projectRoot: source.root,
			ref,
			anchor: source.first,
		});
		checkpoints.pushToStore({
			project: "flywheel",
			projectRoot: source.root,
			ref,
			anchor: source.first,
		});
		rmSync(source.root, { recursive: true, force: true });

		const replacement = mkdtempSync(
			join(tmpdir(), "flywheel-checkpoint-replacement-"),
		);
		roots.push(replacement);
		git(replacement, "init", "--quiet");
		expect(
			checkpoints.recover({
				project: "flywheel",
				projectRoot: replacement,
				ref,
				anchor: source.first,
			}),
		).toEqual({ adopted: true });
		expect(git(replacement, "rev-parse", ref)).toBe(source.first);
	});

	it("reports anchor_unreachable only when neither local nor store carrier has the commit", () => {
		const repo = makeRepo();
		const storeRoot = mkdtempSync(join(tmpdir(), "flywheel-checkpoint-store-"));
		roots.push(storeRoot);
		const checkpoints = new GitWorkflowResumeCheckpointStore({ storeRoot });

		expect(() =>
			checkpoints.recover({
				project: "flywheel",
				projectRoot: repo.root,
				ref: "refs/flywheel/checkpoints/run-1/missing",
				anchor: repo.first,
			}),
		).toThrow("anchor_unreachable");
	});

	it("prunes local and store refs with an expected-old CAS", () => {
		const repo = makeRepo();
		const storeRoot = mkdtempSync(join(tmpdir(), "flywheel-checkpoint-store-"));
		roots.push(storeRoot);
		const checkpoints = new GitWorkflowResumeCheckpointStore({ storeRoot });
		const ref = "refs/flywheel/checkpoints/run-1/attachment-1";
		checkpoints.prepareLocalRef({
			projectRoot: repo.root,
			ref,
			anchor: repo.first,
		});
		checkpoints.pushToStore({
			project: "flywheel",
			projectRoot: repo.root,
			ref,
			anchor: repo.first,
		});

		expect(
			checkpoints.pruneRef({
				project: "flywheel",
				projectRoot: repo.root,
				ref,
				anchor: repo.first,
			}),
		).toEqual({ localDeleted: true, storeDeleted: true });
		expect(() =>
			git(repo.root, "show-ref", "--verify", "--quiet", ref),
		).toThrow();
		expect(
			checkpoints.pruneRef({
				project: "flywheel",
				projectRoot: repo.root,
				ref,
				anchor: repo.first,
			}),
		).toEqual({ localDeleted: false, storeDeleted: false });
	});

	it("reconciles intent through both create-only carriers with revision-fenced stamps", () => {
		const repo = makeRepo();
		const storeRoot = mkdtempSync(join(tmpdir(), "flywheel-checkpoint-store-"));
		roots.push(storeRoot);
		const checkpoints = new GitWorkflowResumeCheckpointStore({ storeRoot });
		const ref = "refs/flywheel/checkpoints/run-1/attachment-1";
		const attachment: WorkflowResumeAttachmentRow = {
			attachment_id: "attachment-1",
			run_id: "run-1",
			target_node_id: "implement",
			target_attempt: 1,
			transition_uid: "edge-1",
			receipt_kind: "edge_traversed",
			receipt_digest: "receipt",
			carrier_kind: "git_checkpoint",
			anchor_ref: ref,
			anchor_commit: repo.first,
			repo_identity: "flywheel",
			snapshot_digest: "snapshot",
			resolved_node_digest: "node",
			runtime_semantics_digest: null,
			rework_authority_digest: "none",
			envelope_json: "{}",
			created_at: "2026-08-15T00:00:00.000Z",
		};
		let state: WorkflowResumeAttachmentStateRow = {
			attachment_id: attachment.attachment_id,
			state: "intent",
			resolved_anchor_commit: null,
			store_locator: null,
			envelope_stamped_json: null,
			runtime_semantics_stamped: null,
			invalid_reason: null,
			attempt_count: 0,
			next_attempt_at: null,
			revision: 0,
			updated_at: attachment.created_at,
		};
		const stateStore: WorkflowResumeCheckpointStateStore = {
			getWorkflowResumeAttachmentState: () => ({ ...state }),
			advanceWorkflowResumeAttachment: (input) => {
				state = {
					...state,
					state:
						input.action.kind === "ref_prepared"
							? "ref_prepared"
							: "store_pushed",
					store_locator:
						input.action.kind === "store_pushed"
							? input.action.storeLocator
							: state.store_locator,
					revision: state.revision + 1,
				};
				return { ok: true, state: state.state, revision: state.revision };
			},
			recordWorkflowResumeAttachmentRetry: () => {
				throw new Error("unexpected retry");
			},
			invalidateWorkflowResumeAttachment: () => {
				throw new Error("unexpected invalidation");
			},
		};

		expect(
			reconcileWorkflowResumeCheckpoint({
				stateStore,
				checkpointStore: checkpoints,
				attachment,
				project: "flywheel",
				projectRoot: repo.root,
				now: "2026-08-15T00:01:00.000Z",
			}),
		).toEqual({ outcome: "progressed", state: "store_pushed" });
		expect(state).toMatchObject({ state: "store_pushed", revision: 2 });
	});
});
