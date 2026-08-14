import { execFile as nodeExecFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { leadAddressFromManifest } from "../lead-address.js";
import { type ModelCapVerdict, parseModelCap } from "./model-cap.js";
import type { QuotaMonitorAlert } from "./quota-monitor.js";
import {
	MAX_UNKNOWN_PANE_COUNT,
	type QuotaMonitorState,
	updateUnknownPaneObservations,
} from "./quota-monitor-state.js";

const execFileAsync = promisify(nodeExecFile);

export type QuotaPaneClass = "quota_stuck" | "login_expired" | "other";

const CLAUDE_COMMAND = /^(?:claude|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/i;
const FLYWHEEL_SESSION =
	/^(?:flywheel|flywheel-quota-qa|runner-[A-Za-z0-9._-]+|cmux-[A-Za-z0-9._-]+)$/;
const FLYWHEEL_WINDOW =
	/^(?:[A-Z][A-Z0-9]*-\d+-[A-Za-z0-9._-]+|[a-z0-9][A-Za-z0-9._-]*-lead)$/;
const INPUT_BOX = /─{6,}[^\n]*@[\w-]+\s+─/u;
const CLAUDE_STATUS =
	/\b(?:Opus|Sonnet|Haiku)\b[^\n]*\|\s*⚡?[\w-]+\s*\|[^\n]*\bctx\s+\d+%/i;
const CLAUDE_MODE =
	/(?:bypass permissions|accept edits|plan mode)[^\n]*(?:shift\+tab|permissions)/i;

function recentOwnPane(capture: string): string {
	return capture
		.split("\n")
		.slice(-40)
		.filter((line) => !/^\s*←/.test(line))
		.join("\n");
}

/**
 * Fixture-driven, deliberately narrow classifier. A quota action requires the
 * real Claude cap sentence, an idle input box, and a 100% statusline gauge in
 * the recent live region. Alert echoes, generic 429s and resume menus fail it.
 */
export function classifyQuotaPane(capture: string): QuotaPaneClass {
	const recent = recentOwnPane(capture);
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
	/** Absolute private Lead socket. Absent means the configured Runner socket. */
	socket?: string;
	paneId: string;
	panePid: number;
	sessionName: string;
	windowName: string;
	currentCommand: string;
	dead: boolean;
	qaInjection: boolean;
}

export const MAX_QUOTA_PANES = 64;
export const DEFAULT_QUOTA_PANE_CAPTURE_TIMEOUT_MS = 5_000;
export const DEFAULT_QUOTA_PANE_CAPTURE_CONCURRENCY = 4;

export interface QuotaPaneObservation {
	pane: QuotaPaneRef;
	capture: string | null;
	captureError?: string;
	managed: boolean;
	quotaClass: QuotaPaneClass;
	modelVerdict: ModelCapVerdict;
}

export interface QuotaPaneSnapshot {
	socket: string;
	capturedAt: number;
	listedCount: number;
	observations: QuotaPaneObservation[];
	omittedPanes: QuotaPaneRef[];
	listError?: string;
	complete: boolean;
}

export interface ScanQuotaPanesInput {
	nowMs: number;
	socket: string;
	qaInjectionEnabled: boolean;
	listPanes: () => Promise<QuotaPaneRef[]>;
	capturePane: (paneId: string, socket?: string) => Promise<string>;
	maxPanes?: number;
	captureTimeoutMs?: number;
	captureConcurrency?: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function paneOrder(a: QuotaPaneRef, b: QuotaPaneRef): number {
	const paneDelta = Number(a.paneId.slice(1)) - Number(b.paneId.slice(1));
	return paneDelta || a.panePid - b.panePid;
}

async function captureWithTimeout(
	capture: Promise<string>,
	timeoutMs: number,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`capture timeout after ${timeoutMs}ms`)),
			timeoutMs,
		);
		capture.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * Capture one bounded, immutable fleet view. Every consumer in a monitor tick
 * receives this object; none may independently list/capture panes again.
 */
export async function scanQuotaPanes(
	input: ScanQuotaPanesInput,
): Promise<QuotaPaneSnapshot> {
	const maxPanes = Math.max(
		1,
		Math.min(MAX_QUOTA_PANES, Math.floor(input.maxPanes ?? MAX_QUOTA_PANES)),
	);
	const captureTimeoutMs = Math.max(
		1,
		Math.floor(input.captureTimeoutMs ?? DEFAULT_QUOTA_PANE_CAPTURE_TIMEOUT_MS),
	);
	const captureConcurrency = Math.max(
		1,
		Math.min(
			MAX_QUOTA_PANES,
			Math.floor(
				input.captureConcurrency ?? DEFAULT_QUOTA_PANE_CAPTURE_CONCURRENCY,
			),
		),
	);
	let listed: QuotaPaneRef[];
	try {
		listed = await input.listPanes();
	} catch (error) {
		return {
			socket: input.socket,
			capturedAt: input.nowMs,
			listedCount: 0,
			observations: [],
			omittedPanes: [],
			listError: errorMessage(error),
			complete: false,
		};
	}

	const unique = new Map<string, QuotaPaneRef>();
	for (const pane of listed) {
		const key = `${pane.socket ?? input.socket}:${pane.paneId}:${pane.panePid}`;
		if (!unique.has(key)) unique.set(key, pane);
	}
	const panes = [...unique.values()].sort(paneOrder);
	const selected = panes.slice(0, maxPanes);
	const omittedPanes = panes.slice(maxPanes);
	const observations = new Array<QuotaPaneObservation>(selected.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < selected.length) {
			const index = cursor++;
			const pane = selected[index];
			if (pane === undefined) break;
			try {
				const capture = await captureWithTimeout(
					pane.socket
						? input.capturePane(pane.paneId, pane.socket)
						: input.capturePane(pane.paneId),
					captureTimeoutMs,
				);
				const managed = isManagedClaudePane(
					pane,
					capture,
					input.qaInjectionEnabled,
				);
				observations[index] = {
					pane,
					capture,
					managed,
					quotaClass: managed ? classifyQuotaPane(capture) : "other",
					modelVerdict: managed
						? parseModelCap(recentOwnPane(capture))
						: { state: "clear" },
				};
			} catch (error) {
				observations[index] = {
					pane,
					capture: null,
					captureError: errorMessage(error),
					managed: false,
					quotaClass: "other",
					modelVerdict: { state: "clear" },
				};
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(captureConcurrency, selected.length) },
			worker,
		),
	);
	return {
		socket: input.socket,
		capturedAt: input.nowMs,
		listedCount: panes.length,
		observations,
		omittedPanes,
		complete:
			omittedPanes.length === 0 &&
			observations.every((observation) => observation.capture !== null),
	};
}

