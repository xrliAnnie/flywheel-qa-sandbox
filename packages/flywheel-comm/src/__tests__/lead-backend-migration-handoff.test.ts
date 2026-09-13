import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { enqueueMigrationHandoff } from "../lead-backend-migration-handoff.js";
import type { MigrationOperatorArtifact } from "../lead-backend-migration-operator.js";
import { MailboxQueue } from "../mailbox-queue.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { force: true, recursive: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fly2459-handoff-"));
	dirs.push(dir);
	const path = join(dir, "comm.db");
	const artifact: MigrationOperatorArtifact = {
		version: 1,
		intentSha: "a".repeat(64),
		cutoffs: {
			version: 1,
			migrationId: "FLY-2459-honey-lemon",
			botUserId: "123456789012345678",
			writerStoppedAt: "2026-09-11T00:00:00.000Z",
			channels: [
				{
					channelId: "223456789012345678",
					observedAt: "2026-09-11T00:00:00.000Z",
					cutoffId: "323456789012345678",
					lastBotReplyId: null,
					unresolvedMessageIds: ["323456789012345678"],
					unresolvedBefore: "323456789012345678",
				},
			],
		},
	};
	return {
		path,
		artifact,
		identity: {
			botUserId: artifact.cutoffs.botUserId,
			channelIds: artifact.cutoffs.channels.map((c) => c.channelId),
		},
	};
}
it("persists unresolved handoff in the standard mailbox and replays after reopening", () => {
	const f = fixture();
	let queue = new MailboxQueue(f.path);
	const first = enqueueMigrationHandoff(
		queue,
		f.artifact,
		f.identity,
		() => {},
	);
	expect(first).toHaveLength(1);
	const row = queue.getById(first[0]);
	expect(row).toMatchObject({
		to_agent: "flywheel-product-lead",
		recipient_kind: "lead",
		msg_class: "model",
		state: "QUEUED",
	});
	expect(row?.content).toContain("323456789012345678");
	expect(row?.content).toContain("unresolvedBefore");
	expect(row?.content).toContain("reconcile");
	queue.close();
	queue = new MailboxQueue(f.path);
	try {
		expect(
			enqueueMigrationHandoff(queue, f.artifact, f.identity, () => {}),
		).toEqual(first);
		expect(queue.getById(first[0])?.seq).toBe(row?.seq);
	} finally {
		queue.close();
	}
});
it("requires the stop/window fence before writing", () => {
	const f = fixture();
	const queue = new MailboxQueue(f.path);
	try {
		expect(() =>
			enqueueMigrationHandoff(queue, f.artifact, f.identity, () => {
				throw new Error("writer alive");
			}),
		).toThrow("writer alive");
	} finally {
		queue.close();
	}
});
it("skips channels with no unresolved history", () => {
	const f = fixture();
	Object.assign(f.artifact.cutoffs.channels[0], {
		unresolvedMessageIds: [],
		unresolvedBefore: null,
		lastBotReplyId: "323456789012345678",
	});
	const queue = new MailboxQueue(f.path);
	try {
		expect(
			enqueueMigrationHandoff(queue, f.artifact, f.identity, () => {}),
		).toEqual([]);
	} finally {
		queue.close();
	}
});
it("changed evidence under the same intent conflicts rather than duplicating work", () => {
	const f = fixture();
	const queue = new MailboxQueue(f.path);
	try {
		enqueueMigrationHandoff(queue, f.artifact, f.identity, () => {});
		f.artifact.cutoffs.channels[0].unresolvedBefore = null;
		expect(() =>
			enqueueMigrationHandoff(queue, f.artifact, f.identity, () => {}),
		).toThrow();
	} finally {
		queue.close();
	}
});
it("refuses to treat dead delivery as a successful handoff", () => {
	const f = fixture();
	const queue = new MailboxQueue(f.path);
	try {
		const [id] = enqueueMigrationHandoff(
			queue,
			f.artifact,
			f.identity,
			() => {},
		);
		queue.markDead(id, "2026-09-11T00:01:00.000Z", "recipient_missing");
		expect(() =>
			enqueueMigrationHandoff(queue, f.artifact, f.identity, () => {}),
		).toThrow(/dead/);
		queue.archiveFamily({
			id,
			retentionMs: 0,
			now: "2026-09-20T00:00:00.000Z",
		});
		expect(() =>
			enqueueMigrationHandoff(queue, f.artifact, f.identity, () => {}),
		).toThrow(/delivery/);
	} finally {
		queue.close();
	}
});
