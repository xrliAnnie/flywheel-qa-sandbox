import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SummaryRole } from "flywheel-comm/lead-identity";
import { compileLeadIdentityRegistry } from "flywheel-comm/lead-identity";
import type { LeadBackendId } from "./lead-backends/lead-backend.js";
import { isLeadEffort, type LeadEffort } from "./lead-effort.js";

export type LeadCarrier = "v2";

export interface LeadConfig {
	agentId: string;
	/** FLY-2030: explicit summary inflow assignment. Missing/unknown values fail config load. */
	summaryRole: SummaryRole;
	chatChannel: string;
	match: {
		labels: string[];
	};
	/** Env var name for this lead's Discord bot token (e.g., "PETER_BOT_TOKEN"). */
	botTokenEnv?: string;
	/** Registry-owned expected Discord bot user ID. Never derived from the token at runtime. */
	botUserId?: string;
	/** Registry-owned Discord plugin state directory. Defaults from agentId when absent. */
	discordStateDir?: string;
	/** Resolved bot token (populated at load time from botTokenEnv). NOT from JSON input. */
	botToken?: string;
	/**
	 * FLY-83: Discord channel ID where lead-alert.sh posts
	 * operator-facing alerts (login expired, permission blocked, silent pane).
	 * If omitted and alertFallbackToCore is false, alerts are skipped.
	 */
	alertChannel?: string;
	/** Optional Discord user ID for severe follow-up DMs. */
	alertDmUserId?: string;
	/**
	 * Env var name for the bot token used to post alerts. Falls back to
	 * botTokenEnv/botToken if omitted.
	 */
	alertBotTokenEnv?: string;
	/**
	 * When true and alertChannel is missing, route alerts to the project's
	 * core channel (Simba's cos-chat) instead of dropping them.
	 */
	alertFallbackToCore?: boolean;
	/**
	 * FLY-127 / FLY-163: Bridge spawn authorization — independent of Discord
	 * channel features. Whether this Lead is authorized to spawn Runners via
	 * `POST /api/runs/start`. The Bridge enforces this server-side.
	 *
	 * Default (when field is absent): `true`. PM / triage Leads MUST explicitly
	 * set `"canSpawnRunners": false` — the PM/Triage validator (see
	 * `loadProjects()`) throws if a Lead's `match.labels` includes "PM" or
	 * "Triage" (case-insensitive) without an explicit `canSpawnRunners: false`.
	 *
	 * After `loadProjects()`, this field is normalized to a boolean (no `undefined`).
	 */
	canSpawnRunners?: boolean;
	/**
	 * FLY-137 v1.27.2: optional explicit department identifier. If absent,
	 * `resolveLeadDepartment(lead)` derives it from `match.labels[0]?.toLowerCase()`.
	 *
	 * Used by `DepartmentRegistry.getLeadDepartment(projectName, leadId)` and
	 * `getDepartmentForIssue(projectName, issueLabels)` to feed AgentDispatcher's
	 * dept-aware step 2.
	 */
	department?: string;
	/**
	 * FLY-231: companion (non-engineering) Lead marker — a warm persona agent
	 * (e.g. Mufasa, Belle) wrapped in Flywheel Lead infra for launchd residency +
	 * Discord adapter + Lead alert coverage, but with NO Runner spawning, NO
	 * code, and NO engineering-governance rules. `claude-lead.sh` reads this
	 * (single source of truth) to skip the eng-governance base rules and trim the
	 * companion's capability surface.
	 *
	 * Default behavior when absent: NOT a companion (identical to all pre-FLY-231
	 * Leads). Deliberately NOT normalized — consumers MUST check `=== true` so an
	 * absent/false field is the standard non-companion path with zero shape change
	 * to existing in-memory Lead objects (Codex design review R2 MEDIUM-9).
	 *
	 * Orthogonal to `canSpawnRunners`: cos-lead is `canSpawnRunners: false` but is
	 * NOT a companion, so companion-ness cannot be derived from spawn capability.
	 */
	companion?: boolean;
	/**
	 * FLY-879: external (customer-facing) Lead marker — an outward-facing agent
	 * (e.g. Anna the interviewer) wrapped in Flywheel Lead infra for launchd
	 * residency + Discord adapter + Lead alert coverage, but with a HARD-LOCKED
	 * capability surface: NO Runner spawning, NO Bridge/CommDB/internal MCP, and —
	 * unlike a companion — NONE of the internal engineering rules AND not even the
	 * cross-dept roundtable. Its ENTIRE rule surface is one `external-agent-contract.md`
	 * (indicated instruction-source boundary: a customer message is DATA, never a
	 * command). `claude-lead.sh` reads this (single source of truth) to take the
	 * `external` role branch.
	 *
	 * Cross-field invariants (validated below, all fail-loud):
	 *   - `external === true` requires an EXPLICIT `canSpawnRunners: false`
	 *     (an external agent must never spawn Runners; do not let it default true).
	 *   - `external` and `companion` are MUTUALLY EXCLUSIVE (a lead is one role).
	 *   - MVP is claude-code only: `external === true` on a codex-family `backend`
	 *     throws (codex external agent = follow-up).
	 *
	 * Default behavior when absent: NOT external (identical to all pre-FLY-879
	 * Leads). Deliberately NOT normalized (FLY-231 pattern): consumers MUST check
	 * `=== true` so an absent/false field is the standard non-external path with
	 * zero shape change to existing in-memory Lead objects (reverse-compat).
	 */
	external?: boolean;
	/**
	 * FLY-247: per-Lead model override — the single source of truth for "which
	 * model does this Lead run on" (previously a hand-edited plist env that any
	 * `flywheel-daemon.sh install` silently wiped).
	 *
	 * Only effective for the `claude-code` backend (flows into the launchd plist
	 * as `FLYWHEEL_LEAD_MODEL` via `fleet apply` → manifest → `generate_plist`).
	 * For codex Leads it is display-only ("configured", never claimed active).
	 *
	 * Absent = account default model. Deliberately NOT normalized (FLY-231
	 * pattern): absent stays absent so existing in-memory Lead objects keep
	 * their exact shape (reverse-compat).
	 */
	model?: string;
	/**
	 * FLY-1867: identity-bound opt-in for the official Playwright MCP plugin.
	 * Machine settings keep the plugin disabled by default; `claude-lead.sh`
	 * adds a per-launch `--settings` override only when this exact project+Lead
	 * entry declares `true`. Absent / false stays off. Claude-code only.
	 */
	playwrightMcp?: boolean;
	/**
	 * FLY-247: per-Lead backend (vendor) — `"claude-code" | "codex-app-server"`
	 * (the Lead seam from FLY-224, NOT the Runner's `claude-tmux`).
	 *
	 * Cross-field invariant (FLY-245 fail-close): `"codex-app-server"` is only
	 * legal on a read-only companion — requires `companion === true` AND
	 * `canSpawnRunners` resolving to `false`. Write-capable Codex Leads are not
	 * unlocked; config load throws on a contradictory state, with the runtime
	 * sandbox fail-close (`codex-lead-runtime.ts`) as the second line of defense.
	 *
	 * Absent = `"claude-code"` semantics via `effectiveLeadBackend()`; the field
	 * itself is NOT normalized into the object (reverse-compat).
	 */
	backend?: LeadBackendId;
	/**
	 * FLY-1663 launchd-native carrier marker. Absence and explicit `"v2"` are
	 * equivalent for Claude Leads; other values are rejected.
	 */
	carrier?: LeadCarrier;
	/**
	 * FLY-350: Codex Lead capability profile (only meaningful for the
	 * `codex-app-server` backend). Expresses which Codex tier this Lead runs as,
	 * instead of overloading `companion`:
	 *   - "companion"            — pure 1:1 chat companion (no model-callable MCP).
	 *   - "write-capable"        — FLY-350 (Z): net-off workspace-write shell + the
	 *                              gateway (git_push/open_pr/discord_send). The
	 *                              runtime confines it (FLY-245 net-off + GH_TOKEN in
	 *                              the gateway only); merge stays founder-gated.
	 *   - "full-access"          — FLY-350: a Claude-EQUAL Codex Lead (workspace-write
	 *                              + network ON + local gh/git, NO gateway/broker/
	 *                              confinement). The retained control is the team-wide
	 *                              founder-gate rule bundle + branch protection (the
	 *                              SAME model every Claude Lead runs under). Opt-in.
	 *
	 * Cross-field invariant (FLY-245/FLY-350): `codex-app-server` requires
	 * `canSpawnRunners` resolving to false AND a recognized tier — either
	 * `companion === true` OR an explicit `codexProfile`. `write-capable` and
	 * `full-access` additionally require `companion !== true` (a write tier is not a
	 * companion). canSpawnRunners stays false until FLY-251 wires Codex Lead
	 * runner-spawn end-to-end.
	 *
	 * Absent = unchanged behavior (derived from `companion`); NOT normalized into
	 * the object (FLY-231 reverse-compat pattern).
	 */
	codexProfile?: "companion" | "write-capable" | "full-access";
	/**
	 * FLY-546: per-agent voice for headphone mode (PRD §17 "换 agent 换声线").
	 * Consumed by the voice-headphone daemon via `GET /api/voice/scope` /
	 * VoiceDirectory — the Bridge itself never speaks. rate is "±N%", pitch is
	 * "±NHz" (the edge-tts CLI grammar; validated at load so a typo fails the
	 * config load, not a live announce). Absent = project default voice.
	 * Deliberately NOT normalized (FLY-231 pattern): absent stays absent so
	 * existing in-memory Lead objects keep their exact shape (reverse-compat).
	 */
	voice?: string | { voiceId: string; rate?: string; pitch?: string };
	/**
	 * FLY-671: per-Lead reasoning-effort override (`low|medium|high|xhigh|max`).
	 * Mirrors `model`: only effective for the `claude-code` backend, flowing
	 * `fleet apply → manifest → generate_plist` as `FLYWHEEL_LEAD_EFFORT` →
	 * `claude-lead.sh --effort`. Lowering it from the account default (effectively
	 * xhigh) directly saves tokens.
	 *
	 * Cross-field (validated below): rejected on a `codex-app-server` Lead — Codex
	 * has no `--effort` runtime path, so a value there would be inert dead config.
	 *
	 * Absent = account default (companions still get their FLY-583 `xhigh`).
	 * Deliberately NOT normalized (FLY-231 pattern): absent stays absent so
	 * existing in-memory Lead objects keep their exact shape (reverse-compat).
	 */
	effort?: LeadEffort;
}

