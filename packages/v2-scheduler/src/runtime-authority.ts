import {
	type DatabaseAuthorityState,
	FenceViolation,
	type Kernel,
	readCutoverAuthority,
} from "flywheel-v2-kernel";

export interface RuntimeAuthorityOptions {
	authorityPath: string;
	armedPath: string;
	windowId: string;
	epoch: number;
}

export function readMatchingRuntimeAuthority(
	kernel: Kernel,
	options: RuntimeAuthorityOptions,
): DatabaseAuthorityState {
	const databaseState = kernel.read(
		(tx) =>
			tx.get<{ value: string }>(
				"SELECT value FROM meta WHERE key='cutover_authority_state'",
			)?.value,
	);
	if (databaseState !== "cutover" && databaseState !== "live") {
		throw new FenceViolation(
			"scheduler database authority is missing or malformed",
		);
	}
	const machineAuthority = readCutoverAuthority({
		authorityPath: options.authorityPath,
		armedPath: options.armedPath,
		expectedWindowId: options.windowId,
		expectedEpoch: options.epoch,
	});
	if (
		machineAuthority.mode !== "armed" ||
		machineAuthority.authority.state !== databaseState
	) {
		throw new FenceViolation(
			"scheduler machine and database authority states disagree",
		);
	}
	return databaseState;
}
