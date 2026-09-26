export const PATROL_SNAPSHOT_EXECUTION_TIMEOUT_MS = 270_000;

// FLY-2914: root-cause collection runs beside the helper inside that budget.
export const ROOT_CAUSE_DEADLINE_MS = 30_000;

// Leave bounded cleanup/receipt work outside the snapshot child-process budget.
export const PATROL_SNAPSHOT_SERVER_TIMEOUT_MS =
	PATROL_SNAPSHOT_EXECUTION_TIMEOUT_MS + 5_000;

// The Lead first performs a separately bounded GitHub prefetch before the POST.
export const PATROL_SNAPSHOT_CLIENT_TIMEOUT_MS =
	PATROL_SNAPSHOT_SERVER_TIMEOUT_MS + 20_000;
