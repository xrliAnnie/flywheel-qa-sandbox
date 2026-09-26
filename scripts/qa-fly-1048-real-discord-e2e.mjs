// QA·FLY-1048 — real-machine Discord E2E for the watchdog DETECTION layer (PR-A).
//
// Runs the ACTUAL built #522 dist (packages/teamlead/dist) with the 6 new flags
// ON, drives the real detection code paths, and — for the ONE thing PR-A
// notifies to Discord (pane_error_stalled) — posts a REAL message to the
// ISOLATED 529-Room test channel via the real LeadAlertNotifier. Everything is
// isolated (temp alert/queue/claims dirs, :memory: StateStore, test bot token,
// test channel) — production Bridge / channels / claims.db are never touched.
//
// Scenarios:
//  ① Lead pane frozen on "Not logged in" (idle-looking) → multiFrame veto →
//     pane_error_stalled → REAL Discord message in the test channel.
//  ①b committed error-stalled-lead.txt ("Server error mid-response") → same path
//     → REAL Discord message (exercises the exact committed fixture).
//  ② Runner pane cycling the SAME error with CHANGING text (rolling ENOENT) →
//     evaluateStuckCandidate (FLYWHEEL_STUCK_ERRORSIG gate) → CANDIDATE with the
//     error-signature kind. (Runner-side A3 produces the candidate; the
//     notification is the existing FLY-195 path, not new in PR-A — so this
//     scenario is a detection-fires proof on the real dist fn.)
//  ③ Cheap gap scan: evaluateGapSuspicion over a real temp CommDB-shaped input →
//     produces gap suspicion records (PR-A: observe-only, no Discord by design).
//
// Evidence: the returned Discord message ids + a Discord API re-fetch of the
// test channel confirming the messages really landed.
//
// Usage: node scripts/qa-fly-1048-real-discord-e2e.mjs
// Requires: built teamlead dist; TEST_BOT_TOKEN_1 in env; test channel from
//           ~/.flywheel/test-slots.json (alertChannel.channelId).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tl = (p) => import(join(repoRoot, "packages/teamlead/dist", p));

const CHANNEL = "1519421055805165842"; // test-flywheel-alerts (isolated)
const TOKEN_ENV = "TEST_BOT_TOKEN_1";
const TOKEN = process.env[TOKEN_ENV];
if (!TOKEN) {
	console.error(`FATAL: ${TOKEN_ENV} not set`);
	process.exit(2);
}

// ── isolate every filesystem side-channel to a temp dir (prod untouched) ──
const tmp = mkdtempSync(join(tmpdir(), "qa-fly1048-"));
process.env.FLYWHEEL_ALERT_QUEUE_DIR = join(tmp, "queue");
process.env.FLYWHEEL_ALERT_DEADLETTER_DIR = join(tmp, "dl");
process.env.FLYWHEEL_CLAIMS_DB = join(tmp, "claims.db");
// the 6 PR-A flags ON (the ones the dist FUNCTIONS read from env):
process.env.FLYWHEEL_STUCK_ERRORSIG = "1";
process.env.FLYWHEEL_DETECTION_GAP_SCAN = "1";
process.env.FLYWHEEL_GAP_SCAN_EVERY_N_TICKS = "1";
process.env.FLYWHEEL_FRAME_INTERVAL_MS = "1000";
process.env.FLYWHEEL_FRAME_CAPTURES_PER_TICK = "2";
// FLYWHEEL_PANE_MULTIFRAME is a config option on LeadWatchdog (set below).

const { StateStore } = await tl("StateStore.js");
const { LeadWatchdog } = await tl("LeadWatchdog.js");
const { LeadAlertNotifier } = await tl("LeadAlertNotifier.js");
const { createClaimsReader, createClaimsClaimer, resolveAlertDirsFromEnv } =
	await tl("bridge/lead-alert-helpers.js");
