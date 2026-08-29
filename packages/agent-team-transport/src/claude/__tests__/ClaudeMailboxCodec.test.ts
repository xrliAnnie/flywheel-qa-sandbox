/**
 * ClaudeMailboxCodec unit tests.
 *
 * Per plan v1.27.1 §2.0.6 acceptance gates:
 * - Round-trip: write → read returns same fields, stock-compatible wire
 * - Idempotency: 100x same flywheelId → 1 main entry + 1 finalized sidecar
 * - Best-effort: no flywheelId → writes succeed but may duplicate
 * - Pre-lock invariant: empty inbox doesn't crash on first write
 * - Concurrency: stock-shaped markMessagesAsRead + codec write loops, no loss
 *
 * Stock-binary round-trip lives in `ClaudeMailboxCodec.integration.test.ts`
 * (skipped by default; requires `claude` CLI + tmux).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MailboxPayload, MailboxWriteError } from "../../types.js";
import {
	__testing,
	computeFingerprint,
	ensureFileExists,
	readMailboxEntries,
	type SidecarRecord,
	type TeammateMessage,
	writeMailboxEntry,
} from "../ClaudeMailboxCodec.js";

let tempDir: string;
let inboxPath: string;
let sidecarPath: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "claude-mailbox-codec-"));
	inboxPath = join(tempDir, "inboxes", "runner.json");
	sidecarPath = `${inboxPath}.flywheel.jsonl`;
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function basePayload(overrides: Partial<MailboxPayload> = {}): MailboxPayload {
	return {
		from: "cos-lead",
		to: "runner",
		content: "Reply with the literal word ALPHA-OK and nothing else.",
		...overrides,
	};
}

// ============================================================================
// Round-trip + wire format
// ============================================================================

describe("ClaudeMailboxCodec — round-trip + wire format", () => {
	it("writes a stock-compatible TeammateMessage entry", async () => {
		const payload = basePayload();

		const result = await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "test-id-1",
			payload,
			color: "red",
			summary: "spike test sentinel",
		});

		expect(result.idempotent).toBe(false);
		expect(result.flywheelId).toBe("test-id-1");
		expect(result.wroteAt).toBeGreaterThan(0);

		// Main file should be a top-level array of TeammateMessage.
		const raw = await readFile(inboxPath, "utf-8");
		const parsed = JSON.parse(raw) as TeammateMessage[];
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);

		const entry = parsed[0]!;
		expect(entry.from).toBe("cos-lead");
		expect(entry.text).toBe(payload.content);
		expect(entry.read).toBe(false);
		expect(entry.color).toBe("red");
		expect(entry.summary).toBe("spike test sentinel");
		// timestamp is ISO-8601 string — parse must succeed.
		expect(() => new Date(entry.timestamp).toISOString()).not.toThrow();
	});

	it("does not write color/summary fields when not supplied", async () => {
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "no-extras",
			payload: basePayload(),
		});

		const parsed = await readMailboxEntries(inboxPath);
		const entry = parsed[0]!;
		expect(entry.color).toBeUndefined();
		expect(entry.summary).toBeUndefined();
	});

	it("appends to existing inbox without losing prior entries", async () => {
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "first",
			payload: basePayload({ content: "first message" }),
		});
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "second",
			payload: basePayload({ content: "second message" }),
		});

		const messages = await readMailboxEntries(inboxPath);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.text).toBe("first message");
		expect(messages[1]?.text).toBe("second message");
	});

	it("readMailboxEntries returns [] when inbox doesn't exist", async () => {
		const missing = join(tempDir, "missing", "inbox.json");
		await expect(readMailboxEntries(missing)).resolves.toEqual([]);
	});

	it("throws MailboxWriteError on corrupted JSON", async () => {
		await ensureFileExists(inboxPath, "{bad json");
		await expect(readMailboxEntries(inboxPath)).rejects.toThrow(
			MailboxWriteError,
		);
	});
});

// ============================================================================
// Pre-lock invariant (Codex r3 medium #4)
// ============================================================================

describe("ClaudeMailboxCodec — pre-lock invariant", () => {
	it("first write to non-existent inbox creates `[]` then writes 1 entry", async () => {
		// inbox file doesn't exist yet
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "first-write",
			payload: basePayload(),
		});

		const stat = await __testing.statSafe(inboxPath);
		expect(stat.exists).toBe(true);

		const messages = await readMailboxEntries(inboxPath);
		expect(messages).toHaveLength(1);
	});

	it("ensureFileExists is idempotent (EEXIST swallowed)", async () => {
		await ensureFileExists(inboxPath, "[]");
		await ensureFileExists(inboxPath, "[]"); // second call must not throw
		const content = await readFile(inboxPath, "utf-8");
		expect(content).toBe("[]");
	});
});

// ============================================================================
// Idempotency (Codex r4 high #1 + r5 low #1)
// ============================================================================

describe("ClaudeMailboxCodec — idempotency (caller-provided flywheelId)", () => {
	it("100x same flywheelId → 1 main entry + 1 finalized sidecar record", async () => {
		const payload = basePayload({ content: "idempotent payload" });
		const flywheelId = "stable-key-100x";

		const results = await Promise.all(
			Array.from({ length: 100 }, () =>
				writeMailboxEntry({
					inboxPath,
					sidecarPath,
					flywheelId,
					payload,
				}),
			),
		);

		// Exactly one write should be non-idempotent (the first); 99 should be skips.
		const nonIdempotent = results.filter((r) => !r.idempotent);
		const idempotent = results.filter((r) => r.idempotent);
		expect(nonIdempotent).toHaveLength(1);
		expect(idempotent).toHaveLength(99);

		// Main file: exactly one entry.
		const messages = await readMailboxEntries(inboxPath);
		expect(messages).toHaveLength(1);

		// Sidecar: one finalized record for this flywheelId.
		const records = await __testing.sidecarReadRecords(sidecarPath);
		const matching = records.filter((r) => r.flywheelId === flywheelId);
		expect(matching).toHaveLength(1);
		expect(matching[0]?.status).toBe("finalized");
		expect(matching[0]?.idempotency).toBe("stable");
		expect(matching[0]?.finalizedAt).toBeGreaterThan(0);
		expect(matching[0]?.mainEntryRef).toBeDefined();
	});

	it("different flywheelIds → multiple main entries", async () => {
		const payload = basePayload();

		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "id-a",
			payload,
		});
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "id-b",
			payload,
		});
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "id-c",
			payload,
		});

		const messages = await readMailboxEntries(inboxPath);
		expect(messages).toHaveLength(3);

		const records = await __testing.sidecarReadRecords(sidecarPath);
		const finalized = records.filter((r) => r.status === "finalized");
		expect(finalized.map((r) => r.flywheelId).sort()).toEqual([
			"id-a",
			"id-b",
			"id-c",
		]);
	});

	it("returns idempotent: true on hit even when writes interleave concurrently", async () => {
		const flywheelId = "concurrent-key";
		const payload = basePayload();

		// Race 50 concurrent writes — only one should be non-idempotent.
		const results = await Promise.all(
			Array.from({ length: 50 }, () =>
				writeMailboxEntry({
					inboxPath,
					sidecarPath,
					flywheelId,
					payload,
				}),
			),
		);
		const nonIdempotent = results.filter((r) => !r.idempotent).length;
		expect(nonIdempotent).toBe(1);
	});
});

// ============================================================================
// Best-effort writes (no flywheelId)
// ============================================================================

describe("ClaudeMailboxCodec — best-effort writes (no flywheelId)", () => {
	it("write without flywheelId always writes (no dedupe)", async () => {
		const payload = basePayload();

		await writeMailboxEntry({ inboxPath, sidecarPath, payload });
		await writeMailboxEntry({ inboxPath, sidecarPath, payload });
		await writeMailboxEntry({ inboxPath, sidecarPath, payload });

		const messages = await readMailboxEntries(inboxPath);
		expect(messages).toHaveLength(3);

		const records = await __testing.sidecarReadRecords(sidecarPath);
		expect(records.every((r) => r.idempotency === "best-effort")).toBe(true);
	});

	it("best-effort sidecar records are FINALIZED (Codex r1 medium #3 — not left dangling)", async () => {
		const payload = basePayload();
		await writeMailboxEntry({ inboxPath, sidecarPath, payload });
		await writeMailboxEntry({ inboxPath, sidecarPath, payload });

		const records = await __testing.sidecarReadRecords(sidecarPath);
		// Each best-effort write should produce exactly one finalized record.
		expect(records).toHaveLength(2);
		for (const r of records) {
			expect(r.status).toBe("finalized");
			expect(r.idempotency).toBe("best-effort");
			expect(r.finalizedAt).toBeGreaterThan(0);
			expect(r.mainEntryRef).toBeDefined();
		}
	});

	it("best-effort and stable writes can coexist on same inbox", async () => {
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "stable-1",
			payload: basePayload({ content: "stable" }),
		});
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			payload: basePayload({ content: "best-effort" }),
		});

		const messages = await readMailboxEntries(inboxPath);
		expect(messages.map((m) => m.text)).toEqual(["stable", "best-effort"]);

		const records = await __testing.sidecarReadRecords(sidecarPath);
		const stable = records.filter((r) => r.idempotency === "stable");
		const bestEffort = records.filter((r) => r.idempotency === "best-effort");
		expect(stable).toHaveLength(1);
		expect(bestEffort).toHaveLength(1);
	});
});

// ============================================================================
// Concurrency vs stock-shaped markMessagesAsRead (Codex r2 critical #1)
// ============================================================================

/**
 * Replicates stock claude-code's markMessagesAsRead behavior:
 * - Acquire `${inboxPath}.lock` with the same LOCK_OPTIONS
 * - Read all messages
 * - Flip every `read` to `true`
 * - Write back (NOT atomic — matches stock at teammateMailbox.ts:320)
 *
 * If our codec doesn't cooperate with the same lock, the race between
 * stock-write-back and our atomic-rename will lose messages.
 */
