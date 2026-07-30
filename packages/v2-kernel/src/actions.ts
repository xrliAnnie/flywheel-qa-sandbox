import { createHash } from "node:crypto";
import { ActionSerializationError } from "./errors.js";
import type { ReadTx, WriteTx } from "./kernel.js";

type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export type ActionActor =
	| {
			kind: "lead";
			agentId: string;
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

export type ActionState = "intended" | "succeeded" | "failed";

/**
 * The identity of a logical effect, independent of which invocation carried it.
 *
 * `actions_one_root_per_logical` is UNIQUE on this WHERE supersedes_action_id IS
 * NULL, so a second ROOT action for the same logical effect is refused while a
 * declared successor is allowed. A caller that must legitimately re-issue an
 * effect therefore has to find the existing chain and supersede its tip, and to
 * do that it needs this derivation. It is exported so no caller has to
 * reimplement it -- a divergent copy would compute a key that does not match the
 * index the database enforces.
 */
export function deriveActionLogicalKey(spec: {
	actorAgentId: string;
	attemptGeneration?: number;
	attemptId?: string;
	cutoverEpoch: number;
	kind: string;
	logicalEffectId: string;
	taskId?: string;
}): string {
	const taskId = spec.taskId ?? null;
	return digest(
		canonicalize({
			attemptGeneration: spec.attemptGeneration ?? null,
			attemptId: spec.attemptId ?? null,
			cutoverEpoch: spec.cutoverEpoch,
			kind: spec.kind,
			logicalEffectId: spec.logicalEffectId,
			taskId,
			unboundActorAgentId: taskId === null ? spec.actorAgentId : null,
		}),
	);
}

export interface RecordActionIntentSpec {
	id: string;
	taskId?: string;
	attemptId?: string;
	attemptGeneration?: number;
	actor: ActionActor;
	kind: string;
	payload: JsonValue;
	authorization?: JsonValue;
	logicalEffectId: string;
	invocationUid: string;
	supersedesActionId?: string;
	retryBasis?: {
		evidenceRef: string;
		reason: string;
	};
	cutoverEpoch: number;
	createdAt?: string;
}

export interface ActionSnapshot {
	id: string;
	taskId?: string;
	attemptId?: string;
	attemptGeneration?: number;
	actor: ActionActor;
	kind: string;
	payload: JsonValue;
	payloadDigest: string;
	authorization?: JsonValue;
	authorizationDigest?: string;
	logicalKey: string;
	effectKey: string;
	supersedesActionId?: string;
	retryBasis?: {
		evidenceRef: string;
		reason: string;
	};
	cutoverEpoch: number;
	state: ActionState;
	result?: JsonValue;
	createdAt: string;
	completedAt?: string;
}

export interface RecordActionIntentResult {
	outcome: "inserted" | "replayed";
	action: ActionSnapshot;
}

export interface RecordActionIntentOptions {
	prepare?(tx: WriteTx): void;
}

export interface RecordActionOutcomeSpec {
	id: string;
	actor: ActionActor;
	state: "succeeded" | "failed";
	result: JsonValue;
	completedAt?: string;
}

export interface ListActionsOptions {
	state?: ActionState;
	actorAgentId?: string;
	taskId?: string;
	logicalKey?: string;
	effectKey?: string;
	createdBefore?: string;
	limit: number;
}

interface ActionRow {
	id: string;
	task_id: string | null;
	attempt_id: string | null;
	attempt_generation: number | null;
	activation_id: string | null;
	actor_kind: "lead" | "runner";
	actor_agent_id: string;
	actor_instance_id: string;
	actor_generation: number;
	kind: string;
	payload: string;
	payload_digest: string;
	authorization: string | null;
	authorization_digest: string | null;
	logical_key: string;
	effect_key: string;
	supersedes_action_id: string | null;
	retry_basis: string | null;
	cutover_epoch: number;
	state: ActionState;
	result: string | null;
	created_at: string;
	completed_at: string | null;
}

const ACTION_COLUMNS = `id, task_id, attempt_id, attempt_generation,
  activation_id, actor_kind, actor_agent_id, actor_instance_id,
  actor_generation, kind, payload, payload_digest, authorization,
  authorization_digest, logical_key, effect_key, supersedes_action_id,
  retry_basis, cutover_epoch, state, result, created_at, completed_at`;

function requireNonEmpty(value: string, name: string): string {
	if (value.trim().length === 0) {
		throw new TypeError(`${name} must not be empty`);
	}
	return value;
}

function requireGeneration(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative integer`);
	}
	return value;
}

function requireCanonicalIso(value: string, name: string): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new TypeError(`${name} must be a canonical ISO timestamp`);
	}
	return value;
}

function canonicalize(value: JsonValue): string {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new TypeError("action JSON contains a non-finite number");
		}
		return JSON.stringify(value);
	}
	if (typeof value !== "object") {
		throw new TypeError(
			`action JSON contains an unsupported ${typeof value} value`,
		);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("action JSON contains a non-plain object");
	}
	const ownKeys = Reflect.ownKeys(value);
	if (
		ownKeys.some((key) => typeof key === "symbol") ||
		ownKeys.length !== Object.keys(value).length
	) {
		throw new TypeError(
			"action JSON contains a symbol or non-enumerable object field",
		);
	}
	const entries = Object.entries(value).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	for (const [key, entry] of entries) {
		if (entry === undefined) {
			throw new TypeError(`action JSON field ${key} is undefined`);
		}
	}
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
		.join(",")}}`;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function optional<T>(value: T | null): T | undefined {
	return value === null ? undefined : value;
}

function parseJson(value: string): JsonValue {
	return JSON.parse(value) as JsonValue;
}

function toSnapshot(row: ActionRow): ActionSnapshot {
	const actor: ActionActor =
		row.actor_kind === "runner"
			? {
					kind: "runner",
					agentId: row.actor_agent_id,
					instanceId: row.actor_instance_id,
					generation: row.actor_generation,
					activationId: row.activation_id as string,
				}
			: {
					kind: "lead",
					agentId: row.actor_agent_id,
					instanceId: row.actor_instance_id,
					generation: row.actor_generation,
				};
	const retryBasis = row.retry_basis
		? (JSON.parse(row.retry_basis) as {
				evidence_ref: string;
				reason: string;
			})
		: undefined;
	return {
		id: row.id,
		taskId: optional(row.task_id),
		attemptId: optional(row.attempt_id),
		attemptGeneration: optional(row.attempt_generation),
		actor,
		kind: row.kind,
		payload: parseJson(row.payload),
		payloadDigest: row.payload_digest,
		authorization:
			row.authorization === null ? undefined : parseJson(row.authorization),
		authorizationDigest: optional(row.authorization_digest),
		logicalKey: row.logical_key,
		effectKey: row.effect_key,
		supersedesActionId: optional(row.supersedes_action_id),
		retryBasis: retryBasis
			? {
					evidenceRef: retryBasis.evidence_ref,
					reason: retryBasis.reason,
				}
			: undefined,
		cutoverEpoch: row.cutover_epoch,
		state: row.state,
		result: row.result === null ? undefined : parseJson(row.result),
		createdAt: row.created_at,
		completedAt: optional(row.completed_at),
	};
}

export function readAction(tx: ReadTx, id: string): ActionSnapshot | null {
	requireNonEmpty(id, "action id");
	const row = tx.get<ActionRow>(
		`SELECT ${ACTION_COLUMNS} FROM actions WHERE id=@id`,
		{ id },
	);
	return row ? toSnapshot(row) : null;
}

export function listActions(
	tx: ReadTx,
	options: ListActionsOptions,
): ActionSnapshot[] {
	if (!Number.isInteger(options.limit) || options.limit <= 0) {
		throw new TypeError("listActions limit must be a positive integer");
	}
	if (
		options.state !== undefined &&
		options.state !== "intended" &&
		options.state !== "succeeded" &&
		options.state !== "failed"
	) {
		throw new TypeError("listActions state is invalid");
	}
	const conditions: string[] = [];
	const params: Record<string, string | number> = { limit: options.limit };
	for (const [value, name, column] of [
		[options.actorAgentId, "actorAgentId", "actor_agent_id"],
		[options.taskId, "taskId", "task_id"],
		[options.logicalKey, "logicalKey", "logical_key"],
		[options.effectKey, "effectKey", "effect_key"],
		[options.createdBefore, "createdBefore", "created_at"],
	] as const) {
		if (value === undefined) {
			continue;
		}
		requireNonEmpty(value, `listActions ${name}`);
		const operator = name === "createdBefore" ? "<" : "=";
		conditions.push(`${column}${operator}@${name}`);
		params[name] = value;
	}
	if (options.state !== undefined) {
		conditions.push("state=@state");
		params.state = options.state;
	}
	const where =
		conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
	return tx
		.all<ActionRow>(
			`SELECT ${ACTION_COLUMNS} FROM actions${where}
			 ORDER BY created_at DESC, id DESC
			 LIMIT @limit`,
			params,
		)
		.map(toSnapshot);
}

function readActionRowByEffectKey(
	tx: ReadTx,
	effectKey: string,
): ActionRow | undefined {
	return tx.get<ActionRow>(
		`SELECT ${ACTION_COLUMNS} FROM actions WHERE effect_key=@effectKey`,
		{ effectKey },
	);
}

export function recordActionIntent(
	tx: WriteTx,
	spec: RecordActionIntentSpec,
	options: RecordActionIntentOptions = {},
): RecordActionIntentResult {
	requireNonEmpty(spec.id, "action id");
	requireNonEmpty(spec.actor.agentId, "actor.agentId");
	requireNonEmpty(spec.actor.instanceId, "actor.instanceId");
	requireGeneration(spec.actor.generation, "actor.generation");
	requireNonEmpty(spec.kind, "kind");
	requireNonEmpty(spec.logicalEffectId, "logicalEffectId");
	requireNonEmpty(spec.invocationUid, "invocationUid");
	requireGeneration(spec.cutoverEpoch, "cutoverEpoch");

	const taskId = spec.taskId ?? null;
	const attemptId = spec.attemptId ?? null;
	const attemptGeneration = spec.attemptGeneration ?? null;
	const payload = canonicalize(spec.payload);
	const payloadDigest = digest(payload);
	const authorization =
		spec.authorization === undefined ? null : canonicalize(spec.authorization);
	const authorizationDigest =
		authorization === null ? null : digest(authorization);
	if (
		(spec.supersedesActionId === undefined) !==
		(spec.retryBasis === undefined)
	) {
		throw new TypeError(
			"supersedesActionId and retryBasis must be provided together",
		);
	}
	const supersedesActionId =
		spec.supersedesActionId === undefined
			? null
			: requireNonEmpty(spec.supersedesActionId, "supersedesActionId");
	const retryBasis =
		spec.retryBasis === undefined
			? null
			: canonicalize({
					evidence_ref: requireNonEmpty(
						spec.retryBasis.evidenceRef,
						"retryBasis.evidenceRef",
					),
					reason: requireNonEmpty(spec.retryBasis.reason, "retryBasis.reason"),
				});
	const logicalKey = deriveActionLogicalKey({
		actorAgentId: spec.actor.agentId,
		...(attemptGeneration === null ? {} : { attemptGeneration }),
		...(attemptId === null ? {} : { attemptId }),
		cutoverEpoch: spec.cutoverEpoch,
		kind: spec.kind,
		logicalEffectId: spec.logicalEffectId,
		...(taskId === null ? {} : { taskId }),
	});
	const effectKey = digest(
		canonicalize({
			invocationUid: spec.invocationUid,
			logicalKey,
		}),
	);
	const existing = readActionRowByEffectKey(tx, effectKey);
	if (existing) {
		if (
			spec.supersedesActionId !== undefined &&
			existing.supersedes_action_id !== supersedesActionId
		) {
			throw new Error("action supersede must use a new invocationUid");
		}
		const exactEnvelope =
			existing.kind === spec.kind &&
			existing.payload_digest === payloadDigest &&
			existing.task_id === taskId &&
			existing.attempt_id === attemptId &&
			existing.attempt_generation === attemptGeneration &&
			existing.logical_key === logicalKey &&
			existing.cutover_epoch === spec.cutoverEpoch &&
			existing.supersedes_action_id === supersedesActionId &&
			existing.retry_basis === retryBasis;
		if (!exactEnvelope) {
			throw new Error(`action effect key collision for ${effectKey}`);
		}
		return { outcome: "replayed", action: toSnapshot(existing) };
	}
	options.prepare?.(tx);

	tx.run(
		`INSERT INTO actions (
		   id, task_id, attempt_id, attempt_generation, activation_id,
		   actor_kind, actor_agent_id, actor_instance_id, actor_generation,
		   kind, payload, payload_digest, authorization, authorization_digest,
		   logical_key, effect_key, supersedes_action_id, retry_basis,
		   cutover_epoch, state, result, created_at, completed_at
		 ) VALUES (
		   @id, @taskId, @attemptId, @attemptGeneration, @activationId,
		   @actorKind, @actorAgentId, @actorInstanceId, @actorGeneration,
		   @kind, @payload, @payloadDigest, @authorization, @authorizationDigest,
		   @logicalKey, @effectKey, @supersedesActionId, @retryBasis,
		   @cutoverEpoch, 'intended', NULL, @createdAt, NULL
		 )`,
		{
			id: spec.id,
			taskId,
			attemptId,
			attemptGeneration,
			activationId:
				spec.actor.kind === "runner" ? spec.actor.activationId : null,
			actorKind: spec.actor.kind,
			actorAgentId: spec.actor.agentId,
			actorInstanceId: spec.actor.instanceId,
			actorGeneration: spec.actor.generation,
			kind: spec.kind,
			payload,
			payloadDigest,
			authorization,
			authorizationDigest,
			logicalKey,
			effectKey,
			supersedesActionId,
			retryBasis,
			cutoverEpoch: spec.cutoverEpoch,
			createdAt:
				spec.createdAt === undefined
					? new Date().toISOString()
					: requireCanonicalIso(spec.createdAt, "createdAt"),
		},
	);
	const action = readAction(tx, spec.id);
	if (!action) {
		throw new Error(`inserted action ${spec.id} is missing`);
	}
	return { outcome: "inserted", action };
}

export function recordActionOutcome(
	tx: WriteTx,
	spec: RecordActionOutcomeSpec,
): ActionSnapshot {
	requireNonEmpty(spec.id, "action id");
	requireNonEmpty(spec.actor.agentId, "actor.agentId");
	requireNonEmpty(spec.actor.instanceId, "actor.instanceId");
	requireGeneration(spec.actor.generation, "actor.generation");
	if (spec.actor.kind === "runner") {
		requireNonEmpty(spec.actor.activationId, "actor.activationId");
	}
	if (spec.state !== "succeeded" && spec.state !== "failed") {
		throw new TypeError("action outcome state must be succeeded or failed");
	}
	let result: string;
	try {
		result = canonicalize(spec.result);
	} catch (error) {
		throw new ActionSerializationError(error);
	}
	const completedAt =
		spec.completedAt === undefined
			? new Date().toISOString()
			: requireCanonicalIso(spec.completedAt, "completedAt");
	const activationId =
		spec.actor.kind === "runner" ? spec.actor.activationId : null;
	tx.cas(
		`UPDATE actions
		    SET state=@state, result=@result, completed_at=@completedAt
		  WHERE id=@id
		    AND state='intended'
		    AND actor_kind=@actorKind
		    AND actor_agent_id=@actorAgentId
		    AND actor_instance_id=@actorInstanceId
		    AND actor_generation=@actorGeneration
		    AND activation_id IS @activationId
		    AND (
		      (@actorKind='lead' AND EXISTS (
		        SELECT 1 FROM agents
		         WHERE agent_id=@actorAgentId
		           AND kind='lead'
		           AND generation=@actorGeneration
		      ))
		      OR
		      (@actorKind='runner' AND EXISTS (
		        SELECT 1 FROM activations
		         WHERE id=@activationId
		           AND session_ref=@actorAgentId
		           AND session_ref=@actorInstanceId
		           AND generation=@actorGeneration
		           AND state='active'
		      ))
		    )`,
		{
			id: spec.id,
			state: spec.state,
			result,
			completedAt,
			actorKind: spec.actor.kind,
			actorAgentId: spec.actor.agentId,
			actorInstanceId: spec.actor.instanceId,
			actorGeneration: spec.actor.generation,
			activationId,
		},
	);
	const action = readAction(tx, spec.id);
	if (!action) {
		throw new Error(`completed action ${spec.id} is missing`);
	}
	return action;
}
