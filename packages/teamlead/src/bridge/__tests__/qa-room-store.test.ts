import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type QaRoom,
	type QaRoomOperation,
	QaRoomStore,
} from "../qa-room-store.js";

const now = "2026-09-26T18:00:00.000Z";
function room(id = "r1", owner = "runner:exec1"): QaRoom {
	return {
		room_id: id,
		status: "queued",
		status_reason: null,
		owner_actor_key: owner,
		owner_issue: "FLY-2405",
		head: "a".repeat(40),
		slot: 1,
		claim_token: "private-claim",
		physically_claimed: 0,
		release_state: "held",
		src_dir: `/tmp/${id}/src`,
		deploy_json: null,
		evidence_dir: null,
		request_json: "{}",
		created_at: now,
		updated_at: now,
	};
}
function op(id = "o1", owner = "runner:exec1", roomId = "r1"): QaRoomOperation {
	return {
		operation_id: id,
		room_id: roomId,
		kind: "deploy",
		actor_key: owner,
		request_id: `request-${id}`,
		request_digest: "digest",
		attempt: 1,
		status: "queued",
		operation_dir: `/tmp/${roomId}/ops/${id}`,
		pid: null,
		residue_check: null,
		request_json: "{}",
		queued_at: now,
		created_at: now,
		started_at: null,
		finished_at: null,
	};
}

describe("QA room persistence", () => {
	let db: Database.Database;
	let store: QaRoomStore;
	beforeEach(() => {
		db = new Database(":memory:");
		db.pragma("foreign_keys = ON");
		store = new QaRoomStore(db);
		store.migrate();
	});
	afterEach(() => db.close());
	const accept = (s: QaRoomStore, r = room(), o = op(), slots = [1, 2]) =>
		s.accept(r, o, slots, {
			at: now,
			actor_key: o.actor_key,
			actor_issue: r.owner_issue,
			action: "deploy",
			room_id: r.room_id,
			slot: r.slot,
			decision: "accepted",
			reason: null,
			head: r.head,
			request_digest: o.request_digest,
		});
	it("migrates idempotently and retains reservations and operation age", () => {
		accept(store);
		const restarted = new QaRoomStore(db);
		restarted.migrate();
		expect(restarted.getRoom("r1")).toEqual(room());
		expect(restarted.getOperation("o1")).toEqual(op());
		expect(restarted.reservedSlots()).toEqual([1, 2]);
	});
	it("retains physical claims, release progress and operation age across a file-backed close and reopen", () => {
		const dir = mkdtempSync(join(tmpdir(), "qa-room-reopen-"));
		const path = join(dir, "teamlead.db");
		let diskDb = new Database(path);
		try {
			diskDb.pragma("foreign_keys = ON");
			const writer = new QaRoomStore(diskDb);
			writer.migrate();
			const persistedRoom: QaRoom = {
				...room(),
				status: "tearing_down",
				physically_claimed: 1,
				release_state: "releasing",
			};
			const persistedOperation: QaRoomOperation = {
				...op(),
				kind: "teardown",
				attempt: 2,
				queued_at: "2026-09-26T17:59:00.000Z",
			};
			accept(writer, persistedRoom, persistedOperation);
			const persistedAudits = writer.audits();
			diskDb.close();

			diskDb = new Database(path, { fileMustExist: true });
			diskDb.pragma("foreign_keys = ON");
			const reopened = new QaRoomStore(diskDb);
			reopened.migrate();
			expect(reopened.getRoom("r1")).toEqual(persistedRoom);
			expect(reopened.getOperation("o1")).toEqual(persistedOperation);
			expect(reopened.reservedSlots()).toEqual([1, 2]);
			expect(reopened.audits()).toEqual(persistedAudits);
		} finally {
			if (diskDb.open) diskDb.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("rolls back the room, operation and audit if any borrowed slot is taken", () => {
		accept(store);
		expect(() =>
			accept(
				store,
				{ ...room("r2", "runner:exec2"), slot: 3 },
				op("o2", "runner:exec2", "r2"),
				[3, 2],
			),
		).toThrow(/UNIQUE/);
		expect(store.getRoom("r2")).toBeUndefined();
		expect(store.getOperation("o2")).toBeUndefined();
		expect(store.reservedSlots()).toEqual([1, 2]);
		expect(store.audits()).toHaveLength(1);
	});
	it("enforces nonempty actor/request identity and Lead idempotency without an execution id", () => {
		accept(store, room("r1", "lead:eng"), op("o1", "lead:eng"));
		const second = {
			...op("o2", "lead:eng"),
			request_id: "request-o1",
			kind: "teardown" as const,
		};
		expect(() => store.addOperation(second)).toThrow(/UNIQUE/);
		expect(store.findRequest("lead:eng", "request-o1")?.operation_id).toBe(
			"o1",
		);
		for (const field of ["actor_key", "request_id"] as const) {
			for (const value of ["", null]) {
				expect(() =>
					store.addOperation({
						...second,
						request_id: "new",
						[field]: value,
					} as QaRoomOperation),
				).toThrow();
			}
		}
	});
	it("keeps one live room per runner, releasing capacity only at a terminal state", () => {
		accept(store);
		expect(() =>
			accept(
				store,
				{ ...room("r2"), slot: 3 },
				op("o2", "runner:exec1", "r2"),
				[3],
			),
		).toThrow(/UNIQUE/);
		store.updateRoom("r1", {
			status: "released",
			release_state: "released",
			updated_at: now,
		});
		store.releaseReservations("r1");
		accept(store, room("r2"), op("o2", "runner:exec1", "r2"));
		expect(store.rooms()).toHaveLength(2);
	});
	it("rejects invalid status/kind/release values at the database boundary", () => {
		accept(store);
		for (const [table, column] of [
			["qa_room", "status"],
			["qa_room", "release_state"],
			["qa_room_operation", "status"],
			["qa_room_operation", "kind"],
		]) {
			expect(() =>
				db.prepare(`UPDATE ${table} SET ${column} = ?`).run("invented"),
			).toThrow(/CHECK/);
		}
	});
	it("makes audits append-only, including refused requests without a room", () => {
		store.audit({
			at: now,
			actor_key: "runner:other",
			actor_issue: "FLY-9",
			action: "teardown",
			room_id: null,
			slot: null,
			decision: "refused",
			reason: "room_not_owned",
			head: null,
			request_digest: "x",
		});
		expect(() =>
			db.prepare("UPDATE qa_room_audit SET reason = ?").run("rewritten"),
		).toThrow(/append.only/);
		expect(() => db.prepare("DELETE FROM qa_room_audit").run()).toThrow(
			/append.only/,
		);
		expect(store.audits()[0]?.reason).toBe("room_not_owned");
	});
	it("commits completion and audit atomically and keeps each teardown attempt", () => {
		accept(store);
		store.updateOperation("o1", { status: "succeeded", finished_at: now });
		store.addOperation({ ...op("o2"), kind: "teardown", attempt: 1 });
		store.updateOperation("o2", { status: "failed", finished_at: now });
		store.addOperation({ ...op("o3"), kind: "teardown", attempt: 2 });
		expect(store.operations("r1").map((item) => item.operation_id)).toEqual([
			"o1",
			"o2",
			"o3",
		]);
		expect(() =>
			store.transaction(() => {
				store.updateRoom("r1", { status: "torn_down", updated_at: now });
				throw new Error("crash before audit");
			}),
		).toThrow("crash before audit");
		expect(store.getRoom("r1")?.status).toBe("queued");
	});
});
