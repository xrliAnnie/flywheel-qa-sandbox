/**
 * FLY-175 Track 2 — wiring helper.
 *
 * Assembles the evaluator + shared context resolver + Surface B router + debug
 * router from the Bridge's existing pieces (StateStore, projects, config). Kept
 * out of plugin.ts so the integration is small and unit-testable.
 *
 * Returns `null` only when `config.founderConsent` is entirely absent. When
 * present-but-off (`decisionMode === "off"`) it returns a wiring with NO
 * evaluator/audit/debug, but STILL a (pass-through) gate router. This is
 * required for byte-compat: the patched `flywheel-comm respond` CLI always
 * routes `approve_to_ship` through the Bridge gate endpoint, so the route must
 * exist (and write the response) even while off — otherwise every production
 * ship would 404 during the default-off Phase 0 rollout (Codex R1 HIGH).
 */

import { type Request, type Response, Router } from "express";
import { AnthropicLLMClient } from "flywheel-claude-runner";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { StateStore } from "../../StateStore.js";
import type { BridgeConfig } from "../types.js";
import {
	type FounderConsentAuditStore,
	openAuditStore,
	redactAuditRow,
} from "./audit.js";
import { ConsentCache } from "./cache.js";
import { FounderConsentEvaluator } from "./evaluator.js";
import {
	createGateResponseRouter,
	type GateResponseRouterDeps,
} from "./gate-response-router.js";
import {
	type ConsentContextResolver,
	founderConsentMiddleware,
	type ResolvedConsentContext,
} from "./middleware.js";
import type { MountKind } from "./reserved-endpoints.js";

const logger = {
	info: (m: string) => console.log(`[founder-consent] ${m}`),
	warn: (m: string) => console.warn(`[founder-consent] ${m}`),
};

export interface FounderConsentWiring {
	/** Undefined when decisionMode=off (evaluator never constructed). */
	evaluator?: FounderConsentEvaluator;
	/** Undefined when decisionMode=off. */
	auditStore?: FounderConsentAuditStore;
	resolveContext: ConsentContextResolver;
	/** Surface A middleware factory (no-op handler when off). */
	middlewareFor: (
		mount: MountKind,
	) => ReturnType<typeof founderConsentMiddleware>;
	/** Surface B router — ALWAYS present (pass-through write when off). */
	gateRouter: Router;
	/** Read-only debug router — undefined when off. */
	debugRouter?: Router;
}

export function buildFounderConsentWiring(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
	overrides?: {
		llm?: ConstructorParameters<typeof FounderConsentEvaluator>[0]["llm"];
		auditStore?: FounderConsentAuditStore;
		fetchImpl?: ConstructorParameters<
			typeof FounderConsentEvaluator
		>[0]["fetchImpl"];
		now?: () => number;
		nowIso?: () => string;
	},
): FounderConsentWiring | null {
	const fc = config.founderConsent;
	if (!fc) return null; // Track 2 not compiled into this config at all.

	const enabled = fc.decisionMode !== "off";
	const configuredProjects = new Set(projects.map((p) => p.projectName));

	// Shared context resolver — needed only when evaluating, but cheap to build.
	const resolveContext: ConsentContextResolver = async (executionId) => {
		if (!executionId) return null;
		const s = store.getSessionForConsentLookup(executionId);
		if (!s) return null;

		const project = projects.find((p) => p.projectName === s.project_name);
		let threadId: string | undefined;
		let channelId: string | undefined;
		let botToken: string | undefined = config.discordBotToken;

		if (project) {
			for (const lead of project.leads) {
				const t = store.getChatThreadByIssue(s.issue_id, lead.chatChannel);
				if (t) {
					threadId = t.thread_id;
					channelId = t.channel_id;
					botToken = lead.botToken ?? config.discordBotToken;
					break;
				}
			}
		}

		const ctx: ResolvedConsentContext = {
			issueId: s.issue_id,
			issueIdentifier: s.issue_identifier,
			projectName: s.project_name,
			executionId,
			sessionRole: s.session_role,
			sessionStatusAtCall: s.session_status,
			issueLabels: s.issue_labels,
			prNumber: s.pr_number,
			prHeadSha: s.pr_head_sha ?? null,
			threadId,
			discordChannelId: channelId,
			botToken,
			// MVP: Bridge does not enumerate per-lead Discord bot user ids, so
			// lead/runner role hints are best-effort. The security property is
			// preserved regardless: only `founder`-role messages (author ==
			// FOUNDER_USER_ID) can ever serve as authorization evidence.
			leadBotIds: new Set<string>(),
			runnerBotIds: new Set<string>(),
		};
		return ctx;
	};

	const getSessionProject = (executionId: string) => {
		const sess = store.getSession(executionId);
		return sess ? { project_name: sess.project_name } : undefined;
	};

	// ── Off: pass-through gate router only, no evaluator/audit/debug ──
	if (!enabled) {
		const gateDeps: GateResponseRouterDeps = {
			evaluator: undefined,
			resolveContext,
			getSessionProject,
			configuredProjects,
			logger,
		};
		return {
			resolveContext,
			middlewareFor: () => (_q, _s, next) => next(),
			gateRouter: createGateResponseRouter(gateDeps),
		};
	}

	// ── Enabled (audit_only | enforce) ──
	const auditStore = overrides?.auditStore ?? openAuditStore(fc.auditDbPath);
	const llm = overrides?.llm ?? new AnthropicLLMClient();
	const cache = new ConsentCache(fc.cacheTtlSecs);

	const evaluator = new FounderConsentEvaluator({
		config: fc,
		llm,
		audit: auditStore,
		cache,
		fetchImpl: overrides?.fetchImpl,
		now: overrides?.now,
		nowIso: overrides?.nowIso,
		logger,
	});

	const debugRouter = Router();
	debugRouter.get("/", (req: Request, res: Response) => {
		const issue =
			typeof req.query.issue === "string" ? req.query.issue : undefined;
		const reqLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
		const limit = Math.min(
			Number.isNaN(reqLimit) ? fc.debugEndpointMaxLimit : reqLimit,
			fc.debugEndpointMaxLimit,
		);
		const rows = issue
			? auditStore.queryByIssue(issue, limit)
			: auditStore.queryRecent(limit);
		res.json({
			rows: rows.map(redactAuditRow),
			limit,
			decisionMode: fc.decisionMode,
		});
	});

	const gateDeps: GateResponseRouterDeps = {
		evaluator,
		resolveContext,
		getSessionProject,
		configuredProjects,
		logger,
	};

	return {
		evaluator,
		auditStore,
		resolveContext,
		middlewareFor: (mount) =>
			founderConsentMiddleware(mount, { evaluator, resolveContext, logger }),
		gateRouter: createGateResponseRouter(gateDeps),
		debugRouter,
	};
}
