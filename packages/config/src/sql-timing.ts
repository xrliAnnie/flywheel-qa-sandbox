import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
export interface SqlTimingRecord {
	databaseKind: string;
	sqlId: string;
	method: string;
	durationMs: number;
}
export interface SqlTimingOptions {
	now?: () => number;
	warn?: (record: SqlTimingRecord) => void;
}
type Method = (this: unknown, ...args: unknown[]) => unknown;
const installed = new WeakSet<object>();
const transactionVariants = new Set([
	"default",
	"immediate",
	"deferred",
	"exclusive",
]);
/** Wrap only this connection instance. Never log SQL text, parameters or errors. */
export function installSqlTiming<T extends object>(
	db: T,
	databaseKind: string,
	options: SqlTimingOptions = {},
): T {
	if (installed.has(db)) return db;
	const clock = options.now ?? (() => performance.now());
	const warn =
		options.warn ??
		((record) => console.warn(`[slow-sql] ${JSON.stringify(record)}`));
	const safeNow = () => {
		try {
			return clock();
		} catch {
			return NaN;
		}
	};
	const measured = (
		fn: Method,
		receiver: unknown,
		args: unknown[],
		sqlId: string,
		method: string,
	) => {
		const started = safeNow();
		try {
			return Reflect.apply(fn, receiver, args);
		} finally {
			const durationMs = safeNow() - started;
			if (durationMs > 250) {
				try {
					warn({ databaseKind, sqlId, method, durationMs });
				} catch {
					/* diagnostics cannot replace the SQL result */
				}
			}
		}
	};
	const sqlIdFor = (sql: unknown) =>
		createHash("sha256")
			.update(typeof sql === "string" ? sql : "invalid-sql")
			.digest("hex")
			.slice(0, 16);
	const statements = new WeakSet<object>();
	const iterators = new WeakSet<object>();
	const wrapMethods = (object: object, names: string[], sqlId: string) => {
		const target = object as Record<string, unknown>;
		for (const method of names) {
			const original = target[method];
			if (typeof original !== "function") continue;
			target[method] = function (this: unknown, ...args: unknown[]) {
				return measured(original as Method, this, args, sqlId, method);
			};
		}
	};
	const instrumentStatement = (statement: object, sqlId: string) => {
		if (statements.has(statement)) return statement;
		statements.add(statement);
		wrapMethods(statement, ["run", "get", "all"], sqlId);
		const target = statement as Record<string, unknown>;
		const iterate = target.iterate;
		if (typeof iterate === "function")
			target.iterate = function (this: unknown, ...args: unknown[]) {
				const iterator = measured(
					iterate as Method,
					this,
					args,
					sqlId,
					"iterate",
				) as object;
				if (iterator && !iterators.has(iterator)) {
					iterators.add(iterator);
					wrapMethods(iterator, ["next", "return", "throw"], sqlId);
				}
				return iterator;
			};
		return statement;
	};
	const transactions = new WeakMap<Method, Method>();
	const instrumentTransaction = (original: Method): Method => {
		const cached = transactions.get(original);
		if (cached) return cached as Method;
		const wrapped = function (this: unknown, ...args: unknown[]) {
			return measured(
				original,
				this,
				args,
				sqlIdFor("transaction"),
				"transaction",
			);
		};
		transactions.set(original, wrapped);
		// better-sqlite3 uses nonconfigurable alias properties, so wrapping through
		// a Proxy get trap would violate its invariants. Copy descriptors instead.
		const descriptors = Object.getOwnPropertyDescriptors(original);
		for (const name of transactionVariants) {
			const descriptor = descriptors[name];
			if (descriptor && typeof descriptor.value === "function")
				descriptor.value = instrumentTransaction(descriptor.value as Method);
		}
		Object.defineProperties(wrapped, descriptors);
		return wrapped;
	};
	const target = db as Record<string, unknown>;
	for (const method of ["prepare", "exec", "pragma", "transaction"]) {
		const original = target[method];
		if (typeof original !== "function") continue;
		target[method] = function (this: unknown, ...args: unknown[]) {
			const sqlId = sqlIdFor(
				method === "transaction" ? "transaction" : args[0],
			);
			const result = measured(
				original as Method,
				this,
				args,
				sqlId,
				method === "transaction" ? "transaction.create" : method,
			);
			if (method === "prepare")
				return instrumentStatement(result as object, sqlId);
			if (method === "transaction")
				return instrumentTransaction(result as Method);
			return result;
		};
	}
	installed.add(db);
	return db;
}
