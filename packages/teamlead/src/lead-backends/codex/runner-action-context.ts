import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	type CompiledLeadIdentityRow,
	identityEnvProjection,
	resolveLeadIdentityRow,
} from "flywheel-comm/lead-identity";
import { resolveCodexLeadCapabilities } from "flywheel-config";

export interface RunnerActionContext {
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly projectsPath: string;
	readonly projectRoot: string;
	/** Re-read before every handler; no DB/HTTP effects precede this check. */
	assertCurrent(): CompiledLeadIdentityRow;
}

export function createRunnerActionContext(
	input: NodeJS.ProcessEnv,
): RunnerActionContext {
	const env = Object.freeze({ ...input });
	if (env.FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS !== "1") {
		throw new Error(
			"runner capability requires explicit validated environment marker",
		);
	}
	const required = (key: string): string => {
		const value = env[key];
		if (!value) throw new Error(`runner identity context missing ${key}`);
		return value;
	};
	const projectsPath = required("FLYWHEEL_PROJECTS_FILE");
	const homeDir = env.FLYWHEEL_SUMMARY_CONFIG_HOME ?? required("HOME");
	if (!isAbsolute(projectsPath) || !isAbsolute(homeDir))
		throw new Error("runner identity paths must be absolute");
	const projectName = required("FLYWHEEL_PROJECT_NAME");
	const leadId = required("FLYWHEEL_LEAD_ID");
	const profile = required("FLYWHEEL_CODEX_LEAD_PROFILE");
	const read = (): CompiledLeadIdentityRow => {
		const row = resolveLeadIdentityRow({
			projectsPath,
			projectName,
			leadId,
			homeDir,
		});
		if (!resolveCodexLeadCapabilities(row.lead).runnerActionsEnabled) {
			throw new Error(
				"runner capability is disabled or invalid in current registry",
			);
		}
		if (row.lead.codexProfile !== profile)
			throw new Error(
				"runner capability profile changed; managed restart required",
			);
		// A registry byte digest changes when any Lead is edited. The per-identity
		// digest and coordinates, not that whole-file digest, bind a live caller.
		for (const line of identityEnvProjection(row.identity)) {
			const split = line.indexOf("=");
			const name = line.slice(0, split);
			if (name === "FLYWHEEL_LEAD_PROJECTS_DIGEST") continue;
			if (env[name] !== line.slice(split + 1))
				throw new Error(`runner identity environment mismatch: ${name}`);
		}
		return row;
	};
	const initial = read();
	if (
		typeof initial.project.projectRoot !== "string" ||
		!isAbsolute(initial.project.projectRoot)
	) {
		throw new Error("runner identity project root must be absolute");
	}
	const projectRoot = realpathSync(initial.project.projectRoot);
	return Object.freeze({
		env,
		projectsPath,
		projectRoot,
		assertCurrent() {
			const row = read();
			if (
				typeof row.project.projectRoot !== "string" ||
				realpathSync(row.project.projectRoot) !== projectRoot
			) {
				throw new Error(
					"runner identity project root changed; managed restart required",
				);
			}
			return row;
		},
	});
}
