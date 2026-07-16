import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { QuotaMonitorAlert } from "./quota-monitor.js";
import type { QuotaMonitorState } from "./quota-monitor-state.js";

const execFileAsync = promisify(nodeExecFile);

export type QuotaPaneClass = "quota_stuck" | "login_expired" | "other";

/**
 * Fixture-driven, deliberately narrow classifier. A quota action requires the
 * real Claude cap sentence, an idle input box, and a 100% statusline gauge in
 * the recent live region. Alert echoes, generic 429s and resume menus fail it.
 */
export function classifyQuotaPane(capture: string): QuotaPaneClass {
	const recent = capture.split("\n").slice(-40).join("\n");
	if (
		/(?:not logged in|please run \/login|oauth token has expired|invalid api key)/i.test(
			recent,
		)
	) {
		return "login_expired";
	}
	const realCap =
		/Claude usage limit reached\. Your limit will reset[^\n]*\./i.test(recent);
	const idleInput = /^\s*❯\s*$/m.test(recent);
	const exhaustedGauge = /(?:^|\|)\s*(?:5h|7d)\s+[^\n|]*\b100%/im.test(recent);
	return realCap && idleInput && exhaustedGauge ? "quota_stuck" : "other";
}

export interface QuotaPaneRef {
	paneId: string;
	panePid: number;
}

export interface ReviveScanInput {
	state: QuotaMonitorState;
	nowMs: number;
	socket: string;
	monitorOnly: boolean;
	listPanes: () => Promise<QuotaPaneRef[]>;
	capturePane: (paneId: string) => Promise<string>;
	sendContinue: (paneId: string) => Promise<{ sent: boolean; error?: string }>;
	persistState: (state: QuotaMonitorState) => Promise<void>;
	alert: (alert: QuotaMonitorAlert) => Promise<void>;
}

export interface ReviveScanResult {
	state: QuotaMonitorState;
	summary: { revived: number; pending: number; loginExpired: number };
}

function paneInstanceKey(socket: string, pane: QuotaPaneRef): string {
	return `${socket}:${pane.paneId}:${pane.panePid}`;
}

export async function reviveScan(
	input: ReviveScanInput,
): Promise<ReviveScanResult> {
	const state = structuredClone(input.state);
	let epoch = state.reviveEpoch;
	if (epoch !== null && epoch.expiresAt <= input.nowMs) {
		state.reviveEpoch = null;
		epoch = null;
		await input.persistState(state);
	}
	const authorized = epoch !== null && !input.monitorOnly;
	const panes = await input.listPanes();
	const liveQuotaKeys = new Set<string>();
	let revived = 0;
	let pending = 0;
	let loginExpired = 0;

	for (const pane of panes) {
		let capture: string;
		try {
			capture = await input.capturePane(pane.paneId);
		} catch {
			continue;
		}
		const classification = classifyQuotaPane(capture);
		if (classification === "login_expired") {
			loginExpired++;
			continue;
		}
		if (classification !== "quota_stuck") continue;

		const key = paneInstanceKey(input.socket, pane);
		liveQuotaKeys.add(key);
		if (!authorized || epoch === null) continue;
		const previous = epoch.panes[key];
		if (previous && previous.attempts >= 3) {
			pending++;
			await input.alert({
				kind: "quota_revive_stuck",
				severity: "warning",
				title: "Claude pane remained quota-stuck after account switch",
				body: `pane=${key}; attempts=${previous.attempts}; source_account=${epoch.sourceAccount}`,
				signature: `quota-revive-stuck-${key}-${epoch.openedAt}`,
			});
			continue;
		}
		if (previous && previous.lastAttemptAt >= input.nowMs) {
			pending++;
			continue;
		}

		const sent = await input.sendContinue(pane.paneId);
		if (!sent.sent) {
			pending++;
			continue;
		}
		epoch.panes[key] = {
			attempts: (previous?.attempts ?? 0) + 1,
			lastAttemptAt: input.nowMs,
		};
		await input.persistState(state);
		revived++;
	}

	if (epoch !== null) {
		let removed = false;
		for (const key of Object.keys(epoch.panes)) {
			if (liveQuotaKeys.has(key)) continue;
			delete epoch.panes[key];
			removed = true;
		}
		if (removed) await input.persistState(state);
	}

	return { state, summary: { revived, pending, loginExpired } };
}

type ExecFileFn = (
	file: string,
	args: string[],
	options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface TmuxReviveOptions {
	socket: string;
	execFile?: ExecFileFn;
	timeoutMs?: number;
}

function tmuxPrefix(socket: string): string[] {
	return socket.length > 0 ? ["-L", socket] : [];
}

export function makeTmuxReviveDeps(opts: TmuxReviveOptions): {
	listPanes: () => Promise<QuotaPaneRef[]>;
	capturePane: (paneId: string) => Promise<string>;
	sendContinue: (paneId: string) => Promise<{ sent: boolean; error?: string }>;
} {
	const exec = opts.execFile ?? (execFileAsync as ExecFileFn);
	const timeout = opts.timeoutMs ?? 5_000;
	const prefix = tmuxPrefix(opts.socket);
	return {
		async listPanes(): Promise<QuotaPaneRef[]> {
			const { stdout } = await exec(
				"tmux",
				[...prefix, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"],
				{ timeout },
			);
			return stdout
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.flatMap((line) => {
					const [paneId, pidText] = line.split(/\s+/, 2);
					const panePid = Number(pidText);
					return paneId && Number.isInteger(panePid) && panePid > 0
						? [{ paneId, panePid }]
						: [];
				});
		},
		async capturePane(paneId: string): Promise<string> {
			const { stdout } = await exec(
				"tmux",
				[...prefix, "capture-pane", "-p", "-t", paneId],
				{ timeout },
			);
			return stdout;
		},
		async sendContinue(
			paneId: string,
		): Promise<{ sent: boolean; error?: string }> {
			try {
				await exec(
					"tmux",
					[...prefix, "send-keys", "-t", paneId, "-l", "--", "continue"],
					{ timeout },
				);
				await exec("tmux", [...prefix, "send-keys", "-t", paneId, "Enter"], {
					timeout,
				});
				return { sent: true };
			} catch (error) {
				return {
					sent: false,
					error: error instanceof Error ? error.message : "tmux send failed",
				};
			}
		},
	};
}
