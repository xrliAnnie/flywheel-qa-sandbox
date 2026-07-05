/**
 * FLY-369 follow-up: contract fixture for the Runner status-relay + proactive
 * patrol Lead rule. Pins the rule file's load wiring + its key contract elements
 * (RC-1 lifecycle relay, runner-done≠accepted, RC-2 waking-channel + commdb
 * self-containment, RC-3 patrol, RC-6 handoff) so a future trim can't silently
 * strip the parts the FLY-369 acceptance criteria depend on.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BASE = join(__dirname, "..", "..", "lead-rules-base");
const PATROL_PATH = join(BASE, "runner-patrol-rules.md");
const MSG_PATH = join(BASE, "runner-messaging-rules.md");
const README_PATH = join(BASE, "README.md");
const SH_PATH = join(__dirname, "..", "..", "scripts", "claude-lead.sh");

describe("runner-patrol Lead rule (FLY-369 follow-up)", () => {
	const patrol = readFileSync(PATROL_PATH, "utf8");
	const msg = readFileSync(MSG_PATH, "utf8");
	const readme = readFileSync(README_PATH, "utf8");
	const sh = readFileSync(SH_PATH, "utf8");

	it("RC-3: proactive patrol uses runner_terminal_list as the sweep starting point (NOT an acceptance oracle)", () => {
		expect(patrol).toContain("runner_terminal_list");
		expect(patrol).toContain("parked-alive");
		// it must say the list is a starting point / not proof of acceptance
		expect(patrol).toMatch(/acceptance oracle|not.*proof|起点|starting point/i);
		// cross-check required before close/reopen/status change
		expect(patrol).toMatch(/cross-check/i);
		expect(patrol).toMatch(/PR\/commit|commit evidence|PR\/commit evidence/i);
	});

	it("RC-3: patrol is a discipline, the automation engine is out of scope (FLY-271 / FLY-368)", () => {
		expect(patrol).toContain("FLY-271");
		expect(patrol).toContain("FLY-368");
		expect(patrol).toMatch(/discipline,\s+not\s+a\s+guarantee/i);
	});

	it("RC-1: every lifecycle event MUST relay to the [FLY-XX] thread via /api/chat-threads/send", () => {
		expect(patrol).toContain("/api/chat-threads/send");
		for (const ev of [
			"session_completed",
			"session_failed",
			"runner_stuck_escalation",
			"runner_question",
		]) {
			expect(patrol).toContain(ev);
		}
		// it must frame relay as mandatory / a checklist, not optional
		expect(patrol).toMatch(/mandatory|checklist|MUST/i);
	});

	it("RC-1: runner-delivered ≠ acceptance-met ≠ OK-to-mark-Done (FLY-576 lesson)", () => {
		expect(patrol).toContain("FLY-576");
		expect(patrol).toMatch(/acceptance/i);
		// must explicitly forbid reporting Linear-Done as accepted
		expect(patrol).toMatch(
			/not an acceptance signal|not.*accept|Never report/i,
		);
		// the manual proxy is allowed ONLY for an explicit acceptance/founder correction
		expect(patrol).toContain("/api/linear/update-issue");
	});

	it("RC-2: drive a parked runner with a WAKING channel, never respond for non-gate", () => {
		expect(patrol).toMatch(/SendMessage|flywheel-comm send/);
		expect(patrol).toMatch(/respond.*gate answers only|gate answers only/i);
		// must warn respond silently fails to wake a non-gate
		expect(patrol).toMatch(
			/silently fail|does \*\*not\*\* (write the )?mailbox|不.*唤醒/i,
		);
	});

	it("RC-2: the rule is self-contained for the commdb rollback path (does not rely on runner-messaging-rules.md being loaded)", () => {
		// Codex R2 non-blocking ask: pin the commdb/legacy-send self-contained
		// content so it can't regress to a bare runner-messaging-rules.md pointer.
		expect(patrol).toContain("commdb");
		expect(patrol).toMatch(
			/legacy.*flywheel-comm send|flywheel-comm send.*legacy/i,
		);
		expect(patrol).toMatch(/self-contained|stands on its own|without it/i);
	});

	it("RC-6: continuation/handoff runner must read the committed plan + the Lead verifies brainstorm alignment", () => {
		expect(patrol).toMatch(/committed plan/i);
		expect(patrol).toMatch(/brainstorm/i);
		expect(patrol).toMatch(/rubber-stamp|verify.*align|align.*greenlight/i);
		expect(patrol).toContain("FLY-350");
	});

	it("runner-messaging-rules.md carries the authoritative parked-runner waking-channel rule + wake matrix", () => {
		expect(msg).toMatch(/parked|idle runner/i);
		expect(msg).toMatch(/SendMessage|flywheel-comm send/);
		// must say respond does NOT wake a non-gate (the footgun)
		expect(msg).toMatch(/respond/i);
		expect(msg).toMatch(/wake/i);
		// the matrix must keep the Codex marker-bearing no-block gate wake row
		expect(msg).toMatch(/marker/i);
	});

	it("claude-lead.sh loads runner-patrol for dept leads (non-cos), in monotonic order after reengage", () => {
		expect(sh).toContain("runner-patrol-rules.md");
		const patrolIdx = sh.indexOf("BASE_PATROL_RULES");
		const reengageIdx = sh.indexOf("BASE_REENGAGE_RULES");
		const cosIdx = sh.indexOf("BASE_COS_RULES");
		expect(patrolIdx).toBeGreaterThan(0);
		// dept-only: appears before the cos base-rules block
		expect(patrolIdx).toBeLessThan(cosIdx);
		// loaded after reengage (matches the resolver's pinned order)
		expect(patrolIdx).toBeGreaterThan(reengageIdx);
	});

	it("README base-rules table lists runner-patrol-rules.md (anti-drift)", () => {
		expect(readme).toContain("runner-patrol-rules.md");
	});
});
