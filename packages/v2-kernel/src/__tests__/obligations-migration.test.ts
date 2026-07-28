import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { MIGRATIONS } from "../migrations/index.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

function insertTask(
	db: ReturnType<typeof openKernelDb>,
	id: string,
	state = "ready",
): void {
	db.prepare(
		`INSERT INTO tasks
			(id, project_id, kind, state, lineage_root_id, created_at)
		 VALUES (?, 'flywheel', 'build', ?, ?, '2026-07-27T00:00:00.000Z')`,
	).run(id, state, id);
}

function insertFinalObligation(
	db: ReturnType<typeof openKernelDb>,
	input: {
		id: string;
		targetKind: "task" | "agent";
		targetTaskId?: string | null;
		targetAgentId?: string | null;
		episodeKey?: string | null;
		parentId?: string | null;
		depth?: number;
		rootEpisodeId?: string | null;
	},
): void {
	db.prepare(
		`INSERT INTO obligations
			(id, kind, target_kind, target_task_id, target_agent_id, episode_key,
			 parent_obligation_id, depth, root_episode_id, opened_at)
		 VALUES
			(@id, 'mailbox_backlog', @targetKind, @targetTaskId, @targetAgentId,
			 @episodeKey, @parentId, @depth, @rootEpisodeId, '2026-07-27T00:00:00.000Z')`,
	).run({
		id: input.id,
		targetKind: input.targetKind,
		targetTaskId: input.targetTaskId ?? null,
		targetAgentId: input.targetAgentId ?? null,
		episodeKey: input.episodeKey ?? null,
		parentId: input.parentId ?? null,
		depth: input.depth ?? 0,
		rootEpisodeId: input.rootEpisodeId ?? null,
	});
}

