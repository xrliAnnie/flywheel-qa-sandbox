const DEFAULT_SHIP_READY_REMIND_MS = 30 * 60 * 1_000;

export type WorkflowShipReadyNotice = {
	runId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	templateId: string;
	gateNodeId: string;
	attempt: number;
	gateOpenedAt: string;
	sourceExecutionId: string;
	ageMinutes: number;
	evidence: {
		headSha?: string;
		prNumber?: number;
		qaPassed: boolean;
	};
	pending: {
		lead: boolean;
		founder: boolean;
	};
};

export type ShipReadyFounderOutcome =
	| { kind: "posted" }
	| { kind: "transient"; reason: string; retryAfterMs?: number }
	| { kind: "permanent"; reason: string };

export type ShipReadyHandledOutcome =
	| { kind: "handled"; reason: "pr_merged" | "founder_approved" }
	| { kind: "unhandled" }
	| { kind: "unknown" };

export type ShipReadyMarkerPayload = {
	path: "lead" | "founder" | "failed";
	reason?: string;
	at: string;
};

export type WorkflowShipReadyArm = {
	queueLeadNotice(
		notice: WorkflowShipReadyNotice,
	): Promise<{ queued: boolean }>;
	postFounderCard(
		notice: WorkflowShipReadyNotice,
	): Promise<ShipReadyFounderOutcome>;
	classifyShipHandled(
		batch: readonly WorkflowShipReadyNotice[],
	): Promise<Map<string, ShipReadyHandledOutcome>>;
};

export function shipReadyNotifyEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.FLYWHEEL_SHIP_READY_NOTIFY !== "0";
}

export function shipReadyRemindMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const parsed = Number(env.FLYWHEEL_SHIP_READY_REMIND_MS);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_SHIP_READY_REMIND_MS;
}

export function workflowShipReadyUid(input: {
	runId: string;
	gateNodeId: string;
	attempt: number;
}): string {
	return `${input.runId}:${input.gateNodeId}:${input.attempt}`;
}
