import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { CommDB } from "flywheel-comm/db";
import type {
	DesignReviewManifest,
	Session,
	StateStore,
} from "../StateStore.js";
import { buildCodexInstruction } from "./codex-instruction.js";
import { commDbPathForProject } from "./commdb-path.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const DIRTY_PLAN_MESSAGE =
	"commit plan current contents and re-run review (staged, unstaged, and untracked plan changes are rejected)";

export type DesignPlanSnapshot =
	| { ok: true; blobSha: string }
	| {
			ok: false;
			reason: "missing" | "dirty" | "invalid_path" | "git_error";
			message: string;
	  };

function safeRelativePath(path: string): boolean {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!/[\0\r\n\t]/.test(path) &&
		!isAbsolute(path) &&
		!path.split(/[\\/]/).some((segment) => segment === "..")
	);
}

function git(worktree: string, args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
		{
			cwd: worktree,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trim();
}

/** Resolve the exact committed blob and reject every dirty-plan shape. */
export function snapshotDesignReviewPlan(
	session: Pick<Session, "worktree_path" | "branch">,
	planPath: string,
): DesignPlanSnapshot {
	if (!safeRelativePath(planPath)) {
		return {
			ok: false,
			reason: "invalid_path",
			message: "plan path must be a safe repository-relative path",
		};
	}
	const worktree = session.worktree_path;
	if (!worktree) {
		return {
			ok: false,
			reason: "missing",
			message: "session has no persisted worktree for the design plan",
		};
	}
	const absolutePlan = resolve(worktree, planPath);
	if (
		absolutePlan !== resolve(worktree) &&
		!absolutePlan.startsWith(`${resolve(worktree)}/`)
	) {
		return {
			ok: false,
			reason: "invalid_path",
			message: "plan path escapes the persisted worktree",
		};
	}

	try {
		if (!existsSync(absolutePlan)) {
			return {
				ok: false,
				reason: "missing",
				message: `plan does not exist at ${planPath}`,
			};
		}
		const planStat = lstatSync(absolutePlan);
		if (!planStat.isFile() || planStat.isSymbolicLink()) {
			return {
				ok: false,
				reason: "invalid_path",
				message: "plan path must resolve to a regular file in the worktree",
			};
		}
		const branch = session.branch?.trim();
		const ref = branch
			? branch.startsWith("refs/heads/")
				? branch
				: `refs/heads/${branch}`
			: "HEAD";
		const headCommit = git(worktree, [
			"rev-parse",
			"--verify",
			"HEAD^{commit}",
		]).toLowerCase();
		const refCommit = git(worktree, [
			"rev-parse",
			"--verify",
			`${ref}^{commit}`,
		]).toLowerCase();
		if (headCommit !== refCommit) {
			return { ok: false, reason: "dirty", message: DIRTY_PLAN_MESSAGE };
		}

		let blobSha: string;
		try {
			blobSha = git(worktree, [
				"rev-parse",
				"--verify",
				`${ref}:${planPath}`,
			]).toLowerCase();
		} catch {
			// An on-disk file absent from the authoritative tree is untracked.
			return { ok: false, reason: "dirty", message: DIRTY_PLAN_MESSAGE };
		}
		if (!FULL_SHA_RE.test(blobSha)) {
			return {
				ok: false,
				reason: "git_error",
				message: `git returned an invalid blob id for ${planPath}`,
			};
		}

		// Compare the authoritative tree, index, and raw worktree bytes without
		// porcelain. In particular, --no-filters prevents a runner-controlled
		// filter.clean command from executing while the Bridge validates the plan.
		const treeEntry = git(worktree, ["ls-tree", ref, "--", planPath]);
		const indexEntry = git(worktree, [
			"ls-files",
			"--stage",
			"--error-unmatch",
			"--",
			planPath,
		]);
		const treeMatch = /^(\d+) blob ([0-9a-f]{40})\t/.exec(treeEntry);
		const indexMatch = /^(\d+) ([0-9a-f]{40}) 0\t/.exec(indexEntry);
		const worktreeSha = git(worktree, [
			"hash-object",
			"--no-filters",
			"--",
			planPath,
		]).toLowerCase();
		if (
			!treeMatch ||
			!indexMatch ||
			treeMatch[1] !== indexMatch[1] ||
			treeMatch[2] !== blobSha ||
			indexMatch[2] !== blobSha ||
			worktreeSha !== blobSha
		) {
			return { ok: false, reason: "dirty", message: DIRTY_PLAN_MESSAGE };
		}
		return { ok: true, blobSha };
	} catch (error) {
		return {
			ok: false,
			reason: existsSync(absolutePlan) ? "git_error" : "missing",
			message: existsSync(absolutePlan)
				? `could not bind committed plan blob: ${error instanceof Error ? error.message : String(error)}`
				: `plan does not exist at ${planPath}`,
		};
	}
}

export interface DesignManifestDeliveryResult {
	queued: true;
	deduped: boolean;
	/** Durable runner consumption, not merely a successful CommDB insert. */
	consumed: boolean;
}

const DESIGN_MANIFEST_ID = /^design-review-manifest:(.+):([1-9][0-9]*)$/;

/**
 * Terminal session state cannot retire the current design-review obligation.
 * The manifest revision is authoritative; older revisions become ordinary
 * stale instructions as soon as StateStore advances the current row.
 */
export function isCurrentDesignReviewManifestInstruction(
	store: Pick<StateStore, "getCurrentDesignReviewManifest">,
	row: Pick<
		import("flywheel-comm/mailbox-queue").MailboxRow,
		"id" | "to_agent"
	>,
): boolean {
	const match = DESIGN_MANIFEST_ID.exec(row.id);
	if (!match || match[1] !== row.to_agent) return false;
	const revision = Number(match[2]);
	const current = store.getCurrentDesignReviewManifest(row.to_agent);
	return (
		current !== null &&
		current.revision === revision &&
		current.delivered_at === undefined
	);
}

/** Stable-id CommDB delivery followed by the StateStore delivery receipt. */
export function deliverDesignReviewManifest(
	store: StateStore,
	manifest: DesignReviewManifest,
): DesignManifestDeliveryResult {
	const current = store.getCurrentDesignReviewManifest(manifest.execution_id);
	if (
		!current ||
		current.revision !== manifest.revision ||
		current.request_id !== manifest.request_id
	) {
		throw new Error(
			`refusing to deliver stale design review manifest ${manifest.execution_id}/${manifest.revision}`,
		);
	}
	const dbPath = commDbPathForProject(manifest.project_name);
	mkdirSync(dirname(dbPath), { recursive: true });
	const commDb = new CommDB(dbPath);
	let inserted: boolean;
	let consumed = false;
	try {
		const instructionId = `design-review-manifest:${manifest.execution_id}:${manifest.revision}`;
		inserted = commDb.insertInstructionWithId(
			instructionId,
			"bridge",
			manifest.execution_id,
			buildCodexInstruction(
				"design",
				manifest.expected_plan_path,
				manifest.execution_id,
				{
					requestId: manifest.request_id,
					reviewedPlanBlobSha: manifest.expected_blob_sha,
				},
			),
		);
		consumed = commDb.getMessageById(instructionId)?.read_at !== null;
	} finally {
		commDb.close();
	}
	if (consumed) {
		store.markDesignReviewManifestDelivered(
			manifest.execution_id,
			manifest.revision,
		);
	}
	return { queued: true, deduped: !inserted, consumed };
}

export function reconcileDesignReviewInstructions(
	store: StateStore,
	logger: Pick<Console, "log" | "warn"> = console,
): { attempted: number; delivered: number; failed: number } {
	const manifests = store.listUndeliveredDesignReviewManifests();
	let delivered = 0;
	let failed = 0;
	for (const manifest of manifests) {
		try {
			const result = deliverDesignReviewManifest(store, manifest);
			if (result.consumed) delivered++;
			logger.log(
				`[design-review-manifest] ${result.consumed ? "consumed" : result.deduped ? "awaiting consumption" : "queued"} ${manifest.execution_id}/${manifest.revision}`,
			);
		} catch (error) {
			failed++;
			logger.warn(
				`[design-review-manifest] delivery failed for ${manifest.execution_id}/${manifest.revision}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { attempted: manifests.length, delivered, failed };
}
