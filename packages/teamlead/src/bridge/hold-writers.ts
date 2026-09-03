import { CMUX_LIVE_SESSION_STATUSES } from "../operational-terminal-status.js";
import type { LivenessVerdict } from "./delivery-contract/liveness.js";

export interface FreezeDecisionInput {
	ageMs: number;
	thresholdMs: number;
	sessionStatus: string | null | undefined;
	liveness: LivenessVerdict;
}

export function shouldFreeze(input: FreezeDecisionInput): boolean {
	return (
		Number.isFinite(input.ageMs) &&
		Number.isFinite(input.thresholdMs) &&
		input.ageMs >= input.thresholdMs &&
		typeof input.sessionStatus === "string" &&
		CMUX_LIVE_SESSION_STATUSES.has(input.sessionStatus) &&
		input.liveness !== "alive"
	);
}

export interface HoldUndeliverableDecisionInput {
	graceElapsed: boolean;
	recipientTerminal: boolean;
	successorExecutionId: string | null;
	liveness: LivenessVerdict;
}

export function shouldHoldUndeliverable(
	input: HoldUndeliverableDecisionInput,
): boolean {
	return (
		input.graceElapsed &&
		input.recipientTerminal &&
		input.successorExecutionId === null &&
		input.liveness !== "alive"
	);
}
