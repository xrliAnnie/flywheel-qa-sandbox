import {
	engageCodexLeadProactiveTopic,
	probeCodexLeadInboxCapabilities,
	resolveCodexLeadInboxSocketPath,
} from "./codex/CodexLeadInboxSocket.js";
import type { PrepareProactiveEngagement } from "./codex/CodexLeadOutboundHandler.js";
/**
 * FLY-224 Phase 7 block 3a — codexLeadBridgeWiring: the Bridge-side wiring helpers
 * for a Codex Lead, kept OUT of plugin.ts so the logic is unit-tested and the
 * prod-Bridge edit (block 3b) is a thin, byte-compat 2-call wiring.
 *
 * Builds the express handler for `POST /api/lead-outbound/send`
 *      (the apiToken-guarded reserved endpoint), wiring CodexLeadOutboundHandler +
 *      a per-Lead bot-token resolver that mirrors LeadAlertNotifier
 *      (`projects[].leads` by `agentId` → `botToken ?? env[botTokenEnv]`).
 */

import {
	lookupThreadParent,
	type ThreadParentLookup,
} from "../bridge/thread-validator.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type {
	CodexLeadOutboundHandler,
	OutboundSendBody,
} from "./codex/CodexLeadOutboundHandler.js";

/**
 * Resolve a Lead's Discord bot token by leadId (= `LeadConfig.agentId`), mirroring
 * LeadAlertNotifier: the load-time-resolved `botToken`, else `env[botTokenEnv]`.
 * Returns undefined if the lead/token isn't found (the send then fails closed).
 */
export function buildResolveBotToken(
	projects: ProjectEntry[],
	env: NodeJS.ProcessEnv,
): (projectName: string, leadId: string) => string | undefined {
	return (projectName: string, leadId: string) => {
		for (const project of projects) {
			if (project.projectName !== projectName) continue;
			for (const lead of project.leads ?? []) {
				if (lead.agentId !== leadId) continue;
				if (lead.botToken) return lead.botToken;
				if (lead.botTokenEnv) return env[lead.botTokenEnv] || undefined;
				return undefined;
			}
		}
		return undefined;
	};
}

/**
 * Build the anti-impersonation guard (FLY-224 review): `(projectName, leadId,
 * channelId) => allowed`. A Lead may post ONLY to the channels it's configured for —
 * its own `chatChannel`, project core, declared roundtable, and their threads. KEYED BY
 * (projectName, leadId) because `agentId` is NOT globally unique — a reused agentId in
 * another project must not inherit this project's channels. An unknown (project, lead),
 * or a channel it doesn't own, returns false → the handler rejects 403. (Defense-in-
 * depth on the shared apiToken; the full fix is per-Lead auth — FLY-246.)
 */
export interface AuthorizeLeadChannelDeps {
	resolveBotToken: (projectName: string, leadId: string) => string | undefined;
	lookupThreadParent?: (
		channelId: string,
		botToken: string,
	) => Promise<ThreadParentLookup>;
	cache?: Map<string, string>;
}

export type LeadChannelAuthorization = boolean | "unavailable";

export function buildAuthorizeLeadChannel(
	projects: ProjectEntry[],
	deps: AuthorizeLeadChannelDeps,
): (
	projectName: string,
	leadId: string,
	channelId: string,
) => Promise<LeadChannelAuthorization> {
	// key = `${projectName}\0${agentId}` (NUL can't appear in either field).
	const allowed = new Map<string, Set<string>>();
	const parentCache = deps.cache ?? new Map<string, string>();
	const findParent = deps.lookupThreadParent ?? lookupThreadParent;
	const keyOf = (projectName: string, leadId: string) =>
		`${projectName}\0${leadId}`;
	for (const project of projects) {
		for (const lead of project.leads ?? []) {
			const key = keyOf(project.projectName, lead.agentId);
			const set = allowed.get(key) ?? new Set<string>();
			if (lead.chatChannel) set.add(lead.chatChannel);
			if (project.generalChannel) set.add(project.generalChannel);
			if (lead.roundtableChannel) set.add(lead.roundtableChannel);
			allowed.set(key, set);
		}
	}
	return async (projectName, leadId, channelId) => {
		const direct = allowed.get(keyOf(projectName, leadId));
		if (!direct) return false;
		if (direct.has(channelId)) return true;
		const botToken = deps.resolveBotToken(projectName, leadId);
		if (!botToken) return false;
		const cachedParent = parentCache.get(channelId);
		if (cachedParent !== undefined) return direct.has(cachedParent);
		const parent = await findParent(channelId, botToken);
		if (parent.state === "transient") return "unavailable";
		if (parent.state !== "resolved") return false;
		parentCache.set(channelId, parent.parentId);
		return direct.has(parent.parentId);
	};
}

