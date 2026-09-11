import { mkdirSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { commDbPathForProject } from "../commdb-path.js";
import { createBridgeApp } from "../plugin.js";
import { RunnerAdmissionController } from "../runner-admission.js";

const teardown = vi.hoisted(() => ({
	reap: vi.fn(),
	kill: vi.fn(),
	mcp: vi.fn(async () => {}),
	cmux: vi.fn(async () => {}),
}));
vi.mock("../codex-daemon-teardown.js", () => ({
	reapCodexDaemonForSession: teardown.reap,
}));
vi.mock("../runner-teardown.js", () => ({ reapRunnerMcp: teardown.mcp }));
vi.mock("../tmux-lookup.js", async (original) => ({
	...(await original<typeof import("../tmux-lookup.js")>()),
	killTmuxWindow: teardown.kill,
	killCmuxLinkedSession: teardown.cmux,
}));

describe("FLY-2498 real close-tmux route", () => {
	let store: StateStore;
	let db: CommDB;
	const exec = "fly2498-dead-design";
	const target = "runner-flywheel:@2498";
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const path = commDbPathForProject("flywheel");
		mkdirSync(dirname(path), { recursive: true });
		db = new CommDB(path);
		db.registerSession(exec, target, "flywheel", "issue-2498", "lead-a");
		db.upsertDeclaredState(
			exec,
			"parked",
			"design handed off",
			Date.now(),
			null,
		);
		db.insertQuestion(exec, "lead-a", "aged question");
		(db as unknown as { db: { exec(sql: string): void } }).db.exec(
			"UPDATE mailbox SET created_at = datetime('now', '-16 minutes')",
		);
		store.upsertSession({
			execution_id: exec,
			issue_id: "issue-2498",
			issue_identifier: "FLY-2498",
			project_name: "flywheel",
			status: "completed",
			adapter_type: "codex-tmux",
			started_at: new Date().toISOString(),
			last_activity_at: new Date().toISOString(),
		});
		teardown.reap.mockReset().mockResolvedValue({ outcome: "absent" });
		teardown.kill.mockReset().mockResolvedValue({ killed: true });
	});
	afterEach(() => {
		db.close();
		store.close();
		vi.restoreAllMocks();
	});
	async function post() {
		const app = createBridgeApp(store, [], {
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			apiToken: "test-token",
			notificationChannel: "test",
			defaultLeadAgentId: "lead-a",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
			runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		});
		const server = http.createServer(app);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		try {
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("missing address");
			const response = await fetch(
				`http://127.0.0.1:${address.port}/api/sessions/${exec}/close-tmux`,
				{
					method: "POST",
					headers: {
						authorization: "Bearer test-token",
						"content-type": "application/json",
					},
					body: "{}",
				},
			);
			return { status: response.status, body: await response.json() };
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	}
	it("removes the dead parked identity and records real ask disposition", async () => {
		expect(await post()).toMatchObject({
			status: 200,
			body: { closed: true, commDbFinalized: true },
		});
		expect(db.getSession(exec)).toBeUndefined();
		expect(store.getEventsByExecution(exec)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event_type: "commdb_ask_disposed",
					source: "bridge.close-tmux",
				}),
				expect.objectContaining({
					event_type: "tmux_closed",
					source: "bridge.close-tmux",
				}),
			]),
		);
	});
	it.each(["residual", "unverifiable"])(
		"keeps identity when daemon is %s",
		async (outcome) => {
			teardown.reap.mockResolvedValue({ outcome });
			expect(await post()).toMatchObject({
				status: 200,
				body: { closed: true, commDbFinalized: false },
			});
			expect(db.getSession(exec)?.status).toBe("running");
			expect(store.getEventsByExecution(exec)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ event_type: "commdb_finalize_skipped" }),
				]),
			);
		},
	);
	it("keeps identity if window kill fails", async () => {
		teardown.kill.mockResolvedValue({ killed: false, error: "kill failed" });
		expect(await post()).toMatchObject({
			body: { closed: false, error: "kill failed", commDbFinalized: false },
		});
		expect(db.getSession(exec)).toBeDefined();
	});
	it("retains the existing awaiting_review guard", async () => {
		store.upsertSession({
			...store.getSession(exec)!,
			status: "awaiting_review",
		});
		expect(await post()).toMatchObject({ status: 409 });
		expect(teardown.reap).not.toHaveBeenCalled();
		expect(db.getSession(exec)).toBeDefined();
	});
	it("retains the no-target response", async () => {
		db.finalizeSession(exec);
		expect(await post()).toMatchObject({
			status: 200,
			body: { closed: false, reason: "No tmux target found" },
		});
		expect(teardown.kill).not.toHaveBeenCalled();
	});
	it("keeps a successful cleanup result if audit storage throws", async () => {
		vi.spyOn(store, "recordCommDbFinalizeOutcome").mockImplementation(() => {
			throw new Error("audit failed");
		});
		expect(await post()).toMatchObject({
			status: 200,
			body: { closed: true, commDbFinalized: true },
		});
		expect(db.getSession(exec)).toBeUndefined();
	});
});
