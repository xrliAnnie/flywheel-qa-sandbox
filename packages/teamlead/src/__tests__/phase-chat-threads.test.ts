/**
 * FLY-793 (Step 11): the Hybrid per-phase chat-thread side-table.
 *
 * A three-stage issue has ONE Design/Implement/QA thread per role. The existing
 * `chat_threads` table (UNIQUE issue+channel) allows only one row per issue, so
 * phase threads live in a NEW `phase_chat_threads` side-table. The Hybrid
 * guarantee: the `main` path is BYTE-UNCHANGED (every existing caller passes no
 * role → 'main' → existing 1:1 behavior), and only explicit phase roles reach the
 * side-table.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeChatThreadRole, StateStore } from "../StateStore.js";

describe("FLY-793 phase_chat_threads (Step 11, Hybrid)", () => {
	let dir: string;
	let store: StateStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly793-threads-"));
		store = await StateStore.create(join(dir, "teamlead.db"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	describe("normalizeChatThreadRole", () => {
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

	describe("byte-compat: main role → chat_threads (unchanged)", () => {
		it("default (no role) upserts + reads the main thread", () => {
			store.upsertChatThread("t-main", "chan-1", "FLY-793", "lead-a");
			const got = store.getChatThreadByIssue("FLY-793", "chan-1");
			expect(got?.thread_id).toBe("t-main");
			expect(got?.session_role).toBe("main");
		});
		it("a second main upsert on the same issue+channel replaces (1:1)", () => {
			store.upsertChatThread("t-main-1", "chan-1", "FLY-793");
			store.upsertChatThread("t-main-2", "chan-1", "FLY-793");
			const got = store.getChatThreadByIssue("FLY-793", "chan-1");
			expect(got?.thread_id).toBe("t-main-2");
			// old row is gone (delete-stale)
			expect(store.getChatThreadByThreadId("t-main-1")).toBeUndefined();
		});
	});

	describe("side-table: one thread per phase role", () => {
		it("design / implement / qa each get their own thread, all coexisting", () => {
			store.upsertChatThread("t-design", "chan-1", "FLY-793", "lead", "design");
			store.upsertChatThread(
				"t-impl",
				"chan-1",
				"FLY-793",
				"lead",
				"implement",
			);
			store.upsertChatThread("t-qa", "chan-1", "FLY-793", "lead", "qa");

			expect(
				store.getChatThreadByIssue("FLY-793", "chan-1", "design")?.thread_id,
			).toBe("t-design");
			expect(
				store.getChatThreadByIssue("FLY-793", "chan-1", "implement")?.thread_id,
			).toBe("t-impl");
			expect(
				store.getChatThreadByIssue("FLY-793", "chan-1", "qa")?.thread_id,
			).toBe("t-qa");
		});

		it("creating the Implement thread does NOT delete the sibling Design thread", () => {
			store.upsertChatThread("t-design", "chan-1", "FLY-793", "lead", "design");
			store.upsertChatThread(
				"t-impl",
				"chan-1",
				"FLY-793",
				"lead",
				"implement",
			);
			// design survives
			expect(
				store.getChatThreadByIssue("FLY-793", "chan-1", "design")?.thread_id,
			).toBe("t-design");
		});

		it("a phase thread and the main thread coexist for the SAME issue", () => {
			store.upsertChatThread("t-main", "chan-1", "FLY-793");
			store.upsertChatThread("t-design", "chan-1", "FLY-793", "lead", "design");
			expect(store.getChatThreadByIssue("FLY-793", "chan-1")?.thread_id).toBe(
				"t-main",
			);
			expect(
				store.getChatThreadByIssue("FLY-793", "chan-1", "design")?.thread_id,
			).toBe("t-design");
		});

		it("re-upserting a phase role replaces only that role's thread", () => {
			store.upsertChatThread(
				"t-design-1",
				"chan-1",
				"FLY-793",
				"lead",
				"design",
			);
			store.upsertChatThread(
				"t-design-2",
				"chan-1",
				"FLY-793",
				"lead",
				"design",
			);
			expect(
				store.getChatThreadByIssue("FLY-793", "chan-1", "design")?.thread_id,
			).toBe("t-design-2");
			expect(store.getChatThreadByThreadId("t-design-1")).toBeUndefined();
		});
	});

	describe("getChatThreadByThreadId spans both tables + echoes role", () => {
		it("finds a main thread with session_role='main'", () => {
			store.upsertChatThread("t-main", "chan-1", "FLY-793");
			expect(store.getChatThreadByThreadId("t-main")).toMatchObject({
				thread_id: "t-main",
				issue_id: "FLY-793",
				session_role: "main",
			});
		});
		it("finds a phase thread with its session_role", () => {
			store.upsertChatThread("t-qa", "chan-1", "FLY-793", "lead", "qa");
			expect(store.getChatThreadByThreadId("t-qa")).toMatchObject({
				thread_id: "t-qa",
				issue_id: "FLY-793",
				session_role: "qa",
			});
		});
	});

	describe("markMissing / markArchived reach the phase table", () => {
		it("markChatThreadMissing hides a phase thread from getChatThreadByIssue", () => {
			store.upsertChatThread("t-design", "chan-1", "FLY-793", "lead", "design");
			store.markChatThreadMissing("t-design");
			expect(
				store.getChatThreadByIssue("FLY-793", "chan-1", "design"),
			).toBeUndefined();
		});
		it("markChatThreadArchived stamps a phase thread's archived_at", () => {
			store.upsertChatThread(
				"t-impl",
				"chan-1",
				"FLY-793",
				"lead",
				"implement",
			);
			store.markChatThreadArchived("t-impl");
			expect(
				store.getChatThreadByIssue("FLY-793", "chan-1", "implement")
					?.archived_at,
			).not.toBeNull();
		});
	});

	describe("attach-pin is role-scoped", () => {
		it("a design attach-pin does not leak into the qa thread", () => {
			store.upsertChatThread("t-design", "chan-1", "FLY-793", "lead", "design");
			store.upsertChatThread("t-qa", "chan-1", "FLY-793", "lead", "qa");
			store.setChatThreadAttachPin(
				"FLY-793",
				"chan-1",
				{ messageId: "m1", command: "tmux attach", pinnedAt: "2026-07-03" },
				"design",
			);
			expect(
				store.getChatThreadAttachPin("FLY-793", "chan-1", "design")?.messageId,
			).toBe("m1");
			expect(
				store.getChatThreadAttachPin("FLY-793", "chan-1", "qa"),
			).toBeUndefined();
		});
	});

	describe("persisted sessions.chat_thread_role round-trips", () => {
		it("defaults to 'main' when unset, and stores an explicit phase role", () => {
			store.upsertSession({
				execution_id: "e-main",
				issue_id: "FLY-793",
				project_name: "flywheel",
				status: "running",
			});
			expect(store.getSession("e-main")?.chat_thread_role).toBe("main");

			store.upsertSession({
				execution_id: "e-design",
				issue_id: "FLY-793",
				project_name: "flywheel",
				status: "running",
				chat_thread_role: "design",
			});
			expect(store.getSession("e-design")?.chat_thread_role).toBe("design");
		});
	});
});