/** Minimal express-ish req/res shapes (avoids a hard express type dep here). */
export interface OutboundReq {
	body?: OutboundSendBody;
	headers: Record<string, string | string[] | undefined>;
}
export interface OutboundRes {
	status(code: number): OutboundRes;
	json(payload: unknown): void;
}

/** Extract the bearer/raw token from an Authorization header. */
function extractToken(headers: OutboundReq["headers"]): string | undefined {
	const h = headers.authorization ?? headers.Authorization;
	const v = Array.isArray(h) ? h[0] : h;
	if (!v) return undefined;
	return v.startsWith("Bearer ") ? v.slice("Bearer ".length) : v;
}

/**
 * Build the express handler for `POST /api/lead-outbound/send`. The route is still
 * mounted behind `tokenAuthMiddleware(config.apiToken)` in plugin.ts; this handler
 * ALSO passes the presented token to CodexLeadOutboundHandler (defense-in-depth,
 * already fail-closed there) and maps the outcome to the HTTP response.
 */
export function buildLeadOutboundExpressHandler(
	handler: CodexLeadOutboundHandler,
	logger?: { info(message: string): void },
): (req: OutboundReq, res: OutboundRes) => Promise<void> {
	return async (req, res) => {
		const body = req.body ?? {};
		const outcome = await handler.handle({
			body,
			providedToken: extractToken(req.headers),
		});
		const auditValue = (value: unknown) =>
			typeof value === "string" && value
				? JSON.stringify(value).slice(1, -1)
				: "-";
		logger?.info(
			`[lead-outbound] project=${auditValue(body.projectName)} lead=${auditValue(body.leadId)} channel=${auditValue(body.channelId)} probe=${body.probe === true ? 1 : 0} status=${outcome.status} reason=${auditValue(outcome.reason)} messageId=${auditValue(outcome.messageId)} idempotencyKey=${auditValue(body.idempotencyKey)}`,
		);
		res.status(outcome.httpStatus).json({
			status: outcome.status,
			...(outcome.engagement
				? {
						sendStatus: outcome.sendStatus,
						engagement: outcome.engagement,
						...(outcome.threadId ? { threadId: outcome.threadId } : {}),
					}
				: {}),
			messageId: outcome.messageId,
			reason: outcome.reason,
		});
	};
}

/** Host registry and authenticated socket authority for proactive roundtable sends. */
export function buildPrepareProactiveEngagement(
	projects: ProjectEntry[],
	deps: {
		resolveBotToken(projectName: string, leadId: string): string | undefined;
		resolveStateDir(
			projectName: string,
			leadId: string,
		): string | Promise<string>;
		probe?: typeof probeCodexLeadInboxCapabilities;
		engage?: typeof engageCodexLeadProactiveTopic;
	},
): PrepareProactiveEngagement {
	return async (identity) => {
		const project = projects.find(
			(p) => p.projectName === identity.projectName,
		);
		const lead = project?.leads.find((l) => l.agentId === identity.leadId);
		if (
			!lead ||
			lead.external === true ||
			!lead.roundtableChannel ||
			lead.roundtableChannel !== identity.channelId
		)
			throw new Error("proactive identity or parent rejected");
		const authSecret = deps.resolveBotToken(
			identity.projectName,
			identity.leadId,
		);
		if (!authSecret) throw new Error("proactive credential unavailable");
		const socketPath = resolveCodexLeadInboxSocketPath(
			await deps.resolveStateDir(identity.projectName, identity.leadId),
		);
		const args = { socketPath, leadId: identity.leadId, authSecret };
		const probe = deps.probe ?? probeCodexLeadInboxCapabilities;
		const current = await probe(args);
		if (
			!current.socketOwnerId ||
			!current.features.includes("roundtable_proactive_engage_v1")
		)
			throw new Error("proactive capability unavailable");
		return async (receipt) => {
			const owner = await probe(args);
			if (
				owner.socketOwnerId !== current.socketOwnerId ||
				!owner.features.includes("roundtable_proactive_engage_v1")
			)
				throw new Error("proactive owner changed");
			const result = await (deps.engage ?? engageCodexLeadProactiveTopic)({
				...args,
				...receipt,
				socketOwnerId: current.socketOwnerId,
				parentChannelId: identity.channelId,
			});
			return result.engagement;
		};
	};
}
