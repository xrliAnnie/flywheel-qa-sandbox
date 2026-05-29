import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

	if (!Array.isArray(raw)) {
		throw new Error("FLYWHEEL_PROJECTS must be a JSON array");
	}

	const seen = new Set<string>();
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
			// Strip any raw botToken from JSON input first — secrets must come via env vars
			delete lead.botToken;
			const botTokenEnv = lead.botTokenEnv;
			if (typeof botTokenEnv === "string" && botTokenEnv.length > 0) {
				const resolved = process.env[botTokenEnv];
				if (resolved) {
					lead.botToken = resolved;
				} else {
					console.warn(
						`[loadProjects] "${entry.projectName}" leads[${i}]: botTokenEnv="${botTokenEnv}" not found in env — will fall back to DISCORD_BOT_TOKEN`,
					);
				}
			}
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
