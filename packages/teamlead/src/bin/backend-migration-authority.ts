import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
	assertMigrationAdmissionWindow,
	assertMigrationRestartOwner,
	parseMigrationWindowContext,
} from "flywheel-comm/lead-backend-migration-runtime";

/** No intent or environment flag grants authority. Revalidate the original
 * restart owner, its admission lease and the checkout being deployed each time.
 * deployed-sha advances AFTER the Lead wave and is deliberately not consulted.
 */
export function createMigrationWindowGuard(
	json: string,
	trusted: { home: string; root: string },
	deploymentSha: string,
	dbPath = process.env.TEAMLEAD_DB_PATH ??
		join(trusted.home, ".flywheel/teamlead.db"),
): () => void {
	const context = parseMigrationWindowContext(json, trusted);
	if (!/^[a-f0-9]{40}$/.test(deploymentSha))
		throw Error("invalid migration deployment SHA");
	return () => {
		const current = readMigrationDeploymentHead(context.root);
		if (current !== deploymentSha)
			throw Error("migration deployment HEAD conflict");
		assertMigrationAdmissionWindow(
			dbPath,
			{
				leaseId: context.leaseId,
				restartPid: context.restartPid,
				now: new Date().toISOString(),
			},
			() => {
				assertMigrationRestartOwner(context);
			},
		);
	};
}

/** Read the checkout identity for a read-only wave disposition; mutation still pins the plan SHA. */
export function readMigrationDeploymentHead(root: string): string {
	let current: string;
	try {
		current = execFileSync(
			"git",
			["-C", root, "rev-parse", "--verify", "HEAD"],
			{
				encoding: "utf8",
				timeout: 1000,
				maxBuffer: 1024,
				stdio: ["ignore", "pipe", "ignore"],
				env: {
					...process.env,
					GIT_DIR: undefined,
					GIT_WORK_TREE: undefined,
					GIT_COMMON_DIR: undefined,
				},
			},
		).trim();
	} catch {
		throw Error("migration deployment HEAD unavailable");
	}
	if (!/^[a-f0-9]{40}$/.test(current))
		throw Error("invalid migration deployment HEAD");
	return current;
}
