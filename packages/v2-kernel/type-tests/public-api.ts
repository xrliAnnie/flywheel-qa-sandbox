import {
	type AgentIdentity,
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

// @ts-expect-error async callbacks are excluded from the write contract.
kernel.write("async is forbidden", async () => undefined);

// @ts-expect-error the underlying SQLite Database type is intentionally private.
import type { Database } from "flywheel-v2-kernel";

declare const forbiddenDatabase: Database;
void forbiddenDatabase;

// @ts-expect-error consumers cannot construct a Kernel around an arbitrary connection.
new Kernel();
