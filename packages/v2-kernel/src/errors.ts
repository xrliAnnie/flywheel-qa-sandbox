export class CasViolation extends Error {
	readonly expectedChanges: number;
	readonly actualChanges: number;

	constructor(expectedChanges: number, actualChanges: number) {
		super(
			`CAS expected ${expectedChanges} changed row(s), got ${actualChanges}`,
		);
		this.name = "CasViolation";
		this.expectedChanges = expectedChanges;
		this.actualChanges = actualChanges;
	}
}

export class ActionSerializationError extends TypeError {
	constructor(cause: unknown) {
		super(
			`action result serialization failed: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
			{ cause },
		);
		this.name = "ActionSerializationError";
	}
}

export class FenceViolation extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FenceViolation";
	}
}

export class TxLifecycleViolation extends Error {
	constructor(operation: string) {
		super(`transaction handle is not active: ${operation}`);
		this.name = "TxLifecycleViolation";
	}
}

export class TxBudgetExceeded extends Error {
	readonly label: string;
	readonly elapsedMs: number;
	readonly budgetMs: number;

	constructor(label: string, elapsedMs: number, budgetMs: number) {
		super(
			`transaction "${label}" exceeded ${budgetMs}ms budget (${elapsedMs.toFixed(2)}ms)`,
		);
		this.name = "TxBudgetExceeded";
		this.label = label;
		this.elapsedMs = elapsedMs;
		this.budgetMs = budgetMs;
	}
}

export class NestedWriteViolation extends Error {
	constructor(label: string) {
		super(`nested kernel write rejected: ${label}`);
		this.name = "NestedWriteViolation";
	}
}
