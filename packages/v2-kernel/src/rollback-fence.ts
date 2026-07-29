import { createHash } from "node:crypto";
import { FenceViolation } from "./errors.js";
import type { Kernel, ReadTx, WriteTx } from "./kernel.js";

export type DatabaseAuthorityState = "cutover" | "live";
export type RollbackState = "clear" | "rollback_started";

export interface RollbackFenceSnapshot {
	authorityState: DatabaseAuthorityState;
	effectIntentCount: number;
	rollbackState: RollbackState;
}

interface MetaRow {
	key: string;
	value: string;
}

function requireIso(value: string): void {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new TypeError("nowIso must be canonical UTC ISO-8601");
	}
}

function requireNonEmpty(value: string, name: string): void {
	if (value.trim().length === 0) {
		throw new TypeError(`${name} must not be empty`);
	}
}

function readFenceTx(tx: ReadTx): RollbackFenceSnapshot {
	const rows = new Map(
		tx
			.all<MetaRow>(
				`SELECT key,value FROM meta
				  WHERE key IN (
				    'cutover_authority_state',
				    'external_effect_intent_count',
				    'rollback_state'
				  )`,
			)
			.map((row) => [row.key, row.value]),
	);
	if (rows.size !== 3) {
		throw new FenceViolation("cutover rollback fence is missing");
	}
	const authorityState = rows.get("cutover_authority_state");
	const rollbackState = rows.get("rollback_state");
	const countRaw = rows.get("external_effect_intent_count");
	if (
		(authorityState !== "cutover" && authorityState !== "live") ||
		(rollbackState !== "clear" && rollbackState !== "rollback_started") ||
		!countRaw ||
		!/^(0|[1-9][0-9]*)$/.test(countRaw)
	) {
		throw new FenceViolation("cutover rollback fence is malformed");
	}
	const effectIntentCount = Number(countRaw);
	if (!Number.isSafeInteger(effectIntentCount)) {
		throw new FenceViolation("cutover rollback fence is malformed");
	}
	return {
		authorityState,
		effectIntentCount,
		rollbackState,
	};
}

export function initializeRollbackFenceTx(
	tx: WriteTx,
	input: {
		authorityState: DatabaseAuthorityState;
		nowIso: string;
	},
): void {
	requireIso(input.nowIso);
	const existing = tx.all<MetaRow>(
		`SELECT key,value FROM meta
		  WHERE key IN (
		    'cutover_authority_state',
		    'external_effect_intent_count',
		    'rollback_state'
		  )`,
	);
	if (existing.length > 0) {
		const snapshot = readFenceTx(tx);
		if (snapshot.authorityState !== input.authorityState) {
			throw new FenceViolation(
				"existing cutover rollback fence conflicts with initialization",
			);
		}
		return;
	}
	tx.run(
		`INSERT INTO meta(key,value,updated_at) VALUES
		 ('cutover_authority_state',@authorityState,@nowIso),
		 ('external_effect_intent_count','0',@nowIso),
		 ('rollback_state','clear',@nowIso)`,
		input,
	);
}

export function advanceDatabaseAuthorityStateTx(
	tx: WriteTx,
	input: {
		expected: "cutover";
		next: "live";
		nowIso: string;
	},
): void {
	requireIso(input.nowIso);
	const current = readFenceTx(tx);
	if (
		current.authorityState !== input.expected ||
		current.rollbackState !== "clear"
	) {
		throw new FenceViolation("database authority state cannot advance");
	}
	tx.cas(
		`UPDATE meta SET value=@next,updated_at=@nowIso
		  WHERE key='cutover_authority_state' AND value=@expected`,
		input,
	);
}

export function recordExternalEffectIntentTx(
	tx: WriteTx,
	input: {
		effectKey: string;
		family: string;
		nowIso: string;
	},
): boolean {
	requireNonEmpty(input.effectKey, "effectKey");
	requireNonEmpty(input.family, "family");
	requireIso(input.nowIso);
	const fence = readFenceTx(tx);
	if (fence.rollbackState !== "clear") {
		throw new FenceViolation("external effect rejected after rollback started");
	}
	const digest = createHash("sha256").update(input.effectKey).digest("hex");
	const key = `external_effect_intent:${digest}`;
	const value = JSON.stringify({
		v: 1,
		effect_key: input.effectKey,
		family: input.family,
	});
	const inserted = tx.run(
		`INSERT OR IGNORE INTO meta(key,value,updated_at)
		 VALUES (@key,@value,@nowIso)`,
		{ key, value, nowIso: input.nowIso },
	);
	if (inserted.changes === 0) {
		const existing = tx.get<{ value: string }>(
			"SELECT value FROM meta WHERE key=@key",
			{ key },
		);
		if (existing?.value !== value) {
			throw new FenceViolation("external effect intent digest collision");
		}
		return false;
	}
	tx.cas(
		`UPDATE meta
		    SET value=CAST(value AS INTEGER)+1,updated_at=@nowIso
		  WHERE key='external_effect_intent_count'
		    AND value=@expectedCount
		    AND EXISTS (
		      SELECT 1 FROM meta
		       WHERE key='rollback_state' AND value='clear'
		    )`,
		{
			expectedCount: String(fence.effectIntentCount),
			nowIso: input.nowIso,
		},
	);
	return true;
}

export function rollbackGateCas(
	tx: WriteTx,
	nowIso: string,
): RollbackFenceSnapshot {
	requireIso(nowIso);
	const current = readFenceTx(tx);
	if (current.effectIntentCount !== 0) {
		throw new FenceViolation(
			"rollback rejected after an external effect intent",
		);
	}
	if (current.rollbackState !== "clear") {
		throw new FenceViolation("rollback has already started");
	}
	tx.cas(
		`UPDATE meta SET value='rollback_started',updated_at=@nowIso
		  WHERE key='rollback_state' AND value='clear'
		    AND EXISTS (
		      SELECT 1 FROM meta
		       WHERE key='cutover_authority_state'
		         AND value IN ('cutover','live')
		    )
		    AND EXISTS (
		      SELECT 1 FROM meta
		       WHERE key='external_effect_intent_count' AND value='0'
		    )`,
		{ nowIso },
	);
	return { ...current, rollbackState: "rollback_started" };
}

export function readRollbackFence(kernel: Kernel): RollbackFenceSnapshot {
	return kernel.read((tx) => readFenceTx(tx));
}
