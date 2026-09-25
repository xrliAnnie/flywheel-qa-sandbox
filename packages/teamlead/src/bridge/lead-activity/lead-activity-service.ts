/**
 * FLY-2882 — roster → carrier → read → DTO. Every registered Lead gets an
 * answer; a reader crash becomes `unknown/read_failed` for that Lead only.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
	probeCodexLeadInboxCapabilities,
	readCodexLeadTurnState,
	resolveCodexLeadInboxSocketPath,
} from "../../lead-backends/codex/CodexLeadInboxSocket.js";
import { buildResolveBotToken } from "../../lead-backends/codexLeadBridgeWiring.js";
import type { LeadConfig, ProjectEntry } from "../../ProjectConfig.js";
import type { StateStore } from "../../StateStore.js";
import { resolveCommDbPath } from "../commdb-session-prune.js";
import { locateConfiguredLeadWindow } from "../fleet-lead-locator.js";
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

export const FLEET_CONCURRENCY = 4;

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
}

function carrierOf(lead: LeadConfig): LeadActivityCarrier | undefined {
	const backend = lead.backend as unknown;
	if (backend === undefined || backend === "claude-code") return "claude-code";
	if (backend === "codex-app-server") return "codex-app-server";
	return undefined;
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
		const carrier = carrierOf(lead);
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
		try {
			const read =
				carrier === "codex-app-server"
					? this.deps.readCodex
					: this.deps.readClaude;
			const { reading, observedAtMs } = await read(projectName, lead.agentId);
			return build(reading, observedAtMs);
		} catch {
			this.deps.log?.("[lead-activity] read_failed");
			return build(
				{ state: "unknown", reason: "read_failed" },
				this.deps.now(),
			);
		}
	}
}

/** Production wiring: live pane capture, sidecar socket, read-only CommDB. */
export function createProductionLeadActivityService(args: {
	projects: ProjectEntry[];
	store: Pick<StateStore, "getLeadEventSessionKeyBySeq">;
	env?: NodeJS.ProcessEnv;
}): LeadActivityService {
	const env = args.env ?? process.env;
	const stateDir =
		env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	const capture = defaultLeadPaneCapture();
	const resolveBotToken = buildResolveBotToken(args.projects, env);
	const log = (message: string) => console.warn(message);
	return new LeadActivityService({
		projects: () => args.projects,
		now: Date.now,
		log,
		readClaude: (projectName, leadId) =>
			readClaudeLeadActivity(projectName, leadId, {
				locate: (p, l) =>
					locateConfiguredLeadWindow(p, l, {
						homeDir: homedir(),
						stateDir,
						readFile: (path) => readFileSync(path, "utf8"),
					}),
				capture,
				now: Date.now,
			}),
		readCodex: (projectName, leadId) =>
			readCodexLeadActivity(projectName, leadId, {
				resolveSocketPath: async (p, l) =>
					resolveCodexLeadInboxSocketPath(resolveCodexLeadStateDir(p, l)),
				resolveAuthSecret: resolveBotToken,
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
