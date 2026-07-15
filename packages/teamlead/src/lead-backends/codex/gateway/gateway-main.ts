/**
 * FLY-245 F-a — the Flywheel Lead gateway entrypoint: the ONLY out-of-sandbox
 * action channel a write-capable Codex Lead has (plan §4).
 *
 * A stdio MCP server (app-server child, OUTSIDE the exec sandbox), spawned from
 * the TRUSTED teamlead dist (an absolute path outside the model's
 * writableRoots — enforced by resolveLeadWorkspace's overlap checks). It is a
 * SECRETLESS shim at spawn time: action secrets (Discord bot token, Bridge API
 * token) are fetched at startup over the parent runtime's unix-socket broker
 * (Phase E) and live only in this process's memory.
 *
 * Tool surface (245): `request_runner_lifecycle` (founder-gated lifecycle
 * request — execution happens strictly behind the founder-confirmation edge in
 * LifecycleOrchestrator) and `relay_ship_decision` (merge/ship founder
 * preflight; the durable relay transport is FLY-251). Non-reserved tools
 * (start_runner / send / ask / read_tmux) are FLY-251.
 *
 * Split for testability (same discipline as codex-lead-runtime.ts):
 *   - `parseGatewayConfig` / `mapHttpDispatchOutcome` / `resolveLifecycleTarget`
 *     are pure-ish and unit-tested;
 *   - `gatewayMain` is assembly glue — validated by the Phase F real-machine
 *     threat-matrix QA, not unit tests.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	realpathSync as nodeRealpathSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { verifyApproval } from "flywheel-comm/verify-approval";
import { verifyLifecycleConsent } from "flywheel-comm/verify-lifecycle-consent";
import { markAutomatedDiscordText } from "../../../bridge/automated-message.js";
import {
	getActionClassMeta,
	isLifecycleAction,
} from "../../../bridge/founder-consent/reserved-endpoints.js";
import { matchesLead } from "../../../bridge/lead-scope.js";
import { checkStartedEvidence } from "../../../bridge/started-evidence.js";
import {
	isTmuxWindowAlive,
	lookupTmuxTarget,
} from "../../../bridge/tmux-lookup.js";
import { loadProjects } from "../../../ProjectConfig.js";
import type { Session } from "../../../StateStore.js";
import { CodexFounderPreflight } from "../CodexFounderPreflight.js";
import { runDiscordSend } from "../discord-send-core.js";
import { parseExplicitAliases } from "../lead-actions/alias-allowlist.js";
import {
	SendIdempotencyCache,
	SlidingWindowRateLimiter,
} from "../lead-actions/send-guard.js";
import { fetchSecretsFromBroker } from "../secret-broker.js";
import {
	checkReactionConfirmation,
	encodeReactionEmoji,
	FOUNDER_CONFIRM_EMOJI,
	type TokenConfirmationMessage,
} from "./founder-confirmation.js";
import {
	buildPushAuditRow,
	buildRemoteUrl,
	deriveBranchName,
	makeGitPushExec,
	materializeAndPush,
	openPullRequest,
	parseOwnerRepo,
	probeGitHubToken,
	readModelHeadSha,
} from "./GitPushRunner.js";
import {
	LifecycleOrchestrator,
	type ResolvedLifecycleTarget,
} from "./lifecycle-orchestrator.js";
import {
	type DispatchOutcome,
	type LifecycleRequestRecord,
	LifecycleRequestStore,
	makePostconditionCheck,
} from "./lifecycle-requests.js";
import { AmbiguousTargetError, resolveExactlyOne } from "./resolve-target.js";
import { makeRetryDispatchPostcondition } from "./retry-dispatch.js";
import {
	canonicalizeTargetWorktree,
	deriveTargetPrHead,
	type GitRunner,
	makeTrustedGitRunner,
	resolveTrustedGitPath,
} from "./ship-preflight.js";

// ── Config (pure, fail-loud) ─────────────────────────────────────────────────

export interface GatewayConfig {
	leadId: string;
	projectName: string;
	founderId: string;
	stateDir: string;
	brokerSocketPath: string;
	confirmChannelId: string;
	bridgeUrl: string;
	commDbPath: string;
	stateDbPath: string;
	/** Founder-confirmation window (default 30 min). */
	confirmTtlMs: number;
	/** Observation poll interval (default 5s). */
	pollIntervalMs: number;
	// ── FLY-350 (Z) unit 3: discord_send channel coordinates ──────────────────
	// The SAME contract as the lead-actions MCP (one alias→channel allowlist
	// across both proactive-send paths). OPTIONAL (byte-compat with the FLY-245
	// gateway that had no discord_send) — absent → empty, and `resolveChannelAlias`
	// fails CLOSED at call time (the model can never send to an unconfigured alias).
	/** The Lead's own chat channel id (alias "chat"). */
	chatChannelId: string;
	/** Configured cross-department channel ids (alias "roundtable" when exactly one). */
	crossDeptChannelIds: string[];
	/** Explicit alias→channelId pins (disambiguate multi/zero roundtable). */
	explicitAliases: Record<string, string>;
	/** Per-channel proactive-send cap per window (FLY-220 loop-safety). */
	sendRateMaxPerWindow: number;
	/** Proactive-send rate-limit window length (ms). */
	sendRateWindowMs: number;
	/** Idempotency TTL (ms) — a repeat (channel, text) within this collapses. */
	sendIdempotencyTtlMs: number;
	/** FLY-676 — EFFECTIVE roundtable autoContinue (runtime-computed; NOT raw env). When
	 * true, a proactive `target="roundtable"` send is fail-soft refused (FLY-680). Default
	 * false (byte-compat with the FLY-245 gateway that had no roundtable awareness). */
	roundtableAutoContinue: boolean;
	// ── FLY-350 (Z) unit 4: gateway-proxied PR scope ──────────────────────────
	/** The project's GitHub repo slug ("owner/repo") — scopes git_push/open_pr.
	 * OPTIONAL (absent → git_push/open_pr fail closed at call time). The GH_TOKEN
	 * itself is a broker secret, NEVER config/env. */
	projectRepo: string;
}

