import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	attributeCodexTurnTrigger,
	type ReadonlySqlite,
} from "../turn-trigger-attribution.js";

const LEAD = "mufasa";
const EXEC_A = "244670e3-1b2c-4d5e-8f90-0123456789ab";
const EXEC_B = "344670e3-1b2c-4d5e-8f90-0123456789ab";
const SENTINEL = "SENTINEL-BODY-5c1e";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Minimal CommDB fixture: only the columns the reader may touch plus the
 * body columns it must never select (seeded with a sentinel). */
function commDb(
	rows: Array<{
		delivery_id: string;
		to_agent?: string;
		source_kind: string | null;
		from_agent: string;
		source_ref?: string | null;
	}>,
	sessions: Array<{ execution_id: string; issue_id: string | null }> = [],
) {
	const dir = mkdtempSync(join(tmpdir(), "fly2882-attr-"));
	dirs.push(dir);
	const path = join(dir, "comm.db");
	const db = new Database(path);
	db.exec(`
		CREATE TABLE mailbox (
			delivery_id TEXT NOT NULL UNIQUE, from_agent TEXT NOT NULL,
			to_agent TEXT NOT NULL, source_kind TEXT, source_ref TEXT,
			content TEXT NOT NULL, delivery_content TEXT
		);
		CREATE TABLE sessions (execution_id TEXT PRIMARY KEY, issue_id TEXT);
	`);
	const insert = db.prepare(
		"INSERT INTO mailbox VALUES (@delivery_id, @from_agent, @to_agent, @source_kind, @source_ref, @content, @delivery_content)",
	);
	for (const row of rows)
		insert.run({
			to_agent: LEAD,
			source_ref: null,
			...row,
			content: SENTINEL,
			delivery_content: SENTINEL,
		});
	for (const s of sessions)
		db.prepare("INSERT INTO sessions VALUES (?, ?)").run(
			s.execution_id,
			s.issue_id,
		);
	db.close();
	return path;
}

function recordingOpen(path: string | undefined) {
	const seen: string[] = [];
	const open = vi.fn((): ReadonlySqlite | undefined => {
		if (!path) return undefined;
		const db = new Database(path, { readonly: true, fileMustExist: true });
		return {
			prepare(sql: string) {
				seen.push(sql);
				return db.prepare(sql);
			},
			close: () => db.close(),
		};
	});
	return { open, seen };
}

function run(
	deliveryIds: string[],
	path: string | undefined,
	sessionKeys: Record<number, string | null> = {},
) {
	const { open, seen } = recordingOpen(path);
	const getLeadEventSessionKeyBySeq = vi.fn(
		(seq: number) => sessionKeys[seq] ?? null,
	);
	const log = vi.fn();
	const trigger = attributeCodexTurnTrigger(
		{ projectName: "flywheel", leadId: LEAD, deliveryIds },
		{ openCommDb: open, getLeadEventSessionKeyBySeq, log },
	);
	return { trigger, seen, open, getLeadEventSessionKeyBySeq, log };
}