/**
 * FLY-137 v1.27.2: resolve a Lead's department.
 *
 * Returns the explicit `LeadConfig.department` if set, else falls back to
 * the first match label (lowercased) — preserves backward compat with FLY-127
 * label-based dispatch for projects that don't yet set `department` explicitly.
 *
 * Returns `undefined` only if both `department` is unset AND `match.labels` is
 * empty (shouldn't happen after `loadProjects()` validation, but defensive).
 */
export function resolveLeadDepartment(lead: LeadConfig): string | undefined {
	if (typeof lead.department === "string" && lead.department.length > 0) {
		return lead.department;
	}
	const firstLabel = lead.match?.labels?.[0];
	if (typeof firstLabel === "string" && firstLabel.length > 0) {
		return firstLabel.toLowerCase();
	}
	return undefined;
}

/**
 * FLY-371: per-Flywheel-project Linear binding. Lets the Bridge resolve a
 * Linear team / Project / scope-label from a Flywheel `projectName`, so Leads
 * stop hardcoding "create in team X / project Y / label Z" in identity prose.
 *
 * Resolved by `/api/linear/create-issue`, `/api/linear/issues`, and
 * `/api/triage/data` (see `bridge/linear-scope.ts`). Absent OR `null` ⇒ those
 * endpoints behave exactly as before (explicit params required).
 */
