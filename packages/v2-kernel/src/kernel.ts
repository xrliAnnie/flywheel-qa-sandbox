import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { openKernelDb } from "./connection.js";
import {
	CasViolation,
	FenceViolation,
	NestedWriteViolation,
	TxBudgetExceeded,
	TxLifecycleViolation,
} from "./errors.js";
import { type AgentIdentity, identitiesEqual, readRegistry } from "./fence.js";
import type { KernelOpenOptions } from "./types.js";

export {
	CasViolation,
	FenceViolation,
	NestedWriteViolation,
	TxBudgetExceeded,
	TxLifecycleViolation,
};

const DEFAULT_TX_BUDGET_MS = 1_000;

type SyncOnly<T> = T extends PromiseLike<unknown> ? never : T;

interface StatementRunResult {
	changes: number;
	lastInsertRowid: number | bigint;
}

export interface ReadTx {
	get<T>(sql: string, params?: unknown): T | undefined;
	all<T>(sql: string, params?: unknown): T[];
}

export interface WriteTx extends ReadTx {
	run(sql: string, params?: unknown): StatementRunResult;
	cas(sql: string, params: unknown, expectedChanges?: number): void;
	requireIdentity(registryKey: string, expected: AgentIdentity): void;
}

function requirePositiveFinite(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new TypeError(`${name} must be a finite positive number`);
	}
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		"then" in value &&
		typeof value.then === "function"
	);
}

function invokeStatement<T>(
	statement: Database.Statement,
	method: "get" | "all" | "run",
	params: unknown,
): T {
	if (params === undefined) {
		return statement[method]() as T;
	}
	if (Array.isArray(params)) {
		return statement[method](...params) as T;
	}
	return statement[method](params) as T;
}

const CONNECTION_STATE_KEYWORDS = new Set([
	"ATTACH",
	"BEGIN",
	"COMMIT",
	"DETACH",
	"END",
	"PRAGMA",
	"RELEASE",
	"ROLLBACK",
	"SAVEPOINT",
	"VACUUM",
]);

/**
 * 跳过 SQLite 在 token 之间会忽略的东西:空白、BOM、行注释、块注释。
 *
 * `skipEmptyStatements` 只在**语句起始处**为真 —— 那里的 `;` 是一条合法空语句,SQLite 会跳过;
 * 而 token **之间**的 `;` 是真正的语句边界,绝不能跳,否则就跨过边界去读下一条语句了。
 *
 * 未闭合的块注释 / 未换行的行注释返回空串:后面的内容 SQLite 也看不见,
 * 调用方会得到空关键字,随后由 `db.prepare` 以语法错误拒掉(fail-closed)。
 */
function skipIgnorable(sql: string, skipEmptyStatements: boolean): string {
	let remaining = sql;
	for (;;) {
		const trimmed = remaining.replace(/^[\s\uFEFF]+/, "");
		if (trimmed !== remaining) {
			remaining = trimmed;
			continue;
		}
		if (skipEmptyStatements && remaining.startsWith(";")) {
			remaining = remaining.slice(1);
			continue;
		}
		if (remaining.startsWith("--")) {
			const newline = remaining.indexOf("\n");
			if (newline < 0) {
				return "";
			}
			remaining = remaining.slice(newline + 1);
			continue;
		}
		if (remaining.startsWith("/*")) {
			const close = remaining.indexOf("*/", 2);
			if (close < 0) {
				return "";
			}
			remaining = remaining.slice(close + 2);
			continue;
		}
		return remaining;
	}
}

function keywordAt(sql: string): string {
	return /^[A-Za-z]+/.exec(sql)?.[0]?.toUpperCase() ?? "";
}

