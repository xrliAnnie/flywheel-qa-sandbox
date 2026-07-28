import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

// QA (FLY-1497) — concurrency.test.ts 用**同一进程内的两个连接**验证 pa_one_running /
// activations 的 partial unique。那已经能证明约束存在,但同进程两连接共享同一个 SQLite
// 库级互斥与同一份内存态;真正的部署形态是 Bridge / runner / dispatcher 各自独立的
// **操作系统进程**。本文件把同样的不变量放到真·跨进程下再验一遍 —— 独立页缓存、
// 独立 WAL 读者、独立连接生命周期。
//
// 验收对应:设计 §1.2d「pa_one_running 实测拒并发」/ §1.6 activations 双 partial unique。
//
// child 脚本落在系统临时目录,该路径向上**没有** node_modules,所以裸
// `require('better-sqlite3')` 在 plain node 下会 MODULE_NOT_FOUND(已实测)。
// 这里把父进程解析好的绝对路径显式传进去,不依赖测试运行器碰巧提供的解析环境。

// 必须**小于** Vitest 的 framework testTimeout(本包 vitest.config.ts 未覆盖 → 默认 5s)。
// 否则 child 卡住时框架先在 5s 判超时,这里的 SIGKILL 永远轮不到,僵尸 child 会活过本用例
// 去干扰后续用例。取 2.5s:留足正常路径余量(实测单次 child 往返 ~100-400ms),又稳稳早于 5s。
const CHILD_TIMEOUT_MS = 2_500;

// child 在结果**flush 之后**才 disconnect,让父进程既拿到结果、又能观察到干净的 exit 0。
// (不用 process.exit():那会在 send 落地前就砍掉进程。)
const CHILD_SOURCE = `
process.on('message', (msg) => {
  let db;
  let payload;
  try {
    const Database = require(msg.driverPath);
    db = new Database(msg.path);
    db.pragma('busy_timeout = 2000');
    db.pragma('foreign_keys = ON');
    const changes = db.prepare(msg.sql).run().changes;
    payload = { done: true, ok: true, changes };
  } catch (error) {
    payload = { done: true, ok: false, code: error.code, message: error.message };
  } finally {
    if (db) db.close();
  }
  process.send(payload, () => { process.disconnect(); });
});
process.send({ ready: true });
`;

// 故意永不回话的 child:用来在仓内钉死「helper 自己会及时收尸」这条,
// 而不是靠 Vitest 的 framework timeout 兜底(那样 child 会活下来污染后续用例)。
const HUNG_CHILD_SOURCE = `
process.on('message', () => { setInterval(() => {}, 1000); });
process.send({ ready: true, pid: process.pid });
`;

// 发完 ready 就断开 IPC 但**保持存活**:parent 随后的 send 会失败(ERR_IPC_CHANNEL_CLOSED),
// 走 'error' 路径。这是回归测试 —— 早先版本会在 'error' 里直接结算并清掉收尸 timer,
// 结果 Promise 已 reject 而 child 还活着,漏给后续用例。
// 断开 IPC 但保持存活的 child。
// 诚实边界:我试过让 parent 的回发确定性地撞上 ERR_IPC_CHANNEL_CLOSED(disconnect 放在
// send 的 flush 回调里、以及与 send 同 tick 两种写法都试了),但 parent 收到 ready 后的
// 回发**总是先于** disconnect 传播到位,于是实际走的是超时收尸路径而不是 'error' 路径。
// 所以这条测试保证的是「IPC 断了还赖着不死的 child 最终仍被收掉、Promise 仍 reject」,
// **不是**对 'error' 分支的覆盖 —— 那条分支靠构造保证(error 只记账+开杀,不结算),
// 没有确定性回归测试,已在 qa-report §5 如实记账。
const DISCONNECTED_CHILD_SOURCE = `
process.send({ ready: true, pid: process.pid });
process.disconnect();
setInterval(() => {}, 1000);
`;

interface ChildResult {
	ok: boolean;
	changes?: number;
	code?: string;
	message?: string;
}

interface ChildMessage extends Partial<ChildResult> {
	ready?: boolean;
	done?: boolean;
	pid?: number;
}

// 让测试能观察到 child 的 pid,从而断言「结算之后它确实没了」——
// 光看错误消息和耗时证明不了收尸真的发生过。
interface ChildObservation {
	pid?: number;
}

