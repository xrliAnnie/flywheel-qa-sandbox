#!/usr/bin/env node
import { randomUUID } from "node:crypto";
// QA · FLY-907 — module-driven real-Discord E2E against the 529 QA Room (slot 2).
// Drives the REAL compiled production code (StateStore, ChatThreadCreator,
// derivePhaseDisplayState/deriveIssueTitleBadge/renderPhaseStatusLine,
// buildPipelineHeaderContent) against a real Discord test channel. No mocks
// for Discord — real fetch, real bot token.
//
// GOTCHA (memory: reference_qa_discord_thread_rename_ratelimit): Discord hard-
// limits thread RENAME to 2/10min PER THREAD. Each scenario below therefore
// gets its OWN fresh thread (distinct issueId) with AT MOST 2 title renames;
// pinned-header edits (a different Discord route) are not subject to that
// limit and can happen freely within a thread.
//
// Usage: pnpm -r build && source ~/.flywheel/.env && node scripts/qa-fly-907-real-discord-e2e.mjs > /tmp/fly907-e2e.log 2>&1
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMLEAD_DIST = join(__dirname, "..", "packages", "teamlead", "dist");
const { StateStore } = await import(`file://${TEAMLEAD_DIST}/StateStore.js`);
const { ChatThreadCreator, buildPipelineHeaderContent } = await import(
	`file://${TEAMLEAD_DIST}/bridge/ChatThreadCreator.js`
);
const { derivePhaseDisplayState, deriveIssueTitleBadge } = await import(
	`file://${TEAMLEAD_DIST}/bridge/issue-display.js`
);
const { PHASE_THREAD_BADGE, THREE_STAGE_PHASE_SEQUENCE, phaseMessageTag } =
	await import(
		`file://${TEAMLEAD_DIST}/../node_modules/flywheel-config/dist/index.js`
	);

const BOT_TOKEN = process.env.TEST_BOT_TOKEN_2;
const CHANNEL_ID = "1493080993173737583"; // slot-2 product-lead-test
if (!BOT_TOKEN) {
	console.error("Missing TEST_BOT_TOKEN_2 in env (source ~/.flywheel/.env)");
	process.exit(1);
}
const DISCORD_API = "https://discord.com/api/v10";
const transcript = [];

async function discordGetChannel(threadId) {
	const res = await fetch(`${DISCORD_API}/channels/${threadId}`, {
		headers: { Authorization: `Bot ${BOT_TOKEN}` },
	});
	if (!res.ok)
		throw new Error(`GET channel ${res.status}: ${await res.text()}`);
	return res.json();
}
async function discordGetPins(threadId) {
	const res = await fetch(`${DISCORD_API}/channels/${threadId}/pins`, {
		headers: { Authorization: `Bot ${BOT_TOKEN}` },
	});
	if (!res.ok) throw new Error(`GET pins ${res.status}: ${await res.text()}`);
	return res.json();
}
async function snapshot(threadId, label) {
	const chan = await discordGetChannel(threadId);
	const pins = await discordGetPins(threadId);
	const pinned = pins[0]?.content ?? "(no pin)";
	transcript.push({ label, threadId, title: chan.name, pinned });
	console.log(`\n=== ${label} ===`);
	console.log(`真实线程 id: ${threadId}`);
	console.log(`标题(thread name): ${chan.name}`);
	console.log(`置顶块(pinned):\n${pinned}`);
}

const tmpDir = mkdtempSync(join(tmpdir(), "qa-fly907-"));
const dbPath = join(tmpDir, "teamlead.db");
const store = await StateStore.create(dbPath);
const creator = new ChatThreadCreator(store);
const runId = randomUUID().slice(0, 8);

function baseCtx(scenarioTag, issueId) {
	return {
		chatChannelId: CHANNEL_ID,
		issueId,
		issueIdentifier: `FLY-907QA-${runId}-${scenarioTag}`,
		issueTitle: `[QA-907/${scenarioTag}] 显示批次真机验证 ${runId}`,
		botToken: BOT_TOKEN,
		leadId: "qa-lead",
	};
}

async function pinRows(
	ctx,
	threadId,
	phaseStatuses,
	parkByRole,
	execByRole,
	crossWireRole,
) {
	const rows = THREE_STAGE_PHASE_SEQUENCE.map((role) => {
		const status = phaseStatuses[role];
		if (!status)
			return {
				label: phaseMessageTag(role).trim(),
				status: "pending",
				plannedModel: "Fable",
			};
		const state = derivePhaseDisplayState({
			role,
			status,
			park: parkByRole[role] ?? "unknown",
		});
		const row = {
			label: phaseMessageTag(role, "claude-fable-5").trim(),
			status: state,
			execId: (execByRole[role] ?? "exec0000").slice(0, 8),
		};
		if (crossWireRole === role) row.attachUnresolved = true;
		else if (state !== "pending")
			row.attachCommand = `tmux attach -t runner-${role}`;
		return row;
	});
	const content = buildPipelineHeaderContent(ctx, rows);
	await creator.ensureRunnerPipelineHeaderPin(ctx, threadId, content);
	return derivedBadge(phaseStatuses, parkByRole);
}

function derivedBadge(phaseStatuses, parkByRole) {
	const phaseStates = new Map();
	for (const role of THREE_STAGE_PHASE_SEQUENCE) {
		const status = phaseStatuses[role];
		phaseStates.set(
			role,
			status
				? derivePhaseDisplayState({
						role,
						status,
						park: parkByRole[role] ?? "unknown",
					})
				: "pending",
		);
	}
	return deriveIssueTitleBadge({
		phaseStates,
		mainSessionStage: undefined,
		mainSessionStatus: undefined,
	});
}

