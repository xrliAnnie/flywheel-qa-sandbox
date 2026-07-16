/**
 * ConclusionPipeline (FLY-545 PR-2 P13′) — the C block: turn a finished
 * huddle into durable artifacts on the kickoff issue.
 *
 * Landing order is a contract (plan §6): summary comment → worktree → Done →
 * TIV card. Done is LAST — any earlier failure leaves the issue open and the
 * failure spoken/visible (never a silent half-landing, never a Done without
 * its artifacts). The summary comment carries a deterministic idempotency
 * marker (Codex R2 guardrail ①) so a re-run edits nothing twice; re-running
 * after a partial landing resumes where it failed (comment already present →
 * skip, worktree already created → reuse).
 *
 * A6 (founder increment): no live dispatching mid-meeting — action items ride
 * the summary comment on the kickoff issue after the meeting. Per-Lead thread
 * fan-out is a seam (dispatchActionItems) the wiring may extend later.
 */
import type { CreatedIssue } from "../linear/BridgeLinearClient.js";

export interface ConclusionLinear {
	comment(issueId: string, body: string): Promise<void>;
	setStatus(issueId: string, status: string): Promise<void>;
	/** current workflow state name (idempotency guard: Done = already landed).
	 * A lookup failure must RESOLVE undefined, not throw — the guard is an
	 * optimization, never a reason to refuse a landing. */
	getState?(issueId: string): Promise<string | undefined>;
}

export interface ConclusionWorktree {
	create(opts: {
		mainRepoPath: string;
		projectName: string;
		issueId: string;
	}): Promise<{ path: string }>;
}

/** durable per-issue landing ledger — the partial-resume memory (Codex R2:
 * the Done guard alone cannot see a half-landed issue; the daemon is
 * single-machine, so a local file is the honest source of "which steps
 * already ran"). Failures in the store must never fail a landing. */
export interface LandingProgress {
	commented?: boolean;
	worktreePath?: string;
}

export interface LandingProgressStore {
	load(identifier: string): LandingProgress | undefined;
	save(identifier: string, progress: LandingProgress): void;
}

export interface ConclusionPipelineOptions {
	linear: ConclusionLinear;
	worktree: ConclusionWorktree;
	/** journal text → summary markdown (ReadOnlyLeadBrain, host persona). */
	summarize: (journalSnapshot: string) => Promise<string>;
	/** awaited TIV card / warning surface. */
	tiv: { card(content: string): Promise<void>; warn(text: string): void };
	mainRepoPath: string;
	projectName: string;
	/** optional partial-resume ledger; absent = every re-run repeats steps. */
	progressStore?: LandingProgressStore;
	log?: (line: string) => void;
}

export interface LandInput {
	issue: CreatedIssue;
	/** false = she left before the verbal recap-confirm (degraded landing). */
	confirmed: boolean;
	journalSnapshot: string;
	/** transcript file path for the audit pointer in the comment. */
	transcriptPath?: string;
}

export type LandOutcome = "landed" | "failed";

export const SUMMARY_MARKER = (identifier: string) =>
	`<!-- huddle-summary:${identifier} -->`;

export class ConclusionPipeline {
	constructor(private readonly opts: ConclusionPipelineOptions) {}

	/** assembling timed out — she never joined. Close out loudly and cheaply. */
	async abortNoShow(issue: CreatedIssue): Promise<void> {
		try {
			await this.opts.linear.comment(
				issue.identifier,
				`${SUMMARY_MARKER(issue.identifier)}\n本场 huddle 未开成(founder 未进语音,assembling 超时)。自动关闭。`,
			);
			await this.opts.linear.setStatus(issue.identifier, "Done");
		} catch (err) {
			this.opts.tiv.warn(
				`未开成收尾没写全(${msg(err)})— issue ${issue.identifier} 需要人工关一下。`,
			);
		}
	}

