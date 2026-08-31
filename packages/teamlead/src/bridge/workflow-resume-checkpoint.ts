import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withSyncOpMarker } from "flywheel-claude-runner";
import { GIT_SAFE_CONFIG } from "../lead-backends/codex/gateway/ship-preflight.js";
import type {
	WorkflowResumeAttachmentAdvanceResult,
	WorkflowResumeAttachmentInvalidationResult,
	WorkflowResumeAttachmentRetryResult,
	WorkflowResumeAttachmentRow,
	WorkflowResumeAttachmentStateRow,
} from "../StateStore.js";

const ZERO_SHA = "0".repeat(40);

function gitSubcommand(args: string[]): string {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "-c" || arg === "-C" || arg === "--git-dir") {
			index += 1;
			continue;
		}
		if (arg.startsWith("--git-dir=") || arg.startsWith("-")) continue;
		return arg;
	}
	return "git";
}
const SHA_RE = /^[0-9a-f]{40}$/;

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

export interface GitWorkflowResumeCheckpointStoreOptions {
	storeRoot: string;
	gitPath?: string;
}

export interface WorkflowResumeCheckpointStateStore {
	getWorkflowResumeAttachmentState(
		attachmentId: string,
	): WorkflowResumeAttachmentStateRow | undefined;
	advanceWorkflowResumeAttachment(input: {
		attachmentId: string;
		expectedRevision: number;
		action:
			| { kind: "ref_prepared" }
			| { kind: "store_pushed"; storeLocator: string };
		now: string;
	}): WorkflowResumeAttachmentAdvanceResult;
	recordWorkflowResumeAttachmentRetry(input: {
		attachmentId: string;
		expectedState: "intent" | "ref_prepared" | "store_pushed";
		expectedRevision: number;
		error: "anchor_pending" | "anchor_unreachable";
		now: string;
	}): WorkflowResumeAttachmentRetryResult;
	invalidateWorkflowResumeAttachment(input: {
		attachmentId: string;
		runId: string;
		nodeId: string;
		attempt: number;
		reason: "anchor_pending" | "anchor_unreachable";
		authority: {
			kind: "attachment_reconciler";
			expectedState: "intent" | "ref_prepared" | "store_pushed";
			expectedAttemptCount: number;
			expectedNextAttemptAt: string | null;
			expectedRevision: number;
		};
		now: string;
	}): WorkflowResumeAttachmentInvalidationResult;
}

export type WorkflowResumeCheckpointReconcileResult =
	| { outcome: "skipped" | "pending"; state: string }
	| { outcome: "progressed"; state: string }
	| { outcome: "retry_scheduled"; state: string; attemptCount: number }
	| { outcome: "invalidated"; reason: "anchor_pending" | "anchor_unreachable" }
	| { outcome: "raced" };

/** Drive one attachment forward; every SQLite mutation is fenced by T2 revision. */
export function reconcileWorkflowResumeCheckpoint(input: {
	stateStore: WorkflowResumeCheckpointStateStore;
	checkpointStore: GitWorkflowResumeCheckpointStore;
	attachment: WorkflowResumeAttachmentRow;
	project: string;
	projectRoot: string;
	now: string;
}): WorkflowResumeCheckpointReconcileResult {
	if (input.attachment.carrier_kind !== "git_checkpoint") {
		return { outcome: "skipped", state: "state_only_checkpoint" };
	}
	let state = input.stateStore.getWorkflowResumeAttachmentState(
		input.attachment.attachment_id,
	);
	if (!state || state.state === "ready" || state.state === "invalid") {
		return { outcome: "skipped", state: state?.state ?? "missing" };
	}
	const anchor =
		input.attachment.anchor_commit ?? state.resolved_anchor_commit ?? undefined;
	if (!anchor) return { outcome: "pending", state: state.state };

	try {
		if (state.state === "intent") {
			input.checkpointStore.prepareLocalRef({
				projectRoot: input.projectRoot,
				ref: input.attachment.anchor_ref!,
				anchor,
			});
			const advanced = input.stateStore.advanceWorkflowResumeAttachment({
				attachmentId: input.attachment.attachment_id,
				expectedRevision: state.revision,
				action: { kind: "ref_prepared" },
				now: input.now,
			});
			if (!advanced.ok) return { outcome: "raced" };
			state = input.stateStore.getWorkflowResumeAttachmentState(
				input.attachment.attachment_id,
			);
			if (!state) return { outcome: "raced" };
		}
		if (state.state === "ref_prepared") {
			const pushed = input.checkpointStore.pushToStore({
				project: input.project,
				projectRoot: input.projectRoot,
				ref: input.attachment.anchor_ref!,
				anchor,
			});
			const advanced = input.stateStore.advanceWorkflowResumeAttachment({
				attachmentId: input.attachment.attachment_id,
				expectedRevision: state.revision,
				action: { kind: "store_pushed", storeLocator: pushed.storeLocator },
				now: input.now,
			});
			if (!advanced.ok) return { outcome: "raced" };
			return { outcome: "progressed", state: advanced.state };
		}
		return { outcome: "pending", state: state.state };
	} catch (error) {
		const current = input.stateStore.getWorkflowResumeAttachmentState(
			input.attachment.attachment_id,
		);
		if (!current || current.state === "ready" || current.state === "invalid") {
			return { outcome: "raced" };
		}
		const reason =
			error instanceof Error &&
			(error.message === "checkpoint_anchor_missing" ||
				error.message === "anchor_unreachable")
				? "anchor_unreachable"
				: "anchor_pending";
		const retry = input.stateStore.recordWorkflowResumeAttachmentRetry({
			attachmentId: input.attachment.attachment_id,
			expectedState: current.state,
			expectedRevision: current.revision,
			error: reason,
			now: input.now,
		});
		if (!retry.ok) return { outcome: "raced" };
		if (retry.attemptCount < 5) {
			return {
				outcome: "retry_scheduled",
				state: current.state,
				attemptCount: retry.attemptCount,
			};
		}
		const invalidated = input.stateStore.invalidateWorkflowResumeAttachment({
			attachmentId: input.attachment.attachment_id,
			runId: input.attachment.run_id,
			nodeId: input.attachment.target_node_id,
			attempt: input.attachment.target_attempt,
			reason,
			authority: {
				kind: "attachment_reconciler",
				expectedState: current.state,
				expectedAttemptCount: retry.attemptCount,
				expectedNextAttemptAt: retry.nextAttemptAt,
				expectedRevision: retry.revision,
			},
			now: input.now,
		});
		return invalidated.ok
			? { outcome: "invalidated", reason }
			: { outcome: "raced" };
	}
}

