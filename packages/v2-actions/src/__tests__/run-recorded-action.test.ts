import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
	type ActionSnapshot,
	Kernel,
	migrateDatabase,
	readAction,
	recordActionIntent,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { runRecordedAction } from "../index.js";

describe("runRecordedAction", () => {
	let dir: string | undefined;
	let kernel: Kernel | undefined;

	afterEach(() => {
		kernel?.close();
		kernel = undefined;
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	// QA (FLY-1500) — 下面新增用例共用正式迁移链的开库步骤。
	function bootKernel(): { kernel: Kernel; path: string } {
		dir = mkdtempSync(join(tmpdir(), "flywheel-v2-actions-"));
		const path = join(dir, "v2.db");
		migrateDatabase({ path });
		const opened = Kernel.open({ path });
		kernel = opened;
		opened.write("seed current lead", (tx) => {
			tx.run(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			);
		});
		return { kernel: opened, path };
	}

	const LEAD_ACTOR = {
		kind: "lead" as const,
		agentId: "lead-a",
		instanceId: "session-a",
		generation: 1,
	};

	it("commits intent before the effect and records its successful result", async () => {
		dir = mkdtempSync(join(tmpdir(), "flywheel-v2-actions-"));
		const path = join(dir, "v2.db");
		migrateDatabase({ path });
		kernel = Kernel.open({ path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			);
		});
		let observedDuringEffect: ActionSnapshot | null = null;

		const result = await runRecordedAction({
			kernel,
			action: {
				id: "action-1",
				actor: {
					kind: "lead",
					agentId: "lead-a",
					instanceId: "session-a",
					generation: 1,
				},
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "daily-report",
				invocationUid: "transcript:tool-call-1",
				cutoverEpoch: 7,
			},
			perform: async () => {
				observedDuringEffect = kernel?.read((tx) =>
					readAction(tx, "action-1"),
				) as ActionSnapshot | null;
				return { externalId: "external-1" };
			},
		});

		expect(observedDuringEffect).toMatchObject({
			id: "action-1",
			state: "intended",
		});
		expect(result).toMatchObject({
			disposition: "performed",
			action: {
				id: "action-1",
				state: "succeeded",
				result: { externalId: "external-1" },
			},
		});
	});

	it("records a thrown effect as failed before rethrowing the same error", async () => {
		dir = mkdtempSync(join(tmpdir(), "flywheel-v2-actions-"));
		const path = join(dir, "v2.db");
		migrateDatabase({ path });
		kernel = Kernel.open({ path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			);
		});
		const failure = new Error("provider unavailable");

		await expect(
			runRecordedAction({
				kernel,
				action: {
					id: "action-failed",
					actor: {
						kind: "lead",
						agentId: "lead-a",
						instanceId: "session-a",
						generation: 1,
					},
					kind: "custom_tool_call",
					payload: { body: "hello" },
					logicalEffectId: "failed-report",
					invocationUid: "transcript:tool-call-failed",
					cutoverEpoch: 7,
				},
				perform: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(kernel.read((tx) => readAction(tx, "action-failed"))).toMatchObject({
			state: "failed",
			result: {
				error: { name: "Error", message: "provider unavailable" },
			},
		});
	});

	it.each([
		["Date", new Date("2026-07-28T08:00:00.000Z")],
		["Map", new Map([["externalId", "external-1"]])],
	])(
		"terminalizes a successful effect whose %s result cannot be serialized",
		async (valueKind, sdkResult) => {
			const { kernel: opened } = bootKernel();
			let performCount = 0;

			const result = await runRecordedAction({
				kernel: opened,
				action: {
					id: `action-sdk-result-${valueKind}`,
					actor: LEAD_ACTOR,
					kind: "custom_tool_call",
					payload: { body: "hello" },
					logicalEffectId: `sdk-result-${valueKind}`,
					invocationUid: `transcript:sdk-result-${valueKind}`,
					cutoverEpoch: 7,
				},
				perform: () => {
					performCount += 1;
					return sdkResult as never;
				},
			});

			expect(result).toMatchObject({
				disposition: "performed",
				action: {
					state: "succeeded",
					result: {
						serialization_error: {
							name: "ActionSerializationError",
							message: expect.stringMatching(/serialization.*JSON/i),
						},
						value_kind: valueKind,
					},
				},
			});
			expect(performCount).toBe(1);
			expect(
				opened.read((tx) => readAction(tx, `action-sdk-result-${valueKind}`)),
			).toEqual(result.action);
		},
	);

	it("rolls back generic prepare work when intent admission fails", async () => {
		dir = mkdtempSync(join(tmpdir(), "flywheel-v2-actions-"));
		const path = join(dir, "v2.db");
		migrateDatabase({ path });
		kernel = Kernel.open({ path });
		kernel.write("seed authority and capability", (tx) => {
			tx.run(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			);
			tx.run(
				`INSERT INTO capabilities
				 (id, token_hash, issuer, audience, action, issued_at)
				 VALUES ('cap-1', 'hash-1', 'founder', 'lead-a', 'tool', '2026-07-28T08:00:00Z')`,
			);
		});
		const rejected = new Error("authorization subject changed");
		let performCount = 0;

		await expect(
			runRecordedAction({
				kernel,
				action: {
					id: "action-prepared",
					actor: {
						kind: "lead",
						agentId: "lead-a",
						instanceId: "session-a",
						generation: 1,
					},
					kind: "custom_tool_call",
					payload: { body: "hello" },
					logicalEffectId: "prepared-report",
					invocationUid: "transcript:tool-call-prepared",
					cutoverEpoch: 7,
				},
				prepare: (tx) => {
					tx.run(
						`UPDATE capabilities SET consumed_at='2026-07-28T08:00:01Z'
						 WHERE id='cap-1'`,
					);
					throw rejected;
				},
				perform: () => {
					performCount += 1;
					return { externalId: "should-not-run" };
				},
			}),
		).rejects.toBe(rejected);
		expect(performCount).toBe(0);
		expect(kernel.read((tx) => readAction(tx, "action-prepared"))).toBeNull();
		expect(
			kernel.read((tx) =>
				tx.get<{ consumed_at: string | null }>(
					"SELECT consumed_at FROM capabilities WHERE id='cap-1'",
				),
			),
		).toEqual({ consumed_at: null });
	});

	it("rolls back a successful capability consume when the intent insert fails", async () => {
		const { kernel: opened } = bootKernel();
		opened.write("seed capability and colliding action id", (tx) => {
			tx.run(
				`INSERT INTO capabilities
				 (id, token_hash, issuer, audience, action, issued_at)
				 VALUES ('cap-rollback', 'hash-rollback', 'founder', 'lead-a', 'tool',
				         '2026-07-28T08:00:00Z')`,
			);
			recordActionIntent(tx, {
				id: "action-colliding-id",
				actor: LEAD_ACTOR,
				kind: "custom_tool_call",
				payload: { body: "existing" },
				logicalEffectId: "existing-report",
				invocationUid: "transcript:existing",
				cutoverEpoch: 7,
			});
		});
		let performCount = 0;

		await expect(
			runRecordedAction({
				kernel: opened,
				action: {
					id: "action-colliding-id",
					actor: LEAD_ACTOR,
					kind: "custom_tool_call",
					payload: { body: "new" },
					logicalEffectId: "new-report",
					invocationUid: "transcript:new",
					cutoverEpoch: 7,
				},
				prepare: (tx) => {
					tx.cas(
						`UPDATE capabilities SET consumed_at=:now
						 WHERE id=:capabilityId AND consumed_at IS NULL`,
						{
							capabilityId: "cap-rollback",
							now: "2026-07-28T08:00:01Z",
						},
						"consume capability",
					);
				},
				perform: () => {
					performCount += 1;
					return { externalId: "must-not-run" };
				},
			}),
		).rejects.toThrow();
		expect(performCount).toBe(0);
		expect(
			opened.read((tx) =>
				tx.get<{ consumed_at: string | null }>(
					"SELECT consumed_at FROM capabilities WHERE id='cap-rollback'",
				),
			),
		).toEqual({ consumed_at: null });
		expect(
			opened.read((tx) => readAction(tx, "action-colliding-id")),
		).toMatchObject({
			payload: { body: "existing" },
			state: "intended",
		});
	});

	it("short-circuits prepare and perform when an invocation replays", async () => {
		dir = mkdtempSync(join(tmpdir(), "flywheel-v2-actions-"));
		const path = join(dir, "v2.db");
		migrateDatabase({ path });
		kernel = Kernel.open({ path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			);
		});
		let prepareCount = 0;
		let performCount = 0;
		const base = {
			kernel,
			action: {
				id: "action-1",
				actor: {
					kind: "lead" as const,
					agentId: "lead-a",
					instanceId: "session-a",
					generation: 1,
				},
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "daily-report",
				invocationUid: "transcript:tool-call-1",
				cutoverEpoch: 7,
			},
			prepare: () => {
				prepareCount += 1;
			},
			perform: () => {
				performCount += 1;
				return { externalId: "external-1" };
			},
		};
		await runRecordedAction(base);

		const replayed = await runRecordedAction({
			...base,
			action: { ...base.action, id: "action-2" },
		});

		expect(replayed).toMatchObject({
			disposition: "replayed",
			action: {
				id: "action-1",
				state: "succeeded",
				result: { externalId: "external-1" },
			},
		});
		expect({ prepareCount, performCount }).toEqual({
			prepareCount: 1,
			performCount: 1,
		});
	});

	it("performs an evidenced successor once and replays only the identical request", async () => {
		dir = mkdtempSync(join(tmpdir(), "flywheel-v2-actions-"));
		const path = join(dir, "v2.db");
		migrateDatabase({ path });
		kernel = Kernel.open({ path });
		kernel.write("seed current lead", (tx) => {
			tx.run(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			);
		});
		const actor = {
			kind: "lead" as const,
			agentId: "lead-a",
			instanceId: "session-a",
			generation: 1,
		};
		const rootError = new Error("provider unavailable");
		let performCount = 0;
		await expect(
			runRecordedAction({
				kernel,
				action: {
					id: "action-root",
					actor,
					kind: "custom_tool_call",
					payload: { body: "hello" },
					logicalEffectId: "daily-report",
					invocationUid: "transcript:tool-call-1",
					cutoverEpoch: 7,
				},
				perform: () => {
					performCount += 1;
					throw rootError;
				},
			}),
		).rejects.toBe(rootError);
		const successorAction = {
			id: "action-successor",
			actor,
			kind: "custom_tool_call",
			payload: { body: "hello" },
			logicalEffectId: "daily-report",
			invocationUid: "transcript:tool-call-2",
			supersedesActionId: "action-root",
			retryBasis: {
				evidenceRef: "gh://runs/123",
				reason: "provider confirmed no request was accepted",
			},
			cutoverEpoch: 7,
		};
		const perform = () => {
			performCount += 1;
			return { externalId: "external-2" };
		};

		const successor = await runRecordedAction({
			kernel,
			action: successorAction,
			perform,
		});
		const replayed = await runRecordedAction({
			kernel,
			action: { ...successorAction, id: "action-successor-replayed" },
			perform,
		});
		await expect(
			runRecordedAction({
				kernel,
				action: {
					...successorAction,
					id: "action-successor-conflict",
					retryBasis: {
						...successorAction.retryBasis,
						reason: "different retry evidence",
					},
				},
				perform,
			}),
		).rejects.toThrow(/effect key collision/i);

		expect(successor).toMatchObject({
			disposition: "performed",
			action: {
				id: "action-successor",
				state: "succeeded",
				supersedesActionId: "action-root",
			},
		});
		expect(replayed).toMatchObject({
			disposition: "replayed",
			action: {
				id: "action-successor",
				state: "succeeded",
				supersedesActionId: "action-root",
			},
		});
		expect(performCount).toBe(2);
	});

	// QA (FLY-1500) — mapping §7.5 的「模拟 effect 后进程中断则行保持 intended」与
	// §5 崩溃语义 3 的正面证明。这里先提交 intent，再真的调用一次 fake effect，并刻意丢弃
	// effect 返回值来模拟进程在 outcome 事务之前消失。后续同一 invocation 重入必须只读回
	// intended，不能重放外部效果，也不能谎报成功。
	it("keeps an effect-after crash intended and never re-performs the effect", async () => {
		const { kernel: opened } = bootKernel();
		opened.write("intent transaction only", (tx) =>
			recordActionIntent(tx, {
				id: "action-killed",
				actor: LEAD_ACTOR,
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "killed-report",
				invocationUid: "transcript:tool-call-killed",
				cutoverEpoch: 7,
			}),
		);
		let externalEffectCount = 0;
		const performExternalEffect = () => {
			externalEffectCount += 1;
			return { externalId: `external-${externalEffectCount}` };
		};
		expect(performExternalEffect()).toEqual({ externalId: "external-1" });
		expect(opened.read((tx) => readAction(tx, "action-killed"))).toMatchObject({
			state: "intended",
			result: undefined,
			completedAt: undefined,
		});

		const replayed = await runRecordedAction({
			kernel: opened,
			action: {
				id: "action-killed-retry",
				actor: LEAD_ACTOR,
				kind: "custom_tool_call",
				payload: { body: "hello" },
				logicalEffectId: "killed-report",
				invocationUid: "transcript:tool-call-killed",
				cutoverEpoch: 7,
			},
			perform: performExternalEffect,
		});

		expect(replayed).toEqual({
			disposition: "replayed",
			action: expect.objectContaining({
				id: "action-killed",
				state: "intended",
				result: undefined,
			}),
		});
		expect(externalEffectCount).toBe(1);
		expect(opened.read((tx) => readAction(tx, "action-killed"))).toMatchObject({
			state: "intended",
		});
	});

	// QA (FLY-1500) — mapping §5「replayed + failed 明确表示上次观察到失败，不能冒充成功继续下游」。
	// 既有用例只覆盖 succeeded 行的重放；失败行的重放才是调用方最容易误读成「已办妥」的一种。
	it("replays a failed action without re-running the effect or reporting success", async () => {
		const { kernel: opened } = bootKernel();
		const failure = new Error("provider unavailable");
		let performCount = 0;
		const action = {
			actor: LEAD_ACTOR,
			kind: "custom_tool_call",
			payload: { body: "hello" },
			logicalEffectId: "failed-replay-report",
			invocationUid: "transcript:tool-call-failed-replay",
			cutoverEpoch: 7,
		};
		await expect(
			runRecordedAction({
				kernel: opened,
				action: { ...action, id: "action-failed-root" },
				perform: () => {
					performCount += 1;
					throw failure;
				},
			}),
		).rejects.toBe(failure);

		const replayed = await runRecordedAction({
			kernel: opened,
			action: { ...action, id: "action-failed-replay" },
			perform: () => {
				performCount += 1;
				return { externalId: "must-not-happen" };
			},
		});

		expect(replayed).toMatchObject({
			disposition: "replayed",
			action: {
				id: "action-failed-root",
				state: "failed",
				result: { error: { message: "provider unavailable" } },
			},
		});
		expect(performCount).toBe(1);
	});

	// QA (FLY-1500) — mapping §7.7 的成功侧。既有用例只证明了 prepare 抛错时授权消费会回滚；
	// 这里补的是 FLY-1498 merge 工具真正要依赖的那一半：一次性 capability 的消费与 intent 落在
	// 同一事务，且随行的 gate/head 授权引用写进去之后**连数据库自己都改不动**。
	it("consumes a one-shot capability inside the intent transaction and freezes its authorization", async () => {
		const { kernel: opened, path } = bootKernel();
		opened.write("seed capability", (tx) => {
			tx.run(
				`INSERT INTO capabilities
				 (id, token_hash, issuer, audience, action, issued_at)
				 VALUES ('cap-merge', 'hash-1', 'founder', 'lead-a', 'github_merge',
				  '2026-07-28T08:00:00Z')`,
			);
		});

		const result = await runRecordedAction({
			kernel: opened,
			action: {
				id: "action-merge",
				actor: LEAD_ACTOR,
				kind: "github_merge",
				payload: { pr: 720 },
				authorization: { gate_id: "gate-1", target_head: "abc123" },
				logicalEffectId: "merge-pr-720",
				invocationUid: "transcript:tool-call-merge",
				cutoverEpoch: 7,
			},
			prepare: (tx) => {
				tx.cas(
					`UPDATE capabilities SET consumed_at='2026-07-28T08:00:01Z'
					  WHERE id='cap-merge' AND consumed_at IS NULL AND revoked_at IS NULL`,
					{},
				);
			},
			perform: () => ({ mergeCommit: "deadbeef" }),
		});

		expect(result).toMatchObject({
			disposition: "performed",
			action: {
				state: "succeeded",
				authorization: { gate_id: "gate-1", target_head: "abc123" },
			},
		});
		expect(
			opened.read((tx) =>
				tx.get<{ consumed_at: string | null }>(
					"SELECT consumed_at FROM capabilities WHERE id='cap-merge'",
				),
			),
		).toEqual({ consumed_at: "2026-07-28T08:00:01Z" });

		// 已结算和未结算两种形态都要证明篡改被拒。不对具体是哪一条 trigger 抢先报错做断言：
		// SQLite 同事件多 trigger 的触发顺序未定义，钉死报错文案会让这条守卫变脆。
		opened.write("second merge intent", (tx) =>
			recordActionIntent(tx, {
				id: "action-merge-pending",
				actor: LEAD_ACTOR,
				kind: "github_merge",
				payload: { pr: 721 },
				authorization: { gate_id: "gate-2", target_head: "def456" },
				logicalEffectId: "merge-pr-721",
				invocationUid: "transcript:tool-call-merge-2",
				cutoverEpoch: 7,
			}),
		);
		opened.close();
		kernel = undefined;
		const raw = new Database(path);
		try {
			for (const id of ["action-merge-pending", "action-merge"]) {
				expect(() =>
					raw
						.prepare(
							`UPDATE actions SET authorization='{"gate_id":"forged"}'
							  WHERE id=@id`,
						)
						.run({ id }),
				).toThrow(/action (intent fields are immutable|outcome transition)/i);
			}
			expect(
				raw
					.prepare(
						"SELECT authorization FROM actions WHERE id IN ('action-merge','action-merge-pending') ORDER BY id",
					)
					.pluck()
					.all(),
			).toEqual([
				'{"gate_id":"gate-1","target_head":"abc123"}',
				'{"gate_id":"gate-2","target_head":"def456"}',
			]);
		} finally {
			raw.close();
		}
	});
});