/** Parse + validate the gateway env. Fail-loud: lists ALL missing vars. */
export function parseGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
	const missing: string[] = [];
	const req = (name: string): string => {
		const v = env[name]?.trim();
		if (!v) missing.push(name);
		return v ?? "";
	};
	const leadId = req("FLYWHEEL_LEAD_ID");
	const projectName = req("FLYWHEEL_PROJECT_NAME");
	const founderId = req("FLYWHEEL_FOUNDER_DISCORD_USER_ID");
	const stateDir = req("FLYWHEEL_GATEWAY_STATE_DIR");
	const brokerSocketPath = req("FLYWHEEL_GATEWAY_BROKER_SOCKET");
	const confirmChannelId = req("FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID");
	const bridgeUrl = req("FLYWHEEL_BRIDGE_URL");
	if (missing.length > 0) {
		throw new Error(`gateway: missing required env: ${missing.join(", ")}`);
	}
	if (/[/\\]|\.\./.test(projectName)) {
		throw new Error(`gateway: invalid project name "${projectName}"`);
	}
	const commRoot =
		env.FLYWHEEL_COMM_ROOT?.trim() || join(env.HOME ?? "", ".flywheel", "comm");
	const ttlRaw = Number(env.FLYWHEEL_GATEWAY_CONFIRM_TTL_MS);
	const pollRaw = Number(env.FLYWHEEL_GATEWAY_POLL_INTERVAL_MS);
	// FLY-350 (Z) unit 3: discord_send coords — OPTIONAL (byte-compat), same env
	// var names + parser as the lead-actions MCP (one alias contract).
	const crossDeptChannelIds = (env.FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const posInt = (raw: string | undefined, fallback: number): number => {
		const n = Number(raw);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	};
	return {
		leadId,
		projectName,
		founderId,
		stateDir,
		brokerSocketPath,
		confirmChannelId,
		bridgeUrl: bridgeUrl.replace(/\/+$/, ""),
		commDbPath:
			env.FLYWHEEL_GATEWAY_COMM_DB?.trim() ||
			join(commRoot, projectName, "comm.db"),
		stateDbPath:
			env.FLYWHEEL_GATEWAY_STATE_DB?.trim() ||
			join(env.HOME ?? "", ".flywheel", "state", "teamlead.db"),
		confirmTtlMs:
			Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : 30 * 60 * 1000,
		pollIntervalMs: Number.isFinite(pollRaw) && pollRaw > 0 ? pollRaw : 5000,
		chatChannelId: env.FLYWHEEL_LEAD_CHAT_CHANNEL_ID?.trim() ?? "",
		crossDeptChannelIds,
		explicitAliases: parseExplicitAliases(
			env.FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES,
		),
		sendRateMaxPerWindow: posInt(env.FLYWHEEL_LEAD_ACTIONS_RATE_MAX, 5),
		sendRateWindowMs: posInt(env.FLYWHEEL_LEAD_ACTIONS_RATE_WINDOW_MS, 60_000),
		sendIdempotencyTtlMs: posInt(
			env.FLYWHEEL_LEAD_ACTIONS_IDEMPOTENCY_TTL_MS,
			60_000,
		),
		projectRepo: env.FLYWHEEL_GATEWAY_PROJECT_REPO?.trim() ?? "",
		// FLY-676: runtime-computed effective flag (NOT raw THREAD_AUTOCONTINUE). Default
		// false when absent → no proactive-roundtable refusal (byte-compat).
		roundtableAutoContinue:
			env.FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE === "1",
	};
}

// ── HTTP dispatch outcome mapping (pure) ─────────────────────────────────────

/**
 * Map an HTTP dispatch attempt to the D-f DispatchOutcome classes (Codex
 * code-review R1 MED-6 — an EXPLICIT success is required, and post-send
 * uncertainty is `unknown`, never a terminalizing `not_dispatched`):
 *   - 2xx + successFlag === true → success;
 *   - 2xx + successFlag === false → not_dispatched (the Bridge handled the
 *     request and EXPLICITLY refused — provably no hidden start);
 *   - 2xx WITHOUT an explicit success flag (malformed / non-JSON body) → unknown
 *     (we cannot confirm the Bridge acted → postcondition reconciliation);
 *   - 4xx → not_dispatched (a client/validation refusal — the Bridge rejected
 *     before acting). This is sound ONLY because the Bridge's retry handler is
 *     fixed (R2 MED-6) to return 4xx EXCLUSIVELY for pre-dispatch failures: once
 *     `dispatch()` returns, every post-dispatch bookkeeping error still reports
 *     SUCCESS with the bound successor id, never a clean 4xx failure;
 *   - 5xx → unknown (the Bridge MAY have already acted before erroring; a
 *     non-idempotent retry must not be terminalized as not-started);
 *   - connection refused / DNS-level failure BEFORE a response → not_dispatched
 *     (the request never reached the Bridge);
 *   - anything else ambiguous (timeout / socket reset mid-flight) → unknown.
 */
