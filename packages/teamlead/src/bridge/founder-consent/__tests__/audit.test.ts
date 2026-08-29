import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FounderConsentAuditRow } from "../audit.js";
import { openAuditStore, redactAuditRow } from "../audit.js";

let dir: string;
function row(
	over: Partial<FounderConsentAuditRow> = {},
): FounderConsentAuditRow {
	return {
		ts: "2026-05-28T10:00:00Z",
		evaluator_version: "v-test",
		decision_mode: "enforce",
		action: "approve",
		issue_id: "i1",
		issue_identifier: "FLY-175",
		actor_source: "http_middleware",
		decision: "allow",
		decision_source: "llm",
		llm_raw_response: "RAW SECRET",
		...over,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fca-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("FounderConsentAuditStore", () => {
	it("creates the schema idempotently and inserts + queries", () => {
		const path = join(dir, "audit.db");
		const s1 = openAuditStore(path);
		s1.insert(row({ issue_identifier: "FLY-1" }));
		s1.insert(row({ issue_identifier: "FLY-1" }));
		s1.close();
		// Re-open (idempotent CREATE TABLE IF NOT EXISTS) — data persists.
		const s2 = openAuditStore(path);
		const rows = s2.queryByIssue("FLY-1", 10);
		expect(rows).toHaveLength(2);
		expect(s2.queryRecent(10)).toHaveLength(2);
		s2.close();
	});

	it("queryRecent respects the limit", () => {
		const s = openAuditStore(join(dir, "a.db"));
		for (let i = 0; i < 5; i++)
			s.insert(row({ ts: `2026-05-28T10:0${i}:00Z` }));
		expect(s.queryRecent(3)).toHaveLength(3);
		s.close();
	});

	it("stores all NOT-NULL columns + nullable context", () => {
		const s = openAuditStore(join(dir, "a.db"));
		const id = s.insert(
			row({ confidence: 0.91, comm_question_id: "q-1", pr_head_sha: "sha" }),
		);
		expect(id).toBeGreaterThan(0);
		const got = s.queryRecent(1)[0] as Record<string, unknown>;
		expect(got.confidence).toBe(0.91);
		expect(got.comm_question_id).toBe("q-1");
		expect(got.pr_head_sha).toBe("sha");
		s.close();
	});
});

describe("redactAuditRow", () => {
	it("redacts llm_raw_response, keeps structured fields", () => {
		const redacted = redactAuditRow({
			decision: "allow",
			llm_raw_response: "RAW SECRET",
			confidence: 0.9,
		});
		expect(redacted.decision).toBe("allow");
		expect(redacted.confidence).toBe(0.9);
		expect(redacted.llm_raw_response).toBe("[redacted]");
	});

	it("keeps null llm_raw_response as null", () => {
		expect(
			redactAuditRow({ llm_raw_response: null }).llm_raw_response,
		).toBeNull();
	});
});
