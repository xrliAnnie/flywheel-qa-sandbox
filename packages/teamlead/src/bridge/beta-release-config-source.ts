import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import {
	type BetaReleaseConfig,
	parseBetaReleaseConfig,
} from "flywheel-config";
import { parse } from "yaml";
import type { ProjectEntry } from "../ProjectConfig.js";

export type BetaProject = Pick<
	ProjectEntry,
	"projectName" | "projectRoot" | "projectRepo"
>;
export interface BetaProjectConfig extends BetaProject {
	config?: BetaReleaseConfig;
	revision?: string;
	reason:
		| "config_invalid"
		| "unconfigured"
		| "credential_missing"
		| "credential_shared"
		| "binding_invalid"
		| null;
}

/** Refresh from canonical roster roots, independently of management-console enablement. */
export async function readBetaReleaseProjects(
	projects: readonly BetaProject[],
	env: Readonly<Record<string, string | undefined>>,
): Promise<BetaProjectConfig[]> {
	const entries = await Promise.all(
		projects.map(async (project): Promise<BetaProjectConfig> => {
			if (
				!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(
					project.projectRepo ?? "",
				) ||
				[".", ".."].includes(project.projectRepo?.split("/")[1] ?? "")
			) {
				return { ...project, reason: "binding_invalid" };
			}
			try {
				const root = await realpath(project.projectRoot);
				const file = await realpath(join(root, ".flywheel/config.yaml"));
				if (!file.startsWith(`${root}${sep}`))
					return { ...project, reason: "binding_invalid" };
				const source = await readFile(file, "utf8");
				const raw = parse(source);
				if (!raw || typeof raw !== "object" || Array.isArray(raw))
					throw new Error("config_invalid");
				const config = parseBetaReleaseConfig(raw.beta_release);
				return {
					...project,
					config,
					revision: createHash("sha256").update(source).digest("hex"),
					reason: !config?.workflow_file
						? "unconfigured"
						: !config.token_env || !env[config.token_env]?.trim()
							? "credential_missing"
							: null,
				};
			} catch (error) {
				// YAML errors can contain source lines, including unrelated secrets.
				return {
					...project,
					reason:
						(error as NodeJS.ErrnoException).code === "ENOENT"
							? "unconfigured"
							: "config_invalid",
				};
			}
		}),
	);
	for (const entry of entries) {
		const key = entry.config?.token_env;
		if (!key) continue;
		if (
			entries.some(
				(other) =>
					other !== entry &&
					other.config?.token_env &&
					(other.config.token_env === key ||
						(env[key] && env[key] === env[other.config.token_env])),
			)
		) {
			entry.reason = "credential_shared";
		}
	}
	return entries;
}
