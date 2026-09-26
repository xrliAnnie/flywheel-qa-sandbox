/**
 * FLY-892 (converge): one issue = one thread.
 *
 * FLY-793 (Step 11) split a three-stage issue into three threads via a
 * `phase_chat_threads` side-table keyed on `(issue, channel, session_role)`.
 * FLY-892 converges thread resolution back to a single `(issue, channel)` row in
 * `chat_threads`: every caller — a Lead `/send`, and a design/implement/qa phase
 * session — resolves the SAME thread. The side-table is now READ-ONLY legacy:
 *   - nothing WRITES it (upsertChatThread / attach-pin no longer route by role);
 *   - existing rows are still reverse-lookup-able + archivable (boot sweep);
 *   - `getUnarchivedPhaseChatThreads()` exposes them to the sweep.
 *
 * The `sessions.chat_thread_role` phase MARKER is untouched (three-stage identity
 * now rides on the message / pipeline-header, not on a separate thread).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeChatThreadRole, StateStore } from "../StateStore.js";

/** Access the private sql.js handle to seed LEGACY phase rows (nothing in the
 *  post-converge API writes them; they only ever existed from pre-892 code). */
function rawDb(store: StateStore): {
	run(sql: string, params?: unknown[]): void;
} {
	return (
		store as unknown as { db: { run(sql: string, params?: unknown[]): void } }
	).db;
}
function seedLegacyPhaseThread(
	store: StateStore,
	row: {
		threadId: string;
		channelId: string;
		issueId: string;
		role: string;
		leadId?: string;
		archived?: boolean;
		missing?: boolean;
	},
): void {
	rawDb(store).run(
		`INSERT INTO phase_chat_threads
		   (thread_id, channel_id, issue_id, session_role, lead_id, archived_at, discord_missing_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			row.threadId,
			row.channelId,
			row.issueId,
			row.role,
			row.leadId ?? null,
			row.archived ? "2026-07-01" : null,
			row.missing ? "2026-07-01" : null,
		],
	);
}
function countPhaseRows(store: StateStore): number {
	const db = (
		store as unknown as {
			db: { exec(sql: string): Array<{ values: unknown[][] }> };
		}
	).db;
	const res = db.exec("SELECT COUNT(*) FROM phase_chat_threads");
	return Number(res[0]?.values[0]?.[0] ?? 0);
}

describe("FLY-892 one issue = one thread (converge)", () => {
	let dir: string;
	let store: StateStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly892-threads-"));
		store = await StateStore.create(join(dir, "teamlead.db"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	describe("normalizeChatThreadRole (marker semantics retained)", () => {
		it("folds absent / non-phase roles to 'main'", () => {
			expect(normalizeChatThreadRole()).toBe("main");
			expect(normalizeChatThreadRole(undefined)).toBe("main");
			expect(normalizeChatThreadRole(null)).toBe("main");
			expect(normalizeChatThreadRole("main")).toBe("main");
			expect(normalizeChatThreadRole("something-else")).toBe("main");
		});
		it("keeps the three phase roles", () => {
			expect(normalizeChatThreadRole("design")).toBe("design");
			expect(normalizeChatThreadRole("implement")).toBe("implement");
			expect(normalizeChatThreadRole("qa")).toBe("qa");
		});
	});

	describe("(a) every caller resolves the single (issue,channel) main row", () => {
		it("upsert + read the one thread; never touches the phase side-table", () => {
			store.upsertChatThread("t-main", "chan-1", "FLY-892", "lead-a");
			const got = store.getChatThreadByIssue("FLY-892", "chan-1");
			expect(got?.thread_id).toBe("t-main");
			expect(countPhaseRows(store)).toBe(0);
		});
		it("a second upsert on the same issue+channel replaces (1:1)", () => {
			store.upsertChatThread("t-main-1", "chan-1", "FLY-892");
			store.upsertChatThread("t-main-2", "chan-1", "FLY-892");
			expect(store.getChatThreadByIssue("FLY-892", "chan-1")?.thread_id).toBe(
				"t-main-2",
			);
			expect(store.getChatThreadByThreadId("t-main-1")).toBeUndefined();
			expect(countPhaseRows(store)).toBe(0);
		});
		it("the attach-pin lives on the single main thread", () => {
			store.upsertChatThread("t-main", "chan-1", "FLY-892");
			store.setChatThreadAttachPin("FLY-892", "chan-1", {
				messageId: "m1",
				command: "tmux attach",
				pinnedAt: "2026-07-05",
			});
			expect(store.getChatThreadAttachPin("FLY-892", "chan-1")?.messageId).toBe(
				"m1",
			);
			expect(countPhaseRows(store)).toBe(0);
			store.clearChatThreadAttachPin("FLY-892", "chan-1");
			expect(store.getChatThreadAttachPin("FLY-892", "chan-1")).toBeUndefined();
		});
	});

	describe("(b) legacy phase rows stay reverse-lookup-able + archivable", () => {
		it("getChatThreadByThreadId finds a legacy phase thread + echoes its role", () => {
			seedLegacyPhaseThread(store, {
				threadId: "t-qa-legacy",
				channelId: "chan-1",
				issueId: "FLY-887",
				role: "qa",
			});
			expect(store.getChatThreadByThreadId("t-qa-legacy")).toMatchObject({
				thread_id: "t-qa-legacy",
				issue_id: "FLY-887",
				session_role: "qa",
			});
		});
		it("markChatThreadArchived / markChatThreadMissing reach a legacy phase row", () => {
			seedLegacyPhaseThread(store, {
				threadId: "t-impl-legacy",
				channelId: "chan-1",
				issueId: "FLY-887",
				role: "implement",
			});
			store.markChatThreadArchived("t-impl-legacy");
			// archived → drops out of the sweep input set
			expect(store.getUnarchivedPhaseChatThreads()).toHaveLength(0);

			seedLegacyPhaseThread(store, {
				threadId: "t-design-legacy",
				channelId: "chan-1",
				issueId: "FLY-886",
				role: "design",
			});
			store.markChatThreadMissing("t-design-legacy");
			expect(store.getUnarchivedPhaseChatThreads()).toHaveLength(0);
		});
	});

	describe("(c1) getUnarchivedPhaseChatThreads (boot-sweep input)", () => {
		it("returns only unarchived + non-missing legacy phase rows", () => {
			seedLegacyPhaseThread(store, {
				threadId: "t-d",
				channelId: "chan-1",
				issueId: "FLY-880",
				role: "design",
				leadId: "lead-x",
			});
			seedLegacyPhaseThread(store, {
				threadId: "t-i",
				channelId: "chan-1",
				issueId: "FLY-880",
				role: "implement",
			});
			seedLegacyPhaseThread(store, {
				threadId: "t-archived",
				channelId: "chan-1",
				issueId: "FLY-881",
				role: "qa",
				archived: true,
			});
			seedLegacyPhaseThread(store, {
				threadId: "t-missing",
				channelId: "chan-1",
				issueId: "FLY-882",
				role: "qa",
				missing: true,
			});

			const rows = store.getUnarchivedPhaseChatThreads();
			expect(rows.map((r) => r.thread_id).sort()).toEqual(["t-d", "t-i"]);
			const design = rows.find((r) => r.thread_id === "t-d");
			expect(design).toMatchObject({
				channel_id: "chan-1",
				issue_id: "FLY-880",
				session_role: "design",
				lead_id: "lead-x",
			});
		});
		it("is empty when there were never any phase rows (non-three-stage byte-compat)", () => {
			store.upsertChatThread("t-main", "chan-1", "FLY-500");
			expect(store.getUnarchivedPhaseChatThreads()).toHaveLength(0);
		});
	});

	describe("(c2) getLatestPhaseSessionsForIssue (pipeline-header data source)", () => {
		it("returns the latest session per phase role, keyed on chat_thread_role", () => {
			store.upsertSession({
				execution_id: "e-design",
				issue_id: "FLY-892",
				project_name: "flywheel",
				status: "completed",
				chat_thread_role: "design",
				runner_model: "claude-fable-5",
				last_activity_at: "2026-07-05T01:00:00Z",
			});
			store.upsertSession({
				execution_id: "e-impl",
				issue_id: "FLY-892",
				project_name: "flywheel",
				status: "running",
				chat_thread_role: "implement",
				runner_model: "claude-opus-4-8",
				last_activity_at: "2026-07-05T02:00:00Z",
			});
			// a non-phase (main) session on the SAME issue is excluded
			store.upsertSession({
				execution_id: "e-main",
				issue_id: "FLY-892",
				project_name: "flywheel",
				status: "running",
			});

			const rows = store.getLatestPhaseSessionsForIssue("FLY-892");
			expect(rows.map((s) => s.chat_thread_role).sort()).toEqual([
				"design",
				"implement",
			]);
			expect(
				rows.find((s) => s.chat_thread_role === "design")?.runner_model,
			).toBe("claude-fable-5");
		});
		it("returns the MOST RECENT session when a phase has multiple (fix-loop)", () => {
			store.upsertSession({
				execution_id: "e-impl-1",
				issue_id: "FLY-892",
				project_name: "flywheel",
				status: "completed",
				chat_thread_role: "implement",
				last_activity_at: "2026-07-05T01:00:00Z",
			});
			store.upsertSession({
				execution_id: "e-impl-2",
				issue_id: "FLY-892",
				project_name: "flywheel",
				status: "running",
				chat_thread_role: "implement",
				last_activity_at: "2026-07-05T03:00:00Z",
			});
			const rows = store.getLatestPhaseSessionsForIssue("FLY-892");
			expect(rows).toHaveLength(1);
			expect(rows[0]?.execution_id).toBe("e-impl-2");
		});
		it("is empty for an issue with no phase sessions", () => {
			store.upsertSession({
				execution_id: "e-main",
				issue_id: "FLY-500",
				project_name: "flywheel",
				status: "running",
			});
			expect(store.getLatestPhaseSessionsForIssue("FLY-500")).toHaveLength(0);
		});
	});
});
