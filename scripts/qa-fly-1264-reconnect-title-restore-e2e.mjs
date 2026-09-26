#!/usr/bin/env node
// QA · FLY-1264 — module-driven real-Discord E2E for the reconnect-title restore
// path. Drives the REAL compiled production writer (ChatThreadCreator) against a
// real Discord thread in the 529 QA Room (slot-1 cos-test), then reads the thread
// name back FROM Discord as ground truth (never trusting the writer's own return).
//
// What this proves on real Discord (the founder-facing acceptance from the issue:
// "⚠️重连中 → 恢复阶段前缀,无需人工 PATCH"):
//   1. A thread stamped `⚠️重连中 [FLY-XXX] …` is the post-restart state the
//      HeartbeatService owns.
//   2. The canonical restore call the FLY-907 refresher's Face A makes AFTER the
//      boot title settle — `stampStageEmojiResult(ctx, threadId, <stage/phase>)`,
//      the EXACT method + args from issue-display-refresher.ts:711-731 — replaces
//      ⚠️ with the correct phase/stage badge while preserving the human base title.
//   3. Re-running the identical restore is a `noop` (no PATCH, no rename) — an
//      already-correct thread never churns (no rename storm; the FLY-907
//      fingerprint concern).
//
// The settle→enqueue orchestration that PRODUCES this call is covered
// deterministically by the unit suites (HeartbeatService.monitor-loss +
// reconnect-title-restore + issue-display-refresher). This script closes the ONE
// thing mocks can't: does a real Discord PATCH actually peel ⚠️重连中 and land the
// stage badge, base intact.
//
// GOTCHA (memory reference_qa_discord_thread_rename_ratelimit): Discord hard-limits
// thread RENAME to 2/10min PER THREAD. Each scenario gets its OWN fresh thread and
// spends EXACTLY 2 renames (⚠️ enter, then the restore); the idempotent re-stamp is
// a noop and issues no PATCH.
//
// Usage:
//   pnpm --filter flywheel-teamlead build
//   source ~/.flywheel/.env
//   node scripts/qa-fly-1264-reconnect-title-restore-e2e.mjs > /tmp/fly1264-e2e.log 2>&1
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMLEAD_DIST = join(__dirname, "..", "packages", "teamlead", "dist");
const { StateStore } = await import(`file://${TEAMLEAD_DIST}/StateStore.js`);
const { ChatThreadCreator } = await import(
	`file://${TEAMLEAD_DIST}/bridge/ChatThreadCreator.js`
);
const { reconnectingBadge } = await import(
	`file://${TEAMLEAD_DIST}/bridge/stage-utils.js`
);
const { PHASE_THREAD_BADGE } = await import(
	`file://${TEAMLEAD_DIST}/../node_modules/flywheel-config/dist/index.js`
);

const BOT_TOKEN = process.env.TEST_BOT_TOKEN_1;
const CHANNEL_ID = "1493080991290626079"; // slot-1 cos-test (529 QA Room)
if (!BOT_TOKEN) {
	console.error("Missing TEST_BOT_TOKEN_1 in env (source ~/.flywheel/.env)");
	process.exit(1);
}
const DISCORD_API = "https://discord.com/api/v10";
const transcript = [];
const failures = [];

function check(label, ok, detail) {
	const line = `${ok ? "PASS" : "FAIL"} — ${label}${detail ? ` :: ${detail}` : ""}`;
	console.log(line);
	if (!ok) failures.push(line);
}

async function discordThreadName(threadId) {
	const res = await fetch(`${DISCORD_API}/channels/${threadId}`, {
		headers: { Authorization: `Bot ${BOT_TOKEN}` },
	});
	if (!res.ok)
		throw new Error(`GET channel ${res.status}: ${await res.text()}`);
	return (await res.json()).name;
}

const tmpDir = mkdtempSync(join(tmpdir(), "qa-fly1264-"));
const store = await StateStore.create(join(tmpDir, "teamlead.db"));
const creator = new ChatThreadCreator(store);
const runId = randomUUID().slice(0, 8);

function baseCtx(scenarioTag, issueId) {
	return {
		chatChannelId: CHANNEL_ID,
		issueId,
		issueIdentifier: `FLY-1264QA-${runId}-${scenarioTag}`,
		issueTitle: `[QA-1264/${scenarioTag}] 重连标题恢复真机验证 ${runId}`,
		botToken: BOT_TOKEN,
		leadId: "qa-lead",
	};
}

