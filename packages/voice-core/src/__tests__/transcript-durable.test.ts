import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlTranscriptSink, MemoryTranscriptSink } from "../transcript.js";
import type { DurableTranscriptEntry } from "../types.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

function durableEntry(
	over: Partial<DurableTranscriptEntry> = {},
): DurableTranscriptEntry {
	return {
		ts: "2026-09-23T20:00:00.000Z",
		timestamp: "2026-09-23T20:00:00.000Z",
		transcriptId: "transcript-1",
		utteranceId: "utterance-1",
		sessionId: "session-1",
		generation: 1,
		sequence: 1,
		backendId: "fake-v1",
		source: "room",
		face: "converse",
		role: "user",
		text: "请让 Peter 查一下最新 CI。",
		final: true,
		attribution: {
			kind: "known",
			speakerUserId: "founder-1",
			speakerName: "Annie",
		},
		...over,
	};
}

describe("durable transcript receipts", () => {
	it("waits for persistence and can verify the same receipt after restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voice-transcript-durable-"));
		dirs.push(dir);
		const file = join(dir, "nested", "session.jsonl");
		const sink = new JsonlTranscriptSink(file);
		const receipt = await sink.appendDurable(durableEntry());
		expect(receipt).toMatchObject({
			version: 1,
			durable: true,
			sessionId: "session-1",
			transcriptId: "transcript-1",
			contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});

		const reopened = new JsonlTranscriptSink(file);
		await expect(
			reopened.readReceipt("session-1", "transcript-1", receipt.contentDigest),
		).resolves.toEqual(receipt);
	});

	it("reuses an identical identity and rejects the same identity with changed content", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voice-transcript-idempotent-"));
		dirs.push(dir);
		const file = join(dir, "session.jsonl");
		const sink = new JsonlTranscriptSink(file);
		const first = await sink.appendDurable(durableEntry());
		await expect(sink.appendDurable(durableEntry())).resolves.toEqual(first);
		await expect(
			sink.appendDurable(durableEntry({ text: "另一句话" })),
		).rejects.toThrow("transcript_identity_conflict");
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("keeps equal sentences with different transcript identities and rejects partials", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voice-transcript-distinct-"));
		dirs.push(dir);
		const file = join(dir, "session.jsonl");
		const sink = new JsonlTranscriptSink(file);
		await sink.appendDurable(durableEntry());
		await sink.appendDurable(
			durableEntry({
				transcriptId: "transcript-2",
				utteranceId: "utterance-2",
				sequence: 2,
			}),
		);
		await expect(
			sink.appendDurable(
				durableEntry({ transcriptId: "partial", final: false }),
			),
		).rejects.toThrow("transcript_durable_entry_invalid");
		expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("does not claim a receipt when a restarted file has a corrupt tail", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voice-transcript-corrupt-"));
		dirs.push(dir);
		const file = join(dir, "session.jsonl");
		const sink = new JsonlTranscriptSink(file);
		const receipt = await sink.appendDurable(durableEntry());
		appendFileSync(file, '{"truncated":');

		const reopened = new JsonlTranscriptSink(file);
		await expect(
			reopened.readReceipt("session-1", "transcript-1", receipt.contentDigest),
		).rejects.toThrow("transcript_tail_corrupt");
	});

	it("rejects durable writes instead of converting a filesystem failure into a receipt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voice-transcript-write-fail-"));
		dirs.push(dir);
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const sink = new JsonlTranscriptSink(
			join(blocker, "session.jsonl"),
			() => {},
		);
		await expect(sink.appendDurable(durableEntry())).rejects.toThrow();
	});

	it("marks memory receipts non-durable", async () => {
		const sink = new MemoryTranscriptSink();
		await expect(sink.appendDurable(durableEntry())).resolves.toMatchObject({
			durable: false,
			sessionId: "session-1",
			transcriptId: "transcript-1",
		});
	});
});
