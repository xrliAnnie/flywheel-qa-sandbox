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

	it("FLY-2080: patrol goal is aggressive Ship-card progress, with founder wording pinned", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		for (const anchor of [
			"巡检的 goal",
			"把 orchestrator 一直推到每个 issue 最后到达 Ship card",
			"有真正的问题必须要我来回答",
			"我把事情派给你之后,我就可以去休息了",
			"这个东西已经推进到我可以 review 的状态",
			"自己去 identify 发现了什么问题,把漏的账补上,让 Bridge 继续操作",
			"让所有的巡检都带上这两个步骤",
		]) {
			expect(section0).toContain(anchor);
		}
		expect(section0).toMatch(/步骤 A.*发现即补账推进/s);
		expect(section0).toMatch(/步骤 B.*记录进病根 Epic/s);
	});

	it("FLY-2080: guard classification, truth boundaries, and both executable recipes are complete", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		for (const anchor of [
			"错误码",
			"WHERE",
			"防篡改",
			"防漏账",
			"digest",
			"head fingerprint",
			"approval",
			"claim",
			"workflow_rework_delivery",
			"workflow_run_node",
			"workflow_rework_verification_path",
			"workflow_rework_route_revision",
			"workflow_carrier_delivery",
			"delivery_awaiting_receipt",
			"wake_delivered",
			"hold_count",
			"rework_delivery_wake_delivered",
			"workflow_side_effect_ledger",
			"rework_replacement:",
			"replacement_pending",
			"edge_traversed",
			"loop_iteration",
			"loop_limit_escalated",
			"resolveWorkflowHeadAuthority",
			"engine_predecessor_unavailable",
			"targetNodeId",
			"sourceAttempt",
			"loopIteration",
			"BEGIN IMMEDIATE",
			"PRAGMA foreign_keys=ON",
			"PRAGMA busy_timeout=5000",
		]) {
			expect(section0).toContain(anchor);
		}
		expect(section0).toMatch(/held.*wake_delivered.*held.*active/s);
		expect(section0).toMatch(/pane|workflow_run_event/);
		expect(section0).toMatch(/引擎.*接力|Bridge.*接力/);
		// A repair-authored event proves only that sqlite committed, never that
		// Bridge reconciled the run. Handoff evidence must exclude those rows.
		expect(section0).toContain("e.event_uid NOT LIKE 'patrol:FLY-2080:%'");
	});

	it("FLY-2094: predecessor repair omits maxIterations for an unbounded loop", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		expect(section0).toContain("MAX_ITERATIONS_OR_NULL");
		expect(section0).toContain("<MAX_ITERATIONS_OR_NULL> max_iterations");
		expect(section0).toMatch(
			/CASE WHEN max_iterations IS NULL\s+THEN json_object\('iteration',loop_iteration\)\s+ELSE json_object\('iteration',loop_iteration,'maxIterations',max_iterations\) END/s,
		);
		expect(section0).not.toContain("<MAX_ITERATIONS> max_iterations");
	});

	it("FLY-2080: every Bridge finding has a verified FLY-2072 marker receipt", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		const stepB = section0.slice(
			section0.indexOf("步骤 B — 记录进病根 Epic"),
			section0.indexOf("每个 distinct finding 最后追加一行"),
		);
		for (const anchor of [
			"FLY-2072",
			"形状",
			"根因",
			"处置",
			"是否重复",
			"patrol-finding:",
			"epic_marker",
			"UNAVAILABLE_CAUSE",
		]) {
			expect(section0).toContain(anchor);
		}
		expect(stepB).toContain("/api/linear/comments?issueId=FLY-2072&limit=100");
		expect(stepB).toContain("mcp__linear-api__list_issues");
		expect(stepB).toContain("mcp__linear-api__save_issue");
		expect(stepB).toContain("mcp__linear-api__save_comment");
		expect(stepB).toContain("class_key:<ROOT_KEY>");
		expect(stepB).toContain("occurrences: 1");
		expect(stepB).toContain("二十余条旧 comment");
		expect(stepB).toContain("/api/linear/issue");
		expect(stepB).toContain('--data-urlencode "query=$CHILD_IDENTIFIER"');
		expect(stepB).toContain("CHILD_UUID");
		expect(stepB).toContain('.matchType == "identifier"');
		expect(stepB).toContain(".issue.id");
		expect(stepB).not.toContain('get_issue({id:"FLY-2072"');
		expect(stepB).not.toContain("POST /api/linear/comment");
		expect(stepB).not.toContain(
			"/api/linear/comments?issueId=FLY-2072&projectName=",
		);
	});

	it("FLY-2080: root-class dedupe re-reads full child descriptions before matching", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		const stepB = section0.slice(
			section0.indexOf("步骤 B — 记录进病根 Epic"),
			section0.indexOf("每个 distinct finding 最后追加一行"),
		);

		// list_issues truncates long descriptions in production. Pagination finds
		// candidate ids; only a get_issue read is authoritative for class_key.
		expect(stepB).toMatch(
			/list_issues[\s\S]*hasNextPage=false[\s\S]*get_issue\(\{id:"<candidate child identifier>"\}\)[\s\S]*完整 description[\s\S]*class_key:<ROOT_KEY>/,
		);
		expect(stepB).toContain(
			'description: "class_key:<ROOT_KEY>\\n形状: <错误码/卡点/结构形状>',
		);
		expect(stepB).toContain("team=`Flywheel`");
		expect(stepB).not.toContain("team=`FLY`");

		const rootKey = "a".repeat(64);
		const fullDescription = `${"x".repeat(532)}\nclass_key:${rootKey}`;
		const listIssue = {
			id: "FLY-2081",
			description: `${fullDescription.slice(0, 475)}(truncated, use get_issue…)`,
		};
		const getIssue = { ...listIssue, description: fullDescription };
		expect(listIssue.description.length).toBeGreaterThanOrEqual(500);
		expect(listIssue.description).not.toContain(`class_key:${rootKey}`);
		expect(getIssue.description).toContain(`class_key:${rootKey}`);
	});

	it("FLY-2080: the documented FINDING gate requires UUID receipts for both issue and comment records", () => {
		const section0 = patrol.slice(
			patrol.indexOf("## 0."),
			patrol.indexOf("## 1."),
		);
		const program = section0.match(
			/# FLY-2080-FINDING-GATE-BEGIN\nawk '\n([\s\S]*?)\n' "\$REPORT_PATH"\n# FLY-2080-FINDING-GATE-END/,
		)?.[1];
		expect(program).toBeDefined();
		// Keep the embedded awk portable: gawk/mawk reject a parameter whose
		// name collides with another user-defined function.
		expect(program).not.toMatch(/function (?:uuid|hex64)\(value(?:,|\))/);

		const marker = "a".repeat(64);
		const childUuid = "5914cef5-05bf-45a3-be14-edbc858147a2";
		const commentUuid = "123e4567-e89b-12d3-a456-426614174000";
		const run = (lines: string[]) =>
			spawnSync("awk", [program ?? ""], {
				input: `${lines.join("\n")}\n`,
				encoding: "utf8",
			});
		const valid = [
			"STEP 1: FINDING",
			`FINDING step=1 bridge_problem=yes result=fixed evidence=event:101 owner=n/a next=n/a epic=FLY-2072#${childUuid} epic_marker=${marker}`,
			"STEP 2: FINDING",
			"PANE_EVIDENCE pane=p1 result=clear",
			"FINDING step=2 bridge_problem=no result=advanced evidence=pane:changed owner=n/a next=n/a epic=n/a epic_marker=n/a",
			"STEP 3: FINDING",
			`FINDING step=3 bridge_problem=yes result=escalated-with-plan evidence=guard:digest owner=founder next=authorize:run-123 epic=FLY-2072#${commentUuid} epic_marker=${marker}`,
		];
		expect(run(valid).status).toBe(0);

		expect(
			run(
				valid.map((line) =>
					line.replace("result=advanced", "result=known-waiting"),
				),
			).status,
		).not.toBe(0);
		expect(
			run(
				valid.map((line) =>
					line.replace(`epic_marker=${marker}`, "epic_marker=n/a"),
				),
			).status,
		).not.toBe(0);
		expect(run(["STEP 4: FINDING"]).status).not.toBe(0);
		expect(
			run(
				valid.map((line) =>
					line.replace(`epic=FLY-2072#${childUuid}`, "epic=FLY-2072#FLY-2081"),
				),
			).status,
		).not.toBe(0);
		expect(
			run(
				valid.map((line) =>
					line.replace(
						"owner=founder next=authorize:run-123",
						"owner=tbd next=tbd",
					),
				),
			).status,
		).not.toBe(0);

		const unavailable = [
			"STEP 1: FINDING",
			"STEP 6: UNAVAILABLE(transient: linear_epic_unavailable)",
			"UNAVAILABLE_CAUSE step=6 class=transient token=linear_epic_unavailable",
			"FINDING step=1 bridge_problem=yes result=escalated-with-plan evidence=linear:down owner=agent:flywheel-eng-lead next=retry:linear-comment epic=unavailable epic_marker=n/a",
		];
		expect(run(unavailable).status).toBe(0);
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

	it("claude-lead.sh keeps runner-patrol on dispatch-capable department Leads", () => {
		expect(sh).toContain("runner-patrol-rules.md");
		const patrolIdx = sh.indexOf("BASE_PATROL_RULES");
		const cosIdx = sh.indexOf("BASE_COS_RULES");
		const founderTimeIdx = sh.indexOf("BASE_FOUNDER_LOCAL_TIME_RULES");
		expect(patrolIdx).toBeGreaterThan(0);
		// The block lives after role-specific rules but must retain the CoS
		// exclusion: CoS has canSpawnRunners=false and receives no patrol_tick.
		expect(patrolIdx).toBeGreaterThan(cosIdx);
		expect(patrolIdx).toBeLessThan(founderTimeIdx);
		const patrolBlock = sh.slice(patrolIdx, founderTimeIdx);
		expect(patrolBlock).toContain('IS_COS_ROLE" != true');
		expect(patrolBlock).toContain('IS_COMPANION_ROLE" != true');
		expect(patrolBlock).toContain('IS_EXTERNAL_ROLE" != true');
	});

	it("README base-rules table lists runner-patrol-rules.md (anti-drift)", () => {
		expect(readme).toContain("runner-patrol-rules.md");
	});
});
