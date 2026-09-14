import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { readEpicReportPublications } from "../bridge/report-epic-publications.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it("reads reserved stable identities without changing the publication database", () => {
	const dir = mkdtempSync(join(tmpdir(), "epic-identities-"));
	dirs.push(dir);
	const path = join(dir, "teamlead.db");
	const db = new Database(path);
	db.exec(
		"CREATE TABLE epic_page_publication (project_name TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, first_published_at TEXT, last_published_at TEXT, last_version INTEGER)",
	);
	db.prepare(
		"INSERT INTO epic_page_publication(project_name,token) VALUES (?,?)",
	).run("p", "a".repeat(32));
	db.close();
	const before = readFileSync(path);
	expect(readEpicReportPublications(path)).toEqual([
		{ projectName: "p", token: "a".repeat(32) },
	]);
	expect(readFileSync(path)).toEqual(before);
});
it("accepts a pre-Epic schema but refuses missing or malformed authority", () => {
	const dir = mkdtempSync(join(tmpdir(), "epic-identities-"));
	dirs.push(dir);
	const path = join(dir, "teamlead.db");
	expect(() => readEpicReportPublications(path)).toThrow(
		"metadata unavailable",
	);
	const db = new Database(path);
	db.exec("CREATE TABLE sessions (id TEXT)");
	db.close();
	expect(readEpicReportPublications(path)).toEqual([]);
	const invalid = new Database(path);
	invalid.exec(
		"CREATE TABLE epic_page_publication (project_name TEXT, token TEXT)",
	);
	invalid
		.prepare("INSERT INTO epic_page_publication VALUES (?,?)")
		.run("p", "invalid");
	invalid.close();
	expect(() => readEpicReportPublications(path)).toThrow(
		"metadata unavailable",
	);
});
