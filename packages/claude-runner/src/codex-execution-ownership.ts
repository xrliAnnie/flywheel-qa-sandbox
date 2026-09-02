import { randomUUID } from "node:crypto";

export type CodexExecutionOwnerKind = "dispatch" | "rescue";

export interface CodexExecutionOwnershipLease {
	readonly executionId: string;
	readonly kind: CodexExecutionOwnerKind;
	release(): void;
}

type Ownership =
	| { state: "reserved" }
	| {
			state: "active";
			kind: CodexExecutionOwnerKind;
			token: string;
	  };

/**
 * Process-local FLY-2211 owner registry shared by first dispatch and recovery.
 * A reservation is created at session-start persistence time, before the row is
 * visible to the reconciler. Adapter activation consumes that reservation. The
 * active lease is token-bound so delayed cleanup cannot erase a successor.
 */
export class CodexExecutionOwnershipRegistry {
	private readonly owners = new Map<string, Ownership>();

	reserve(executionId: string): boolean {
		if (!executionId || this.owners.has(executionId)) return false;
		this.owners.set(executionId, { state: "reserved" });
		return true;
	}

	claim(
		executionId: string,
		kind: CodexExecutionOwnerKind,
	): CodexExecutionOwnershipLease | undefined {
		if (!executionId) return undefined;
		const current = this.owners.get(executionId);
		if (current?.state === "active") return undefined;
		const token = randomUUID();
		this.owners.set(executionId, { state: "active", kind, token });
		let released = false;
		return {
			executionId,
			kind,
			release: () => {
				if (released) return;
				released = true;
				const owned = this.owners.get(executionId);
				if (owned?.state === "active" && owned.token === token) {
					this.owners.delete(executionId);
				}
			},
		};
	}

	releaseReservation(executionId: string): boolean {
		const current = this.owners.get(executionId);
		if (current?.state !== "reserved") return false;
		this.owners.delete(executionId);
		return true;
	}

	isExecutionOwned(executionId: string): boolean {
		return this.owners.has(executionId);
	}
}