const driverPath = createRequire(import.meta.url).resolve("better-sqlite3");

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function runInChildProcess(
	childPath: string,
	dbPath: string,
	sql: string,
	observed?: ChildObservation,
): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const child = fork(childPath, [], { stdio: "ignore" });
		let result: ChildResult | undefined;
		let failure: Error | undefined;
		let timedOut = false;
		let settled = false;

		// **唯一**结算点。只从 'close' 或最后的 backstop 调用 —— 这样 Promise 结算时
		// child 已经确实退出了。绝不从 'error' / 超时分支直接结算:那会在 child 还活着
		// 的时候就 settle,并把收尸 timer 一起清掉,把进程漏给后续用例。
		const settle = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			clearTimeout(backstop);
			if (failure) {
				reject(failure);
			} else if (timedOut) {
				reject(new Error(`child did not settle within ${CHILD_TIMEOUT_MS}ms`));
			} else if (result) {
				resolve(result);
			} else {
				reject(new Error("child exited before reporting a result"));
			}
		};

		// 记下失败原因并立刻开杀,但**不**在这里结算 —— 等 'close'。
		const failAndReap = (error: Error): void => {
			failure ??= error;
			child.kill("SIGKILL");
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, CHILD_TIMEOUT_MS);

		// SIGKILL 不可捕获,'close' 正常都会到。但若连 fork 都没成功、'close' 永不到,
		// 这条 backstop 保证 Promise 不会悬死(代价是那种极端情况下无法断言 child 已退出)。
		const backstop = setTimeout(() => {
			failure ??= new Error("child never emitted close after being killed");
			settle();
		}, CHILD_TIMEOUT_MS + 1_000);

		child.on("message", (message: ChildMessage) => {
			if (message.ready) {
				if (observed && typeof message.pid === "number") {
					observed.pid = message.pid;
				}
				// 用 send 回调接住 IPC 失败(如通道已关闭):同步 throw 会逃出这个 handler。
				child.send({ path: dbPath, sql, driverPath }, (error) => {
					if (error) {
						failAndReap(error);
					}
				});
				return;
			}
			if (message.done) {
				result = message as ChildResult;
			}
		});
		// 'error' 不只是 fork 失败 —— IPC send 失败也会走这里,而那时 child 可能还活着。
		child.on("error", failAndReap);
		child.on("close", (code) => {
			if (!failure && !timedOut && code !== 0) {
				failure = new Error(`child exited with code ${String(code)}`);
			}
			settle();
		});
	});
}

function seed(db: ReturnType<typeof openKernelDb>): void {
	db.exec(`
		INSERT INTO tasks (id, project_id, kind, state, lineage_root_id, created_at)
		  VALUES ('task-1', 'flywheel', 'build', 'running', 'task-1', '2026-07-27T00:00:00.000Z');
		INSERT INTO attempts (id, task_id, generation, desired_state)
		  VALUES ('attempt-1', 'task-1', 1, 'started');
		INSERT INTO agents (agent_id, kind, generation, last_poll_at, state)
		  VALUES ('runner-1', 'runner', 0, NULL, 'offline');
		INSERT INTO mailbox
		  (message_uid, source_kind, source_id, payload, payload_digest, to_agent,
		   kind, retention_class, cutover_epoch, created_at)
		  VALUES ('message-1', 'lead', 'source-1', '{}', 'digest', 'runner-1',
		   'instruction', 'business', 1, '2026-07-27T00:00:00.000Z');
	`);
}