export interface ProjectLinearBinding {
	/** Linear team key (e.g. "FLY", "GEO"). REQUIRED when a binding is present. */
	team: string;
	/** Linear Project name. Optional — label-only-scoped COEs may have none. */
	project?: string;
	/** Scope label NAME. Optional. Applied on create, defaulted as filter on list/triage. */
	label?: string;
}

/**
 * FLY-545: optional per-project Huddle (voice meeting) binding, consumed by
 * the standalone voice-bridge daemon (packages/voice-bridge reads
 * ~/.flywheel/projects.json itself — this validator only guards the shape).
 * Absent OR `null` ⇒ huddle disabled for the project (byte-compat). Defaults
 * (commandName "glaw", moveMembers true) are applied by the CONSUMER, not
 * normalized in here (FLY-231 pattern).
 */
export interface HuddleConfig {
	/** Discord guild hosting the resident #huddle voice channel. REQUIRED. */
	guildId: string;
	/** The resident voice channel id (its text area doubles as the TIV). REQUIRED. */
	voiceChannelId: string;
	/** Env var NAME for the orchestrator bot token (pool claim). REQUIRED. */
	orchestratorBotTokenEnv: string;
	/** Env var NAME for the ears (receive) bot token (pool claim). REQUIRED. */
	earsBotTokenEnv: string;
	/** Slash-command name (PRD R10: configurable). Consumer default: "glaw" (Annie-final ①). */
	commandName?: string;
	/** Zero-tap MOVE_MEMBERS when the founder is already in a VC. Consumer default: true. */
	moveMembers?: boolean;
}

export interface ProjectEntry {
	projectName: string;
	projectRoot: string;
	projectRepo?: string;
	leads: LeadConfig[];
	/** Required only while the founder-selected summary mode is per-project. */
	summaryAggregatorLeadId?: string;
	generalChannel?: string;
	/**
	 * FLY-892 (Step 7, ④): env var name holding the dedicated "system announcer"
	 * bot token (a pool bot separate from the chat Leads). Auto status broadcasts
	 * (pipeline header, auto-QA thread posts, the boot-sweep pointer) post as this
	 * bot so the founder tells "system is broadcasting" apart from "a Lead is
	 * talking to me". Resolved at load into the runtime-only `announcerBotToken`;
	 * a raw `announcerBotToken` in JSON input is stripped (secrets come via env,
	 * same as `botTokenEnv`). Unset → all broadcasts use the Lead bot (byte-compat).
	 */
	announcerBotTokenEnv?: string;
	/** Resolved announcer bot token (populated at load from announcerBotTokenEnv). NOT from JSON input. */
	announcerBotToken?: string;
	/** Memory API user_id allowlist. Fail-closed: requests rejected if not configured. */
	memoryAllowedUsers?: string[];
	/**
	 * FLY-545: optional Huddle binding — see `HuddleConfig`. `| null` mirrors
	 * the `linear` field's deployed-roster null tolerance (FLY-371 lesson).
	 */
	huddle?: HuddleConfig | null;
	/**
	 * FLY-371: optional Linear binding, resolved from `projectName` by the
	 * create-issue / issues / triage endpoints. NOT normalized (FLY-231 pattern):
	 * absent stays absent and `null` stays `null` so existing in-memory
	 * ProjectEntry objects keep their exact shape. The `| null` is HONEST about
	 * the deployed shape — the live `~/.flywheel/projects.json` literally carries
	 * `linear: null` on every project (Codex R1 HIGH-1: treating "present"
	 * as "must be a binding" would throw on `null` and break Bridge startup,
	 * because `typeof null === "object"`).
	 */
	linear?: ProjectLinearBinding | null;
}