/**
 * Prove that a capture belongs to a live Flywheel-managed Claude TUI. Text is
 * never authority on its own: shell panes that cat a fixture or documentation
 * remain ineligible even when they reproduce every quota sentence byte-for-byte.
 * The QA seam is deliberately two-keyed (pane marker + daemon env gate).
 */
export function isManagedClaudePane(
	pane: QuotaPaneRef,
	capture: string,
	qaInjectionEnabled: boolean,
): boolean {
	const privateLeadShape =
		typeof pane.socket === "string" &&
		pane.socket.startsWith("/") &&
		pane.sessionName === "main" &&
		pane.windowName === "main";
	if (
		pane.dead ||
		(!privateLeadShape &&
			(!FLYWHEEL_SESSION.test(pane.sessionName) ||
				!FLYWHEEL_WINDOW.test(pane.windowName)))
	) {
		return false;
	}
	if (
		!CLAUDE_COMMAND.test(pane.currentCommand) &&
		!(qaInjectionEnabled && pane.qaInjection)
	) {
		return false;
	}
	const recent = recentOwnPane(capture);
	return (
		INPUT_BOX.test(recent) &&
		CLAUDE_STATUS.test(recent) &&
		CLAUDE_MODE.test(recent)
	);
}

export interface ReviveScanInput {
	state: QuotaMonitorState;
	nowMs: number;
	socket: string;
	monitorOnly: boolean;
	qaInjectionEnabled: boolean;
	listPanes: () => Promise<QuotaPaneRef[]>;
	capturePane: (paneId: string, socket?: string) => Promise<string>;
	sendContinue: (
		paneId: string,
		socket?: string,
	) => Promise<{ sent: boolean; error?: string }>;
	persistState: (state: QuotaMonitorState) => Promise<void>;
	alert: (alert: QuotaMonitorAlert) => Promise<void>;
	/** Pre-captured fleet view. When present, list/capture seams are not called. */
	snapshot?: QuotaPaneSnapshot;
}

export interface ReviveScanResult {
	state: QuotaMonitorState;
	summary: { revived: number; pending: number; loginExpired: number };
	modelDetections: Array<{ pane: QuotaPaneRef; verdict: ModelCapVerdict }>;
	snapshot: QuotaPaneSnapshot;
}

