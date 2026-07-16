import { execFile as nodeExecFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { QuotaMonitorAlert } from "./quota-monitor.js";

const execFileAsync = promisify(nodeExecFile);

export type StrictDeliveryResult =
	| "sent"
	| "duplicate"
	| "queued_transient"
	| "dead_lettered"
	| "config_error";

type ExecFileFn = (
	file: string,
	args: string[],
	options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface QuotaMonitorAlertOptions {
	binPath?: string;
	execFile?: ExecFileFn;
	project?: string;
}

export function defaultLeadAlertBinPath(): string {
	return (
		process.env.FLYWHEEL_LEAD_ALERT_BIN ??
		resolve(
			dirname(fileURLToPath(import.meta.url)),
			"../../../../scripts/lead-alert.sh",
		)
	);
}

export async function sendQuotaMonitorAlert(
	alert: QuotaMonitorAlert,
	opts: QuotaMonitorAlertOptions = {},
): Promise<StrictDeliveryResult> {
	const exec = opts.execFile ?? (execFileAsync as ExecFileFn);
	let stdout: string;
	try {
		({ stdout } = await exec(
			opts.binPath ?? defaultLeadAlertBinPath(),
			[
				"--lead",
				"quota-monitor",
				"--project",
				opts.project ?? "flywheel",
				"--kind",
				alert.kind,
				"--severity",
				alert.severity,
				"--title",
				alert.title,
				"--body",
				alert.body,
				"--signature",
				alert.signature,
				"--strict-delivery",
			],
			{ timeout: 30_000 },
		));
	} catch {
		throw new Error(
			"quota monitor alert strict delivery failed (process error)",
		);
	}
	const delivery = stdout.trim() as StrictDeliveryResult;
	if (
		delivery === "sent" ||
		delivery === "queued_transient" ||
		delivery === "duplicate"
	) {
		return delivery;
	}
	throw new Error(
		"quota monitor alert strict delivery failed (rejected result)",
	);
}
