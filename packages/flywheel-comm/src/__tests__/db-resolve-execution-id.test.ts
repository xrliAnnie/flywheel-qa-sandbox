import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../db.js";

/**
 * FLY-3083 — `CommDB.resolveExecutionId`: a Runner mailbox short name
 * ("runner-<8hex>", the exact shape of deriveRunnerMailboxIdentity) resolves
 * to the full execution_id so the runner-msg-guard hook's replacement command
 * can hand `send --to` the name the Lead actually sees. Every other string
 * keeps the existing opaque-id contract (returned verbatim, no DB query).
 */
describe("CommDB.resolveExecutionId (FLY-3083)", () => {
	let tmpDir: string;
	let db: CommDB;
	const EXEC_A = "42afa86c-1111-4222-8333-444455556666";
	const EXEC_B = "42afa86c-9999-4aaa-8bbb-ccccddddeeee";
	const EXEC_C = "7b1920df-fcad-4ebc-9677-40ac675cf229";

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly3083-resolve-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});
	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("resolves a unique short name to the full execution id", () => {
		db.registerSession(EXEC_A, "s:w", "proj", "FLY-1", "lead-a");
		db.registerSession(EXEC_C, "s:w2", "proj", "FLY-2", "lead-a");
		expect(db.resolveExecutionId("runner-42afa86c")).toBe(EXEC_A);
		expect(db.resolveExecutionId("runner-7b1920df")).toBe(EXEC_C);
	});

	it("fails closed when no session matches", () => {
		expect(() => db.resolveExecutionId("runner-deadbeef")).toThrow(
			/no session for runner ref runner-deadbeef/,
		);
	});

	it("fails closed on an ambiguous prefix instead of guessing", () => {
		db.registerSession(EXEC_A, "s:w", "proj", "FLY-1", "lead-a");
		db.registerSession(EXEC_B, "s:w2", "proj", "FLY-2", "lead-b");
		expect(() => db.resolveExecutionId("runner-42afa86c")).toThrow(
			/ambiguous runner ref runner-42afa86c \(2 sessions\)/,
		);
	});

	it("narrows by leadId when given", () => {
		db.registerSession(EXEC_A, "s:w", "proj", "FLY-1", "lead-a");
		db.registerSession(EXEC_B, "s:w2", "proj", "FLY-2", "lead-b");
		expect(db.resolveExecutionId("runner-42afa86c", { leadId: "lead-b" })).toBe(
			EXEC_B,
		);
		expect(() =>
			db.resolveExecutionId("runner-42afa86c", { leadId: "lead-z" }),
		).toThrow(/no session for runner ref runner-42afa86c/);
	});

	it.each([
		EXEC_A,
		"exec-123",
		"runner-e1",
		"runner-42AFA86C",
		"runner-42afa86c-x",
		" runner-42afa86c",
		"runner-42afa86",
	])("returns non-short-name %j verbatim without querying", (ref) => {
		// A matching session exists — a verbatim return proves no lookup ran.
		db.registerSession(EXEC_A, "s:w", "proj", "FLY-1", "lead-a");
		expect(db.resolveExecutionId(ref)).toBe(ref);
	});
});
