import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, expect, it, vi } from "vitest";
import {
	collectAndSeedBackendMigration,
	observeBackendMigrationSeed,
} from "./collect-seed-backend-migration.js";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const home = realpathSync(
		mkdtempSync(join(tmpdir(), "fly2459-collect-seed-")),
	);
	dirs.push(home);
	mkdirSync(join(home, ".flywheel/lead-backend-migrations"), {
		recursive: true,
		mode: 0o700,
	});
	const db = join(home, ".flywheel/comm/flywheel/comm.db");
	new MailboxQueue(db).close();
	return {
		home,
		db,
		stateDir: join(home, ".flywheel/state/codex-lead/flywheel-product-lead"),
		intentSha: "a".repeat(64),
		botToken: "fixture-token",
		botUserId: "123456789012345678",
		channelIds: ["223456789012345678"],
		assertWindowAndStopped: () => {},
	};
}
it("collects once, queues unresolved work and preserves an advanced cursor on replay", async () => {
	const f = fixture();
	const fetcher = vi.fn(
		async () =>
			new Response(
				JSON.stringify([
					{ id: "323456789012345678", author: { id: "423456789012345678" } },
				]),
				{ status: 200 },
			),
	);
	vi.stubGlobal("fetch", fetcher);
	const first = await collectAndSeedBackendMigration(f);
	expect(first.cursor.status).toBe("seeded");
	expect(first.handoffIds).toHaveLength(1);
	const queue = new MailboxQueue(f.db);
	try {
		expect(queue.getById(first.handoffIds[0]!)?.content).toContain(
			"323456789012345678",
		);
	} finally {
		queue.close();
	}
	const cursor = join(f.stateDir, "inbound-cursor.json");
	writeFileSync(
		cursor,
		JSON.stringify({ [f.channelIds[0]!]: "523456789012345678" }),
	);
	const second = await collectAndSeedBackendMigration(f);
	expect(second.cursor.status).toBe("already_advanced");
	expect(second.handoffIds).toEqual(first.handoffIds);
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(JSON.parse(readFileSync(cursor, "utf8"))[f.channelIds[0]!]).toBe(
		"523456789012345678",
	);
});
it("refuses collection and seed when the window or stopped proof is revoked", async () => {
	const f = fixture();
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	f.assertWindowAndStopped = () => {
		throw Error("revoked");
	};
	await expect(collectAndSeedBackendMigration(f)).rejects.toThrow("revoked");
	expect(fetcher).not.toHaveBeenCalled();
});
it("closes CommDB and preserves a conflicting cursor when seed fails", async () => {
	const f = fixture();
	mkdirSync(f.stateDir, { recursive: true, mode: 0o700 });
	const cursor = join(f.stateDir, "inbound-cursor.json");
	writeFileSync(cursor, "{}", { mode: 0o600 });
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				JSON.stringify([
					{ id: "323456789012345678", author: { id: "423456789012345678" } },
				]),
				{ status: 200 },
			),
	);
	const close = vi.spyOn(MailboxQueue.prototype, "close");
	try {
		await expect(collectAndSeedBackendMigration(f)).rejects.toThrow(
			"existing cursor conflicts",
		);
		expect(close).toHaveBeenCalledTimes(1);
		expect(readFileSync(cursor, "utf8")).toBe("{}");
	} finally {
		close.mockRestore();
	}
});
it("observes live seed evidence without collecting, enqueuing or changing cursor bytes", async () => {
	const f = fixture();
	expect(observeBackendMigrationSeed(f).state).toBe("pre");
	const request = vi.fn(
		async () =>
			new Response(
				JSON.stringify([
					{ id: "323456789012345678", author: { id: "423456789012345678" } },
				]),
				{ status: 200 },
			),
	);
	vi.stubGlobal("fetch", request);
	const seeded = await collectAndSeedBackendMigration(f);
	const cursor = join(f.stateDir, "inbound-cursor.json"),
		bytes = readFileSync(cursor);
	const enqueue = vi.spyOn(MailboxQueue.prototype, "enqueue");
	try {
		expect(observeBackendMigrationSeed(f).state).toBe("post");
		expect(enqueue).not.toHaveBeenCalled();
		expect(readFileSync(cursor)).toEqual(bytes);
		expect(request).toHaveBeenCalledTimes(1);
	} finally {
		enqueue.mockRestore();
	}
	const queue = new MailboxQueue(f.db);
	try {
		queue.markDead(
			seeded.handoffIds[0]!,
			new Date().toISOString(),
			"recipient_missing",
		);
	} finally {
		queue.close();
	}
	expect(observeBackendMigrationSeed(f).state).toBe("conflict");
});
it("recognizes an archived ACKED handoff without re-enqueueing it", async () => {
	const f = fixture();
	vi.stubGlobal(
		"fetch",
		async () =>
			new Response(
				JSON.stringify([
					{ id: "323456789012345678", author: { id: "423456789012345678" } },
				]),
				{ status: 200 },
			),
	);
	const seeded = await collectAndSeedBackendMigration(f),
		id = seeded.handoffIds[0]!;
	const queue = new MailboxQueue(f.db);
	try {
		expect(queue.ack(id, "2026-09-11T00:00:00.000Z")).toBe(true);
		queue.archiveFamily({
			id,
			retentionMs: 0,
			now: "2026-09-20T00:00:00.000Z",
		});
		expect(queue.getById(id)).toBeUndefined();
	} finally {
		queue.close();
	}
	expect(observeBackendMigrationSeed(f).state).toBe("post");
});
