import { statSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XhsWriteStore } from "../store.js";
import { fixture, NOW } from "./store-fixture.js";

const fixtures: ReturnType<typeof fixture>[] = [];
function setup() {
	const f = fixture();
	fixtures.push(f);
	return f;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const f of fixtures.splice(0)) f.close();
});

describe("durable one-use admission", () => {
	it("requires existing initialized ledger and matching generation on reopen", () => {
		const f = setup();
		expect(
			() =>
				new XhsWriteStore(`${f.path}.missing`, {
					providerGeneration: "generation-a",
				}),
		).toThrow();
		expect(
			() => new XhsWriteStore(f.path, { providerGeneration: "other" }),
		).toThrow("generation_mismatch");
		expect(
			() =>
				new XhsWriteStore(f.path, {
					initialize: true,
					providerGeneration: "generation-a",
				}),
		).toThrow();
		expect(statSync(f.path).mode & 0o777).toBe(0o600);
	});
	it("reads back WAL/FULL/fullfsync/foreign keys from the actual writer", () => {
		const f = setup();
		expect(f.store.durability()).toEqual({
			journalMode: "wal",
			synchronous: 2,
			fullfsync: 1,
			checkpointFullfsync: 1,
			foreignKeys: 1,
			busyTimeout: 5000,
		});
	});
	it("rolls back all consumption fields when attempt insertion fails", () => {
		const f = setup();
		f.approve();
		const db = new Database(f.path);
		db.exec(
			"CREATE TRIGGER deny_attempt BEFORE INSERT ON xhs_write_attempt BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END",
		);
		let mutations = 0;
		expect(() => {
			if (f.store.claim(f.request, NOW + 3000).kind === "claimed") mutations++;
		}).toThrow();
		expect(mutations).toBe(0);
		f.restart();
		expect(
			db.prepare("SELECT consumed_at FROM xhs_write_decision").get(),
		).toEqual({ consumed_at: null });
		expect(
			db.prepare("SELECT count(*) AS n FROM xhs_write_attempt").get(),
		).toEqual({ n: 0 });
		db.exec("DROP TRIGGER deny_attempt");
		db.close();
		expect(f.store.claim(f.request, NOW + 3001).kind).toBe("claimed");
	});
	it("never returns admission when COMMIT reports failure", () => {
		const f = setup();
		f.approve();
		const db = (f.store as any).database as Database.Database;
		const original = db.exec.bind(db);
		const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
			if (sql === "COMMIT") throw new Error("SQLITE_IOERR_FSYNC");
			return original(sql);
		});
		let mutations = 0;
		expect(() => {
			if (f.store.claim(f.request, NOW + 3000).kind === "claimed") mutations++;
		}).toThrow("SQLITE_IOERR_FSYNC");
		expect(mutations).toBe(0);
		spy.mockRestore();
		f.restart();
		expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
			"approved",
		);
		expect(f.store.claim(f.request, NOW + 3001).kind).toBe("claimed");
	});
});

it("fails admission if the actual writer loses FULL durability", () => {
	const f = setup();
	f.approve();
	const db = (f.store as unknown as { database: Database.Database }).database;
	db.pragma("synchronous = NORMAL");
	let mutations = 0;
	expect(() => {
		if (f.store.claim(f.request, NOW + 3000).kind === "claimed") mutations++;
	}).toThrow("durability_unavailable");
	expect(mutations).toBe(0);
	db.pragma("synchronous = FULL");
	expect(f.store.claim(f.request, NOW + 3001).kind).toBe("claimed");
});

it("rolls back approval, audit and notification together when outbox persistence fails", () => {
	const f = setup();
	f.prepare();
	f.store.delivered(
		f.frozen.proposalId,
		{
			previewDigest: "d".repeat(64),
			cardId: "card-a",
			challenge: "ABCDEFGH",
			guildId: "guild-a",
			channelId: "channel-a",
		},
		NOW,
	);
	const db = new Database(f.path);
	try {
		db.exec(
			"CREATE TRIGGER deny_notification BEFORE INSERT ON xhs_write_notification BEGIN SELECT RAISE(ABORT, 'outbox disk failure'); END",
		);
		expect(() => f.store.recordDecision(f.decision)).toThrow(
			"outbox disk failure",
		);
		f.restart();
		expect(f.store.status(f.frozen.proposalId, f.identity)?.state).toBe(
			"awaiting_approval",
		);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM xhs_write_decision").get(),
		).toEqual({ n: 0 });
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM xhs_write_event").get(),
		).toEqual({ n: 0 });
		expect(f.store.claim(f.request, NOW + 3000).kind).toBe("denied");
		db.exec("DROP TRIGGER deny_notification");
		f.store.recordDecision(f.decision);
		expect(f.store.claim(f.request, NOW + 3001).kind).toBe("claimed");
	} finally {
		db.close();
	}
});