export function loadProjects(): ProjectEntry[] {
	let raw: unknown;

	// Source 1: FLYWHEEL_PROJECTS env var (JSON array)
	const envProjects = process.env.FLYWHEEL_PROJECTS;
	if (envProjects) {
		raw = JSON.parse(envProjects);
	} else {
		// Source 2: the wrapper-selected registry file. Source 3 is the resident
		// default for processes that were not launched through a scoped wrapper.
		const filePath =
			process.env.FLYWHEEL_PROJECTS_FILE ??
			join(homedir(), ".flywheel", "projects.json");
		try {
			const data = readFileSync(filePath, "utf-8");
			raw = JSON.parse(data);
		} catch (err: unknown) {
			// Only ENOENT (file not found) returns empty array.
			// All other errors (parse error, EACCES, etc.) fail fast.
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return [];
			}
			throw new Error(
				`Failed to load ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const projects = parseAndValidateProjects(raw);

	// Hydrate per-lead bot tokens from env. This is NOT part of pure validation,
	// so `parseAndValidateProjects` stays env-free and reusable by the engine
	// CLI validator and the Bridge fleet-admin API (FLY-247 inc2a, R2 #5).
	for (const entry of projects) {
		for (const lead of entry.leads) {
			const botTokenEnv = lead.botTokenEnv;
			if (typeof botTokenEnv === "string" && botTokenEnv.length > 0) {
				const resolved = process.env[botTokenEnv];
				if (resolved) {
					lead.botToken = resolved;
				} else {
					console.warn(
						`[loadProjects] "${entry.projectName}" lead "${lead.agentId}": ` +
							`botTokenEnv="${botTokenEnv}" not found in env — will fall back to DISCORD_BOT_TOKEN`,
					);
				}
			}
		}
		// FLY-892 (Step 7): hydrate the project-level announcer bot token from env
		// (same secret-handling model as the per-lead botTokenEnv). Missing env →
		// leave unset → broadcasts fall back to the Lead bot (byte-compat).
		const announcerEnv = entry.announcerBotTokenEnv;
		if (typeof announcerEnv === "string" && announcerEnv.length > 0) {
			const resolved = process.env[announcerEnv];
			if (resolved) {
				entry.announcerBotToken = resolved;
			} else {
				console.warn(
					`[loadProjects] "${entry.projectName}": announcerBotTokenEnv="${announcerEnv}" ` +
						`not found in env — auto broadcasts will fall back to the Lead bot`,
				);
			}
		}
	}

	return projects;
}

/**
 * FLY-892 (Step 7): the project's resolved "system announcer" bot token, or
 * `undefined` when the project didn't configure one → callers fall back to the
 * Lead bot (byte-compat). Used by the auto-broadcast seams (pipeline header,
 * auto-QA thread posts, boot-sweep pointer).
 */
export function resolveAnnouncerBotToken(
	projects: ProjectEntry[],
	projectName: string,
): string | undefined {
	return projects.find((p) => p.projectName === projectName)?.announcerBotToken;
}

/**
 * FLY-247 inc2a (R2 #5): pure structural parse + validation, split from runtime
 * secret hydration. Takes already-parsed JSON (`raw`) and returns validated
 * `ProjectEntry[]` WITHOUT reading `process.env` or resolving bot tokens.
 *
 * This is the single validation authority reused by:
 *   - `loadProjects()` (which then hydrates bot tokens from env), and
 *   - the engine-side CLI validator (`validate-projects.js`) invoked by
 *     `flywheel-fleet.sh` before every `projects.json` rename and during
 *     recovery — so a bash writer can never fall back to `jq empty` and bypass
 *     cross-field rules such as the FLY-245 codex fail-close.
 *
 * Behaviour is byte-identical to the pre-split `loadProjects` validation
 * (canSpawnRunners normalization, deprecated-field strip, FLY-245 cross-field,
 * raw-botToken strip), MINUS the env-based bot-token resolution.
 */
export function parseAndValidateProjects(raw: unknown): ProjectEntry[] {
	if (!Array.isArray(raw)) {
		throw new Error("FLYWHEEL_PROJECTS must be a JSON array");
	}

	const seen = new Set<string>();
	// FLY-247 R5#6: exact keys `${projectName}-${agentId}` become filesystem
	// path components (manifests, plists, txn artifacts) and evidence-map
	// keys. Enforce a safe identifier grammar and GLOBAL key uniqueness
	// ("a-b"+"c" and "a"+"b-c" both produce "a-b-c") at the schema boundary.
	const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
	const seenExactKeys = new Set<string>();
	for (const entry of raw) {
		if (
			typeof entry?.projectName !== "string" ||
			typeof entry?.projectRoot !== "string"
		) {
			throw new Error(
				`Invalid project entry: each must have string "projectName" and "projectRoot". Got: ${JSON.stringify(entry)}`,
			);
		}
		if (seen.has(entry.projectName)) {
			throw new Error(`Duplicate projectName: "${entry.projectName}"`);
		}
		seen.add(entry.projectName);
		if (!SAFE_ID.test(entry.projectName)) {
			throw new Error(
				`Project "${entry.projectName}": projectName must match ${SAFE_ID} (it becomes a filesystem path component)`,
			);
		}

		// Validate leads config (GEO-152: 1:N multi-lead routing)
		const leads = entry?.leads;
		if (!Array.isArray(leads) || leads.length === 0) {
			throw new Error(
				`Project "${entry.projectName}" is missing "leads" config. Each project must have leads: [{ agentId, chatChannel, match: { labels: [...] } }]`,
			);
		}
		for (let i = 0; i < leads.length; i++) {
			const lead = leads[i];
			if (!lead || typeof lead !== "object") {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}] is invalid: must be an object`,
				);
			}
			if (typeof lead.agentId !== "string" || lead.agentId.length === 0) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].agentId: must be a non-empty string`,
				);
			}
			// FLY-163: Strip deprecated forumChannel / statusTagMap before validation.
			// Existing fork configs may still have these fields; warn loudly but
			// don't break startup. The next-release follow-up will hard-fail.
			if ((lead as Record<string, unknown>).forumChannel !== undefined) {
				console.warn(
					`[loadProjects] "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
						`'forumChannel' is deprecated (FLY-163), ignoring`,
				);
				delete (lead as Record<string, unknown>).forumChannel;
			}
			if ((lead as Record<string, unknown>).statusTagMap !== undefined) {
				console.warn(
					`[loadProjects] "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
						`'statusTagMap' is deprecated (FLY-163), ignoring`,
				);
				delete (lead as Record<string, unknown>).statusTagMap;
			}
			if (
				typeof lead.chatChannel !== "string" ||
				lead.chatChannel.length === 0
			) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].chatChannel: must be a non-empty string`,
				);
			}
			const match = lead.match;
			if (!match || typeof match !== "object") {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].match: must be an object with labels[]`,
				);
			}
			if (!Array.isArray(match.labels) || match.labels.length === 0) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].match.labels: must be a non-empty array of strings`,
				);
			}
			for (const label of match.labels) {
				if (typeof label !== "string" || label.length === 0) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].match.labels: each label must be a non-empty string`,
					);
				}
			}

			// FLY-137 v1.27.2: validate optional department field (used by AgentDispatcher).
			if (lead.department !== undefined) {
				if (
					typeof lead.department !== "string" ||
					lead.department.length === 0
				) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].department: if provided, must be a non-empty string`,
					);
				}
			} else if (Array.isArray(match.labels) && match.labels.length > 1) {
				// Warn (not error) when a Lead has multiple match labels AND no explicit
				// department — first-label inference may not match intent.
				console.warn(
					`[loadProjects] Project "${entry.projectName}" leads[${i}] (agentId="${lead.agentId}") has ` +
						`match.labels.length=${match.labels.length} but no explicit "department" field. ` +
						`AgentDispatcher will derive dept from match.labels[0]="${match.labels[0]}" (lowercased). ` +
						`Set "department" explicitly if this is wrong.`,
				);
			}

			// GEO-252: resolve per-lead bot token from env var
			// Validate botTokenEnv type if present
			if (
				lead.botTokenEnv !== undefined &&
				(typeof lead.botTokenEnv !== "string" || lead.botTokenEnv.length === 0)
			) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].botTokenEnv: must be a non-empty string, got ${JSON.stringify(lead.botTokenEnv)}`,
				);
			}

			// FLY-546: validate optional per-agent voice (headphone mode). Same
			// fail-loud style as botTokenEnv — a malformed voice is a config error
			// caught at load, never at announce time.
			if (lead.voice !== undefined) {
				const where = `Project "${entry.projectName}" leads[${i}].voice`;
				if (typeof lead.voice === "string") {
					// FLY-545 huddle form: bare edge-tts voice id (voice-bridge
					// consumes it verbatim). VoiceRef parity with voice-core.
					if (lead.voice.length === 0) {
						throw new Error(
							`${where}: must be a non-empty string (edge-tts voice id) or an object { voiceId, rate?, pitch? }, got ""`,
						);
					}
				} else if (
					typeof lead.voice !== "object" ||
					lead.voice === null ||
					Array.isArray(lead.voice)
				) {
					throw new Error(
						`${where}: must be a non-empty string (edge-tts voice id) or an object { voiceId, rate?, pitch? }, got ${JSON.stringify(lead.voice)}`,
					);
				} else {
					// FLY-546 headphone form: voiceId + optional prosody.
					const { voiceId, rate, pitch } = lead.voice;
					if (typeof voiceId !== "string" || voiceId.trim().length === 0) {
						throw new Error(
							`${where}.voiceId: must be a non-empty string, got ${JSON.stringify(voiceId)}`,
						);
					}
					if (rate !== undefined && !/^[+-]\d+%$/.test(rate as string)) {
						throw new Error(
							`${where}.rate: must match ±N% (e.g. "-10%"), got ${JSON.stringify(rate)}`,
						);
					}
					if (pitch !== undefined && !/^[+-]\d+Hz$/.test(pitch as string)) {
						throw new Error(
							`${where}.pitch: must match ±NHz (e.g. "+2Hz"), got ${JSON.stringify(pitch)}`,
						);
					}
				}
			}

			// FLY-83: validate optional alert fields
			for (const field of [
				"alertChannel",
				"alertDmUserId",
				"alertBotTokenEnv",
			] as const) {
				const value = (lead as Record<string, unknown>)[field];
				if (
					value !== undefined &&
					(typeof value !== "string" || value.length === 0)
				) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].${field}: must be a non-empty string, got ${JSON.stringify(value)}`,
					);
				}
			}
			if (
				lead.alertFallbackToCore !== undefined &&
				typeof lead.alertFallbackToCore !== "boolean"
			) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].alertFallbackToCore: must be a boolean, got ${JSON.stringify(lead.alertFallbackToCore)}`,
				);
			}
			// FLY-127: validate optional canSpawnRunners type
			if (
				lead.canSpawnRunners !== undefined &&
				typeof lead.canSpawnRunners !== "boolean"
			) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].canSpawnRunners: must be a boolean, got ${JSON.stringify(lead.canSpawnRunners)}`,
				);
			}
			// FLY-127 / FLY-163: Normalize canSpawnRunners default to `true`.
			// PM / triage Leads must explicitly opt out with `canSpawnRunners: false`.
			// The PM/Triage validator below enforces this.
			if (lead.canSpawnRunners === undefined) {
				lead.canSpawnRunners = true;
			}
			// FLY-231: validate optional companion type. Deliberately NOT normalized
			// (Codex R2 MEDIUM-9): consumers use `=== true`, so absent/false leaves the
			// existing in-memory Lead object shape unchanged (byte-compat for the 5
			// existing Leads). Only type-check when present.
			if (lead.companion !== undefined && typeof lead.companion !== "boolean") {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].companion: must be a boolean, got ${JSON.stringify(lead.companion)}`,
				);
			}

			// FLY-247 R5#6: agentId grammar + global exact-key uniqueness.
			if (typeof lead.agentId === "string" && !SAFE_ID.test(lead.agentId)) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].agentId: must match ${SAFE_ID} (it becomes a filesystem path component), got ${JSON.stringify(lead.agentId)}`,
				);
			}
			// FLY-1501 W3: the launch wrapper derives this exact key and the
			// restart-storm gate deliberately refuses to normalize/truncate it.
			// Reject at the config boundary so a config accepted by Bridge can
			// never strand its Lead behind a permanently fail-closed gate.
			const restartChildKey = `lead.${entry.projectName}-${lead.agentId}`;
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(restartChildKey)) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}]: derived restart child_key "${restartChildKey}" must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ (maximum 128 ASCII bytes)`,
				);
			}
			const exactKey = `${entry.projectName}-${lead.agentId}`;
			if (seenExactKeys.has(exactKey)) {
				throw new Error(
					`Exact-key collision: "${exactKey}" is produced by more than one (projectName, agentId) pair — manifests/plists/evidence would collide. Rename one.`,
				);
			}
			seenExactKeys.add(exactKey);

			// FLY-247: validate optional per-lead fleet fields (model, backend).
			// Deliberately NOT normalized (FLY-231 pattern): absent fields stay
			// absent so existing in-memory Lead objects keep their exact shape.
			if (lead.model !== undefined) {
				if (typeof lead.model !== "string" || lead.model.trim().length === 0) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].model: must be a non-empty string, got ${JSON.stringify(lead.model)}`,
					);
				}
				// Plist/system safety boundary (plan §3.1): the model value flows
				// into a launchd plist; reject NUL / C0 control chars / DEL outright
				// rather than trusting downstream escaping alone.
				// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate control-char boundary check
				if (/[\u0000-\u001f\u007f]/.test(lead.model)) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].model: contains control characters (newline/NUL/C0), got ${JSON.stringify(lead.model)}`,
					);
				}
			}
			if (
				lead.playwrightMcp !== undefined &&
				typeof lead.playwrightMcp !== "boolean"
			) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].playwrightMcp: must be a boolean, got ${JSON.stringify(lead.playwrightMcp)}`,
				);
			}
			if (lead.backend !== undefined) {
				if (
					lead.backend !== "claude-code" &&
					lead.backend !== "codex-app-server"
				) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].backend: must be "claude-code" | "codex-app-server" (the Lead backend seam, not the Runner's executor id), got ${JSON.stringify(lead.backend)}`,
					);
				}
			}
			if (lead.playwrightMcp === true && lead.backend === "codex-app-server") {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].playwrightMcp: is only supported by the "claude-code" Lead launcher; codex-app-server cannot consume Claude plugin settings`,
				);
			}
			if (lead.carrier !== undefined) {
				if (lead.carrier !== "v2") {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].carrier: must be "v2", got ${JSON.stringify(lead.carrier)}`,
					);
				}
				if (lead.backend === "codex-app-server") {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].carrier: is only valid for backend "claude-code"; codex-app-server uses its bespoke runtime`,
					);
				}
			}
			// FLY-879: external (customer-facing) Lead marker. Validate type +
			// cross-field invariants. Runs AFTER canSpawnRunners normalization (so
			// the explicit-false requirement is checked against the real boolean) and
			// AFTER companion/backend validation. Placed BEFORE the FLY-245 codex
			// block so an external+codex misconfig yields the external-specific
			// message. Deliberately NOT normalized (FLY-231 pattern): absent stays
			// absent, explicit false stays false — zero shape change for existing Leads.
			if (lead.external !== undefined && typeof lead.external !== "boolean") {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].external: must be a boolean, got ${JSON.stringify(lead.external)}`,
				);
			}
			if (lead.external === true) {
				// A customer-facing external agent must NEVER spawn Runners. Require an
				// EXPLICIT canSpawnRunners:false — since canSpawnRunners was normalized
				// to `true` above when absent, this rejects both absent and true, so a
				// missing field can never silently arm spawn authorization on an
				// outward-facing bot.
				if (lead.canSpawnRunners !== false) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
							`external: true requires an explicit canSpawnRunners: false ` +
							`(a customer-facing external agent must never spawn Runners — FLY-879).`,
					);
				}
				// A lead is exactly one role — external and companion are mutually
				// exclusive (they load different, incompatible rule surfaces).
				if (lead.companion === true) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
							`external: true cannot be combined with companion: true ` +
							`(a lead is exactly one role — FLY-879).`,
					);
				}
				// MVP is claude-code only: the external isolation surface (pane-cred
				// emptying, MCP stripping, external-agent-contract) is wired for the
				// claude-code launcher path. A codex-family external agent is a follow-up.
				if (lead.backend === "codex-app-server") {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
							`external: true is only supported on backend "claude-code" (MVP); ` +
							`"codex-app-server" is a follow-up — FLY-879.`,
					);
				}
			}

			// FLY-671: validate optional per-lead effort (closed CLI enum). Absent
			// stays absent (reverse-compat). Codex Leads have no `--effort` runtime
			// path → reject the mixture as dead config (Codex design review R2 LOW-5,
			// same fail-closed cross-field discipline as the codexProfile block).
			if (lead.effort !== undefined) {
				if (!isLeadEffort(lead.effort)) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].effort: must be "low"|"medium"|"high"|"xhigh"|"max", got ${JSON.stringify(lead.effort)}`,
					);
				}
				if (lead.backend === "codex-app-server") {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
							`effort is not supported on backend "codex-app-server" (Codex has no ` +
							`--effort runtime path — it would be inert config). Remove effort or ` +
							`use the claude-code backend.`,
					);
				}
			}
			// FLY-350: validate codexProfile value if present (only consulted for
			// codex-app-server below). "write-capable" (Z) is now a legal tier; an
			// UNKNOWN value is still fail-loud (R2-4 — never silently default).
			if (
				lead.codexProfile !== undefined &&
				lead.codexProfile !== "companion" &&
				lead.codexProfile !== "write-capable" &&
				lead.codexProfile !== "full-access"
			) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
						`codexProfile must be "companion" | "write-capable" | "full-access", ` +
						`got ${JSON.stringify(lead.codexProfile)}`,
				);
			}
			// Cross-field invariant (FLY-245/FLY-350, runs AFTER canSpawnRunners
			// normalization above): codex-app-server requires canSpawnRunners:false
			// (Codex runner-spawn awaits FLY-251) AND a recognized tier — companion:
			// true OR an explicit codexProfile. FLY-350 (Z): "write-capable" is a
			// recognized tier but is NOT a companion — reject the mixture so the
			// declared capability is unambiguous (R2-4).
			if (lead.backend === "codex-app-server") {
				const recognizedTier =
					lead.companion === true || lead.codexProfile !== undefined;
				if (lead.canSpawnRunners !== false || !recognizedTier) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
							`backend "codex-app-server" requires canSpawnRunners: false AND a ` +
							`recognized Codex tier (companion: true OR codexProfile: ` +
							`"companion"|"write-capable"|"full-access"). Codex ` +
							`runner-spawn awaits FLY-251 (FLY-245 fail-close).`,
					);
				}
				if (lead.codexProfile === "write-capable" && lead.companion === true) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
							`codexProfile "write-capable" cannot be combined with companion: true ` +
							`(a write-capable Lead is not a companion — FLY-350 R2-4).`,
					);
				}
				// FLY-350: a full-access (= Claude-equal) Codex Lead is a write tier —
				// never a companion. Reject the mixture so the declared capability is
				// unambiguous (same SSOT discipline as write-capable above).
				if (lead.codexProfile === "full-access" && lead.companion === true) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
							`codexProfile "full-access" cannot be combined with companion: true ` +
							`(a full-access Lead is a Claude-equal write tier, not a companion — FLY-350).`,
					);
				}
			}

			// FLY-163: PM/Triage validator — runs AFTER deprecated-field strip
			// AND AFTER canSpawnRunners normalization. PM / triage Leads must
			// explicitly opt out of spawn authorization; if they default-true,
			// fail loudly so the operator notices.
			const PM_LABELS = ["pm", "triage"];
			const labelsLower: string[] = (match.labels as unknown[])
				.filter((s): s is string => typeof s === "string")
				.map((s) => s.trim().toLowerCase());
			const hasPmLabel = labelsLower.some((l: string) => PM_LABELS.includes(l));
			if (hasPmLabel && lead.canSpawnRunners !== false) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
						`match.labels contains PM/Triage (${labelsLower.join(",")}) but ` +
						`canSpawnRunners is not false. PM/Triage leads must explicitly ` +
						`set "canSpawnRunners": false. ` +
						`(FLY-163: canSpawnRunners no longer derives from forumChannel.)`,
				);
			}
			// Strip any raw botToken from JSON input — secrets must come via env
			// vars and are hydrated later (in loadProjects), keeping this
			// validator pure/env-free (FLY-247 inc2a R2 #5).
			delete lead.botToken;
		}

		// FLY-173: validate optional generalChannel (project core channel). It
		// is used as a routing authority by the reply-guard (core-channel
		// exemption) and by LeadAlertNotifier (alert→core fallback), so a
		// malformed value must fail loudly at the config boundary, not silently
		// disable the exemption.
		if (
			entry?.generalChannel !== undefined &&
			(typeof entry.generalChannel !== "string" ||
				entry.generalChannel.length === 0)
		) {
			throw new Error(
				`Project "${entry.projectName}" generalChannel: if provided, must be a non-empty string, got ${JSON.stringify(entry.generalChannel)}`,
			);
		}

		// FLY-892 (Step 7): validate optional announcerBotTokenEnv (an env var NAME,
		// not a secret) + strip any raw announcerBotToken from JSON input — the
		// secret is hydrated from env later (loadProjects), keeping this validator
		// pure/env-free (same model as the per-lead botTokenEnv).
		if (
			entry?.announcerBotTokenEnv !== undefined &&
			(typeof entry.announcerBotTokenEnv !== "string" ||
				entry.announcerBotTokenEnv.length === 0)
		) {
			throw new Error(
				`Project "${entry.projectName}" announcerBotTokenEnv: if provided, must be a non-empty string, got ${JSON.stringify(entry.announcerBotTokenEnv)}`,
			);
		}
		delete entry.announcerBotToken;

		// Validate optional memoryAllowedUsers (GEO-204)
		const memoryAllowedUsers = entry?.memoryAllowedUsers;
		if (memoryAllowedUsers !== undefined) {
			if (
				!Array.isArray(memoryAllowedUsers) ||
				memoryAllowedUsers.length === 0
			) {
				throw new Error(
					`Project "${entry.projectName}" memoryAllowedUsers: must be a non-empty array of strings`,
				);
			}
			for (const u of memoryAllowedUsers) {
				if (typeof u !== "string" || u.length === 0) {
					throw new Error(
						`Project "${entry.projectName}" memoryAllowedUsers: each user must be a non-empty string`,
					);
				}
			}
		}

		// FLY-545: validate optional Huddle binding. `null` and `undefined` BOTH
		// mean "huddle disabled" and short-circuit (same deployed-roster null
		// tolerance as `linear` below). Required fields are the four the
		// voice-bridge cannot start without; optional fields are type-checked
		// only when present; unknown keys stay tolerated (loose-validation).
		const huddle = (entry as Record<string, unknown>).huddle;
		if (huddle != null) {
			if (typeof huddle !== "object" || Array.isArray(huddle)) {
				throw new Error(
					`Project "${entry.projectName}" huddle: if provided, must be an object { guildId, voiceChannelId, orchestratorBotTokenEnv, earsBotTokenEnv, commandName?, moveMembers? }, got ${JSON.stringify(huddle)}`,
				);
			}
			const hb = huddle as Record<string, unknown>;
			for (const field of [
				"guildId",
				"voiceChannelId",
				"orchestratorBotTokenEnv",
				"earsBotTokenEnv",
			] as const) {
				if (typeof hb[field] !== "string" || hb[field].length === 0) {
					throw new Error(
						`Project "${entry.projectName}" huddle.${field}: must be a non-empty string, got ${JSON.stringify(hb[field])}`,
					);
				}
			}
			if (hb.commandName !== undefined) {
				// Discord chat-input command grammar (the subset we use): lowercase
				// alphanumerics/dash/underscore, 1-32 chars. Reject at the config
				// boundary instead of a confusing Discord 400 at registration time.
				if (
					typeof hb.commandName !== "string" ||
					!/^[a-z0-9_-]{1,32}$/.test(hb.commandName)
				) {
					throw new Error(
						`Project "${entry.projectName}" huddle.commandName: if provided, must match ^[a-z0-9_-]{1,32}$ (Discord slash-command grammar), got ${JSON.stringify(hb.commandName)}`,
					);
				}
			}
			if (hb.moveMembers !== undefined && typeof hb.moveMembers !== "boolean") {
				throw new Error(
					`Project "${entry.projectName}" huddle.moveMembers: if provided, must be a boolean, got ${JSON.stringify(hb.moveMembers)}`,
				);
			}
		}

		// FLY-371: validate optional Linear binding.
		// Codex R1 HIGH-1: `null` and `undefined` BOTH mean "no binding" and must
		// short-circuit BEFORE the object/team checks — the deployed roster
		// literally has `linear: null` on every project, and `typeof null ===
		// "object"` would otherwise sail past an object check and then throw on the
		// required `team`, breaking Bridge startup. Neither is normalized (FLY-231
		// pattern): absent stays absent, null stays null.
		const linear = (entry as Record<string, unknown>).linear;
		if (linear != null) {
			if (typeof linear !== "object" || Array.isArray(linear)) {
				throw new Error(
					`Project "${entry.projectName}" linear: if provided, must be an object { team, project?, label? }, got ${JSON.stringify(linear)}`,
				);
			}
			const lb = linear as Record<string, unknown>;
			// team is the minimal required field — nothing resolves without it.
			// Codex R1 LOW-7: reject whitespace-only operator-authored routing values
			// at the config boundary, not later as a confusing Linear 404.
			if (typeof lb.team !== "string" || lb.team.trim().length === 0) {
				throw new Error(
					`Project "${entry.projectName}" linear.team: must be a non-empty string (Linear team key, e.g. "FLY"), got ${JSON.stringify(lb.team)}`,
				);
			}
			if (
				lb.project !== undefined &&
				(typeof lb.project !== "string" || lb.project.trim().length === 0)
			) {
				throw new Error(
					`Project "${entry.projectName}" linear.project: if provided, must be a non-empty string (Linear Project name), got ${JSON.stringify(lb.project)}`,
				);
			}
			if (
				lb.label !== undefined &&
				(typeof lb.label !== "string" || lb.label.trim().length === 0)
			) {
				throw new Error(
					`Project "${entry.projectName}" linear.label: if provided, must be a non-empty string (scope label name), got ${JSON.stringify(lb.label)}`,
				);
			}
		}
	}

	// FLY-1726: one shared identity validator owns the cross-project invariants
	// that the richer TeamLead schema cannot safely enforce one row at a time:
	// bare Lead IDs, expected bot IDs, and effective state directories must all
	// be globally unique; token-managed Leads require an independent botUserId.
	compileLeadIdentityRegistry(raw);

	return raw as ProjectEntry[];
}

