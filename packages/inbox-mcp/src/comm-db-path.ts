import { dirname, join } from "node:path";

export interface InboxCommCoordinates {
	commDbPath: string;
	leaseDir: string;
}

export function resolveInboxCommCoordinates(
	env: NodeJS.ProcessEnv,
): InboxCommCoordinates {
	const commRoot = env.FLYWHEEL_COMM_ROOT?.trim();
	const projectName = env.FLYWHEEL_PROJECT_NAME?.trim();
	const inheritedDb = env.FLYWHEEL_COMM_DB?.trim();
	const commDbPath =
		commRoot && projectName
			? join(commRoot, projectName, "comm.db")
			: inheritedDb;
	if (!commDbPath) throw new Error("FLYWHEEL_COMM_DB is required");
	return { commDbPath, leaseDir: dirname(commDbPath) };
}
