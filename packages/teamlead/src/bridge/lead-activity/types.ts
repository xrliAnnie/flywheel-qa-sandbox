/**
 * FLY-2882 — read-only "what is this Lead doing right now" contract.
 *
 * Invariants encoded here (plan §3):
 *   - `state` is a discriminated union: busy carries a turn + trigger, idle
 *     carries nothing else, unknown carries an enumerated reason whose `detail`
 *     is ALWAYS the fixed text from the table below (never pane text, paths,
 *     SQL parameters or sidecar bytes).
 *   - `source` is fixed per carrier (claude_pane / codex_sidecar).
 *   - The validator is exact-key: an unexpected field (e.g. a leaked message
 *     body) makes the DTO invalid, so the route answers 500 instead of leaking.
 */

export const LEAD_ACTIVITY_SCHEMA = "lead-activity.v1" as const;
export const LEAD_ACTIVITY_FLEET_SCHEMA = "lead-activity-fleet.v1" as const;

export type LeadActivityCarrier = "claude-code" | "codex-app-server";
export type LeadActivitySource = "claude_pane" | "codex_sidecar";

export const SOURCE_BY_CARRIER: Readonly<
	Record<LeadActivityCarrier, LeadActivitySource>
> = {
	"claude-code": "claude_pane",
	"codex-app-server": "codex_sidecar",
};

export const UNKNOWN_REASON_DETAIL = {
	lead_window_unavailable:
		"找不到或无法确认这个 Lead 的终端窗口(没配置、tmux 不通或身份对不上)",
	pane_capture_failed: "读取这个 Lead 的终端画面失败",
	pane_unrecognized:
		"终端画面里找不到这个 Lead 的输入框(可能停在菜单/弹窗,或 Claude 进程不在)",
	no_turn_status_line:
		"终端里没有任何本轮状态行(可能重启后还没干过活),无法证明空闲",
	unrecognized_status_line: "最近的状态行格式不认识,无法判断忙闲",
	status_line_blocked: "终端显示正在压缩上下文或等待取消,忙闲不确定",
	sidecar_unreachable:
		"连不上这个 Codex Lead 的 sidecar(没在运行、超时或认证失败)",
	sidecar_lacks_turn_state:
		"这个 Codex Lead 的 sidecar 不支持忙闲查询(需要重启到新版本)",
	sidecar_protocol_invalid: "sidecar 回包格式不合法",
	observer_disconnected: "sidecar 与 Codex 后台的连接已断开",
	turn_state_not_seeded: "sidecar 还没拿到可信的忙闲初值",
	carrier_unsupported: "这个 Lead 的载体类型不受支持",
	read_failed: "读取忙闲时出现意外错误",
} as const;
export type UnknownReason = keyof typeof UNKNOWN_REASON_DETAIL;

export const TRIGGER_UNDETERMINED_DETAIL = {
	causality_unproven: "判断不了:Claude Lead 没有记录这一轮由哪条消息开启",
	founder_terminal_turn: "判断不了:这一轮是 founder 在终端里直接开的",
	turn_origin_unknown: "判断不了:这一轮开始于 sidecar 接上之前,不知道由谁发起",
	turn_not_yet_bound: "判断不了:这一轮刚开始,还没绑定到投递记录",
	ambiguous_turn_binding: "判断不了:这一轮对应了多条投递记录",
	no_delivery_binding:
		"判断不了:这一轮不是由信箱投递开启的(例如 sidecar 直接收到的 Discord 消息)",
	candidate_overflow: "判断不了:这一轮合并的消息太多",
	unmapped_delivery: "判断不了:有消息映射不到具体的单",
	multiple_issues: "判断不了:这一轮合并了多张单的消息",
	attribution_unavailable: "判断不了:读取投递记录失败",
} as const;
export type TriggerUndeterminedReason =
	keyof typeof TRIGGER_UNDETERMINED_DETAIL;

export interface LeadActivityTurn {
	startedAt: string;
	elapsedMs: number;
	precision: "second" | "minute";
	origin: "message" | "founder_terminal" | "unknown";
}

export type LeadActivityTrigger =
	| { kind: "issue"; issueId: string; basis: "codex_journal_members" }
	| {
			kind: "undetermined";
			reason: TriggerUndeterminedReason;
			detail: string;
	  };

interface LeadActivityBase {
	schema: typeof LEAD_ACTIVITY_SCHEMA;
	projectName: string;
	leadId: string;
	carrier: LeadActivityCarrier;
	observedAt: string;
	source: LeadActivitySource;
}

export type LeadActivityV1 =
	| (LeadActivityBase & {
			state: "busy";
			turn: LeadActivityTurn;
			trigger: LeadActivityTrigger;
	  })
	| (LeadActivityBase & { state: "idle" })
	| (LeadActivityBase & {
			state: "unknown";
			unknown: { reason: UnknownReason; detail: string };
	  });

export interface LeadActivityFleetV1 {
	schema: typeof LEAD_ACTIVITY_FLEET_SCHEMA;
	observedAt: string;
	leads: LeadActivityV1[];
}