/**
 * FLY-371: resolve a Flywheel project's Linear binding by `projectName`.
 *
 * Returns `undefined` for: unknown project, a project with no `linear` field,
 * OR a project with `linear: null` (Codex R1 HIGH-1 — null coerces to undefined
 * so consumers never have to defend against null).
 */
export function resolveProjectLinearBinding(
	projects: ProjectEntry[],
	projectName: string,
): ProjectLinearBinding | undefined {
	return (
		projects.find((p) => p.projectName === projectName)?.linear ?? undefined
	);
}

export function getProjectRoot(
	projects: ProjectEntry[],
	projectName: string,
): string | undefined {
	return projects.find((p) => p.projectName === projectName)?.projectRoot;
}

/**
 * FLY-534: resolve a caller-supplied `projectName` to the configured project's
 * EXACT (canonical) name, case-insensitively.
 *
 * Configured project names are canonical (e.g. lowercase "sub"); callers —
 * Leads, humans, cron — may send a differently-cased value ("Sub"/"SUB").
 * Every projectName lookup on the runs path is case-SENSITIVE: the dispatcher's
 * `blueprintsByProject.get(name)`, the dept-scope / lead-scope `projects.find
 * (p => p.projectName === name)`, the CommDB path, the tmux session name. A
 * case mismatch therefore surfaces as `No runtime for project: <name>` or a
 * DEPT_SCOPE_REJECT `project_unknown`. Canonicalizing once at the route
 * boundary makes ALL of those resolve consistently with a single configured
 * name flowing downstream (no half-normalized "Sub" runner / comm.db / tmux).
 *
 * An EXACT-case match wins over a different-case one (so a deployment that
 * legitimately configured both "Sub" and "sub" keeps exact semantics). A
 * genuinely unknown project is returned unchanged so it still rejects
 * downstream exactly as before — this never invents a project.
 */
