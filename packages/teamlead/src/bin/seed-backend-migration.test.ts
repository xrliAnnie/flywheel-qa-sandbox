import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, expect, it } from "vitest";
import { seedBackendMigration } from "./seed-backend-migration.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fly2459-seed-"));
	dirs.push(root);
	const channel = "123456789012345678",
		empty = "223456789012345678",
		botUserId = "323456789012345678",
		message = "423456789012345678";
	const at = "2026-09-11T00:00:00.000Z";
	const artifact = {
		version: 1 as const,
		intentSha: "a".repeat(64),
		cutoffs: {
			version: 1 as const,
			migrationId: "FLY-2459-honey-lemon" as const,
			botUserId,
			writerStoppedAt: at,
			channels: [
				{
					channelId: channel,
					observedAt: at,
					cutoffId: message,
					lastBotReplyId: null,
					unresolvedMessageIds: [message],
					unresolvedBefore: null,
				},
				{
					channelId: empty,
					observedAt: at,
					cutoffId: null,
					lastBotReplyId: null,
					unresolvedMessageIds: [],
					unresolvedBefore: null,
				},
			],
		},
	};
	return {
		root,
		channel,
		empty,
		message,
		input: {
			path: join(root, "inbound-cursor.json"),
			expectedBeforeSha256: null,
			artifact,
			identity: { botUserId, channelIds: [channel, empty] },
			assertWindowAndStopped: () => {},
		},
	};
}
it("queues unresolved history before seeding cutoffs and resumes both steps after reopening", () => {
	const f = fixture();
	let queue = new MailboxQueue(join(f.root, "comm.db"));
	const first = seedBackendMigration({ ...f.input, queue });
	expect(first.cursor.status).toBe("seeded");
	expect(JSON.parse(readFileSync(f.input.path, "utf8"))).toEqual({
		[f.channel]: f.message,
		[f.empty]: "0",
	});
	expect(queue.getById(first.handoffIds[0])?.content).toContain(f.message);
	queue.close();
	queue = new MailboxQueue(join(f.root, "comm.db"));
	try {
		const next = seedBackendMigration({ ...f.input, queue });
		expect(next.handoffIds).toEqual(first.handoffIds);
		expect(next.cursor.status).toBe("already_seeded");
	} finally {
		queue.close();
	}
});
it("a failed mailbox write leaves the cursor absent", () => {
	const f = fixture();
	const queue = new MailboxQueue(join(f.root, "comm.db"));
	queue.close();
	expect(() => seedBackendMigration({ ...f.input, queue })).toThrow();
	expect(existsSync(f.input.path)).toBe(false);
});
it("rechecks the stopped-writer fence after handoff before advancing the cursor", () => {
	const f = fixture();
	const queue = new MailboxQueue(join(f.root, "comm.db"));
	let calls = 0;
	try {
		expect(() =>
			seedBackendMigration({
				...f.input,
				queue,
				assertWindowAndStopped: () => {
					if (++calls === 3) throw new Error("writer returned");
				},
			}),
		).toThrow("writer returned");
		expect(existsSync(f.input.path)).toBe(false);
	} finally {
		queue.close();
	}
});