export function mapHttpDispatchOutcome(
	result:
		| { kind: "response"; status: number; successFlag?: boolean; body?: string }
		| { kind: "network_error"; code?: string; message: string },
): DispatchOutcome {
	if (result.kind === "response") {
		const detail = `http_${result.status}:${(result.body ?? "").slice(0, 200)}`;
		if (result.status >= 200 && result.status < 300) {
			if (result.successFlag === true) return { kind: "success" };
			if (result.successFlag === false) {
				return { kind: "not_dispatched", detail };
			}
			// 2xx with no explicit success flag → can't confirm → ambiguous.
			return { kind: "unknown", detail };
		}
		// 5xx (and any other non-2xx >= 500) may have acted before erroring.
		if (result.status >= 500) {
			return { kind: "unknown", detail };
		}
		// 4xx: the Bridge refused before acting.
		return { kind: "not_dispatched", detail };
	}
	const code = result.code ?? "";
	if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ENOENT") {
		return { kind: "not_dispatched", detail: code };
	}
	return { kind: "unknown", detail: result.message };
}

// ── Target resolution (§5.4 exactly-one, read-only StateStore) ───────────────

interface SessionRow {
	execution_id: string;
	issue_id: string;
	issue_identifier: string | null;
	project_name: string;
	status: string;
	session_role: string | null;
	lifecycle_revision: number | null;
	worktree_path?: string | null;
	issue_labels?: string | null;
}

/** R1 MED-7: a session shape sufficient for label-routing scope resolution. */
export interface ScopeProbeSession {
	execution_id: string;
	project_name: string;
	issue_labels?: string;
}

/**
 * Resolve EXACTLY ONE target session for (issue, action) from a READ-ONLY
 * StateStore snapshot, filtered to the action's SSOT-eligible statuses, this
 * gateway's project, AND — when `leadScope` is supplied — this Lead's label
 * routing scope (R1 MED-7: a founder credential must NEVER be created/consumed
 * for ANOTHER Lead's runner; the Bridge's later leadId check is only a second
 * line). Zero or multiple candidates throw (fail-closed, AmbiguousTargetError
 * carries the IN-SCOPE candidate list for the founder).
 */
export function resolveLifecycleTarget(args: {
	stateDbPath: string;
	projectName: string;
	issue: string;
	action: string;
	leadScope?: {
		leadId: string;
		/** Returns true iff the session routes to this gateway's Lead. Throwing
		 * (unknown project / unresolvable routing) is treated as OUT of scope. */
		inScope: (session: ScopeProbeSession) => boolean;
	};
}): ResolvedLifecycleTarget & { worktreePath?: string } {
	const meta = getActionClassMeta(args.action);
	if (!meta || !isLifecycleAction(args.action)) {
		throw new Error(`"${args.action}" is not a lifecycle action`);
	}
	if (!existsSync(args.stateDbPath)) {
		throw new Error(
			`StateStore not found at ${args.stateDbPath} (fail-closed)`,
		);
	}
	const db = new Database(args.stateDbPath, {
		readonly: true,
		fileMustExist: true,
	});
	let rows: SessionRow[];
	try {
		rows = db
			.prepare(
				`SELECT execution_id, issue_id, issue_identifier, project_name, status,
				        session_role, lifecycle_revision, worktree_path, issue_labels
				 FROM sessions
				 WHERE project_name = ? AND (issue_identifier = ? OR issue_id = ?)`,
			)
			.all(args.projectName, args.issue, args.issue) as SessionRow[];
	} finally {
		db.close();
	}
	const eligible = rows.filter((r) => meta.eligibleStatuses.includes(r.status));
	// MED-7: restrict to this Lead's routing scope BEFORE exactly-one selection.
	const inScope = args.leadScope
		? eligible.filter((r) => {
				try {
					return args.leadScope?.inScope({
						execution_id: r.execution_id,
						project_name: r.project_name,
						issue_labels: r.issue_labels ?? undefined,
					});
				} catch {
					return false; // unresolvable routing → fail-closed (out of scope)
				}
			})
		: eligible;
	const chosen = resolveExactlyOne({
		candidates: inScope,
		describe: (r) =>
			`${r.issue_identifier ?? r.issue_id} exec=${r.execution_id} role=${r.session_role ?? "main"} status=${r.status}`,
		intent: `${args.action} ${args.issue}`,
	});
	return {
		execId: chosen.execution_id,
		issueId: chosen.issue_identifier ?? chosen.issue_id,
		role: chosen.session_role ?? "main",
		status: chosen.status,
		revision: chosen.lifecycle_revision ?? 0,
		project: args.projectName,
		worktreePath: chosen.worktree_path ?? undefined,
	};
}

// ── Assembly glue (real-machine validated, Phase F QA) ──────────────────────

const DISCORD_API = "https://discord.com/api/v10";

