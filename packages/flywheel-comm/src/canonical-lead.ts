import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type LeadBackendId = "claude-code" | "codex-app-server";

export interface CanonicalLeadConfig {
	agentId: string;
	backend?: LeadBackendId;
	[key: string]: unknown;
}

export type CanonicalLeadResolution =
	| {
			status: "ok";
			canonicalProject: string;
			leadKey: string;
			lead: CanonicalLeadConfig;
			projectsDigest: string;
	  }
	| {
			status: "valid_but_lead_absent";
			leadId: string;
			projectHint?: string;
			projectsDigest: string;
	  }
	| {
			status: "ambiguous";
			leadId: string;
			projects: string[];
			projectsDigest: string;
	  }
	| { status: "source_error"; error: string };

export interface CanonicalProject {
	projectName: string;
	leads: CanonicalLeadConfig[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseProjects(raw: string): CanonicalProject[] {
	const parsed = JSON.parse(raw) as unknown;
	const candidates =
		parsed !== null &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		"projects" in parsed
			? (parsed as { projects: unknown }).projects
			: parsed;
	if (!Array.isArray(candidates)) {
		throw new Error("projects.json must be an array or {projects: array}");
	}
	return candidates.map((candidate, projectIndex) => {
		if (candidate === null || typeof candidate !== "object") {
			throw new Error(`projects[${projectIndex}] must be an object`);
		}
		const project = candidate as Record<string, unknown>;
		if (
			typeof project.projectName !== "string" ||
			project.projectName.length === 0
		) {
			throw new Error(
				`projects[${projectIndex}].projectName must be non-empty`,
			);
		}
		if (!Array.isArray(project.leads)) {
			throw new Error(`projects[${projectIndex}].leads must be an array`);
		}
		const leads = project.leads.map((candidateLead, leadIndex) => {
			if (candidateLead === null || typeof candidateLead !== "object") {
				throw new Error(
					`projects[${projectIndex}].leads[${leadIndex}] must be an object`,
				);
			}
			const lead = candidateLead as Record<string, unknown>;
			if (typeof lead.agentId !== "string" || lead.agentId.length === 0) {
				throw new Error(
					`projects[${projectIndex}].leads[${leadIndex}].agentId must be non-empty`,
				);
			}
			if (
				lead.backend !== undefined &&
				lead.backend !== "claude-code" &&
				lead.backend !== "codex-app-server"
			) {
				throw new Error(
					`projects[${projectIndex}].leads[${leadIndex}].backend is invalid`,
				);
			}
			return lead as CanonicalLeadConfig;
		});
		return { projectName: project.projectName, leads };
	});
}

export type CanonicalLeadCatalog =
	| {
			status: "ok";
			projects: CanonicalProject[];
			projectsDigest: string;
			ambiguousLeadIds: string[];
	  }
	| { status: "source_error"; error: string };

/** Parse the canonical projects source once for fleet-wide diagnostics. */
export function readCanonicalLeadCatalog(
	projectsPath: string,
	deps: { readFile?: (path: string) => string } = {},
): CanonicalLeadCatalog {
	let raw: string;
	try {
		raw = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(
			projectsPath,
		);
		const projects = parseProjects(raw);
		const counts = new Map<string, number>();
		for (const project of projects) {
			for (const lead of project.leads) {
				counts.set(lead.agentId, (counts.get(lead.agentId) ?? 0) + 1);
			}
		}
		return {
			status: "ok",
			projects,
			projectsDigest: createHash("sha256").update(raw).digest("hex"),
			ambiguousLeadIds: [...counts.entries()]
				.filter(([, count]) => count > 1)
				.map(([leadId]) => leadId)
				.sort(),
		};
	} catch (error) {
		return { status: "source_error", error: errorMessage(error) };
	}
}

export function resolveCanonicalLead(
	input: { leadId: string; projectHint?: string; projectsPath: string },
	deps: { readFile?: (path: string) => string } = {},
): CanonicalLeadResolution {
	const catalog = readCanonicalLeadCatalog(input.projectsPath, deps);
	if (catalog.status === "source_error") return catalog;
	const { projects, projectsDigest } = catalog;
	const matches = projects.flatMap((project) =>
		project.leads
			.filter((lead) => lead.agentId === input.leadId)
			.map((lead) => ({ projectName: project.projectName, lead })),
	);
	if (matches.length === 0) {
		return {
			status: "valid_but_lead_absent",
			leadId: input.leadId,
			...(input.projectHint ? { projectHint: input.projectHint } : {}),
			projectsDigest,
		};
	}
	if (matches.length > 1) {
		return {
			status: "ambiguous",
			leadId: input.leadId,
			projects: matches.map((match) => match.projectName).sort(),
			projectsDigest,
		};
	}
	const match = matches[0]!;
	return {
		status: "ok",
		canonicalProject: match.projectName,
		leadKey: `${match.projectName}-${input.leadId}`,
		lead: match.lead,
		projectsDigest,
	};
}

function normalizeLeadBackend(value: string | undefined): LeadBackendId {
	return value === "codex-app-server" ? "codex-app-server" : "claude-code";
}

/** Shared desired-backend precedence consumed by flywheel-comm and teamlead. */
export function effectiveLeadBackend(
	explicit: LeadBackendId | undefined,
	legacy?: string | null,
): { backend: LeadBackendId; source: "explicit" | "legacy" | "default" } {
	if (explicit !== undefined) {
		return { backend: normalizeLeadBackend(explicit), source: "explicit" };
	}
	if (typeof legacy === "string" && legacy.length > 0) {
		return { backend: normalizeLeadBackend(legacy), source: "legacy" };
	}
	return { backend: "claude-code", source: "default" };
}
