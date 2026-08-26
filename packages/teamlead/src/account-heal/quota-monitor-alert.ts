import { execFile as nodeExecFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	QuotaMonitorAlert,
	QuotaMonitorAlertKind,
} from "./quota-monitor.js";
import type {
	DurableAlertIntent,
	QuotaMonitorState,
} from "./quota-monitor-state.js";

const execFileAsync = promisify(nodeExecFile);

export type StrictDeliveryResult =
	| "sent"
	| "duplicate"
	| "queued_transient"
	| "dead_lettered"
	| "config_error";

export type DeliveryAttemptResult =
	| StrictDeliveryResult
	| "process_error"
	| "invalid_result";

export interface DeliveryReport {
	primary: DeliveryAttemptResult;
	secondary?: DeliveryAttemptResult;
}

type ExecFileFn = (
	file: string,
	args: string[],
	options: { timeout: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface QuotaMonitorAlertOptions {
	binPath?: string;
	execFile?: ExecFileFn;
	project?: string;
}

type RoutingPolicy = {
	mention: boolean;
	severe: boolean;
	primaryChannel?: "notify";
	primaryStyle?: "plain";
};

const ROUTING = {
	account_switched: {
		mention: true,
		severe: false,
		primaryChannel: "notify",
		primaryStyle: "plain",
	},
	account_switch_degraded: {
		mention: true,
		severe: true,
		primaryChannel: "notify",
		primaryStyle: "plain",
	},
	machine_account_conflict: { mention: true, severe: true },
	model_cap_switched: { mention: true, severe: false },
	model_cap_unknown: { mention: false, severe: false },
	model_cap_persistent_unknown: { mention: true, severe: true },
	model_bench_malformed: { mention: true, severe: true },
	quota_choice: { mention: true, severe: true },
	quota_switch_confirmation: {
		mention: false,
		severe: false,
		primaryChannel: "notify",
		primaryStyle: "plain",
	},
	quota_no_target: { mention: true, severe: true },
	account_identity_mismatch: { mention: true, severe: true },
	quota_blocked_recovered: { mention: false, severe: false },
	quota_read_blind: { mention: false, severe: false },
	account_switch_failed: { mention: false, severe: false },
	quota_revive_stuck: { mention: false, severe: false },
	quota_monitor_down: { mention: false, severe: false },
} satisfies Record<QuotaMonitorAlertKind, RoutingPolicy>;

const STRICT_RESULTS = new Set<StrictDeliveryResult>([
	"sent",
	"duplicate",
	"queued_transient",
	"dead_lettered",
	"config_error",
]);

export function defaultLeadAlertBinPath(): string {
	return (
		process.env.FLYWHEEL_LEAD_ALERT_BIN ??
		resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../scripts/lead-alert.sh",
		)
	);
}

function parseStrictResult(stdout: unknown): DeliveryAttemptResult {
	if (typeof stdout !== "string" || stdout.trim().length === 0) {
		return "process_error";
	}
	const value = stdout.trim();
	return STRICT_RESULTS.has(value as StrictDeliveryResult)
		? (value as StrictDeliveryResult)
		: "invalid_result";
}

async function attemptDelivery(
	exec: ExecFileFn,
	binPath: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
): Promise<DeliveryAttemptResult> {
	try {
		const { stdout } = await exec(binPath, args, { timeout: 30_000, env });
		return parseStrictResult(stdout);
	} catch (error) {
		const stdout =
			typeof error === "object" && error !== null && "stdout" in error
				? (error as { stdout?: unknown }).stdout
				: undefined;
		return stdout === undefined ? "process_error" : parseStrictResult(stdout);
	}
}

/**
 * Who to @ on a mention-policy alert. FLY-1366: the daemon ran with no quota
 * mention configured, so `quota_no_target` landed in the alert channel with no
 * ping and the founder never saw the account pool was stuck. Fall back to the
 * founder id the daemon already carries. Not `A ?? B` — an env set to an empty
 * or whitespace-only string must not suppress the fallback (and would in turn be
 * dropped by the falsy check in `alertArgs`, mentioning nobody).
 */
function resolveMentionUser(): string | undefined {
	for (const candidate of [
		process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER,
		process.env.FLYWHEEL_FOUNDER_USER_ID,
	]) {
		const trimmed = candidate?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function alertArgs(
	alert: QuotaMonitorAlert | DurableAlertIntent["alert"],
	project: string,
	mentionUser?: string,
	signature = alert.signature,
	plainMessage = false,
): string[] {
	const args = [
		"--lead",
		"quota-monitor",
		"--project",
		project,
		"--kind",
		alert.kind,
		"--severity",
		alert.severity,
		"--title",
		alert.title,
		"--body",
		alert.body,
		"--signature",
		signature,
		"--strict-delivery",
	];
	if (plainMessage) args.push("--plain-message");
	if (mentionUser) args.push("--mention-user", mentionUser);
	return args;
}

export async function sendQuotaMonitorAlert(
	alert: QuotaMonitorAlert | DurableAlertIntent["alert"],
	opts: QuotaMonitorAlertOptions = {},
): Promise<DeliveryReport> {
	const exec = opts.execFile ?? (execFileAsync as ExecFileFn);
	const binPath = opts.binPath ?? defaultLeadAlertBinPath();
	const project = opts.project ?? "flywheel";
	const policy =
		alert.kind === "account_switch_failed" &&
		/\breason=(?:transition_journal_conflict|identity_rollback_failed)\b/.test(
			alert.body,
		)
			? { mention: true, severe: true }
			: ((ROUTING as Record<string, RoutingPolicy>)[alert.kind] ?? {
					mention: true,
					severe: true,
				});
	const mentionUser = policy.mention ? resolveMentionUser() : undefined;
	const notifyChannel =
		policy.primaryChannel === "notify"
			? process.env.FLYWHEEL_NOTIFY_CHANNEL?.trim()
			: undefined;
	if (policy.primaryChannel === "notify" && !notifyChannel) {
		return { primary: "config_error" };
	}
	const primaryEnv = notifyChannel
		? {
				...process.env,
				FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: notifyChannel,
			}
		: undefined;
	const primary = await attemptDelivery(
		exec,
		binPath,
		alertArgs(
			alert,
			project,
			mentionUser,
			alert.signature,
			policy.primaryStyle === "plain",
		),
		primaryEnv,
	);

	const severeChannel = process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID;
	const unifiedChannel = process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID;
	if (
		!policy.severe ||
		!severeChannel ||
		severeChannel === unifiedChannel ||
		severeChannel === notifyChannel
	) {
		return { primary };
	}

	const secondary = await attemptDelivery(
		exec,
		binPath,
		alertArgs(alert, project, mentionUser, `${alert.signature}-core`),
		{ ...process.env, FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: severeChannel },
	);
	return { primary, secondary };
}

export async function drainQuotaMonitorAlertOutbox(
	inputState: QuotaMonitorState,
	deps: {
		send: (alert: DurableAlertIntent["alert"]) => Promise<StrictDeliveryResult>;
		persistState: (state: QuotaMonitorState) => Promise<void>;
	},
): Promise<{
	state: QuotaMonitorState;
	result: "empty" | "sent" | "queued" | "unconfirmed";
}> {
	const pending = inputState.alertOutbox[0];
	if (pending === undefined) return { state: inputState, result: "empty" };
	const delivery = await deps.send(pending.alert);
	if (delivery !== "sent" && delivery !== "queued_transient") {
		return { state: inputState, result: "unconfirmed" };
	}
	const state = structuredClone(inputState);
	state.alertOutbox = state.alertOutbox.filter(
		(item) => item.eventId !== pending.eventId,
	);
	await deps.persistState(state);
	return {
		state,
		result: delivery === "sent" ? "sent" : "queued",
	};
}
