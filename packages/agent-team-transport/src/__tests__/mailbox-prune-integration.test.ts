/**
 * FLY-182 Track A — end-to-end prune wiring through the real codec path.
 *
 * Proves prune is actually invoked from `writeMailboxEntry` /
 * `markEntriesAsReadUnderLock` (not just the pure function), that the file
 * stays stock-compatible (`TeammateMessage[]`), and that `readMailboxEntries`
 * still returns every unread entry after prune.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	markEntriesAsReadUnderLock,
	readMailboxEntries,
	writeMailboxEntry,
} from "../claude/ClaudeMailboxCodec.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mailbox prune — end-to-end via codec", () => {
	let dir: string;
	let inbox: string;
	let sidecar: string;
	const saved = { ...process.env };

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fly182-prune-int-"));
		inbox = join(dir, "teams", "ops-lead", "inboxes", "ops-lead.json");
		sidecar = `${inbox}.flywheel.jsonl`;
	});
	afterEach(async () => {
		process.env = { ...saved };
		await rm(dir, { recursive: true, force: true });
	});

	async function write(content: string, flywheelId: string) {
		await writeMailboxEntry({
			inboxPath: inbox,
			sidecarPath: sidecar,
			flywheelId,
			payload: { from: "bridge", to: "ops-lead", content },
		});
	}

	it("prunes old read entries on the next write, preserving unread + recent read + stock shape", async () => {
		// Tight policy: keep most-recent 1 read by count, retention 1ms → older
		// read entries become prunable after a short real delay. (0 is rejected
		// by resolvePrunePolicy and falls back to the default, so use 1.)
		process.env.FLYWHEEL_MAILBOX_READ_KEEP = "1";
		process.env.FLYWHEEL_MAILBOX_READ_RETENTION_MS = "1";
		process.env.FLYWHEEL_MAILBOX_UNREAD_WARN = "100000"; // no overflow here

		await write("a", "id-a");
		await write("b", "id-b");
		await write("c", "id-c");

		// Mark a + b read (predicate by content); c stays unread.
		await markEntriesAsReadUnderLock({
			inboxPath: inbox,
			predicate: (m) => m.text === "a" || m.text === "b",
		});

		await sleep(15); // exceed the 1ms retention window deterministically

		// Next write triggers prune: a (oldest read, beyond keep=1, older than
		// retention) drops; b (most-recent read, kept by count) + c (unread) +
		// d (new unread) survive.
		await write("d", "id-d");

		const entries = await readMailboxEntries(inbox);
		expect(entries.map((e) => e.text).sort()).toEqual(["b", "c", "d"]);
		// b is read-but-recent (kept by count); c + d unread → stock poller sees them.
		expect(entries.find((e) => e.text === "b")?.read).toBe(true);
		expect(
			entries
				.filter((e) => e.read === false)
				.map((e) => e.text)
				.sort(),
		).toEqual(["c", "d"]);

		// File is valid stock TeammateMessage[] JSON.
		const raw = JSON.parse(await readFile(inbox, "utf-8"));
		expect(Array.isArray(raw)).toBe(true);
		expect(raw).toHaveLength(3);
	});

	it("never drops unread even under a tiny retention + keep=0", async () => {
		process.env.FLYWHEEL_MAILBOX_READ_KEEP = "0";
		process.env.FLYWHEEL_MAILBOX_READ_RETENTION_MS = "1";

		await write("u1", "u1");
		await write("u2", "u2");
		await sleep(15);
		await write("u3", "u3");

		const entries = await readMailboxEntries(inbox);
		// Nothing was marked read → all unread → all preserved.
		expect(entries.map((e) => e.text).sort()).toEqual(["u1", "u2", "u3"]);
	});
});
