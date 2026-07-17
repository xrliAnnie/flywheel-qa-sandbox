import { execFile as nodeExecFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	QuotaMonitorAlert,
	QuotaMonitorAlertKind,
} from "./quota-monitor.js";

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

type RoutingPolicy = { mention: boolean; severe: boolean };

const ROUTING = {
	account_switched: { mention: true, severe: false },
	account_switch_degraded: { mention: true, severe: true },
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

function alertArgs(
	alert: QuotaMonitorAlert,
	project: string,
	mentionUser?: string,
	signature = alert.signature,
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
	if (mentionUser) args.push("--mention-user", mentionUser);
	return args;
}

export async function sendQuotaMonitorAlert(
	alert: QuotaMonitorAlert,
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
			: ROUTING[alert.kind];
	const mentionUser = policy.mention
		? process.env.FLYWHEEL_QUOTA_ALERT_MENTION_USER
		: undefined;
	const primary = await attemptDelivery(
		exec,
		binPath,
		alertArgs(alert, project, mentionUser),
	);

	const severeChannel = process.env.FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID;
	const unifiedChannel = process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID;
	if (!policy.severe || !severeChannel || severeChannel === unifiedChannel) {
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