async function stockMarkAllAsReadOnce(inboxPath: string): Promise<void> {
	const lockPath = `${inboxPath}.lock`;
	const release = await lockfile.lock(inboxPath, {
		lockfilePath: lockPath,
		retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
	});
	try {
		const raw = await readFile(inboxPath, "utf-8");
		const messages = JSON.parse(raw) as TeammateMessage[];
		for (const m of messages) m.read = true;
		await writeFile(inboxPath, JSON.stringify(messages, null, 2), "utf-8");
	} finally {
		await release();
	}
}

describe("ClaudeMailboxCodec — concurrency with stock-shaped markMessagesAsRead", () => {
	it("60s parallel codec write + stock mark-as-read produces zero message loss", async () => {
		// Seed: ensure inbox exists with [].
		await ensureFileExists(inboxPath, "[]");

		const writerCount = 200;
		const writeIds = Array.from({ length: writerCount }, (_, i) => `wid-${i}`);

		let stop = false;
		// Reader loop: keep marking as read at high frequency.
		const readerLoop = (async () => {
			while (!stop) {
				try {
					await stockMarkAllAsReadOnce(inboxPath);
				} catch (_e) {
					// Ignore transient errors during write churn.
				}
				// Tight loop — simulates worst-case Runner poller speed.
				await new Promise((r) => setImmediate(r));
			}
		})();

		// Writer batch: 200 writes with stable but distinct flywheelIds, racing
		// against the reader. After the writers finish, every id MUST be
		// reflected in the main file.
		const writerPromises = writeIds.map((id, i) =>
			writeMailboxEntry({
				inboxPath,
				sidecarPath,
				flywheelId: id,
				payload: basePayload({ content: `msg-${i}` }),
			}),
		);
		await Promise.all(writerPromises);

		stop = true;
		await readerLoop;

		// One final mark-as-read flush so we read a quiescent state.
		await stockMarkAllAsReadOnce(inboxPath);

		const messages = await readMailboxEntries(inboxPath);
		const seenIds = new Set(messages.map((m) => m.text));

		// Every writer's content must appear exactly once.
		expect(seenIds.size).toBe(writerCount);
		for (let i = 0; i < writerCount; i++) {
			expect(seenIds.has(`msg-${i}`)).toBe(true);
		}
		// Sidecar finalized count must match.
		const records = await __testing.sidecarReadRecords(sidecarPath);
		const finalized = records.filter((r) => r.status === "finalized");
		expect(finalized.length).toBe(writerCount);
	}, 60_000);
});

