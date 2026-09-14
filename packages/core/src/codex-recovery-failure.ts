/** Process-internal recovery diagnostics. Free text never grants retry credit. */
export const MAX_CHARGED_ATTEMPTS = 2;
export const MAX_READINESS_FAILURES = 3;
export const READINESS_WINDOW_MS = 900_000;
export const READINESS_RETRY_DELAY_MS = 30_000;
export const RECOVERY_PRECOMMIT_OBSERVATION_MS = 300_000;

const STAGES = [
	"preflight",
	"context",
	"daemon_spawn",
	"socket_connect",
	"owner_admission",
	"commit",
	"teardown",
	"unknown",
] as const;
export type RecoveryStage = (typeof STAGES)[number];
export const RECOVERY_CODE_LABELS = {
	daemon_socket_not_ready: "恢复守护进程的 socket 尚未就绪",
	daemon_connect_not_ready: "恢复守护进程的连接尚未就绪",
	launch_snapshot_mismatch: "恢复启动配置与原始快照不一致",
	capability_mismatch: "恢复权限与原始权限不一致",
	permission_denied: "恢复操作被权限检查拒绝",
	daemon_start_failed: "恢复守护进程启动失败",
	owner_admission_failed: "恢复负责人接入失败",
	commit_refused: "恢复接管提交被拒绝",
	owner_result_missing: "恢复负责人未提供接管回执",
	owner_failed_unknown: "恢复负责人失败；未提供可识别错误",
	cleanup_unconfirmed: "恢复进程清理未确认完成",
} as const;
export type RecoveryCode = keyof typeof RECOVERY_CODE_LABELS;
const CLEANUPS = ["not_started", "confirmed_absent", "unconfirmed"] as const;
const SYSTEM_CODES = ["ENOENT", "ECONNREFUSED", "EACCES", "EPERM"] as const;
const MISMATCH_FIELDS = [
	"cwd",
	"model",
	"effort",
	"skillFrameworkMode",
	"phaseRole",
	"loopTargetNodeId",
	"capabilityDigest",
	"sandboxWritableRoots",
] as const;
export interface CodexRecoveryFailureV1 {
	version: 1;
	code: RecoveryCode;
	stage: RecoveryStage;
	summary: string;
	cleanup: (typeof CLEANUPS)[number];
	systemCode?: (typeof SYSTEM_CODES)[number];
	mismatchFields?: Array<(typeof MISMATCH_FIELDS)[number]>;
	secondaryCode?: "cleanup_unconfirmed";
}
function member<T extends string>(
	values: readonly T[],
	value: unknown,
): value is T {
	return typeof value === "string" && values.includes(value as T);
}
function fixedSummary(code: RecoveryCode, stage: RecoveryStage): string {
	return code === "owner_failed_unknown"
		? `恢复负责人在 ${stage} 失败；未提供可识别错误（owner_failed_unknown）`
		: `${RECOVERY_CODE_LABELS[code]}（${code}）`;
}
/** Reject unknown keys, oversized fields and unsupported versions on persisted reads. */
export function parseCodexRecoveryFailure(
	value: unknown,
): CodexRecoveryFailureV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).some(
			(key) =>
				![
					"version",
					"code",
					"stage",
					"summary",
					"cleanup",
					"systemCode",
					"mismatchFields",
					"secondaryCode",
				].includes(key),
		)
	)
		return undefined;
	if (
		v.version !== 1 ||
		typeof v.code !== "string" ||
		!Object.hasOwn(RECOVERY_CODE_LABELS, v.code) ||
		!member(STAGES, v.stage) ||
		!member(CLEANUPS, v.cleanup) ||
		typeof v.summary !== "string" ||
		!v.summary.trim() ||
		v.summary.length > 1000 ||
		Array.from(v.summary).length > 500 ||
		(v.systemCode !== undefined && !member(SYSTEM_CODES, v.systemCode)) ||
		(v.secondaryCode !== undefined && v.secondaryCode !== "cleanup_unconfirmed")
	)
		return undefined;
	if (
		v.mismatchFields !== undefined &&
		(!Array.isArray(v.mismatchFields) ||
			v.mismatchFields.length > MISMATCH_FIELDS.length ||
			v.mismatchFields.some((f) => !member(MISMATCH_FIELDS, f)))
	)
		return undefined;
	const parsed = createCodexRecoveryFailure({
		code: v.code as RecoveryCode,
		stage: v.stage,
		cleanup: v.cleanup,
		...(v.systemCode === undefined
			? {}
			: { systemCode: v.systemCode as CodexRecoveryFailureV1["systemCode"] }),
		...(v.mismatchFields === undefined
			? {}
			: {
					mismatchFields:
						v.mismatchFields as CodexRecoveryFailureV1["mismatchFields"],
				}),
		...(v.secondaryCode === undefined
			? {}
			: { secondaryCode: v.secondaryCode }),
	});
	if (parsed.code === "owner_failed_unknown")
		parsed.summary = legacySummary(v.summary) ?? parsed.summary;
	return parsed;
}
export function createCodexRecoveryFailure(
	input: Pick<CodexRecoveryFailureV1, "code" | "stage"> &
		Partial<
			Pick<
				CodexRecoveryFailureV1,
				"cleanup" | "systemCode" | "mismatchFields" | "secondaryCode"
			>
		>,
): CodexRecoveryFailureV1 {
	return {
		version: 1,
		code: input.code,
		stage: input.stage,
		summary: fixedSummary(input.code, input.stage),
		cleanup: input.cleanup ?? "not_started",
		...(input.systemCode === undefined ? {} : { systemCode: input.systemCode }),
		...(input.mismatchFields === undefined
			? {}
			: { mismatchFields: [...new Set(input.mismatchFields)] }),
		...(input.secondaryCode === undefined
			? {}
			: { secondaryCode: input.secondaryCode }),
	};
}
export class CodexRecoveryError extends Error {
	readonly recoveryFailure: CodexRecoveryFailureV1;
	constructor(failure: CodexRecoveryFailureV1, options?: ErrorOptions) {
		const safe =
			parseCodexRecoveryFailure(failure) ??
			createCodexRecoveryFailure({
				code: "owner_failed_unknown",
				stage: "unknown",
			});
		super(safe.summary, options);
		this.name = "CodexRecoveryError";
		this.recoveryFailure = safe;
	}
}
/** Cleanup evidence is attached without ever replacing the primary source. */
export function withRecoveryCleanup(
	failure: CodexRecoveryFailureV1,
	cleanup: CodexRecoveryFailureV1["cleanup"],
): CodexRecoveryFailureV1 {
	return {
		...failure,
		cleanup,
		...(cleanup === "unconfirmed"
			? { secondaryCode: "cleanup_unconfirmed" as const }
			: {}),
	};
}
function legacySummary(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const clean = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal control sequences from diagnostics.
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Remove controls from public diagnostics.
			/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g,
			" ",
		)
		.replace(/<[@#][^>]*>|@(?:everyone|here|[\w.-]+)/g, "[mention]")
		.replace(
			/\b(?:password|passwd|secret|token|api[_-]?key|authorization|credential|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
			"[credential]",
		)
		.replace(/\bBearer\s+\S+/gi, "[credential]")
		.replace(
			/\b(?:eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+)/g,
			"[credential]",
		)
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
		.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]*/g, "[path]")
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
			"[id]",
		)
		.replace(/\s+/g, " ")
		.trim();
	// Only retain recognizable operational prose, never arbitrary blobs, stacks or payloads.
	if (
		!/\b(?:fail(?:ed|ure)?|error|timeout|refused|denied|missing|socket|daemon|recovery|owner|lease|snapshot|reown)\b|失败|错误|超时|拒绝|恢复/.test(
			clean.replace(/[_-]/g, " "),
		) ||
		/[{}]|\bat\s+\w+\s*\(|[A-Za-z0-9_-]{32,}/.test(clean)
	)
		return undefined;
	return Array.from(clean).slice(0, 500).join("") || undefined;
}
export function normalizeCodexRecoveryFailure(
	input: unknown,
	fallback: {
		failureReason?: unknown;
		resultText?: unknown;
		stage?: RecoveryStage;
	} = {},
): CodexRecoveryFailureV1 {
	const typed = parseCodexRecoveryFailure(
		input instanceof CodexRecoveryError ? input.recoveryFailure : input,
	);
	if (typed) return typed;
	const unknown = createCodexRecoveryFailure({
		code: "owner_failed_unknown",
		stage: member(STAGES, fallback.stage) ? fallback.stage : "unknown",
	});
	const summary =
		legacySummary(fallback.failureReason) ??
		legacySummary(fallback.resultText) ??
		legacySummary(input instanceof Error ? input.message : input);
	return summary ? { ...unknown, summary } : unknown;
}
export function isReadinessFailure(input: unknown): boolean {
	const f = parseCodexRecoveryFailure(input);
	if (
		!f ||
		f.cleanup !== "confirmed_absent" ||
		f.secondaryCode === "cleanup_unconfirmed"
	)
		return false;
	return (
		(f.code === "daemon_socket_not_ready" && f.stage === "daemon_spawn") ||
		(f.code === "daemon_connect_not_ready" &&
			f.stage === "socket_connect" &&
			(f.systemCode === "ENOENT" || f.systemCode === "ECONNREFUSED"))
	);
}
