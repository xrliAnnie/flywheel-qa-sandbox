export interface DeadLetterNoticeInput {
	recipient: string;
	count: number;
	probeFacts?: string;
	summaries?: readonly string[];
}

/** FLY-1708: an unacknowledged message is a fact, not a liveness verdict. */
export function formatDeadLetterNotice(input: DeadLetterNoticeInput): string {
	const lines = [
		`${input.recipient} 有 ${input.count} 封信未签收。未签收 ≠ 已下线：判死需独立探针，勿凭本通知推断状态。`,
		input.probeFacts?.trim()
			? `探针实况：${input.probeFacts.trim()}`
			: "探针实况：不可得（处置前请人工 tmux pane 直读 + Bridge 心跳核对）。",
	];
	if (input.summaries?.length) {
		lines.push("摘要：", ...input.summaries.map((summary) => `- ${summary}`));
	}
	lines.push(
		"处置前必须先验活体（tmux pane 直读 + Bridge 心跳），确认死透再决定：重新派 / 丢弃 / 转给别人；活着则不要动它。",
	);
	return lines.join("\n");
}