describe("attributeCodexTurnTrigger", () => {
	it("maps a runner question to its session's issue", () => {
		const path = commDb(
			[{ delivery_id: "d-1", source_kind: "question", from_agent: EXEC_A }],
			[{ execution_id: EXEC_A, issue_id: "FLY-2830" }],
		);
		expect(run(["d-1"], path).trigger).toEqual({
			kind: "issue",
			issueId: "FLY-2830",
			basis: "codex_journal_members",
		});
	});

	it("maps a Bridge lead_event via the metadata-only session key", () => {
		const path = commDb([
			{
				delivery_id: "d-1",
				source_kind: "lead_event",
				from_agent: "bridge",
				source_ref: "128953",
			},
		]);
		const r = run(["d-1"], path, { 128953: "flywheel:FLY-2830" });
		expect(r.trigger).toMatchObject({ kind: "issue", issueId: "FLY-2830" });
		expect(r.getLeadEventSessionKeyBySeq).toHaveBeenCalledWith(128953);
	});

	it("dedupes several members that all point at the same issue", () => {
		const path = commDb(
			[
				{ delivery_id: "d-1", source_kind: "question", from_agent: EXEC_A },
				{
					delivery_id: "d-2",
					source_kind: "lead_event",
					from_agent: "bridge",
					source_ref: "7",
				},
			],
			[{ execution_id: EXEC_A, issue_id: "FLY-2830" }],
		);
		expect(
			run(["d-1", "d-2"], path, { 7: "flywheel:FLY-2830" }).trigger,
		).toMatchObject({
			kind: "issue",
			issueId: "FLY-2830",
		});
	});

	it("answers multiple_issues when members map to different issues", () => {
		const path = commDb(
			[
				{ delivery_id: "d-1", source_kind: "question", from_agent: EXEC_A },
				{ delivery_id: "d-2", source_kind: "question", from_agent: EXEC_B },
			],
			[
				{ execution_id: EXEC_A, issue_id: "FLY-2830" },
				{ execution_id: EXEC_B, issue_id: "FLY-2831" },
			],
		);
		expect(run(["d-1", "d-2"], path).trigger).toMatchObject({
			kind: "undetermined",
			reason: "multiple_issues",
		});
	});

	it.each([
		[
			"a Discord chat member",
			[
				{
					delivery_id: "d-1",
					source_kind: "discord_chat",
					from_agent: "discord:1524829037825101975",
				},
			],
			{},
		],
		[
			"an unknown source kind",
			[{ delivery_id: "d-1", source_kind: null, from_agent: EXEC_A }],
			{},
		],
		[
			"a question from a non-UUID sender",
			[
				{
					delivery_id: "d-1",
					source_kind: "question",
					from_agent: "flywheel-eng-lead",
				},
			],
			{},
		],
		[
			"a question whose session has no issue",
			[{ delivery_id: "d-1", source_kind: "question", from_agent: EXEC_B }],
			{},
		],
		[
			"a lead_event with a non-numeric source_ref",
			[
				{
					delivery_id: "d-1",
					source_kind: "lead_event",
					from_agent: "bridge",
					source_ref: "12x",
				},
			],
			{},
		],
		[
			"a lead_event whose session key is not project:ISSUE",
			[
				{
					delivery_id: "d-1",
					source_kind: "lead_event",
					from_agent: "bridge",
					source_ref: "9",
				},
			],
			{ 9: "patrol:flywheel-eng-lead" },
		],
		[
			"a member addressed to another Lead",
			[
				{
					delivery_id: "d-1",
					to_agent: "other-lead",
					source_kind: "question",
					from_agent: EXEC_A,
				},
			],
			{},
		],
		["a member row that does not exist", [], {}],
	] as const)("answers unmapped_delivery for %s", (_label, rows, keys) => {
		const path = commDb(
			rows.map((row) => ({ ...row })),
			[
				{ execution_id: EXEC_A, issue_id: "FLY-2830" },
				{ execution_id: EXEC_B, issue_id: null },
			],
		);
		expect(
			run(["d-1"], path, keys as Record<number, string | null>).trigger,
		).toMatchObject({
			kind: "undetermined",
			reason: "unmapped_delivery",
			detail: expect.stringContaining("判断不了"),
		});
	});

	it("answers unmapped_delivery when one of two members is unmapped", () => {
		const path = commDb(
			[
				{ delivery_id: "d-1", source_kind: "question", from_agent: EXEC_A },
				{
					delivery_id: "d-2",
					source_kind: "discord_chat",
					from_agent: "discord:1",
				},
			],
			[{ execution_id: EXEC_A, issue_id: "FLY-2830" }],
		);
		expect(run(["d-1", "d-2"], path).trigger).toMatchObject({
			reason: "unmapped_delivery",
		});
	});

	it("answers attribution_unavailable when the CommDB is missing or unreadable", () => {
		expect(run(["d-1"], undefined).trigger).toMatchObject({
			reason: "attribution_unavailable",
		});
		const dir = mkdtempSync(join(tmpdir(), "fly2882-attr-bad-"));
		dirs.push(dir);
		const bad = join(dir, "comm.db");
		new Database(bad).close();
		const r = run(["d-1"], bad);
		expect(r.trigger).toMatchObject({ reason: "attribution_unavailable" });
		expect(r.log).toHaveBeenCalledWith("attribution_unavailable");
	});

	it("never selects body columns and never echoes rows or parameters (privacy sentinel)", () => {
		const path = commDb(
			[
				{ delivery_id: "d-1", source_kind: "question", from_agent: EXEC_A },
				{
					delivery_id: "d-2",
					source_kind: "lead_event",
					from_agent: "bridge",
					source_ref: "7",
				},
			],
			[{ execution_id: EXEC_A, issue_id: "FLY-2830" }],
		);
		const r = run(["d-1", "d-2"], path, { 7: "flywheel:FLY-2831" });
		expect(r.seen.length).toBeGreaterThan(0);
		for (const sql of r.seen) {
			expect(sql).not.toMatch(/\bcontent\b|delivery_content|payload|\*/);
		}
		expect(r.seen.some((sql) => /\bIN \(\?, \?\)/.test(sql))).toBe(true);
		expect(JSON.stringify(r.trigger)).not.toContain(SENTINEL);
		expect(JSON.stringify(r.log.mock.calls)).not.toContain(SENTINEL);
	});

	it("opens the CommDB once and closes it", () => {
		const path = commDb(
			[{ delivery_id: "d-1", source_kind: "question", from_agent: EXEC_A }],
			[{ execution_id: EXEC_A, issue_id: "FLY-2830" }],
		);
		const r = run(["d-1"], path);
		expect(r.open).toHaveBeenCalledTimes(1);
		expect(r.open).toHaveBeenCalledWith("flywheel");
	});
});
