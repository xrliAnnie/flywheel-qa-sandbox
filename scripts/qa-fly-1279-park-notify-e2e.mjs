// QA·FLY-1279 — real-machine E2E for the park→notify→founder-escalation ladder.
//
// WHY this exists: the unit suite (park-watch.test.ts) stubs `notify`, so it
// proves the DETECTION + episode bookkeeping only. Nothing in the suite proves
// a park episode actually REACHES a Lead and then a founder — which is the
// entire point of FLY-1279 (the 7-14 night: 1254/1238 parked 3-4h and nobody
// was told). Annie's standing rule for detection/relay/notification work is a
// real-machine segment, so this drives the REAL composition:
//
//   real StateStore (temp file)  →  real runParkWatch
//     →  real notifyLeadFirst      (Lead leg; durable lead_events row = truth)
//     →  real reconcileDetectionEscalations
//     →  real createFounderPager   (founder leg; REAL Discord POST)
//     →  message READ BACK from Discord (delivered ≠ recorded — read it back)
//
// Isolation: every write goes to a temp StateStore/CommDB and the founder page
// is pinned to the isolated 529-Room channel (test-flywheel-alerts). Production
// state, the production Bridge, and the production alert lane are untouched.
//
// CLOCK NOTE (a real harness trap, cost one debugging round): StateStore stamps
// `awaiting_review_entered_at`/`started_at` with SQL `datetime('now')` — a
// seeded past timestamp is OVERWRITTEN by the real clock. So the fake clock must
// LEAD real time (park-watch.test.ts does the same for the same reason);
// a fake NOW in the past yields a negative episode age and NOTHING fires, which
// looks exactly like a product bug but is a harness artifact.
//
// NO OPTIONAL CALLS: every store/db method is called directly (never `obj.m?.()`)
// so a renamed method THROWS instead of silently turning a scenario into a
// vacuous pass. S3-MUT exists for the same reason — it breaks the guard on
// purpose to prove S3 isn't passing for free.
//
// Seams deliberately NOT stubbed: park-watch, notifyLeadFirst, reconcile, the
// founder pager, and the Discord POST are all the real production functions.
// Stubbed: `addMember` (adds the founder to a thread — not FLY-1279's contract,
// and the isolated target is a channel, not a thread) and the Lead runtime
// transport (no live Lead daemon in a QA run — the durable lead_events row the
// real notifyLeadFirst writes IS the delivery ledger, and is asserted instead).
//
// Coverage boundary (honest): park:gate_row_missing / park:gate_unreachable
// (the FLY-1262/1264 shapes) need a CommDB gate fixture and are left to the unit
// suite — this script pins review_question_id="unbound" so the approval-gate
// park signal is isolated. The Lead TRANSPORT (mailbox/Codex instruction) is
// FLY-142/168 infrastructure with its own real-machine E2E, not re-verified here.
//
// Usage: TEST_BOT_TOKEN_1=... node --import tsx scripts/qa-fly-1279-park-notify-e2e.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => import(join(repoRoot, "packages/teamlead/src", p));

// scripts/ sits at the workspace root, which does not resolve the
// `flywheel-comm` package specifier — import the real source directly.
const { CommDB } = await import(
	join(repoRoot, "packages/flywheel-comm/src/db.ts")
);
const { StateStore } = await src("StateStore.ts");
const {
	runParkWatch,
	LEAD_ONLY_PARK_KINDS,
	PARK_KIND_PREFIX,
	parkFounderGraceMs,
} = await src("bridge/park-watch.ts");
const { notifyLeadFirst, reconcileDetectionEscalations } = await src(
	"bridge/detection-escalation.ts",
);
const { createFounderPager } = await src(
	"bridge/detection-escalation-sinks.ts",
);
const { AutoQaCoordinator } = await src("bridge/auto-qa-coordinator.ts");

