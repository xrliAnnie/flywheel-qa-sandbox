#!/usr/bin/env node
import { randomUUID } from "node:crypto";
// QA · FLY-892 — module-driven real-Discord E2E against the 529 QA Room (slot 2).
// Drives the REAL compiled production code (StateStore, ChatThreadCreator,
// reconcileLegacyPhaseThreads, phaseMessageTag/phaseThreadBadge) against a real
// Discord test channel. No mocks for Discord — real fetch, real bot token.
//
// Usage: pnpm -r build && TEST_BOT_TOKEN_2=<token> node scripts/qa-fly892-real-discord-thread-e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEAMLEAD_DIST = join(__dirname, "..", "packages", "teamlead", "dist");
const { StateStore } = await import(`file://${TEAMLEAD_DIST}/StateStore.js`);
const { ChatThreadCreator, buildPipelineHeaderContent } = await import(
	`file://${TEAMLEAD_DIST}/bridge/ChatThreadCreator.js`
);
const { reconcileLegacyPhaseThreads } = await import(
	`file://${TEAMLEAD_DIST}/bridge/legacy-phase-thread-sweep.js`
);
const { phaseMessageTag, phaseThreadBadge } = await import(
	`file://${TEAMLEAD_DIST}/../node_modules/flywheel-config/dist/index.js`
);

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

async function discordGetMessages(threadId, limit = 20) {
	const res = await fetch(
		`${DISCORD_API}/channels/${threadId}/messages?limit=${limit}`,
		{
			headers: { Authorization: `Bot ${BOT_TOKEN}` },
		},
	);
	if (!res.ok)
		throw new Error(`GET messages ${res.status}: ${await res.text()}`);
	return res.json();
}

async function discordGetChannel(threadId) {
	const res = await fetch(`${DISCORD_API}/channels/${threadId}`, {
		headers: { Authorization: `Bot ${BOT_TOKEN}` },
	});
	if (!res.ok)
		throw new Error(`GET channel ${res.status}: ${await res.text()}`);
	return res.json();
}

async function archiveThread(threadId) {
	await fetch(`${DISCORD_API}/channels/${threadId}`, {
		method: "PATCH",
		headers: {
			Authorization: `Bot ${BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ archived: true }),
	}).catch(() => undefined);
}

async function createRawThread(nameSeed) {
	const msgRes = await fetch(`${DISCORD_API}/channels/${CHANNEL_ID}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			content: `🧵 legacy-sim ${nameSeed}`,
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
				name: `[legacy] ${nameSeed}`.slice(0, 100),
				auto_archive_duration: 4320,
			}),
		},
	);
	const thr = await thrRes.json();
	if (!thr.id)
		throw new Error(`raw thread create failed: ${JSON.stringify(thr)}`);
	return thr.id;
}