describe("single-writer invariants across real OS processes", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("resolves the sqlite driver for the child out of band", async () => {
		// 这条是上面那两条的前置自证:child 能跑起来、能连库、能回话。
		// 若解析环境变了(driverPath 传丢/包移位),这里先红,而不是让并发断言给出误导性的失败。
		temp = makeTempDatabase();
		const childPath = join(temp.dir, "child.cjs");
		writeFileSync(childPath, CHILD_SOURCE);
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			seed(db);
			const ok = await runInChildProcess(
				childPath,
				temp.path,
				`INSERT INTO meta (key, value, updated_at)
				 VALUES ('cross-process-probe', 'ok', '2026-07-27T00:00:00.000Z')`,
			);
			expect(ok.ok).toBe(true);
			expect(ok.changes).toBe(1);
		} finally {
			db.close();
		}
	});

	it("reaps a hung child itself instead of leaning on the framework timeout", async () => {
		// helper 的超时必须早于 Vitest 的 testTimeout(默认 5s),否则卡住的 child 会被框架
		// 判超时后遗留下来污染后续用例。这条把「helper 自己收尸」钉在仓内。
		temp = makeTempDatabase();
		const childPath = join(temp.dir, "hung.cjs");
		writeFileSync(childPath, HUNG_CHILD_SOURCE);

		const observed: ChildObservation = {};
		const startedAt = performance.now();
		await expect(
			runInChildProcess(childPath, temp.path, "SELECT 1", observed),
		).rejects.toThrow(/did not settle within/);
		const elapsedMs = performance.now() - startedAt;

		// 早于框架 5s 超时结算 —— 证明是 helper 收的尸,不是 Vitest。
		expect(elapsedMs).toBeLessThan(4_000);
		expect(elapsedMs).toBeGreaterThanOrEqual(CHILD_TIMEOUT_MS);
		// 光看耗时和错误消息证明不了收尸真发生了(退化成 kill 后立刻 reject 也能过)。
		// 直接对 pid 取证:结算之后它必须已经不在。
		expect(observed.pid).toBeTypeOf("number");
		expect(isAlive(observed.pid as number)).toBe(false);
	});

	it("reaps a child that drops its IPC channel but stays alive", async () => {
		// 见 DISCONNECTED_CHILD_SOURCE 上方的诚实边界说明:这条实际走的是超时收尸路径,
		// 保证「IPC 断了还赖着不死的 child 最终仍被收掉」,不是对 'error' 分支的覆盖。
		temp = makeTempDatabase();
		const childPath = join(temp.dir, "disconnected.cjs");
		writeFileSync(childPath, DISCONNECTED_CHILD_SOURCE);

		const observed: ChildObservation = {};
		await expect(
			runInChildProcess(childPath, temp.path, "SELECT 1", observed),
		).rejects.toThrow();

		expect(observed.pid).toBeTypeOf("number");
		expect(isAlive(observed.pid as number)).toBe(false);
	});

	it("rejects a second running processing attempt raised by a separate process", async () => {
		temp = makeTempDatabase();
		const childPath = join(temp.dir, "child.cjs");
		writeFileSync(childPath, CHILD_SOURCE);
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			seed(db);
			db.prepare(
				`INSERT INTO processing_attempts
				 (attempt_uid, message_uid, attempt_no, instance_id, generation, started_at)
				 VALUES ('pa-1', 'message-1', 1, 'instance-a', 1, '2026-07-27T00:00:00.000Z')`,
			).run();

			const rejected = await runInChildProcess(
				childPath,
				temp.path,
				`INSERT INTO processing_attempts
				 (attempt_uid, message_uid, attempt_no, instance_id, generation, started_at)
				 VALUES ('pa-2', 'message-1', 2, 'instance-b', 1, '2026-07-27T00:00:00.000Z')`,
			);
			expect(rejected.ok).toBe(false);
			expect(rejected.code).toMatch(/^SQLITE_CONSTRAINT/);

			// 结算旧行之后,另一个进程必须能重新开一次尝试 —— 约束不能把重试锁死。
			db.prepare(
				`UPDATE processing_attempts SET outcome = 'failed', settled_at = '2026-07-27T00:01:00.000Z'
				 WHERE attempt_uid = 'pa-1'`,
			).run();
			const retried = await runInChildProcess(
				childPath,
				temp.path,
				`INSERT INTO processing_attempts
				 (attempt_uid, message_uid, attempt_no, instance_id, generation, started_at)
				 VALUES ('pa-3', 'message-1', 3, 'instance-c', 1, '2026-07-27T00:00:00.000Z')`,
			);
			expect(retried.ok).toBe(true);
			expect(retried.changes).toBe(1);
		} finally {
			db.close();
		}
	});

	it("rejects a second active activation for the same attempt or session from another process", async () => {
		temp = makeTempDatabase();
		const childPath = join(temp.dir, "child.cjs");
		writeFileSync(childPath, CHILD_SOURCE);
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			seed(db);
			db.exec(`
				INSERT INTO tasks (id, project_id, kind, state, lineage_root_id, created_at)
				  VALUES ('task-2', 'flywheel', 'build', 'running', 'task-2', '2026-07-27T00:00:00.000Z');
				INSERT INTO attempts (id, task_id, generation, desired_state)
				  VALUES ('attempt-2', 'task-2', 1, 'started');
				INSERT INTO activations (id, attempt_id, session_ref, generation, state)
				  VALUES ('activation-1', 'attempt-1', 'session-1', 1, 'active');
			`);

			const sameAttempt = await runInChildProcess(
				childPath,
				temp.path,
				`INSERT INTO activations (id, attempt_id, session_ref, generation, state)
				 VALUES ('activation-2', 'attempt-1', 'session-2', 2, 'active')`,
			);
			expect(sameAttempt.ok).toBe(false);
			expect(sameAttempt.code).toMatch(/^SQLITE_CONSTRAINT/);

			const sameSession = await runInChildProcess(
				childPath,
				temp.path,
				`INSERT INTO activations (id, attempt_id, session_ref, generation, state)
				 VALUES ('activation-3', 'attempt-2', 'session-1', 1, 'active')`,
			);
			expect(sameSession.ok).toBe(false);
			expect(sameSession.code).toMatch(/^SQLITE_CONSTRAINT/);

			// 旧 activation 转 terminal 后,换代(新 active 行)必须可行。
			db.prepare(
				"UPDATE activations SET state = 'terminal' WHERE id = 'activation-1'",
			).run();
			const cutover = await runInChildProcess(
				childPath,
				temp.path,
				`INSERT INTO activations (id, attempt_id, session_ref, generation, state)
				 VALUES ('activation-4', 'attempt-1', 'session-1', 2, 'active')`,
			);
			expect(cutover.ok).toBe(true);
			expect(cutover.changes).toBe(1);
		} finally {
			db.close();
		}
	});
});
