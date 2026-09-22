import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EvidenceLog } from "../evidence.js";

describe("EvidenceLog", () => {
	it("fsyncs private JSONL", () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-evidence-"));
		try {
			const path = join(root, "voice-evidence", "events.jsonl");
			new EvidenceLog(path).append({
				kind: "session_live",
				ts: "2026-09-09T00:00:00.000Z",
			});
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
				kind: "session_live",
			});
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	it("batches packet diagnostics without fsyncing each record", () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-evidence-"));
		try {
			const path = join(root, "voice-evidence", "events.jsonl");
			let fsyncCalls = 0;
			const evidence = new EvidenceLog(path, {
				fsync: () => {
					fsyncCalls += 1;
				},
			});
			for (let packet = 0; packet < 64; packet += 1) {
				evidence.appendBuffered({
					kind: "discord_dave_diagnostic",
					packet,
				});
			}

			vi.advanceTimersByTime(250);
			expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(64);
			expect(fsyncCalls).toBe(0);

			evidence.append({ kind: "session_failed" });
			expect(fsyncCalls).toBe(1);
		} finally {
			vi.useRealTimers();
			rmSync(root, { recursive: true });
		}
	});

	it("flushes buffered records before a second writer appends durably", () => {
		vi.useFakeTimers();
		const root = mkdtempSync(join(tmpdir(), "flywheel-voice-evidence-"));
		try {
			const path = join(root, "voice-evidence", "events.jsonl");
			const diagnostics = new EvidenceLog(path);
			const delivery = new EvidenceLog(path);

			diagnostics.appendBuffered({
				kind: "discord_dave_diagnostic",
				ts: "2026-09-18T00:00:00.000Z",
			});
			delivery.append({
				kind: "realtime_transcript",
				ts: "2026-09-18T00:00:00.001Z",
			});
			vi.advanceTimersByTime(250);

			const records = readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(records.map((record) => record.kind)).toEqual([
				"discord_dave_diagnostic",
				"realtime_transcript",
			]);
		} finally {
			vi.useRealTimers();
			rmSync(root, { recursive: true });
		}
	});
});
