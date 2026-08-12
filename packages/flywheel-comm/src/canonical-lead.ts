import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	compileLeadIdentityRows,
	type IdentityLeadRow,
} from "./lead-identity.js";

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
			/** Retained only for wire compatibility; strict FLY-1726 validation rejects it as source_error. */
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

export type CanonicalLeadCatalog =
	| {
			status: "ok";
			projects: CanonicalProject[];
			projectsDigest: string;
			ambiguousLeadIds: string[];
	  }
	| { status: "source_error"; error: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function digest(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

/**
 * Compatibility facade for FLY-1309 callers. Parsing and identity validation
 * are delegated to the strict FLY-1726 compiler so there is no second, looser
 * registry authority.
 */
export function readCanonicalLeadCatalog(
	projectsPath: string,
	deps: { readFile?: (path: string) => string } = {},
): CanonicalLeadCatalog {
	try {
		const rawText = (deps.readFile ?? ((path) => readFileSync(path, "utf8")))(
			projectsPath,
		);
		const projectsDigest = digest(rawText);
		const rows = compileLeadIdentityRows(JSON.parse(rawText), {
			projectsDigest,
		});
		const projectsByName = new Map<string, CanonicalProject>();
		for (const row of rows) {
			let project = projectsByName.get(row.identity.projectName);
			if (project === undefined) {
				project = { projectName: row.identity.projectName, leads: [] };
				projectsByName.set(row.identity.projectName, project);
			}
			project.leads.push(row.lead as IdentityLeadRow as CanonicalLeadConfig);
		}
		return {
			status: "ok",
			projects: [...projectsByName.values()],
			projectsDigest,
			ambiguousLeadIds: [],
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
	const matches = catalog.projects.flatMap((project) =>
		project.leads
			.filter((lead) => lead.agentId === input.leadId)
			.map((lead) => ({ projectName: project.projectName, lead })),
	);
	if (matches.length === 0) {
		return {
			status: "valid_but_lead_absent",
			leadId: input.leadId,
			...(input.projectHint ? { projectHint: input.projectHint } : {}),
			projectsDigest: catalog.projectsDigest,
		};
	}
	const match = matches[0]!;
	return {
		status: "ok",
		canonicalProject: match.projectName,
		leadKey: `${match.projectName}-${input.leadId}`,
		lead: match.lead,
		projectsDigest: catalog.projectsDigest,
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