describe("historical obligations rebuild migration through 0002", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("preserves old rows and backfills the final targeting and tier columns", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 1));
			insertTask(db, "task-1");
			db.prepare(
				`INSERT INTO obligations
				 (id, kind, target_task_id, target_attempt_generation, root_episode_id,
				  depth, episode_key, state, opened_at)
				 VALUES
				 ('old-open', 'mailbox_backlog', 'task-1', 2, 'episode-root', 0,
				  'episode-open', 'open', '2026-07-27T00:00:00.000Z')`,
			).run();
			db.prepare(
				`INSERT INTO obligations
				 (id, kind, target_task_id, root_episode_id, depth, state, opened_at,
				  resolved_at, resolution)
				 VALUES
				 ('old-resolved', 'review', 'task-1', 'episode-resolved', 0, 'resolved',
				  '2026-07-27T00:00:01.000Z', '2026-07-27T00:00:02.000Z', 'done')`,
			).run();
			db.prepare(
				`INSERT INTO obligations
				 (id, kind, target_task_id, root_episode_id, parent_obligation_id, depth,
				  state, opened_at)
				 VALUES
				 ('old-child', 'notify', 'task-1', 'episode-root', 'old-open', 1,
				  'open', '2026-07-27T00:00:03.000Z')`,
			).run();

			expect(runMigrations(db, MIGRATIONS.slice(1, 2)).applied).toEqual([
				"0002-obligations-rebuild",
			]);
			const rows = db
				.prepare("SELECT * FROM obligations ORDER BY id")
				.all() as Record<string, unknown>[];

			expect(rows).toHaveLength(3);
			for (const row of rows) {
				expect(row.target_kind).toBe("task");
				expect(row.target_task_id).toBe("task-1");
				expect(row.target_agent_id).toBeNull();
				expect(row.notify_recipient_agent_id).toBeNull();
				expect(row.last_enqueued_tier).toBe(0);
				expect(row.suppressed_tier).toBeNull();
				expect(row.last_notified_tier).toBe(0);
			}
			expect(rows.find((row) => row.id === "old-open")).toMatchObject({
				target_attempt_generation: 2,
				root_episode_id: "episode-root",
				episode_key: "episode-open",
				state: "open",
			});
			expect(rows.find((row) => row.id === "old-resolved")).toMatchObject({
				state: "resolved",
				resolved_at: "2026-07-27T00:00:02.000Z",
				resolution: "done",
			});
			expect(rows.find((row) => row.id === "old-child")).toMatchObject({
				parent_obligation_id: "old-open",
				depth: 1,
			});
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		} finally {
			db.close();
		}
	});

	it("accepts agent targets, rejects zero or two targets, and reroutes notification independently", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 2));
			insertTask(db, "task-1");
			insertFinalObligation(db, {
				id: "agent-obligation",
				targetKind: "agent",
				targetAgentId: "runner-1",
			});
			expect(() =>
				insertFinalObligation(db, {
					id: "zero-targets",
					targetKind: "task",
				}),
			).toThrow();
			expect(() =>
				insertFinalObligation(db, {
					id: "two-targets",
					targetKind: "agent",
					targetTaskId: "task-1",
					targetAgentId: "runner-1",
				}),
			).toThrow();

			db.prepare(
				"UPDATE obligations SET notify_recipient_agent_id = ? WHERE id = ?",
			).run("lead-2", "agent-obligation");
			expect(
				db
					.prepare(
						"SELECT target_agent_id, notify_recipient_agent_id FROM obligations WHERE id = ?",
					)
					.get("agent-obligation"),
			).toEqual({
				target_agent_id: "runner-1",
				notify_recipient_agent_id: "lead-2",
			});
		} finally {
			db.close();
		}
	});

	it("tombstones only task-target obligations when a task becomes terminal", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 2));
			insertTask(db, "task-1", "running");
			insertFinalObligation(db, {
				id: "task-target",
				targetKind: "task",
				targetTaskId: "task-1",
			});
			insertFinalObligation(db, {
				id: "agent-target",
				targetKind: "agent",
				targetAgentId: "runner-1",
			});

			db.prepare("UPDATE tasks SET state = 'done' WHERE id = 'task-1'").run();

			expect(
				db.prepare("SELECT id, state FROM obligations ORDER BY id").all(),
			).toEqual([
				{ id: "agent-target", state: "open" },
				{ id: "task-target", state: "tombstoned" },
			]);
		} finally {
			db.close();
		}
	});

	it("enforces one open episode while allowing a replacement after resolution", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 2));
			insertFinalObligation(db, {
				id: "episode-1",
				targetKind: "agent",
				targetAgentId: "runner-1",
				episodeKey: "runner-1:mailbox",
			});
			expect(() =>
				insertFinalObligation(db, {
					id: "episode-2",
					targetKind: "agent",
					targetAgentId: "runner-1",
					episodeKey: "runner-1:mailbox",
				}),
			).toThrow();
			db.prepare(
				"UPDATE obligations SET state='resolved', resolved_at=? WHERE id='episode-1'",
			).run("2026-07-27T00:01:00.000Z");
			insertFinalObligation(db, {
				id: "episode-2",
				targetKind: "agent",
				targetAgentId: "runner-1",
				episodeKey: "runner-1:mailbox",
			});
		} finally {
			db.close();
		}
	});

	it("rejects depth two and hierarchy mutation bypasses", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 2));
			insertFinalObligation(db, {
				id: "root",
				targetKind: "agent",
				targetAgentId: "runner-1",
				rootEpisodeId: "root-episode",
			});
			insertFinalObligation(db, {
				id: "child",
				targetKind: "agent",
				targetAgentId: "runner-1",
				parentId: "root",
				depth: 1,
				rootEpisodeId: "root-episode",
			});
			expect(() =>
				insertFinalObligation(db, {
					id: "grandchild",
					targetKind: "agent",
					targetAgentId: "runner-1",
					parentId: "child",
					depth: 1,
					rootEpisodeId: "root-episode",
				}),
			).toThrow();
			expect(() =>
				db
					.prepare(
						"UPDATE obligations SET parent_obligation_id='child', depth=1 WHERE id='root'",
					)
					.run(),
			).toThrow();
			expect(() =>
				db
					.prepare(
						"UPDATE obligations SET root_episode_id='other' WHERE id='child'",
					)
					.run(),
			).toThrow();
		} finally {
			db.close();
		}
	});
});
