import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_V2_DB_PATH = join(
	homedir(),
	".flywheel",
	"flywheel-v2.db",
);

export function defaultCutoverAuthorityPaths(
	env: Record<string, string | undefined> = process.env,
): { authorityPath: string; armedPath: string } {
	const root = env.FLYWHEEL_HOME?.trim() || join(homedir(), ".flywheel");
	return {
		authorityPath:
			env.FLYWHEEL_CUTOVER_AUTHORITY_PATH?.trim() ||
			join(root, "v2-cutover-authority.json"),
		armedPath:
			env.FLYWHEEL_CUTOVER_ARMED_PATH?.trim() || join(root, "v2-cutover-armed"),
	};
}
