import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CommDB } from "../db.js";

it("pages terminal sessions within exact project and lead scope using stable execution keys", () => {
	const root = mkdtempSync(join(tmpdir(), "terminal-page-")),
		db = new CommDB(join(root, "comm.db"), true);
	try {
		db.registerSession("a", "fixture:0", "project", "FLY-1", "eng");
		db.registerSession("b", "fixture:1", "project", "FLY-2", "other");
		db.registerSession("c", "fixture:2", "project", "FLY-3", "eng");
		db.registerSession("d", "fixture:3", "foreign", "FLY-4", "eng");
		db.registerSession("e", "fixture:4", "project", "FLY-5");
		expect(
			db
				.listLeadTerminalSessions("project", "eng", "", 1)
				.map((s) => s.execution_id),
		).toEqual(["a"]);
		expect(
			db
				.listLeadTerminalSessions("project", "eng", "a", 100)
				.map((s) => s.execution_id),
		).toEqual(["c", "e"]);
		expect(
			db.listLeadTerminalSessions("project' OR 1=1 --", "eng", "", 100),
		).toEqual([]);
		expect(() =>
			db.listLeadTerminalSessions("project", "eng", "", 101),
		).toThrow("terminal_page_invalid");
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
