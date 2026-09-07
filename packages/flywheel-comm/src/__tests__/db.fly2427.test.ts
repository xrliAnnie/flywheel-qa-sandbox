import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

type RawDatabase = {
	prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
};

describe("CommDB FLY-2427 founder ship question inspection", () => {
	let dir: string;
	let db: CommDB;
	let raw: RawDatabase;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly2427-comm-inspection-"));
		db = new CommDB(join(dir, "comm.db"));
		raw = (db as unknown as { db: RawDatabase }).db;
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function question(): string {
		const id = db.insertQuestion("exec-1", "lead-1", "ship?", {
			checkpoint: "approve_to_ship",
		});
		raw
			.prepare("UPDATE mailbox SET relay_state = 'protected' WHERE id = ?")
			.run(id);
		return id;
	}

	it("classifies every unanswerable condition without mutating the question", () => {
		const healthy = question();
		const disposed = question();
		const superseded = question();
		const resolved = question();
		const answered = question();

		raw
			.prepare(
				"UPDATE mailbox SET relay_state = 'terminal_disposed' WHERE id = ?",
			)
			.run(disposed);
		raw
			.prepare("UPDATE mailbox SET superseded_at = ? WHERE id = ?")
			.run("2026-09-07T18:00:00.000Z", superseded);
		raw
			.prepare("UPDATE mailbox SET resolved_at = ? WHERE id = ?")
			.run("2026-09-07T18:00:00.000Z", resolved);
		db.insertResponse(answered, "lead-1", "changes requested");
		raw
			.prepare("UPDATE mailbox SET relay_state = 'protected' WHERE id = ?")
			.run(answered);

		expect(
			db.inspectFounderShipGateQuestion("missing", "flywheel"),
		).toMatchObject({
			questionExists: false,
			answerable: false,
			unanswerableReasons: ["question_missing"],
		});
		expect(db.inspectFounderShipGateQuestion(healthy, "flywheel")).toEqual({
			questionId: healthy,
			questionExists: true,
			terminalDisposed: false,
			superseded: false,
			resolved: false,
			responseExists: false,
			founderSourceEventExists: false,
			answerable: true,
			unanswerableReasons: [],
		});

		for (const [id, reason] of [
			[disposed, "terminal_disposed"],
			[superseded, "superseded"],
			[resolved, "resolved"],
			[answered, "response_exists"],
		] as const) {
			expect(db.inspectFounderShipGateQuestion(id, "flywheel")).toMatchObject({
				questionExists: true,
				answerable: false,
				unanswerableReasons: [reason],
			});
		}

		expect(db.getMessageById(healthy)).toMatchObject({
			relay_state: "protected",
			resolved_at: null,
			superseded_at: null,
		});
	});

	it.each([
		["founder-approval", ""],
		["founder-feedback", ":discord-message-1"],
	] as const)(
		"finds a %s source event with suffix %j using the project-scoped prefix",
		(kind, suffix) => {
			const id = question();
			const sourceEventId = `${kind}:${id}${suffix}`;
			raw
				.prepare(
					`INSERT INTO workflow_source_event
					 (project, source_event_id, kind, payload, payload_digest, schema_version, at)
					 VALUES (?, ?, ?, '{}', 'digest', 1, '2026-09-07T18:00:00.000Z')`,
				)
				.run("flywheel", sourceEventId, kind.replace("-", "_"));

			expect(db.inspectFounderShipGateQuestion(id, "flywheel")).toMatchObject({
				founderSourceEventExists: true,
			});
			expect(
				db.inspectFounderShipGateQuestion(id, "other-project"),
			).toMatchObject({ founderSourceEventExists: false });
		},
	);
});