const CHANNEL = "1519421055805165842"; // test-flywheel-alerts (isolated 529 Room)
const TOKEN = process.env.TEST_BOT_TOKEN_1;
if (!TOKEN) {
	console.error("FATAL: TEST_BOT_TOKEN_1 not set");
	process.exit(2);
}
// No fallback id (Codex R1 MEDIUM-2): a hardcoded guess that disagrees with the
// real founder id turns the mention assertion into a self-fulfilling check.
const FOUNDER_ID = process.env.DISCORD_OWNER_USER_ID;
if (!FOUNDER_ID) {
	console.error("FATAL: DISCORD_OWNER_USER_ID not set");
	process.exit(2);
}
const RUN_TAG = `qa1279${process.pid}${Math.random().toString(36).slice(2, 6)}`;

const results = [];
const check = (name, pass, detail = "") => {
	results.push({ name, pass, detail });
	console.log(
		`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
	);
};

// ── harness ────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "fly1279-e2e-"));
const dbPath = join(dir, "comm.db");
new CommDB(dbPath).close();
const store = await StateStore.create(join(dir, "state.db"));

// See CLOCK NOTE: must lead real time so store-stamped anchors are in the past.
let NOW = Date.now() + 3 * 60 * 60_000;
const now = () => NOW;

// `realThread: true` pins this issue's thread at the isolated 529 channel so the
// REAL pager posts there. chat_threads is keyed by thread_id (PK), so only ONE
// issue may claim the channel — the others get a distinct id and are asserted at
// the pager-invocation level (pageAttempts) instead of at the Discord level.
function seedSession(execId, status, extra = {}, realThread = false) {
	const issueId = `issue-${execId}`;
	store.upsertSession({
		execution_id: execId,
		issue_id: issueId,
		issue_identifier: `FLY-${execId}`,
		project_name: "flywheel",
		status,
		last_activity_at: new Date(Date.now() - 30 * 60_000).toISOString(),
		...extra,
	});
	if (realThread) {
		store.upsertChatThread(CHANNEL, CHANNEL, issueId, "flywheel-eng-lead");
	}
	return issueId;
}

const REVIEW_READY_SHA = "c".repeat(40);
function seedReviewReadySession(execId, prNumber, realThread = false) {
	const issueId = seedSession(
		execId,
		"awaiting_review",
		{
			pr_number: prNumber,
			session_role: "implement",
			adapter_type: "codex",
		},
		realThread,
	);
	store.setReviewBinding(execId, {
		questionId: null,
		prHeadSha: REVIEW_READY_SHA,
	});
	store.recordCodexReviewApproved({
		executionId: execId,
		targetPrHeadSha: REVIEW_READY_SHA,
		issueId,
		projectName: "flywheel",
		authorFamily: "codex",
		reviewerFamily: "claude",
		requestId: `qa-review-${execId}`,
	});
	return issueId;
}
/** The real notifyLeadFirst payload field carrying the park kind. */
const kindOf = (d) => d.event.escalation_kind;

// Lead leg: real notifyLeadFirst, recording transport. The durable lead_events
// row it writes (append+claim) is the delivery ledger and the real assertion.
const leadDeliveries = [];
const runtimeRegistry = {
	getForLead: () => ({
		deliver: async (env) => {
			leadDeliveries.push(env);
			return { delivered: true };
		},
	}),
};

const undeliverable = [];
const pageFounder = createFounderPager({
	store,
	resolveTarget: (row) => {
		const s = store.getSession(row.target_key);
		if (!s) return null;
		return {
			executionId: s.execution_id,
			issueId: s.issue_id,
			issueIdentifier: s.issue_identifier,
			projectName: s.project_name,
			chatChannel: CHANNEL,
			botToken: TOKEN,
		};
	},
	discordOwnerUserId: FOUNDER_ID,
	discordBotToken: TOKEN,
	onUndeliverable: async (row, reason) => {
		undeliverable.push({ kind: row.kind, reason });
		console.log(`  [undeliverable] ${row.kind}: ${reason}`);
	},
	addMember: async () => true,
	now,
});

const paged = [];
// pageAttempts counts every time the POLICY let a row through to the pager —
// that is the layer the lead_only guard governs, independent of whether Discord
// accepted the post (S3/S3-MUT assert here; S2 asserts the real Discord post).
const pageAttempts = [];
const pageFounderRecorded = async (row) => {
	pageAttempts.push({ kind: row.kind, target: row.target_key });
	const ok = await pageFounder(row);
	if (ok) paged.push({ kind: row.kind, target: row.target_key });
	return ok;
};

const fleetTickets = [];
const scan = () =>
	runParkWatch({
		store,
		commDbPathForProject: () => dbPath,
		notify: (input) =>
			notifyLeadFirst(
				{
					store,
					runtimeRegistry,
					resolveOwner: () => ({
						leadId: "flywheel-eng-lead",
						projectName: "flywheel",
					}),
					now,
				},
				input,
			),
		now,
		n1Ms: 10 * 60_000,
		qaHealthyMs: 2 * 60 * 60_000,
		qaRegistrationGraceMs: 10 * 60_000,
	});

// Mirrors the production plugin.ts wiring verbatim (park kinds: lead_only for
// LEAD_ONLY_PARK_KINDS, page_no_fleet otherwise, park N2 grace).
const reconcile = (policyOverride) =>
	reconcileDetectionEscalations({
		store,
		pageFounder: pageFounderRecorded,
		pagePolicy:
			policyOverride ??
			((row) =>
				LEAD_ONLY_PARK_KINDS.has(row.kind)
					? "lead_only"
					: row.kind.startsWith(PARK_KIND_PREFIX)
						? "page_no_fleet"
						: "page"),
		fleetSink: async (kind, rows) => {
			fleetTickets.push({
				kind,
				n: rows.length,
				targets: rows.map((r) => r.target_key),
			});
		},
		graceMsFor: (row) =>
			row.kind.startsWith(PARK_KIND_PREFIX) ? parkFounderGraceMs() : undefined,
		fleetThreshold: 2,
		// The fleet window defaults to 1h, but episode anchors are stamped with the
		// REAL clock while our fake NOW runs ~3h ahead (see CLOCK NOTE) and then
		// advances further per grace step — so every episode would fall outside the
		// window and the aggregate could never fire, silently making S6 vacuous.
		// Widening the window past the harness's clock skew is what lets S6-MUT
		// actually reach the aggregate and prove S6 means something.
		fleetWindowMs: 24 * 60 * 60_000,
		now,
	});

const discordGet = async () => {
	const res = await fetch(
		`https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=50`,
		{
			headers: {
				Authorization: `Bot ${TOKEN}`,
				"User-Agent": "flywheel-qa/1279",
			},
		},
	);
	if (!res.ok)
		throw new Error(`Discord GET ${res.status}: ${await res.text()}`);
	return res.json();
};

// ── S0: the isolated channel is reachable (else every later PASS is vacuous) ──
const baseline = await discordGet();
check(
	"S0 isolated 529 channel reachable",
	Array.isArray(baseline),
	`baseline=${baseline.length} msgs`,
);

// ── S1: parked at the founder approval gate → Lead told, founder NOT yet ─────
// The 1254/1238 shape: ready_to_merge, sitting on the approval gate, nobody told.
const e1 = `${RUN_TAG}approval`;
seedReviewReadySession(
	e1,
	595,
	true, // this is the episode whose founder page must really reach Discord
);
await scan();
const s1Event = leadDeliveries.find(
	(d) => kindOf(d) === "park:awaiting_review",
);
check(
	"S1 park at founder approval gate → Lead notified (durable lead_event)",
	!!s1Event && s1Event.event.event_type === "runner_park_notice",
	`lead_events=${JSON.stringify(leadDeliveries.map(kindOf))}`,
);
if (s1Event) {
	// FLY-1279 §要做1: the Lead notice must carry issueId + gate type + PR +
	// wait duration — enough to act on without opening a dashboard.
	const blob = JSON.stringify(s1Event.event);
	check(
		"S1 Lead notice carries the issue identity + gate kind",
		blob.includes(`FLY-${e1}`) && blob.includes("park:awaiting_review"),
		"issueId + gate type per the issue's ask",
	);
	check(
		"S1 Lead notice carries the PR number",
		blob.includes("595"),
		`payload=${blob.slice(0, 240)}`,
	);
	check(
		"S1 Lead notice carries the structured wait duration",
		Number.isFinite(s1Event.event.waited_ms) &&
			s1Event.event.waited_ms >= 10 * 60_000,
		`waited_ms=${s1Event.event.waited_ms}`,
	);
}
await reconcile();
check(
	"S1 founder NOT paged before the N2 grace (no premature page)",
	paged.length === 0,
	`paged=${paged.length}`,
);

// ── S2: Lead never presents → past N2 → founder paged for REAL ──────────────
NOW += parkFounderGraceMs() + 60_000;
await reconcile();
check(
	"S2 Lead didn't present within N2 → founder paged",
	paged.some((p) => p.kind === "park:awaiting_review"),
	`paged=${JSON.stringify(paged)}`,
);
const after = await discordGet();
const s2Msg = after.find((m) => (m.content ?? "").includes(e1));
check(
	"S2 founder page REALLY landed in Discord (read back from the API)",
	!!s2Msg,
	s2Msg ? `msg id=${s2Msg.id}` : "no message found in the isolated channel",
);
if (s2Msg) {
	console.log(
		`\n  ── founder-facing text actually posted ──\n${s2Msg.content}\n`,
	);
	// Assert Discord's OWN parsed mentions[], not our own id echoed back in the
	// text we configured (Codex R1 MEDIUM-2: that check proves only that the
	// harness can concatenate a string).
	check(
		"S2 founder page @-mentions the founder (Discord-parsed mentions[])",
		Array.isArray(s2Msg.mentions) &&
			s2Msg.mentions.some((m) => m.id === FOUNDER_ID),
		`mentions=${JSON.stringify((s2Msg.mentions ?? []).map((m) => m.id))}`,
	);
	check(
		"S2 founder page names the parked issue",
		s2Msg.content.includes(`FLY-${e1}`) || s2Msg.content.includes(e1),
		"the page must say WHICH runner is parked",
	);
	check(
		"S2 founder page explains the park in human language",
		s2Msg.content.includes("Runner 正在等待 founder 审批") &&
			!s2Msg.content.includes("park:awaiting_review"),
		"founder must see the actionable state, not an internal kind",
	);
}

// ── S3: healthy QA hold is lead_only — founder must NEVER be paged ──────────
// Suppression is the load-bearing half: FLY-1279 must not become alert spam.
const e3 = `${RUN_TAG}qahold`;
const issue3 = seedSession(e3, "running");
seedSession(`${e3}qa`, "running");
store.claimAutoQaRecord({
	parentExecutionId: e3,
	targetPrHeadSha: "cafe1279",
	issueId: issue3,
	projectName: "flywheel",
});
store.setAutoQaQaExecutionId(e3, "cafe1279", `${e3}qa`);
const attemptsBeforeS3 = pageAttempts.length;
await scan();
check(
	"S3 healthy QA hold → Lead IS told (the episode exists at all)",
	leadDeliveries.some((d) => kindOf(d) === "park:qa_hold_healthy"),
	`kinds=${JSON.stringify([...new Set(leadDeliveries.map(kindOf))])}`,
);
NOW += parkFounderGraceMs() + 60_000;
await reconcile();
const s3Attempts = pageAttempts.slice(attemptsBeforeS3);
check(
	"S3 healthy QA hold → founder NEVER paged (lead_only suppression holds)",
	!s3Attempts.some((a) => a.kind === "park:qa_hold_healthy"),
	`qa_hold_healthy page attempts=${s3Attempts.filter((a) => a.kind === "park:qa_hold_healthy").length}`,
);

// ── S3-MUT: mutation — prove the lead_only guard is load-bearing ────────────
// If the guard were absent (policy "page"), the SAME state must reach the pager.
// A guard that cannot be broken is not being tested.
const attemptsBeforeMut = pageAttempts.length;
await reconcile(() => "page");
const mutAttempts = pageAttempts
	.slice(attemptsBeforeMut)
	.filter((a) => a.kind === "park:qa_hold_healthy");
check(
	"S3-MUT breaking the lead_only guard DOES page → S3 is not vacuous",
	mutAttempts.length > 0,
	`qa_hold_healthy page attempts once un-guarded=${mutAttempts.length} (0 ⇒ S3 passed for free)`,
);

// ── S4: goal self-marked blocked → notified, not silent ─────────────────────
const e4 = `${RUN_TAG}blocked`;
const pagesBeforeS4 = paged.length;
seedSession(
	e4,
	"blocked",
	{ last_error: "goal blocked: waiting on FLY-1278" },
	true,
);
await scan();
check(
	"S4 goal self-marked blocked → Lead notified",
	leadDeliveries.some((d) => kindOf(d) === "park:blocked"),
	"1254/1251 marked blocked and nobody was told",
);
NOW += parkFounderGraceMs() + 60_000;
await reconcile();
check(
	"S4 Lead did not present → blocked goal escalates to founder",
	paged
		.slice(pagesBeforeS4)
		.some((page) => page.kind === "park:blocked" && page.target === e4),
	"blocked uses the same N2 founder fallback without pretending it is a review gate",
);
const afterBlocked = await discordGet();
const s4Msg = afterBlocked.find((message) =>
	(message.content ?? "").includes(e4),
);
check(
	"S4 blocked founder page REALLY lands with human wording",
	!!s4Msg &&
		s4Msg.content.includes("Runner 已因无法继续而暂停") &&
		!s4Msg.content.includes("park:blocked") &&
		Array.isArray(s4Msg.mentions) &&
		s4Msg.mentions.some((mention) => mention.id === FOUNDER_ID),
	s4Msg ? `msg id=${s4Msg.id}` : "no blocked message found",
);

// ── S5: idempotence — a live park must not re-notify every 3s tick ──────────
const before5 = leadDeliveries.length;
await scan();
await scan();
await scan();
check(
	"S5 repeat ticks do not re-notify a live episode (no spam)",
	leadDeliveries.length === before5 && before5 > 0,
	`delta=${leadDeliveries.length - before5}, base=${before5}`,
);

// ── S7: the independent QA session died → detected, implement not left waiting ─
// The 1238 shape: the implement session waits on a QA that is never coming
// (its runner died at spawn). The auto-QA record still says `running` while the
// QA session is gone — that must surface as qa_hold_orphaned.
const e7 = `${RUN_TAG}qadead`;
const issue7 = seedSession(e7, "running");
seedSession(`${e7}qa`, "failed"); // the QA runner died (1238: worktree_takeover_failed)
store.claimAutoQaRecord({
	parentExecutionId: e7,
	targetPrHeadSha: "dead1279",
	issueId: issue7,
	projectName: "flywheel",
});
store.setAutoQaQaExecutionId(e7, "dead1279", `${e7}qa`);
await scan();
check(
	"S7 independent QA session died → implement's hold surfaces as orphaned",
	leadDeliveries.some((d) => kindOf(d) === "park:qa_hold_orphaned"),
	`kinds=${JSON.stringify([...new Set(leadDeliveries.map(kindOf))])}`,
);

// ── S6: park episodes never collapse into a fleet aggregate ─────────────────
// page_no_fleet: N parked runners = N founder pages, not one summary ticket —
// each is a different PR needing a different decision.
//
// Codex R1 MEDIUM-1 killed the first version of this twice over:
//  (a) with only ONE pageable episode per kind, `fleetTickets.length === 0` was
//      true no matter what the policy did;
//  (b) reusing S1/S2's episode does not help either — reconcile only acts on
//      LEAD_NOTIFIED rows, and that one was already ESCALATED, so the mutation
//      pass had nothing to chew on and still "passed".
// Fix: each arm seeds its OWN fresh pair of parked runners (fleetThreshold=2).
//
// Caveat, measured not assumed (Codex R2 LOW-1): rows are NOT consumed by a
// reconcile that fails to post — the individual pages here return
// `no_chat_thread` (only S1's issue owns the isolated channel), so the rows stay
// LEAD_NOTIFIED and remain eligible on the next pass. The S6-MUT assertion
// therefore checks the fleet payload's TARGETS, not just the ticket count, so it
// cannot be satisfied purely by leftovers from the S6 arm.
async function freshParkedPair(tag) {
	for (const n of [1, 2]) {
		const ex = `${RUN_TAG}${tag}${n}`;
		seedReviewReadySession(ex, 700 + n);
	}
	await scan(); // → LEAD_NOTIFIED
	NOW += parkFounderGraceMs() + 60_000; // → overdue for the founder leg
}

await freshParkedPair("fleetreal");
const fleetBefore = fleetTickets.length;
const attemptsBeforeS6 = pageAttempts.length;
await reconcile();
const s6Paged = pageAttempts
	.slice(attemptsBeforeS6)
	.filter((a) => a.kind === "park:awaiting_review").length;
// Precise claim (Codex R2 LOW-2): this arm proves each episode reached the
// INDIVIDUAL pager and none were folded into an aggregate. It does NOT prove
// they landed in Discord — these two have no chat-thread binding, so the posts
// return no_chat_thread. S2 is the "really landed in Discord" evidence.
check(
	"S6 two same-kind parks → each reaches the individual pager, no fleet aggregate",
	fleetTickets.length === fleetBefore && s6Paged >= 2,
	`fleet delta=${fleetTickets.length - fleetBefore}, individual page attempts=${s6Paged}`,
);

// ── S6-MUT: mutation — prove the aggregate is genuinely reachable ───────────
// A SECOND fresh pair, reconciled with the plain "page" policy, must collapse
// into one fleet ticket. If it does, S6's "no aggregate" is a real property of
// page_no_fleet rather than an artifact of never reaching the threshold.
await freshParkedPair("fleetmut");
const fleetBeforeMut = fleetTickets.length;
await reconcile(() => "page");
const mutTickets = fleetTickets.slice(fleetBeforeMut);
// Assert the aggregate carries THIS pair's targets — a ticket built purely from
// the S6 arm's leftover rows would not name them (Codex R2 LOW-1).
const namesMutPair = mutTickets.some((t) =>
	t.targets.some((k) => k.includes("fleetmut")),
);
check(
	"S6-MUT dropping page_no_fleet DOES aggregate this pair → S6 is not vacuous",
	mutTickets.length > 0 && namesMutPair,
	`fleet delta once un-guarded=${mutTickets.length}, targets=${JSON.stringify(mutTickets.flatMap((t) => t.targets).map((k) => k.replace(RUN_TAG, "")))} (0 ⇒ S6 passed for free)`,
);

// ── S8: the HELD-REVIEW silent hole — the exact 1279 regression to guard ─────
// FLY-1279 RE-TEST HIGH: commit 77bac3383 suppresses park:awaiting_review whenever
// reviewHoldReason() is non-null. But `codex_pending` includes the case where the
// codex_review_record row does NOT EXIST (defect ④ — a QA-role session's approval
// verdict silently dropped). In that case park-watch stays silent AND the FLY-863
// stuck-hold watcher can't see it either (its query needs a pending ROW). Net:
// a runner parked at the founder gate with no codex record → nobody is told,
// forever — the exact 1254/1238 shape 1279 exists to kill.
//
// Every OTHER scenario in this file uses seedReviewReadySession (pre-seeds an
// APPROVED codex record), so it walks the hold=null happy path and can NEVER
// exercise the suppression branch. S8 deliberately uses a BARE seedSession (no
// codex record) so the harness finally SEES the suppression path.
//
// This asserts the OUTCOME (someone is notified), not the mechanism — robust to
// whichever fix shape lands (suppress-founder-only / keep-Lead / add a held-wait
// watcher). RED on the unfixed head, GREEN once the hole is closed.
const e8 = `${RUN_TAG}heldnorow`;
seedSession(e8, "awaiting_review", {
	pr_number: 999,
	session_role: "implement",
});
store.setReviewBinding(e8, { questionId: null, prHeadSha: "e".repeat(40) });
const before8 = leadDeliveries.length;
await scan();
NOW += parkFounderGraceMs() + 60_000;
await reconcile();
const s8LeadTold = leadDeliveries
	.slice(before8)
	.some((d) => d.event.execution_id === e8);
const s8FounderPaged = paged.some((p) => p.target === e8);
check(
	"S8 parked at founder gate with NO codex record → SOMEONE is told (not silent)",
	s8LeadTold || s8FounderPaged,
	s8LeadTold || s8FounderPaged
		? `notified (leadTold=${s8LeadTold} founderPaged=${s8FounderPaged})`
		: "SILENT — the 1279 regression (77bac3383 held-review suppression + no stuck-watcher coverage)",
);

// ── S9: clean-retry via the REAL AutoQaCoordinator (Lead spec R2) ────────────
// Plan V2 acceptance leg. S7 proves the death is DETECTED; S9 proves the
// coordinator ACTUALLY RE-LAUNCHES. Per the Lead's upgraded spec, this must not
// merely flip StateStore fields — it must drive the real
// `AutoQaCoordinator.sweepOrphanedQaRecords()` through the spawn boundary and
// prove a fresh QA launch was really initiated.
//
// The only fakes are the boundary endpoints (recording, not mocking the logic):
//   • startDispatcher.start   — records every launch (the spawn boundary)
//   • effects.*               — record side effects (alerts/threads/etc.)
// Everything between — death detection, retry claim, canLaunchRecovery, the
// bounded retry counter — is the real coordinator + real StateStore.
//
// S9-MUT: the retry is BOUNDED. After the coordinator's ONE clean relaunch, a
// second death must go `exhausted` with NO further spawn — recovery cannot loop
// forever.
{
	const dir9 = mkdtempSync(join(tmpdir(), "fly1279-s9-"));
	const store9 = await StateStore.create(join(dir9, "s9.db"));
	const P = `${RUN_TAG}s9parent`;
	const SHA9 = "9".repeat(40);

	// Recording spawn boundary — the assertion point for "a fresh QA is launched".
	const startCalls = [];
	const startDispatcher = {
		start: async (req) => {
			startCalls.push(req);
			return {
				executionId:
					req.successorExecutionId ?? `${P}-qa-spawn${startCalls.length}`,
				issueId: req.issueId,
			};
		},
		// canLaunchRecovery needs this probe present AND returning false (no inflight).
		hasInflightForRole: () => false,
	};
	const s9alerts = [];
	const effects = {
		postThread: () => {},
		createQaIssue: () => ({
			issueId: `qa-issue-${P}`,
			issueIdentifier: `QA-${P}`,
		}),
		notifyShipReady: () => {},
		feedbackWakeMain: () => {},
		alertLeadPipelineError: ({ reason }) => s9alerts.push(reason),
		stampIssueStage: () => {},
		retestWakeQa: () => ({ ok: true }),
		closeQaRunner: () => {},
		queueCodexInstruction: () => {},
		alertCodexGateBlocked: () => {},
	};
	const coord = new AutoQaCoordinator({
		store: store9,
		startDispatcher,
		resolveQaPolicy: () => ({ enabled: true }),
		effects,
		env: { FLYWHEEL_CODEX_HARD_GATE: "0" },
	});

	// Implement parent held at the founder gate; its independent QA is running…
	store9.upsertSession({
		execution_id: P,
		issue_id: `issue-${P}`,
		issue_identifier: `FLY-${P}`,
		project_name: "flywheel",
		status: "awaiting_review",
		session_role: "implement",
		pr_number: 1279,
		last_activity_at: new Date(Date.now() - 60 * 60_000).toISOString(),
	});
	store9.setReviewBinding(P, { questionId: null, prHeadSha: SHA9 });
	store9.claimAutoQaRecord({
		parentExecutionId: P,
		targetPrHeadSha: SHA9,
		issueId: `issue-${P}`,
		projectName: "flywheel",
	});
	// The separate QA·FLY issue must exist so recovery can re-use it (a reconcile
	// re-spawn never mints QA2's issue).
	store9.setAutoQaIssue(P, SHA9, {
		issueId: `qa-issue-${P}`,
		issueIdentifier: `QA-${P}`,
	});
	store9.setAutoQaQaExecutionId(P, SHA9, `${P}-qa1`);
	// …but the QA runner DIED without a verdict (1238 worktree_takeover_failed).
	store9.upsertSession({
		execution_id: `${P}-qa1`,
		issue_id: `qa-issue-${P}`,
		issue_identifier: `QA-${P}`,
		project_name: "flywheel",
		status: "failed",
		session_role: "qa",
		last_activity_at: new Date(Date.now() - 55 * 60_000).toISOString(),
	});

	// Drive the REAL coordinator sweep: detect the dead QA → queue retry →
	// canLaunchRecovery → spawnQa → startDispatcher.start.
	await coord.sweepOrphanedQaRecords();
	const afterSweep = store9.getAutoQaRecord(P, SHA9);
	check(
		"S9 real AutoQaCoordinator sweep → a fresh QA launch is ACTUALLY initiated (spawn boundary hit)",
		startCalls.length === 1 && afterSweep?.status !== "stuck",
		`startCalls=${startCalls.length}, record status=${afterSweep?.status}, alerts=${JSON.stringify(s9alerts)}`,
	);
	check(
		"S9 the relaunch targets the SAME parent/head (implement's QA, not a stray)",
		startCalls[0]?.issueId != null &&
			startCalls[0]?.successorExecutionId != null,
		`start req: issueId=${startCalls[0]?.issueId} successor=${startCalls[0]?.successorExecutionId}`,
	);

	// S9-MUT: the coordinator's retry is BOUNDED. The successor QA (spawned above,
	// but sessionless in this harness) is seen dead on the next sweep → exhausted,
	// with NO second spawn.
	await coord.sweepOrphanedQaRecords();
	const afterSecond = store9.getAutoQaRecord(P, SHA9);
	check(
		"S9-MUT second death → exhausted + NO further spawn (bounded, not an infinite loop)",
		afterSecond?.status === "stuck" && startCalls.length === 1,
		`status=${afterSecond?.status}, total spawns=${startCalls.length} (status≠stuck or spawns>1 ⇒ unbounded)`,
	);

	store9.close();
	rmSync(dir9, { recursive: true, force: true });
}

// ── report ─────────────────────────────────────────────────────────────────
store.close();
rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${"=".repeat(66)}`);
console.log(
	`QA·FLY-1279 real-machine E2E: ${results.length - failed.length}/${results.length} passed`,
);
if (failed.length) {
	console.log("FAILED:");
	for (const f of failed) console.log(`  - ${f.name} (${f.detail})`);
}
process.exit(failed.length ? 1 : 0);