/**
 * 取出 SQLite 实际会执行的那条语句的首关键字。
 *
 * 必须跟 SQLite prepare 的 tokenizer 对齐 —— **任何分歧都是绕过**。已经踩过三次:
 * ① 守卫只装在只读面,写入面没有;
 * ② 不跳前导空语句,单个 `;` 前缀就废掉整道守卫;
 * ③ 只看最外层关键字,`EXPLAIN PRAGMA …` 直接生效;而随后剥外壳时只认空白分隔,
 *    注释插在 `EXPLAIN`/`QUERY`/`PLAN` 之间照样绕(SQLite 在 token 间忽略注释)。
 *
 * 教训:别再就地写第二套「跳过什么」的规则。token 间的忽略语义统一走 `skipIgnorable`,
 * 唯一区别是语句起始处额外跳空语句(`;`)。
 */
function leadingSqlKeyword(sql: string): string {
	// 语句起始:空白/注释/BOM/空语句都要跳。
	let remaining = skipIgnorable(sql, true);
	for (;;) {
		const keyword = keywordAt(remaining);
		// EXPLAIN 外壳剥掉再看里面那条;剥而不是一律禁,
		// 因为 `EXPLAIN QUERY PLAN SELECT …` 是只读面的合法用法。
		if (keyword !== "EXPLAIN") {
			return keyword;
		}
		// 以下都是 token **之间**:按 SQLite 规则跳空白/注释,但不跳分号。
		remaining = skipIgnorable(remaining.slice(keyword.length), false);
		if (keywordAt(remaining) === "QUERY") {
			const afterQuery = skipIgnorable(remaining.slice("QUERY".length), false);
			if (keywordAt(afterQuery) === "PLAN") {
				remaining = skipIgnorable(afterQuery.slice("PLAN".length), false);
			}
		}
	}
}

class ReadTransaction implements ReadTx {
	protected active = true;

	constructor(
		protected readonly db: Database.Database,
		private readonly enforceReadonly = true,
		private readonly facadeLabel = "read facade",
	) {}

	invalidate(): void {
		this.active = false;
	}

	protected assertActive(operation: string): void {
		if (!this.active) {
			throw new TxLifecycleViolation(operation);
		}
	}

	get<T>(sql: string, params?: unknown): T | undefined {
		this.assertActive("get");
		const statement = this.prepare(sql);
		return invokeStatement<T | undefined>(statement, "get", params);
	}

	all<T>(sql: string, params?: unknown): T[] {
		this.assertActive("all");
		const statement = this.prepare(sql);
		return invokeStatement<T[]>(statement, "all", params);
	}

	/**
	 * 两个 façade 共用的 prepare 边界。
	 *
	 * 连接状态 / 事务控制 SQL 对**读写两侧都禁止**:事务边界由 Kernel.write 的
	 * BEGIN IMMEDIATE 独占;**调用方提供的** PRAGMA 一律不接受(设计 §0.5b)。
	 * 说准确点:kernel 自身在 write() 入口有两处 foreign_keys 的设/读回防御性调用,
	 * 连接工厂里也有几处 —— 这道守卫管的是「不让调用方从 tx 句柄塞 PRAGMA 进来」,
	 * 不是「进程里再无 PRAGMA 字样」。若调用方能从
	 * tx 句柄里执行 COMMIT,回调抛错时事务已经提交、"异常整体回滚"的支柱就没了;
	 * 若能执行 PRAGMA ignore_check_constraints,CHECK 约束会被就地关掉。
	 * 早先只有只读面设了这道守卫,写入面漏了 —— 两条都被实测复现过,见同名回归测试。
	 *
	 * `enforceReadonly` 只额外管「语句必须是只读的」,那才是只读面独有的约束。
	 */
	protected prepare(sql: string): Database.Statement {
		const keyword = leadingSqlKeyword(sql);
		if (CONNECTION_STATE_KEYWORDS.has(keyword)) {
			throw new TypeError(
				`${this.facadeLabel} rejects connection-state SQL (${keyword})`,
			);
		}
		const statement = this.db.prepare(sql);
		if (this.enforceReadonly && !statement.readonly) {
			throw new TypeError(`${this.facadeLabel} accepts read-only SQL only`);
		}
		return statement;
	}
}

