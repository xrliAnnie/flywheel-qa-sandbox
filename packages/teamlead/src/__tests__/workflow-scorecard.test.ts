import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore, type WorkflowRunEventRow } from "../StateStore.js";
import {
	readScorecardAssignment,
	readScorecardDegradation,
} from "../workflow-model-assignment.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const cleanups: string[] = [];

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

afterEach(() => {
	for (const path of cleanups.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function createImplementRun(store: StateStore): void {
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "scorecard-test", revision: 1 },
		canonicalRoot: REPO_ROOT,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-6-sol",
					effort: "low",
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "claude-opus-5",
					effort: "high",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "implemented",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_passed",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
			],
			loops: [
				{
					id: "qa_rework",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 2,
					on_limit: "escalate",
				},
			],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["qa_passed", "founder_approved"],
		},
	});
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-2789",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
}

function event(
	input: Partial<WorkflowRunEventRow> &
		Pick<WorkflowRunEventRow, "event_uid" | "kind" | "payload">,
): WorkflowRunEventRow {
	return {
		run_id: "run-1",
		seq: 1,
		node_id: "implement",
		edge_id: null,
		execution_id: null,
		at: "2026-09-23 04:00:00",
		...input,
	};
}

describe("scorecard assignment reader", () => {
	it.each([
		["design", "design_g1"],
		["design", "design_g2"],
		["design", "design_g3"],
		["implement", "impl_opus"],
		["implement", "impl_sol56"],
		["implement", "impl_sol6"],
		["qa", "qa_sol56"],
		["qa", "qa_sol6"],
		["qa", "qa_opus"],
	] as const)("preserves the opaque %s arm %s", (nodeId, arm) => {
		expect(
			readScorecardAssignment(
				[
					event({
						node_id: nodeId,
						event_uid: `model_arm_assigned:run-1:${nodeId}`,
						kind: "model_arm_assigned",
						payload: {
							schemaVersion: 1,
							runId: "run-1",
							nodeId,
							policyVersion: "policy-v1",
							arm,
							resolvedModel: "exact-model-id",
							assignedAt: "2026-09-23T04:00:00.000Z",
						},
					}),
				],
				{ runId: "run-1", nodeId },
			),
		).toMatchObject({ state: "assigned", receipt: { arm } });
	});

	it("normalizes canonical, legacy, and unassigned receipts without choosing an arm", () => {
		expect(
			readScorecardAssignment([], { runId: "run-1", nodeId: "implement" }),
		).toEqual({ state: "unassigned" });

		expect(
			readScorecardAssignment(
				[
					event({
						event_uid: "model_arm_assigned:run-1:implement",
						kind: "model_arm_assigned",
						payload: {
							schemaVersion: 1,
							runId: "run-1",
							nodeId: "implement",
							policyVersion: "impl-v1",
							arm: "impl_sol",
							resolvedModel: "gpt-6-sol",
							assignedAt: "2026-09-23T04:00:00.000Z",
						},
					}),
				],
				{ runId: "run-1", nodeId: "implement" },
			),
		).toMatchObject({
			state: "assigned",
			receipt: {
				policyVersion: "impl-v1",
				arm: "impl_sol",
				resolvedModel: "gpt-6-sol",
			},
		});

		expect(
			readScorecardAssignment(
				[
					event({
						event_uid: "design_model_arm_assigned:run-1:implement",
						kind: "design_model_arm_assigned",
						payload: {
							arm: "impl_opus",
							model: "claude-opus-4-1",
							basis: { ruleVersion: "legacy-v1" },
						},
					}),
				],
				{ runId: "run-1", nodeId: "implement" },
			),
		).toMatchObject({
			state: "assigned",
			receipt: {
				policyVersion: "legacy-v1",
				arm: "impl_opus",
				resolvedModel: "claude-opus-4-1",
				assignedAt: "2026-09-23T04:00:00.000Z",
			},
		});
	});

	it("fails visibly when canonical and legacy receipts disagree", () => {
		const result = readScorecardAssignment(
			[
				event({
					event_uid: "model_arm_assigned:run-1:implement",
					kind: "model_arm_assigned",
					payload: {
						schemaVersion: 1,
						runId: "run-1",
						nodeId: "implement",
						policyVersion: "impl-v1",
						arm: "impl_sol",
						resolvedModel: "gpt-6-sol",
						assignedAt: "2026-09-23T04:00:00.000Z",
					},
				}),
				event({
					seq: 2,
					event_uid: "design_model_arm_assigned:run-1:implement",
					kind: "design_model_arm_assigned",
					payload: {
						arm: "impl_opus",
						model: "claude-opus-4-1",
						basis: { ruleVersion: "impl-v1" },
					},
				}),
			],
			{ runId: "run-1", nodeId: "implement" },
		);
		expect(result).toMatchObject({ state: "invalid_assignment" });
		expect(
			readScorecardAssignment(
				[
					event({
						event_uid: "wrong-envelope",
						kind: "model_arm_assigned",
						payload: {
							schemaVersion: 1,
							runId: "run-1",
							nodeId: "implement",
							policyVersion: "impl-v1",
							arm: "impl_sol",
							resolvedModel: "gpt-6-sol",
							assignedAt: "2026-09-23T04:00:00.000Z",
						},
					}),
				],
				{ runId: "run-1", nodeId: "implement" },
			),
		).toMatchObject({ state: "unknown" });
	});

	it("accepts only authority-linked degradation receipts matching the launched model", () => {
		const assignment = {
			state: "assigned" as const,
			receipt: {
				schemaVersion: 1 as const,
				runId: "run-1",
				nodeId: "implement",
				policyVersion: "impl-v1",
				arm: "impl_sol",
				resolvedModel: "gpt-6-sol",
				assignedAt: "2026-09-23T04:00:00.000Z",
			},
			eventUid: "model_arm_assigned:run-1:implement",
			digest: "a".repeat(64),
		};
		const receipt = event({
			seq: 2,
			execution_id: "exec-1",
			event_uid:
				"model_arm_degraded:run-1:implement:activation:exec-1:run-1:implement:1",
			kind: "model_arm_degraded",
			payload: {
				schemaVersion: 1,
				runId: "run-1",
				nodeId: "implement",
				activationId: "activation:exec-1:run-1:implement:1",
				assignmentEventUid: "model_arm_assigned:run-1:implement",
				arm: "impl_sol",
				degraded: true,
				assignedModel: "gpt-6-sol",
				actualModel: "claude-opus-5",
				reason: "codex_pool_exhausted",
				degradedAt: "2026-09-23T04:00:01.000Z",
			},
		});
		expect(
			readScorecardDegradation(
				[
					receipt,
					event({
						seq: 3,
						event_uid:
							"model_arm_degraded:run-1:implement:activation:exec-2:run-1:implement:1",
						kind: "model_arm_degraded",
						payload: {
							...(receipt.payload as Record<string, unknown>),
							activationId: "activation:exec-2:run-1:implement:1",
						},
					}),
				],
				{
					runId: "run-1",
					nodeId: "implement",
					activationId: "activation:exec-1:run-1:implement:1",
					launchModel: "claude-opus-5",
					assignment,
				},
			),
		).toMatchObject({ state: "degraded", receipt: { arm: "impl_sol" } });
		expect(
			readScorecardDegradation(
				[
					{
						...receipt,
						payload: {
							...(receipt.payload as Record<string, unknown>),
							actualModel: "forged-model",
						},
					},
				],
				{
					runId: "run-1",
					nodeId: "implement",
					activationId: "activation:exec-1:run-1:implement:1",
					launchModel: "claude-opus-5",
					assignment,
				},
			),
		).toMatchObject({ state: "invalid_degradation" });
	});
});