const { evaluateStuckCandidate } = await tl("bridge/stuck-candidate.js");
const { scanErrorSignatures } = await tl("bridge/error-signatures.js");
const { computeFrameDeltas } = await tl("bridge/pane-frames.js");
const { evaluateGapSuspicion, defaultGapThresholds } = await tl(
	"bridge/detection-gap-scan.js",
);

const results = { pass: [], fail: [], discord: [] };
const ok = (name, cond, detail = "") =>
	(cond ? results.pass : results.fail).push(
		`${name}${detail ? ` — ${detail}` : ""}`,
	);

// ── a lead-shaped pane: <error line> frozen above an idle input box ──
function leadPane(errorLine) {
	return [
		"⏺ Calling plugin:discord:discord… (ctrl+o to expand)",
		"",
		`  ⎿  ${errorLine}`,
		"",
		"───────────────────────────────────────────────────────────────────── @cos-lead ──",
		"❯",
		"──────────────────────────────────────────────────────────────────────────────────",
		"  Opus 4.8/xhigh | ⚡cos-lead | ~/.flywheel/lead-workspace/cos-lead | ctx 34%",
		"  5h  12% reset today 21:30  |  7d  41% reset Mon 09:00",
		"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
	].join("\n");
}

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/qa-fly1048",
		generalChannel: CHANNEL,
		leads: [
			{
				agentId: "flywheel-test-1",
				chatChannel: CHANNEL,
				match: { labels: ["cos"] },
				alertChannel: CHANNEL,
				alertBotTokenEnv: TOKEN_ENV,
				alertFallbackToCore: false,
			},
		],
	},
];

function makeNotifier(store) {
	const notifier = new LeadAlertNotifier({
		store,
		projects,
		claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
		claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
		unifiedAlert: { channelId: CHANNEL, repairBotTokenEnv: TOKEN_ENV },
		...resolveAlertDirsFromEnv(process.env),
	});
	return notifier;
}

async function runLeadScenario(label, errorLine, marker) {
	const store = await StateStore.create(":memory:");
	const notifier = makeNotifier(store);
	const sent = [];
	let paneNow = "";
	let now = 1_700_000_000_000;
	const wd = new LeadWatchdog({
		pollIntervalMs: 30_000,
		paneHashStuckCycles: 2,
		paneHashAlertCycles: 3,
		cooldownMs: 300_000,
		projects,
		store,
		notifier: async (payload) => {
			sent.push(payload);
			// real Discord post via the production notifier + isolated channel:
			const r = await notifier.alert({
				...payload,
				title: `${payload.title} ${marker}`,
			});
			return r ?? { sent: true };
		},
		locateWindowFn: async () => ({
			windowId: "@7",
			windowName: "flywheel-cos-lead",
		}),
		captureFn: async () => paneNow,
		claimsReader: async () => new Set(),
		blockedMarkerReader: async () => [],
		now: () => now,
		suppressIdleHealthy: true,
		multiFrame: true, // FLYWHEEL_PANE_MULTIFRAME=1 equivalent
	});
	const pane = leadPane(errorLine);
	for (let i = 0; i < 3; i++) {
		paneNow = pane;
		await wd.pollOnce();
		now += 30_000;
	}
	const kinds = sent.map((s) => s.eventType);
	ok(
		`${label}: exactly one alert fired`,
		sent.length === 1,
		`count=${sent.length}`,
	);
	ok(
		`${label}: kind=pane_error_stalled`,
		kinds[0] === "pane_error_stalled",
		`kinds=[${kinds}]`,
	);
	ok(
		`${label}: alert body does NOT echo the raw error line (echo immunity)`,
		sent[0] && !sent[0].body.includes(errorLine.replace(/\.$/, "")),
	);
	return sent[0]?.eventId ?? null;
}

console.log(
	"=== FLY-1048 detection E2E — running #522 dist, isolated 529 channel ===",
);
console.log(`temp dir: ${tmp}`);

