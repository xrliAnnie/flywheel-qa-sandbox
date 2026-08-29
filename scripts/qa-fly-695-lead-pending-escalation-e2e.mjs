// FLY-695 — real-Discord E2E for FLY-637-ext lead-pending escalation.
//
// Independent QA filling the gap FLY-692 left explicit (FLY-692 = mock-clock
// logic + better-sqlite3 persistence only; "不含 live 端到端: 真 Discord 催 Lead /
// 页 Annie, 不实跑真 timer"). This harness drives the REAL `GatePoller.poll()`
// loop against real isolated components with SECONDS-level policy so we never
// wait the production 20min–2h.
//
//   - real isolated StateStore (better-sqlite3, temp file)  — sessions + backoff rows
//   - real isolated CommDB (FLYWHEEL_COMM_DIR temp dir)      — blocking `question` gate
//   - real MailboxLeadRuntime + real ClaudeCodeAdapter       — nudge → REAL inbox JSON
//   - real LeadAlertNotifier → isolated #test-flywheel-alerts — page → REAL Discord post (GET read-back)
//
// SAFETY: never touches production. FLYWHEEL_COMM_DIR / CLAUDE_CONFIG_DIR /
// FLYWHEEL_ALERT_* / FLYWHEEL_CLAIMS_DB all point at a fresh temp sandbox. The
// page is a CHANNEL post to the isolated 529-Room test channel — NOT a DM, so
// Annie's real DM is never paged.
//
// ARCHITECTURE NOTE (Tadashi-confirmed; report prominently):
//   nudge Lead = runner_lead_pending_escalation → runtime.deliver() →
//                MailboxLeadRuntime writes the Lead inbox JSON (= Lead really
//                receives it). NOT a direct Discord post; a live Lead relays it
//                into Discord (separate mechanism, out of FLY-637 scope).
//   page Annie = runner_lead_pending_unhandled → LeadAlertNotifier.alert() →
//                REAL Discord POST to the unified alert channel.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FLY637_ROOT =
	process.env.FLY637_ROOT ||
	join(homedir(), "Dev/flywheel-FLY-695/worktrees/fly-637-qa");
const TL = join(FLY637_ROOT, "packages/teamlead/dist");
const COMM = join(FLY637_ROOT, "packages/flywheel-comm/dist");
const XPORT = join(FLY637_ROOT, "packages/agent-team-transport/dist/src");
const ALERT_CHANNEL_ID =
	process.env.FLY695_ALERT_CHANNEL_ID || "1519421055805165842";
const BOT_TOKEN_ENV = "TEST_BOT_TOKEN_1";
const ONLY = process.env.FLY695_ONLY || "";

const imp = (root, p) => import(pathToFileURL(join(root, p)).href);
const { StateStore } = await imp(TL, "StateStore.js");
const { GatePoller } = await imp(TL, "bridge/gate-poller.js");
const { LeadAlertNotifier } = await imp(TL, "LeadAlertNotifier.js");
const { MailboxLeadRuntime } = await imp(TL, "bridge/mailbox-lead-runtime.js");
const { RuntimeRegistry } = await imp(TL, "bridge/runtime-registry.js");
const { createClaimsReader, createClaimsClaimer, resolveAlertDirsFromEnv } =
	await imp(TL, "bridge/lead-alert-helpers.js");
