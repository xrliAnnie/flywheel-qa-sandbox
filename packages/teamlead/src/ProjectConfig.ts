import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LeadConfig {
	agentId: string;
	forumChannel: string;
	chatChannel: string;
	match: {
		labels: string[];
	};
	/** Runtime adapter for this lead. Default: "openclaw". */
	runtime?: "openclaw" | "claude-discord";
	/** Discord control channel ID for claude-discord runtime (hidden, bot-only). */
	controlChannel?: string;
}

export interface ProjectEntry {
	projectName: string;
	projectRoot: string;
	projectRepo?: string;
	leads: LeadConfig[];
	generalChannel?: string;
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
				`Project "${entry.projectName}" is missing "leads" config. Each project must have leads: [{ agentId, forumChannel, chatChannel, match: { labels: [...] } }]`,
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
			if (
				typeof lead.forumChannel !== "string" ||
				lead.forumChannel.length === 0
			) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].forumChannel: must be a non-empty string`,
				);
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

			// GEO-195: validate runtime config
			const runtime = lead.runtime;
			if (
				runtime !== undefined &&
				runtime !== "openclaw" &&
				runtime !== "claude-discord"
			) {
				throw new Error(
					`Project "${entry.projectName}" leads[${i}].runtime: must be "openclaw" or "claude-discord", got "${runtime}"`,
				);
			}
			if (runtime === "claude-discord") {
				if (
					typeof lead.controlChannel !== "string" ||
					lead.controlChannel.length === 0
				) {
					throw new Error(
						`Project "${entry.projectName}" leads[${i}]: runtime="claude-discord" requires a non-empty controlChannel`,
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
