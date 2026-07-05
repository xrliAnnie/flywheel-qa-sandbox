/**
 * FLY-368 rework: owner-attributed alert bot-token chains.
 *
 * The Bridge holds every lead's `*_BOT_TOKEN` in its env, so it can POST an alert
 * as the STUCK agent's OWN bot (correct attribution) even when that agent's
 * process is dead — the token is just a credential. This module builds the
 * ordered candidate chains and resolves the first usable token.
 *
 * Chains (env-name lists, de-duped, priority-preserving):
 *  - SEND  (alert about lead L): [ ...ownBotEnvs(L), repairBotEnv, ...allLeadsAlpha ]
 *  - REPAIR (Cass-owned thread):  [ repairBotEnv, ...allLeadsAlpha ]
 *
 * `allLeadsAlpha` = every configured lead's bot env, sorted by agentId fleet-wide
 * (deterministic). Own-bot = `botTokenEnv` first, then `alertBotTokenEnv` as a
 * legacy-compat candidate (Codex R1 LOW-4); a lead's inline `botToken` is the
 * hydrated value of `botTokenEnv`, so env-name resolution already covers it.
 */

import type { ProjectEntry } from "../ProjectConfig.js";

export interface BotCandidate {
	tokenEnv: string;
	token: string;
}

/** The own-bot env candidates for a lead, in attribution priority. */
export function ownBotEnvCandidates(lead: {
	botTokenEnv?: string;
	alertBotTokenEnv?: string;
}): string[] {
	const out: string[] = [];
	if (lead.botTokenEnv) out.push(lead.botTokenEnv);
	// Legacy-compat: a lead configured only the alert-token way still attributes
	// to itself rather than falling straight to Cass.
	if (lead.alertBotTokenEnv && lead.alertBotTokenEnv !== lead.botTokenEnv) {
		out.push(lead.alertBotTokenEnv);
	}
	return out;
}

/** Every configured lead's bot env, sorted by agentId (fleet-wide, deterministic). */
export function allLeadsAlphaEnvs(projects: ProjectEntry[]): string[] {
	const leads = projects
		.flatMap((p) => p.leads)
		.slice()
		.sort((a, b) => a.agentId.localeCompare(b.agentId));
	const out: string[] = [];
	for (const lead of leads) {
		for (const env of ownBotEnvCandidates(lead)) out.push(env);
	}
	return out;
}

/** De-dup preserving first occurrence (priority order). */
function dedup(envNames: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const e of envNames) {
		if (e && !seen.has(e)) {
			seen.add(e);
			out.push(e);
		}
	}
	return out;
}

/** Find the lead matching leadId across all projects (first match). */
function findLead(
	projects: ProjectEntry[],
	leadId: string,
): { botTokenEnv?: string; alertBotTokenEnv?: string } | undefined {
	for (const p of projects) {
		const lead = p.leads.find((l) => l.agentId === leadId);
		if (lead) return lead;
	}
	return undefined;
}

/**
 * SEND chain for an alert about `leadId`: own bot → repair bot (Cass) →
 * alphabetical fleet. If `leadId` is unknown (e.g. a stale config), the chain
 * still degrades to repair → alpha.
 */
export function buildSendChain(
	projects: ProjectEntry[],
	leadId: string,
	repairBotEnv: string,
): string[] {
	const lead = findLead(projects, leadId);
	return dedup([
		...(lead ? ownBotEnvCandidates(lead) : []),
		repairBotEnv,
		...allLeadsAlphaEnvs(projects),
	]);
}

/** REPAIR chain (Cass-owned thread ops): repair bot → alphabetical fleet. */
export function buildRepairChain(
	projects: ProjectEntry[],
	repairBotEnv: string,
): string[] {
	return dedup([repairBotEnv, ...allLeadsAlphaEnvs(projects)]);
}

/**
 * Resolve the first env name in `envNames` whose value is a non-empty string.
 * Returns the explicit {tokenEnv, token} (Codex R2 LOW — explicit candidate, no
 * env-name/value ambiguity) or null if none resolve.
 */
export function resolveFirstAvailableBotToken(
	envNames: string[],
	env: NodeJS.ProcessEnv = process.env,
): BotCandidate | null {
	for (const tokenEnv of envNames) {
		const token = env[tokenEnv];
		if (token) return { tokenEnv, token };
	}
	return null;
}
