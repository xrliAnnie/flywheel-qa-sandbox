import type { AdapterExecutionContext } from "flywheel-core";

/** Durable owner bound to the adapter's existing execution-registry token. */
export interface ExecutionProcessOwnerLease {
	readonly nonce: string;
	prepareSpawn(): Promise<void>;
	authorizeSpawn(): boolean;
	beginRestart(): Promise<boolean>;
	acceptSpawn(pgid: number): Promise<void>;
	/** Durably revoke spawn/restart permission before cooperative stop. */
	close(): Promise<void>;
	/** Independently establish physical drain; uncertainty must reject. */
	finish(): Promise<void>;
}

export type ExecutionProcessOwnerFactory = (
	ctx: AdapterExecutionContext,
	ownerToken: string,
	kind?: "dispatch" | "rescue",
) => Promise<ExecutionProcessOwnerLease>;