async function stampBadge(ctx, threadId, badge) {
	if (badge.kind === "blocked")
		await creator.stampStatusBadge(ctx, threadId, "🔴 受阻");
	else if (badge.kind === "completed")
		await creator.stampStageEmoji(ctx, threadId, "completed", true);
	else if (badge.kind === "phase")
		await creator.stampStageEmoji(
			ctx,
			threadId,
			"",
			true,
			PHASE_THREAD_BADGE[badge.phase],
		);
}

async function main() {
	// ── Scenario A: design running -> park+handoff to implement (2 renames) ──
	{
		const issueId = `qa-fly907-${runId}-a`;
		const ctx = baseCtx("A-park-handoff", issueId);
		const created = await creator.ensureChatThread({ ...ctx, modelCode: "F" });
		const threadId = created.threadId;
		let badge = await pinRows(
			ctx,
			threadId,
			{ design: "running" },
			{},
			{ design: "exec00001" },
		);
		await stampBadge(ctx, threadId, badge); // rename #1: 🎨设计
		await snapshot(threadId, "A① design 阶段进行中");

		badge = await pinRows(
			ctx,
			threadId,
			{ design: "design_done", implement: "running" },
			{ design: "parked" },
			{ design: "exec00001", implement: "exec00002" },
		);
		await stampBadge(ctx, threadId, badge); // rename #2: 🔨实现 — FLY-902 root-cause: park 之前这里从不刷新
		await snapshot(
			threadId,
			"A② design park+handoff → implement 开始(FLY-902 根因场景:park 不触发 stage_changed,以前标题会卡在🎨)",
		);
	}

	// ── Scenario B: implement<->QA park/wake handoff (2 renames) ──
	{
		const issueId = `qa-fly907-${runId}-b`;
		const ctx = baseCtx("B-wake-fix", issueId);
		const created = await creator.ensureChatThread({ ...ctx, modelCode: "F" });
		const threadId = created.threadId;
		let badge = await pinRows(
			ctx,
			threadId,
			{ design: "design_done", implement: "awaiting_review", qa: "running" },
			{ design: "parked", implement: "parked" },
			{ design: "exec00001", implement: "exec00002", qa: "exec00003" },
		);
		await stampBadge(ctx, threadId, badge); // rename #1: 🧪QA — implement 已交接
		await snapshot(threadId, "B① implement 交接 QA(awaiting_review+park)");

		badge = await pinRows(
			ctx,
			threadId,
			{ design: "design_done", implement: "awaiting_review", qa: "running" },
			{ design: "parked", implement: "not_parked" },
			{ design: "exec00001", implement: "exec00002", qa: "exec00003" },
		);
		await stampBadge(ctx, threadId, badge); // rename #2: 🔨实现 — FLY-543 修正,不能停在 QA/✅
		await snapshot(
			threadId,
			"B② QA FAIL → 唤醒 implement 返工(FLY-543:标题正确回退🔨,不停在QA)",
		);
	}

	// ── Scenario C: kill/terminate + attach cross-wire (1 rename) ──
	{
		const issueId = `qa-fly907-${runId}-c`;
		const ctx = baseCtx("C-kill-crosswire", issueId);
		const created = await creator.ensureChatThread({ ...ctx, modelCode: "F" });
		const threadId = created.threadId;
		const badge = await pinRows(
			ctx,
			threadId,
			{ design: "design_done", implement: "design_done", qa: "terminated" },
			{ design: "parked", implement: "parked" },
			{ design: "exec00001", implement: "exec00002", qa: "exec00003" },
			"implement", // inject a cross-wire on the implement row
		);
		await stampBadge(ctx, threadId, badge); // rename #1: 🔴 受阻
		await snapshot(
			threadId,
			"C kill/terminate QA + attach 串线注入(implement 行应显示「终端待解析」而非错误链接)",
		);
	}

	// ── Scenario D: ship-terminal finalize (1 rename) — the structural bug from
	//    exploration.md §2.3: pre-FLY-907 the title could NEVER reach ✅ on a
	//    three-stage issue (it always echoed the reporting phase's badge). ──
	{
		const issueId = `qa-fly907-${runId}-d`;
		const ctx = baseCtx("D-finalize", issueId);
		const created = await creator.ensureChatThread({ ...ctx, modelCode: "F" });
		const threadId = created.threadId;
		const badge = await pinRows(
			ctx,
			threadId,
			{ design: "completed", implement: "completed", qa: "completed" },
			{},
			{ design: "exec00001", implement: "exec00002", qa: "exec00003" },
		);
		await stampBadge(ctx, threadId, badge); // rename #1: ✅ 完成
		await snapshot(
			threadId,
			"D finalize(ship 收尾终态 — 结构性修复:标题终于能到✅,不留「进行中」)",
		);
	}

	console.log(
		"\n\n四个真实线程均建在 529 QA Room(内部隔离环境,slot-2 product-lead-test channel)。",
	);
	console.log("线程未归档 — 保留供人工核查真实渲染。");
	console.log(
		`\n__TRANSCRIPT_JSON__${JSON.stringify({ channelId: CHANNEL_ID, steps: transcript })}`,
	);
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(1);
});