export function resolveCanonicalProjectName(
	projects: ProjectEntry[],
	projectName: string,
): string {
	// Exact match first — never rewrite a name that is already configured as-is.
	if (projects.some((p) => p.projectName === projectName)) {
		return projectName;
	}
	// Case-insensitive fallback. If a (mis)configuration carries more than one
	// project differing ONLY by case, the match is AMBIGUOUS — fail CLOSED
	// (return the input unchanged so it rejects downstream as before) rather
	// than silently pick one by config order. Project names are expected to be
	// unique case-insensitively; this only guards the misconfigured case.
	const lowered = projectName.toLowerCase();
	const matches = projects.filter(
		(p) => p.projectName.toLowerCase() === lowered,
	);
	return matches.length === 1 ? matches[0]!.projectName : projectName;
}

export function resolveLeadForIssue(
	projects: ProjectEntry[],
	projectName: string,
	issueLabels: string[] = [],
): { lead: LeadConfig; matchMethod: "label" | "general" } {
	const project = projects.find((p) => p.projectName === projectName);
	if (!project) {
		throw new Error(
			`No project found for "${projectName}". Cannot resolve lead config.`,
		);
	}

	// Label match (case-insensitive, first match wins)
	const normalizedLabels = new Set(issueLabels.map((l) => l.toLowerCase()));
	for (const lead of project.leads) {
		const hasMatch = lead.match.labels.some((l) =>
			normalizedLabels.has(l.toLowerCase()),
		);
		if (hasMatch) return { lead, matchMethod: "label" };
	}

	// No match — use first lead as default, flag as "general" match
	return { lead: project.leads[0]!, matchMethod: "general" };
}

/**
 * Validate memory API IDs against project config. Fail-closed:
 * rejects if project lacks memoryAllowedUsers (memory not configured).
 */
export function validateMemoryIds(
	projects: ProjectEntry[],
	projectName: string,
	agentId: string | undefined,
	userId: string,
): { valid: true } | { valid: false; error: string } {
	const project = projects.find((p) => p.projectName === projectName);
	if (!project) {
		return {
			valid: false,
			error: `unknown project_name: "${projectName}"`,
		};
	}
	// GEO-203: agentId optional for search (cross-agent queries omit it)
	if (agentId !== undefined) {
		const knownAgents = project.leads.map((l) => l.agentId);
		if (!knownAgents.includes(agentId)) {
			return {
				valid: false,
				error: `unknown agent_id: "${agentId}" for project "${projectName}"`,
			};
		}
	}
	if (!project.memoryAllowedUsers) {
		return {
			valid: false,
			error: `memory not configured for project "${projectName}" (missing memoryAllowedUsers)`,
		};
	}
	if (!project.memoryAllowedUsers.includes(userId)) {
		return {
			valid: false,
			error: `unknown user_id: "${userId}" for project "${projectName}"`,
		};
	}
	return { valid: true };
}