function discordRest(botToken: string) {
	const headers = {
		Authorization: `Bot ${botToken}`,
		"Content-Type": "application/json",
	};
	return {
		async sendConfirmation(channelId: string, text: string) {
			const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					content: markAutomatedDiscordText(text),
				}),
			});
			if (!res.ok) {
				throw new Error(`discord send failed: ${res.status}`);
			}
			const body = (await res.json()) as { id: string; channel_id: string };
			return { channelId: body.channel_id, messageId: body.id };
		},
		async editMessage(channelId: string, messageId: string, text: string) {
			const res = await fetch(
				`${DISCORD_API}/channels/${channelId}/messages/${messageId}`,
				{
					method: "PATCH",
					headers,
					body: JSON.stringify({
						content: markAutomatedDiscordText(text),
					}),
				},
			);
			if (!res.ok) throw new Error(`discord edit failed: ${res.status}`);
		},
		async fetchReactionPage(args: {
			channelId: string;
			messageId: string;
			emoji: string;
			after?: string;
		}) {
			// LOW-10: forward the pagination cursor so >100 reactors can't hide the
			// founder behind page 1.
			const afterQs = args.after
				? `&after=${encodeURIComponent(args.after)}`
				: "";
			const res = await fetch(
				`${DISCORD_API}/channels/${args.channelId}/messages/${args.messageId}/reactions/${encodeReactionEmoji(args.emoji)}?limit=100${afterQs}`,
				{ headers },
			);
			return {
				status: res.status,
				body: res.ok ? await res.json() : undefined,
			};
		},
		async fetchRecentMessages(
			channelId: string,
		): Promise<TokenConfirmationMessage[]> {
			const res = await fetch(
				`${DISCORD_API}/channels/${channelId}/messages?limit=25`,
				{ headers },
			);
			if (!res.ok) return [];
			const body = (await res.json()) as Array<{
				content?: string;
				channel_id?: string;
				author?: { id?: string };
			}>;
			if (!Array.isArray(body)) return [];
			return body.map((m) => ({
				text: m.content ?? "",
				authorId: m.author?.id ?? "",
				channelId: m.channel_id ?? channelId,
			}));
		},
	};
}

/** POST one canonical Bridge action endpoint; classify the outcome (pure
 * mapping via mapHttpDispatchOutcome). Always sends leadId; retry carries the
 * D2 pre-bound ids. */
async function dispatchToBridge(
	cfg: GatewayConfig,
	apiToken: string,
	row: LifecycleRequestRecord,
): Promise<DispatchOutcome> {
	const meta = getActionClassMeta(row.action);
	if (!meta) return { kind: "not_dispatched", detail: "unclassified_action" };
	const path = meta.canonicalEndpoint.replace(":id", row.execId);
	const body: Record<string, unknown> = {
		execution_id: row.execId,
		leadId: row.leadId,
		reason: `founder-confirmed lifecycle ${row.action} (gateway request ${row.requestId})`,
	};
	if (row.action === "retry") {
		body.gateway_request_id = row.requestId;
		body.successor_execution_id = row.successorExecId;
	}
	try {
		const res = await fetch(`${cfg.bridgeUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiToken}`,
			},
			body: JSON.stringify(body),
		});
		let successFlag: boolean | undefined;
		let text = "";
		try {
			text = await res.text();
			const parsed = JSON.parse(text) as { success?: boolean };
			successFlag = parsed.success;
		} catch {
			// non-JSON body — status code governs
		}
		return mapHttpDispatchOutcome({
			kind: "response",
			status: res.status,
			successFlag,
			body: text,
		});
	} catch (err) {
		const e = err as Error & { cause?: { code?: string } };
		return mapHttpDispatchOutcome({
			kind: "network_error",
			code: e.cause?.code,
			message: e.message,
		});
	}
}

/**
 * Assemble + run the gateway: broker secrets → orchestrator with real bindings
 * → MCP stdio server → recovery + observation loop. Returns the orchestrator
 * (for tests/embedding); `await`s forever in production via the MCP transport.
 */
