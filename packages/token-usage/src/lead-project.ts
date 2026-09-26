import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECTS } from "./classifier.js";

/**
 * Lead → project is ONE-TO-MANY (a project can own several leads, but each lead
 * belongs to exactly ONE project — no lead spans projects). So this is a 1:1 lookup.
 *
 * The AUTHORITATIVE source is the fleet config `~/.flywheel/projects.json`
 * (each project has `projectName` + `leads[].agentId`, where agentId == the
 * lead-workspace name). `loadLeadProjectMap()` derives the map from it. The map
 * below is only a hardcoded FALLBACK for when the config is unreadable (and for
 * test slots, which aren't in projects.json).
 */
export const DEFAULT_LEAD_PROJECT: Record<string, string> = {
	"flywheel-eng-lead": "flywheel",
	"flywheel-cos-lead": "flywheel",
	"cos-lead": "geoforge3d",
	"flywheel-test-1": "flywheel",
	"flywheel-test-2": "flywheel",
	"flywheel-test-3": "flywheel",
	"flywheel-test-4": "flywheel",
	"sub-lead": "sub",
	"tidal-echo-content-lead": "tidal-echo",
	"tidal-echo-cos-lead": "tidal-echo",
	"joycon-lead": "joycon-typeless",
	"product-lead": "geoforge3d",
	"ops-lead": "geoforge3d",
	"rafiki-lead": "growth",
	"reflection-lead": "growth",
	"mufasa-lead": "growth",
	"belle-lead": "personal-assistant",
};

/** Fallback bucket for leads not in the map and not matching a known prefix. */
export const LEAD_FALLBACK_PROJECT = "(其它)";

/**
 * Display-only projects: names the founder recognizes but that are NOT yet
 * registered in `projects.json`. They are listed in the report (with 0 usage
 * and a "(未立项)" tag) so they're visible, WITHOUT registering them as managed
 * projects (registration = the Bridge/watchdog expects a Lead + config). When a
 * project is truly stood up, add it to `projects.json` and remove it here.
 */
export const DISPLAY_ONLY_PROJECTS: readonly string[] = ["polaris"];

/** Default authoritative fleet-config path. */
export const DEFAULT_PROJECTS_JSON = path.join(
	os.homedir(),
	".flywheel",
	"projects.json",
);

interface ProjectsJsonEntry {
	projectName?: string;
	leads?: { agentId?: string }[];
}

/**
 * Derive the lead→project map from the fleet config `projects.json` (authoritative;
 * agentId == lead-workspace name). Config entries override the hardcoded fallback.
 * Returns the fallback alone if the file is missing/unreadable (so the report still runs).
 */
export function loadLeadProjectMap(
	projectsJsonPath: string = DEFAULT_PROJECTS_JSON,
	fallback: Record<string, string> = DEFAULT_LEAD_PROJECT,
): Record<string, string> {
	let parsed: ProjectsJsonEntry[];
	try {
		parsed = JSON.parse(
			readFileSync(projectsJsonPath, "utf8"),
		) as ProjectsJsonEntry[];
	} catch {
		console.warn(
			`[token-usage] could not read fleet config ${projectsJsonPath}; using fallback lead→project map`,
		);
		return { ...fallback };
	}
	if (!Array.isArray(parsed)) return { ...fallback };
	const map: Record<string, string> = { ...fallback };
	for (const proj of parsed) {
		const name = proj?.projectName;
		if (!name || !Array.isArray(proj.leads)) continue;
		for (const lead of proj.leads) {
			if (lead?.agentId) map[lead.agentId] = name;
		}
	}
	return map;
}

/**
 * The canonical list of known project names from the fleet config `projects.json`
 * (each entry's `projectName`). Used to list every project in the report — even
 * ones with no usage that day (shown as 0). Returns `[]` if the config is
 * unreadable (so the report still renders, just without 0-padding).
 */
export function loadKnownProjects(
	projectsJsonPath: string = DEFAULT_PROJECTS_JSON,
): string[] {
	try {
		const parsed = JSON.parse(
			readFileSync(projectsJsonPath, "utf8"),
		) as ProjectsJsonEntry[];
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((p) => p?.projectName)
			.filter((n): n is string => typeof n === "string" && n.length > 0);
	} catch {
		return [];
	}
}

/**
 * Resolve a lead's owning project (exactly one). Explicit map wins; otherwise a
 * known-project name prefix; otherwise the fallback bucket.
 */
export function resolveLeadProject(
	lead: string,
	map: Record<string, string> = DEFAULT_LEAD_PROJECT,
): string {
	const explicit = map[lead];
	if (explicit) return explicit;
	for (const p of PROJECTS) {
		if (lead.startsWith(p)) return p;
	}
	return LEAD_FALLBACK_PROJECT;
}
