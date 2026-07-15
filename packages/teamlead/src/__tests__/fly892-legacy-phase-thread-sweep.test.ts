/**
 * FLY-892 Step 5: boot sweep for legacy FLY-793 per-phase side-table threads.
 * FAIL-CLOSED (Codex R1 #1): never archive a phase thread that is an issue's only
 * visible Discord face.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileLegacyPhaseThreads } from "../bridge/legacy-phase-thread-sweep.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import { StateStore } from "../StateStore.js";

function rawDb(store: StateStore): {
	run(sql: string, params?: unknown[]): void;
} {
	return (
		store as unknown as { db: { run(sql: string, params?: unknown[]): void } }
	).db;
}
function seedPhaseThread(
	store: StateStore,
	row: {
		threadId: string;
		channelId: string;
		issueId: string;
		role: string;
		leadId?: string;
	},
): void {
	rawDb(store).run(
		`INSERT INTO phase_chat_threads (thread_id, channel_id, issue_id, session_role, lead_id)
		 VALUES (?, ?, ?, ?, ?)`,
		[
			row.threadId,
			row.channelId,
			row.issueId,
			row.role,
			row.leadId ?? "lead-1",
		],
	);
}

const CH = "chan-1";
const projects: ProjectEntry[] = [
	{
		projectName: "proj",
		projectRoot: "/x",
		leads: [
			{
				agentId: "lead-1",
				chatChannel: CH,
				botToken: "lead-bot",
				match: { labels: ["engineer"] },
			},
		],
	} as ProjectEntry,
];

function seedSession(store: StateStore, over: Partial<Session>): void {
	store.upsertSession({
		execution_id: `e-${over.issue_id}-${over.status}`,
		project_name: "proj",
		status: "running",
		issue_labels: JSON.stringify(["engineer"]),
		...over,
	} as Session);
}

describe("reconcileLegacyPhaseThreads (FLY-892 Step 5)", () => {
	let store: StateStore;
	let posted: Array<{ url: string; token: string; body: string }>;
	let archived: string[];
	let fetchImpl: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		posted = [];
		archived = [];
		fetchImpl = vi.fn(
			async (
				url: string,
				init: { headers?: Record<string, string>; body?: string },
			) => {
				posted.push({
					url,
					token: init.headers?.Authorization ?? "",
					body: init.body ?? "",
				});
				return {
					ok: true,
					status: 200,
					json: () => Promise.resolve({ id: "m" }),
				};
			},
		);
	});
	afterEach(() => store.close());

	const archiveFn = vi.fn(async (threadId: string) => {
		archived.push(threadId);
		return { archived: true, attempts: 1, reason: "archived" as const };
	});

	it("has a main thread → posts pointer + archives the phase thread", async () => {
		store.upsertChatThread("t-main", CH, "FLY-880", "lead-1");
		seedSession(store, { issue_id: "FLY-880", status: "completed" });
		seedPhaseThread(store, {
			threadId: "t-design",
			channelId: CH,
			issueId: "FLY-880",
			role: "design",
		});

		const r = await reconcileLegacyPhaseThreads({
			store,
			projects,
			fetchImpl,
			archiveFn,
		});
		expect(r.archived).toBe(1);
		expect(archived).toEqual(["t-design"]);
		expect(JSON.parse(posted[0]?.body ?? "{}").content).toMatch(/^🤖\[自动\] /);
		expect(posted[0]?.body).toContain("<#t-main>"); // pointer to main thread
		expect(posted[0]?.token).toBe("Bot lead-bot"); // no announcer → lead bot
		// idempotent: archived row drops out → second run is a no-op
		archived.length = 0;
		posted.length = 0;
		const r2 = await reconcileLegacyPhaseThreads({
			store,
			projects,
			fetchImpl,
			archiveFn,
		});
		expect(r2.processed).toBe(0);
	});

	it("FAIL-CLOSED: no main + ACTIVE session → skipped_no_main, NOT archived", async () => {
		// A three-stage phase session sets BOTH session_role (dispatch) and
		// chat_thread_role; getActivePhaseSessionForIssue keys on session_role.
		seedSession(store, {
			issue_id: "FLY-887",
			status: "running",
			session_role: "implement",
			chat_thread_role: "implement",
		});
		seedPhaseThread(store, {
			threadId: "t-impl",
			channelId: CH,
			issueId: "FLY-887",
			role: "implement",
		});

		const r = await reconcileLegacyPhaseThreads({
			store,
			projects,
			fetchImpl,
			archiveFn,
		});
		expect(r.skipped).toBe(1);
		expect(r.archived).toBe(0);
		expect(archived).toEqual([]);
	});

	it("FAIL-CLOSED covers awaiting_review / design_done / pending+worktree (all skipped)", async () => {
		for (const [issue, status, extra] of [
			["FLY-A", "awaiting_review", { session_role: "design" }],
			["FLY-B", "design_done", { session_role: "design" }],
			// pending+worktree is protected regardless of role (getActivePhaseSessionForIssue)
			["FLY-C", "pending", { worktree_path: "/w" }],
		] as const) {
			seedSession(store, {
				issue_id: issue,
				status,
				chat_thread_role: "design",
				...extra,
			});
			seedPhaseThread(store, {
				threadId: `t-${issue}`,
				channelId: CH,
				issueId: issue,
				role: "design",
			});
		}
		const r = await reconcileLegacyPhaseThreads({
			store,
			projects,
			fetchImpl,
			archiveFn,
		});
		expect(r.skipped).toBe(3);
		expect(r.archived).toBe(0);
	});

	it("no main + TERMINAL session → archives (issue finished)", async () => {
		seedSession(store, {
			issue_id: "FLY-882",
			status: "completed",
			chat_thread_role: "qa",
		});
		seedPhaseThread(store, {
			threadId: "t-qa",
			channelId: CH,
			issueId: "FLY-882",
			role: "qa",
		});

		const r = await reconcileLegacyPhaseThreads({
			store,
			projects,
			fetchImpl,
			archiveFn,
		});
		expect(r.archived).toBe(1);
		expect(archived).toEqual(["t-qa"]);
		expect(posted).toHaveLength(0); // no main → no pointer, just archive
	});

	it("uses the announcer bot token for the pointer when configured", async () => {
		const withAnnouncer: ProjectEntry[] = [
			{ ...projects[0]!, announcerBotToken: "announcer-bot" } as ProjectEntry,
		];
		store.upsertChatThread("t-main", CH, "FLY-883", "lead-1");
		seedSession(store, { issue_id: "FLY-883", status: "completed" });
		seedPhaseThread(store, {
			threadId: "t-d",
			channelId: CH,
			issueId: "FLY-883",
			role: "design",
		});

		await reconcileLegacyPhaseThreads({
			store,
			projects: withAnnouncer,
			fetchImpl,
			archiveFn,
		});
		expect(posted[0]?.token).toBe("Bot announcer-bot");
	});

	it("a single-row failure does not abort the sweep", async () => {
		store.upsertChatThread("t-main1", CH, "FLY-890", "lead-1");
		store.upsertChatThread("t-main2", CH, "FLY-891", "lead-1");
		seedSession(store, { issue_id: "FLY-890", status: "completed" });
		seedSession(store, { issue_id: "FLY-891", status: "completed" });
		seedPhaseThread(store, {
			threadId: "t-bad",
			channelId: CH,
			issueId: "FLY-890",
			role: "design",
		});
		seedPhaseThread(store, {
			threadId: "t-good",
			channelId: CH,
			issueId: "FLY-891",
			role: "design",
		});

		const failingArchive = vi.fn(async (threadId: string) => {
			if (threadId === "t-bad") throw new Error("boom");
			archived.push(threadId);
			return { archived: true, attempts: 1, reason: "archived" as const };
		});
		const r = await reconcileLegacyPhaseThreads({
			store,
			projects,
			fetchImpl,
			archiveFn: failingArchive,
		});
		expect(r.failed).toBe(1);
		expect(archived).toContain("t-good"); // the other row still processed
	});
});
