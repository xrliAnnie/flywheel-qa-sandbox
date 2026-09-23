import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { Database } from "better-sqlite3";
import {
	parseClaudeUsageLine,
	parseCodexUsageLine,
	type WorkflowUsageObservation,
} from "./workflow-usage-source.js";

export type ScorecardAxis = "design" | "implement" | "qa" | "unassigned";

export interface WorkflowScorecardActivationRow {
	activation_id: string;
	execution_id: string;
	run_id: string;
	node_id: string;
	attempt: number;
	axis: ScorecardAxis;
	assignment_state: string;
	policy_version: string | null;
	arm_id: string | null;
	assignment_event_uid: string | null;
	assignment_digest: string | null;
	admitted_at: string;
	closed_at: string | null;
	close_event_uid: string | null;
	close_kind: string | null;
}

export interface WorkflowScorecardUsageRow {
	vendor: "claude" | "codex";
	native_session_id: string;
	source_generation: string;
	source_record_id: string;
	provider_request_id: string | null;
	native_turn_id: string | null;
	observed_model_id: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	reasoning_tokens: number | null;
	normalized_delta: number;
	source_digest: string;
	at: string;
	source_offset: number;
}

interface WorkflowScorecardCursorRow {
	vendor: "claude" | "codex";
	native_session_id: string;
	source_generation: string;
	execution_id: string;
	source_locator: string;
	committed_offset: number;
	source_fingerprint: string;
	coverage: string;
	error: string | null;
	final_watermark: number | null;
	updated_at: string;
}

function inside(root: string, path: string): boolean {
	const value = relative(root, path);
	return (
		value !== "" &&
		!isAbsolute(value) &&
		value !== ".." &&
		!value.startsWith(`..${sep}`)
	);
}

