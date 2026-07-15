/**
 * FLY-598: founder-facing UX gate — Bridge HTTP routes (credential split).
 *
 * Two routes with DELIBERATELY DIFFERENT credentials (Codex R2-#1 / R3-#1):
 *
 *  - GET  /api/founder-ux/status   — READ. Authed with the RUNNER's ingest token.
 *    MUST be mounted BEFORE the broad `app.use("/api", tokenAuthMiddleware(
 *    apiToken), ...)` so an ingest-token request is not rejected by the broad
 *    api-token middleware first.
 *  - POST /api/founder-ux/signoff  — PRIVILEGED WRITE. Requires the apiToken
 *    (Lead-only). Fail-closed (503) when apiToken is unset; never satisfiable by
 *    the Runner's ingest token (the two are validated distinct at startup).
 *
 * The write path triggers the crown-jewel server-side founder verification
 * (verify.ts). The read path returns {approved} iff a verified sign-off bound to
 * the queried uxHash exists.
 */

import type { Express, RequestHandler } from "express";
import { isFounderUxGateEnabled } from "flywheel-config";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { StateStore } from "../../StateStore.js";
import { signoffSatisfies } from "./signoff.js";
import {
	type FounderUxVerifyDeps,
	verifyAndRecordFounderUxSignoff,
} from "./verify.js";

export interface FounderUxRouteDeps {
	store: StateStore;
	projects: ProjectEntry[];
	/** Founder Discord id (config.founderConsent?.founderUserId). */
	founderUserId: string;
	/** Runner ingest token — gates the read-only status route. */
	ingestToken?: string;
	/** Privileged api token — gates the signoff write route. */
	apiToken?: string;
	/** Default bot token when a lead has none. */
	discordBotToken?: string;
	/** Test overrides. */
	fetchImpl?: FounderUxVerifyDeps["fetchImpl"];
	now?: () => number;
	windowMs?: number;
}

/** Resolve the issue thread + bot token for a run (mirrors founder-consent wiring). */
function buildResolveThread(
	store: StateStore,
	projects: ProjectEntry[],
	discordBotToken?: string,
): FounderUxVerifyDeps["resolveThread"] {
	return (executionId: string) => {
		const s = store.getSessionForConsentLookup(executionId);
		if (!s) return null;
		const project = projects.find((p) => p.projectName === s.project_name);
		if (!project) return null;
		for (const lead of project.leads) {
			const t = store.getChatThreadByIssue(s.issue_id, lead.chatChannel);
			if (t) {
				const botToken = lead.botToken ?? discordBotToken;
				if (!botToken) return null;
				return { threadId: t.thread_id, botToken };
			}
		}
		return null;
	};
}

/** Bearer-equality auth (mirrors plugin tokenAuthMiddleware) for a specific token. */
function requireBearer(token: string): RequestHandler {
	return (req, res, next) => {
		const header = req.headers.authorization ?? "";
		const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
		if (!token || provided !== token) {
			res.status(401).json({ error: "unauthorized" });
			return;
		}
		next();
	};
}

/**
 * Register both founder-ux routes on `app`. MUST be called BEFORE the broad
 * `/api` token middleware is mounted (so the ingest-token status read is not
 * shadowed by the api-token middleware).
 */
export function mountFounderUxRoutes(
	app: Express,
	deps: FounderUxRouteDeps,
): void {
	const resolveThread = buildResolveThread(
		deps.store,
		deps.projects,
		deps.discordBotToken,
	);

	// ── READ: GET /api/founder-ux/status (ingest-token) ──
	// ALWAYS require the ingest bearer — never fail-open. When ingestToken is
	// unset, requireBearer("") rejects every request (401), so a token-less
	// Bridge makes the Runner's await fail-closed (block) rather than exposing
	// the gate state unauthenticated. The privileged WRITE is independently
	// fail-closed below.
	app.get(
		"/api/founder-ux/status",
		requireBearer(deps.ingestToken ?? ""),
		(req, res) => {
			const execId =
				typeof req.query.execId === "string" ? req.query.execId : "";
			const uxHash =
				typeof req.query.uxHash === "string" ? req.query.uxHash : "";
			if (!execId || !uxHash) {
				res
					.status(400)
					.json({ approved: false, error: "execId + uxHash required" });
				return;
			}
			// FLY-900: gate retired fleet-wide by default. When the kill-switch is
			// not explicitly re-enabled, the await-founder-ux-gate poll gets an
			// immediate `approved: true` — it never blocks implement on a sign-off
			// (this also unblocks any stale session still polling this route). auth +
			// param validation above stay unchanged.
			if (!isFounderUxGateEnabled()) {
				res.json({ approved: true });
				return;
			}
			res.json({ approved: signoffSatisfies(deps.store, execId, uxHash) });
		},
	);

	// ── PRIVILEGED WRITE: POST /api/founder-ux/signoff (api-token, fail-closed) ──
	// Codex R2-#1 + R3-#2: the write requires the apiToken AND that apiToken be
	// DISTINCT from the ingest token — otherwise "reject the Runner's ingest
	// token" is only a variable-name distinction, since auth is bearer-equality.
	const tokensCollide =
		!!deps.apiToken && !!deps.ingestToken && deps.apiToken === deps.ingestToken;
	const signoffAuth: RequestHandler = !deps.apiToken
		? (_req, res) => {
				res.status(503).json({
					error:
						"founder-ux signoff route disabled: TEAMLEAD_API_TOKEN not configured",
				});
			}
		: tokensCollide
			? (_req, res) => {
					res.status(503).json({
						error:
							"founder-ux signoff route disabled: TEAMLEAD_API_TOKEN and ingest token must be distinct",
					});
				}
			: requireBearer(deps.apiToken);
	app.post("/api/founder-ux/signoff", signoffAuth, async (req, res) => {
		const body = (req.body ?? {}) as {
			execution_id?: string;
			ux_hash?: string;
			annie_msg_id?: string;
		};
		if (!body.execution_id || !body.ux_hash || !body.annie_msg_id) {
			res.status(400).json({
				error: "execution_id, ux_hash, annie_msg_id required",
			});
			return;
		}
		const result = await verifyAndRecordFounderUxSignoff(
			{
				store: deps.store,
				resolveThread,
				founderUserId: deps.founderUserId,
				fetchImpl: deps.fetchImpl,
				now: deps.now,
				windowMs: deps.windowMs,
			},
			{
				executionId: body.execution_id,
				uxHash: body.ux_hash,
				annieMsgId: body.annie_msg_id,
			},
		);
		if (result.ok) {
			res.json({ recorded: true, auditId: result.auditId });
			return;
		}
		res.status(result.status).json({ recorded: false, reason: result.reason });
	});
}
