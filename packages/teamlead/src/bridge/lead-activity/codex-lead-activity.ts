/**
 * FLY-2882 §5.4 — Codex-carrier Lead activity, read from the sidecar's
 * authenticated inbox socket (`capabilities` → `readTurnState`).
 *
 * The reply is validated with an exact-key schema; anything unexpected is
 * `sidecar_protocol_invalid` and NEVER defaults to an empty turn list (= idle).
 */

import {
	type CodexLeadInboxCapabilities,
	CodexLeadInboxRejectedError,
} from "../../lead-backends/codex/CodexLeadInboxSocket.js";
import {
	MAX_BOUND_DELIVERIES,
	type SidecarTurn,
	TURN_STATE_SCHEMA,
	type TurnBinding,
	type TurnStateSnapshot,
} from "../../lead-backends/codex/LeadTurnStateTracker.js";
import {
	type LeadActivityReading,
	type LeadActivityTrigger,
	type TriggerUndeterminedReason,
	undetermined,
} from "./types.js";

export const SIDECAR_TIMEOUT_MS = 3_000;
const FUTURE_SKEW_MS = 5_000;
const MAX_ACTIVE_TURNS = 4;
const MAX_TURN_ID = 128;
const MAX_DELIVERY_ID = 200;

interface SocketArgs {
	socketPath: string;
	leadId: string;
	authSecret: string;
	timeoutMs: number;
}

export interface CodexLeadActivityDeps {
	resolveSocketPath(projectName: string, leadId: string): Promise<string>;
	resolveAuthSecret(projectName: string, leadId: string): string | undefined;
	probeCapabilities(args: SocketArgs): Promise<CodexLeadInboxCapabilities>;
	readTurnState(args: SocketArgs): Promise<unknown>;
	attribute(
		projectName: string,
		leadId: string,
		deliveryIds: string[],
	): LeadActivityTrigger;
	now(): number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value);
	return (
		actual.length === keys.length && actual.every((key) => keys.includes(key))
	);
}

function validBinding(value: unknown): value is TurnBinding {
	if (!isRecord(value)) return false;
	if (value.status === "bound")
		return (
			exactKeys(value, ["status", "deliveryIds"]) &&
			Array.isArray(value.deliveryIds) &&
			value.deliveryIds.length >= 1 &&
			value.deliveryIds.length <= MAX_BOUND_DELIVERIES &&
			value.deliveryIds.every(
				(id) =>
					typeof id === "string" &&
					id.length > 0 &&
					id.length <= MAX_DELIVERY_ID,
			)
		);
	return (
		exactKeys(value, ["status"]) &&
		["pending", "ambiguous", "no_members", "overflow", "unavailable"].includes(
			value.status as string,
		)
	);
}

function validTurn(value: unknown, observedAtMs: number): value is SidecarTurn {
	if (!isRecord(value)) return false;
	const common =
		typeof value.turnId === "string" &&
		value.turnId.length > 0 &&
		value.turnId.length <= MAX_TURN_ID &&
		Number.isSafeInteger(value.startedAtMs) &&
		(value.startedAtMs as number) > 0 &&
		(value.startedAtMs as number) <= observedAtMs + FUTURE_SKEW_MS;
	if (!common) return false;
	if (value.origin === "message")
		return (
			exactKeys(value, ["origin", "turnId", "startedAtMs", "binding"]) &&
			validBinding(value.binding)
		);
	return (
		(value.origin === "founder_terminal" || value.origin === "unknown") &&
		exactKeys(value, ["origin", "turnId", "startedAtMs"])
	);
}

export function parseTurnStateSnapshot(
	value: unknown,
	observedAtMs: number,
): TurnStateSnapshot | undefined {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"schema",
			"generation",
			"connected",
			"seeded",
			"activeTurns",
		]) ||
		value.schema !== TURN_STATE_SCHEMA ||
		typeof value.generation !== "string" ||
		value.generation.length === 0 ||
		value.generation.length > MAX_TURN_ID ||
		typeof value.connected !== "boolean" ||
		typeof value.seeded !== "boolean" ||
		!Array.isArray(value.activeTurns) ||
		value.activeTurns.length > MAX_ACTIVE_TURNS ||
		!value.activeTurns.every((turn) => validTurn(turn, observedAtMs))
	)
		return undefined;
	const ids = (value.activeTurns as SidecarTurn[]).map((turn) => turn.turnId);
	if (new Set(ids).size !== ids.length) return undefined;
	return value as unknown as TurnStateSnapshot;
}

