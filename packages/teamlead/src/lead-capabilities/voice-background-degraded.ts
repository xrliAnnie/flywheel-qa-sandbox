/**
 * Why a voice session's background could not be admitted (plan v12 §14.2). The
 * session then continues as foreground-only voice; raw errors stay in local
 * evidence and never reach Bridge, prompts or the thread.
 */
export const VOICE_BACKGROUND_DEGRADED_REASONS = [
	"native_skill_baseline_unverified",
	"model_isolation_unproven",
	"node_runtime_closure_unresolved",
	"bridge_unavailable",
	"subscription_auth_unverified",
	"capability_process_failed",
	"admission_timeout",
	"admission_budget_exhausted",
	"parent_start_failed",
] as const;
export type VoiceBackgroundDegradedReason =
	(typeof VOICE_BACKGROUND_DEGRADED_REASONS)[number];

/** Fixed spoken/thread wording for each reason. */
export const VOICE_BACKGROUND_DEGRADED_REASON_TEXT: Readonly<
	Record<VoiceBackgroundDegradedReason, string>
> = Object.freeze({
	native_skill_baseline_unverified: "原生技能基线没核上",
	model_isolation_unproven: "沙箱隔离没证明",
	node_runtime_closure_unresolved: "运行环境没解析出来",
	bridge_unavailable: "连不上 Bridge",
	subscription_auth_unverified: "订阅登录没核上",
	capability_process_failed: "后台进程没起来",
	admission_timeout: "准备超时",
	admission_budget_exhausted: "准备时间不够",
	parent_start_failed: "后台启动失败",
});

export function isVoiceBackgroundDegradedReason(
	value: unknown,
): value is VoiceBackgroundDegradedReason {
	return (
		typeof value === "string" &&
		(VOICE_BACKGROUND_DEGRADED_REASONS as readonly string[]).includes(value)
	);
}