// Simulate the HeartbeatService "⚠️重连中" enter stamp on the real thread. This is
// the SAME per-thread coalescing writer stampReconnect(enter) drives in production
// (ChatThreadCreator.stampStatusBadge with reconnectingBadge()).
async function stampReconnectEnter(ctx, threadId) {
	await creator.stampStatusBadge(ctx, threadId, reconnectingBadge(true));
}

async function scenario(tag, restore, expectedBadge, sceneDesc) {
	const issueId = `qa-fly1264-${runId}-${tag}`;
	const ctx = baseCtx(tag, issueId);
	const created = await creator.ensureChatThread({ ...ctx, modelCode: "F" });
	const threadId = created.threadId;
	const baseName = await discordThreadName(threadId);
	console.log(`\n=== 场景 ${tag}: ${sceneDesc} ===`);
	console.log(`真实线程 id: ${threadId}`);
	console.log(`建线程后基名: ${baseName}`);

	// (1) Post-restart state: HeartbeatService stamps ⚠️重连中 (rename #1).
	await stampReconnectEnter(ctx, threadId);
	const afterEnter = await discordThreadName(threadId);
	console.log(`① ⚠️ enter 后(Discord 读回): ${afterEnter}`);
	check(
		`${tag} ①: 重连中前缀已上`,
		afterEnter.startsWith("⚠️重连中"),
		afterEnter,
	);

	// (2) Recovery: the exact call Face A makes after the boot title settle, with
	//     NO runner stage_changed event — result MUST be "changed" (real PATCH).
	const result = await restore(ctx, threadId);
	const afterRestore = await discordThreadName(threadId);
	console.log(`② 恢复写回后(Discord 读回): ${afterRestore} [writer=${result}]`);
	check(
		`${tag} ②a: 恢复写回返回 changed`,
		result === "changed",
		`got=${result}`,
	);
	check(
		`${tag} ②b: ⚠️重连中 前缀已被替换为 ${expectedBadge}`,
		afterRestore.startsWith(expectedBadge) &&
			!afterRestore.includes("⚠️") &&
			!afterRestore.includes("重连中"),
		afterRestore,
	);
	// Human base title (issue key + curated text) survives the peel.
	check(
		`${tag} ②c: 人工基名保留(含 issue 号)`,
		afterRestore.includes(ctx.issueIdentifier),
		afterRestore,
	);

	// (3) Idempotence: an already-correct thread does not churn — noop, no rename.
	const again = await restore(ctx, threadId);
	const afterRepeat = await discordThreadName(threadId);
	check(
		`${tag} ③: 重复恢复=noop 不改名(无 rename 风暴)`,
		again === "noop" && afterRepeat === afterRestore,
		`writer=${again} name=${afterRepeat}`,
	);

	transcript.push({
		tag,
		threadId,
		baseName,
		afterEnter,
		afterRestore,
		expectedBadge,
	});
}

async function main() {
	// Scenario A — single-runner main session, implement stage. Face A takes the
	// `badge.stage` branch: stampStageEmojiResult(ctx, threadId, "implement", true).
	await scenario(
		"A-implement-stage",
		(ctx, threadId) =>
			creator.stampStageEmojiResult(ctx, threadId, "implement", true),
		"🔨实现",
		"单 runner main 会话 implement 阶段(Face A badge.stage 分支)",
	);

	// Scenario B — three-stage issue currently in QA phase. Face A takes the
	// `badge.phase` branch: stampStageEmojiResult(ctx, threadId, "", true, PHASE_THREAD_BADGE.qa).
	await scenario(
		"B-qa-phase",
		(ctx, threadId) =>
			creator.stampStageEmojiResult(
				ctx,
				threadId,
				"",
				true,
				PHASE_THREAD_BADGE.qa,
			),
		"🧪QA",
		"三段式 issue QA 阶段(Face A badge.phase 分支)",
	);

	// Scenario C — three-stage design phase, proving the design prefix too.
	await scenario(
		"C-design-phase",
		(ctx, threadId) =>
			creator.stampStageEmojiResult(
				ctx,
				threadId,
				"",
				true,
				PHASE_THREAD_BADGE.design,
			),
		"🎨设计",
		"三段式 issue design 阶段(Face A badge.phase 分支)",
	);

	console.log(
		"\n三个真实线程建在 529 QA Room(内部隔离环境,slot-1 cos-test channel),未归档,保留供人工核查。",
	);
	console.log(
		`\n结果: ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAIL`}`,
	);
	console.log(
		`\n__TRANSCRIPT_JSON__${JSON.stringify({ channelId: CHANNEL_ID, steps: transcript, failures })}`,
	);
	process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error("FATAL:", err);
	process.exit(2);
});