/** Carrier-local reading, before the service stamps identity + observedAt. */
export type LeadActivityReading =
	| {
			state: "busy";
			turn: LeadActivityTurn;
			trigger: LeadActivityTrigger;
	  }
	| { state: "idle" }
	| { state: "unknown"; reason: UnknownReason };

export const ISSUE_ID_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export function undetermined(
	reason: TriggerUndeterminedReason,
): LeadActivityTrigger {
	return {
		kind: "undetermined",
		reason,
		detail: TRIGGER_UNDETERMINED_DETAIL[reason],
	};
}

export function buildLeadActivity(args: {
	projectName: string;
	leadId: string;
	carrier: LeadActivityCarrier;
	observedAtMs: number;
	reading: LeadActivityReading;
}): LeadActivityV1 {
	const base: LeadActivityBase = {
		schema: LEAD_ACTIVITY_SCHEMA,
		projectName: args.projectName,
		leadId: args.leadId,
		carrier: args.carrier,
		observedAt: new Date(args.observedAtMs).toISOString(),
		source: SOURCE_BY_CARRIER[args.carrier],
	};
	const reading = args.reading;
	if (reading.state === "unknown") {
		return {
			...base,
			state: "unknown",
			unknown: {
				reason: reading.reason,
				detail: UNKNOWN_REASON_DETAIL[reading.reason],
			},
		};
	}
	if (reading.state === "idle") return { ...base, state: "idle" };
	return {
		...base,
		state: "busy",
		turn: { ...reading.turn },
		trigger: { ...reading.trigger },
	};
}

function exactKeys(value: object, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return (
		actual.length === keys.length && actual.every((key) => keys.includes(key))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Number.isFinite(Date.parse(value)) &&
		new Date(Date.parse(value)).toISOString() === value
	);
}

const IDENTITY_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validTurn(value: unknown): boolean {
	return (
		isRecord(value) &&
		exactKeys(value, ["startedAt", "elapsedMs", "precision", "origin"]) &&
		isIsoTimestamp(value.startedAt) &&
		Number.isSafeInteger(value.elapsedMs) &&
		(value.elapsedMs as number) >= 0 &&
		(value.precision === "second" || value.precision === "minute") &&
		(value.origin === "message" ||
			value.origin === "founder_terminal" ||
			value.origin === "unknown")
	);
}

function validTrigger(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value.kind === "issue")
		return (
			exactKeys(value, ["kind", "issueId", "basis"]) &&
			typeof value.issueId === "string" &&
			ISSUE_ID_RE.test(value.issueId) &&
			value.basis === "codex_journal_members"
		);
	return (
		value.kind === "undetermined" &&
		exactKeys(value, ["kind", "reason", "detail"]) &&
		typeof value.reason === "string" &&
		Object.hasOwn(TRIGGER_UNDETERMINED_DETAIL, value.reason) &&
		value.detail ===
			TRIGGER_UNDETERMINED_DETAIL[value.reason as TriggerUndeterminedReason]
	);
}

/** Exact-key runtime check applied to every DTO before it leaves the Bridge. */
export function isValidLeadActivity(value: unknown): value is LeadActivityV1 {
	if (!isRecord(value)) return false;
	const baseKeys = [
		"schema",
		"projectName",
		"leadId",
		"carrier",
		"observedAt",
		"source",
		"state",
	];
	if (
		value.schema !== LEAD_ACTIVITY_SCHEMA ||
		typeof value.projectName !== "string" ||
		!IDENTITY_RE.test(value.projectName) ||
		typeof value.leadId !== "string" ||
		!IDENTITY_RE.test(value.leadId) ||
		(value.carrier !== "claude-code" && value.carrier !== "codex-app-server") ||
		value.source !== SOURCE_BY_CARRIER[value.carrier] ||
		!isIsoTimestamp(value.observedAt)
	)
		return false;
	if (value.state === "idle") return exactKeys(value, baseKeys);
	if (value.state === "unknown") {
		const unknown = value.unknown;
		return (
			exactKeys(value, [...baseKeys, "unknown"]) &&
			isRecord(unknown) &&
			exactKeys(unknown, ["reason", "detail"]) &&
			typeof unknown.reason === "string" &&
			Object.hasOwn(UNKNOWN_REASON_DETAIL, unknown.reason) &&
			unknown.detail === UNKNOWN_REASON_DETAIL[unknown.reason as UnknownReason]
		);
	}
	if (value.state !== "busy") return false;
	if (
		!exactKeys(value, [...baseKeys, "turn", "trigger"]) ||
		!validTurn(value.turn) ||
		!validTrigger(value.trigger)
	)
		return false;
	const turn = value.turn as unknown as LeadActivityTurn;
	return Date.parse(turn.startedAt) <= Date.parse(value.observedAt as string);
}

export function isValidLeadActivityFleet(
	value: unknown,
): value is LeadActivityFleetV1 {
	return (
		isRecord(value) &&
		exactKeys(value, ["schema", "observedAt", "leads"]) &&
		value.schema === LEAD_ACTIVITY_FLEET_SCHEMA &&
		isIsoTimestamp(value.observedAt) &&
		Array.isArray(value.leads) &&
		value.leads.every(isValidLeadActivity)
	);
}
