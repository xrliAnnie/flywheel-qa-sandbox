import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { runMigrations } from "../migrator.js";
import { CANDIDATE_SQL, DETECTOR_SQL } from "../sql/candidates.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

// QA (FLY-1497) — 补 query-plan.test.ts 的一个**前提条件缺口**。
//
// query-plan.test.ts 在一个刚建好、从未 ANALYZE 过的库上断言「四条候选各自命中自己的
// _f / _nf partial index」。那个断言是真的,但它成立的前提是**优化器统计缺席**。
//
// 机制(已用「删 stat4 保 stat1」隔离实测,不是推测):本仓的 SQLite 3.51.3 编译开了
// SQLITE_ENABLE_STAT4,`ANALYZE` 会同时产出 sqlite_stat1 与 sqlite_stat4。真正让 planner
// 改判到**基础**索引 mailbox_pending_scheduled 的是 **sqlite_stat4 的直方图样本** ——
// 只删掉 sqlite_stat4、保留 sqlite_stat1,F2/N2 会**全部回到** _f/_nf。所以正确表述是
// 「ANALYZE 产生的 STAT4 样本可能改变精确选择」,而不是「sqlite_stat1 一出现就翻」。
//
// 是否翻还取决于 founder/非-founder 配比(3000 行 1/7 翻 F2、1/50 翻 N2、1/20 两条都不翻)。
//
// 这不是正确性缺陷:基础索引的 WHERE 是 partial 索引 WHERE 的严格超集,列顺序
// (to_agent,next_retry_at,seq) 完全相同 → 结果集与顺序不变,LIMIT 1 仍能提前终止,
// 且**任何配置下都不出现 USE TEMP B-TREE**。影响面是「fairness 分区可能悄悄不再被使用」
// 的性能/公平性问题,归属批次 2(消费循环落地时)。

const EXPECTED_INDEX = {
	F1: "mailbox_pending_immediate_f",
	F2: "mailbox_pending_scheduled_f",
	N1: "mailbox_pending_immediate_nf",
	N2: "mailbox_pending_scheduled_nf",
} as const;

const FREE_CANDIDATE_SQL = Object.fromEntries(
	Object.entries(CANDIDATE_SQL).map(([name, sql]) => [
		name,
		sql.replace(
			/ INDEXED BY mailbox_pending_(?:immediate|scheduled)_(?:f|nf)/,
			"",
		),
	]),
) as Record<keyof typeof CANDIDATE_SQL, string>;

interface PlanRow {
	detail: string;
}

function seed(
	db: ReturnType<typeof openKernelDb>,
	rows: number,
	founderEvery: number,
): void {
	const insert = db.prepare(
		`INSERT INTO mailbox
		 (message_uid, source_kind, source_id, payload, payload_digest, to_agent,
		  kind, retention_class, cutover_epoch, state, retry_count, next_retry_at, created_at)
		 VALUES (?, ?, ?, '{}', 'digest', ?, 'instruction', 'business', 1, ?, 0, ?, '2026-07-26T00:00:00.000Z')`,
	);
	db.transaction(() => {
		for (let i = 0; i < 25; i++) {
			db.prepare(
				`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
				 VALUES (?, 'lead', 0, NULL, 'offline')`,
			).run(`runner-${i}`);
		}
		for (let i = 0; i < rows; i++) {
			insert.run(
				`message-${i}`,
				i % founderEvery === 0 ? "founder" : "lead",
				`source-${i}`,
				`runner-${i % 25}`,
				i % 11 === 0 ? "applied" : "pending",
				i % 3 === 0 ? "2026-07-26T00:00:00.000Z" : null,
			);
		}
	})();
}

function planFor(db: ReturnType<typeof openKernelDb>, sql: string): string[] {
	return (
		db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({
			agent: "runner-1",
			now: "2026-07-27T00:00:00.000Z",
			cutoff: "2026-07-27T00:00:00.000Z",
		}) as PlanRow[]
	).map((row) => row.detail);
}

function statTables(db: ReturnType<typeof openKernelDb>): string[] {
	return db
		.prepare(
			"SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%' ORDER BY name",
		)
		.pluck()
		.all() as string[];
}

