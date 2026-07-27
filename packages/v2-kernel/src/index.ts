export { backupDatabase } from "./backup.js";
export {
	CasViolation,
	FenceViolation,
	NestedWriteViolation,
	TxBudgetExceeded,
	TxLifecycleViolation,
} from "./errors.js";
export type { AgentIdentity } from "./fence.js";
export {
	consumerRegistryKey,
	leadRegistryKey,
} from "./fence.js";
export type { ReadTx, WriteTx } from "./kernel.js";
export { Kernel } from "./kernel.js";
export { migrateDatabase } from "./migrator.js";
export { DEFAULT_V2_DB_PATH } from "./paths.js";
export { CANDIDATE_SQL, DETECTOR_SQL } from "./sql/candidates.js";
export type { KernelOpenOptions, MigrateOptions } from "./types.js";