// ── ① "Not logged in" (Tadashi's example) → real Discord pane_error_stalled ──
await runLeadScenario(
	"① Not-logged-in frozen lead pane",
	"Not logged in",
	"[QA1048-①]",
);

// ── ①b committed "Server error mid-response" fixture → real Discord ──
await runLeadScenario(
	"①b Server-error frozen lead pane",
	"API Error: Server error mid-response. Please try again.",
	"[QA1048-①b]",
);

// ── ② runner pane cycling the SAME error, CHANGING text → repeated-error-sig ──
{
	const frame1 = readFileSync(
		join(
			repoRoot,
			"packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-frame1.txt",
		),
		"utf-8",
	);
	const frame2 = readFileSync(
		join(
			repoRoot,
			"packages/teamlead/src/bridge/__tests__/fixtures/error-panes/fn1-enoent-loop-frame2.txt",
		),
		"utf-8",
	);
	// The two frames differ textually (rolling counters/paths) but carry the SAME
	// normalized error signature — the exact "changes every poll so the old
	// fingerprint clock never fires" MISS that A3 fixes.
	const sig1 = scanErrorSignatures(frame1);
	const sig2 = scanErrorSignatures(frame2);
	ok(
		"② both frames carry an ENOENT signature",
		sig1.length > 0 && sig2.length > 0,
	);
	ok(
		"② full-text differs but normalized signature repeats (rolling-loop MISS)",
		frame1 !== frame2 && sig1[0]?.signature === sig2[0]?.signature,
	);
	const deltas = computeFrameDeltas(
		[
			{ text: frame1, capturedAtMs: 0 },
			{ text: frame2, capturedAtMs: 300_000 },
		],
		{ minSpanMs: 120_000 },
	);
	ok(
		"② computeFrameDeltas flags the repeated error signature across changing frames",
		deltas.repeatedErrorSig !== null,
		`sig=${deltas.repeatedErrorSig?.kind}`,
	);

	// The runner-side A3 path: gate reads FLYWHEEL_STUCK_ERRORSIG (=1 above).
	// The hard safety gates (status must be running, no pending gate/review) run
	// FIRST and are deliberately untouched by A3 — a real running runner.
	const now = 1_700_000_000_000;
	const base = {
		status: "running",
		hasPendingGate: false,
		hasPendingReviewSignal: false,
	};
	const first = evaluateStuckCandidate({
		...base,
		output: frame1,
		prior: undefined,
		now,
	});
	// second poll, 11min later, text changed but signature same → CANDIDATE.
	const second = evaluateStuckCandidate({
		...base,
		output: frame2,
		prior: first.episode,
		now: now + 11 * 60_000,
	});
	ok(
		"② FLYWHEEL_STUCK_ERRORSIG gate: rolling-error pane becomes a stuck CANDIDATE",
		second.candidate === true,
		`exclusion=${second.exclusion ?? "-"}`,
	);
	ok(
		"② candidate carries the error-signature kind (truthful evidence, not raw line)",
		!!second.evidence?.errorSignature,
		`errorSignature=${second.evidence?.errorSignature}`,
	);
	// byte-compat proof: same input with the gate OFF → NOT a candidate (rolling
	// text resets the legacy fingerprint clock, the documented MISS).
	const offFirst = evaluateStuckCandidate({
		...base,
		output: frame1,
		prior: undefined,
		now,
		errorSigEnabled: false,
	});
	const offSecond = evaluateStuckCandidate({
		...base,
		output: frame2,
		prior: offFirst.episode,
		now: now + 11 * 60_000,
		errorSigEnabled: false,
	});
	ok(
		"② byte-compat: gate OFF → rolling-error pane is NOT a candidate (legacy MISS preserved)",
		offSecond.candidate === false,
	);
}