export async function gatewayMain(
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const cfg = parseGatewayConfig(env);

	// Secrets ONLY via the parent broker — fail-closed (a secretless gateway
	// must refuse its action surface, not limp along).
	const secrets = await fetchSecretsFromBroker(cfg.brokerSocketPath);
	const botToken = secrets.DISCORD_BOT_TOKEN;
	const apiToken = secrets.FLYWHEEL_API_TOKEN;
	if (!botToken || !apiToken) {
		throw new Error(
			"gateway: broker did not supply DISCORD_BOT_TOKEN + FLYWHEEL_API_TOKEN (fail-closed)",
		);
	}
	// FLY-350 (Z) unit 4: the GH_TOKEN is OPTIONAL — present only for a Lead
	// provisioned to open PRs. Absent → git_push/open_pr fail closed at call time
	// (the FLY-245 dormant path + a non-PR Lead need no GH token). It lives ONLY
	// here in gateway memory (broker-served); it is never in the model env/shell.
	const githubToken = secrets.GITHUB_TOKEN;

	const rest = discordRest(botToken);
	const store = new LifecycleRequestStore(
		join(cfg.stateDir, "lifecycle-requests.db"),
	);

	// FLY-350 (Z) unit 3: proactive-send loop-safety guards (FLY-220) — one
	// instance per live gateway process; shared by every discord_send turn.
	const sendRateLimiter = new SlidingWindowRateLimiter({
		maxPerWindow: cfg.sendRateMaxPerWindow,
		windowMs: cfg.sendRateWindowMs,
	});
	const sendIdempotency = new SendIdempotencyCache(cfg.sendIdempotencyTtlMs);
	const discordSendAuditPath = join(
		cfg.stateDir,
		"gateway-discord-send-audit.jsonl",
	);

	// MED-7: restrict target resolution to THIS Lead's label-routing scope so a
	// founder credential is never created/consumed for another Lead's runner.
	// projects.json is read from ~/.flywheel (HOME is forwarded); a load failure
	// leaves `projects` empty → matchesLead throws on an unknown project →
	// resolveLifecycleTarget treats every candidate as out-of-scope (fail-closed).
	let projects: import("../../../ProjectConfig.js").ProjectEntry[] = [];
	try {
		projects = loadProjects();
	} catch (err) {
		process.stderr.write(
			`[gateway] WARN could not load projects for lead-scope (fail-closed): ${(err as Error).message}\n`,
		);
	}
	const leadScope = {
		leadId: cfg.leadId,
		inScope: (s: {
			execution_id: string;
			project_name: string;
			issue_labels?: string;
		}) => matchesLead(s as Session, cfg.leadId, projects),
	};

	const { CommDB } = await import("flywheel-comm/db");
	const comm = {
		insertQuestion: (
			fromAgent: string,
			toAgent: string,
			content: string,
			opts: { checkpoint: string; ttlSeconds: number },
		): string => {
			const db = new CommDB(cfg.commDbPath);
			try {
				return db.insertQuestion(fromAgent, toAgent, content, opts);
			} finally {
				db.close();
			}
		},
		insertResponse: (
			parentId: string,
			fromAgent: string,
			content: string,
		): void => {
			const db = new CommDB(cfg.commDbPath);
			try {
				db.insertResponse(parentId, fromAgent, content);
			} finally {
				db.close();
			}
		},
		claimConsent: (questionId: string, checkpoint: string): boolean => {
			const db = new CommDB(cfg.commDbPath);
			try {
				return db.claimLifecycleConsent(questionId, checkpoint);
			} finally {
				db.close();
			}
		},
		// MED-9 recovery latch: read any durable founder response for the question.
		getResponse: (
			questionId: string,
		): { from_agent: string; content: string } | undefined => {
			try {
				const db = CommDB.openReadonly(cfg.commDbPath);
				try {
					const r = db.getResponse(questionId);
					return r
						? { from_agent: r.from_agent, content: r.content }
						: undefined;
				} finally {
					db.close();
				}
			} catch {
				return undefined; // fail-safe: no latch → normal observation path
			}
		},
	};

	const readRevision = (execId: string): number | undefined => {
		try {
			const db = new Database(cfg.stateDbPath, {
				readonly: true,
				fileMustExist: true,
			});
			try {
				const row = db
					.prepare(
						"SELECT lifecycle_revision FROM sessions WHERE execution_id = ?",
					)
					.get(execId) as { lifecycle_revision?: number } | undefined;
				if (!row) return undefined;
				return typeof row.lifecycle_revision === "number"
					? row.lifecycle_revision
					: 0;
			} finally {
				db.close();
			}
		} catch {
			return undefined; // fail-closed upstream
		}
	};
	const readStatus = async (execId: string): Promise<string | undefined> => {
		try {
			const db = new Database(cfg.stateDbPath, {
				readonly: true,
				fileMustExist: true,
			});
			try {
				const row = db
					.prepare("SELECT status FROM sessions WHERE execution_id = ?")
					.get(execId) as { status?: string } | undefined;
				return row?.status;
			} finally {
				db.close();
			}
		} catch {
			throw new Error("state db unreadable"); // postcondition fail-closed
		}
	};

	const postcondition = (row: LifecycleRequestRecord) => {
		if (row.action === "retry") {
			// D2: the one non-idempotent action — reconcile by authoritative
			// started evidence on the PRE-BOUND successor id.
			return makeRetryDispatchPostcondition({
				checkEvidence: (execId, project) =>
					checkStartedEvidence(execId, project),
			})(row);
		}
		return makePostconditionCheck(row.action, {
			sessionStatus: readStatus,
			tmuxPresent: async (execId) => {
				const t = lookupTmuxTarget(execId, row.project);
				if (t.kind === "error") throw new Error(t.error);
				if (t.kind === "gone") return false;
				return isTmuxWindowAlive(t.target.tmuxWindow);
			},
			runnerPresent: async (execId) => {
				const t = lookupTmuxTarget(execId, row.project);
				if (t.kind === "error") throw new Error(t.error);
				if (t.kind === "gone") return false;
				return isTmuxWindowAlive(t.target.tmuxWindow);
			},
		})(row);
	};

	const orchestrator = new LifecycleOrchestrator({
		store,
		founderId: cfg.founderId,
		leadId: cfg.leadId,
		ttlMs: cfg.confirmTtlMs,
		comm,
		verify: (row) =>
			verifyLifecycleConsent({
				questionId: row.questionId,
				execId: row.execId,
				action: row.action,
				nonce: row.nonce,
				leadId: cfg.leadId,
				founderId: cfg.founderId,
				project: row.project,
				dbPath: cfg.commDbPath,
				stateDbPath: cfg.stateDbPath,
			}),
		currentRevision: readRevision,
		discord: {
			sendConfirmation: (text) =>
				rest.sendConfirmation(cfg.confirmChannelId, text),
			editMessage: (channelId, messageId, text) =>
				rest.editMessage(channelId, messageId, text),
			checkReaction: (channelId, messageId) =>
				checkReactionConfirmation((args) => rest.fetchReactionPage(args), {
					channelId,
					messageId,
					founderId: cfg.founderId,
					emoji: FOUNDER_CONFIRM_EMOJI,
				}),
			fetchRecentMessages: (channelId) => rest.fetchRecentMessages(channelId),
		},
		dispatch: (row) => dispatchToBridge(cfg, apiToken, row),
		postcondition,
		logger: {
			info: (m) => process.stderr.write(`[gateway] ${m}\n`),
			warn: (m) => process.stderr.write(`[gateway] WARN ${m}\n`),
		},
	});

	// merge/ship preflight (C2): the SAME flywheel-comm verifyApproval as a
	// Claude Lead, with the prHead derived from the TARGET worktree (never the
	// Lead workspace). HIGH-5: an ABSOLUTE trusted git binary (never PATH-
	// resolved) run with a MINIMAL env — the unsandboxed, secret-bearing gateway
	// must not execute a model-planted `git` off $PATH.
	const founderPreflight = new CodexFounderPreflight({
		verify: verifyApproval,
	});
	const trustedGitPath = resolveTrustedGitPath(env);
	const gitRunner: GitRunner = makeTrustedGitRunner(trustedGitPath);
	// FLY-350 (Z) unit 4: gateway-proxied git_push/open_pr support. The push
	// exec is the hardened (no-inherited-config, minimal-env) git used to drive a
	// CLEAN staging repo; the staging root lives under the per-Lead state dir —
	// OUTSIDE the model's writableRoots (resolveLeadWorkspace already forbids the
	// scratch from overlapping stateDir). owner/repo is the configured project
	// repo (never inferred from model-local git state, R3-4).
	const gitPushExec = makeGitPushExec(trustedGitPath);
	const gitStagingRoot = join(cfg.stateDir, "git-staging");
	const pushAuditPath = join(cfg.stateDir, "gateway-git-push-audit.jsonl");
	// Best-effort metadata-only audit (NEVER the token — buildPushAuditRow never
	// carries it; a failed append must not fail the action).
	const appendGitPushAudit = (row: Record<string, unknown>): void => {
		try {
			mkdirSync(cfg.stateDir, { recursive: true });
			appendFileSync(pushAuditPath, `${JSON.stringify(row)}\n`);
		} catch {
			// best-effort
		}
	};
	let ownerRepo: { owner: string; repo: string } | undefined;
	if (cfg.projectRepo) {
		try {
			ownerRepo = parseOwnerRepo(cfg.projectRepo);
		} catch (e) {
			process.stderr.write(
				`[gateway] WARN invalid FLYWHEEL_GATEWAY_PROJECT_REPO (git_push/open_pr disabled): ${(e as Error).message}\n`,
			);
		}
	}
	// R2 HIGH-5: the model's writable scratch — a target worktree overlapping it
	// is refused (forged-clean HEAD + repo-local-config risk). The runtime ALWAYS
	// forwards FLYWHEEL_CODEX_LEAD_WORKSPACE (= the canonical release.workspace),
	// so for a write-capable gateway its ABSENCE is a misconfiguration: fail the
	// ship path CLOSED (never silently run with an empty overlap check). Resolve
	// the canonical form so a symlinked worktree can't slip past the compare.
	const modelWorkspaceRaw = env.FLYWHEEL_CODEX_LEAD_WORKSPACE?.trim();
	let modelWorkspaceRoot: string | undefined;
	if (modelWorkspaceRaw) {
		try {
			modelWorkspaceRoot = nodeRealpathSync(modelWorkspaceRaw);
		} catch {
			modelWorkspaceRoot = modelWorkspaceRaw; // best-effort; still used as a root
		}
	}

	// ── MCP stdio server ──
	const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
	const { StdioServerTransport } = await import(
		"@modelcontextprotocol/sdk/server/stdio.js"
	);
	const { z } = await import("zod");

	const server = new McpServer({ name: "flywheel-gateway", version: "0.1.0" });

	const asText = (text: string, isError = false) => ({
		content: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
	});

	server.tool(
		"request_runner_lifecycle",
		"REQUEST a founder-gated runner-lifecycle action (terminate/reject/defer/shelve/retry/close_tmux/close_runner). The founder must confirm on Discord before anything executes — this tool can only ask.",
		{
			issue: z.string().describe("Issue identifier (e.g. FLY-12)"),
			action: z.string().describe("Lifecycle action to request"),
			reason: z.string().optional().describe("Why (shown to the founder)"),
		},
		async ({ issue, action }) => {
			try {
				// Authority is DERIVED here (never from the model): exactly-one
				// target, fail-closed on zero/multiple (§5.4).
				const target = resolveLifecycleTarget({
					stateDbPath: cfg.stateDbPath,
					projectName: cfg.projectName,
					issue,
					action,
					leadScope,
				});
				const { requestId } = await orchestrator.createRequest(target, action);
				return asText(
					`Founder confirmation requested (${requestId}) for ${action} ${target.issueId} exec=${target.execId}. Nothing will execute until the founder confirms on Discord.`,
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				const candidates =
					e instanceof AmbiguousTargetError && e.candidateDescriptions.length
						? `\nCandidates:\n${e.candidateDescriptions.join("\n")}`
						: "";
				return asText(`REFUSED: ${msg}${candidates}`, true);
			}
		},
	);

	server.tool(
		"relay_ship_decision",
		"Check the founder merge/ship approval (verify-approval credential against the TARGET worktree's HEAD). Preflight only — the durable relay to the Runner is FLY-251; the Runner's own verify-approval remains the final authority.",
		{
			issue: z.string().describe("Issue identifier (e.g. FLY-12)"),
		},
		async ({ issue }) => {
			try {
				const target = resolveLifecycleTarget({
					stateDbPath: cfg.stateDbPath,
					projectName: cfg.projectName,
					issue,
					action: "terminate", // broadest eligible-status set for lookup only
					leadScope,
				});
				if (!target.worktreePath) {
					return asText(
						"REFUSED: target session has no trusted worktree_path (fail-closed)",
						true,
					);
				}
				// R2 HIGH-5: the model workspace root MUST be known for a write-capable
				// gateway (the runtime always forwards it). Its absence means the
				// overlap check would be silently disabled → fail CLOSED.
				if (!modelWorkspaceRoot) {
					return asText(
						"REFUSED: FLYWHEEL_CODEX_LEAD_WORKSPACE not set — cannot validate worktree isolation (fail-closed)",
						true,
					);
				}
				// HIGH-5: canonicalize + ownership-validate the worktree BEFORE it
				// becomes a git cwd (realpath, must be a real .git worktree, must not
				// overlap the model's writable scratch).
				const canonicalWorktree = canonicalizeTargetWorktree(
					target.worktreePath,
					{ untrustedRoots: [modelWorkspaceRoot] },
				);
				const prHead = deriveTargetPrHead(canonicalWorktree, gitRunner);
				const decision = founderPreflight.check({
					action: "ship",
					execId: target.execId,
					prHead,
					dbPath: cfg.commDbPath,
					stateDbPath: cfg.stateDbPath,
				});
				return asText(
					decision.allowed
						? `Ship preflight ALLOWED for ${target.issueId} exec=${target.execId} head=${prHead}. (Relay transport lands in FLY-251 — the Runner's verify-approval is the final authority.)`
						: `Ship preflight DENIED: ${decision.reason}`,
					!decision.allowed,
				);
			} catch (e) {
				return asText(
					`REFUSED: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	// FLY-350 (Z) unit 3: discord_send — proactive post to an ALLOWLISTED channel
	// alias. NOT founder-gated (it cannot reach the merge red line): the model
	// passes an alias only ("chat"/"roundtable"), the channel id is resolved
	// SERVER-SIDE (fail-closed), and the send is rate-limited + idempotent +
	// metadata-audited. Delegates to the SHARED runDiscordSend core (the exact
	// same path as the full-access lead-actions MCP), so the two
	// proactive-send surfaces can never drift.
	server.tool(
		"discord_send",
		"Proactively post a message to one of YOUR allowlisted channels. `target` " +
			'is an ALIAS ("chat" = your own channel, "roundtable" = the cross-' +
			"department channel), NOT a channel id. Use this to START a message " +
			"(reactive replies are sent automatically — no tool needed).",
		{
			target: z
				.string()
				.describe('Channel alias: "chat" or "roundtable" (not a raw id)'),
			text: z.string().min(1).describe("Message text to post"),
		},
		async ({ target, text }) => {
			const r = await runDiscordSend(target, text, {
				chatChannelId: cfg.chatChannelId,
				crossDeptChannelIds: cfg.crossDeptChannelIds,
				explicitAliases: cfg.explicitAliases,
				botToken,
				rateLimiter: sendRateLimiter,
				idempotency: sendIdempotency,
				auditPath: discordSendAuditPath,
				leadId: cfg.leadId,
				projectName: cfg.projectName,
				roundtableAutoContinue: cfg.roundtableAutoContinue,
			});
			return asText(r.text, r.isError);
		},
	);

	// FLY-350 (Z) unit 4: gateway-proxied PR. git_push + open_pr let a net-off
	// write-capable Lead open a PR WITHOUT a shell token or shell network — the
	// gateway holds the fine-grained GH_TOKEN (contents:write + pull_requests:write
	// only) and does the push/PR. NOT founder-gated (push a feature branch / open a
	// PR ≠ merge): the model cannot reach `gh pr merge` / `:cool:` (no such tool),
	// branch protection + the absent merge tool keep the merge red line structural.
	// Both derive the SAME server-side branch from the model HEAD (R4-4) so a
	// git_push then open_pr line up. Fail-closed if the Lead has no GH_TOKEN/repo.
	const requirePrPrereqs = ():
		| { ok: true; owner: string; repo: string; token: string; worktree: string }
		| { ok: false; reason: string } => {
		if (!githubToken)
			return { ok: false, reason: "no GH_TOKEN provisioned (fail-closed)" };
		if (!ownerRepo)
			return {
				ok: false,
				reason: "no/invalid project repo configured (fail-closed)",
			};
		if (!modelWorkspaceRoot)
			return {
				ok: false,
				reason:
					"FLYWHEEL_CODEX_LEAD_WORKSPACE not set — cannot locate the model worktree (fail-closed)",
			};
		return {
			ok: true,
			owner: ownerRepo.owner,
			repo: ownerRepo.repo,
			token: githubToken,
			worktree: modelWorkspaceRoot,
		};
	};

	server.tool(
		"git_push",
		"Push YOUR committed work (the model worktree's current HEAD) to a fresh " +
			"feature branch on the project repo, via the gateway (your shell has no " +
			"token/network). The branch is derived server-side; main/protected are " +
			"refused; this is NOT a merge.",
		{
			issue: z
				.string()
				.min(1)
				.describe(
					"Issue identifier (e.g. FLY-350) — required; labels the branch",
				),
		},
		async ({ issue }) => {
			const pre = requirePrPrereqs();
			if (!pre.ok) return asText(`REFUSED: ${pre.reason}`, true);
			try {
				const headSha = readModelHeadSha(pre.worktree, gitPushExec);
				const branch = deriveBranchName({ leadId: cfg.leadId, issue, headSha });
				const probe = await probeGitHubToken({
					fetchImpl: fetch,
					owner: pre.owner,
					repo: pre.repo,
					token: pre.token,
				});
				if (!probe.ok)
					return asText(
						`REFUSED: GH token probe failed: ${probe.reason}`,
						true,
					);
				const res = materializeAndPush(
					{
						modelGitDir: join(pre.worktree, ".git"),
						headSha,
						remoteUrl: buildRemoteUrl(pre.owner, pre.repo),
						branch,
						token: pre.token,
					},
					{ gitPath: trustedGitPath, stagingRoot: gitStagingRoot },
				);
				appendGitPushAudit(
					buildPushAuditRow({
						ts: Date.now(),
						leadId: cfg.leadId,
						projectName: cfg.projectName,
						repo: `${pre.owner}/${pre.repo}`,
						branch,
						localSha: headSha,
						pushedSha: res.pushedSha,
						actor: probe.actor,
						outcome: res.ok ? "pushed" : `failed:${res.error ?? "unknown"}`,
					}),
				);
				if (!res.ok) return asText(`REFUSED: ${res.error}`, true);
				return asText(
					`Pushed HEAD ${headSha} → branch ${branch} on ${pre.owner}/${pre.repo}. Open a PR with open_pr.`,
				);
			} catch (e) {
				return asText(
					`REFUSED: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	server.tool(
		"open_pr",
		"Open a pull request from YOUR pushed feature branch into the project's " +
			"default branch (main). Run git_push first. This opens a PR for review — " +
			"it does NOT merge (you cannot merge; the founder/CI own that).",
		{
			title: z.string().min(1).describe("PR title"),
			body: z.string().describe("PR body (what changed + why)"),
			issue: z
				.string()
				.min(1)
				.describe(
					"Issue identifier (required; must match the git_push that created the branch)",
				),
		},
		async ({ title, body, issue }) => {
			const pre = requirePrPrereqs();
			if (!pre.ok) return asText(`REFUSED: ${pre.reason}`, true);
			try {
				const headSha = readModelHeadSha(pre.worktree, gitPushExec);
				const branch = deriveBranchName({ leadId: cfg.leadId, issue, headSha });
				const probe = await probeGitHubToken({
					fetchImpl: fetch,
					owner: pre.owner,
					repo: pre.repo,
					token: pre.token,
				});
				if (!probe.ok)
					return asText(
						`REFUSED: GH token probe failed: ${probe.reason}`,
						true,
					);
				const pr = await openPullRequest({
					fetchImpl: fetch,
					owner: pre.owner,
					repo: pre.repo,
					token: pre.token,
					head: branch,
					base: "main",
					title,
					body,
				});
				appendGitPushAudit(
					buildPushAuditRow({
						ts: Date.now(),
						leadId: cfg.leadId,
						projectName: cfg.projectName,
						repo: `${pre.owner}/${pre.repo}`,
						branch,
						localSha: headSha,
						actor: probe.actor,
						prNumber: pr.number,
						prUrl: pr.url,
						outcome: pr.ok
							? "pr_opened"
							: `pr_failed:${pr.reason ?? "unknown"}`,
					}),
				);
				if (!pr.ok) return asText(`REFUSED: ${pr.reason}`, true);
				return asText(`Opened PR #${pr.number}: ${pr.url}`);
			} catch (e) {
				return asText(
					`REFUSED: ${e instanceof Error ? e.message : String(e)}`,
					true,
				);
			}
		},
	);

	// Recovery first (never blind-replays), then the observation loop.
	await orchestrator.recover();
	const timer = setInterval(() => {
		orchestrator.observeOnce().catch((err) => {
			process.stderr.write(
				`[gateway] WARN observe failed: ${(err as Error).message}\n`,
			);
		});
	}, cfg.pollIntervalMs);
	timer.unref();

	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write(
		`[gateway] ${cfg.leadId}@${cfg.projectName} ready (founder ${cfg.founderId})\n`,
	);
}

// Run when executed directly (the app-server MCP config points here).
if (process.argv[1]?.includes("gateway-main")) {
	gatewayMain().catch((err) => {
		process.stderr.write(`[gateway] fatal: ${(err as Error).message}\n`);
		process.exit(1);
	});
}