const BINDING_REASON: Record<
	Exclude<TurnBinding["status"], "bound">,
	TriggerUndeterminedReason
> = {
	pending: "turn_not_yet_bound",
	ambiguous: "ambiguous_turn_binding",
	no_members: "no_delivery_binding",
	overflow: "candidate_overflow",
	unavailable: "attribution_unavailable",
};

function triggerFor(
	turn: SidecarTurn,
	projectName: string,
	leadId: string,
	deps: CodexLeadActivityDeps,
): LeadActivityTrigger {
	if (turn.origin !== "message")
		return undetermined(
			turn.origin === "founder_terminal"
				? "founder_terminal_turn"
				: "turn_origin_unknown",
		);
	const binding = turn.binding;
	if (binding.status !== "bound")
		return undetermined(BINDING_REASON[binding.status]);
	try {
		return deps.attribute(projectName, leadId, [...binding.deliveryIds]);
	} catch {
		return undetermined("attribution_unavailable");
	}
}

export async function readCodexLeadActivity(
	projectName: string,
	leadId: string,
	deps: CodexLeadActivityDeps,
): Promise<{ reading: LeadActivityReading; observedAtMs: number }> {
	const unknown = (
		reason: Extract<LeadActivityReading, { state: "unknown" }>["reason"],
	) => ({
		reading: { state: "unknown" as const, reason },
		observedAtMs: deps.now(),
	});
	const authSecret = deps.resolveAuthSecret(projectName, leadId);
	if (!authSecret) return unknown("sidecar_unreachable");
	let args: SocketArgs;
	try {
		args = {
			socketPath: await deps.resolveSocketPath(projectName, leadId),
			leadId,
			authSecret,
			timeoutMs: SIDECAR_TIMEOUT_MS,
		};
	} catch {
		return unknown("sidecar_unreachable");
	}
	let capabilities: CodexLeadInboxCapabilities;
	try {
		capabilities = await deps.probeCapabilities(args);
	} catch {
		return unknown("sidecar_unreachable");
	}
	if (!isRecord(capabilities) || !Array.isArray(capabilities.features))
		return unknown("sidecar_protocol_invalid");
	if (!capabilities.features.includes("turn_state_v1"))
		return unknown("sidecar_lacks_turn_state");
	let raw: unknown;
	try {
		raw = await deps.readTurnState(args);
	} catch (error) {
		return unknown(
			error instanceof CodexLeadInboxRejectedError &&
				error.reason === "unsupported inbox method"
				? "sidecar_lacks_turn_state"
				: "sidecar_unreachable",
		);
	}
	const observedAtMs = deps.now();
	const snapshot = parseTurnStateSnapshot(raw, observedAtMs);
	if (!snapshot)
		return {
			reading: { state: "unknown", reason: "sidecar_protocol_invalid" },
			observedAtMs,
		};
	if (!snapshot.connected)
		return {
			reading: { state: "unknown", reason: "observer_disconnected" },
			observedAtMs,
		};
	if (!snapshot.seeded)
		return {
			reading: { state: "unknown", reason: "turn_state_not_seeded" },
			observedAtMs,
		};
	const earliest = [...snapshot.activeTurns].sort(
		(a, b) => a.startedAtMs - b.startedAtMs,
	)[0];
	if (!earliest) return { reading: { state: "idle" }, observedAtMs };
	const startedAtMs = Math.min(earliest.startedAtMs, observedAtMs);
	return {
		reading: {
			state: "busy",
			turn: {
				startedAt: new Date(startedAtMs).toISOString(),
				elapsedMs: observedAtMs - startedAtMs,
				precision: "second",
				origin: earliest.origin,
			},
			trigger: triggerFor(earliest, projectName, leadId, deps),
		},
		observedAtMs,
	};
}
