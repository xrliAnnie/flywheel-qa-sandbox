/**
 * FLY-2882 — roster → carrier → read → DTO. Every registered Lead gets an
 * answer; a reader crash becomes `unknown/read_failed` for that Lead only.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { type ExecFn, readV2LeadClaudePid } from "../../LeadWindowLocator.js";
import {
	probeCodexLeadInboxCapabilities,
	readCodexLeadTurnState,
	resolveCodexLeadInboxSocketPath,
} from "../../lead-backends/codex/CodexLeadInboxSocket.js";
import { buildResolveBotToken } from "../../lead-backends/codexLeadBridgeWiring.js";
import { effectiveLeadBackend } from "../../lead-backends/lead-backend.js";
import type { LeadConfig, ProjectEntry } from "../../ProjectConfig.js";
import type { StateStore } from "../../StateStore.js";
import { resolveCommDbPath } from "../commdb-session-prune.js";
import {
	type ConfiguredLeadWindowLocatorOptions,
	LEAD_LAUNCHD_REGISTRY_ENV,
	locateConfiguredLeadWindow,
} from "../fleet-lead-locator.js";
import { defaultLeadPaneCapture } from "../lead-alert-helpers.js";
import { resolveCodexLeadStateDir } from "../lead-inbox-runtime.js";
import { readClaudeLeadActivity } from "./claude-lead-activity.js";
import { readCodexLeadActivity } from "./codex-lead-activity.js";
import { attributeCodexTurnTrigger } from "./turn-trigger-attribution.js";
import {
	buildLeadActivity,
	LEAD_ACTIVITY_FLEET_SCHEMA,
	type LeadActivityCarrier,
	type LeadActivityFleetV1,
	type LeadActivityReading,
	type LeadActivityV1,
} from "./types.js";

/**
 * Budget (design-correction A1): every Lead's whole read chain is cut at
 * `LEAD_READ_DEADLINE_MS` (→ unknown/read_timed_out); the fleet runs
 * `FLEET_CONCURRENCY` reads at once, so 17 Leads cost at most ⌈17/6⌉×8s = 24s.
 * CLI timeouts sit above both (single 15s, --all 45s).
 */
export const FLEET_CONCURRENCY = 6;
export const LEAD_READ_DEADLINE_MS = 8_000;

type CarrierRead = (
	projectName: string,
	leadId: string,
) => Promise<{ reading: LeadActivityReading; observedAtMs: number }>;

export interface LeadActivityServiceDeps {
	projects(): ProjectEntry[];
	readClaude: CarrierRead;
	readCodex: CarrierRead;
	now(): number;
	log?(message: string): void;
	/** Bridge-wide legacy backend (`FLYWHEEL_LEAD_BACKEND`), as the delivery adapter reads it. */
	legacyBackend?(): string | undefined;
	deadlineMs?: number;
}

function carrierOf(
	lead: LeadConfig,
	legacy: string | undefined,
): LeadActivityCarrier | undefined {
	const explicit = lead.backend as unknown;
	if (
		explicit !== undefined &&
		explicit !== "claude-code" &&
		explicit !== "codex-app-server"
	)
		return undefined;
	return effectiveLeadBackend(lead.backend, legacy).backend;
}

export class LeadActivityService {
	constructor(readonly deps: LeadActivityServiceDeps) {}

	async read(
		projectName: string,
		leadId: string,
	): Promise<LeadActivityV1 | undefined> {
		const lead = this.deps
			.projects()
			.find((project) => project.projectName === projectName)
			?.leads.find((row) => row.agentId === leadId);
		return lead ? this.readLead(projectName, lead) : undefined;
	}

