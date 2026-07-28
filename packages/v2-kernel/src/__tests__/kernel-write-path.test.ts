import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { consumerRegistryKey, FENCE } from "../fence.js";
import {
	CasViolation,
	FenceViolation,
	Kernel,
	NestedWriteViolation,
	TxBudgetExceeded,
	TxLifecycleViolation,
	type WriteTx,
} from "../kernel.js";
import { migrateDatabase } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

function countEvents(kernel: Kernel): number {
	return kernel.read(
		(tx) =>
			(
				tx.get<{ count: number }>("SELECT count(*) AS count FROM events") ?? {
					count: -1,
				}
			).count,
	);
}

function insertEvent(tx: WriteTx, uid: string): void {
	tx.run(
		`INSERT INTO events(event_uid, kind, cutover_epoch, created_at)
		 VALUES (@uid, 'test', 1, '2026-07-27T00:00:00.000Z')`,
		{ uid },
	);
}

describe("Kernel single-writer transaction discipline", () => {
	let temp: TempDatabase | undefined;
	const kernels: Kernel[] = [];

	afterEach(() => {
		for (const kernel of kernels.splice(0)) {
			kernel.close();
		}
		temp?.cleanup();
		temp = undefined;
	});

	function openKernel(
		options: Omit<Parameters<typeof Kernel.open>[0], "path"> = {},
	): Kernel {
		temp ??= makeTempDatabase();
		migrateDatabase({ path: temp.path });
		const kernel = Kernel.open({ path: temp.path, ...options });
		kernels.push(kernel);
		return kernel;
	}

	it("uses BEGIN IMMEDIATE and applies the configured busy timeout", () => {
		const statements: string[] = [];
		const kernel = openKernel({
			busyTimeoutMs: 321,
			verbose: (sql) => statements.push(sql),
		});

		kernel.write("insert event", (tx) => insertEvent(tx, "event-1"));

		expect(statements.some((sql) => sql === "BEGIN IMMEDIATE")).toBe(true);
		expect(statements.some((sql) => sql === "BEGIN")).toBe(false);
		expect(statements.some((sql) => sql === "BEGIN DEFERRED")).toBe(false);
		expect(
			kernel.read(
				(tx) =>
					tx.get<{ timeout: number }>("SELECT timeout FROM pragma_busy_timeout")
						?.timeout ?? -1,
			),
		).toBe(321);
	});

	it.each([
		"PRAGMA foreign_keys = OFF",
		"BEGIN",
		"ATTACH DATABASE ':memory:' AS side",
	])(
		"rejects connection-state SQL before prepare and preserves foreign keys: %s",
		(sql) => {
			const kernel = openKernel();

			expect(() => kernel.read((tx) => tx.get(sql))).toThrow(
				/read facade rejects connection-state SQL/,
			);
			expect(
				kernel.read(
					(tx) =>
						tx.get<{ foreign_keys: number }>(
							"SELECT foreign_keys FROM pragma_foreign_keys",
						)?.foreign_keys,
				),
			).toBe(1);
			expect(() =>
				kernel.write("reject orphan", (tx) => {
					tx.run(
						`INSERT INTO attempts(id, task_id, generation, desired_state)
						 VALUES ('orphan-attempt', 'missing-task', 1, 'planned')`,
					);
				}),
			).toThrow(/FOREIGN KEY constraint failed/);
		},
	);

	it("rejects connection-state SQL hidden behind comments", () => {
		const kernel = openKernel();
		expect(() =>
			kernel.read((tx) =>
				tx.get(
					"/* caller context */ -- still unsafe\n PRAGMA foreign_keys=OFF",
				),
			),
		).toThrow(/read facade rejects connection-state SQL/);
	});

	it("prevents the read facade from smuggling a write through RETURNING", () => {
		const kernel = openKernel();
		expect(() =>
			kernel.read((tx) =>
				tx.get(
					`INSERT INTO events(event_uid, kind, cutover_epoch, created_at)
					 VALUES ('read-smuggled-write', 'test', 1, 'now')
					 RETURNING event_uid`,
				),
			),
		).toThrow(/read-only SQL/);
		expect(countEvents(kernel)).toBe(0);
	});

	// FLY-1497 QA 漏检补测:只读面早先加过这道守卫,**写入面漏了**,两条都实测复现过。
	// 事务边界归 Kernel.write 的 BEGIN IMMEDIATE 独占,PRAGMA 的唯一落点是连接工厂(§0.5b);
	// 调用方从 tx 句柄里夺走任何一样,支柱③「异常/CAS 失败整事务回滚」就不成立了。
	it("does not let the write facade commit the transaction out from under the kernel", () => {
		const kernel = openKernel();
		expect(() =>
			kernel.write("commit escape", (tx) => {
				tx.run(
					`INSERT INTO events(event_uid, kind, cutover_epoch, created_at)
					 VALUES ('commit-escape', 'test', 1, 'now')`,
				);
				tx.run("COMMIT");
				throw new Error("boom");
			}),
		).toThrow(/write facade rejects connection-state SQL \(COMMIT\)/);
		// 关键断言不是"抛了错",而是"抛错之后库里没有残留" —— 早先的实现里回调确实抛错,
		// 但 COMMIT 已经落地,这一行会是 1。
		expect(countEvents(kernel)).toBe(0);
	});

	it("does not let the write facade disable CHECK constraints via PRAGMA", () => {
		const kernel = openKernel();
		expect(() =>
			kernel.write("pragma bypass", (tx) => {
				tx.run("PRAGMA ignore_check_constraints = ON");
				tx.run(
					`INSERT INTO tasks(id, project_id, kind, state, lineage_root_id, created_at)
					 VALUES ('bad-task', 'flywheel', 'build', 'not-a-state', 'bad-task', 'now')`,
				);
			}),
		).toThrow(/write facade rejects connection-state SQL \(PRAGMA\)/);
		expect(
			kernel.read(
				(tx) =>
					tx.get<{ count: number }>(
						"SELECT count(*) AS count FROM tasks WHERE id = 'bad-task'",
					)?.count,
			),
		).toBe(0);
	});

	// 与只读面 E2 那组对称:同一批连接状态 SQL,写入面必须一视同仁地拒。
	it.each([
		"COMMIT",
		"ROLLBACK",
		"BEGIN",
		"SAVEPOINT sp1",
		"RELEASE sp1",
		"PRAGMA foreign_keys = OFF",
		"ATTACH DATABASE ':memory:' AS side",
		"DETACH DATABASE side",
		"VACUUM",
		"END",
	])("rejects connection-state SQL on the write facade too: %s", (sql) => {
		const kernel = openKernel();
		expect(() =>
			kernel.write("connection-state probe", (tx) => {
				tx.run(sql);
			}),
		).toThrow(/write facade rejects connection-state SQL/);
		// 拒绝之后连接必须仍然干净 —— 外键没被关掉。
		expect(
			kernel.read(
				(tx) =>
					tx.get<{ foreign_keys: number }>(
						"SELECT foreign_keys FROM pragma_foreign_keys",
					)?.foreign_keys,
			),
		).toBe(1);
	});

	it("rejects connection-state SQL hidden behind comments on the write facade", () => {
		const kernel = openKernel();
		expect(() =>
			kernel.write("comment smuggling", (tx) => {
				tx.run(
					"/* caller context */ -- still unsafe\n PRAGMA foreign_keys=OFF",
				);
			}),
		).toThrow(/write facade rejects connection-state SQL/);
	});

	it("applies the guard to the write facade read helpers as well", () => {
		const kernel = openKernel();
		for (const call of [
			(tx: WriteTx) => tx.get("PRAGMA foreign_keys = OFF"),
			(tx: WriteTx) => tx.all("PRAGMA foreign_keys = OFF"),
			(tx: WriteTx) => tx.cas("PRAGMA foreign_keys = OFF", {}),
		]) {
			expect(() => kernel.write("write facade helper", call)).toThrow(
				/write facade rejects connection-state SQL/,
			);
		}
	});

	// 第二轮:守卫的词法分析必须跟 SQLite 的 tokenizer 对齐,任何分歧都是绕过。
	// 已实测过两类真绕过 —— 前导空语句(单个 `;` 就废掉整道守卫)与 EXPLAIN 外壳
	// (`EXPLAIN PRAGMA ignore_check_constraints=ON` 确实生效,非法枚举写进了 tasks)。
	it.each([
		["leading semicolon", "; COMMIT"],
		["semicolon without space", ";COMMIT"],
		["repeated semicolons", ";; COMMIT"],
		["whitespace then semicolon", "  \n\t ; COMMIT"],
		["comment then semicolon", "/* x */ ; COMMIT"],
		["semicolon then comment", "; -- y\n COMMIT"],
		["bom then semicolon", "﻿; COMMIT"],
		["explain wrapper", "EXPLAIN COMMIT"],
	])(
		"keeps the transaction intact when COMMIT is disguised: %s",
		(_label, sql) => {
			const kernel = openKernel();
			// 断言守卫消息而不是裸 .toThrow():回调自己也会抛 boom,
			// 只断言"抛了"无法区分"守卫命中"和"绕过成功后回调照常抛错"。
			expect(() =>
				kernel.write("disguised commit", (tx) => {
					insertEvent(tx, "disguised-commit");
					tx.run(sql);
					throw new Error("boom");
				}),
			).toThrow(/write facade rejects connection-state SQL/);
			// 判据是"抛错之后零残留",不是"抛了错" —— 绕过成功时回调同样会抛,
			// 但 COMMIT 已经落地,这里会是 1。
			expect(countEvents(kernel)).toBe(0);
		},
	);

	it.each([
		["leading semicolon", "; PRAGMA ignore_check_constraints = ON"],
		["semicolon without space", ";PRAGMA ignore_check_constraints = ON"],
		[
			"comment then semicolon",
			"/* x */ ; PRAGMA ignore_check_constraints = ON",
		],
		["explain wrapper", "EXPLAIN PRAGMA ignore_check_constraints = ON"],
	])(
		"keeps CHECK constraints enforced when PRAGMA is disguised: %s",
		(_label, sql) => {
			const kernel = openKernel();
			expect(() =>
				kernel.write("disguised pragma", (tx) => {
					tx.run(sql);
					tx.run(
						`INSERT INTO tasks(id, project_id, kind, state, lineage_root_id, created_at)
					 VALUES ('bad-disguised', 'flywheel', 'build', 'not-a-state', 'bad-disguised', 'now')`,
					);
				}),
			).toThrow();
			expect(
				kernel.read(
					(tx) =>
						tx.get<{ count: number }>(
							"SELECT count(*) AS count FROM tasks WHERE id = 'bad-disguised'",
						)?.count,
				),
			).toBe(0);
		},
	);

	// 负向:wrapper 消费逻辑必须承重。SQLite 在 token 之间忽略注释,所以注释插进
	// EXPLAIN/QUERY/PLAN 之间时它仍认完整 wrapper —— 守卫也必须看穿,否则内层受禁
	// 关键字逃检(实测过:这四种都曾把非法枚举写进 tasks)。
	it.each([
		[
			"comment between EXPLAIN and QUERY",
			"EXPLAIN /*x*/ QUERY PLAN PRAGMA ignore_check_constraints = ON",
		],
		[
			"comment between QUERY and PLAN",
			"EXPLAIN QUERY /*y*/ PLAN PRAGMA ignore_check_constraints = ON",
		],
		[
			"comments at both separators",
			"EXPLAIN /*x*/ QUERY /*y*/ PLAN PRAGMA ignore_check_constraints = ON",
		],
		[
			"line comments as separators",
			"EXPLAIN -- c\n QUERY -- d\n PLAN PRAGMA ignore_check_constraints = ON",
		],
	])(
		"sees through an EXPLAIN QUERY PLAN wrapper split by comments: %s",
		(_label, sql) => {
			const kernel = openKernel();
			expect(() =>
				kernel.write("wrapper probe", (tx) => {
					tx.run(sql);
				}),
			).toThrow(/write facade rejects connection-state SQL \(PRAGMA\)/);
		},
	);

	// 阳性对照:剥 EXPLAIN 是为了看穿外壳,不是禁掉 EXPLAIN —— 合法只读用法不能被误伤,
	// 包括同样被注释分隔的那种写法。
	it("still allows EXPLAIN QUERY PLAN on the read facade", () => {
		const kernel = openKernel();
		const plan = kernel.read((tx) =>
			tx.all<{ detail: string }>(
				"EXPLAIN QUERY PLAN SELECT seq FROM mailbox WHERE to_agent = 'a' AND state = 'pending'",
			),
		);
		expect(plan.length).toBeGreaterThan(0);
		const withComments = kernel.read((tx) =>
			tx.all<{ detail: string }>(
				"EXPLAIN /*x*/ QUERY /*y*/ PLAN SELECT seq FROM mailbox WHERE to_agent = 'a'",
			),
		);
		expect(withComments.length).toBeGreaterThan(0);
	});

	it("rejects AsyncFunction callbacks before beginning a transaction", () => {
		const statements: string[] = [];
		const kernel = openKernel({ verbose: (sql) => statements.push(sql) });
		const asyncCallback = async (tx: WriteTx): Promise<void> => {
			insertEvent(tx, "event-async");
		};

		expect(() =>
			kernel.write(
				"async callback",
				asyncCallback as unknown as (tx: WriteTx) => void,
			),
		).toThrow(TxLifecycleViolation);
		expect(countEvents(kernel)).toBe(0);
		expect(statements.some((sql) => sql === "BEGIN IMMEDIATE")).toBe(false);
	});

	it("rolls back pre-await writes and invalidates a tx escaped through a thenable", async () => {
		const kernel = openKernel();
		let continuation: Promise<unknown> | undefined;

		expect(() =>
			kernel.write("thenable callback", ((tx: WriteTx) => {
				insertEvent(tx, "event-before-await");
				continuation = Promise.resolve().then(() =>
					insertEvent(tx, "event-after-await"),
				);
				return continuation;
			}) as unknown as (tx: WriteTx) => void),
		).toThrow(TxLifecycleViolation);

		await expect(continuation).rejects.toBeInstanceOf(TxLifecycleViolation);
		expect(countEvents(kernel)).toBe(0);
	});

	it("invalidates every escaped tx operation and rolls back on user error", () => {
		const kernel = openKernel();
		let escaped: WriteTx | undefined;
		expect(() =>
			kernel.write("user failure", (tx) => {
				escaped = tx;
				insertEvent(tx, "event-before-throw");
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(countEvents(kernel)).toBe(0);

		const tx = escaped as WriteTx;
		expect(() => tx.run("SELECT 1")).toThrow(TxLifecycleViolation);
		expect(() => tx.get("SELECT 1")).toThrow(TxLifecycleViolation);
		expect(() => tx.all("SELECT 1")).toThrow(TxLifecycleViolation);
		expect(() => tx.cas("UPDATE events SET kind='x'", {})).toThrow(
			TxLifecycleViolation,
		);
		expect(() =>
			tx.requireIdentity(consumerRegistryKey("runner-1"), {
				kind: "runner",
				agentId: "runner-1",
				instanceId: "instance-1",
				generation: 1,
				activationId: "activation-1",
			}),
		).toThrow(TxLifecycleViolation);
	});

	it("recovers its nesting guard after callback and BEGIN failures", () => {
		const kernel = openKernel({ busyTimeoutMs: 50 });
		expect(() =>
			kernel.write("first failure", () => {
				throw new Error("first");
			}),
		).toThrow("first");
		kernel.write("after callback failure", (tx) =>
			insertEvent(tx, "event-after-callback-failure"),
		);

		const locker = openKernelDb({ path: temp?.path ?? "", busyTimeoutMs: 50 });
		try {
			locker.exec("BEGIN IMMEDIATE");
			expect(() =>
				kernel.write("busy failure", (tx) =>
					insertEvent(tx, "event-during-lock"),
				),
			).toThrow(/locked|busy/i);
			locker.exec("ROLLBACK");
			kernel.write("after begin failure", (tx) =>
				insertEvent(tx, "event-after-busy"),
			);
		} finally {
			if (locker.inTransaction) {
				locker.exec("ROLLBACK");
			}
			locker.close();
		}
		expect(countEvents(kernel)).toBe(2);
	});

	it("rejects nested writes, including reentry from the BEGIN verbose callback", () => {
		const holder: { kernel?: Kernel } = {};
		let verboseReentry: unknown;
		const statements: string[] = [];
		const kernel = openKernel({
			verbose: (sql) => {
				statements.push(sql);
				if (sql === "BEGIN IMMEDIATE" && holder.kernel && !verboseReentry) {
					try {
						holder.kernel.write("verbose reentry", () => undefined);
					} catch (error) {
						verboseReentry = error;
					}
				}
			},
		});
		holder.kernel = kernel;

		kernel.write("outer", (tx) => {
			insertEvent(tx, "event-outer");
			expect(() => kernel?.write("nested", () => undefined)).toThrow(
				NestedWriteViolation,
			);
		});

		expect(verboseReentry).toBeInstanceOf(NestedWriteViolation);
		expect(statements.some((sql) => sql.startsWith("SAVEPOINT"))).toBe(false);
		expect(countEvents(kernel)).toBe(1);
	});

	it("rolls back all prior writes when CAS affects the wrong row count", () => {
		const kernel = openKernel();
		expect(() =>
			kernel.write("failed cas", (tx) => {
				insertEvent(tx, "event-before-cas");
				tx.cas(
					"UPDATE mailbox SET state='applied' WHERE message_uid=@uid AND state='pending'",
					{ uid: "missing" },
				);
			}),
		).toThrow(CasViolation);
		expect(countEvents(kernel)).toBe(0);
	});

	it("fail-closes malformed, stale, and mismatched identities without partial effects", () => {
		const kernel = openKernel();
		const registryKey = consumerRegistryKey("runner-1");
		const expected = {
			kind: "runner" as const,
			agentId: "runner-1",
			instanceId: "instance-1",
			generation: 2,
			activationId: "activation-2",
		};
		kernel.write("seed mailbox", (tx) => {
			tx.run(
				`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
				 VALUES ('runner-1','runner',0,NULL,'offline')`,
			);
			tx.run(
				`INSERT INTO mailbox
				 (message_uid, source_kind, source_id, payload, payload_digest, to_agent,
				  kind, retention_class, cutover_epoch, created_at)
				 VALUES ('message-1', 'test', 'source-1', '{}', 'digest', 'runner-1',
				  'instruction', 'business', 1, '2026-07-27T00:00:00.000Z')`,
			);
		});

		const rejectedValues: Array<string | undefined> = [
			undefined,
			"{not-json",
			JSON.stringify({ ...expected, kind: "lead", leadId: "lead-1" }),
			JSON.stringify({ ...expected, generation: 1 }),
			JSON.stringify({ ...expected, activationId: "activation-old" }),
		];
		for (const [index, value] of rejectedValues.entries()) {
			if (value !== undefined) {
				kernel.write(`seed bad identity ${index}`, (tx) => {
					tx.run(
						`INSERT INTO meta(key, value, updated_at) VALUES (@key, @value, 'now')
						 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
						{ key: registryKey, value },
					);
				});
			}
			expect(() =>
				kernel.write(`reject identity ${index}`, (tx) => {
					insertEvent(tx, `identity-rejected-${index}`);
					tx.requireIdentity(registryKey, expected);
					tx.cas(FENCE.mailboxCasPendingApplied, {
						uid: "message-1",
						now: "2026-07-27T00:01:00.000Z",
					});
				}),
			).toThrow(FenceViolation);
			expect(countEvents(kernel)).toBe(0);
			expect(
				kernel.read(
					(tx) =>
						tx.get<{ state: string }>(
							"SELECT state FROM mailbox WHERE message_uid='message-1'",
						)?.state,
				),
			).toBe("pending");
		}

		kernel.write("seed current identity", (tx) => {
			tx.run(
				`INSERT INTO meta(key, value, updated_at) VALUES (@key, @value, 'now')
				 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
				{ key: registryKey, value: JSON.stringify(expected) },
			);
		});
		kernel.write("current identity", (tx) => {
			tx.requireIdentity(registryKey, expected);
			insertEvent(tx, "identity-accepted");
			tx.cas(FENCE.mailboxCasPendingApplied, {
				uid: "message-1",
				now: "2026-07-27T00:01:00.000Z",
			});
		});
		expect(countEvents(kernel)).toBe(1);
		expect(
			kernel.read(
				(tx) =>
					tx.get<{ state: string }>(
						"SELECT state FROM mailbox WHERE message_uid='message-1'",
					)?.state,
			),
		).toBe("applied");
	});

	it("rolls back transactions that exceed the synchronous budget", () => {
		const kernel = openKernel({ txBudgetMs: 1 });
		expect(() =>
			kernel.write("too slow", (tx) => {
				insertEvent(tx, "event-too-slow");
				const stopAt = performance.now() + 5;
				while (performance.now() < stopAt) {
					// Deliberately consume the configured synchronous transaction budget.
				}
			}),
		).toThrow(TxBudgetExceeded);
		expect(countEvents(kernel)).toBe(0);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid transaction budget %s",
		(txBudgetMs) => {
			temp = makeTempDatabase();
			migrateDatabase({ path: temp.path });
			expect(() => Kernel.open({ path: temp?.path ?? "", txBudgetMs })).toThrow(
				/txBudgetMs/,
			);
		},
	);
});
