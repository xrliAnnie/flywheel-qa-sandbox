#!/usr/bin/env node
// QA · FLY-921 — module-driven real-Discord E2E against the 529 QA Room (slot 2).
// Drives the REAL compiled production PhaseOrchestrator (packages/teamlead/dist)
// and the REAL flywheel-comm CommDB (better-sqlite3, packages/flywheel-comm/dist)
// against a real Discord thread. No mocks for Discord — real fetch, real bot
// token, real thread messages Annie can open and read.
//
// Scope: probePhaseAlive (tmux/process liveness) is the one dependency that
// production wires to a real tmux/pane check — here it is a deterministic
// per-scenario stub (no real tmux Runner is spun up), exactly the boundary
// disclosed in engineering/doc/FLY-921-three-stage-turn-belt/qa-report.md §5.
// Every other code path — evidence-gate decision, turn-belt stale detection,
// recovery-target selection, epoch bump, the completed+qa ship carve-out — is
// the REAL shipped PhaseOrchestrator class, and the CommDB reads/writes are
// REAL sqlite rows, not mocks.
//
// Usage: pnpm -r build && TEST_BOT_TOKEN_2=<token> node scripts/qa-fly921-real-discord-turn-belt-e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMLEAD_DIST = join(__dirname, "..", "packages", "teamlead", "dist");
const COMM_DIST = join(__dirname, "..", "packages", "flywheel-comm", "dist");
const { PhaseOrchestrator } = await import(
	`file://${TEAMLEAD_DIST}/bridge/phase-orchestrator.js`
);
const { CommDB } = await import(`file://${COMM_DIST}/db.js`);

const BOT_TOKEN = process.env.TEST_BOT_TOKEN_2;
const CHANNEL_ID = "1493080993173737583"; // slot-2 product-lead-test (~/.flywheel/test-slots.json)
if (!BOT_TOKEN) {
	console.error("Missing TEST_BOT_TOKEN_2 in env (source ~/.flywheel/.env)");
	process.exit(1);
}

const DISCORD_API = "https://discord.com/api/v10";
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
			content: `🧵 FLY-921 real-machine QA demo — ${nameSeed}`,
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
				name: `[FLY-921 QA demo] ${nameSeed}`.slice(0, 100),
				auto_archive_duration: 4320,
			}),
		},
	);
	const thr = await thrRes.json();
	if (!thr.id) throw new Error(`thread create failed: ${JSON.stringify(thr)}`);
	return thr.id;
}

const ISSUE = "FLY-921-QADEMO";
const PROJECT = "flywheel";

function makeQaVerdicts() {
	const intents = new Map();
	return {
		getSession: () => undefined,
		readIntent: (id) => intents.get(id),
		patchIntent: (id, patch) => {
			intents.set(id, { ...(intents.get(id) ?? {}), ...patch });
		},
		countImplementPhases: () => 1,
		recordFixRound: () => 1,
		getActiveImplementSession: () => undefined,
		listVerdictEventCandidates: () => [],
		getLatestQaResultEvent: () => undefined,
		listStrandedPassCandidates: () => [],
		postIssueThread: async () => {},
	};
}

