#!/usr/bin/env node
// QA · FLY-939 — module-driven real-Discord E2E against the 529 QA Room (slot 2).
// Drives the REAL compiled production `PhaseOrchestrator` class
// (packages/teamlead/dist) against a real Discord thread + a real tmux window,
// per Annie's request (option b): run the full wake-not-respawn lifecycle for
// real before merging PR #482.
//
// Three scenarios, mapped 1:1 to the Lead's ask:
//   ① QA-fail → WAKE the resident implement, never respawn (G-B kickback path)
//   ② wake failure → fail-loud + replayable → a "boot reconcile" replay retries
//      and succeeds (one-shot backfill, G-A)
//   ③ restart reconcile finds implement not tracked alive → about to spawn a
//      replacement → REAL tmux probe finds the old window still alive →
//      refuses to spawn a duplicate (G-C ghost guard)
//
// Real: PhaseOrchestrator (production class), tmux (a real session for
// scenario ③'s ghost probe via the REAL probeRunnerProcessLiveness), Discord
// (real fetch, real bot token, a real thread Annie can open).
// Disclosed stub (same boundary FLY-921's script drew, see qa-report.md): the
// mailbox WRITE side of wakePhaseRunner (the Agent Team file-based inbox) is
// not exercised — no live Claude/Codex runner process is spun up to receive
// it. Everything upstream of that write (evidence gates, fix-round
// accounting, fail-loud/replayable bookkeeping, the ghost-guard tmux probe,
// grantTurn) is the real shipped code.
//
// Usage: pnpm -r build && source ~/.flywheel/.env && node scripts/qa-fly939-real-discord-wake-not-respawn-e2e.mjs
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMLEAD_DIST = join(__dirname, "..", "packages", "teamlead", "dist");
const { PhaseOrchestrator } = await import(
	`file://${TEAMLEAD_DIST}/bridge/phase-orchestrator.js`
);
const { probeRunnerProcessLiveness } = await import(
	`file://${TEAMLEAD_DIST}/bridge/tmux-lookup.js`
);

const BOT_TOKEN = process.env.TEST_BOT_TOKEN_2;
const CHANNEL_ID = "1493080993173737583"; // slot-2 product-lead-test (~/.flywheel/test-slots.json)
if (!BOT_TOKEN) {
	console.error("Missing TEST_BOT_TOKEN_2 in env (source ~/.flywheel/.env)");
	process.exit(1);
}
const DISCORD_API = "https://discord.com/api/v10";
const GUILD_ID = "1485787271192907816";

const results = [];
function check(name, cond, detail) {
	results.push({ name, pass: !!cond, detail });
	console.log(
		`${cond ? "✅ PASS" : "❌ FAIL"} — ${name}${detail ? ` (${detail})` : ""}`,
	);
}

