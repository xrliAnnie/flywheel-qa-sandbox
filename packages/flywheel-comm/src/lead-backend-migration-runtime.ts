/** Internal migration integration surface; no public apply command is registered. */

export type { BackendMigrationPlan } from "./lead-backend-migration.js";
export {
	observeMigrationArtifact,
	preserveMigrationArtifacts,
	replaceMigrationArtifact,
} from "./lead-backend-migration-artifacts.js";
export {
	type MigrationWindowContext,
	parseMigrationWindowContext,
} from "./lead-backend-migration-context.js";
export { collectMigrationCutoffs } from "./lead-backend-migration-cutoff.js";
export {
	executeBackendMigration,
	MigrationActivationPreflightError,
	type MigrationExecutorDeps,
	type MigrationObservation,
	type MigrationStep,
} from "./lead-backend-migration-executor.js";
export { resolveMigrationIdentities } from "./lead-backend-migration-identities.js";
export {
	readCommittedMigrationIntent,
	readMigrationIntentRecord,
} from "./lead-backend-migration-io.js";
export { assertMigrationRestartOwner } from "./lead-backend-migration-owner.js";
export {
	commitMigrationVerification,
	loadMigrationReceipt,
	retireCommittedMigrationIntent,
	saveMigrationReceipt,
} from "./lead-backend-migration-receipt.js";
export {
	migrateRegistryFieldsLocked,
	observeMigrationRegistry,
	readMigrationRegistry,
	restoreMigrationFilesLocked,
} from "./lead-backend-migration-registry.js";
export { renderMigrationArtifacts } from "./lead-backend-migration-render.js";
export { assertMigrationWriterStopped } from "./lead-backend-migration-stopped.js";
export {
	assertMigrationAdmissionWindow,
	assertMigrationOutsideWindow,
} from "./lead-backend-migration-window.js";
