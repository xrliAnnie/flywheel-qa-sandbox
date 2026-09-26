import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlTranscriptSink, MemoryTranscriptSink } from "../transcript.js";
import type { TranscriptEntry } from "../types.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
	return {
		ts: "2026-07-06T00:00:00.000Z",
		sessionId: "sid",
		backendId: "edge-tts",
		face: "announce",
		role: "assistant",
		text: "早会开始",
		final: true,
		...over,
	};
}

describe("JsonlTranscriptSink", () => {
	it("appends one JSON object per line (with face) and creates missing dirs", () => {
		const dir = mkdtempSync(join(tmpdir(), "voice-transcript-"));
		dirs.push(dir);
		const file = join(dir, "nested", "session.jsonl");
		const sink = new JsonlTranscriptSink(file);
		sink.append(
			entry({ face: "announce", role: "assistant", text: "播报内容" }),
		);
		sink.append(
			entry({
				face: "converse",
				backendId: "gemini-live",
				role: "user",
				text: "你好",
			}),
		);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toMatchObject({
			face: "announce",
			role: "assistant",
		});
		expect(JSON.parse(lines[1])).toMatchObject({
			face: "converse",
			role: "user",
			backendId: "gemini-live",
		});
	});
});

describe("MemoryTranscriptSink", () => {
	it("collects entries in order", () => {
		const sink = new MemoryTranscriptSink();
		sink.append(entry({ text: "a" }));
		sink.append(entry({ text: "b" }));
		expect(sink.entries.map((e) => e.text)).toEqual(["a", "b"]);
	});
});