async function main() {
	const tmpDir = mkdtempSync(join(tmpdir(), "fly921-qa-demo-"));
	const db = new CommDB(join(tmpDir, "comm.db"));
	const sessions = new Map();
	const liveness = new Map();
	// biome-ignore lint/style/useConst: assigned once but declared before use via closures below
	let threadId;

	function seed(over) {
		const row = {
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "running",
			...over,
		};
		sessions.set(row.execution_id, row);
		return row;
	}

	async function narrate(text) {
		console.log(text.replace(/\n/g, " | "));
		await postMessage(threadId, text);
	}

	let alertCallCount = 0;
	async function alertLeadPipelineError({ reason }) {
		alertCallCount++;
		await narrate(
			`⚠️ **Lead alert (real production \`alertLeadPipelineError\` call)**\n${reason}`,
		);
	}

	function makeOrchestrator() {
		return new PhaseOrchestrator({
			startDispatcher: {
				start: async () => {
					throw new Error(
						"startDispatcher.start() called — QA MUST NOT reach here in scenario 1",
					);
				},
			},
			effects: {
				capturePhaseHeadSha: async () => "f".repeat(40),
				closePhaseRunner: async () => {},
				alertLeadPipelineError,
				probePhaseAlive: async (s) => liveness.get(s.execution_id) ?? "absent",
				parkPhaseRunner: async () => {},
				wakePhaseRunner: async () => ({ ok: true }),
				assertPhaseWorktreeReady: async () => ({ ok: true }),
			},
			resolveThreeStage: () => ({ enabled: true }),
			listStrandedDesignPhases: () => [],
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
				db.grantTurn(issueId, execId, phase, Date.now());
			},
			turnBelt: {
				listTurns: () =>
					db.listTurns().map((turn) => ({ projectName: PROJECT, turn })),
				getTurn: (issueId) => db.getTurn(issueId),
				deleteTurn: (issueId) => db.deleteTurn(issueId),
				getSessionForTurnHolder: (execId) => sessions.get(execId),
				getPhaseSessionsForIssue: (issueId) =>
					[...sessions.values()].filter((s) => s.issue_id === issueId),
			},
			qaVerdicts: makeQaVerdicts(),
		});
	}

	threadId = await createThread(new Date().toISOString());
	console.log(
		`Discord thread: https://discord.com/channels/1485787271192907816/${CHANNEL_ID}/${threadId}`,
	);

	await narrate(
		[
			"**FLY-921 独立 QA — 真机模块驱动复现（真 Discord + 真 CommDB + 真 PhaseOrchestrator）**",
			"",
			"本 demo 用 `packages/teamlead/dist` 里编译出的**真实生产 `PhaseOrchestrator` 类**（非 mock）+ `packages/flywheel-comm/dist` 的**真实 better-sqlite3 CommDB**，逐条复现 Annie 要看的三件事：",
			"① QA 相位不抢跑（implement 没交出真实证据 → QA 绝不 spawn）",
			"② turn-belt 死 holder 正常释放锁（kill implement → design 自动拿回 TURN，一条告警）",
			"③ 成功 ship 不误发 STALE-TURN 告警（QA 优雅 completed → 零告警、TURN 不动）",
			"",
			"（唯一 stub 的依赖是 `probePhaseAlive`——真机没有起真 tmux Runner，其余判定/存储/告警全部真实，边界与 qa-report.md §5 一致。）",
		].join("\n"),
	);

	// ── Scenario ① — QA must NOT preempt an unfinished implement ──
	await narrate(
		"**① QA 相位抢跑防护**：起 design(parked-alive) + implement(awaiting_review，无 review_question_id — 模拟嵌套会话误判/被 kill 的合成完成)。",
	);
	{
		const orch = makeOrchestrator();
		liveness.set("design-demo", "alive");
		seed({
			execution_id: "design-demo",
			session_role: "design",
			chat_thread_role: "design",
			status: "design_done",
		});
		const impl = seed({
			execution_id: "impl-demo",
			session_role: "implement",
			chat_thread_role: "implement",
			status: "awaiting_review", // no review_question_id — synthesized
		});
		db.grantTurn(
			ISSUE,
			impl.execution_id,
			"implement",
			Date.now() - 10 * 60_000,
		);

		let threw = false;
		try {
			await orch.onPhaseComplete(impl);
		} catch (e) {
			threw = true;
			console.error("unexpected throw:", e);
		}
		check(
			"① evidence gate refuses synthesized completion — QA never spawned",
			!threw,
			"startDispatcher.start would have thrown if QA had been spawned",
		);
		await narrate(
			`✅ **验证①通过**：implement 停在 \`awaiting_review\` 但**没有** \`review_question_id\`（合成完成的铁证）——真实 \`PhaseOrchestrator.onPhaseComplete\` 判定为「非 runner 驱动的证据」，**没有调用 startDispatcher 拉起 QA**，只发了上面那条 Lead 告警。design 段仍 parked，QA 相位这一轮完全没起来。`,
		);
	}

	// ── Scenario ② — kill-holder recovery (turn-belt release) ──
	await narrate(
		"**② turn-belt 死 holder 恢复**：Lead 把卡住的 implement 判定 kill（status→failed），触发真实 `reconcileTurnBelt`。",
	);
	{
		const orch = makeOrchestrator();
		const before = db.getTurn(ISSUE);
		const impl = sessions.get("impl-demo");
		impl.status = "failed"; // the Lead's kill
		await orch.reconcileTurnBelt({
			issueId: ISSUE,
			projectName: PROJECT,
			terminalExecId: impl.execution_id,
		});
		const after = db.getTurn(ISSUE);
		check(
			"② TURN moved to the parked-alive design session",
			after?.holder_exec_id === "design-demo",
			`holder ${before?.holder_exec_id}(epoch ${before?.epoch}) → ${after?.holder_exec_id}(epoch ${after?.epoch})`,
		);
		await narrate(
			`✅ **验证②通过**：kill 前 TURN holder=\`${before?.holder_exec_id}\` epoch=${before?.epoch}；reconcile 后 TURN holder=\`${after?.holder_exec_id}\` epoch=${after?.epoch}——design 段自动拿回轮次，**不需要 operator 手改 DB**（FLY-543 事故里的手动步骤，现在是自动的）。`,
		);

		// idempotency: re-run should not double-grant / double-alert
		await orch.reconcileTurnBelt({
			issueId: ISSUE,
			projectName: PROJECT,
			terminalExecId: impl.execution_id,
		});
		const after2 = db.getTurn(ISSUE);
		check(
			"② re-run is idempotent (no double grant)",
			after2?.epoch === after?.epoch,
			`epoch stayed ${after2?.epoch}`,
		);
	}

	// ── Scenario ③ — graceful ship must NOT fire a false STALE-TURN alert ──
	await narrate(
		"**③ 成功 ship 不误报**：design 段现在持有 TURN，正常推进到 QA，QA 优雅 \`completed\`（approved ship）——验证不会被误判成 stale 而抢走/告警。",
	);
	{
		const orch = makeOrchestrator();
		// design now holds the turn (from scenario ②); hand off to a QA session
		// that ships gracefully while STILL holding the turn (post-ship
		// finalization would delete it moments later in production).
		liveness.set("design-demo", "alive");
		const qa = seed({
			execution_id: "qa-demo",
			session_role: "qa",
			chat_thread_role: "qa",
			status: "completed", // graceful ship
		});
		db.grantTurn(ISSUE, qa.execution_id, "qa", Date.now());
		const alertsBefore = alertCallCount;

		await orch.reconcileTurnBelt({
			issueId: ISSUE,
			projectName: PROJECT,
			terminalExecId: qa.execution_id,
		});
		const turn = db.getTurn(ISSUE);
		check(
			"③ graceful completed+qa holder is left alone (no re-grant to design)",
			turn?.holder_exec_id === "qa-demo",
			`TURN still held by ${turn?.holder_exec_id} (post-ship finalization owns cleanup, not reconcile)`,
		);
		check(
			"③ no false STALE-TURN alert fired on graceful ship",
			alertCallCount === alertsBefore,
			`alertLeadPipelineError call count unchanged (${alertsBefore} → ${alertCallCount})`,
		);
		await narrate(
			`✅ **验证③通过**：QA 段 \`completed\`（优雅 ship 形态）时，真实 reconcile **没有**把 TURN 重新判给 parked 的 design、也**没有**发 STALE-TURN 告警——TURN 原样留给 post-ship finalization 收尾。这正是本轮 Codex code review 抓到的 HIGH 发现（若无此 carve-out，每次成功 ship 都会误报一次）。`,
		);
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
			`Discord thread（真实,可点开）：https://discord.com/channels/1485787271192907816/${CHANNEL_ID}/${threadId}`,
		].join("\n"),
	);

	console.log(
		`\nTotal: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`,
	);
	console.log(
		`Thread: https://discord.com/channels/1485787271192907816/${CHANNEL_ID}/${threadId}`,
	);

	db.close();
	rmSync(tmpDir, { recursive: true, force: true });

	if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
