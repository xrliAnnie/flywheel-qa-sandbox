export interface LeadRegistryIntent {
	schemaVersion: 1;
	phase: "pending" | "done";
	operation?: "add" | "cos-context-import";
	leadKey: string;
	startedAt: string;
	projectsShaBefore: string;
	receiptDigestBefore: string;
	projectsShaPlanned: string;
	receiptDigestPlanned: string;
	projectsShaAfter?: string;
	receiptDigestAfter?: string;
	backups: { projects: string; receipt: string };
}

export type LeadRegistryRecoveryClassification =
	| { state: "none" }
	| { state: "discard_done"; intent: LeadRegistryIntent }
	| { state: "discard_unwritten"; intent: LeadRegistryIntent }
	| { state: "restore_projects"; intent: LeadRegistryIntent }
	| { state: "finalize"; intent: LeadRegistryIntent }
	| { state: "conflict"; intent: LeadRegistryIntent };

export type LeadRegistryRecoveryErrorCode = "lead_registry_intent_invalid";

export class LeadRegistryRecoveryError extends Error {
	constructor(
		readonly code: LeadRegistryRecoveryErrorCode,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "LeadRegistryRecoveryError";
	}
}

const DIGEST = /^[a-f0-9]{64}$/;

function parseIntent(value: unknown): LeadRegistryIntent {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new LeadRegistryRecoveryError(
			"lead_registry_intent_invalid",
			"intent must be an object",
		);
	}
	const intent = value as Record<string, unknown>;
	const backups = intent.backups as Record<string, unknown> | undefined;
	if (
		intent.schemaVersion !== 1 ||
		(intent.phase !== "pending" && intent.phase !== "done") ||
		(intent.operation !== undefined &&
			intent.operation !== "add" &&
			intent.operation !== "cos-context-import") ||
		typeof intent.leadKey !== "string" ||
		intent.leadKey.length === 0 ||
		typeof intent.startedAt !== "string" ||
		intent.startedAt.length === 0 ||
		backups === undefined ||
		!DIGEST.test(String(intent.projectsShaBefore)) ||
		!DIGEST.test(String(intent.receiptDigestBefore)) ||
		!DIGEST.test(String(intent.projectsShaPlanned)) ||
		!DIGEST.test(String(intent.receiptDigestPlanned)) ||
		(intent.projectsShaAfter !== undefined &&
			!DIGEST.test(String(intent.projectsShaAfter))) ||
		(intent.receiptDigestAfter !== undefined &&
			!DIGEST.test(String(intent.receiptDigestAfter))) ||
		typeof backups.projects !== "string" ||
		backups.projects.length === 0 ||
		typeof backups.receipt !== "string" ||
		backups.receipt.length === 0
	) {
		throw new LeadRegistryRecoveryError(
			"lead_registry_intent_invalid",
			"intent schema, phase, images, or backup paths are invalid",
		);
	}
	return value as LeadRegistryIntent;
}

export function classifyRecovery(
	intentValue: unknown | undefined,
	currentProjectsSha: string,
	currentReceiptDigest: string,
	activationOk: boolean,
): LeadRegistryRecoveryClassification {
	if (intentValue === undefined) return { state: "none" };
	const intent = parseIntent(intentValue);
	if (intent.phase === "done") return { state: "discard_done", intent };
	if (
		currentProjectsSha === intent.projectsShaBefore &&
		currentReceiptDigest === intent.receiptDigestBefore
	) {
		return { state: "discard_unwritten", intent };
	}
	if (
		currentProjectsSha === intent.projectsShaPlanned &&
		currentReceiptDigest === intent.receiptDigestBefore
	) {
		return { state: "restore_projects", intent };
	}
	if (
		currentProjectsSha === intent.projectsShaPlanned &&
		currentReceiptDigest === intent.receiptDigestPlanned &&
		activationOk
	) {
		return { state: "finalize", intent };
	}
	return { state: "conflict", intent };
}
