import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

it("keeps the latest note per project, issue and role without inventing missing notes", async () => {
	const store = await StateStore.create(":memory:");
	try {
		const input = {
			projectName: "example",
			issueUuid: "issue-1",
			role: "engineering",
			text: "验证中",
			writtenAt: "2026-09-09T12:00:00.000Z",
		};
		expect(store.getLeadNotes("example", ["issue-1"])).toEqual([]);
		store.setLeadNote(input);
		store.setLeadNote({ ...input, role: "product" });
		store.setLeadNote({ ...input, projectName: "other" });
		store.setLeadNote({
			...input,
			text: "验证完成",
			writtenAt: "2026-09-10T12:00:00.000Z",
		});
		expect(store.getLeadNote("example", "issue-1", "engineering")).toEqual({
			issue_uuid: "issue-1",
			role: "engineering",
			text: "验证完成",
			written_at: "2026-09-10T12:00:00.000Z",
		});
		expect(
			store.getLeadNotes("example", ["issue-1"]).map((note) => note.role),
		).toEqual(["engineering", "product"]);
		expect(store.clearLeadNote("example", "issue-1", "engineering")).toBe(true);
		expect(store.clearLeadNote("example", "issue-1", "engineering")).toBe(
			false,
		);
		expect(
			store.getLeadNote("example", "issue-1", "engineering"),
		).toBeUndefined();
		expect(store.getLeadNotes("other", ["issue-1"])).toHaveLength(1);
		expect(store.getLeadNotes("example", ["issue-1"])).toHaveLength(1);
	} finally {
		store.close();
	}
});

it("migrates an empty table, preserves exact bytes over reopen and keeps reads migration-free", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lead-note-"));
	const path = join(dir, "fixture.db");
	let store = await StateStore.create(path);
	try {
		const db = new BetterSqlite3(path);
		expect(
			db
				.prepare("PRAGMA table_info(lead_note)")
				.all()
				.map((row) => (row as { name: string }).name),
		).toEqual(["project_name", "issue_uuid", "role", "text", "written_at"]);
		expect(store.getLeadNotes("example", ["one"])).toEqual([]);
		const input = {
			projectName: "example",
			issueUuid: "one' OR 1=1 --",
			role: "工程 Lead",
			text: "引用 ' 保留；<b>纯文本</b>",
			writtenAt: "2026-09-09T12:00:00.123Z",
		};
		store.setLeadNote(input);
		const before = store.getLeadNote(
			input.projectName,
			input.issueUuid,
			input.role,
		);
		store.close();
		store = await StateStore.create(path);
		expect(
			store.getLeadNote(input.projectName, input.issueUuid, input.role),
		).toEqual(before);
		expect(
			store.getLeadNotes(
				"example",
				Array.from({ length: 405 }, (_, i) =>
					i === 404 ? input.issueUuid : `absent-${i}`,
				),
			),
		).toEqual([before]);
		expect(
			store.getLeadNotes("example", [input.issueUuid, input.issueUuid]),
		).toEqual([before]);
		expect(store.clearLeadNote("example", "one", input.role)).toBe(false);
		db.exec(
			"CREATE TRIGGER refuse_note BEFORE INSERT ON lead_note BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END",
		);
		expect(() => store.setLeadNote({ ...input, text: "失败写入" })).toThrow(
			"fixture_failure",
		);
		expect(
			store.getLeadNote(input.projectName, input.issueUuid, input.role),
		).toEqual(before);
		db.exec("DROP TRIGGER refuse_note; DROP TABLE lead_note");
		store.close();
		store = await StateStore.openForMaintenance(path, { readonly: true });
		expect(() => store.getLeadNotes("example", ["one"])).toThrow(
			"no such table",
		);
		expect(
			db
				.prepare("SELECT name FROM sqlite_master WHERE name = 'lead_note'")
				.all(),
		).toEqual([]);
		db.close();
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
