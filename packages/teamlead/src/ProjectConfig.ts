import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LeadBackendId } from "./lead-backends/lead-backend.js";

export interface LeadConfig {
	agentId: string;
	chatChannel: string;
	match: {
		labels: string[];
	};
	/** Env var name for this lead's Discord bot token (e.g., "PETER_BOT_TOKEN"). */
	botTokenEnv?: string;
	/** Resolved bot token (populated at load time from botTokenEnv). NOT from JSON input. */
	botToken?: string;
	/**
	 * FLY-83: Discord channel ID where LeadWatchdog / lead-alert.sh post
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
	 * Discord adapter + LeadWatchdog coverage, but with NO Runner spawning, NO
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

export interface ProjectEntry {
	projectName: string;
	projectRoot: string;
	projectRepo?: string;
	leads: LeadConfig[];
	generalChannel?: string;
	/** Memory API user_id allowlist. Fail-closed: requests rejected if not configured. */
	memoryAllowedUsers?: string[];
}

export function loadProjects(): ProjectEntry[] {
	let raw: unknown;

	// Source 1: FLYWHEEL_PROJECTS env var (JSON array)
	const envProjects = process.env.FLYWHEEL_PROJECTS;
	if (envProjects) {
		raw = JSON.parse(envProjects);
	} else {
		// Source 2: ~/.flywheel/projects.json
		const filePath = join(homedir(), ".flywheel", "projects.json");
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
	}

	return projects;
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
			if (lead.backend !== undefined) {
				if (
					lead.backend !== "claude-code" &&
					lead.backend !== "codex-app-server"
				) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].backend: must be "claude-code" | "codex-app-server" (the Lead backend seam, not the Runner's executor id), got ${JSON.stringify(lead.backend)}`,
					);
				}
				// Cross-field invariant (runs AFTER canSpawnRunners normalization
				// above): codex-app-server is only legal on a read-only companion.
				if (
					lead.backend === "codex-app-server" &&
					(lead.companion !== true || lead.canSpawnRunners !== false)
				) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}] (${lead.agentId}): ` +
							`backend "codex-app-server" requires companion: true AND ` +
							`canSpawnRunners: false. Write-capable Codex Leads are not ` +
							`unlocked (FLY-245 fail-close).`,
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
	}

	return raw as ProjectEntry[];
}

export function getProjectRoot(
	projects: ProjectEntry[],
	projectName: string,
): string | undefined {
	return projects.find((p) => p.projectName === projectName)?.projectRoot;
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