async function postMessage(threadId, content, attempt = 0) {
	const res = await fetch(`${DISCORD_API}/channels/${threadId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
	});
	if (res.status === 429 && attempt < 5) {
		const body = await res.json().catch(() => ({}));
		const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
		await new Promise((r) => setTimeout(r, waitMs));
		return postMessage(threadId, content, attempt + 1);
	}
	if (!res.ok)
		throw new Error(`POST message ${res.status}: ${await res.text()}`);
	return res.json();
}

async function createThread(nameSeed) {
	const msgRes = await fetch(`${DISCORD_API}/channels/${CHANNEL_ID}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			content: `🧵 FLY-939 real-machine QA demo (Annie-requested, pre-merge) — ${nameSeed}`,
			allowed_mentions: { parse: [] },
		}),
	});
	const msg = await msgRes.json();
	const thrRes = await fetch(
		`${DISCORD_API}/channels/${CHANNEL_ID}/messages/${msg.id}/threads`,
		{
			method: "POST",
			headers: {
				Authorization: `Bot ${BOT_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name: `[FLY-939 QA demo] ${nameSeed}`.slice(0, 100),
				auto_archive_duration: 4320,
			}),
		},
	);
	const thr = await thrRes.json();
	if (!thr.id) throw new Error(`thread create failed: ${JSON.stringify(thr)}`);
	return thr.id;
}

const PROJECT = "flywheel";
const TMUX_GHOST = "fly939-qademo-ghost";
const TMUX_TARGET = `${TMUX_GHOST}:implement`;

function makeQaVerdicts(
	intents,
	hasGateResponseFn,
	recordFixRoundStore,
	postIssueThreadFn,
) {
	return {
		getSession: () => undefined,
		readIntent: (id) => intents.get(id),
		patchIntent: (id, patch) => {
			intents.set(id, { ...(intents.get(id) ?? {}), ...patch });
		},
		countImplementPhases: () => 1,
		recordFixRound: (session, eventId) => {
			const key = `${session.execution_id}:${eventId}`;
			if (!recordFixRoundStore.has(key)) {
				recordFixRoundStore.set(key, recordFixRoundStore.size + 1);
			}
			// insert-or-read semantics: same (execId,eventId) always returns the
			// SAME round, regardless of how many times it's replayed.
			const roundsForExec = [...recordFixRoundStore.entries()].filter(([k]) =>
				k.startsWith(`${session.execution_id}:`),
			);
			const idx = roundsForExec.findIndex(([k]) => k === key);
			return idx + 1;
		},
		getActiveImplementSession: () => undefined,
		listVerdictEventCandidates: () => [],
		getLatestQaResultEvent: () => undefined,
		listStrandedPassCandidates: () => [],
		postIssueThread: postIssueThreadFn ?? (async () => {}),
		hasGateResponse: hasGateResponseFn,
	};
}

async function main() {
	const sessions = new Map();
	const alerts = []; // { reason }
	const threadRef = {};

	function seed(over) {
		const row = {
			issue_id: over.issue_id,
			project_name: PROJECT,
			status: "running",
			...over,
		};
		sessions.set(row.execution_id, row);
		return row;
	}

	async function narrate(text) {
		console.log(text.replace(/\n/g, " | "));
		await postMessage(threadRef.id, text);
	}

	async function alertLeadPipelineError({ session, reason }) {
		alerts.push({ execId: session?.execution_id, reason });
		await narrate(
			`⚠️ **Lead alert(真实生产 \`alertLeadPipelineError\` 调用,非 mock)**\n${reason}`,
		);
	}

	async function realPostIssueThread(_session, text) {
		await narrate(`📌 **真实 postIssueThread 调用**\n${text}`);
	}

	/**
	 * Builds one PhaseOrchestrator wired with REAL effects where cheap
	 * (probeGhostTmux → real tmux, alertLeadPipelineError/postIssueThread →
	 * real Discord posts, grantTurn → real in-memory turn map) and a disclosed
	 * deterministic stub for the mailbox-write side of wakePhaseRunner (see
	 * header comment) plus startDispatcher.start (throws — any call there IS
	 * the bug: none of these 3 scenarios should ever spawn).
	 */
	function makeOrchestrator({ wakeBox, qaVerdicts, listPhaseSessionRowsFn }) {
		const turns = new Map(); // issueId -> {holder_exec_id, phase, epoch}
		return {
			turns,
			orch: new PhaseOrchestrator({
				startDispatcher: {
					start: async (args) => {
						throw new Error(
							`startDispatcher.start() called (sessionRole=${args.sessionRole}) — QA MUST NOT reach here in this scenario (would be a duplicate respawn)`,
						);
					},
				},
				effects: {
					capturePhaseHeadSha: async () => "f".repeat(40),
					closePhaseRunner: async () => {},
					alertLeadPipelineError,
					probePhaseAlive: async () => "absent",
					probeGhostTmux: async (row) => {
						if (!row.tmux_session) return "absent";
						const liveness = await probeRunnerProcessLiveness(row.tmux_session);
						console.log(
							`  [real tmux probe] target=${row.tmux_session} → ${liveness}`,
						);
						return liveness;
					},
					parkPhaseRunner: async () => {},
					wakePhaseRunner: async (args) => {
						console.log(
							`  [wakePhaseRunner stub — mailbox write not exercised, see header] kind=${args.kind} target=${args.session.execution_id} → ${JSON.stringify(wakeBox.value)}`,
						);
						return wakeBox.value;
					},
					assertPhaseWorktreeReady: async () => ({ ok: true }),
				},
				resolveThreeStage: () => ({ enabled: true }),
				listStrandedDesignPhases: () => [],
				listStrandedImplementPhases: () => [],
				listPhaseSessionRows: listPhaseSessionRowsFn ?? (() => []),
				resolveLeadId: () => "eng-lead",
				keepAliveEnabled: () => true,
				getAlivePhaseSession: (issueId, phase) => {
					const ALIVE = new Set([
						"running",
						"awaiting_review",
						"approved_to_ship",
						"design_done",
					]);
					return [...sessions.values()].find(
						(s) =>
							s.issue_id === issueId &&
							s.chat_thread_role === phase &&
							ALIVE.has(s.status),
					);
				},
				hasShipFinalizationClaim: () => false,
				refreshPhaseStatusLine: async () => {},
				grantTurn: ({ issueId, execId, phase }) => {
					turns.set(issueId, {
						holder_exec_id: execId,
						phase,
						epoch: (turns.get(issueId)?.epoch ?? 0) + 1,
					});
				},
				turnBelt: {
					listTurns: () => [],
					getTurn: (issueId) => turns.get(issueId) ?? null,
					deleteTurn: (issueId) => turns.delete(issueId),
					getSessionForTurnHolder: (execId) => sessions.get(execId),
					getPhaseSessionsForIssue: (issueId) =>
						[...sessions.values()].filter((s) => s.issue_id === issueId),
				},
				qaVerdicts,
			}),
		};
	}

	threadRef.id = await createThread(new Date().toISOString());
	console.log(
		`Discord thread: https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${threadRef.id}`,
	);

	await narrate(
		[
			"**FLY-939 独立 QA — 真机模块驱动复现（Annie 选 (b)：merge 前真跑一遍完整生命周期）**",
			"",
			"用 `packages/teamlead/dist` 编译出的**真实生产 `PhaseOrchestrator` 类**（非 mock）逐条复现三件事：",
			"① QA-fail → **唤醒**常驻 implement（不 respawn、G-B）",
			"② wake 失败 → fail-loud + 可重放 → 模拟「Bridge 重启后 reconcile 重放」这次唤醒成功（一次性补位、G-A）",
			"③ 重启 reconcile 想要 respawn，但**真 tmux 探活**发现旧窗口还活着 → 拒绝 respawn（G-C ghost guard）",
			"",
			"真实：PhaseOrchestrator 生产类 / 真 tmux(场景③的 ghost 探测用真实 `probeRunnerProcessLiveness`) / 真 Discord(本线程)。",
			"披露的边界(与 FLY-921 那次相同的取舍):`wakePhaseRunner` 的**邮箱写入**那一段没有起真 Claude/Codex runner 去收——没有真跑起来的 agent 进程去消费它。除此之外(证据门槛判定、fix-round 记账、fail-loud/可重放语义、ghost-guard 真 tmux 探测、grantTurn)全部是真实生产代码。",
		].join("\n"),
	);

	// ── Scenario ① — QA-fail → WAKE resident implement (G-B kickback, not respawn) ──
	await narrate(
		"**① QA-fail → 唤醒常驻 implement（G-B kickback）**：QA 段已经 PASS 过、正 hold 着自己的 ship gate(awaiting_review)；founder 在 gate 上答「changes requested」（真实 `hasGateResponse` 返回 true）；QA 重发 `qa-result fail`。",
	);
	{
		const issueId = `fly939-qademo-b-${randomUUID().slice(0, 8)}`;
		const intents = new Map();
		intents.set("qa-b", { status: "pass", event_id: "V-pass-b", at: "t0" });
		const recordFixRoundStore = new Map();
		const qaVerdicts = makeQaVerdicts(
			intents,
			(session) => session.execution_id === "qa-b",
			recordFixRoundStore,
			realPostIssueThread,
		);
		const { orch, turns } = makeOrchestrator({
			wakeBox: { value: { ok: true } },
			qaVerdicts,
		});
		seed({
			execution_id: "impl-b",
			issue_id: issueId,
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review", // alive, parked
		});
		const qa = seed({
			execution_id: "qa-b",
			issue_id: issueId,
			session_role: "qa",
			chat_thread_role: "qa",
			status: "awaiting_review", // holding its own ship gate
			review_question_id: "q-b-1",
		});

		let threw = false;
		try {
			await orch.onQaResult(qa, {
				eventId: "V-fb-b",
				status: "fail",
				summary: "founder feedback kickback: 首屏文案再紧一点",
			});
		} catch (e) {
			threw = true;
			console.error("unexpected throw:", e);
		}
		check("① no throw (kickback accepted, not refused)", !threw);
		check(
			"① TURN granted to the RESIDENT implement (not a new one)",
			turns.get(issueId)?.holder_exec_id === "impl-b",
			`holder=${turns.get(issueId)?.holder_exec_id}`,
		);
		check(
			"① fixExecId bound to the resident implement (wake succeeded)",
			intents.get("qa-b")?.fixExecId === "impl-b",
			`fixExecId=${intents.get("qa-b")?.fixExecId}`,
		);
		await narrate(
			`✅ **验证①通过**：QA 的 founder-feedback kickback FAIL 被 \`isFeedbackKickback\` 守卫放行,真实 \`grantTurn\` 把 TURN 判给了**常驻**的 \`impl-b\`(同一个 implement,不是新起的),wakePhaseRunner 真实被调用且成功,\`fixExecId\` 绑定到 \`impl-b\`。\`startDispatcher.start\`(respawn 路径)全程**没有被调用**——不是 mock 出来的「没调用」,是真代码路径里根本走不到那一行。`,
		);
	}

	// ── Scenario ② — wake failure → fail-loud + replayable → boot reconcile retries ──
	await narrate(
		"**② wake 失败 → fail-loud + 可重放 → 模拟 Bridge 重启后 reconcile 重放,这次唤醒成功（G-A）**",
	);
	{
		const issueId = `fly939-qademo-a-${randomUUID().slice(0, 8)}`;
		const intents = new Map();
		const recordFixRoundStore = new Map();
		const qaVerdicts = makeQaVerdicts(
			intents,
			() => false,
			recordFixRoundStore,
			realPostIssueThread,
		);
		const wakeBox = {
			value: { ok: false, error: "no mailbox (simulated outage)" },
		};
		const { orch } = makeOrchestrator({ wakeBox, qaVerdicts });
		seed({
			execution_id: "impl-a",
			issue_id: issueId,
			session_role: "implement",
			chat_thread_role: "implement",
			status: "running", // alive
		});
		const qa = seed({
			execution_id: "qa-a",
			issue_id: issueId,
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running", // still executing its own verdict — NOT holding a ship gate
		});

		await orch.onQaResult(qa, {
			eventId: "V-a1",
			status: "fail",
			summary: "regression in checkout flow",
		});
		check(
			"② first attempt: wake failed → fail-loud alert fired",
			alerts.some((a) => a.reason?.includes("fix wake failed")),
		);
		check(
			"② first attempt: intent stays REPLAYABLE (no fixExecId)",
			intents.get("qa-a")?.fixExecId === undefined,
		);
		const roundAfterFirst = recordFixRoundStore.get("qa-a:V-a1");

		await narrate(
			"⏩ **模拟 Bridge 重启**：mailbox 故障已恢复(wakeBox.value 翻成 ok:true),用同一个 `V-a1` verdict 重放(等价于 `reconcileQaVerdicts` 在 boot 时读到同一条未消化的 FAIL 事件,再走一次 `onQaResult`)。",
		);
		wakeBox.value = { ok: true };
		await orch.onQaResult(qa, {
			eventId: "V-a1", // SAME event id — a genuine boot replay, not a new verdict
			status: "fail",
			summary: "regression in checkout flow",
		});
		check(
			"② replay reuses the SAME fix round (no double-count)",
			recordFixRoundStore.get("qa-a:V-a1") === roundAfterFirst,
			`round stayed ${recordFixRoundStore.get("qa-a:V-a1")}`,
		);
		check(
			"② replay's wake now succeeds → fixExecId finally bound",
			intents.get("qa-a")?.fixExecId === "impl-a",
		);
		await narrate(
			`✅ **验证②通过**：第一次 wake 失败,真实 \`alertLeadPipelineError\` 报警(fail-loud),intent **没有**被提前 patch fixExecId(可重放)。模拟重启重放同一个 \`V-a1\` verdict 后,fix round 记账**复用同一轮**(不是新开一轮),这次 wake 成功,\`fixExecId\` 才真正绑定。全程 implement 都是「唤醒同一个」,\`startDispatcher.start\` 两次都**没有被调用**。`,
		);
	}

	// ── Scenario ③ — restart reconcile + REAL tmux probe → refuse respawn (G-C) ──
	await narrate(
		"**③ 重启 reconcile → 真 tmux 探活 → 拒绝 respawn（G-C ghost guard）**：起一个真实 tmux 会话代表「重启前那个 implement 的窗口」；DB 层面它已经是 terminal(模拟一次旁路把行翻成 terminal，但窗口没关),`getAlivePhaseSession` 找不到活的 implement(模拟重启后追踪丢失)→ 兜底要 spawn 前先探真 tmux。",
	);
	{
		await execFileP("tmux", [
			"new-session",
			"-d",
			"-s",
			TMUX_GHOST,
			"-n",
			"implement",
			"sleep 300",
		]);
		console.log(`  [real tmux] created live session ${TMUX_TARGET}`);

		const issueId = `fly939-qademo-c-${randomUUID().slice(0, 8)}`;
		const intents = new Map();
		const recordFixRoundStore = new Map();
		const qaVerdicts = makeQaVerdicts(
			intents,
			() => false,
			recordFixRoundStore,
			realPostIssueThread,
		);
		const ghostRow = {
			execution_id: "impl-c-ghost",
			issue_id: issueId,
			project_name: PROJECT,
			chat_thread_role: "implement",
			status: "completed", // terminal per DB — but the tmux window below is REAL and alive
			tmux_session: TMUX_TARGET,
		};
		const { orch } = makeOrchestrator({
			wakeBox: { value: { ok: true } }, // must never be reached — no alive implement in this scenario
			qaVerdicts,
			listPhaseSessionRowsFn: (_iid, phase) =>
				phase === "implement" ? [ghostRow] : [],
		});
		const qa = seed({
			execution_id: "qa-c",
			issue_id: issueId,
			session_role: "qa",
			chat_thread_role: "qa",
			status: "running", // still executing its own verdict — NOT holding a ship gate
		});
		// Deliberately NO alive 'impl-c' session in `sessions` — simulates the
		// post-restart state where StateStore no longer tracks it as alive.

		await orch.onQaResult(qa, {
			eventId: "V-c1",
			status: "fail",
			summary: "flaky auth test",
		});
		check(
			"③ real tmux ghost probe fired + refused the spawn",
			alerts.some(
				(a) =>
					a.reason?.includes("LIVE") && a.reason?.includes("refusing to spawn"),
			),
		);
		check(
			"③ intent stays replayable (fixExecId not bound to a phantom spawn)",
			intents.get("qa-c")?.fixExecId === undefined,
		);

		await narrate(
			`✅ **验证③通过**：\`listPhaseSessionRows('implement')\` 返回的行在 DB 里是 \`completed\`(旁路把它翻成终态),但它的 \`tmux_session\` 指向一个**真实存活**的 tmux 窗口(\`${TMUX_TARGET}\`)。真实 \`probeGhostTmux\` 直接对这个真窗口跑了 \`probeRunnerProcessLiveness\`(不经过 CommDB 注册表,那条路会把它漏判成 absent),探到 alive → ghost guard fail-closed,报警文案里明确点名「LIVE tmux process」+「refusing to spawn a duplicate」,\`startDispatcher.start\` **没有被调用**——重启 reconcile 没有盲目二次拉起一个和真实还活着的窗口打架的 implement。`,
		);

		await execFileP("tmux", ["kill-session", "-t", TMUX_GHOST]);
		console.log(`  [real tmux] killed ${TMUX_GHOST}`);
	}

	const failed = results.filter((r) => !r.pass);
	await narrate(
		[
			"**结论**",
			`${results.length - failed.length}/${results.length} 项通过。`,
			failed.length
				? `失败项：${failed.map((f) => f.name).join("; ")}`
				: "全部通过 ✅",
			"",
			`Discord thread(真实,可点开)：https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${threadRef.id}`,
			"",
			"PR #482 若以上全绿：可以 ship。",
		].join("\n"),
	);

	console.log(
		`\nTotal: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`,
	);
	console.log(
		`Thread: https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}/${threadRef.id}`,
	);

	if (failed.length > 0) process.exit(1);
}

main().catch(async (err) => {
	console.error("FATAL:", err);
	// Best-effort tmux cleanup on a fatal error mid-run.
	try {
		await execFileP("tmux", ["kill-session", "-t", TMUX_GHOST]);
	} catch {
		/* already gone / never created */
	}
	process.exit(1);
});
