// FLY-616 — better-sqlite3-backed READ-ONLY reader for teamlead.db.
//
// 安全边界：以 `readonly:true` + `fileMustExist:true` 打开 = OS 级真只读
// (连接无写权限、绝不创建/写文件，比原 sql.js『load bytes 不 save』更硬)。
// **绝不实例化 StateStore** (它 create()→migrate() 会写回)。显式 SELECT。
// FLY-663 把 StateStore 迁到 better-sqlite3 后,eval 也用同一原生引擎 —— 一致
// + 更快,且不再为读一个 SQLite 文件而重新引入 sql.js (WASM) 依赖。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3, { type Database as BetterDb } from "better-sqlite3";
import type { EvalReaders, SessionRow } from "./extract.js";
import { v1MockedExternalReaders } from "./extract.js";
import type { TaskRunHandle } from "./types.js";

/** Open a teamlead.db read-only (no write perms, never creates). Cached per path. */
function openReadonly(dbPath: string, cache: Map<string, BetterDb>): BetterDb {
	const existing = cache.get(dbPath);
	if (existing) return existing;
	// readonly:true → connection can never modify the file.
	// fileMustExist:true → a missing path throws instead of creating an empty DB.
	const db = new BetterSqlite3(dbPath, {
		readonly: true,
		fileMustExist: true,
	});
	cache.set(dbPath, db);
	return db;
}

function one(
	db: BetterDb,
	sql: string,
	params: unknown[],
): Record<string, unknown> | null {
	const row = db.prepare(sql).get(...(params as never[]));
	return (row as Record<string, unknown> | undefined) ?? null;
}

function scalarCount(db: BetterDb, sql: string, params: unknown[]): number {
	const row = one(db, sql, params);
	if (!row) return 0;
	const v = Object.values(row)[0];
	return typeof v === "number" ? v : Number(v ?? 0);
}

/**
 * 真只读 readers：质量信号 (sessions / auto_qa_record) 走 better-sqlite3 readonly；
 * landing 走文件 (路径 = handle.landStatusPath ?? worktree/.flywheel/runs/<execId>/land-status.json, Codex R4 #2)；
 * 614 token / lagging / diff = v1 mocked (注入 overrides 可替换)。
 */
export async function createSqliteReaders(
	overrides: Partial<EvalReaders> = {},
): Promise<EvalReaders> {
	const cache = new Map<string, BetterDb>();

	const base: EvalReaders = {
		async readSession(dbPath, execId): Promise<SessionRow | null> {
			const db = openReadonly(dbPath, cache);
			const row = one(
				db,
				"SELECT status, pr_number, pr_head_sha, worktree_path FROM sessions WHERE execution_id = ?",
				[execId],
			);
			if (!row) return null;
			return {
				status: (row.status as string) ?? null,
				prNumber: row.pr_number == null ? null : Number(row.pr_number),
				prHeadSha: (row.pr_head_sha as string) ?? null,
				worktreePath: (row.worktree_path as string) ?? null,
			};
		},

		async readAcceptedQaStatus(
			dbPath,
			parentExecId,
			targetPrHeadSha,
		): Promise<string | null> {
			if (!targetPrHeadSha) return null; // 无 head → 无法绑定 accepted record
			const db = openReadonly(dbPath, cache);
			// Codex R2 #1：列名 target_pr_head_sha，绑 sessions.pr_head_sha
			const row = one(
				db,
				"SELECT status FROM auto_qa_record WHERE parent_execution_id = ? AND target_pr_head_sha = ?",
				[parentExecId, targetPrHeadSha],
			);
			return row ? ((row.status as string) ?? null) : null;
		},

		async qaFamilyExists(dbPath, parentExecId): Promise<boolean> {
			const db = openReadonly(dbPath, cache);
			return (
				scalarCount(
					db,
					"SELECT COUNT(*) AS c FROM auto_qa_record WHERE parent_execution_id = ?",
					[parentExecId],
				) > 0
			);
		},

		async countQaFailLoops(dbPath, parentExecId): Promise<number> {
			const db = openReadonly(dbPath, cache);
			return scalarCount(
				db,
				"SELECT COUNT(*) AS c FROM auto_qa_record WHERE parent_execution_id = ? AND status = 'failed'",
				[parentExecId],
			);
		},

		readLandingRaw(
			handle: TaskRunHandle,
			session: SessionRow | null,
		): string | null {
			const path =
				handle.landStatusPath ??
				landingPathFor(
					handle,
					session?.worktreePath ?? handle.worktreePath ?? null,
				);
			if (!path) return null;
			try {
				return readFileSync(path, "utf-8");
			} catch {
				return null; // 文件缺/不可读 → not attempted
			}
		},

		...v1MockedExternalReaders,
		...overrides,
	};

	return base;
}

/** land-status 路径派生 (Codex R4 #2)：${worktreePath}/.flywheel/runs/<execId>/land-status.json。 */
export function landingPathFor(
	handle: TaskRunHandle,
	worktreePath: string | null,
): string | null {
	if (!worktreePath) return null;
	return join(
		worktreePath,
		".flywheel",
		"runs",
		handle.execId,
		"land-status.json",
	);
}