describe("scorecard activation ledger", () => {
	it("records one immutable activation and closes it on terminal replay", async () => {
		const store = await StateStore.create(":memory:");
		createImplementRun(store);
		store.appendWorkflowRunEvent({
			runId: "run-1",
			nodeId: "implement",
			eventUid: "model_arm_assigned:run-1:implement",
			kind: "model_arm_assigned",
			payload: {
				schemaVersion: 1,
				runId: "run-1",
				nodeId: "implement",
				policyVersion: "impl-v1",
				arm: "impl_sol",
				resolvedModel: "gpt-6-sol",
				assignedAt: "2026-09-23T04:00:00.000Z",
			},
		});
		const input = {
			runId: "run-1",
			nodeId: "implement",
			executionId: "exec-1",
			attempt: 1,
			now: "2026-09-23T04:00:00.000Z",
			expiresAt: "2026-09-23T05:00:00.000Z",
			absoluteDeadlineAt: "2026-09-24T04:00:00.000Z",
		};
		expect(store.admitGeneralizedWorkflowExecution(input)).toMatchObject({
			ok: true,
			idempotentReplay: false,
		});
		expect(store.admitGeneralizedWorkflowExecution(input)).toMatchObject({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			store.workflowScorecard.getActivation(
				"activation:exec-1:run-1:implement:1",
			),
		).toMatchObject({
			axis: "implement",
			assignment_state: "assigned",
			arm_id: "impl_sol",
			closed_at: null,
		});
		expect(store.workflowScorecard.listActivations("run-1")).toHaveLength(1);
		expect(
			store.workflowScorecard.recordTurn({
				vendor: "codex",
				nativeSessionId: "thread-1",
				nativeTurnId: "turn-1",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				attributionState: "attributed",
				startedAt: "2026-09-23T04:00:00.100Z",
				sourceGeneration: "generation-1",
				startOffset: 10,
			}),
		).toEqual({ ok: true, deduped: false });
		expect(
			store.workflowScorecard.recordTurn({
				vendor: "codex",
				nativeSessionId: "thread-1",
				nativeTurnId: "turn-1",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				attributionState: "attributed",
				startedAt: "2026-09-23T04:00:00.200Z",
				sourceGeneration: "generation-other",
				startOffset: 20,
			}),
		).toEqual({ ok: false, reason: "turn_replay_conflict" });
		const usage = (
			offset: number,
			inputTokens: number,
			outputTokens: number,
		) => ({
			sourceRecordId: String(offset),
			sourceOffset: offset,
			sourceDigest: String(offset).padStart(64, "0"),
			providerRequestId: null,
			nativeTurnId: "turn-1",
			observedModelId: "gpt-6-sol",
			inputTokens,
			outputTokens,
			cacheReadTokens: Math.min(inputTokens, 80),
			cacheWriteTokens: 0,
			reasoningTokens: Math.min(outputTokens, 10),
			totalTokens: inputTokens + outputTokens,
			at: "2026-09-23T04:00:01.000Z",
		});
		expect(
			store.workflowScorecard.recordUsage({
				vendor: "codex",
				nativeSessionId: "thread-1",
				sourceGeneration: "generation-other",
				observation: usage(10, 1, 1),
			}),
		).toEqual({ ok: false, reason: "turn_not_registered" });
		expect(
			store.workflowScorecard.recordUsage({
				vendor: "codex",
				nativeSessionId: "thread-1",
				sourceGeneration: "generation-1",
				observation: usage(20, 100, 20),
			}),
		).toMatchObject({ ok: true, deduped: false, normalizedDelta: 120 });
		expect(
			store.workflowScorecard.recordUsage({
				vendor: "codex",
				nativeSessionId: "thread-1",
				sourceGeneration: "generation-1",
				observation: usage(30, 130, 25),
			}),
		).toMatchObject({ ok: true, deduped: false, normalizedDelta: 35 });
		expect(
			store.workflowScorecard.recordUsage({
				vendor: "codex",
				nativeSessionId: "thread-1",
				sourceGeneration: "generation-1",
				observation: usage(30, 130, 25),
			}),
		).toMatchObject({ ok: true, deduped: true, normalizedDelta: 35 });
		expect(store.workflowScorecard.listUsageForRun("run-1")).toMatchObject([
			{ source_record_id: "20", normalized_delta: 120 },
			{ source_record_id: "30", normalized_delta: 35 },
		]);

		const codexHome = mkdtempSync(join(tmpdir(), "fly2789-codex-home-"));
		cleanups.push(codexHome);
		const sessions = join(codexHome, "sessions", "2026", "09", "23");
		mkdirSync(sessions, { recursive: true });
		const rollout = join(sessions, "rollout-thread-2.jsonl");
		writeFileSync(
			rollout,
			`${JSON.stringify({ type: "session_meta", payload: { id: "thread-2" } })}\n`,
		);
		expect(
			store.workflowScorecard.bindUsageSource({
				vendor: "codex",
				nativeSessionId: "thread-2",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: codexHome,
				sourcePath: rollout,
				boundAt: "2026-09-23T04:00:00.000Z",
			}),
		).toMatchObject({ ok: true, committedOffset: expect.any(Number) });
		appendFileSync(
			rollout,
			[
				JSON.stringify({
					timestamp: "2026-09-23T04:00:01.000Z",
					type: "turn_context",
					payload: {
						turn_id: "turn-2",
						model: "gpt-6-sol",
						effort: "xhigh",
					},
				}),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:01.500Z",
					type: "event_msg",
					payload: {
						type: "token_count",
						info: null,
						rate_limits: { primary: { used_percent: 1 } },
					},
				}),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:02.000Z",
					type: "event_msg",
					payload: {
						type: "token_count",
						info: {
							total_token_usage: {
								input_tokens: 50,
								cached_input_tokens: 30,
								output_tokens: 10,
								reasoning_output_tokens: 5,
								total_tokens: 60,
							},
						},
					},
				}),
			].join("\n"),
		);
		expect(
			store.workflowScorecard.importUsageSource({
				vendor: "codex",
				nativeSessionId: "thread-2",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: codexHome,
				sourcePath: rollout,
				final: true,
			}),
		).toMatchObject({
			ok: true,
			imported: 1,
			deduped: 0,
			coverage: "complete",
		});
		expect(
			store.workflowScorecard.importUsageSource({
				vendor: "codex",
				nativeSessionId: "thread-2",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: codexHome,
				sourcePath: rollout,
				final: true,
			}),
		).toMatchObject({ ok: true, imported: 0, coverage: "complete" });

		const claudeHome = mkdtempSync(join(tmpdir(), "fly2789-claude-home-"));
		cleanups.push(claudeHome);
		const projects = join(claudeHome, "projects", "fixture");
		mkdirSync(projects, { recursive: true });
		const transcript = join(projects, "session-1.jsonl");
		writeFileSync(
			transcript,
			`${[
				JSON.stringify({
					type: "user",
					uuid: "claude-turn-1",
					timestamp: "2026-09-23T04:00:00.000Z",
					message: { role: "user", content: "continue" },
				}),
				JSON.stringify({
					type: "assistant",
					isApiErrorMessage: true,
					timestamp: "2026-09-23T04:00:00.500Z",
					message: {
						model: "<synthetic>",
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
				JSON.stringify({
					type: "assistant",
					requestId: "req-claude-1",
					timestamp: "2026-09-23T04:00:01.000Z",
					message: {
						model: "claude-opus-5",
						usage: {
							input_tokens: 10,
							output_tokens: 20,
							cache_read_input_tokens: 30,
							cache_creation_input_tokens: 40,
						},
					},
				}),
			].join("\n")}\n`,
		);
		expect(
			store.workflowScorecard.importUsageSource({
				vendor: "claude",
				nativeSessionId: "session-1",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: claudeHome,
				sourcePath: transcript,
				final: true,
				allowBootstrap: true,
			}),
		).toMatchObject({
			ok: true,
			imported: 1,
			deduped: 0,
			coverage: "complete",
		});
		expect(
			store.workflowScorecard
				.listUsageForRun("run-1")
				.filter((row) => row.native_session_id === "session-1"),
		).toMatchObject([{ normalized_delta: 100 }]);

		const rollbackRollout = join(sessions, "rollout-thread-3.jsonl");
		const codexLine = (
			inputTokens: number,
			outputTokens: number,
			second: number,
		) =>
			JSON.stringify({
				timestamp: `2026-09-23T04:00:0${second}.000Z`,
				type: "event_msg",
				payload: {
					type: "token_count",
					info: {
						total_token_usage: {
							input_tokens: inputTokens,
							cached_input_tokens: 0,
							output_tokens: outputTokens,
							reasoning_output_tokens: 0,
							total_tokens: inputTokens + outputTokens,
						},
					},
				},
			});
		const prefix = [
			JSON.stringify({ type: "session_meta", payload: { id: "thread-3" } }),
			JSON.stringify({
				timestamp: "2026-09-23T04:00:01.000Z",
				type: "turn_context",
				payload: { turn_id: "turn-3", model: "gpt-6-sol" },
			}),
		];
		const multiTurnRollout = join(sessions, "rollout-thread-5.jsonl");
		writeFileSync(
			multiTurnRollout,
			`${[
				JSON.stringify({ type: "session_meta", payload: { id: "thread-5" } }),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:01.000Z",
					type: "turn_context",
					payload: { turn_id: "turn-5a", model: "gpt-6-sol" },
				}),
				codexLine(50, 10, 2),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:02.500Z",
					type: "turn_context",
					payload: { turn_id: "turn-5a", model: "gpt-6-sol" },
				}),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:03.000Z",
					type: "turn_context",
					payload: { turn_id: "turn-5b", model: "gpt-6-sol" },
				}),
				codexLine(30, 5, 4),
			].join("\n")}\n`,
		);
		expect(
			store.workflowScorecard.importUsageSource({
				vendor: "codex",
				nativeSessionId: "thread-5",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: codexHome,
				sourcePath: multiTurnRollout,
				final: true,
				allowBootstrap: true,
			}),
		).toMatchObject({
			ok: true,
			imported: 2,
			coverage: "complete",
		});
		expect(
			store.workflowScorecard
				.listUsageForRun("run-1")
				.filter((row) => row.native_session_id === "thread-5"),
		).toMatchObject([
			{ native_turn_id: "turn-5a", normalized_delta: 60 },
			{ native_turn_id: "turn-5b", normalized_delta: 35 },
		]);
		const cumulativeMultiTurnRollout = join(sessions, "rollout-thread-6.jsonl");
		writeFileSync(
			cumulativeMultiTurnRollout,
			`${[
				JSON.stringify({ type: "session_meta", payload: { id: "thread-6" } }),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:01.000Z",
					type: "turn_context",
					payload: { turn_id: "turn-6a", model: "gpt-6-sol" },
				}),
				codexLine(50, 10, 2),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:03.000Z",
					type: "turn_context",
					payload: { turn_id: "turn-6b", model: "gpt-6-sol" },
				}),
				codexLine(80, 15, 4),
			].join("\n")}\n`,
		);
		expect(
			store.workflowScorecard.importUsageSource({
				vendor: "codex",
				nativeSessionId: "thread-6",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: codexHome,
				sourcePath: cumulativeMultiTurnRollout,
				final: true,
				allowBootstrap: true,
			}),
		).toMatchObject({
			ok: true,
			imported: 2,
			coverage: "complete",
		});
		expect(
			store.workflowScorecard
				.listUsageForRun("run-1")
				.filter((row) => row.native_session_id === "thread-6"),
		).toMatchObject([
			{ native_turn_id: "turn-6a", normalized_delta: 60 },
			{ native_turn_id: "turn-6b", normalized_delta: 35 },
		]);
		writeFileSync(
			rollbackRollout,
			`${[...prefix, codexLine(50, 10, 2), codexLine(40, 10, 3)].join("\n")}\n`,
		);
		expect(
			store.workflowScorecard.importUsageSource({
				vendor: "codex",
				nativeSessionId: "thread-3",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: codexHome,
				sourcePath: rollbackRollout,
				final: true,
				allowBootstrap: true,
			}),
		).toEqual({ ok: false, reason: "usage_counter_regressed" });
		writeFileSync(
			rollbackRollout,
			`${[...prefix, codexLine(30, 5, 2)].join("\n")}\n`,
		);
		expect(
			store.workflowScorecard.importUsageSource({
				vendor: "codex",
				nativeSessionId: "thread-3",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: codexHome,
				sourcePath: rollbackRollout,
				final: true,
				allowBootstrap: true,
			}),
		).toMatchObject({ ok: true, imported: 1, coverage: "complete" });
		expect(
			store.workflowScorecard
				.listUsageForRun("run-1")
				.filter((row) => row.native_session_id === "thread-3"),
		).toMatchObject([{ normalized_delta: 35 }]);

		const unsupportedRollout = join(sessions, "rollout-thread-4.jsonl");
		writeFileSync(
			unsupportedRollout,
			`${[
				JSON.stringify({ type: "session_meta", payload: { id: "thread-4" } }),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:01.000Z",
					type: "turn_context",
					payload: { turn_id: "turn-4", model: "gpt-6-sol" },
				}),
				JSON.stringify({
					timestamp: "2026-09-23T04:00:02.000Z",
					type: "event_msg",
					payload: {
						type: "token_count",
						info: { total_token_usage: { input_tokens: 10 } },
					},
				}),
			].join("\n")}\n`,
		);
		expect(
			store.workflowScorecard.importUsageSource({
				vendor: "codex",
				nativeSessionId: "thread-4",
				executionId: "exec-1",
				activationId: "activation:exec-1:run-1:implement:1",
				providerHome: codexHome,
				sourcePath: unsupportedRollout,
				final: true,
				allowBootstrap: true,
			}),
		).toEqual({ ok: false, reason: "unsupported_counter" });

		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: "exec-1",
			endedAt: "2026-09-23T04:00:02.300Z",
		});
		expect(
			store.workflowScorecard.getActivation(
				"activation:exec-1:run-1:implement:1",
			),
		).toMatchObject({
			closed_at: "2026-09-23T04:00:02.300Z",
			close_kind: "done",
		});
		rawDb(store)
			.prepare(
				"DELETE FROM workflow_scorecard_activation WHERE activation_id = ?",
			)
			.run("activation:exec-1:run-1:implement:1");
		expect(store.admitGeneralizedWorkflowExecution(input)).toMatchObject({
			ok: true,
			idempotentReplay: true,
		});
		expect(
			store.workflowScorecard.getActivation(
				"activation:exec-1:run-1:implement:1",
			),
		).toMatchObject({
			closed_at: "2026-09-23T04:00:02.300Z",
			close_kind: "done",
		});
		store.close();
	});
});
