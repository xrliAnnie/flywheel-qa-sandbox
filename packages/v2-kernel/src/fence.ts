import { FenceViolation } from "./errors.js";

export type AgentIdentity =
	| {
			kind: "lead";
			leadId: string;
			instanceId: string;
			generation: number;
	  }
	| {
			kind: "runner";
			agentId: string;
			instanceId: string;
			generation: number;
			activationId: string;
	  };

interface RegistryReadTx {
	get<T>(sql: string, params?: unknown): T | undefined;
}

interface RegistryWriteTx extends RegistryReadTx {
	run(sql: string, params?: unknown): unknown;
}

interface RegistryRow {
	value: string;
}

function requireRegistrySubject(value: string, name: string): string {
	if (value.trim().length === 0) {
		throw new TypeError(`${name} must not be empty`);
	}
	return value;
}

export function leadRegistryKey(leadId: string): string {
	return `lead_registry:${requireRegistrySubject(leadId, "leadId")}`;
}

export function consumerRegistryKey(agent: string): string {
	return `consumer_registry:${requireRegistrySubject(agent, "agent")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	expectedKeys: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	return (
		actual.length === expectedKeys.length &&
		actual.every((key, index) => key === [...expectedKeys].sort()[index])
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isGeneration(value: unknown): value is number {
	return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function parseIdentity(value: unknown): AgentIdentity {
	if (!isRecord(value) || (value.kind !== "lead" && value.kind !== "runner")) {
		throw new FenceViolation("registry value has no valid identity kind");
	}

	if (value.kind === "lead") {
		if (
			!hasExactKeys(value, ["kind", "leadId", "instanceId", "generation"]) ||
			!isNonEmptyString(value.leadId) ||
			!isNonEmptyString(value.instanceId) ||
			!isGeneration(value.generation)
		) {
			throw new FenceViolation("registry lead identity is malformed");
		}
		return {
			kind: "lead",
			leadId: value.leadId,
			instanceId: value.instanceId,
			generation: value.generation,
		};
	}

	if (
		!hasExactKeys(value, [
			"kind",
			"agentId",
			"instanceId",
			"generation",
			"activationId",
		]) ||
		!isNonEmptyString(value.agentId) ||
		!isNonEmptyString(value.instanceId) ||
		!isGeneration(value.generation) ||
		!isNonEmptyString(value.activationId)
	) {
		throw new FenceViolation("registry runner identity is malformed");
	}
	return {
		kind: "runner",
		agentId: value.agentId,
		instanceId: value.instanceId,
		generation: value.generation,
		activationId: value.activationId,
	};
}

export function readRegistry(
	tx: RegistryReadTx,
	key: string,
): AgentIdentity | null {
	const row = tx.get<RegistryRow>("SELECT value FROM meta WHERE key = @key", {
		key,
	});
	if (!row) {
		return null;
	}
	try {
		return parseIdentity(JSON.parse(row.value));
	} catch (error) {
		if (error instanceof FenceViolation) {
			throw error;
		}
		throw new FenceViolation(
			`registry ${key} contains invalid JSON: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export function writeRegistry(
	tx: RegistryWriteTx,
	key: string,
	entry: AgentIdentity,
): void {
	const validated = parseIdentity(entry);
	tx.run(
		`INSERT INTO meta(key, value, updated_at)
		 VALUES (@key, @value, @updatedAt)
		 ON CONFLICT(key) DO UPDATE
		 SET value=excluded.value, updated_at=excluded.updated_at`,
		{
			key,
			value: JSON.stringify(validated),
			updatedAt: new Date().toISOString(),
		},
	);
}

export function identitiesEqual(
	actual: AgentIdentity,
	expected: AgentIdentity,
): boolean {
	const validatedExpected = parseIdentity(expected);
	if (actual.kind !== validatedExpected.kind) {
		return false;
	}
	if (actual.kind === "lead" && validatedExpected.kind === "lead") {
		return (
			actual.leadId === validatedExpected.leadId &&
			actual.instanceId === validatedExpected.instanceId &&
			actual.generation === validatedExpected.generation
		);
	}
	if (actual.kind === "runner" && validatedExpected.kind === "runner") {
		return (
			actual.agentId === validatedExpected.agentId &&
			actual.instanceId === validatedExpected.instanceId &&
			actual.generation === validatedExpected.generation &&
			actual.activationId === validatedExpected.activationId
		);
	}
	return false;
}

export const FENCE = {
	mailboxCasPendingApplied: `UPDATE mailbox SET state='applied', applied_at=:now
     WHERE message_uid=:uid AND state='pending'`,
	processingAttemptCasRunningSettled: `UPDATE processing_attempts
     SET outcome=:outcome, settled_at=:settledAt
     WHERE attempt_uid=:attemptUid AND outcome='running'`,
	activationCasActiveTerminal: `UPDATE activations SET state='terminal'
     WHERE id=:activationId AND state='active'`,
	attemptCasActiveTerminal: `UPDATE attempts
     SET desired_state='terminal', terminal_reason=:reason, terminal_at=:terminalAt
     WHERE id=:attemptId AND desired_state<>'terminal'`,
} as const;