const { ClaudeCodeAdapter } = await imp(XPORT, "index.js");
const { CommDB } = await imp(COMM, "db.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
let PASS = 0;
let FAIL = 0;
const RESULTS = [];
const PAGE_EVIDENCE = [];
function check(label, cond, detail = "") {
	if (cond) {
		PASS++;
		console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
	} else {
		FAIL++;
		console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
	}
	RESULTS.push({ label, ok: !!cond, detail });
}

const LEAD_ID = "qa695-test-lead";
const PROJECT = "qa-fly695";
const LABEL = "qa695";
const EXEC = "exec-qa695";

const makeLead = () => ({
	agentId: LEAD_ID,
	chatChannel: "C-qa695",
	botToken: process.env[BOT_TOKEN_ENV] || "unused-for-mailbox",
	botTokenEnv: BOT_TOKEN_ENV,
	alertChannel: ALERT_CHANNEL_ID,
	alertFallbackToCore: false,
	match: { labels: [LABEL] },
});
const PROJECTS = [
	{ projectName: PROJECT, generalChannel: "", leads: [makeLead()] },
];

const SANDBOX = mkdtempSync(join(tmpdir(), "qa-fly695-"));

function setEnvDirs() {
	const base = mkdtempSync(join(SANDBOX, "scn-"));
	const dirs = {
		comm: join(base, "comm"),
		claude: join(base, "claude"),
		queue: join(base, "alert-queue"),
		dlq: join(base, "alert-deadletter"),
		claims: join(base, "claims.db"),
		state: join(base, "state.db"),
	};
	mkdirSync(join(dirs.comm, PROJECT), { recursive: true });
	mkdirSync(join(dirs.claude, "teams", LEAD_ID, "inboxes"), {
		recursive: true,
	});
	mkdirSync(dirs.queue, { recursive: true });
	mkdirSync(dirs.dlq, { recursive: true });
	process.env.FLYWHEEL_COMM_DIR = dirs.comm;
	process.env.CLAUDE_CONFIG_DIR = dirs.claude;
	process.env.FLYWHEEL_ALERT_QUEUE_DIR = dirs.queue;
	process.env.FLYWHEEL_ALERT_DEADLETTER_DIR = dirs.dlq;
	process.env.FLYWHEEL_CLAIMS_DB = dirs.claims;
	return dirs;
}
function setPolicy({ grace, factor = 2, cap, rounds, killSwitch = false }) {
	process.env.FLYWHEEL_LEAD_NUDGE_GRACE_MS = String(grace);
	process.env.FLYWHEEL_LEAD_NUDGE_BACKOFF_FACTOR = String(factor);
	process.env.FLYWHEEL_LEAD_NUDGE_CAP_MS = String(cap);
	process.env.FLYWHEEL_LEAD_NUDGE_PAGE_ANNIE_ROUNDS = String(rounds);
	if (killSwitch) process.env.FLYWHEEL_LEAD_PENDING_ESCALATION = "0";
	else delete process.env.FLYWHEEL_LEAD_PENDING_ESCALATION;
}

const commDbPath = () =>
	join(process.env.FLYWHEEL_COMM_DIR, PROJECT, "comm.db");
const inboxPath = () =>
	join(
		process.env.CLAUDE_CONFIG_DIR,
		"teams",
		LEAD_ID,
		"inboxes",
		`${LEAD_ID}.json`,
	);
function readInbox() {
	const p = inboxPath();
	if (!existsSync(p)) return [];
	try {
		const raw = JSON.parse(readFileSync(p, "utf8"));
		return Array.isArray(raw)
			? raw
			: Array.isArray(raw?.messages)
				? raw.messages
				: [];
	} catch {
		return [];
	}
}
const inboxText = (m) =>
	String(m?.text ?? m?.content ?? m?.message ?? JSON.stringify(m));
const nudgeMessages = () =>
	readInbox().filter((m) => /reminder #\d+/i.test(inboxText(m)));

async function setup() {
	const store = await StateStore.create(
		join(SANDBOX, `state-${Math.floor(Math.random() * 1e9)}.db`),
	);
	const runtime = new MailboxLeadRuntime({
		leadId: LEAD_ID,
		transport: new ClaudeCodeAdapter(),
	});
	const registry = new RuntimeRegistry();
	registry.register(makeLead(), runtime);
	const notifier = new LeadAlertNotifier({
		store,
		projects: PROJECTS,
		claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
		claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
		unifiedAlert: {
			channelId: ALERT_CHANNEL_ID,
			repairBotTokenEnv: BOT_TOKEN_ENV,
		},
		...resolveAlertDirsFromEnv(process.env),
	});
	// Record every alert the GatePoller fires (the page path) for inspection.
	const pages = [];
	const origAlert = notifier.alert.bind(notifier);
	notifier.alert = async (payload) => {
		const r = await origAlert(payload);
		pages.push({
			...r,
			_eventType: payload.eventType,
			_title: payload.title,
			_body: payload.body,
		});
		return r;
	};
	store.upsertSession({
		execution_id: EXEC,
		issue_id: "FLY-695",
		issue_identifier: "FLY-695",
		issue_title: "QA lead-pending escalation",
		project_name: PROJECT,
		status: "running",
		issue_labels: JSON.stringify([LABEL]),
		session_role: "main",
		session_stage: "implement",
	});
	const poller = new GatePoller({
		pollIntervalMs: 1000,
		projects: PROJECTS,
		store,
		runtimeRegistry: registry,
		chatThreadsEnabled: false,
		leadAlertSink: notifier,
		leadPendingPruneEveryNTicks: 2,
	});
	return { poller, store, notifier, pages };
}

const tick = (poller) => poller.poll(); // TS-private; real method at runtime
function seedQuestion(
	checkpoint = "question",
	content = "BLOCKING: approach A or B?",
) {
	const comm = new CommDB(commDbPath());
	const qid = comm.insertQuestion(
		EXEC,
		LEAD_ID,
		content,
		checkpoint == null ? {} : { checkpoint },
	);
	comm.close();
	return qid;
}
function answerQuestion(qid) {
	const comm = new CommDB(commDbPath());
	comm.insertResponse(qid, LEAD_ID, "Use approach A. — test-lead"); // drops question from pending
	comm.close();
}
function discordGet(channelId, messageId) {
	const out = execFileSync(
		"curl",
		[
			"-s",
			"-H",
			`Authorization: Bot ${process.env[BOT_TOKEN_ENV]}`,
			`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
		],
		{ encoding: "utf8" },
	);
	return JSON.parse(out);
}

// ─────────────────────── Scenario 1: nudge backoff + REAL page ───────────────────────
async function scn1_nudge_backoff_and_page() {
	console.log(
		"\n=== Scenario 1: real nudge backoff (grace→2×→4×) + REAL Discord page (rounds=2) ===",
	);
	setEnvDirs();
	setPolicy({ grace: 5000, factor: 2, cap: 600000, rounds: 2 });
	const { poller, pages } = await setup();
	const qid = seedQuestion();
	console.log(
		`  seeded blocking question gate qid=${qid}; grace=5s factor=2 cap=10min rounds=2`,
	);

	await tick(poller);
	check(
		"AC1 no nudge before grace",
		nudgeMessages().length === 0,
		`inbox nudges=${nudgeMessages().length}`,
	);

	const tg = now();
	await sleep(5300);
	await tick(poller);
	const n1 = nudgeMessages();
	check(
		"AC1 nudge #1 → REAL Lead mailbox after grace",
		n1.length === 1,
		`t=+${((now() - tg) / 1000).toFixed(1)}s; inbox="${n1[0] ? inboxText(n1[0]).replace(/\n/g, " ").slice(0, 80) : "(none)"}"`,
	);
	const t1 = now();

	await sleep(4000);
	await tick(poller);
	check(
		"AC2 no nudge #2 before grown interval",
		nudgeMessages().length === 1,
		`+${((now() - t1) / 1000).toFixed(1)}s after #1 (interval ~10s)`,
	);

	await sleep(6700);
	await tick(poller);
	check(
		"AC2 nudge #2 after ~2×grace (≈10s)",
		nudgeMessages().length === 2,
		`interval #1→#2 ≈ ${((now() - t1) / 1000).toFixed(1)}s`,
	);
	const t2 = now();

	await sleep(21000);
	await tick(poller);
	const dtp = (now() - t2) / 1000;
	const page = pages[pages.length - 1];
	check(
		"AC2 page interval ~4×grace (≈20s)",
		dtp >= 16 && dtp <= 27,
		`interval #2→page ≈ ${dtp.toFixed(1)}s`,
	);
	check(
		"AC3 page fired a REAL Discord alert (sent|queued)",
		!!page && (page.sent || page.queued),
		`result=${JSON.stringify({ sent: page?.sent, queued: page?.queued, channelId: page?.channelId, messageId: page?.messageId })}`,
	);
	check(
		"AC3 page eventType = runner_lead_pending_unhandled",
		page?._eventType === "runner_lead_pending_unhandled",
		`eventType=${page?._eventType}`,
	);
	check(
		"AC3 nudge count still 2 (page is NOT a mailbox nudge)",
		nudgeMessages().length === 2,
		`inbox nudges=${nudgeMessages().length}`,
	);

	if (page?.sent && page?.channelId && page?.messageId) {
		try {
			const msg = discordGet(page.channelId, page.messageId);
			const txt = `${msg.content ?? ""} ${JSON.stringify(msg.embeds ?? [])}`;
			check(
				"AC3 GET read-back: page exists in #test-flywheel-alerts",
				!!msg.id,
				`messageId=${msg.id}`,
			);
			check(
				"AC3 GET read-back body names FLY-695 + Lead-unresponsive",
				/FLY-695/.test(txt) && /unresponsive|waiting/i.test(txt),
				`content="${(msg.content ?? "").replace(/\n/g, " ").slice(0, 110)}"`,
			);
			PAGE_EVIDENCE.push({
				scenario: "scn1",
				channelId: page.channelId,
				messageId: msg.id,
				content: msg.content,
			});
			console.log(
				`  📨 PAGE EVIDENCE → channel=${page.channelId} message=${msg.id}`,
			);
		} catch (e) {
			check("AC3 GET read-back of page", false, `GET failed: ${e.message}`);
		}
	} else
		check(
			"AC3 GET read-back (needs sent+messageId)",
			false,
			`page=${JSON.stringify(page)}`,
		);
}

// ─────────────────────── Scenario 2: Lead answered → stop + clear ───────────────────────
async function scn2_answered_stops() {
	console.log(
		"\n=== Scenario 2: Lead answered → nudges stop + backoff state cleared (AC4) ===",
	);
	setEnvDirs();
	setPolicy({ grace: 3000, factor: 2, cap: 600000, rounds: 3 });
	const { poller, store, pages } = await setup();
	const qid = seedQuestion();

	await sleep(3300);
	await tick(poller);
	check(
		"AC4 nudge #1 fired (precondition)",
		nudgeMessages().length === 1,
		`nudges=${nudgeMessages().length}`,
	);
	check(
		"AC4 backoff row exists while pending",
		!!store.getLeadPendingEscalation(EXEC, qid),
		`row=${JSON.stringify(store.getLeadPendingEscalation(EXEC, qid))}`,
	);

	answerQuestion(qid);
	console.log("  Lead answered the question (inserted a response).");

	// Past the next eligible interval (2×grace=6s) — without the answer, #2 would fire.
	await sleep(7000);
	await tick(poller);
	await tick(poller);
	await tick(poller); // a few ticks (one is prune-eligible)
	check(
		"AC4 NO further nudge after the answer",
		nudgeMessages().length === 1,
		`nudges=${nudgeMessages().length} (still 1)`,
	);
	check(
		"AC4 backoff state cleared after answer (pruned)",
		store.getLeadPendingEscalation(EXEC, qid) === undefined,
		`row=${JSON.stringify(store.getLeadPendingEscalation(EXEC, qid))}`,
	);
	check(
		"AC4 no page (answered before page round)",
		pages.length === 0,
		`pages=${pages.length}`,
	);
}

// ─────────────────────── Scenario 3: kill-switch ───────────────────────
async function scn3_kill_switch() {
	console.log(
		"\n=== Scenario 3: kill-switch FLYWHEEL_LEAD_PENDING_ESCALATION=0 → no nudge, no page (AC5) ===",
	);
	setEnvDirs();
	setPolicy({
		grace: 2000,
		factor: 2,
		cap: 600000,
		rounds: 1,
		killSwitch: true,
	});
	const { poller, store, pages } = await setup();
	const qid = seedQuestion();

	await sleep(2500);
	for (let i = 0; i < 4; i++) {
		await tick(poller);
		await sleep(1500);
	} // would nudge+page if enabled
	check(
		"AC5 kill-switch: zero nudges",
		nudgeMessages().length === 0,
		`nudges=${nudgeMessages().length}`,
	);
	check(
		"AC5 kill-switch: zero pages",
		pages.length === 0,
		`pages=${pages.length}`,
	);
	check(
		"AC5 kill-switch: no backoff row created",
		store.getLeadPendingEscalation(EXEC, qid) === undefined,
		"row=undefined",
	);
}

// ─────────────────────── Scenario 4: exclusions ───────────────────────
async function scn4_exclusions() {
	console.log(
		"\n=== Scenario 4: exclusions — non-blocking ask / founder-facing / frozen do NOT trigger (AC6) ===",
	);

	// 4a non-blocking ask (checkpoint=null)
	setEnvDirs();
	setPolicy({ grace: 2000, factor: 2, cap: 600000, rounds: 2 });
	let s = await setup();
	seedQuestion(null, "FYI (non-blocking): I picked A and kept going");
	await sleep(2500);
	for (let i = 0; i < 3; i++) {
		await tick(s.poller);
		await sleep(800);
	}
	check(
		"AC6 non-blocking ask (checkpoint=null) → no nudge",
		nudgeMessages().length === 0,
		`nudges=${nudgeMessages().length}`,
	);
	check(
		"AC6 non-blocking ask → no page",
		s.pages.length === 0,
		`pages=${s.pages.length}`,
	);

	// 4b founder-facing gates (approve_to_ship + brainstorm)
	setEnvDirs();
	setPolicy({ grace: 2000, factor: 2, cap: 600000, rounds: 2 });
	s = await setup();
	seedQuestion("approve_to_ship", "Ready to ship — approve?");
	const comm = new CommDB(commDbPath());
	comm.insertQuestion(EXEC, LEAD_ID, "Approve this design direction?", {
		checkpoint: "brainstorm",
	});
	comm.close();
	await sleep(2500);
	for (let i = 0; i < 3; i++) {
		await tick(s.poller);
		await sleep(800);
	}
	check(
		"AC6 founder-facing (approve_to_ship/brainstorm) → no lead-pending nudge",
		nudgeMessages().length === 0,
		`nudges=${nudgeMessages().length}`,
	);
	check(
		"AC6 founder-facing → no lead-pending page",
		s.pages.length === 0,
		`pages=${s.pages.length}`,
	);

	// 4c frozen runner: session running, NO pending question
	setEnvDirs();
	setPolicy({ grace: 2000, factor: 2, cap: 600000, rounds: 2 });
	s = await setup();
	await sleep(2500);
	for (let i = 0; i < 3; i++) {
		await tick(s.poller);
		await sleep(800);
	}
	check(
		"AC6 frozen runner (no pending question) → no nudge",
		nudgeMessages().length === 0,
		`nudges=${nudgeMessages().length}`,
	);
	check(
		"AC6 frozen runner → no page (FLY-195 owns frozen, not this path)",
		s.pages.length === 0,
		`pages=${s.pages.length}`,
	);
}

// ─────────────────────── Scenario 5: backoff cap + never-page ───────────────────────
async function scn5_cap_and_never_page() {
	console.log(
		"\n=== Scenario 5: backoff cap clamp + PAGE_ANNIE_ROUNDS=0 never pages (AC2 cap) ===",
	);
	setEnvDirs();
	setPolicy({ grace: 3000, factor: 2, cap: 8000, rounds: 0 }); // 3s→6s→cap8s→cap8s; never page
	const { poller, store, pages } = await setup();
	const qid = seedQuestion();
	console.log("  grace=3s factor=2 cap=8s rounds=0 (never page)");

	await sleep(3300);
	await tick(poller);
	check(
		"cap: nudge #1 fired",
		nudgeMessages().length === 1,
		`n=${nudgeMessages().length}`,
	);
	let tprev = now();

	await sleep(6300);
	await tick(poller);
	const d2 = (now() - tprev) / 1000;
	check(
		"AC2 nudge #2 interval ≈ 2×grace (6s, < cap)",
		nudgeMessages().length === 2 && d2 >= 5 && d2 <= 8,
		`interval≈${d2.toFixed(1)}s`,
	);
	tprev = now();

	await sleep(8300);
	await tick(poller);
	const d3 = (now() - tprev) / 1000;
	check(
		"AC2 nudge #3 interval CLAMPED to cap (8s, not 4×grace=12s)",
		nudgeMessages().length === 3 && d3 >= 7 && d3 <= 10,
		`interval≈${d3.toFixed(1)}s (cap=8s)`,
	);
	tprev = now();

	await sleep(8300);
	await tick(poller);
	const d4 = (now() - tprev) / 1000;
	check(
		"AC2 nudge #4 interval holds at cap (8s)",
		nudgeMessages().length === 4 && d4 >= 7 && d4 <= 10,
		`interval≈${d4.toFixed(1)}s`,
	);

	check(
		"PAGE_ANNIE_ROUNDS=0 → NEVER pages Annie (config flip)",
		pages.length === 0,
		`pages=${pages.length} after 4 nudges`,
	);
	const row = store.getLeadPendingEscalation(EXEC, qid);
	check(
		"backoff row keeps nudging (paged_annie stays false)",
		row && row.nudge_count >= 4 && row.paged_annie === false,
		`row=${JSON.stringify(row)}`,
	);
}

// ─────────────────────── run ───────────────────────
console.log(`FLY-695 lead-pending escalation real-Discord E2E`);
console.log(`FLY-637 dist: ${TL}`);
console.log(`alert channel: ${ALERT_CHANNEL_ID}   sandbox: ${SANDBOX}`);
if (!process.env[BOT_TOKEN_ENV]) {
	console.error(`FATAL: ${BOT_TOKEN_ENV} not set`);
	process.exit(2);
}

const ALL = {
	scn1: scn1_nudge_backoff_and_page,
	scn2: scn2_answered_stops,
	scn3: scn3_kill_switch,
	scn4: scn4_exclusions,
	scn5: scn5_cap_and_never_page,
};
try {
	for (const [name, fn] of Object.entries(ALL)) {
		if (ONLY && ONLY !== name) continue;
		await fn();
	}
} catch (e) {
	console.error("Harness threw:", e);
	FAIL++;
}

console.log(`\n──────── SUMMARY  PASS=${PASS} FAIL=${FAIL} ────────`);
if (PAGE_EVIDENCE.length)
	console.log(`PAGE EVIDENCE: ${JSON.stringify(PAGE_EVIDENCE)}`);
try {
	rmSync(SANDBOX, { recursive: true, force: true });
} catch {}
process.exit(FAIL === 0 ? 0 : 1);
