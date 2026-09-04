export const LAND_CLOSEOUT_CAUSES = [
	"husk_lease_stale",
	"phase_shutdown_unacked",
	"node_process_residual",
	"node_process_unverifiable",
	"window_identity_mismatch",
	"window_cleanup_failed",
	"window_identity_pending",
	"commdb_finalize_failed",
	"worktree_branch_mismatch",
	"lifecycle_conflict",
	"archive_failed",
	"source_session_unavailable",
	"unknown",
] as const;

export type LandCloseoutCause = (typeof LAND_CLOSEOUT_CAUSES)[number];

export function landCloseoutReason(cause: LandCloseoutCause): string {
	return `issue_closeout_incomplete:cause=${cause}`;
}

export function landCloseoutCauseFromReason(reason: string): LandCloseoutCause {
	const cause = reason.match(/(?:^|:)cause=([a-z_]+)(?:$|:)/)?.[1];
	return LAND_CLOSEOUT_CAUSES.includes(cause as LandCloseoutCause)
		? (cause as LandCloseoutCause)
		: "unknown";
}

export function inferLandCloseoutCause(errors: string[]): LandCloseoutCause {
	const joined = errors.join("\n");
	const matchers: Partial<Record<LandCloseoutCause, readonly string[]>> = {
		husk_lease_stale: ["controller_lease_stale"],
		phase_shutdown_unacked: [
			"phase_shutdown_ack_",
			"phase_shutdown_timeout_",
			"phase_shutdown_request_disappeared",
			"phase_shutdown_failed",
		],
		node_process_residual: ["node_process_residual"],
		node_process_unverifiable: ["node_process_unverifiable"],
		window_identity_mismatch: ["window_identity_mismatch"],
		window_cleanup_failed: ["window_cleanup_failed"],
		commdb_finalize_failed: ["commdb finalize", "commdb_finalize_failed"],
		window_identity_pending: ["tmux window identity is still pending"],
		worktree_branch_mismatch: ["branch", "worktree"],
		lifecycle_conflict: ["authority_lost", "disposition_conflict"],
		archive_failed: ["archive_failed"],
		source_session_unavailable: ["source_session_unavailable"],
	};
	for (const cause of LAND_CLOSEOUT_CAUSES) {
		if (matchers[cause]?.some((token) => joined.includes(token))) return cause;
	}
	return "unknown";
}

type CloseoutCauseReportShape = {
	nodes: Array<{
		transition: { state: string; error?: string };
		teardown: { state: string; error?: string };
	}>;
};

export function inferLandCloseoutCauseFromClosureReport(
	report: CloseoutCauseReportShape,
): LandCloseoutCause | undefined {
	const errors = report.nodes.flatMap((node) =>
		[node.transition, node.teardown].flatMap((outcome) =>
			outcome.state === "failed" && outcome.error ? [outcome.error] : [],
		),
	);
	return errors.length > 0 ? inferLandCloseoutCause(errors) : undefined;
}

export function landIssueCloseoutResultFromClosureReport<
	TOutcome extends string,
>(
	report: CloseoutCauseReportShape & { outcome: TOutcome },
): { outcome: TOutcome; cause?: LandCloseoutCause } {
	if (report.outcome === "complete") return { outcome: report.outcome };
	const cause = inferLandCloseoutCauseFromClosureReport(report);
	return { outcome: report.outcome, ...(cause ? { cause } : {}) };
}

export function describeLandCloseoutCause(cause: LandCloseoutCause): string {
	switch (cause) {
		case "husk_lease_stale":
			return "Runner 窗口仍在，但控制器心跳已停止";
		case "phase_shutdown_unacked":
			return "Runner 收尾请求尚未确认，窗口或进程可能仍在运行";
		case "node_process_residual":
			return "Runner 节点进程未能完全退出";
		case "node_process_unverifiable":
			return "Runner 节点进程状态无法确认";
		case "window_identity_mismatch":
			return "Runner 窗口身份无法安全确认";
		case "window_cleanup_failed":
			return "Runner 窗口清理失败";
		case "commdb_finalize_failed":
			return "Runner 通信记录未能完成收尾";
		case "window_identity_pending":
			return "Runner 窗口身份仍未完成注册";
		case "worktree_branch_mismatch":
			return "worktree 或分支状态与预期不一致";
		case "lifecycle_conflict":
			return "issue 生命周期状态发生冲突";
		case "archive_failed":
			return "thread 归档请求失败";
		case "source_session_unavailable":
			return "land 来源 Runner 已不可用";
		default:
			return "自动收尾未能完成";
	}
}

export function renderLandThreadNotification(
	stage: string,
	prNumber: number,
	detail: Record<string, unknown>,
): string {
	const reason = typeof detail.reason === "string" ? detail.reason : "";
	const explanation = describeLandCloseoutCause(
		landCloseoutCauseFromReason(reason),
	);
	if (stage === "finalization_partial") {
		return `🏁 PR #${prNumber} 已合入；自动收尾尚未完成（${explanation}），正在自动重试。thread 暂不归档，以免隐藏仍存活的 Runner。`;
	}
	if (stage === "finalization_held") {
		return `⛔ PR #${prNumber} 已合入，但自动重试已停止（${explanation}）。需要 Lead 人工处理；处理完成并 resume 后，本 thread 会自动归档。`;
	}
	return `🏁 land ${stage} — PR #${prNumber}\n${JSON.stringify(detail)}`;
}