/** Durable, create-only Git carrier for workflow resume anchors. */
export class GitWorkflowResumeCheckpointStore {
	private readonly storeRoot: string;
	private readonly gitPath: string;

	constructor(options: GitWorkflowResumeCheckpointStoreOptions) {
		this.storeRoot = options.storeRoot;
		this.gitPath = options.gitPath ?? "/usr/bin/git";
	}

	prepareLocalRef(input: {
		projectRoot: string;
		ref: string;
		anchor: string;
	}): { adopted: boolean } {
		const anchor = this.validate(input);
		this.runOrThrow(
			["cat-file", "-e", `${anchor}^{commit}`],
			input.projectRoot,
			"checkpoint_anchor_missing",
		);
		const update = this.run(
			["update-ref", input.ref, anchor, ZERO_SHA],
			input.projectRoot,
		);
		if (update.status === 0) return { adopted: false };
		if (this.readRef(input.projectRoot, input.ref) === anchor) {
			return { adopted: true };
		}
		throw new Error("checkpoint_ref_conflict");
	}

	pushToStore(input: {
		project: string;
		projectRoot: string;
		ref: string;
		anchor: string;
	}): { adopted: boolean; storePath: string; storeLocator: string } {
		const anchor = this.validate(input);
		if (!input.project.trim()) throw new Error("checkpoint_project_invalid");
		const storePath = join(
			this.storeRoot,
			`${encodeURIComponent(input.project)}.git`,
		);
		mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 });
		chmodSync(this.storeRoot, 0o700);
		if (!existsSync(storePath)) {
			this.runOrThrow(
				["init", "--quiet", "--bare", storePath],
				this.storeRoot,
				"checkpoint_store_init_failed",
			);
		}
		chmodSync(storePath, 0o700);
		const existing = this.readBareRef(storePath, input.ref);
		if (existing) {
			if (existing !== anchor) {
				throw new Error("checkpoint_store_ref_conflict");
			}
			return {
				adopted: true,
				storePath,
				storeLocator: JSON.stringify({
					path: storePath,
					ref: input.ref,
					generation: 1,
				}),
			};
		}
		const push = this.run(
			[
				"push",
				"--porcelain",
				`--force-with-lease=${input.ref}:${ZERO_SHA}`,
				storePath,
				`${anchor}:${input.ref}`,
			],
			input.projectRoot,
		);
		let adopted = false;
		if (push.status !== 0) {
			const winner = this.readBareRef(storePath, input.ref);
			if (winner !== anchor) {
				throw new Error(
					winner
						? "checkpoint_store_ref_conflict"
						: "checkpoint_store_push_failed",
				);
			}
			adopted = true;
		}
		if (this.readBareRef(storePath, input.ref) !== anchor) {
			throw new Error("checkpoint_store_confirmation_failed");
		}
		return {
			adopted,
			storePath,
			storeLocator: JSON.stringify({
				path: storePath,
				ref: input.ref,
				generation: 1,
			}),
		};
	}

	recover(input: {
		project: string;
		projectRoot: string;
		ref: string;
		anchor: string;
	}): { adopted: boolean } {
		const anchor = this.validate(input);
		const local = this.readRef(input.projectRoot, input.ref);
		if (local) {
			if (local !== anchor) throw new Error("checkpoint_ref_conflict");
			if (
				this.run(["cat-file", "-e", `${anchor}^{commit}`], input.projectRoot)
					.status === 0
			) {
				return { adopted: false };
			}
		}

		const storePath = join(
			this.storeRoot,
			`${encodeURIComponent(input.project)}.git`,
		);
		if (!existsSync(storePath)) throw new Error("anchor_unreachable");
		const stored = this.readBareRef(storePath, input.ref);
		if (!stored) throw new Error("anchor_unreachable");
		if (stored !== anchor) throw new Error("checkpoint_store_ref_conflict");
		this.runOrThrow(
			["fetch", "--quiet", "--no-tags", storePath, input.ref],
			input.projectRoot,
			"anchor_unreachable",
		);
		if (this.readRef(input.projectRoot, "FETCH_HEAD") !== anchor) {
			throw new Error("anchor_unreachable");
		}
		const update = this.run(
			["update-ref", input.ref, anchor, ZERO_SHA],
			input.projectRoot,
		);
		if (
			update.status !== 0 &&
			this.readRef(input.projectRoot, input.ref) !== anchor
		) {
			throw new Error("checkpoint_ref_conflict");
		}
		return { adopted: true };
	}

	pruneRef(input: {
		project: string;
		projectRoot: string;
		ref: string;
		anchor: string;
	}): { localDeleted: boolean; storeDeleted: boolean } {
		const anchor = this.validate(input);
		if (!input.project.trim()) throw new Error("checkpoint_project_invalid");
		const local = this.readRef(input.projectRoot, input.ref);
		if (local && local !== anchor) throw new Error("checkpoint_ref_conflict");
		if (local) {
			this.runOrThrow(
				["update-ref", "-d", input.ref, anchor],
				input.projectRoot,
				"checkpoint_ref_prune_failed",
			);
		}
		const storePath = join(
			this.storeRoot,
			`${encodeURIComponent(input.project)}.git`,
		);
		const stored = existsSync(storePath)
			? this.readBareRef(storePath, input.ref)
			: undefined;
		if (stored && stored !== anchor) {
			throw new Error("checkpoint_store_ref_conflict");
		}
		if (stored) {
			this.runOrThrow(
				["--git-dir", storePath, "update-ref", "-d", input.ref, anchor],
				this.storeRoot,
				"checkpoint_store_ref_prune_failed",
			);
		}
		return { localDeleted: !!local, storeDeleted: !!stored };
	}

	private validate(input: {
		projectRoot: string;
		ref: string;
		anchor: string;
	}): string {
		const anchor = input.anchor.toLowerCase();
		if (!SHA_RE.test(anchor)) throw new Error("checkpoint_anchor_invalid");
		if (
			!input.ref.startsWith("refs/flywheel/checkpoints/") ||
			this.run(["check-ref-format", input.ref], input.projectRoot).status !== 0
		) {
			throw new Error("checkpoint_ref_invalid");
		}
		return anchor;
	}

	private readRef(projectRoot: string, ref: string): string | undefined {
		const result = this.run(["rev-parse", "--verify", ref], projectRoot);
		const value = result.stdout.trim().toLowerCase();
		return result.status === 0 && SHA_RE.test(value) ? value : undefined;
	}

	private readBareRef(storePath: string, ref: string): string | undefined {
		const result = this.run(
			["--git-dir", storePath, "rev-parse", "--verify", ref],
			this.storeRoot,
		);
		const value = result.stdout.trim().toLowerCase();
		return result.status === 0 && SHA_RE.test(value) ? value : undefined;
	}

	private run(args: string[], cwd: string): GitResult {
		const label = gitSubcommand(args);
		const result = withSyncOpMarker(`workflow-resume-checkpoint:${label}`, () =>
			spawnSync(this.gitPath, [...GIT_SAFE_CONFIG, ...args], {
				cwd,
				encoding: "utf8",
				timeout: 10_000,
				env: {
					PATH: "/usr/bin:/bin",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_SYSTEM: "/dev/null",
					GIT_TERMINAL_PROMPT: "0",
				},
			}),
		);
		return {
			status: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	}

	private runOrThrow(args: string[], cwd: string, message: string): GitResult {
		const result = this.run(args, cwd);
		if (result.status !== 0) throw new Error(message);
		return result;
	}
}
