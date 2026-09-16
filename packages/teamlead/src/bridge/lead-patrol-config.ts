import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pinLeadPatrolSources } from "./lead-patrol-snapshot.js";

/** Bridge-owned configuration, derived from this deployment rather than model input. */
export function createLeadPatrolConfiguration(stateDir: string) {
	try {
		return buildConfiguration(realpathSync(stateDir));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		const reason = ["ENOENT", "EACCES", "EPERM"].includes(code ?? "")
			? code
			: error instanceof Error &&
					[
						"patrol_configuration_invalid",
						"patrol_snapshot_unverified",
					].includes(error.message)
				? error.message
				: "patrol_configuration_unavailable";
		console.warn(`[Bridge] patrol disabled: ${reason}`);
		return undefined;
	}
}

function buildConfiguration(stateDir: string) {
	const invalid = () => new Error("patrol_configuration_invalid");
	const deploymentRoot = realpathSync(
		resolve(dirname(fileURLToPath(import.meta.url)), "../../../.."),
	);
	const stat = lstatSync(stateDir);
	if (
		realpathSync(stateDir) !== stateDir ||
		!stat.isDirectory() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o022) !== 0
	)
		throw invalid();
	const pinned = pinLeadPatrolSources(deploymentRoot);
	const activationRoot = join(stateDir, "lead-patrol-capability");
	if (!existsSync(activationRoot)) mkdirSync(activationRoot, { mode: 0o700 });
	const control = lstatSync(activationRoot);
	if (
		!control.isDirectory() ||
		control.isSymbolicLink() ||
		realpathSync(activationRoot) !== activationRoot ||
		control.uid !== process.getuid?.() ||
		(control.mode & 0o077) !== 0
	)
		throw invalid();
	return Object.freeze({
		deploymentRoot,
		stateDir,
		activationRoot,
		nodePath: realpathSync(process.execPath),
		...pinned,
	});
}
