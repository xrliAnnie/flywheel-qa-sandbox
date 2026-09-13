import { setTimeout as delay } from "node:timers/promises";
import {
	type BackendMigrationPlan,
	executeBackendMigration,
	loadMigrationReceipt,
	MigrationActivationPreflightError,
	type MigrationExecutorDeps,
	migrateRegistryFieldsLocked,
	preserveMigrationArtifacts,
	replaceMigrationArtifact,
	restoreMigrationFilesLocked,
	saveMigrationReceipt,
} from "flywheel-comm/lead-backend-migration-runtime";
import { withMigrationConfigLock } from "./backend-migration-config-lock.js";
import { runMigrationLifecycle } from "./backend-migration-lifecycle.js";

/** Window integration. Authority/identity/seed observations are supplied by the
 * internal host entry; this module owns action order, file CAS and recovery.
 */
export async function runBackendMigrationWindow(input: {
	home: string;
	root: string;
	intentSha: string;
	plan: BackendMigrationPlan;
	target: { manifest: string; plist: string };
	assertWindow(): void;
	assertStopped(): void;
	validateCandidate(path: string): void;
	staticPreflight(): Promise<void>;
	seed(): Promise<void>;
	captureSourceCarrier: MigrationExecutorDeps["captureSourceCarrier"];
	observe: MigrationExecutorDeps["observe"];
	/** Actual source fields/files AND canonical old-owner process must all match. */
	observeRestoredSource(): Promise<string | null>;
}) {
	const assertStopped = () => {
		input.assertWindow();
		input.assertStopped();
	};
	const files = async (direction: "apply" | "restore") =>
		withMigrationConfigLock(input, (assertHeld) => {
			const deps = {
				configLockHeld: true,
				validateCandidate: input.validateCandidate,
				assertWindowAndStopped: () => {
					assertHeld();
					assertStopped();
				},
			};
			if (direction === "apply")
				migrateRegistryFieldsLocked(input.home, input.plan, "apply", deps);
			else
				restoreMigrationFilesLocked(input.home, input.plan, input.target, deps);
		});
	return executeBackendMigration(input.intentSha, {
		verifyWindow: async () => input.assertWindow(),
		load: () => loadMigrationReceipt(input.home),
		save: (receipt, revision) =>
			saveMigrationReceipt(input.home, receipt, revision),
		captureSourceCarrier: input.captureSourceCarrier,
		observe: input.observe,
		apply: async (step) => {
			switch (step) {
				case "preflight":
					await input.staticPreflight();
					break;
				case "stop":
					input.assertWindow();
					preserveMigrationArtifacts(input.home, input.plan.expected);
					await runMigrationLifecycle(input, "stop");
					assertStopped();
					break;
				case "configure":
					await files("apply");
					break;
				case "stage_manifest":
				case "stage_plist": {
					const kind = step === "stage_manifest" ? "manifest" : "plist";
					replaceMigrationArtifact(
						input.home,
						input.plan.expected,
						kind,
						input.target[kind],
						"apply",
						assertStopped,
					);
					break;
				}
				case "seed":
					assertStopped();
					await input.seed();
					assertStopped();
					break;
				case "activate":
					assertStopped();
					try {
						await runMigrationLifecycle(input, "preflight");
					} catch {
						throw new MigrationActivationPreflightError();
					}
					assertStopped();
					await runMigrationLifecycle(input, "load");
					break;
			}
		},
		restoreSource: async () => {
			input.assertWindow();
			const previous = await input.observeRestoredSource();
			if (previous) return previous;
			assertStopped();
			await files("restore");
			input.assertWindow();
			await runMigrationLifecycle(input, "load");
			const deadline = Date.now() + 20000;
			for (;;) {
				input.assertWindow();
				const proof = await input.observeRestoredSource();
				if (proof) return proof;
				if (Date.now() >= deadline)
					throw Error("migration restored owner unproven");
				await delay(250);
			}
		},
	});
}
