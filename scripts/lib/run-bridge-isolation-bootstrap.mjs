import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { assertIsolationBoundaryAtBoot } from "../../packages/claude-runner/dist/isolation-boundary.js";

const BOOT_POLICIES = new Set([
	"mustBeUnderRoot",
	"mustBeAbsent",
	"mustBeUnderRootIfSet",
	"unchecked",
]);

function loadContract(path) {
	if (!isAbsolute(path)) {
		throw new Error("FLYWHEEL_ISOLATION_CONTRACT must be absolute");
	}
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(
			"FLYWHEEL_ISOLATION_CONTRACT must be a regular non-symlink file",
		);
	}
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(
			"FLYWHEEL_ISOLATION_CONTRACT must contain a non-empty array",
		);
	}
	const seen = new Set();
	for (const entry of parsed) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof entry.name !== "string" ||
			!BOOT_POLICIES.has(entry.boot) ||
			seen.has(entry.name)
		) {
			throw new Error("FLYWHEEL_ISOLATION_CONTRACT has an invalid boot entry");
		}
		seen.add(entry.name);
	}
	return parsed.map(({ name, boot }) => ({ name, boot }));
}

export function assertRunBridgeIsolationAtBoot(env = process.env) {
	if (!env.FLYWHEEL_ISOLATION_ROOT) return;
	const contractPath = env.FLYWHEEL_ISOLATION_CONTRACT?.trim();
	if (!contractPath) {
		throw new Error("FLYWHEEL_ISOLATION_CONTRACT is required in isolated mode");
	}
	const contract = loadContract(contractPath);
	const result = assertIsolationBoundaryAtBoot(env, contract);
	if (!result.ok) {
		const detail = result.offenders
			.map(
				(offender) =>
					`${offender.name}:${offender.kind}=${JSON.stringify(offender.value)}`,
			)
			.join(", ");
		throw new Error(detail);
	}
}
