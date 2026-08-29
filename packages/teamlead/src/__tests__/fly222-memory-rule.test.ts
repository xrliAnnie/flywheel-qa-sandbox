/**
 * FLY-222: contract fixture for the Xiaohongshu memory-write delegation Lead
 * rule (path B). Pins the rule's load wiring + its key contract elements so a
 * future trim can't silently strip the parts the skill depends on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RULES_PATH = join(
	__dirname,
	"..",
	"..",
	"lead-rules-base",
	"xiaohongshu-memory-rules.md",
);
const SH_PATH = join(__dirname, "..", "..", "scripts", "claude-lead.sh");

describe("xiaohongshu-memory Lead rule (FLY-222 path B)", () => {
	const rules = readFileSync(RULES_PATH, "utf8");
	const sh = readFileSync(SH_PATH, "utf8");

	it("recognizes the exact request marker the skill sends", () => {
		expect(rules).toContain("[XHS-MEMORY-WRITE v1]");
		// the request envelope fields the skill emits
		for (const f of ["run_key", "collection", "op_id", "note_id"]) {
			expect(rules).toContain(f);
		}
	});

	it("writes via /api/memory/add with the Lead's own token (path B premise)", () => {
		expect(rules).toContain("/api/memory/add");
		expect(rules).toContain("$TEAMLEAD_API_TOKEN");
		expect(rules).toContain("$BRIDGE_URL");
		// Runner must NOT write memory itself — the whole point of B
		expect(rules).toMatch(/holds no Bridge[\s\S]*token/i);
	});

	it("pins the dual-bucket choice: user_id = project (shared, project-wide)", () => {
		expect(rules).toMatch(/user_id[\s\S]{0,40}project/i);
		expect(rules).toContain("shared bucket");
	});

	it("pins op_id/run_key idempotency (best-effort, at-least-once accepted)", () => {
		expect(rules).toMatch(/idempoten/i);
		expect(rules).toMatch(/memory\/search/);
		expect(rules).toMatch(/at-least-once/i);
		expect(rules).toMatch(/skip/i);
	});

	it("acks via an ordinary respond (NOT approve_to_ship / NOT --bridge-url)", () => {
		expect(rules).toMatch(/flywheel-comm respond/);
		expect(rules).toMatch(/written=\[/);
		expect(rules).toMatch(/non-`?approve_to_ship`?/i);
		// must explicitly say no founder-consent bridge-url for this reply
		expect(rules).toContain("--bridge-url");
		expect(rules).toMatch(/no founder consent/i);
	});

	it("claude-lead.sh loads the rule for dept leads, NOT cos", () => {
		expect(sh).toContain("xiaohongshu-memory-rules.md");
		// gated inside the non-cos branch: its loader appears BEFORE the cos
		// base-rules block (cos-lead-rules.md), i.e. inside `IS_COS_ROLE=false`.
		const xhsIdx = sh.indexOf("BASE_XHS_MEMORY_RULES");
		const cosIdx = sh.indexOf("BASE_COS_RULES");
		expect(xhsIdx).toBeGreaterThan(0);
		expect(cosIdx).toBeGreaterThan(0);
		expect(xhsIdx).toBeLessThan(cosIdx);
	});
});
