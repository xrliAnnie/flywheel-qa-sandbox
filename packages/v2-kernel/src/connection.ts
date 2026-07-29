import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { KernelOpenOptions } from "./types.js";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const WAL_RETRY_INTERVAL_MS = 10;
const WAL_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

export interface InternalConnOptions extends KernelOpenOptions {
	readonly?: boolean;
}

function requirePositiveFinite(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new TypeError(`${name} must be a finite positive number`);
	}
}

function enableWalWithBusyRetry(
	db: Database.Database,
	busyTimeoutMs: number,
): void {
	const deadline = Date.now() + busyTimeoutMs;
	for (;;) {
		try {
			db.pragma("journal_mode = WAL");
			return;
		} catch (error) {
			if (
				!(error instanceof Database.SqliteError) ||
				error.code !== "SQLITE_BUSY" ||
				Date.now() >= deadline
			) {
				throw error;
			}
			Atomics.wait(
				WAL_RETRY_SIGNAL,
				0,
				0,
				Math.min(WAL_RETRY_INTERVAL_MS, deadline - Date.now()),
			);
		}
	}
}

export function openKernelDb(opts: InternalConnOptions): Database.Database {
	if (!opts.path) {
		throw new TypeError("path is required");
	}
	const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
	requirePositiveFinite(busyTimeoutMs, "busyTimeoutMs");

	if (!opts.readonly && !opts.fileMustExist && opts.path !== ":memory:") {
		const parent = dirname(opts.path);
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		chmodSync(parent, 0o700);
	}

	const verbose = opts.verbose
		? (message?: unknown) => opts.verbose?.(String(message ?? ""))
		: undefined;
	const db = new Database(opts.path, {
		readonly: opts.readonly ?? false,
		fileMustExist: opts.fileMustExist ?? opts.readonly ?? false,
		timeout: busyTimeoutMs,
		verbose,
	});

	try {
		db.pragma(`busy_timeout = ${busyTimeoutMs}`);
		db.pragma("foreign_keys = ON");
		if (!opts.readonly) {
			enableWalWithBusyRetry(db, busyTimeoutMs);
			db.pragma(`synchronous = ${opts.synchronousMode ?? "FULL"}`);
			if (opts.path !== ":memory:") {
				chmodSync(opts.path, 0o600);
			}
		}
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
