import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import {
	createStateStoreSnapshotReader,
	resolveRunnerRecipient,
	type StateStoreSnapshotReader,
} from "../recipient-resolve.js";

const ID = "abcdef01-2345-6789-abcd-0123456789ab";
describe("recipient identity and StateStore authority", () => {
	let dir: string;
	let db: CommDB;
	let stateStore: StateStoreSnapshotReader;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1942-recipient-"));
		db = new CommDB(join(dir, "comm.db"));
		stateStore = { readStatus: () => ({ readable: true, status: "running" }) };
	});
	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const seed = (db: CommDB, id = ID) =>
		db.registerSession(
			id,
			"session:window",
			"flywheel",
			"FLY-1942",
			"flywheel-eng-lead",
			"codex",
		);
	it.each([
		"",
		"abcdef0",
		"runner-abcdef01",
		"exec-123",
		"abcdef01%",
		"abcdef01_",
	])("rejects malformed %s before lookup", (raw) => {
		expect(() =>
			resolveRunnerRecipient({ commDb: db, stateStore }, raw),
		).toThrowError(/recipient_malformed/);
	});
	it("canonicalizes full and unique prefix identity", () => {
		seed(db);
		expect(
			resolveRunnerRecipient(
				{ commDb: db, stateStore },
				` ${ID.toUpperCase()} `,
			),
		).toMatchObject({
			kind: "runner",
			executionId: ID,
			resolvedFromPrefix: false,
		});
		expect(
			resolveRunnerRecipient({ commDb: db, stateStore }, "ABCDEF01"),
		).toMatchObject({
			executionId: ID,
			resolvedFromPrefix: true,
			issueId: "FLY-1942",
			leadId: "flywheel-eng-lead",
		});
	});
	it("rejects unknown full identity and ambiguous prefix", () => {
		expect(() =>
			resolveRunnerRecipient({ commDb: db, stateStore }, ID),
		).toThrowError(/recipient_not_found/);
		seed(db);
		seed(db, "abcdef01-2345-6789-abcd-0123456789ac");
		expect(() =>
			resolveRunnerRecipient({ commDb: db, stateStore }, "abcdef01"),
		).toThrowError(/recipient_ambiguous/);
	});
	it.each(["awaiting_review", "running", "approved_to_ship", null])(
		"allows StateStore %s regardless of CommDB status",
		(status) => {
			seed(db);
			db.updateSessionStatus(ID, "completed");
			stateStore = { readStatus: () => ({ readable: true, status }) };
			expect(
				resolveRunnerRecipient({ commDb: db, stateStore }, ID),
			).toMatchObject({ executionId: ID });
		},
	);
	it("refuses terminal StateStore truth", () => {
		seed(db);
		stateStore = {
			readStatus: () => ({ readable: true, status: "completed" }),
		};
		expect(() =>
			resolveRunnerRecipient({ commDb: db, stateStore }, ID),
		).toThrowError(/recipient_terminal/);
	});
	it("preserves Lead recipients without touching the state reader", () => {
		stateStore = {
			readStatus: () => {
				throw new Error("must not read");
			},
		};
		for (const raw of ["lead", "flywheel-eng-lead"])
			expect(resolveRunnerRecipient({ commDb: db, stateStore }, raw)).toEqual({
				kind: "lead",
				toAgent: raw,
			});
	});
	it("surfaces unreadable liveness while retaining durable identity", () => {
		seed(db);
		stateStore = {
			readStatus: () => ({ readable: false, reason: "unavailable" }),
		};
		expect(
			resolveRunnerRecipient({ commDb: db, stateStore }, ID),
		).toMatchObject({ executionId: ID, livenessWarning: "unavailable" });
	});
	it("reads a real WAL snapshot and closes each handle; missing/corrupt files never created or thrown", () => {
		const path = join(dir, "state.db");
		const reader = createStateStoreSnapshotReader({ TEAMLEAD_DB_PATH: path });
		expect(reader.readStatus(ID)).toMatchObject({ readable: false });
		expect(existsSync(path)).toBe(false);
		const writer = new Database(path);
		try {
			writer.pragma("journal_mode=WAL");
			writer.exec("CREATE TABLE sessions (execution_id TEXT, status TEXT)");
			writer
				.prepare("INSERT INTO sessions VALUES (?, ?)")
				.run(ID, "awaiting_review");
			expect(reader.readStatus(ID)).toEqual({
				readable: true,
				status: "awaiting_review",
			});
			expect(reader.readStatus("absent")).toEqual({
				readable: true,
				status: null,
			});
			writer.prepare("UPDATE sessions SET status = ?").run("completed");
			expect(reader.readStatus(ID)).toEqual({
				readable: true,
				status: "completed",
			});
		} finally {
			writer.close();
		}
		rmSync(path);
		writeFileSync(path, "corrupt");
		expect(reader.readStatus(ID)).toMatchObject({ readable: false });
	});
});
