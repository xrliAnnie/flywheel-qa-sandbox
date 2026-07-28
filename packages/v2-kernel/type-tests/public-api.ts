import {
	type AgentIdentity,
	FENCE,
	Kernel,
	type KernelOpenOptions,
	type MigrateOptions,
	type ReadTx,
	type WriteTx,
} from "flywheel-v2-kernel";

declare const kernel: Kernel;
declare const options: KernelOpenOptions;
declare const migrateOptions: MigrateOptions;
declare const identity: AgentIdentity;
declare const readTx: ReadTx;
declare const writeTx: WriteTx;

void options;
void migrateOptions;
void identity;
void readTx;
void writeTx;
void FENCE;

type KernelModule = typeof import("flywheel-v2-kernel");
// @ts-expect-error registry identity comparison is package-private.
type IdentitiesEqual = KernelModule["identitiesEqual"];
// @ts-expect-error registry reads are package-private.
type ReadRegistry = KernelModule["readRegistry"];
// @ts-expect-error registry writes are package-private.
type WriteRegistry = KernelModule["writeRegistry"];

void (undefined as unknown as IdentitiesEqual);
void (undefined as unknown as ReadRegistry);
void (undefined as unknown as WriteRegistry);

// @ts-expect-error async callbacks are excluded from the write contract.
kernel.write("async is forbidden", async () => undefined);

// @ts-expect-error the underlying SQLite Database type is intentionally private.
import type { Database } from "flywheel-v2-kernel";

declare const forbiddenDatabase: Database;
void forbiddenDatabase;

// @ts-expect-error consumers cannot construct a Kernel around an arbitrary connection.
new Kernel();
