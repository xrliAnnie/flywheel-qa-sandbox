/**
 * FLY-1185 §2.10 — per-project cleanup policy (CleanupPolicyByProject).
 *
 * Built ONCE at the Bridge composition root BEFORE the first boot reconcile
 * (run-infra hoists this above pruneOrphans/reconcile) and injected into
 * every deletion entry (Layer A, sweep, QA teardown, issue closeout).
 *
 * Resolution per project (fail-closed):
 *   - no `.flywheel/config.yaml`            → enabled, empty protected list
 *     (default empty = today's behavior — config, NOT a feature flag);
 *   - config parses, no `cleanup:` block    → enabled, empty list;
 *   - `cleanup.protected_branches` valid    → enabled with that list;
 *   - config unreadable / YAML broken /
 *     `cleanup:` block malformed            → **disabled(reason)** — every
 *     deleter for that project makes ZERO delete calls until fixed.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectEntry } from "../ProjectConfig.js";

export type CleanupPolicy =
	| { enabled: true; protectedBranches: string[] }
	| { enabled: false; reason: string };

export type CleanupPolicyByProject = Map<string, CleanupPolicy>;

/** Default when nothing is configured — enabled, nothing extra protected. */
export const DEFAULT_CLEANUP_POLICY: CleanupPolicy = {
	enabled: true,
	protectedBranches: [],
};

export function resolveCleanupPolicyFromYaml(yamlText: string): CleanupPolicy {
	let raw: unknown;
	try {
		raw = parseYaml(yamlText);
	} catch (err) {
		return {
			enabled: false,
			reason: `config_yaml_unparseable: ${(err as Error).message}`,
		};
	}
	if (raw === null || raw === undefined) return DEFAULT_CLEANUP_POLICY;
	if (typeof raw !== "object") {
		return { enabled: false, reason: "config_not_an_object" };
	}
	const cleanup = (raw as Record<string, unknown>).cleanup;
	if (cleanup === undefined || cleanup === null) return DEFAULT_CLEANUP_POLICY;
	if (typeof cleanup !== "object" || Array.isArray(cleanup)) {
		return { enabled: false, reason: "cleanup_block_not_an_object" };
	}
	const pb = (cleanup as Record<string, unknown>).protected_branches;
	if (pb === undefined || pb === null) {
		return DEFAULT_CLEANUP_POLICY;
	}
	if (!Array.isArray(pb) || pb.some((x) => typeof x !== "string")) {
		return { enabled: false, reason: "protected_branches_not_string_array" };
	}
	return {
		enabled: true,
		protectedBranches: (pb as string[]).map((s) => s.trim()).filter(Boolean),
	};
}

export function buildCleanupPolicies(
	projects: Array<Pick<ProjectEntry, "projectName" | "projectRoot">>,
	readFileFn: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
	existsFn: (p: string) => boolean = (p) => fs.existsSync(p),
): CleanupPolicyByProject {
	const map: CleanupPolicyByProject = new Map();
	for (const project of projects) {
		const configPath = path.join(
			project.projectRoot,
			".flywheel",
			"config.yaml",
		);
		try {
			if (!existsFn(configPath)) {
				map.set(project.projectName, DEFAULT_CLEANUP_POLICY);
				continue;
			}
			const text = readFileFn(configPath);
			map.set(project.projectName, resolveCleanupPolicyFromYaml(text));
		} catch (err) {
			map.set(project.projectName, {
				enabled: false,
				reason: `config_read_failed: ${(err as Error).message}`,
			});
		}
	}
	return map;
}

/** Policy lookup with the fail-closed default for unknown projects. */
export function policyFor(
	policies: CleanupPolicyByProject | undefined,
	projectName: string,
): CleanupPolicy {
	if (!policies) return DEFAULT_CLEANUP_POLICY;
	return (
		policies.get(projectName) ?? {
			enabled: false,
			reason: "project_not_in_policy_map",
		}
	);
}