	async land(input: LandInput): Promise<LandOutcome> {
		// 0. idempotency guard (Codex R1 MEDIUM: the marker was written but
		// never checked): a re-run against an already-Done issue must not
		// duplicate the comment or re-create the worktree. Done is the LAST
		// landing step, so Done ⇒ every artifact exists.
		const state = await this.opts.linear
			.getState?.(input.issue.identifier)
			.catch(() => undefined);
		if (state && state.toLowerCase() === "done") {
			await this.opts.tiv.card(
				`ℹ️ ${input.issue.identifier} 已经落地过(issue 已 Done)— 本次重跑没有重复写入。`,
			);
			return "landed";
		}

		// partial-resume ledger (Codex R2): which steps already ran for this
		// issue? A half-landed re-run must skip the comment and reuse the
		// worktree, not duplicate them.
		const progress: LandingProgress =
			this.opts.progressStore?.load(input.issue.identifier) ?? {};

		if (progress.commented) {
			this.opts.log?.(
				`[conclusion] ${input.issue.identifier} summary comment already landed — skipping (resume)`,
			);
		} else {
			// 1. summary (brain) — a summary we cannot produce is a failed
			// landing, but the transcript pointer still gives her the raw material.
			let summary: string;
			try {
				summary = await this.opts.summarize(input.journalSnapshot);
			} catch (err) {
				this.opts.tiv.warn(
					`总结生成失败(${msg(err)})— transcript 在 ${input.transcriptPath ?? "(未落盘)"},issue ${input.issue.identifier} 留 open。`,
				);
				return "failed";
			}

			const commentBody = [
				SUMMARY_MARKER(input.issue.identifier),
				input.confirmed
					? ""
					: "> ⚠️ 未经口头确认(founder 在 recap 前离开)— 内容如有出入请直接在本 issue 里改。",
				summary,
				"",
				input.transcriptPath
					? `_原始 transcript: ${input.transcriptPath}_`
					: "",
			]
				.filter(Boolean)
				.join("\n");

			// 2. comment — failure stops the landing (no worktree, no Done).
			try {
				await this.opts.linear.comment(input.issue.identifier, commentBody);
			} catch (err) {
				this.opts.tiv.warn(
					`summary 写不进 issue(${msg(err)})— transcript 在 ${input.transcriptPath ?? "(未落盘)"},issue ${input.issue.identifier} 留 open,worktree 未建。`,
				);
				return "failed";
			}
			progress.commented = true;
			this.saveProgress(input.issue.identifier, progress);
		}

		// 3. worktree — failure leaves the issue open (fail loud, never
		// blind-rm); a recorded path from a previous partial landing is reused.
		let worktreePath = progress.worktreePath;
		if (worktreePath) {
			this.opts.log?.(
				`[conclusion] ${input.issue.identifier} worktree already created — reusing ${worktreePath} (resume)`,
			);
		} else {
			try {
				const wt = await this.opts.worktree.create({
					mainRepoPath: this.opts.mainRepoPath,
					projectName: this.opts.projectName,
					issueId: input.issue.identifier,
				});
				worktreePath = wt.path;
			} catch (err) {
				this.opts.tiv.warn(
					`worktree 建失败(${msg(err)})— summary 已写进 ${input.issue.identifier},issue 留 open,人工建或重跑落地。`,
				);
				return "failed";
			}
			progress.worktreePath = worktreePath;
			this.saveProgress(input.issue.identifier, progress);
		}

		// 4. Done — the LAST step; a flip failure is loud and leaves work for a human.
		try {
			await this.opts.linear.setStatus(input.issue.identifier, "Done");
		} catch (err) {
			this.opts.tiv.warn(
				`issue 状态翻不动(${msg(err)})— summary/worktree 都齐了,${input.issue.identifier} 需要人工点 Done。`,
			);
			return "failed";
		}

		// 5. conclusion card.
		await this.opts.tiv.card(
			[
				"✅ **Huddle 落地**",
				`- 立项 issue: ${input.issue.identifier} ${input.issue.url}(已 Done)`,
				`- worktree: ${worktreePath}`,
				input.confirmed ? "" : "- ⚠️ summary 未经口头确认,细节请在 issue 里核对",
				"- summary + action items(含原话引用)在 issue comment 里",
			]
				.filter(Boolean)
				.join("\n"),
		);
		return "landed";
	}

	private saveProgress(identifier: string, progress: LandingProgress): void {
		try {
			this.opts.progressStore?.save(identifier, progress);
		} catch (err) {
			// the ledger is resilience, not a gate — never fail a landing on it.
			this.opts.log?.(`[conclusion] landing ledger write failed: ${msg(err)}`);
		}
	}
}

function msg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