describe("candidate query plans once ANALYZE statistics exist", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	// founder 配比会左右 planner 在 F2/N2 上的取舍,所以多个方向各测一遍。
	it.each([
		["founder-dense", 7],
		["founder-mid", 20],
		["founder-sparse", 50],
	])(
		"keeps every candidate on an index-satisfied ordering with %s traffic",
		(_label, founderEvery) => {
			temp = makeTempDatabase();
			const db = openKernelDb({ path: temp.path });
			try {
				runMigrations(db);
				seed(db, 3000, founderEvery);
				db.exec("ANALYZE");

				for (const [name, sql] of [
					["F1", CANDIDATE_SQL.F1],
					["F2", CANDIDATE_SQL.F2],
					["N1", CANDIDATE_SQL.N1],
					["N2", CANDIDATE_SQL.N2],
				] as const) {
					const details = planFor(db, sql);
					const joined = details.join("\n");

					// 不变量 1:完整统计存在时仍精确命中公平分区索引。
					expect(
						details.some(
							(detail) =>
								detail.includes("SEARCH") &&
								detail.includes(EXPECTED_INDEX[name]),
						),
						`${name}: ${joined}`,
					).toBe(true);
					expect(
						details.some((detail) => detail.includes("SCAN mailbox")),
						`${name}: ${joined}`,
					).toBe(false);

					// 不变量 2:ORDER BY 始终由索引满足 —— 这是 §1.2f 设计真正依赖的性质,
					// 任何配置下都不许出现临时排序。
					expect(
						details.some((detail) => detail.includes("USE TEMP B-TREE")),
						`${name}: ${joined}`,
					).toBe(false);
				}
				const detectorDetails = planFor(db, DETECTOR_SQL);
				expect(detectorDetails.join("\n")).toContain("mailbox_pending_age");
				expect(detectorDetails.join("\n")).not.toContain("SCAN mailbox");
				expect(detectorDetails.join("\n")).not.toContain("USE TEMP B-TREE");

				for (const name of Object.keys(CANDIDATE_SQL) as Array<
					keyof typeof CANDIDATE_SQL
				>) {
					const pinned = db.prepare(CANDIDATE_SQL[name]).get({
						agent: "runner-1",
						now: "2026-07-27T00:00:00.000Z",
					});
					const free = db.prepare(FREE_CANDIDATE_SQL[name]).get({
						agent: "runner-1",
						now: "2026-07-27T00:00:00.000Z",
					});
					expect(pinned).toEqual(free);
				}
			} finally {
				db.close();
			}
		},
	);

	it("attributes the scheduled-candidate plan flip to STAT4 samples, not to sqlite_stat1", () => {
		// 受控翻盘观察:3000 行 / founder 1/7 是实测能稳定复现 F2 翻盘的配置。
		// 这条测试真的去**看见**翻盘,而不是写个「无论怎样都成立」的宽松断言。
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);

			// 阶段 1:无任何统计 —— 精确命中 _f。
			expect(planFor(db, FREE_CANDIDATE_SQL.F2).join("\n")).toContain(
				"mailbox_pending_scheduled_f",
			);

			seed(db, 3000, 7);
			db.exec("ANALYZE");

			// 本仓 SQLite 编译开了 STAT4;若哪天换成没有 STAT4 的构建,这条会红,
			// 提醒后来者这套刻画的前提变了。
			expect(statTables(db)).toContain("sqlite_stat4");

			// 阶段 2:完整 ANALYZE(stat1 + stat4)—— planner 改判到基础索引。
			const withStat4 = planFor(db, FREE_CANDIDATE_SQL.F2).join("\n");
			expect(withStat4).toContain("mailbox_pending_scheduled");
			expect(withStat4).not.toContain("mailbox_pending_scheduled_f");

			// 阶段 3:只删 stat4、保留 stat1 —— 精确选择**回到** _f。
			// 这一步才是把因果钉在 STAT4 上的证据。
			db.exec("DELETE FROM sqlite_stat4");
			db.close();
			const reopened = openKernelDb({ path: temp.path });
			try {
				expect(statTables(reopened)).toContain("sqlite_stat1");
				const withoutStat4 = planFor(reopened, FREE_CANDIDATE_SQL.F2).join(
					"\n",
				);
				expect(withoutStat4).toContain("mailbox_pending_scheduled_f");

				// 全程不许出现临时排序 —— 翻盘只影响选哪个索引,不影响顺序由索引满足。
				expect(withStat4).not.toContain("USE TEMP B-TREE");
				expect(withoutStat4).not.toContain("USE TEMP B-TREE");
			} finally {
				reopened.close();
			}
		} finally {
			// 阶段 3 已经关过一次;重复 close 由 better-sqlite3 容忍。
			db.close();
		}
	});
});