class WriteTransaction extends ReadTransaction implements WriteTx {
	constructor(db: Database.Database) {
		super(db, false, "write facade");
	}

	run(sql: string, params?: unknown): StatementRunResult {
		this.assertActive("run");
		return invokeStatement<StatementRunResult>(
			this.prepare(sql),
			"run",
			params,
		);
	}

	cas(sql: string, params: unknown, expectedChanges = 1): void {
		this.assertActive("cas");
		if (!Number.isInteger(expectedChanges) || expectedChanges < 0) {
			throw new TypeError("expectedChanges must be a non-negative integer");
		}
		const result = this.run(sql, params);
		if (result.changes !== expectedChanges) {
			throw new CasViolation(expectedChanges, result.changes);
		}
	}

	requireIdentity(registryKey: string, expected: AgentIdentity): void {
		this.assertActive("requireIdentity");
		const actual = readRegistry(this, registryKey);
		if (!actual || !identitiesEqual(actual, expected)) {
			throw new FenceViolation(`registry identity mismatch for ${registryKey}`);
		}
	}
}

export class Kernel {
	readonly #db: Database.Database;
	readonly #txBudgetMs: number;
	#inWrite = false;
	#closed = false;

	private constructor(db: Database.Database, txBudgetMs: number) {
		this.#db = db;
		this.#txBudgetMs = txBudgetMs;
	}

	static open(opts: KernelOpenOptions): Kernel {
		const txBudgetMs = opts.txBudgetMs ?? DEFAULT_TX_BUDGET_MS;
		requirePositiveFinite(txBudgetMs, "txBudgetMs");
		return new Kernel(openKernelDb(opts), txBudgetMs);
	}

	write<T>(label: string, fn: (tx: WriteTx) => SyncOnly<T>): SyncOnly<T> {
		this.#assertOpen();
		if (label.trim().length === 0) {
			throw new TypeError("write label must not be empty");
		}
		if (this.#inWrite) {
			throw new NestedWriteViolation(label);
		}
		if (fn.constructor.name === "AsyncFunction") {
			throw new TxLifecycleViolation("async write callback");
		}

		this.#inWrite = true;
		try {
			this.#db.pragma("foreign_keys = ON");
			if (this.#db.pragma("foreign_keys", { simple: true }) !== 1) {
				throw new Error("foreign key enforcement must be enabled");
			}
			return this.#db
				.transaction(() => {
					const tx = new WriteTransaction(this.#db);
					const startedAt = performance.now();
					try {
						const result = fn(tx);
						if (isThenable(result)) {
							throw new TxLifecycleViolation("thenable write callback");
						}
						const elapsedMs = performance.now() - startedAt;
						if (elapsedMs > this.#txBudgetMs) {
							throw new TxBudgetExceeded(label, elapsedMs, this.#txBudgetMs);
						}
						return result;
					} finally {
						tx.invalidate();
					}
				})
				.immediate() as SyncOnly<T>;
		} finally {
			this.#inWrite = false;
		}
	}

	read<T>(fn: (tx: ReadTx) => SyncOnly<T>): SyncOnly<T> {
		this.#assertOpen();
		if (fn.constructor.name === "AsyncFunction") {
			throw new TxLifecycleViolation("async read callback");
		}
		const tx = new ReadTransaction(this.#db);
		try {
			const result = fn(tx);
			if (isThenable(result)) {
				throw new TxLifecycleViolation("thenable read callback");
			}
			return result;
		} finally {
			tx.invalidate();
		}
	}

	close(): void {
		if (this.#closed) {
			return;
		}
		if (this.#inWrite) {
			throw new TxLifecycleViolation("close during write");
		}
		this.#db.close();
		this.#closed = true;
	}

	#assertOpen(): void {
		if (this.#closed) {
			throw new TxLifecycleViolation("kernel is closed");
		}
	}
}