// ============================================================================
// Sidecar repair semantics (Codex r3 high #2)
// ============================================================================

describe("ClaudeMailboxCodec — sidecar repair semantics", () => {
	it("computeFingerprint is deterministic and content-derived", () => {
		const fp1 = computeFingerprint({
			from: "a",
			to: "b",
			text: "hello",
			timestamp: "2026-05-09T00:00:00Z",
		});
		const fp2 = computeFingerprint({
			from: "a",
			to: "b",
			text: "hello",
			timestamp: "2026-05-09T00:00:00Z",
		});
		expect(fp1).toBe(fp2);
		expect(fp1).toHaveLength(64); // sha256 hex
	});

	it("sidecar pending → finalized transition records mainEntryRef", async () => {
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "repairable",
			payload: basePayload(),
		});
		const records: SidecarRecord[] =
			await __testing.sidecarReadRecords(sidecarPath);
		const finalized = records.find((r) => r.flywheelId === "repairable");
		expect(finalized?.status).toBe("finalized");
		expect(finalized?.mainEntryRef?.from).toBe("cos-lead");
		expect(finalized?.mainEntryRef?.timestamp).toBeTruthy();
	});

	// =========================================================================
	// Codex r1 high #2 — pending dedupe semantics
	// =========================================================================

	it("finalized record blocks subsequent retries (genuine idempotency)", async () => {
		await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "stable-1",
			payload: basePayload({ content: "first" }),
		});

		const result = await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "stable-1",
			payload: basePayload({ content: "first" }),
		});
		expect(result.idempotent).toBe(true);

		const messages = await readMailboxEntries(inboxPath);
		expect(messages).toHaveLength(1);
	});

	it("recent (<60s) pending record blocks retry (concurrent-writer protection)", async () => {
		// Inject a pending record manually (simulates an in-flight concurrent writer).
		await ensureFileExists(sidecarPath, "");
		const recentPending: SidecarRecord = {
			flywheelId: "in-flight",
			status: "pending",
			idempotency: "stable",
			payloadFingerprint: "x",
			pendingAt: Date.now(), // very recent
		};
		await writeFile(sidecarPath, `${JSON.stringify(recentPending)}\n`, "utf-8");

		// Retry should defer to the in-flight writer.
		const result = await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "in-flight",
			payload: basePayload(),
		});
		expect(result.idempotent).toBe(true);

		// Main file should NOT have been written (deferred to in-flight writer).
		const messages = await readMailboxEntries(inboxPath);
		expect(messages).toHaveLength(0);
	});

	it("STALE (>=60s) pending record is REPLACED and retry actually writes (Codex r1 high #2 fix)", async () => {
		// Inject a stale pending record (simulates a crashed previous attempt).
		await ensureFileExists(sidecarPath, "");
		const stalePending: SidecarRecord = {
			flywheelId: "crashed-attempt",
			status: "pending",
			idempotency: "stable",
			payloadFingerprint: "old-fp",
			pendingAt: Date.now() - 120_000, // 2 minutes ago — past 60s stale threshold
		};
		await writeFile(sidecarPath, `${JSON.stringify(stalePending)}\n`, "utf-8");

		// Retry with same flywheelId — should NOT be idempotent (stale pending
		// was a dead writer; this retry should actually write).
		const result = await writeMailboxEntry({
			inboxPath,
			sidecarPath,
			flywheelId: "crashed-attempt",
			payload: basePayload({ content: "retry payload" }),
		});
		expect(result.idempotent).toBe(false);

		// Main file should now have the message.
		const messages = await readMailboxEntries(inboxPath);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toBe("retry payload");

		// Sidecar should have one finalized record (stale pending dropped + new
		// pending → finalized).
		const records = await __testing.sidecarReadRecords(sidecarPath);
		const matching = records.filter((r) => r.flywheelId === "crashed-attempt");
		expect(matching).toHaveLength(1);
		expect(matching[0]?.status).toBe("finalized");
	});
});
