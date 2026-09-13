import { identityEnvProjection } from "flywheel-comm/lead-identity";
import { createRunnerActionContext } from "./runner-action-context.js";

/** Non-secret canonical context only. Carrier bearer travels by name/broker. */
export interface RunnerActionMcpContext {
	env: Record<string, string>;
}
const OPTIONAL_CONTEXT_NAMES = [
	"FLYWHEEL_SUMMARY_CONFIG_HOME",
	"FLYWHEEL_STATE_DIR",
	"FLYWHEEL_COMM_ROOT",
	"FLYWHEEL_GATEWAY_STATE_DB",
	"FLYWHEEL_GATEWAY_COMM_DB",
	"FLYWHEEL_LEAD_LEASE_MODE",
	"FLYWHEEL_LEAD_LEASE_MODE_FILE",
	"FLYWHEEL_LEAD_LEASE_DB",
	"FLYWHEEL_LEAD_LEASE_KEY",
	"FLYWHEEL_LEAD_GENERATION",
	"FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR",
	"FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE",
] as const;
export const NONSECRET_RUNNER_KEY_NAMES = new Set([
	"FLYWHEEL_LEAD_KEY",
	"FLYWHEEL_LEAD_LEASE_KEY",
]);
export function resolveRunnerActionMcpContext(
	env: NodeJS.ProcessEnv,
): RunnerActionMcpContext | undefined {
	const marker = env.FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS;
	if (marker === undefined || marker === "0") return undefined;
	if (marker !== "1")
		throw new Error("runner capability marker must be 0 or 1");
	const context = createRunnerActionContext(env);
	const row = context.assertCurrent();
	const projected: Record<string, string> = Object.fromEntries(
		identityEnvProjection(row.identity).map((line) => {
			const i = line.indexOf("=");
			return [line.slice(0, i), line.slice(i + 1)];
		}),
	);
	projected.HOME = env.HOME!;
	projected.FLYWHEEL_PROJECTS_FILE = context.projectsPath;
	projected.FLYWHEEL_CODEX_LEAD_PROFILE = env.FLYWHEEL_CODEX_LEAD_PROFILE!;
	projected.FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS = "1";
	for (const name of OPTIONAL_CONTEXT_NAMES)
		if (env[name] !== undefined) projected[name] = env[name]!;
	return { env: projected };
}