function json(line: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(line);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export class WorkflowScorecardStore {
	constructor(private readonly db: Database) {}

	migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS workflow_scorecard_activation (
				activation_id TEXT PRIMARY KEY
					REFERENCES workflow_execution_binding(activation_id) ON DELETE CASCADE,
				execution_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL CHECK (attempt > 0),
				axis TEXT NOT NULL CHECK (axis IN ('design','implement','qa','unassigned')),
				assignment_state TEXT NOT NULL,
				policy_version TEXT,
				arm_id TEXT,
				assignment_event_uid TEXT,
				assignment_digest TEXT,
				admitted_at TEXT NOT NULL,
				closed_at TEXT,
				close_event_uid TEXT,
				close_kind TEXT
			);
			CREATE INDEX IF NOT EXISTS workflow_scorecard_activation_run
				ON workflow_scorecard_activation(run_id, node_id, attempt);

			CREATE TABLE IF NOT EXISTS workflow_scorecard_turn (
				vendor TEXT NOT NULL CHECK (vendor IN ('claude','codex')),
				native_session_id TEXT NOT NULL,
				native_turn_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				activation_id TEXT REFERENCES workflow_execution_binding(activation_id) ON DELETE SET NULL,
				attribution_state TEXT NOT NULL,
				started_at TEXT NOT NULL,
				ended_at TEXT,
				source_generation TEXT NOT NULL,
				start_offset INTEGER,
				end_offset INTEGER,
				PRIMARY KEY (vendor, native_session_id, native_turn_id)
			);

			CREATE TABLE IF NOT EXISTS workflow_scorecard_usage (
				vendor TEXT NOT NULL CHECK (vendor IN ('claude','codex')),
				native_session_id TEXT NOT NULL,
				source_generation TEXT NOT NULL,
				source_record_id TEXT NOT NULL,
				provider_request_id TEXT,
				native_turn_id TEXT,
				observed_model_id TEXT,
				input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
				output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
				cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
				cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
				reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
				normalized_delta INTEGER NOT NULL CHECK (normalized_delta >= 0),
				source_digest TEXT NOT NULL,
				at TEXT NOT NULL,
				source_offset INTEGER NOT NULL CHECK (source_offset >= 0),
				PRIMARY KEY (vendor, native_session_id, source_generation, source_record_id)
			);

			CREATE TABLE IF NOT EXISTS workflow_scorecard_cursor (
				vendor TEXT NOT NULL CHECK (vendor IN ('claude','codex')),
				native_session_id TEXT NOT NULL,
				source_generation TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				source_locator TEXT NOT NULL,
				committed_offset INTEGER NOT NULL CHECK (committed_offset >= 0),
				source_fingerprint TEXT NOT NULL,
				coverage TEXT NOT NULL,
				error TEXT,
				final_watermark INTEGER CHECK (final_watermark IS NULL OR final_watermark >= 0),
				updated_at TEXT NOT NULL,
				PRIMARY KEY (vendor, native_session_id, source_generation)
			);

			CREATE TRIGGER IF NOT EXISTS workflow_scorecard_close_activation
			AFTER UPDATE OF ended_at ON workflow_run_node
			WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
			BEGIN
				UPDATE workflow_scorecard_activation
				   SET closed_at = NEW.ended_at, close_kind = NEW.state
				 WHERE run_id = NEW.run_id AND node_id = NEW.node_id
				   AND attempt = NEW.attempt AND execution_id = NEW.execution_id
				   AND closed_at IS NULL;
			END;
		`);
	}

	recordActivationSafely(input: {
		activationId: string;
		executionId: string;
		runId: string;
		nodeId: string;
		attempt: number;
		axis: ScorecardAxis;
		assignmentState: string;
		policyVersion?: string;
		armId?: string;
		assignmentEventUid?: string;
		assignmentDigest?: string;
		admittedAt: string;
	}): { ok: true } | { ok: false; reason: string } {
		this.db.exec("SAVEPOINT workflow_scorecard_activation_write");
		try {
			const existing = this.getActivation(input.activationId);
			const immutable = {
				activation_id: input.activationId,
				execution_id: input.executionId,
				run_id: input.runId,
				node_id: input.nodeId,
				attempt: input.attempt,
				axis: input.axis,
				assignment_state: input.assignmentState,
				policy_version: input.policyVersion ?? null,
				arm_id: input.armId ?? null,
				assignment_event_uid: input.assignmentEventUid ?? null,
				assignment_digest: input.assignmentDigest ?? null,
				admitted_at: input.admittedAt,
			};
			if (existing) {
				for (const [key, value] of Object.entries(immutable)) {
					if (existing[key as keyof WorkflowScorecardActivationRow] !== value)
						throw new Error("activation_replay_conflict");
				}
			} else {
				this.db
					.prepare(
						`INSERT INTO workflow_scorecard_activation
					 (activation_id, execution_id, run_id, node_id, attempt, axis,
					  assignment_state, policy_version, arm_id, assignment_event_uid,
					  assignment_digest, admitted_at)
					 VALUES (@activation_id, @execution_id, @run_id, @node_id, @attempt, @axis,
					  @assignment_state, @policy_version, @arm_id, @assignment_event_uid,
					  @assignment_digest, @admitted_at)`,
					)
					.run(immutable);
			}
			const terminalNode = this.db
				.prepare(
					`SELECT state, ended_at FROM workflow_run_node
					  WHERE run_id = ? AND node_id = ? AND attempt = ?
					    AND execution_id = ? AND ended_at IS NOT NULL`,
				)
				.get(input.runId, input.nodeId, input.attempt, input.executionId) as
				| { state: string; ended_at: string }
				| undefined;
			if (terminalNode) {
				this.db
					.prepare(
						`UPDATE workflow_scorecard_activation
						    SET closed_at = ?, close_kind = ?
						  WHERE activation_id = ? AND closed_at IS NULL`,
					)
					.run(terminalNode.ended_at, terminalNode.state, input.activationId);
			}
			this.db.exec("RELEASE SAVEPOINT workflow_scorecard_activation_write");
			return { ok: true };
		} catch (error) {
			this.db.exec("ROLLBACK TO SAVEPOINT workflow_scorecard_activation_write");
			this.db.exec("RELEASE SAVEPOINT workflow_scorecard_activation_write");
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	recordTurn(input: {
		vendor: "claude" | "codex";
		nativeSessionId: string;
		nativeTurnId: string;
		executionId: string;
		activationId?: string;
		attributionState: string;
		startedAt: string;
		sourceGeneration: string;
		startOffset?: number;
	}): { ok: true; deduped: boolean } | { ok: false; reason: string } {
		if (input.activationId) {
			const activation = this.getActivation(input.activationId);
			if (!activation || activation.execution_id !== input.executionId) {
				return { ok: false, reason: "activation_identity_mismatch" };
			}
		}
		const key = [input.vendor, input.nativeSessionId, input.nativeTurnId];
		const existing = this.db
			.prepare(
				`SELECT * FROM workflow_scorecard_turn
				  WHERE vendor = ? AND native_session_id = ? AND native_turn_id = ?`,
			)
			.get(...key) as Record<string, unknown> | undefined;
		const immutable: Record<string, unknown> = {
			vendor: input.vendor,
			native_session_id: input.nativeSessionId,
			native_turn_id: input.nativeTurnId,
			execution_id: input.executionId,
			activation_id: input.activationId ?? null,
			attribution_state: input.attributionState,
			started_at: input.startedAt,
			source_generation: input.sourceGeneration,
			start_offset: input.startOffset ?? null,
		};
		if (existing) {
			return existing.execution_id === input.executionId &&
				existing.activation_id === (input.activationId ?? null) &&
				existing.source_generation === input.sourceGeneration
				? { ok: true, deduped: true }
				: { ok: false, reason: "turn_replay_conflict" };
		}
		this.db
			.prepare(
				`INSERT INTO workflow_scorecard_turn
				 (vendor, native_session_id, native_turn_id, execution_id, activation_id,
				  attribution_state, started_at, source_generation, start_offset)
				 VALUES (@vendor, @native_session_id, @native_turn_id, @execution_id,
				  @activation_id, @attribution_state, @started_at, @source_generation,
				  @start_offset)`,
			)
			.run(immutable);
		return { ok: true, deduped: false };
	}

	closeActivationSafely(input: {
		activationId: string;
		closedAt: string;
		closeEventUid: string;
		closeKind: string;
	}): { ok: true; deduped: boolean } | { ok: false; reason: string } {
		this.db.exec("SAVEPOINT workflow_scorecard_activation_close");
		try {
			const existing = this.getActivation(input.activationId);
			if (!existing) throw new Error("activation_missing");
			if (existing.closed_at !== null) {
				if (
					existing.closed_at !== input.closedAt ||
					existing.close_event_uid !== input.closeEventUid ||
					existing.close_kind !== input.closeKind
				)
					throw new Error("activation_close_conflict");
				this.db.exec("RELEASE SAVEPOINT workflow_scorecard_activation_close");
				return { ok: true, deduped: true };
			}
			this.db
				.prepare(
					`UPDATE workflow_scorecard_activation
					    SET closed_at = ?, close_event_uid = ?, close_kind = ?
					  WHERE activation_id = ? AND closed_at IS NULL`,
				)
				.run(
					input.closedAt,
					input.closeEventUid,
					input.closeKind,
					input.activationId,
				);
			this.db.exec("RELEASE SAVEPOINT workflow_scorecard_activation_close");
			return { ok: true, deduped: false };
		} catch (error) {
			this.db.exec("ROLLBACK TO SAVEPOINT workflow_scorecard_activation_close");
			this.db.exec("RELEASE SAVEPOINT workflow_scorecard_activation_close");
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	recordUsage(input: {
		vendor: "claude" | "codex";
		nativeSessionId: string;
		sourceGeneration: string;
		observation: WorkflowUsageObservation;
	}):
		| { ok: true; deduped: boolean; normalizedDelta: number }
		| { ok: false; reason: string } {
		const observation = input.observation;
		if (!/^[a-f0-9]{64}$/.test(observation.sourceDigest))
			return { ok: false, reason: "source_digest_invalid" };
		if (observation.nativeTurnId) {
			const turn = this.db
				.prepare(
					`SELECT 1 FROM workflow_scorecard_turn
					  WHERE vendor = ? AND native_session_id = ? AND native_turn_id = ?
					    AND source_generation = ?`,
				)
				.get(
					input.vendor,
					input.nativeSessionId,
					observation.nativeTurnId,
					input.sourceGeneration,
				);
			if (!turn) return { ok: false, reason: "turn_not_registered" };
		}
		const existing = this.db
			.prepare(
				`SELECT * FROM workflow_scorecard_usage
				  WHERE vendor = ? AND native_session_id = ?
				    AND source_generation = ? AND source_record_id = ?`,
			)
			.get(
				input.vendor,
				input.nativeSessionId,
				input.sourceGeneration,
				observation.sourceRecordId,
			) as WorkflowScorecardUsageRow | undefined;
		if (existing) {
			return existing.source_digest === observation.sourceDigest
				? {
						ok: true,
						deduped: true,
						normalizedDelta: existing.normalized_delta,
					}
				: { ok: false, reason: "source_record_conflict" };
		}
		const previous = this.db
			.prepare(
				input.vendor === "codex"
					? `SELECT * FROM workflow_scorecard_usage
					    WHERE vendor = ? AND native_session_id = ? AND source_generation = ?
					    ORDER BY source_offset DESC LIMIT 1`
					: `SELECT * FROM workflow_scorecard_usage
					    WHERE vendor = ? AND native_session_id = ? AND source_generation = ?
					      AND provider_request_id = ?
					    ORDER BY source_offset DESC LIMIT 1`,
			)
			.get(
				input.vendor,
				input.nativeSessionId,
				input.sourceGeneration,
				...(input.vendor === "claude" ? [observation.providerRequestId] : []),
			) as WorkflowScorecardUsageRow | undefined;
		if (previous && observation.sourceOffset <= previous.source_offset)
			return { ok: false, reason: "source_offset_out_of_order" };
		const prior = {
			input: previous?.input_tokens ?? 0,
			output: previous?.output_tokens ?? 0,
			cacheRead: previous?.cache_read_tokens ?? 0,
			cacheWrite: previous?.cache_write_tokens ?? 0,
		};
		const codexCounterReset =
			input.vendor === "codex" &&
			previous !== undefined &&
			previous.native_turn_id !== observation.nativeTurnId &&
			(observation.inputTokens < prior.input ||
				observation.outputTokens < prior.output);
		const deltas =
			input.vendor === "codex"
				? codexCounterReset
					? [observation.inputTokens, observation.outputTokens]
					: [
							observation.inputTokens - prior.input,
							observation.outputTokens - prior.output,
						]
				: [
						observation.inputTokens - prior.input,
						observation.outputTokens - prior.output,
						observation.cacheReadTokens - prior.cacheRead,
						observation.cacheWriteTokens - prior.cacheWrite,
					];
		if (deltas.some((delta) => !Number.isSafeInteger(delta) || delta < 0))
			return { ok: false, reason: "usage_counter_regressed" };
		if (
			(input.vendor === "codex" &&
				observation.totalTokens !==
					observation.inputTokens + observation.outputTokens) ||
			(input.vendor === "claude" &&
				observation.totalTokens !==
					observation.inputTokens +
						observation.outputTokens +
						observation.cacheReadTokens +
						observation.cacheWriteTokens)
		) {
			return { ok: false, reason: "usage_total_invalid" };
		}
		const normalizedDelta = deltas.reduce((sum, delta) => sum + delta, 0);
		this.db
			.prepare(
				`INSERT INTO workflow_scorecard_usage
				 (vendor, native_session_id, source_generation, source_record_id,
				  provider_request_id, native_turn_id, observed_model_id, input_tokens,
				  output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
				  normalized_delta, source_digest, at, source_offset)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.vendor,
				input.nativeSessionId,
				input.sourceGeneration,
				observation.sourceRecordId,
				observation.providerRequestId,
				observation.nativeTurnId,
				observation.observedModelId,
				observation.inputTokens,
				observation.outputTokens,
				observation.cacheReadTokens,
				observation.cacheWriteTokens,
				observation.reasoningTokens,
				normalizedDelta,
				observation.sourceDigest,
				observation.at,
				observation.sourceOffset,
			);
		return { ok: true, deduped: false, normalizedDelta };
	}

	private usageSource(input: {
		vendor: "claude" | "codex";
		nativeSessionId: string;
		providerHome: string;
		sourcePath: string;
	}): {
		path: string;
		fingerprint: string;
		size: number;
		generation: string;
		buffer: Buffer;
	} {
		const home = realpathSync(input.providerHome);
		const path = realpathSync(input.sourcePath);
		const allowed =
			input.vendor === "codex"
				? [join(home, "sessions"), join(home, "archived_sessions")]
				: [join(home, "projects")];
		if (
			!isAbsolute(input.sourcePath) ||
			!allowed.some((root) => inside(root, path))
		)
			throw new Error("usage_source_path_invalid");
		const descriptor = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		try {
			const stat = fstatSync(descriptor);
			if (!stat.isFile()) throw new Error("usage_source_path_invalid");
			if (
				input.vendor === "claude" &&
				basename(path) !== `${input.nativeSessionId}.jsonl`
			)
				throw new Error("claude_session_identity_mismatch");
			const buffer = readFileSync(descriptor);
			const fingerprint = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
			const generation = createHash("sha256")
				.update(`${path}\0${fingerprint}`)
				.digest("hex");
			if (input.vendor === "codex") {
				const newline = buffer.subarray(0, 65_536).indexOf(10);
				if (newline < 0) throw new Error("codex_session_meta_missing");
				const meta = json(buffer.subarray(0, newline).toString("utf8"));
				const payload =
					typeof meta?.payload === "object" && meta.payload !== null
						? (meta.payload as Record<string, unknown>)
						: undefined;
				if (
					meta?.type !== "session_meta" ||
					payload?.id !== input.nativeSessionId
				)
					throw new Error("codex_session_identity_mismatch");
			}
			return {
				path,
				fingerprint,
				size: buffer.length,
				generation,
				buffer,
			};
		} finally {
			closeSync(descriptor);
		}
	}

	bindUsageSource(input: {
		vendor: "claude" | "codex";
		nativeSessionId: string;
		executionId: string;
		activationId: string;
		providerHome: string;
		sourcePath: string;
		boundAt: string;
	}):
		| {
				ok: true;
				sourceGeneration: string;
				committedOffset: number;
				deduped: boolean;
		  }
		| { ok: false; reason: string } {
		const activation = this.getActivation(input.activationId);
		if (!activation || activation.execution_id !== input.executionId)
			return { ok: false, reason: "activation_identity_mismatch" };
		try {
			const source = this.usageSource(input);
			const existing = this.db
				.prepare(
					`SELECT * FROM workflow_scorecard_cursor
					  WHERE vendor = ? AND native_session_id = ? AND source_generation = ?`,
				)
				.get(input.vendor, input.nativeSessionId, source.generation) as
				| WorkflowScorecardCursorRow
				| undefined;
			if (existing) {
				if (
					existing.execution_id !== input.executionId ||
					existing.source_locator !== source.path ||
					existing.source_fingerprint !== source.fingerprint
				) {
					return { ok: false, reason: "usage_source_replay_conflict" };
				}
				return {
					ok: true,
					sourceGeneration: source.generation,
					committedOffset: existing.committed_offset,
					deduped: true,
				};
			}
			this.db
				.prepare(
					`INSERT INTO workflow_scorecard_cursor
					 (vendor, native_session_id, source_generation, execution_id,
					  source_locator, committed_offset, source_fingerprint, coverage,
					  error, final_watermark, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?)`,
				)
				.run(
					input.vendor,
					input.nativeSessionId,
					source.generation,
					input.executionId,
					source.path,
					source.size,
					source.fingerprint,
					input.boundAt,
				);
			return {
				ok: true,
				sourceGeneration: source.generation,
				committedOffset: source.size,
				deduped: false,
			};
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	importUsageSource(input: {
		vendor: "claude" | "codex";
		nativeSessionId: string;
		executionId: string;
		activationId: string;
		providerHome: string;
		sourcePath: string;
		final: boolean;
		allowBootstrap?: boolean;
	}):
		| {
				ok: true;
				imported: number;
				deduped: number;
				coverage: "open" | "complete";
				committedOffset: number;
		  }
		| { ok: false; reason: string } {
		const activation = this.getActivation(input.activationId);
		if (!activation || activation.execution_id !== input.executionId)
			return { ok: false, reason: "activation_identity_mismatch" };
		let savepoint = false;
		try {
			const source = this.usageSource(input);
			this.db.exec("SAVEPOINT workflow_scorecard_usage_import");
			savepoint = true;
			let cursor = this.db
				.prepare(
					`SELECT * FROM workflow_scorecard_cursor
					  WHERE vendor = ? AND native_session_id = ? AND source_generation = ?`,
				)
				.get(input.vendor, input.nativeSessionId, source.generation) as
				| WorkflowScorecardCursorRow
				| undefined;
			if (!cursor && input.allowBootstrap) {
				this.db
					.prepare(
						`INSERT INTO workflow_scorecard_cursor
						 (vendor, native_session_id, source_generation, execution_id,
						  source_locator, committed_offset, source_fingerprint, coverage,
						  error, final_watermark, updated_at)
						 VALUES (?, ?, ?, ?, ?, 0, ?, 'open', NULL, NULL, ?)`,
					)
					.run(
						input.vendor,
						input.nativeSessionId,
						source.generation,
						input.executionId,
						source.path,
						source.fingerprint,
						new Date().toISOString(),
					);
				cursor = this.db
					.prepare(
						`SELECT * FROM workflow_scorecard_cursor
						  WHERE vendor = ? AND native_session_id = ? AND source_generation = ?`,
					)
					.get(
						input.vendor,
						input.nativeSessionId,
						source.generation,
					) as WorkflowScorecardCursorRow;
			}
			if (!cursor) throw new Error("usage_cursor_missing");
			if (
				cursor.execution_id !== input.executionId ||
				cursor.source_locator !== source.path ||
				cursor.source_fingerprint !== source.fingerprint ||
				source.size < cursor.committed_offset
			) {
				throw new Error("usage_source_changed");
			}
			const buffer = source.buffer;
			const tail = buffer.subarray(cursor.committed_offset);
			const finalNewline = tail.lastIndexOf(10);
			let completeLength = finalNewline < 0 ? 0 : finalNewline + 1;
			if (
				input.final &&
				completeLength < tail.length &&
				json(tail.subarray(completeLength).toString("utf8"))
			)
				completeLength = tail.length;
			const complete = tail.subarray(0, completeLength);
			let nativeTurnId: string | undefined;
			let model: string | undefined;
			const priorTurn = this.db
				.prepare(
					`SELECT native_turn_id FROM workflow_scorecard_turn
					  WHERE vendor = ? AND native_session_id = ? AND source_generation = ?
					  ORDER BY start_offset DESC LIMIT 1`,
				)
				.get(input.vendor, input.nativeSessionId, source.generation) as
				| { native_turn_id: string }
				| undefined;
			nativeTurnId = priorTurn?.native_turn_id;
			let imported = 0;
			let deduped = 0;
			let position = 0;
			while (position < complete.length) {
				const newline = complete.indexOf(10, position);
				const end = newline < 0 ? complete.length : newline;
				const offset = cursor.committed_offset + position;
				const line = complete.subarray(position, end).toString("utf8");
				position = newline < 0 ? complete.length : newline + 1;
				const row = json(line);
				const payload =
					typeof row?.payload === "object" && row.payload !== null
						? (row.payload as Record<string, unknown>)
						: undefined;
				if (input.vendor === "codex" && row?.type === "turn_context") {
					if (
						typeof payload?.turn_id === "string" &&
						payload.turn_id &&
						typeof payload.model === "string" &&
						payload.model &&
						typeof row.timestamp === "string" &&
						Number.isFinite(Date.parse(row.timestamp))
					) {
						nativeTurnId = payload.turn_id;
						model = payload.model;
						const turn = this.recordTurn({
							vendor: input.vendor,
							nativeSessionId: input.nativeSessionId,
							nativeTurnId,
							executionId: input.executionId,
							activationId: input.activationId,
							attributionState: "attributed",
							startedAt: row.timestamp,
							sourceGeneration: source.generation,
							startOffset: offset,
						});
						if (!turn.ok) throw new Error(turn.reason);
					}
					continue;
				}
				if (input.vendor === "claude" && row?.type === "user") {
					if (
						row.isMeta !== true &&
						typeof row.uuid === "string" &&
						row.uuid &&
						typeof row.timestamp === "string" &&
						Number.isFinite(Date.parse(row.timestamp))
					) {
						nativeTurnId = row.uuid;
						const turn = this.recordTurn({
							vendor: input.vendor,
							nativeSessionId: input.nativeSessionId,
							nativeTurnId,
							executionId: input.executionId,
							activationId: input.activationId,
							attributionState: "attributed",
							startedAt: row.timestamp,
							sourceGeneration: source.generation,
							startOffset: offset,
						});
						if (!turn.ok) throw new Error(turn.reason);
					}
					continue;
				}
				const observation =
					input.vendor === "codex"
						? model
							? parseCodexUsageLine(line, { offset, nativeTurnId, model })
							: null
						: parseClaudeUsageLine(line, { offset, nativeTurnId });
				if (!observation) {
					const message =
						typeof row?.message === "object" && row.message !== null
							? (row.message as Record<string, unknown>)
							: undefined;
					const usage =
						typeof message?.usage === "object" && message.usage !== null
							? (message.usage as Record<string, unknown>)
							: undefined;
					if (
						(input.vendor === "codex" &&
							row?.type === "event_msg" &&
							payload?.type === "token_count" &&
							payload.info !== null) ||
						(input.vendor === "claude" &&
							row?.type === "assistant" &&
							usage &&
							!(
								(row.requestId === undefined || row.requestId === null) &&
								message?.model === "<synthetic>" &&
								usage.input_tokens === 0 &&
								usage.output_tokens === 0 &&
								usage.cache_read_input_tokens === 0 &&
								usage.cache_creation_input_tokens === 0
							))
					)
						throw new Error("unsupported_counter");
					continue;
				}
				const result = this.recordUsage({
					vendor: input.vendor,
					nativeSessionId: input.nativeSessionId,
					sourceGeneration: source.generation,
					observation,
				});
				if (!result.ok) throw new Error(result.reason);
				if (result.deduped) deduped += 1;
				else imported += 1;
			}
			const committedOffset = cursor.committed_offset + complete.length;
			const coverage =
				input.final && committedOffset === source.size ? "complete" : "open";
			this.db
				.prepare(
					`UPDATE workflow_scorecard_cursor
					    SET committed_offset = ?, coverage = ?, error = NULL,
					        final_watermark = ?, updated_at = ?
					  WHERE vendor = ? AND native_session_id = ? AND source_generation = ?`,
				)
				.run(
					committedOffset,
					coverage,
					coverage === "complete" ? committedOffset : null,
					new Date().toISOString(),
					input.vendor,
					input.nativeSessionId,
					source.generation,
				);
			this.db.exec("RELEASE SAVEPOINT workflow_scorecard_usage_import");
			savepoint = false;
			return { ok: true, imported, deduped, coverage, committedOffset };
		} catch (error) {
			if (savepoint) {
				this.db.exec("ROLLBACK TO SAVEPOINT workflow_scorecard_usage_import");
				this.db.exec("RELEASE SAVEPOINT workflow_scorecard_usage_import");
			}
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	getActivation(
		activationId: string,
	): WorkflowScorecardActivationRow | undefined {
		return this.db
			.prepare(
				"SELECT * FROM workflow_scorecard_activation WHERE activation_id = ?",
			)
			.get(activationId) as WorkflowScorecardActivationRow | undefined;
	}

	listActivations(runId: string): WorkflowScorecardActivationRow[] {
		return this.db
			.prepare(
				"SELECT * FROM workflow_scorecard_activation WHERE run_id = ? ORDER BY admitted_at, activation_id",
			)
			.all(runId) as WorkflowScorecardActivationRow[];
	}

	listUsageForRun(runId: string): WorkflowScorecardUsageRow[] {
		return this.db
			.prepare(
				`SELECT usage.*
				   FROM workflow_scorecard_usage usage
				   JOIN workflow_scorecard_turn turn
				     ON turn.vendor = usage.vendor
				    AND turn.native_session_id = usage.native_session_id
				    AND turn.source_generation = usage.source_generation
				    AND turn.native_turn_id = usage.native_turn_id
				   JOIN workflow_scorecard_activation activation
				     ON activation.activation_id = turn.activation_id
				  WHERE activation.run_id = ?
				  ORDER BY usage.source_offset`,
			)
			.all(runId) as WorkflowScorecardUsageRow[];
	}
}
