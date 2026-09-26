// FLY-863 — real-Discord E2E for the codex-hold routine-vs-stuck signal fix.
//
// Drives the REAL compiled `AutoQaCoordinator` / `AutoQaEffects` /
// `LeadAlertNotifier` (dist, same code that ships) against an isolated
// StateStore + isolated CommDB, posting to the SAME 529-Room isolated test
// channel `#test-flywheel-alerts` (1519421055805165842, bot TEST_BOT_TOKEN_1)
// established leads/watchdog E2E QA has used before (see
// reference_qa_escalation_real_discord_module_driven.md). Never touches
// production Discord, production comm.db, or production StateStore.
//
// Scenarios:
//   A. Routine codex-hold (round 1, gate ON, no Codex approval yet) — the
//      overwhelmingly common "review hasn't run yet" moment every PR passes
//      through — must stay COMPLETELY silent (no thread post, no Lead alert),
//      while still queuing the /codex-code-review self-heal instruction.
//   B. The SAME head held past the stuck-duration threshold (real wall-clock
//      sleep, no fake clock) — must escalate EXACTLY ONCE: a real Discord post
//      to the thread channel AND a real Lead alert, both GET-read-back as
//      proof; a second reconcile pass after that must NOT re-post.
//   C. Regression guard — a session with NO valid pr_head_sha (the structural
//      "missing head" anomaly, not a routine loop) must still alert
//      immediately via the existing `reconcileCodexHolds` path (FLY-827
//      behavior, untouched by FLY-863).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.FLY863_ROOT || process.cwd();
const TL = join(ROOT, "packages/teamlead/dist");
const ALERT_CHANNEL_ID =
	process.env.FLY863_ALERT_CHANNEL_ID || "1519421055805165842";
const BOT_TOKEN_ENV = "TEST_BOT_TOKEN_1";
const RUN_ID = Math.random().toString(36).slice(2, 8);
const MARKER = `FLY863QA-${RUN_ID}`;

