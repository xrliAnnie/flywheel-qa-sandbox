import {
	CommDbPreflightStaleError,
	type Fly2268CommDbRebuildReceipt,
	prepareFly2268CommDbRebuild,
} from "flywheel-comm/db";
import { commDbPathForProject } from "./commdb-path.js";

export interface PreparedProjectCommDb {
	projectName: string;
	receipt: Fly2268CommDbRebuildReceipt;
}

/**
 * Prepare every configured project's legacy CommDB before Bridge constructs
 * any writable CommDB or mailbox queue. Missing and current-schema databases
 * are no-ops. A busy source binding is deferred to the next boot; integrity
 * failures remain fail-loud.
 */
export async function prepareBridgeCommDbRebuilds(
	projects: ReadonlyArray<{ projectName: string }>,
	resolvePath: (projectName: string) => string = commDbPathForProject,
	options: {
		prepare?: typeof prepareFly2268CommDbRebuild;
		log?: (message: string) => void;
	} = {},
): Promise<PreparedProjectCommDb[]> {
	const prepare = options.prepare ?? prepareFly2268CommDbRebuild;
	const log = options.log ?? ((message: string) => console.warn(message));
	const prepared: PreparedProjectCommDb[] = [];
	const seen = new Set<string>();
	for (const project of projects) {
		const dbPath = resolvePath(project.projectName);
		if (seen.has(dbPath)) continue;
		seen.add(dbPath);
		let receipt: Fly2268CommDbRebuildReceipt | null;
		try {
			receipt = await prepare(dbPath);
		} catch (error) {
			if (!(error instanceof CommDbPreflightStaleError)) throw error;
			log(
				`[FLY-2268] ${project.projectName} ${error.message}; migration deferred to a later Bridge boot`,
			);
			continue;
		}
		if (receipt) prepared.push({ projectName: project.projectName, receipt });
	}
	return prepared;
}