	async readFleet(): Promise<LeadActivityFleetV1> {
		const targets = this.deps.projects().flatMap((project) =>
			project.leads.map((lead) => ({
				projectName: project.projectName,
				lead,
			})),
		);
		const leads: LeadActivityV1[] = new Array(targets.length);
		let next = 0;
		const worker = async () => {
			while (next < targets.length) {
				const index = next++;
				const target = targets[index]!;
				leads[index] = await this.readLead(target.projectName, target.lead);
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(FLEET_CONCURRENCY, targets.length) },
				worker,
			),
		);
		return {
			schema: LEAD_ACTIVITY_FLEET_SCHEMA,
			observedAt: new Date(this.deps.now()).toISOString(),
			leads,
		};
	}

	private async readLead(
		projectName: string,
		lead: LeadConfig,
	): Promise<LeadActivityV1> {
		const carrier = carrierOf(lead, this.deps.legacyBackend?.());
		const build = (
			reading: LeadActivityReading,
			observedAtMs: number,
			as: LeadActivityCarrier = carrier ?? "claude-code",
		) =>
			buildLeadActivity({
				projectName,
				leadId: lead.agentId,
				carrier: as,
				observedAtMs,
				reading,
			});
		if (!carrier)
			return build(
				{ state: "unknown", reason: "carrier_unsupported" },
				this.deps.now(),
			);
		const read =
			carrier === "codex-app-server"
				? this.deps.readCodex
				: this.deps.readClaude;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				read(projectName, lead.agentId),
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(
						() => resolve("timeout"),
						this.deps.deadlineMs ?? LEAD_READ_DEADLINE_MS,
					);
				}),
			]);
			if (result === "timeout")
				return build(
					{ state: "unknown", reason: "read_timed_out" },
					this.deps.now(),
				);
			return build(result.reading, result.observedAtMs);
		} catch {
			this.deps.log?.("[lead-activity] read_failed");
			return build(
				{ state: "unknown", reason: "read_failed" },
				this.deps.now(),
			);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

/**
 * Where this Bridge finds its Claude Leads' launchd authority: the production
 * LaunchAgents directory, or — when the Bridge config names one — its own
 * launchd registry (a 529 room's `launchd-leads.json`). A blank value is not
 * a registry; an invalid one fails closed inside the locator.
 */
export function claudeLeadLocatorOptions(
	env: NodeJS.ProcessEnv,
	stateDir: string,
): Omit<ConfiguredLeadWindowLocatorOptions, "execFn"> {
	const registry = env[LEAD_LAUNCHD_REGISTRY_ENV]?.trim();
	return {
		homeDir: homedir(),
		stateDir,
		readFile: (path) => readFileSync(path, "utf8"),
		...(registry ? { launchdRegistryPath: registry } : {}),
	};
}

const execFileAsync = promisify(execFile);

/**
 * QA@2 (claim 1599): every tmux read behind this service passes `-u`. A
 * launchd Bridge inherits no TMUX and no LANG/LC_*, so its tmux client is not
 * UTF-8 and tmux rewrites each tab and non-ASCII byte of command output to
 * `_`: the tab-separated `list-panes -F` rows stop parsing and every Claude
 * Lead reads as `lead_window_unavailable`. `-u` declares the client UTF-8
 * whatever it inherits. Other commands (`ps`) pass through unchanged.
 */
export const utf8TmuxExec: ExecFn = (file, args, options) =>
	execFileAsync(file, file === "tmux" ? ["-u", ...args] : [...args], {
		encoding: "utf8",
		...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
	});

/** Production wiring: live pane capture, sidecar socket, read-only CommDB. */
export function createProductionLeadActivityService(args: {
	projects: ProjectEntry[];
	store: Pick<StateStore, "getLeadEventSessionKeyBySeq">;
	env?: NodeJS.ProcessEnv;
}): LeadActivityService {
	const env = args.env ?? process.env;
	const stateDir =
		env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	// Its identity probe and capture-pane both go through `utf8TmuxExec`.
	const capture = defaultLeadPaneCapture(
		undefined,
		utf8TmuxExec as unknown as Parameters<typeof defaultLeadPaneCapture>[1],
	);
	const resolveBotToken = buildResolveBotToken(args.projects, env);
	const log = (message: string) => console.warn(message);
	const locatorOptions = {
		...claudeLeadLocatorOptions(env, stateDir),
		execFn: utf8TmuxExec,
	};
	return new LeadActivityService({
		projects: () => args.projects,
		now: Date.now,
		log,
		legacyBackend: () => env.FLYWHEEL_LEAD_BACKEND,
		readClaude: (projectName, leadId) =>
			readClaudeLeadActivity(projectName, leadId, {
				locate: (p, l) => locateConfiguredLeadWindow(p, l, locatorOptions),
				capture,
				claudeProcess: (window) => readV2LeadClaudePid(window, utf8TmuxExec),
				now: Date.now,
			}),
		readCodex: (projectName, leadId) =>
			readCodexLeadActivity(projectName, leadId, {
				resolveSocketPath: async (p, l) =>
					resolveCodexLeadInboxSocketPath(resolveCodexLeadStateDir(p, l)),
				// Same secret precedence as the delivery adapter that talks to this socket.
				resolveAuthSecret: (p, l) =>
					resolveBotToken(p, l) ?? env.DISCORD_BOT_TOKEN,
				probeCapabilities: probeCodexLeadInboxCapabilities,
				readTurnState: readCodexLeadTurnState,
				attribute: (p, l, deliveryIds) =>
					attributeCodexTurnTrigger(
						{ projectName: p, leadId: l, deliveryIds },
						{
							openCommDb: (project) => {
								const path = resolveCommDbPath(project);
								return path
									? new Database(path, { readonly: true, fileMustExist: true })
									: undefined;
							},
							getLeadEventSessionKeyBySeq: (seq) =>
								args.store.getLeadEventSessionKeyBySeq(seq),
							log: (reason) => log(`[lead-activity] ${reason}`),
						},
					),
				now: Date.now,
			}),
	});
}
