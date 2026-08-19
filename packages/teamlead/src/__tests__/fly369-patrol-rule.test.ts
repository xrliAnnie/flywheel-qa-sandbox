/**
 * FLY-369 follow-up: contract fixture for the Runner status-relay + proactive
 * patrol Lead rule. Pins the rule file's load wiring + its key contract elements
 * (RC-1 lifecycle relay, runner-done≠accepted, RC-2 waking-channel + commdb
 * self-containment, RC-3 patrol, RC-6 handoff) so a future trim can't silently
 * strip the parts the FLY-369 acceptance criteria depend on.
 */

import { spawnSync } from "node:child_process";
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

	it("FLY-1687: patrol_tick delegates every judgment to independent Lead-side sources", () => {
		for (const anchor of [
			"patrol_tick",
			"待核声明",
			"TMUX= tmux",
			"capture-pane",
			"TURN belt",
			"gh pr view",
			"Discord",
			"独立信源",
		]) {
			expect(patrol).toContain(anchor);
		}
		expect(patrol).toMatch(/多了少了.*finding/i);
		expect(patrol).toMatch(/纯闹钟/);
		expect(patrol).toMatch(/不采信.*Bridge|Bridge.*不是事实/);
	});

	it("FLY-1855: patrol_tick has an executable fleet scope, six-step artifact, and explicit UNAVAILABLE exit", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		for (const anchor of [
			"范围合同",
			"检测范围",
			"整机",
			"处置权限",
			"产出物合同",
			"UNAVAILABLE",
			"flywheel-patrol-snapshot",
			"REPORT_PATH",
			"three_stage_turn",
			"workflow_run_node",
			"turn_wake_outbox",
			"dead_letter_alerts",
		]) {
			expect(section0).toContain(anchor);
		}
		for (let step = 1; step <= 6; step += 1) {
			expect(section0).toMatch(new RegExp(`(?:^|\\n)${step}\\.\\s+\\*\\*`));
		}
		expect(section0.match(/run:/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
		expect(section0).toMatch(/跳过.*不留痕.*违约|禁止静默跳过/);
	});

	it("FLY-1855: Discord truth and cross-boundary disposition have exact addresses", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		expect(section0).toContain("/api/chat-threads?issueId=");
		expect(section0).toContain("fetch_messages");
		expect(section0).toContain("FLYWHEEL_ROUNDTABLE_CHANNEL_ID");
		expect(section0).toContain("FLYWHEEL_ROUNDTABLE_CONFIG_FILE");
		expect(section0).toContain("roundtable.json");
		expect(section0).not.toContain('reply(chat_id="1512578695468941333"');
		expect(section0).toContain("flywheel-eng-lead");
		expect(section0).toContain("reply(chat_id=");
		expect(section0).toContain("--config -");
		expect(section0).not.toMatch(/Authorization:\s*Bearer\s+\$\{/);
	});

	it("FLY-1855 founder increment: every canonical Runner pane has full-scrollback evidence and a closed action", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		for (const anchor of [
			"list-panes -a",
			"session_name",
			"runner-",
			"capture-pane -p -S -",
			"PANE_EVIDENCE",
			"pane_count",
			"LIMIT_LIVE",
			"STALLED_60M",
			"INTERACTIVE_MENU",
			"action=REQUIRED",
			"result=UNSET",
			"foreign-registry",
			"owner_index_incomplete",
			"comm.sessions",
			"patrol-continuity",
			"ship_parked",
			"WELL_FORMED_EVIDENCE",
		]) {
			expect(section0).toContain(anchor);
		}
		expect(section0).toContain("You've hit your session limit");
		expect(section0).toContain("You've hit your usage limit");
		expect(section0).toContain("Press Enter to confirm");
		expect(section0).toContain("flywheel-comm send");
		expect(section0).toContain("tmux send-keys");
		expect(section0).toMatch(/action=REQUIRED.*result=UNSET/s);
		expect(section0).toMatch(/PANE_COUNT.*EVIDENCE_COUNT/s);
		expect(section0).toMatch(/-CANDIDATE\$/);
	});

	it("FLY-1855: the documented completion gate accepts finalized UNAVAILABLE rows", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		const pattern = section0.match(/grep -Ec '([^']+)' "\$REPORT_PATH"/)?.[1];
		expect(pattern).toBeDefined();
		const report = [
			"STEP 1: OK",
			"STEP 2: FINDING",
			"STEP 3: UNAVAILABLE(structural: schema_missing)",
			"STEP 4: UNAVAILABLE(transient: sqlite_busy)",
			"STEP 5: OK",
			"STEP 6: FINDING",
		].join("\n");
		const result = spawnSync("grep", ["-Ec", pattern ?? ""], {
			input: `${report}\n`,
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("6");
	});

	it("FLY-1855: the documented dedupe parser accepts a healthy non-truncated response", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		const parser = section0.match(
			/TRUNCATED=.*?jq\s+(-[A-Za-z]+)\s+'([^']+)'/s,
		);
		expect(parser).not.toBeNull();
		const result = spawnSync("jq", [parser?.[1] ?? "", parser?.[2] ?? ""], {
			input: '{"issues":[],"truncated":false}\n',
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("false");
	});

	it("RC-1: every lifecycle event MUST relay to the [FLY-XX] thread via /api/chat-threads/send", () => {
		expect(patrol).toContain("/api/chat-threads/send");
		for (const ev of [
			"session_completed",
			"session_failed",
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