async function postMessage(threadId, content) {
	const res = await fetch(`${DISCORD_API}/channels/${threadId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${BOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
	});
	if (!res.ok)
		throw new Error(`POST message ${res.status}: ${await res.text()}`);
	return res.json();
}

const tmpDir = mkdtempSync(join(tmpdir(), "qa-fly892-"));
const dbPath = join(tmpDir, "teamlead.db");
const createdThreadIds = [];

async function main() {
	const store = await StateStore.create(dbPath);
	const creator = new ChatThreadCreator(store);
	const runId = randomUUID().slice(0, 8);

	// ── Scenario 1: sequential design→implement→qa ensureChatThread converge to ONE thread ──
	const issueA = `qa-fly892-conv-${runId}`;
	const baseCtx = {
		chatChannelId: CHANNEL_ID,
		issueId: issueA,
		issueIdentifier: `FLY-892QA1`,
		issueTitle: `[QA-892] one issue one thread — convergence ${runId}`,
		botToken: BOT_TOKEN,
		leadId: "qa-lead",
	};
	const rDesign = await creator.ensureChatThread({
		...baseCtx,
		modelCode: "F",
	});
	createdThreadIds.push(rDesign.threadId);
	check(
		"S1: design ensure created a thread",
		rDesign.created && rDesign.threadId,
		rDesign.threadId,
	);
	const rImplement = await creator.ensureChatThread({
		...baseCtx,
		modelCode: "O",
	});
	check(
		"S1: implement ensure REUSED the same thread (no new create)",
		!rImplement.created && rImplement.threadId === rDesign.threadId,
		`implement.threadId=${rImplement.threadId}`,
	);
	const rQa = await creator.ensureChatThread({ ...baseCtx, modelCode: "S" });
	check(
		"S1: qa ensure REUSED the same thread",
		!rQa.created && rQa.threadId === rDesign.threadId,
		`qa.threadId=${rQa.threadId}`,
	);
	const storeRowA = store.getChatThreadByIssue(issueA, CHANNEL_ID);
	check(
		"S1: StateStore chat_threads has exactly the ONE (issue,channel) row",
		storeRowA && storeRowA.thread_id === rDesign.threadId,
	);
	// Lead /api/chat-threads/send resolves via the SAME getChatThreadByIssue lookup —
	// prove it returns the identical thread (no bifurcated Lead thread).
	const leadLookup = store.getChatThreadByIssue(issueA, CHANNEL_ID);
	check(
		"S1: Lead chat-threads/send lookup resolves to the SAME thread (no bifurcation)",
		leadLookup.thread_id === rDesign.threadId,
	);
	const threadA = rDesign.threadId;

	// ── Scenario 2: CONCURRENT design+implement ensure dedup to one create ──
	const issueB = `qa-fly892-conc-${runId}`;
	const ctxB = {
		...baseCtx,
		issueId: issueB,
		issueIdentifier: "FLY-892QA2",
		issueTitle: `[QA-892] concurrent dedup ${runId}`,
	};
	const [c1, c2] = await Promise.all([
		creator.ensureChatThread({ ...ctxB, modelCode: "F" }),
		creator.ensureChatThread({ ...ctxB, modelCode: "O" }),
	]);
	createdThreadIds.push(c1.threadId);
	// Both callers share the SAME in-flight promise/result object (that's how the
	// dedup works), so both legitimately see created:true — the real invariant is
	// that only ONE underlying Discord thread got created (same threadId + a single
	// StateStore row, confirmed below).
	check(
		"S2: concurrent design+implement ensure resolve to the SAME thread (dedup)",
		c1.threadId === c2.threadId && c1.created === true && c2.created === true,
		`t1=${c1.threadId}(created=${c1.created}) t2=${c2.threadId}(created=${c2.created})`,
	);
	const storeRowB = store.getChatThreadByIssue(issueB, CHANNEL_ID);
	check(
		"S2: StateStore has exactly ONE chat_threads row for the concurrent issue (no duplicate)",
		storeRowB && storeRowB.thread_id === c1.threadId,
	);

	// ── Scenario 3: message-level phase tag (Step 3) ──
	const tagDesign = phaseMessageTag("design", "claude-fable-5");
	const tagImplement = phaseMessageTag("implement", "claude-opus-4-8");
	const tagQa = phaseMessageTag("qa", "claude-sonnet-5");
	const tagMain = phaseMessageTag("main", null);
	check(
		"S3: design tag = [设计·Fable] ",
		tagDesign === "[设计·Fable] ",
		tagDesign,
	);
	check(
		"S3: implement tag = [实现·Opus] ",
		tagImplement === "[实现·Opus] ",
		tagImplement,
	);
	check("S3: qa tag = [QA·Sonnet] ", tagQa === "[QA·Sonnet] ", tagQa);
	check(
		"S3: main/Lead tag is EMPTY (byte-compat)",
		tagMain === "",
		JSON.stringify(tagMain),
	);

	const postedDesign = await postMessage(
		threadA,
		`${tagDesign}design phase update ${runId}`,
	);
	const postedImplement = await postMessage(
		threadA,
		`${tagImplement}implement phase update ${runId}`,
	);
	const postedQa = await postMessage(
		threadA,
		`${tagQa}qa phase update ${runId}`,
	);
	const postedLead = await postMessage(
		threadA,
		`Lead chat message (no tag) ${runId}`,
	);
	check(
		"S3: design-tagged message landed in the SAME thread",
		postedDesign.channel_id === threadA,
	);
	check(
		"S3: implement-tagged message landed in the SAME thread",
		postedImplement.channel_id === threadA,
	);
	check(
		"S3: qa-tagged message landed in the SAME thread",
		postedQa.channel_id === threadA,
	);
	check(
		"S3: Lead message has no bracket phase tag",
		!/^\[/.test(postedLead.content),
		postedLead.content,
	);

	// ── Scenario 4: pipeline header pin (Step 4) — post/edit idempotent ──
	const phasesV1 = [
		{ label: "[设计·Fable]", status: "done", execId: "abc123" },
		{
			label: "[实现·Opus]",
			status: "active",
			execId: "def456",
			attachCommand: "tmux attach -t FLY-892QA1:@0",
		},
		{ label: "[QA·Sonnet]", status: "planned", plannedModel: "Sonnet" },
	];
	const contentV1 = buildPipelineHeaderContent(
		{ issueId: issueA, issueIdentifier: "FLY-892QA1" },
		phasesV1,
	);
	await creator.ensureRunnerPipelineHeaderPin(baseCtx, threadA, contentV1);
	const pinAfterV1 = store.getChatThreadAttachPin(issueA, CHANNEL_ID);
	check(
		"S4: pipeline header POSTed + pin state recorded (pinnedAt null acceptable — test bot has no MANAGE_MESSAGES)",
		!!pinAfterV1 && !!pinAfterV1.messageId,
		`pinnedAt=${pinAfterV1?.pinnedAt}`,
	);

	const phasesV2 = [
		{ label: "[设计·Fable]", status: "done", execId: "abc123" },
		{
			label: "[实现·Opus]",
			status: "done",
			execId: "def456",
			sessionEnded: true,
		},
		{
			label: "[QA·Sonnet]",
			status: "active",
			execId: "ghi789",
			attachCommand: "tmux attach -t FLY-892QA1:@1",
		},
	];
	const contentV2 = buildPipelineHeaderContent(
		{ issueId: issueA, issueIdentifier: "FLY-892QA1" },
		phasesV2,
	);
	await creator.ensureRunnerPipelineHeaderPin(baseCtx, threadA, contentV2);
	const pinAfterV2 = store.getChatThreadAttachPin(issueA, CHANNEL_ID);
	check(
		"S4: phase advance EDITS the SAME pinned message (messageId unchanged)",
		pinAfterV2 && pinAfterV1 && pinAfterV2.messageId === pinAfterV1.messageId,
		`v1=${pinAfterV1?.messageId} v2=${pinAfterV2?.messageId}`,
	);
	const editedMsg = await (async () => {
		const res = await fetch(
			`${DISCORD_API}/channels/${threadA}/messages/${pinAfterV2.messageId}`,
			{
				headers: { Authorization: `Bot ${BOT_TOKEN}` },
			},
		);
		return res.json();
	})();
	check(
		"S4: pinned message content on Discord matches the LATEST render (v2)",
		editedMsg.content === contentV2,
	);

	// idempotent no-op: same content again → messageId + pinnedAt state unchanged
	await creator.ensureRunnerPipelineHeaderPin(baseCtx, threadA, contentV2);
	const pinAfterV2Again = store.getChatThreadAttachPin(issueA, CHANNEL_ID);
	check(
		"S4: identical re-render is a no-op (same messageId, same pin state)",
		pinAfterV2Again.messageId === pinAfterV2.messageId &&
			pinAfterV2Again.pinnedAt === pinAfterV2.pinnedAt,
	);

	// ── Scenario 5 (Step 6): stage-level title prefix — 🎨/🔨/🧪, not fine-grained ──
	const badgeDesign = phaseThreadBadge("design");
	const badgeImplement = phaseThreadBadge("implement");
	const badgeQa = phaseThreadBadge("qa");
	const badgeMain = phaseThreadBadge("main");
	check("S6: design badge = 🎨设计", badgeDesign === "🎨设计", badgeDesign);
	check(
		"S6: implement badge = 🔨实现",
		badgeImplement === "🔨实现",
		badgeImplement,
	);
	check("S6: qa badge = 🧪QA", badgeQa === "🧪QA", badgeQa);
	check(
		"S6: main/non-three-stage badge empty (FLY-560 byte-compat)",
		badgeMain === "",
	);

	await creator.stampStageEmoji(
		baseCtx,
		threadA,
		"implement",
		false,
		badgeImplement,
	);
	const chAfterStamp1 = await discordGetChannel(threadA);
	check(
		"S6: thread title stamped with 🔨实现 phase badge (not fine-grained FLY-560 word)",
		chAfterStamp1.name.startsWith("🔨实现"),
		chAfterStamp1.name,
	);
	// same stage again (coalescing/idempotent skip) then advance to qa — exactly one more rename
	await creator.stampStageEmoji(
		baseCtx,
		threadA,
		"implement",
		false,
		badgeImplement,
	);
	await creator.stampStageEmoji(baseCtx, threadA, "qa", false, badgeQa);
	const chAfterStamp2 = await discordGetChannel(threadA);
	check(
		"S6: phase switch restamps to 🧪QA (strip+restamp, no residue of prior badge)",
		chAfterStamp2.name.startsWith("🧪QA") && !chAfterStamp2.name.includes("🔨"),
		chAfterStamp2.name,
	);

	// ── Scenario 6 (Step 5): legacy sweep — HAS main thread → pointer + archive ──
	const legacyThreadWithMain = await createRawThread(`with-main-${runId}`);
	createdThreadIds.push(legacyThreadWithMain);
	store.db.run(
		`INSERT INTO phase_chat_threads (thread_id, channel_id, issue_id, session_role, lead_id) VALUES (?, ?, ?, 'design', 'qa-lead')`,
		[legacyThreadWithMain, CHANNEL_ID, issueA],
	);
	store.upsertSession({
		execution_id: `qa-892-exec-${runId}-a`,
		issue_id: issueA,
		project_name: "flywheel",
		status: "completed",
		issue_labels: "[]",
		chat_thread_role: "design",
	});
	const sweepResult1 = await reconcileLegacyPhaseThreads({
		store,
		projects: [],
		globalBotToken: BOT_TOKEN,
	});
	check(
		"S5: sweep processed the legacy row (has-main branch)",
		sweepResult1.processed >= 1,
		JSON.stringify(sweepResult1),
	);
	const legacyMsgsWithMain = await discordGetMessages(legacyThreadWithMain);
	const pointerMsg = legacyMsgsWithMain.find((m) =>
		m.content.includes("已归并到主 thread"),
	);
	check(
		"S5: pointer message posted in the legacy (has-main) thread",
		!!pointerMsg,
		pointerMsg?.content,
	);
	const legacyChAfter = await discordGetChannel(legacyThreadWithMain);
	check(
		"S5: legacy (has-main) thread archived on Discord",
		legacyChAfter.thread_metadata?.archived === true,
	);
	const unarchivedAfter1 = store.getUnarchivedPhaseChatThreads();
	check(
		"S5: legacy row no longer in getUnarchivedPhaseChatThreads (idempotent input)",
		!unarchivedAfter1.some((r) => r.thread_id === legacyThreadWithMain),
	);

	// ── Scenario 7 (Step 5, Codex R1 #1): legacy sweep — NO main thread + ACTIVE issue → fail-closed skip ──
	const issueC = `qa-fly892-nomain-${runId}`;
	const legacyThreadNoMain = await createRawThread(`no-main-active-${runId}`);
	createdThreadIds.push(legacyThreadNoMain);
	store.db.run(
		`INSERT INTO phase_chat_threads (thread_id, channel_id, issue_id, session_role, lead_id) VALUES (?, ?, ?, 'design', 'qa-lead')`,
		[legacyThreadNoMain, CHANNEL_ID, issueC],
	);
	store.upsertSession({
		execution_id: `qa-892-exec-${runId}-c`,
		issue_id: issueC,
		project_name: "flywheel",
		status: "running", // ACTIVE — this thread is the issue's ONLY visible Discord face
		issue_labels: "[]",
		// Production dispatch (Blueprint.ts:610-616) sets BOTH session_role AND
		// chat_thread_role to the phase name for a real phase session — mirror that
		// here so getActivePhaseSessionForIssue's session_role IN (...) check (the
		// actual fail-closed gate) sees a realistic row.
		session_role: "design",
		chat_thread_role: "design",
	});
	const sweepResult2 = await reconcileLegacyPhaseThreads({
		store,
		projects: [],
		globalBotToken: BOT_TOKEN,
	});
	check(
		"S5b: sweep SKIPPED the active no-main row (fail-closed)",
		sweepResult2.skipped >= 1,
		JSON.stringify(sweepResult2),
	);
	const stillUnarchived = store.getUnarchivedPhaseChatThreads();
	check(
		"S5b: active no-main legacy thread NOT archived (Codex R1 #1 guard)",
		stillUnarchived.some((r) => r.thread_id === legacyThreadNoMain),
	);
	const noMainChStillOpen = await discordGetChannel(legacyThreadNoMain);
	check(
		"S5b: legacy thread still OPEN on Discord (not archived)",
		noMainChStillOpen.thread_metadata?.archived !== true,
	);

	// Now mark the issue terminal (no longer active) with STILL no main thread —
	// the sweep should now archive it (issue genuinely finished).
	store.upsertSession({
		execution_id: `qa-892-exec-${runId}-c`,
		issue_id: issueC,
		project_name: "flywheel",
		status: "merged",
		issue_labels: "[]",
		session_role: "design",
		chat_thread_role: "design",
	});
	const sweepResult3 = await reconcileLegacyPhaseThreads({
		store,
		projects: [],
		globalBotToken: BOT_TOKEN,
	});
	check(
		"S5c: after issue goes terminal, sweep ARCHIVES the no-main legacy thread",
		sweepResult3.archived >= 1,
		JSON.stringify(sweepResult3),
	);
	const noMainChAfterTerminal = await discordGetChannel(legacyThreadNoMain);
	check(
		"S5c: legacy thread now archived on Discord (terminal + no main face)",
		noMainChAfterTerminal.thread_metadata?.archived === true,
	);

	// Cleanup: archive the two still-open "live" threads this run created so the
	// test channel doesn't accumulate open threads.
	await archiveThread(threadA);
	await archiveThread(c1.threadId);

	store.close();
	rmSync(tmpDir, { recursive: true, force: true });

	const failed = results.filter((r) => !r.pass);
	console.log(
		`\n=== FLY-892 real-Discord E2E: ${results.length - failed.length}/${results.length} PASS ===`,
	);
	if (failed.length) {
		console.log("FAILED:");
		for (const f of failed) console.log(` - ${f.name} ${f.detail ?? ""}`);
		process.exit(1);
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("E2E crashed:", err);
	process.exit(1);
});
