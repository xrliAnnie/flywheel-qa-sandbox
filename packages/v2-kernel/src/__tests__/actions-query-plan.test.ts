import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

const INCIDENT_QUERIES = [
	{
		name: "state",
		where: "state=@value",
		value: "intended",
		index: "actions_state_created",
	},
	{
		name: "actor",
		where: "actor_agent_id=@value",
		value: "lead-a",
		index: "actions_actor_created",
	},
	{
		name: "task",
		where: "task_id=@value",
		value: "task-1",
		index: "actions_task_created",
	},
	{
		name: "logical effect",
		where: "logical_key=@value",
		value: "logical-1",
		index: "actions_logical_created",
	},
] as const;

function planDetail(
	db: ReturnType<typeof openKernelDb>,
	where: string,
	value: string,
): string {
	return db
		.prepare(
			`EXPLAIN QUERY PLAN
			 SELECT id FROM actions
			  WHERE ${where}
			  ORDER BY created_at DESC, id DESC
			  LIMIT @limit`,
		)
		.all({ value, limit: 10 })
		.map((row) => (row as { detail: string }).detail)
		.join("\n");
}

describe("action incident query plans", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it.each(INCIDENT_QUERIES)(
		"uses the named $name index without a temporary sort",
		({ where, value, index }) => {
			temp = makeTempDatabase();
			const db = openKernelDb({ path: temp.path });
			try {
				runMigrations(db);
				const detail = planDetail(db, where, value);
				expect(detail).toContain(index);
				expect(detail).not.toContain("USE TEMP B-TREE");
			} finally {
				db.close();
			}
		},
	);

	// QA (FLY-1500) — 上面四条断言跑在**刚建好、从未 ANALYZE 过**的空库上。FLY-1497 的 QA 已经
	// 实测过：本仓 SQLite 编译开了 SQLITE_ENABLE_STAT4，`ANALYZE` 产出的直方图样本会改判
	// mailbox 家族的精确索引选择。actions 的四条事故现场读取（mapping §5）必须主动纳入同一
	// 变体断言，否则「命中命名索引」这件事只在空库这一种统计形态下被证明过。
	it("keeps every incident query on its named index once STAT4 statistics exist", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			db.prepare(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-a', 'lead', 1, 'online')`,
			).run();
			db.prepare(
				`INSERT INTO agents(agent_id, kind, generation, state)
				 VALUES ('lead-b', 'lead', 1, 'online')`,
			).run();
			const insertTask = db.prepare(
				`INSERT INTO tasks (id, project_id, kind, state, lineage_root_id, created_at)
				 VALUES (?, 'flywheel', 'build', 'ready', ?, '2026-07-27T00:00:00.000Z')`,
			);
			const insertAction = db.prepare(
				`INSERT INTO actions
				 (id, task_id, actor_kind, actor_agent_id, actor_instance_id,
				  actor_generation, kind, payload, payload_digest, logical_key,
				  effect_key, cutover_epoch, state, result, created_at, completed_at)
				 VALUES (?, ?, 'lead', ?, 'session-a', 1, 'custom_tool', '{}',
				  'payload-digest', ?, ?, 1, ?, ?, ?, ?)`,
			);
			db.transaction(() => {
				for (let index = 0; index < 20; index++) {
					insertTask.run(`task-${index}`, `task-${index}`);
				}
				for (let index = 0; index < 3000; index++) {
					// 混合形态贴近事故现场：少数 intended（崩溃窗）、多数终态、四分之一无 task 绑定、
					// 少数由第二个 Lead 写入 —— 让 STAT4 拿到有区分度的样本而不是均匀分布。
					const state =
						index % 9 === 0
							? "intended"
							: index % 3 === 0
								? "failed"
								: "succeeded";
					insertAction.run(
						`action-${index}`,
						index % 4 === 0 ? null : `task-${index % 20}`,
						index % 7 === 0 ? "lead-b" : "lead-a",
						`logical-${index}`,
						`effect-${index}`,
						state,
						state === "intended" ? null : "{}",
						`2026-07-27T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
						state === "intended" ? null : "2026-07-27T01:00:00.000Z",
					);
				}
			})();
			db.exec("ANALYZE");

			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%' ORDER BY name",
					)
					.pluck()
					.all(),
			).toContain("sqlite_stat4");
			for (const { where, value, index } of INCIDENT_QUERIES) {
				const detail = planDetail(db, where, value);
				expect(detail).toContain(index);
				expect(detail).not.toContain("USE TEMP B-TREE");
			}
		} finally {
			db.close();
		}
	});
});
