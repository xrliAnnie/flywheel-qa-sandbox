import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
});