// ── ③ cheap gap scan detection logic runs (observe-only in PR-A) ──
{
	const now = 1_700_000_000_000;
	const thresholds = defaultGapThresholds(process.env);
	// a parked runner with NO reporting artifact anywhere → gap1 fires.
	const recs = evaluateGapSuspicion({
		session: {
			executionId: "exec-qa-1048",
			projectName: "flywheel",
			status: "awaiting_review",
			lastActivityAtMs: now - 60 * 60_000,
		},
		comm: {
			declaredParked: true,
			pendingQuestionCount: 0,
			outbound: { readable: true, latestAgeMs: null },
			oldestUnansweredAskAgeMs: 40 * 60_000,
			oldestUnconsumedDeliveryAgeMs: null,
		},
		founderNotified: false,
		nowMs: now,
		thresholds,
	});
	const kinds = recs.map((r) => r.kind);
	ok(
		"③ gap scan: parked-unreported detected (漏①)",
		kinds.includes("gap1_parked_unreported"),
		`kinds=[${kinds}]`,
	);
	ok(
		"③ gap scan: unanswered non-blocking ask detected (漏②)",
		kinds.includes("gap2_ask_unanswered"),
	);
	// silence case: a parked runner WITH founder-notified evidence → NO gap1 (R1).
	const quiet = evaluateGapSuspicion({
		session: {
			executionId: "exec-qa-1048b",
			projectName: "flywheel",
			status: "awaiting_review",
			lastActivityAtMs: now,
		},
		comm: {
			declaredParked: true,
			pendingQuestionCount: 0,
			outbound: { readable: true, latestAgeMs: 60_000 },
			oldestUnansweredAskAgeMs: null,
			oldestUnconsumedDeliveryAgeMs: null,
		},
		founderNotified: true,
		nowMs: now,
		thresholds,
	});
	ok(
		"③ gap scan R1: parked-but-already-reported stays SILENT (no false spam)",
		!quiet.some((r) => r.kind === "gap1_parked_unreported"),
	);
}

// ── Discord API re-fetch: confirm the real messages landed in the test channel ──
try {
	const raw = execFileSync(
		"curl",
		[
			"-s",
			"-H",
			`Authorization: Bot ${TOKEN}`,
			"-H",
			"User-Agent: FlywheelQA (https://flywheel, 1.0)",
			`https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=15`,
		],
		{ encoding: "utf-8" },
	);
	const msgs = JSON.parse(raw);
	const mine = msgs.filter((m) => /QA1048-①/.test(JSON.stringify(m)));
	for (const m of mine.slice(0, 5)) {
		results.discord.push({
			id: m.id,
			link: `https://discord.com/channels/@me/${CHANNEL}/${m.id}`,
			content: (m.content || m.embeds?.[0]?.title || "").slice(0, 120),
			ts: m.timestamp,
		});
	}
	ok(
		`Discord: ≥2 real pane_error_stalled messages landed in the isolated test channel`,
		mine.length >= 2,
		`found=${mine.length}`,
	);
} catch (e) {
	results.fail.push(`Discord re-fetch failed: ${e.message}`);
}

console.log("\n===== RESULT =====");
console.log(`PASS (${results.pass.length}):`);
for (const p of results.pass) console.log(`  ✓ ${p}`);
if (results.fail.length) {
	console.log(`\nFAIL (${results.fail.length}):`);
	for (const f of results.fail) console.log(`  ✗ ${f}`);
}
console.log("\nDISCORD MESSAGES (real, isolated channel):");
for (const d of results.discord)
	console.log(`  • ${d.id}  ${d.link}\n      "${d.content}"  @${d.ts}`);
console.log(
	`\nchannel: https://discord.com/channels/1512577412069658634/${CHANNEL}`,
);
console.log(
	results.fail.length === 0 ? "\nE2E VERDICT: PASS" : "\nE2E VERDICT: FAIL",
);
process.exit(results.fail.length === 0 ? 0 : 1);
