import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceDelivery } from "../delivery.js";
import { SessionJournal } from "../journal.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function journal() {
	const root = mkdtempSync(join(tmpdir(), "flywheel-voice-journal-"));
	roots.push(root);
	return {
		path: join(root, "sessions", "session-a", "journal.jsonl"),
		journal: new SessionJournal(
			join(root, "sessions", "session-a", "journal.jsonl"),
		),
	};
}

describe("SessionJournal", () => {
	it("appends fsynced JSONL in a private file and folds pending transcripts", () => {
		const { path, journal: wal } = journal();
		wal.append({
			kind: "captured",
			transcriptId: "t1",
			safeText: "hello",
			nonce: "n1",
		});
		wal.append({ kind: "mirror_requested", transcriptId: "t1" });
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(wal.pending()).toEqual([
			expect.objectContaining({
				transcriptId: "t1",
				stage: "mirror_requested",
			}),
		]);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
	});
});

describe("VoiceDelivery", () => {
	it("scrubs before every durable or external boundary and ingests only the mirrored id", async () => {
		const { path, journal: wal } = journal();
		const mirror = vi.fn(async () => ({ messageId: "discord-1" }));
		const ingest = vi.fn(async () => ({
			lane: "inserted_inbox" as const,
			deliveryId: "chat:raya:discord-1",
		}));
		const evidence = vi.fn();
		const delivery = new VoiceDelivery({
			sessionId: "session-a",
			leadId: "raya",
			threadId: "thread-a",
			founderUserId: "founder-a",
			journal: wal,
			assertLease: () => {},
			mirror,
			ingest,
			readDelivery: vi.fn(),
			status: vi.fn(),
			evidence,
		});
		expect(
			await delivery.capture({
				transcriptId: "t1",
				speakerUserId: "founder-a",
				speakerName: "Annie",
				rawText: "token sk-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG",
				ts: "2026-09-09T00:00:00.000Z",
			}),
		).toBe(true);
		const disk = readFileSync(path, "utf8");
		expect(disk).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
		expect(mirror).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("[redacted]"),
				nonce: expect.stringMatching(/^[0-9a-z]{1,25}$/),
			}),
		);
		expect(ingest).toHaveBeenCalledWith(
			expect.objectContaining({
				messageId: "discord-1",
				authorId: "founder-a",
			}),
		);
		expect(evidence).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "realtime_transcript",
				role: "user",
				generation: 1,
			}),
		);
		expect(wal.pending()).toEqual([]);
	});

	it("retries an unknown mirror with the same nonce and fences recovery before effects", async () => {
		const { journal: wal } = journal();
		const mirror = vi
			.fn()
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce({ messageId: "discord-1" });
		const delivery = new VoiceDelivery({
			sessionId: "session-a",
			leadId: "raya",
			threadId: "thread-a",
			founderUserId: "founder-a",
			journal: wal,
			assertLease: () => {},
			mirror,
			ingest: vi.fn(async () => ({ lane: "inserted_inbox", deliveryId: "d1" })),
			readDelivery: vi.fn(),
			status: vi.fn(),
			evidence: vi.fn(),
			mirrorRetries: 1,
		});
		await delivery.capture({
			transcriptId: "t1",
			speakerUserId: "founder-a",
			speakerName: "Annie",
			rawText: "hello",
			ts: "2026-09-09T00:00:00.000Z",
		});
		expect(mirror.mock.calls[0]?.[0].nonce).toBe(
			mirror.mock.calls[1]?.[0].nonce,
		);

		const fenced = journal().journal;
		fenced.append({
			kind: "captured",
			transcriptId: "t2",
			safeText: "safe",
			nonce: "n2",
			speakerUserId: "founder-a",
			speakerName: "Annie",
			ts: "2026-09-09T00:00:00.000Z",
		});
		const noMirror = vi.fn();
		const noStatus = vi.fn();
		const recovery = new VoiceDelivery({
			sessionId: "session-a",
			leadId: "raya",
			threadId: "thread-a",
			founderUserId: "founder-a",
			journal: fenced,
			assertLease: () => {
				throw new Error("voice_lease_fenced");
			},
			mirror: noMirror,
			ingest: vi.fn(),
			readDelivery: vi.fn(),
			status: noStatus,
			evidence: vi.fn(),
		});
		expect(await recovery.recover()).toBe(1);
		expect(noMirror).not.toHaveBeenCalled();
		expect(noStatus).not.toHaveBeenCalled();
		expect(fenced.pending()).toEqual([]);
	});

	it("abandons an unknown mirror outside the nonce retry window", async () => {
		const { journal: wal } = journal();
		wal.append({
			kind: "captured",
			transcriptId: "old",
			safeText: "hello",
			nonce: "nonceold",
			speakerUserId: "founder-a",
			speakerName: "Annie",
			ts: "2026-09-09T00:00:00.000Z",
		});
		wal.append({
			kind: "mirror_requested",
			transcriptId: "old",
			ts: "2026-09-09T00:00:01.000Z",
		});
		const mirror = vi.fn();
		const status = vi.fn();
		const recovery = new VoiceDelivery({
			sessionId: "session-a",
			leadId: "raya",
			threadId: "thread-a",
			founderUserId: "founder-a",
			journal: wal,
			assertLease: () => {},
			mirror,
			ingest: vi.fn(),
			readDelivery: vi.fn(),
			status,
			evidence: vi.fn(),
			mirrorRetryWindowMs: 60_000,
			now: () => new Date("2026-09-09T00:02:00.000Z"),
		});
		expect(await recovery.recover()).toBe(1);
		expect(mirror).not.toHaveBeenCalled();
		expect(status).toHaveBeenCalledWith("📻 有一句可能没送到,请再说一遍");
		expect(wal.records().at(-1)).toMatchObject({
			kind: "abandoned",
			reason: "mirror_unknown",
		});
	});

	it("retries a transient mailbox ingest with the same mirrored identity", async () => {
		const { journal: wal } = journal();
		const ingest = vi
			.fn()
			.mockRejectedValueOnce(new Error("busy"))
			.mockResolvedValueOnce({ lane: "inserted_inbox", deliveryId: "d1" });
		const retryDelay = vi.fn(async () => {});
		const delivery = new VoiceDelivery({
			sessionId: "session-a",
			leadId: "raya",
			threadId: "thread-a",
			founderUserId: "founder-a",
			journal: wal,
			assertLease: () => {},
			mirror: vi.fn(async () => ({ messageId: "discord-1" })),
			ingest,
			readDelivery: vi.fn(),
			status: vi.fn(),
			evidence: vi.fn(),
			ingestRetries: 1,
			retryDelay,
		});
		await delivery.capture({
			transcriptId: "retry",
			speakerUserId: "founder-a",
			speakerName: "Annie",
			rawText: "hello",
			ts: "2026-09-09T00:00:00.000Z",
		});
		expect(ingest).toHaveBeenCalledTimes(2);
		expect(ingest.mock.calls[0]?.[0]).toEqual(ingest.mock.calls[1]?.[0]);
		expect(retryDelay).toHaveBeenCalledOnce();
		expect(wal.pending()).toEqual([]);
	});

	it("fences a live capture without mirror or status side effects", async () => {
		const { journal: wal } = journal();
		const mirror = vi.fn();
		const status = vi.fn();
		const delivery = new VoiceDelivery({
			sessionId: "session-a",
			leadId: "raya",
			threadId: "thread-a",
			founderUserId: "founder-a",
			journal: wal,
			assertLease: () => {
				throw new Error("voice_lease_fenced");
			},
			mirror,
			ingest: vi.fn(),
			readDelivery: vi.fn(),
			status,
			evidence: vi.fn(),
			mirrorRetries: 2,
		});
		await delivery.capture({
			transcriptId: "t-fenced",
			speakerUserId: "founder-a",
			speakerName: "Annie",
			rawText: "hello",
			ts: "2026-09-09T00:00:00.000Z",
		});
		expect(mirror).not.toHaveBeenCalled();
		expect(status).not.toHaveBeenCalled();
		expect(wal.pending()).toEqual([]);
		expect(wal.records().at(-1)).toMatchObject({ kind: "fenced" });
	});

	it("bounds mirrored speech before Discord's message limit", async () => {
		const { journal: wal } = journal();
		const mirror = vi.fn(async () => ({ messageId: "discord-1" }));
		const delivery = new VoiceDelivery({
			sessionId: "session-a",
			leadId: "raya",
			threadId: "thread-a",
			founderUserId: "founder-a",
			journal: wal,
			assertLease: () => {},
			mirror,
			ingest: vi.fn(async () => ({ lane: "inserted_inbox", deliveryId: "d1" })),
			readDelivery: vi.fn(),
			status: vi.fn(),
			evidence: vi.fn(),
		});
		await delivery.capture({
			transcriptId: "long",
			speakerUserId: "founder-a",
			speakerName: "**Annie**",
			rawText: "语".repeat(3_000),
			ts: "2026-09-09T00:00:00.000Z",
		});
		const mirrored = mirror.mock.calls[0]?.[0].text ?? "";
		expect(Array.from(mirrored).length).toBeLessThanOrEqual(1_900);
		expect(mirrored).toContain("**Annie**");
	});
});
