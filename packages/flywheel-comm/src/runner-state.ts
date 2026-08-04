import { homedir } from "node:os";
import { join } from "node:path";

export function resolveRunnerStateDir(
	executionId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return (
		env.FLYWHEEL_RUNNER_STATE_DIR?.trim() ||
		join(env.HOME ?? homedir(), ".flywheel", "runner-state", executionId)
	);
}
