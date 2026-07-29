export class DagContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DagContractError";
	}
}

export class DagConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DagConflictError";
	}
}

export class DagFenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DagFenceError";
	}
}