const imp = (root, p) => import(pathToFileURL(join(root, p)).href);
const { StateStore } = await imp(TL, "StateStore.js");
const { AutoQaCoordinator } = await imp(TL, "bridge/auto-qa-coordinator.js");
const { AutoQaEffects } = await imp(TL, "bridge/auto-qa-effects.js");
const { LeadAlertNotifier } = await imp(TL, "LeadAlertNotifier.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PASS = 0;
let FAIL = 0;
function check(label, cond, detail = "") {
	if (cond) {
		PASS++;
		console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		FAIL++;
		console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

if (!process.env[BOT_TOKEN_ENV]) {
	console.error(`FATAL: ${BOT_TOKEN_ENV} not set`);
	process.exit(2);
}

const LEAD_ID = `fly863qa-lead-${RUN_ID}`;
const PROJECT = `fly863qa-${RUN_ID}`;
const LABEL = "fly863qa";
const CHAT_CHANNEL = `chat-fly863qa-${RUN_ID}`;

const makeLead = () => ({
	agentId: LEAD_ID,
	chatChannel: CHAT_CHANNEL,
	botToken: process.env[BOT_TOKEN_ENV],
	alertChannel: ALERT_CHANNEL_ID,
	alertFallbackToCore: false,
	match: { labels: [LABEL] },
});
const PROJECTS = [
	{ projectName: PROJECT, generalChannel: "", leads: [makeLead()] },
];

const SANDBOX = mkdtempSync(join(tmpdir(), "qa-fly863-"));
process.env.FLYWHEEL_COMM_DIR = join(SANDBOX, "comm");
mkdirSync(join(process.env.FLYWHEEL_COMM_DIR, PROJECT), { recursive: true });

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function discordGetLatest(channelId, limit = 20) {
	const out = execFileSync(
		"curl",
		[
			"-s",
			"-H",
			`Authorization: Bot ${process.env[BOT_TOKEN_ENV]}`,
			`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`,
		],
		{ encoding: "utf8" },
	);
	return JSON.parse(out);
}

async function makeCoordinator({
	execId,
	issueId,
	envOverrides = {},
	queueTag,
}) {
	const store = await StateStore.create(
		join(SANDBOX, `state-${execId}-${Math.floor(Math.random() * 1e9)}.db`),
	);
	const notifier = new LeadAlertNotifier({
		store,
		projects: PROJECTS,
		queueDir: join(SANDBOX, `queue-${queueTag}`),
		deadLetterDir: join(SANDBOX, `dlq-${queueTag}`),
		unifiedAlert: {
			channelId: ALERT_CHANNEL_ID,
			repairBotTokenEnv: BOT_TOKEN_ENV,
		},
	});
	const alertCalls = [];
	const origAlert = notifier.alert.bind(notifier);
	notifier.alert = async (payload) => {
		const r = await origAlert(payload);
		alertCalls.push({ ...r, _payload: payload });
		return r;
	};

	const effects = new AutoQaEffects({
		store,
		projects: PROJECTS,
		config: {},
		leadAlertNotifier: notifier,
	});
	const postThreadCalls = [];
	const origPostThread = effects.postThread.bind(effects);
	effects.postThread = async (args) => {
		postThreadCalls.push(args);
		return origPostThread(args);
	};

	const coord = new AutoQaCoordinator({
		store,
		startDispatcher: {
			start: async () => {
				throw new Error("QA spawn should NEVER be reached in these scenarios");
			},
		},
		resolveQaPolicy: () => ({ enabled: true }),
		effects,
		env: { ...process.env, ...envOverrides },
		logger: { log: () => {}, warn: (m) => console.log(`    [warn] ${m}`) },
	});

	// Route postThread into the REAL observable test channel (a thread post is
	// just a message POST to a channel/thread id under the hood). Keyed on the
	// SAME issue_id the seeded session carries, so AutoQaEffects.resolveThread's
	// getChatThreadByIssue lookup actually finds this row.
	if (issueId) store.upsertChatThread(ALERT_CHANNEL_ID, CHAT_CHANNEL, issueId);

	return { store, notifier, effects, coord, alertCalls, postThreadCalls };
}

function seedAwaitingReview(store, { execId, issueId, sha }) {
	store.upsertSession({
		execution_id: execId,
		issue_id: issueId,
		project_name: PROJECT,
		status: "awaiting_review",
		session_role: "main",
		issue_title: `QA ${MARKER} — ${execId}`,
		issue_identifier: issueId,
		issue_labels: JSON.stringify([LABEL]),
		branch: `fly863-${execId}`,
		pr_number: 863,
	});
	if (sha) {
		store.setReviewBinding(execId, {
			questionId: `q-${execId}`,
			prHeadSha: sha,
		});
	}
	return store.getSession(execId);
}

// ─────────────────────── Scenario A: routine hold stays silent ───────────────────────
async function scnA_routine_hold_silent() {
	console.log(
		`\n=== Scenario A: fresh awaiting_review, Codex not yet approved (gate ON) — must stay SILENT (${MARKER}) ===`,
	);
	const execId = `exec-a-${RUN_ID}`;
	const issueId = `FLY-863-QA-A-${RUN_ID}`;
	const { store, coord, alertCalls, postThreadCalls } = await makeCoordinator({
		execId,
		issueId,
		queueTag: "a",
	});

	const before = discordGetLatest(ALERT_CHANNEL_ID);
	const session = seedAwaitingReview(store, { execId, issueId, sha: SHA_A });

	await coord.onMainAwaitingReview(session);

	check(
		"no postThread call fired",
		postThreadCalls.length === 0,
		`calls=${postThreadCalls.length}`,
	);
	check(
		"no Lead alert fired",
		alertCalls.length === 0,
		`calls=${alertCalls.length}`,
	);

	const rec = store.getCodexReviewRecord(execId, SHA_A);
	check(
		"hold WAS recorded internally (self-heal engaged, not broken)",
		rec?.status === "pending" && !!rec?.hold_notified_at,
		`record=${JSON.stringify(rec)}`,
	);
	check(
		"escalation NOT yet claimed for this head",
		!rec?.stuck_notified_at,
		`stuck_notified_at=${rec?.stuck_notified_at}`,
	);

	await sleep(1200); // give Discord a moment in case something DID fire
	const after = discordGetLatest(ALERT_CHANNEL_ID);
	const newMsgs = after.filter(
		(m) =>
			!before.some((b) => b.id === m.id) && (m.content ?? "").includes(MARKER),
	);
	check(
		"REAL Discord channel: zero new messages carrying our marker",
		newMsgs.length === 0,
		`new-marker-msgs=${newMsgs.length}`,
	);
}

// ─────────────────────── Scenario B: stuck past threshold escalates once ───────────────────────
async function scnB_stuck_escalates_once() {
	const STUCK_MS = 2000;
	console.log(
		`\n=== Scenario B: SAME head held past ${STUCK_MS}ms real threshold — escalate EXACTLY ONCE (${MARKER}) ===`,
	);
	const execId = `exec-b-${RUN_ID}`;
	const issueId = `FLY-863-QA-B-${RUN_ID}`;
	const { store, coord, alertCalls, postThreadCalls } = await makeCoordinator({
		execId,
		issueId,
		queueTag: "b",
		envOverrides: { FLYWHEEL_CODEX_HOLD_STUCK_MS: String(STUCK_MS) },
	});

	const session = seedAwaitingReview(store, { execId, issueId, sha: SHA_B });
	await coord.onMainAwaitingReview(session); // routine hold — silent (round 1)
	check(
		"round 1 silent before the real sleep",
		postThreadCalls.length === 0 && alertCalls.length === 0,
	);

	console.log(
		`  sleeping ${STUCK_MS + 500}ms real wall-clock past the threshold...`,
	);
	await sleep(STUCK_MS + 500);

	await coord.reconcileStuckCodexHolds();
	check(
		"postThread fired exactly once",
		postThreadCalls.length === 1,
		`calls=${postThreadCalls.length}`,
	);
	check(
		"Lead alert fired exactly once",
		alertCalls.length === 1,
		`calls=${alertCalls.length}`,
	);
	const alertResult = alertCalls[0];
	check(
		"alert eventType = codex_gate_blocked",
		alertResult?._payload?.eventType === "codex_gate_blocked",
		`eventType=${alertResult?._payload?.eventType}`,
	);
	check(
		"alert sent/queued (real Discord attempt)",
		!!alertResult && (alertResult.sent || alertResult.queued),
		`result=${JSON.stringify({ sent: alertResult?.sent, queued: alertResult?.queued, channelId: alertResult?.channelId, messageId: alertResult?.messageId })}`,
	);

	if (alertResult?.sent && alertResult?.channelId && alertResult?.messageId) {
		const out = execFileSync(
			"curl",
			[
				"-s",
				"-H",
				`Authorization: Bot ${process.env[BOT_TOKEN_ENV]}`,
				`https://discord.com/api/v10/channels/${alertResult.channelId}/messages/${alertResult.messageId}`,
			],
			{ encoding: "utf8" },
		);
		const msg = JSON.parse(out);
		check(
			"GET read-back: Lead-alert message exists in #test-flywheel-alerts",
			!!msg.id,
			`messageId=${msg.id}`,
		);
		check(
			"GET read-back body names the issue + 'stuck' framing",
			(msg.content ?? "").includes(issueId) &&
				/stuck|长时间|卡了/i.test(msg.content ?? ""),
			`content="${(msg.content ?? "").replace(/\n/g, " ").slice(0, 140)}"`,
		);
	} else {
		check(
			"GET read-back of Lead alert (needs sent+messageId)",
			false,
			JSON.stringify(alertResult),
		);
	}

	// The thread-post landed directly in the test channel (threadId == ALERT_CHANNEL_ID).
	// Match on the EXACT text the coordinator asked postThread to send (the
	// template doesn't embed the issue id — it's posted to the issue's own
	// thread, so the id is implicit — matching the pre-FLY-863 thread-post shape).
	const expectedText = postThreadCalls[0]?.text;
	const latest = discordGetLatest(ALERT_CHANNEL_ID, 10);
	const threadMsg = latest.find((m) => m.content === expectedText);
	check(
		"REAL Discord: the ⛔ thread post landed in the observable test channel",
		!!threadMsg,
		threadMsg
			? `content="${threadMsg.content.replace(/\n/g, " ").slice(0, 140)}"`
			: `expected="${expectedText}" not found among latest ${latest.length}`,
	);

	// Idempotency — a second reconcile pass must NOT re-post.
	await coord.reconcileStuckCodexHolds();
	await coord.reconcileStuckCodexHolds();
	check(
		"idempotent: repeated reconcileStuckCodexHolds does NOT re-fire",
		postThreadCalls.length === 1 && alertCalls.length === 1,
		`postThread=${postThreadCalls.length} alerts=${alertCalls.length}`,
	);
}

// ─────────────────────── Scenario C: missing-head structural anomaly still alerts ───────────────────────
async function scnC_missing_head_still_alerts() {
	console.log(
		`\n=== Scenario C (regression guard): missing pr_head_sha — structural anomaly must STILL alert immediately (${MARKER}) ===`,
	);
	const execId = `exec-c-${RUN_ID}`;
	const issueId = `FLY-863-QA-C-${RUN_ID}`;
	const { store, coord, alertCalls } = await makeCoordinator({
		execId,
		issueId,
		queueTag: "c",
	});

	// awaiting_review with NO pr_head_sha bound (missing-head shape).
	store.upsertSession({
		execution_id: execId,
		issue_id: issueId,
		project_name: PROJECT,
		status: "awaiting_review",
		session_role: "main",
		issue_title: `QA ${MARKER} — ${execId}`,
		issue_identifier: issueId,
		issue_labels: JSON.stringify([LABEL]),
		branch: `fly863-${execId}`,
	});

	await coord.reconcileCodexHolds();
	check(
		"missing-head anomaly alerts IMMEDIATELY (unchanged FLY-827 behavior)",
		alertCalls.length === 1,
		`calls=${alertCalls.length}`,
	);
	check(
		"eventId is the missing-head variant",
		alertCalls[0]?._payload?.eventId === `codex-gate-missing-head:${execId}`,
		`eventId=${alertCalls[0]?._payload?.eventId}`,
	);
}

console.log(`FLY-863 codex-hold signal real-Discord E2E (${MARKER})`);
console.log(`dist: ${TL}`);
console.log(`alert channel: ${ALERT_CHANNEL_ID}   sandbox: ${SANDBOX}`);

try {
	await scnA_routine_hold_silent();
	await scnB_stuck_escalates_once();
	await scnC_missing_head_still_alerts();
} catch (e) {
	console.error("Harness threw:", e);
	FAIL++;
}

console.log(`\n──────── SUMMARY  PASS=${PASS} FAIL=${FAIL} ────────`);
try {
	rmSync(SANDBOX, { recursive: true, force: true });
} catch {}
process.exit(FAIL === 0 ? 0 : 1);