function paneInstanceKey(socket: string, pane: QuotaPaneRef): string {
	return `${pane.socket ?? socket}:${pane.paneId}:${pane.panePid}`;
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
	const authorized =
		epoch !== null &&
		epoch.generation === state.observedGeneration &&
		!input.monitorOnly;
	const snapshot =
		input.snapshot ??
		(await scanQuotaPanes({
			nowMs: input.nowMs,
			socket: input.socket,
			qaInjectionEnabled: input.qaInjectionEnabled,
			listPanes: input.listPanes,
			capturePane: input.capturePane,
		}));
	if (snapshot.socket !== input.socket) {
		throw new Error("quota pane snapshot socket does not match revive scan");
	}
	const liveQuotaKeys = new Set<string>();
	const unknownReasons = new Map<string, string>();
	const modelDetections: ReviveScanResult["modelDetections"] = [];
	let revived = 0;
	let pending = 0;
	let loginExpired = 0;

	for (const observation of snapshot.observations) {
		const { pane, capture, managed, quotaClass, modelVerdict } = observation;
		if (capture === null || !managed) continue;
		const classification = quotaClass;
		if (modelVerdict.state !== "clear") {
			modelDetections.push({ pane, verdict: modelVerdict });
		}
		if (classification === "login_expired") {
			loginExpired++;
			continue;
		}
		const key = paneInstanceKey(input.socket, pane);
		const epochTrigger = epoch?.trigger ?? { kind: "account" as const };
		const accountActionable =
			epochTrigger.kind === "account" && classification === "quota_stuck";
		const modelMatches =
			epochTrigger.kind === "model" &&
			modelVerdict.state === "capped" &&
			epochTrigger.models.includes(modelVerdict.model);
		const modelUnknown = modelVerdict.state === "unknown";
		if (modelUnknown) {
			if (epochTrigger.kind === "model") liveQuotaKeys.add(key);
			unknownReasons.set(key, modelVerdict.reason);
			await input.alert({
				kind: "model_cap_unknown",
				severity: "warning",
				title: "Claude model cap cannot be safely classified",
				body: `pane=${key}; ${modelVerdict.reason}; no keys sent`,
				signature: `model-cap-unknown-${key}-${Math.floor(input.nowMs / 86_400_000)}`,
			});
			continue;
		}
		if (!accountActionable && !modelMatches) continue;

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

		const sent = pane.socket
			? await input.sendContinue(pane.paneId, pane.socket)
			: await input.sendContinue(pane.paneId);
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

	const previousUnknown = JSON.stringify(state.unknownPanes);
	state.unknownPanes = updateUnknownPaneObservations(
		state.unknownPanes,
		[...unknownReasons.keys()],
		input.nowMs,
	);
	if (JSON.stringify(state.unknownPanes) !== previousUnknown) {
		await input.persistState(state);
	}
	for (const [key, reason] of unknownReasons) {
		if (state.unknownPanes[key]?.count !== MAX_UNKNOWN_PANE_COUNT) continue;
		await input.alert({
			kind: "model_cap_persistent_unknown",
			severity: "warning",
			title: "Claude model cap remained ambiguous across pane scans",
			body: `pane=${key}; consecutive_scans=${MAX_UNKNOWN_PANE_COUNT}; ${reason}; no keys sent`,
			signature: `model-cap-persistent-unknown-${key}-g${state.observedGeneration}`,
		});
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

	return {
		state,
		summary: { revived, pending, loginExpired },
		modelDetections,
		snapshot,
	};
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
	if (socket.startsWith("/")) return ["-S", socket];
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
				[
					...prefix,
					"list-panes",
					"-a",
					"-F",
					"#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}\t#{@flywheel_quota_qa}",
				],
				{ timeout },
			);
			const panes = new Map<string, QuotaPaneRef>();
			for (const line of stdout.split("\n")) {
				if (line.length === 0) continue;
				const [
					paneId,
					pidText,
					sessionName,
					windowName,
					currentCommand,
					deadText,
					qaText = "",
				] = line.replace(/\r$/, "").split("\t");
				const panePid = Number(pidText);
				if (
					!paneId ||
					!/^%\d+$/.test(paneId) ||
					!Number.isInteger(panePid) ||
					panePid <= 0 ||
					!sessionName ||
					!windowName ||
					!currentCommand ||
					(deadText !== "0" && deadText !== "1") ||
					(qaText !== "" && qaText !== "0" && qaText !== "1")
				) {
					continue;
				}
				const key = `${paneId}:${panePid}`;
				if (panes.has(key)) continue;
				panes.set(key, {
					paneId,
					panePid,
					sessionName,
					windowName,
					currentCommand,
					dead: deadText === "1",
					qaInjection: qaText === "1",
				});
			}
			return [...panes.values()];
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

export interface TmuxFleetReviveOptions {
	runnerSocket: string;
	leadSockets: string[];
	execFile?: ExecFileFn;
	timeoutMs?: number;
}

/**
 * One bounded observer over the Runner server plus each private Lead server.
 * An unavailable private socket is an expected restart boundary and does not
 * suppress observations/actions on every other independent server.
 */
export function makeTmuxFleetReviveDeps(opts: TmuxFleetReviveOptions): {
	listPanes: () => Promise<QuotaPaneRef[]>;
	capturePane: (paneId: string, socket?: string) => Promise<string>;
	sendContinue: (
		paneId: string,
		socket?: string,
	) => Promise<{ sent: boolean; error?: string }>;
} {
	const runner = makeTmuxReviveDeps({
		socket: opts.runnerSocket,
		execFile: opts.execFile,
		timeoutMs: opts.timeoutMs,
	});
	const privateDeps = new Map(
		[...new Set(opts.leadSockets)].map((socket) => [
			socket,
			makeTmuxReviveDeps({
				socket,
				execFile: opts.execFile,
				timeoutMs: opts.timeoutMs,
			}),
		]),
	);
	return {
		async listPanes(): Promise<QuotaPaneRef[]> {
			const panes = await runner.listPanes();
			for (const [socket, deps] of privateDeps) {
				try {
					panes.push(
						...(await deps.listPanes()).map((pane) => ({ ...pane, socket })),
					);
				} catch {
					// lead-alert.sh owns private-server absence alerts. The quota
					// observer must not couple unrelated servers during restart.
				}
			}
			return panes;
		},
		capturePane(paneId, socket) {
			if (!socket) return runner.capturePane(paneId);
			const deps = privateDeps.get(socket);
			if (!deps)
				return Promise.reject(new Error("unknown private Lead socket"));
			return deps.capturePane(paneId);
		},
		sendContinue(paneId, socket) {
			if (!socket) return runner.sendContinue(paneId);
			const deps = privateDeps.get(socket);
			if (!deps) {
				return Promise.resolve({
					sent: false,
					error: "unknown private Lead socket",
				});
			}
			return deps.sendContinue(paneId);
		},
	};
}

export interface PrivateLeadSocketDiscoveryOptions {
	stateDir?: string;
	launchAgentsDir?: string;
}

/** Read the v2 launchd roster and accept only exact canonical manifest output. */
export function discoverPrivateLeadSockets(
	opts: PrivateLeadSocketDiscoveryOptions = {},
): string[] {
	const stateDir = opts.stateDir ?? join(homedir(), ".flywheel");
	const launchAgentsDir =
		opts.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
	const wrapper = `${stateDir}/bin/flywheel-lead-wrapper-v2.sh`;
	const sockets = new Set<string>();
	let files: string[];
	try {
		files = readdirSync(launchAgentsDir);
	} catch {
		return [];
	}
	for (const file of files.sort()) {
		const match = /^com\.flywheel\.lead\.([A-Za-z0-9._-]+)\.plist$/.exec(file);
		if (!match) continue;
		const key = match[1];
		try {
			const plist = readFileSync(join(launchAgentsDir, file), "utf8");
			if (!plist.includes(`<string>${wrapper}</string>`)) continue;
			const manifest = JSON.parse(
				readFileSync(join(stateDir, "manifests", `${key}.json`), "utf8"),
			) as Record<string, unknown>;
			const projectName =
				typeof manifest.projectName === "string" ? manifest.projectName : "";
			const leadId = typeof manifest.leadId === "string" ? manifest.leadId : "";
			if (
				!projectName ||
				!leadId ||
				!plist.includes(
					`<string>com.flywheel.lead.${projectName}-${leadId}</string>`,
				)
			) {
				continue;
			}
			const address = leadAddressFromManifest(
				projectName,
				leadId,
				stateDir,
				manifest,
			);
			if (address) sockets.add(address.socketPath);
		} catch {
			// One malformed candidate cannot authorize a socket or suppress the
			// independently valid roster entries.
		}
	}
	return [...sockets].sort();
}
