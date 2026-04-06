import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LeadConfig {
	agentId: string;
	/** Discord Forum channel ID. Optional: PM leads (no Runner) may omit this. */
	forumChannel?: string;
	chatChannel: string;
	match: {
		labels: string[];
	};
	/** Status → Discord Forum tag ID mapping for this lead's forum channel (GEO-253).
	 *  Once defined, fully replaces the global STATUS_TAG_MAP for this lead.
	 *  Omit to fall back to global STATUS_TAG_MAP. */
	statusTagMap?: Record<string, string[]>;
	/** Env var name for this lead's Discord bot token (e.g., "PETER_BOT_TOKEN"). */
	botTokenEnv?: string;
	/** Resolved bot token (populated at load time from botTokenEnv). NOT from JSON input. */
	botToken?: string;
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
			// GEO-275: forumChannel is optional (PM leads don't need a forum)
			if (lead.forumChannel !== undefined) {
				if (
					typeof lead.forumChannel !== "string" ||
					lead.forumChannel.length === 0
				) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].forumChannel: if provided, must be a non-empty string`,
					);
				}
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

			// GEO-253: validate optional statusTagMap
			const stm = lead.statusTagMap;
			if (stm !== undefined) {
				if (typeof stm !== "object" || stm === null || Array.isArray(stm)) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].statusTagMap: must be a non-null, non-array object`,
					);
				}
				if (Object.keys(stm).length === 0) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}].statusTagMap: must not be empty (omit the field to use global fallback)`,
					);
				}
				for (const [status, tagIds] of Object.entries(stm)) {
					if (!Array.isArray(tagIds) || tagIds.length === 0) {
						throw new Error(
							`Project "${entry.projectName}" leads[${i}].statusTagMap["${status}"]: must be a non-empty array of tag ID strings`,
						);
					}
					for (const tagId of tagIds) {
						if (typeof tagId !== "string" || tagId.length === 0) {
							throw new Error(
								`Project "${entry.projectName}" leads[${i}].statusTagMap["${status}"]: each tag ID must be a non-empty string`,
							);
						}
					}
				}
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
