import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createLeadTerminalCore } from "../lead-capability-terminal-core.js";

async function fixture() {
	const home = mkdtempSync(join(tmpdir(), "bridge-terminal-core-"));
	const commDbPath = join(home, "comm.db"),
		db = new CommDB(commDbPath, true);
	const store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "exec-a",
		project_name: "project",
		issue_id: "issue-a",
		issue_identifier: "FLY-1",
		status: "running",
	});
	db.registerSession("exec-a", "runner:0", "project", "FLY-1", "eng");
	const assertCurrent = vi.fn(),
		authorizeIssue = vi.fn(async () => assertCurrent);
	const inspect = vi.fn(async () => ({
		observedSessionId: "$2:%3",
		alive: true,
	}));
	const capture = vi.fn(async () => "Proceed? [Y/n]"),
		send = vi.fn(
			async (_target: string, _text: string, guard: () => Promise<void>) => {
				await guard();
			},
		);
	const core = createLeadTerminalCore({
		projectName: "project",
		leadId: "eng",
		commDbPath,
		store,
		assertCurrent,
		authorizeIssue,
		inspect,
		capture,
		send,
	});
	return {
		core,
		db,
		store,
		authorizeIssue,
		inspect,
		capture,
		send,
		async close() {
			db.close();
			await store.close();
			rmSync(home, { recursive: true, force: true });
		},
	};
}
it("resolves a current issue and real CommDB terminal binding before observing", async () => {
	const f = await fixture();
	try {
		expect(await f.core.status("exec-a")).toMatchObject({
			status: "waiting",
			observedSessionId: "$2:%3",
		});
		expect(f.authorizeIssue).toHaveBeenCalledWith("issue-a");
		expect(f.capture).toHaveBeenCalledWith("%3", 30);
		await f.core.input("exec-a", "$2:%3", "yes");
		expect(f.send).toHaveBeenCalledTimes(1);
	} finally {
		await f.close();
	}
});
it("rejects inconsistent cross-database issue bindings before tmux access", async () => {
	const f = await fixture();
	try {
		f.store.upsertSession({
			execution_id: "exec-a",
			project_name: "project",
			issue_id: "other",
			issue_identifier: "FLY-2",
			status: "running",
		});
		await expect(f.core.capture("exec-a", 20)).rejects.toThrow(
			"terminal_scope_denied",
		);
		expect(f.inspect).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});
it("rejects scope loss while issue authorization is pending", async () => {
	const f = await fixture();
	try {
		f.authorizeIssue.mockImplementation(async () => {
			f.store.upsertSession({
				execution_id: "exec-a",
				project_name: "foreign",
				issue_id: "issue-a",
				issue_identifier: "FLY-1",
				status: "running",
			});
			return () => {};
		});
		await expect(f.core.status("exec-a")).rejects.toThrow(
			"terminal_session_changed",
		);
		expect(f.inspect).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});
it("rejects a terminal rebound during capture and never sends input to a stale pane", async () => {
	const f = await fixture();
	try {
		f.capture.mockImplementation(async () => {
			f.db.registerSession(
				"exec-a",
				"replacement:0",
				"project",
				"FLY-1",
				"eng",
			);
			return "Proceed? [Y/n]";
		});
		await expect(f.core.input("exec-a", "$2:%3", "yes")).rejects.toThrow(
			"terminal_session_changed",
		);
		expect(f.send).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});
it("rejects a canonical issue rebind even if the new issue is also authorized", async () => {
	const f = await fixture();
	try {
		f.inspect.mockImplementation(async () => {
			f.store.upsertSession({
				execution_id: "exec-a",
				project_name: "project",
				issue_id: "issue-b",
				issue_identifier: "FLY-1",
				status: "running",
			});
			return { observedSessionId: "$2:%3", alive: true };
		});
		await expect(f.core.status("exec-a")).rejects.toThrow(
			"terminal_session_changed",
		);
		expect(f.capture).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});
it("uses read-only CommDB opens and closes every acquired handle", async () => {
	const f = await fixture(),
		open = vi.spyOn(CommDB, "openReadonly");
	try {
		await f.core.status("exec-a");
		expect(open).toHaveBeenCalled();
		for (const result of open.mock.results) {
			expect(() => result.value.getSession("exec-a")).toThrow();
		}
	} finally {
		open.mockRestore();
		await f.close();
	}
});
