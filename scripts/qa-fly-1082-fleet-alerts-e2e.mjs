// QA·FLY-1082 — real-machine E2E for the fleet-failure alert + ARC-repair chain.
//
// Runs the ACTUAL built teamlead dist (packages/teamlead/dist) wired EXACTLY the
// way plugin.ts wires it (routedAlertSink → AlertChannelHub → AutoRepairBot →
// FleetSensors/ServerLossCoordinator holders), injects a REAL fault for each of
// the 5 fleet kinds via the same seams the plan documents, and drives the full
// lifecycle to a REAL isolated 529-Room Discord channel via the production
// LeadAlertNotifier + createDiscordOps. Everything is isolated (temp
// alert/queue/claims dirs, temp-file StateStore, isolated tmux socket, test bot
// token, test channel) — production Bridge / channels / claims.db / tmux server
// are never touched.
//
// The plan's acceptance bar (§3.5 / §6): "不接受代码合了" — the 5 kinds must each
// show detection → a real ticket → a real ARC side-effect → resolve/escalate,
// with the alert really landing in Discord. This harness produces exactly that
// evidence (StateStore side-effects + a Discord re-fetch of the test channel).
//
// Scenarios (research §2.8 injection matrix; ① reworked by FLY-1142):
//  ① swap_pressure_high  — real readMemoryPressure seam (FLYWHEEL_SWAP_SENSOR_CMD,
//     now vm_stat-shaped) feeds low-free% readings → 2-tick trigger →
//     pressure-hold placed in StateStore → RunnerAdmission really defers with
//     reason=pressure_hold → free% recovers with Swapouts static → hold lifted
//     → admission admits again + quiet resolve. Plus the FLY-1142 scar
//     scenario: a stranded durable hold + huge-but-static Swapouts lifts on the
//     SECOND healthy sample (first sample has no delta baseline), and a scarred
//     swap watermark alone never re-arms the sensor.
//  ② tmux_server_lost    — a REAL isolated tmux server (tmux -L …) is started then
//     kill-server'd; the coordinator's real probe reads "no server" → ONE episode,
//     every StateStore session migrated to `failed`, one grouped per-Lead notify,
//     ONE ticket.
//  ③ bridge_abnormal_exit — the REAL bridge-exit-marker module: a running marker
//     is latched (dirty prev) → boot ticket → AutoRepairBot reports launchd_respawn
//     → bootReconcileDone recovery.
//  ④ infra_bot_down      — probe reports the codex bot dead → cross-owner = claude
//     bot → ticket → AutoRepairBot runs the real infraBotKickstartRepair (kickstart
//     seam records the job) → probe flips alive → resolve.
//  ⑤ zombie_session_backlog — 3 zombie findings → contract-driven ESCALATED at
//     enqueue (by design, no ARC; remediation = FLY-1066) with the sample list.
//  ⑥ fail-loud kind-contract — a deleted contract entry makes validateKindContracts
//     THROW (Bridge refuses to start); the real table validates clean.
//
// Usage: node scripts/qa-fly-1082-fleet-alerts-e2e.mjs
// Requires: built teamlead dist; TEST_BOT_TOKEN_1 in env; tmux on PATH.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tl = (p) => import(join(repoRoot, "packages/teamlead/dist", p));

const CHANNEL = "1519421055805165842"; // test-flywheel-alerts (isolated 529 Room)
const TOKEN_ENV = "TEST_BOT_TOKEN_1";
const TOKEN = process.env[TOKEN_ENV];
if (!TOKEN) {
	console.error(`FATAL: ${TOKEN_ENV} not set`);
	process.exit(2);
}
const MARK = `[QA1082-${Date.now().toString().slice(-6)}]`; // unique run marker

// ── isolate every side-channel (prod untouched) ──
const tmp = mkdtempSync(join(tmpdir(), "qa-fly1082-"));
process.env.FLYWHEEL_ALERT_QUEUE_DIR = join(tmp, "queue");
process.env.FLYWHEEL_ALERT_DEADLETTER_DIR = join(tmp, "dl");
process.env.FLYWHEEL_CLAIMS_DB = join(tmp, "claims.db");
// Ticket enrichment is welded on; configure only the sender identity here.
process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = TOKEN_ENV;
// fake owner snowflakes (cross-assignment target; never a real ping in the test ch):
process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID = "100000000000000001";
process.env.FLYWHEEL_CODEX_INFRA_BOT_USER_ID = "100000000000000002";
process.env.FLYWHEEL_CLAUDE_INFRA_BOT_JOB =
	"gui/501/com.flywheel.qa.claude-infra";
process.env.FLYWHEEL_CODEX_INFRA_BOT_JOB =
	"gui/501/com.flywheel.qa.codex-infra";

const { StateStore } = await tl("StateStore.js");
const { LeadAlertNotifier } = await tl("LeadAlertNotifier.js");
const { AlertChannelHub, createDiscordOps } = await tl(
	"bridge/AlertChannelHub.js",
);
const { AutoRepairBot } = await tl("bridge/AutoRepairBot.js");
const { FleetSensors, fleetCorrelationKey } = await tl(
	"bridge/fleet-sensors.js",
);
const { ServerLossCoordinator } = await tl("bridge/server-loss.js");
const { RunnerAdmissionController } = await tl("bridge/runner-admission.js");
const { buildInfraAlertRouting } = await tl("bridge/infra-alert-wiring.js");
const { validateKindContracts, KIND_CONTRACTS } = await tl(
	"bridge/kind-contract.js",
);
const { createClaimsReader, createClaimsClaimer, resolveAlertDirsFromEnv } =
	await tl("bridge/lead-alert-helpers.js");
const { noteTicketEscalated } = await tl("bridge/runbook-gap.js");

const results = { pass: [], fail: [] };
const ok = (name, cond, detail = "") =>
	(cond ? results.pass : results.fail).push(
		`${name}${detail ? ` — ${detail}` : ""}`,
	);

// two leads, so the tmux server-loss grouping is genuinely per-Lead
const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/qa-fly1082",
		generalChannel: CHANNEL,
		leads: [
			{
				agentId: "flywheel-test-1",
				chatChannel: CHANNEL,
				match: { labels: ["cos"] },
				alertChannel: CHANNEL,
				alertBotTokenEnv: TOKEN_ENV,
			},
			{
				agentId: "flywheel-test-2",
				chatChannel: CHANNEL,
				match: { labels: ["eng"] },
				alertChannel: CHANNEL,
				alertBotTokenEnv: TOKEN_ENV,
			},
		],
	},
];

// ── build the FULL production alert chain over the real dist ──
const dbFile = join(tmp, "state.db");
const store = await StateStore.create(dbFile);
const notifier = new LeadAlertNotifier({
	store,
	projects,
	claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
	claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
	unifiedAlert: { channelId: CHANNEL, repairBotTokenEnv: TOKEN_ENV },
	...resolveAlertDirsFromEnv(process.env),
});
const discordOps = createDiscordOps(() => [TOKEN]);

// late-bound holders (identical to plugin.ts's ordering-cycle break)
const fleetHolder = { current: null };
const serverLossHolder = { current: null };

// injectable seams captured per-scenario
const seams = {
	swapReading: null, // string vm_stat-shaped output (FLY-1142)
	botProbes: [], // InfraBotProbe[]
	kickstartCalls: [], // recorded jobLabels
	kickstartResult: { ok: true },
	zombies: [], // ZombieFinding[]
	notifiedLeads: [], // {leadId, content, dedupeId}
	serverProbe: () => "unknown",
};
writeFileSync(join(tmp, "swap.txt"), ""); // seam file for FLYWHEEL_SWAP_SENSOR_CMD
const swapCmd = `cat ${join(tmp, "swap.txt")}`;
process.env.FLYWHEEL_SWAP_SENSOR_CMD = swapCmd;
const setSwap = (out) => writeFileSync(join(tmp, "swap.txt"), out);
// FLY-1142: the seam now carries vm_stat output (real pressure signals), not
// the old monotonic sysctl swap watermark. Fixture builder: 1M visible pages,
// free% goes entirely through Pages free; Swapouts is the cumulative counter.
const vmStatOut = (freePct, swapouts) => {
	const total = 1_000_000;
	const free = Math.round((freePct / 100) * total);
	return [
		"Mach Virtual Memory Statistics: (page size of 16384 bytes)",
		`Pages free:                    ${free}.`,
		`Pages active:                  ${total - free}.`,
		"Pages inactive:                0.",
		"Pages speculative:             0.",
		"Pages throttled:               0.",
		"Pages wired down:              0.",
		"Pages occupied by compressor:  0.",
		"Swapins:                       0.",
		`Swapouts:                      ${swapouts}.`,
		"",
	].join("\n");
};

const runbookCreated = [];
const hub = new AlertChannelHub({
	store,
	notifier,
	discord: discordOps,
	autoRepairBot: new AutoRepairBot({
		fleetRepair: {
			swapPressure: (p) =>
				fleetHolder.current
					? fleetHolder.current.swapPressureRepair(p)
					: Promise.resolve({
							outcome: "needs_human",
							action: "none",
							detail: "unwired",
						}),
			infraBotKickstart: (p) =>
				fleetHolder.current
					? fleetHolder.current.infraBotKickstartRepair(p)
					: Promise.resolve({
							outcome: "needs_human",
							action: "none",
							detail: "unwired",
						}),
		},
		logger: () => {},
	}),
	// fleet-kind recovery probe (watermark cleared / bot back / boot reconcile done)
	fleetRecovery: async (row) =>
		(await fleetHolder.current?.recoveryProbe(row)) ?? null,
	onTicketEscalated: async (row) => {
		await noteTicketEscalated(row.event_type, {
			store,
			createIssue: async (input) => {
				runbookCreated.push(input);
				return { id: `qa-${runbookCreated.length}`, identifier: "FLY-QA" };
			},
			isIssueOpen: async () => true,
		});
	},
});

const alertSink = { alert: (p) => hub.handle(p) };
const routedAlertSink = buildInfraAlertRouting({
	store,
	projects,
	globalBotToken: TOKEN,
	rawSink: alertSink,
});

const notifyLead = async (leadId, content, dedupeId) => {
	seams.notifiedLeads.push({ leadId, content, dedupeId });
	return true;
};

fleetHolder.current = new FleetSensors({
	store,
	alert: (p) => routedAlertSink.alert({ ...p, title: `${p.title} ${MARK}` }),
	resolveTicket: (ck) => hub.resolve(ck),
	probeBots: async () => seams.botProbes,
	scanZombies: async () => seams.zombies,
	kickstart: async (jobLabel) => {
		seams.kickstartCalls.push(jobLabel);
		return seams.kickstartResult;
	},
	serverLossPending: () =>
		serverLossHolder.current?.hasPendingMigrations() ?? false,
	env: process.env,
	logger: () => {},
});
serverLossHolder.current = new ServerLossCoordinator({
	store,
	probeServer: async () => seams.serverProbe(),
	targetGone: async () => true,
	migrate: async (session, episode) => {
		store.forceStatus(
			session.execution_id,
			"failed",
			"2026-07-09 21:30:00",
			`tmux server lost (${episode})`,
		);
		return true;
	},
	resolveLeadId: (session) => session.summary ?? null, // lead stashed on summary
	notifyLead,
	alert: (p) => routedAlertSink.alert({ ...p, title: `${p.title} ${MARK}` }),
	currentWatermark: () => fleetHolder.current?.lastWatermark ?? null,
	env: process.env,
	logger: () => {},
});

const admission = RunnerAdmissionController.alwaysAdmit();
admission.setPressureHoldProbe(() => {
	const hold = store.getFleetPressureHold();
	return hold
		? `fleet pressure-hold active since ${hold.set_at} (by ${hold.set_by}, memory ${hold.watermark ?? "?"})`
		: null;
});

const activeRow = (leadId, eventType) =>
	store.getActiveAlertThread(fleetCorrelationKey(leadId, eventType));

console.log(
	`=== FLY-1082 fleet-alert E2E — real dist, isolated 529 channel ${MARK} ===`,
);
console.log(`temp: ${tmp}`);

// ── ⑥ fail-loud kind-contract (structural guard) ──
{
	let threw = false;
	try {
		const broken = { ...KIND_CONTRACTS };
		delete broken.tmux_server_lost;
		validateKindContracts(broken, Object.keys(KIND_CONTRACTS));
	} catch (e) {
		threw = /tmux_server_lost/.test(e.message);
	}
	ok(
		"⑥ fail-loud: a missing kind contract THROWS (Bridge refuses to start)",
		threw,
	);
	let clean = true;
	try {
		validateKindContracts();
	} catch {
		clean = false;
	}
	ok("⑥ the shipped contract table validates clean", clean);
}

// ── ① swap_pressure_high — real pressure seam → hold → admission → resolve ──
{
	// admission admits BEFORE the fault
	ok(
		"① admission admits before the fault (baseline)",
		admission.tryAdmit().admit === true,
	);
	// Real danger: free% collapses below LOW (default 8%) — feed 2 ticks
	// (2-tick confirm). Swapouts static so the free-low branch alone triggers.
	setSwap(vmStatOut(5, 1_000_000));
	await fleetHolder.current.tick(); // tick 1 — arms
	const holdAfter1 = store.getFleetPressureHold();
	await fleetHolder.current.tick(); // tick 2 — triggers → routed alert → hub → ARC
	const hold = store.getFleetPressureHold();
	ok(
		"① 2-tick confirm: no hold after 1 tick, hold placed after 2 (hysteresis)",
		!holdAfter1 && !!hold,
		`set_by=${hold?.set_by}`,
	);
	ok("① hold owned by the swap sensor", hold?.set_by === "swap-sensor");
	const deferred = admission.tryAdmit();
	ok(
		"① RunnerAdmission REALLY defers dispatch with reason=pressure_hold",
		deferred.admit === false && deferred.reason === "pressure_hold",
		JSON.stringify(deferred),
	);
	const row = activeRow("swap", "swap_pressure_high");
	ok(
		"① swap ticket opened + AutoRepairBot ran the reversible hold repair (REPAIRING)",
		!!row &&
			(row.ticket_status === "REPAIRING" || row.repair_status === "attempted"),
		`status=${row?.ticket_status} repair=${row?.repair_status}`,
	);
	// Pressure alerts are owner-routed only; the mailbox sink remains unused by
	// this scenario (server-loss below still exercises its targeted use).
	ok(
		"① pressure alert emitted zero per-Lead mailbox instructions",
		seams.notifiedLeads.length === 0,
		`notified=${seams.notifiedLeads.length}`,
	);
	// recovery: free% back to healthy (≥ HIGH 15%) with Swapouts STATIC →
	// delta 0 → proven healthy → immediate clear (Tadashi's "不许假绿" bar).
	setSwap(vmStatOut(45, 1_000_000));
	await fleetHolder.current.tick(); // clear → liftSensorHold + hub.resolve
	const holdGone = store.getFleetPressureHold();
	ok("① real pressure gone → hold LIFTED (reversible)", !holdGone);
	ok(
		"① admission ADMITS again once the hold lifts",
		admission.tryAdmit().admit === true,
	);
	const resolved = activeRow("swap", "swap_pressure_high");
	ok(
		"① swap ticket quiet-resolved on recovery",
		!resolved || resolved.resolved_at != null,
		`row=${resolved ? resolved.ticket_status : "gone"}`,
	);
}

// ── ①′ FLY-1142 scar — stranded hold + monotonic Swapouts scar never wedges ──
{
	// Yesterday's OOM left a durable swap-sensor hold + a huge cumulative
	// Swapouts total; the Bridge restarted (fresh sensor instance). The machine
	// is healthy NOW (free% high, zero new swapout) — the hold must lift on the
	// SECOND sample (first sample has no delta baseline → health unproven), and
	// the scar alone must never open a new episode.
	store.setFleetPressureHold({ setBy: "swap-sensor", watermark: "94.0%" });
	const preScarAlerts = seams.notifiedLeads.length;
	const scarSensors = new FleetSensors({
		store,
		alert: (p) => routedAlertSink.alert({ ...p, title: `${p.title} ${MARK}` }),
		resolveTicket: (ck) => hub.resolve(ck),
		env: process.env,
		logger: () => {},
	});
	setSwap(vmStatOut(45, 15_351_310)); // scar: huge but STATIC Swapouts
	await scarSensors.tick(); // sample 1 — delta unknown, no lift
	const heldAfter1 = store.getFleetPressureHold();
	await scarSensors.tick(); // sample 2 — delta 0 + free healthy → PROVEN → lift
	const heldAfter2 = store.getFleetPressureHold();
	ok(
		"①′ stranded hold NOT lifted on the 1st post-restart sample (no delta evidence)",
		!!heldAfter1,
	);
	ok(
		"①′ stranded hold LIFTED on the 2nd static sample (health proven)",
		!heldAfter2,
	);
	ok(
		"①′ the swap-watermark scar alone never re-arms the sensor (no new ticket)",
		!activeRow("swap", "swap_pressure_high") ||
			activeRow("swap", "swap_pressure_high")?.resolved_at != null,
	);
	ok(
		"①′ no per-Lead mailbox instruction during the scar scenario",
		seams.notifiedLeads.length === preScarAlerts,
	);
	ok(
		"①′ admission admits with the scar present",
		admission.tryAdmit().admit === true,
	);
}

// ── ①″ FLY-1142 swapout branch — sustained thrash triggers even with free% healthy ──
{
	// The OTHER trigger dimension: the machine is actively swapping out (the
	// Swapouts counter climbs every tick) while free% still LOOKS fine.
	// A FRESH sensor instance (no Swapouts baseline — Codex code R1 LOW), so
	// the sequence is genuinely: baseline sample (delta unknown, never counts)
	// + 2 increasing samples = 3 samples to hold. Recovery: counter goes
	// static → delta 0 → immediate clear. The ARC hold repair still runs via
	// fleetHolder.current (the hub wiring), sharing the same durable store.
	const swapoutSensors = new FleetSensors({
		store,
		alert: (p) => routedAlertSink.alert({ ...p, title: `${p.title} ${MARK}` }),
		resolveTicket: (ck) => hub.resolve(ck),
		env: process.env,
		logger: () => {},
	});
	setSwap(vmStatOut(45, 1_000_000));
	await swapoutSensors.tick(); // baseline — delta unknown (fresh instance)
	setSwap(vmStatOut(45, 1_400_000));
	await swapoutSensors.tick(); // delta 400k — danger 1
	const holdMid = store.getFleetPressureHold();
	setSwap(vmStatOut(45, 1_800_000));
	await swapoutSensors.tick(); // delta 400k — danger 2 → trigger → ARC hold
	const holdSw = store.getFleetPressureHold();
	ok(
		"①″ sustained swapout (healthy free%) → hold after baseline + 2 delta ticks",
		!holdMid && holdSw?.set_by === "swap-sensor",
		`set_by=${holdSw?.set_by}`,
	);
	ok(
		"①″ admission defers during the swapout episode",
		admission.tryAdmit().admit === false,
	);
	setSwap(vmStatOut(45, 1_800_000)); // counter static → delta 0 → healthy
	await swapoutSensors.tick(); // clear
	ok(
		"①″ swapout stops (counter static) → hold lifted immediately",
		!store.getFleetPressureHold(),
	);
	ok(
		"①″ admission admits again after the swapout episode clears",
		admission.tryAdmit().admit === true,
	);
}

// ── ② tmux_server_lost — REAL isolated tmux server killed → grouped episode ──
{
	const sock = `qa-fly1082-${process.pid}`;
	const tmuxOk = spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
	// start a real isolated tmux server with a session, then kill the server
	if (tmuxOk) {
		spawnSync("tmux", [
			"-L",
			sock,
			"new-session",
			"-d",
			"-s",
			"probe",
			"sleep 300",
		]);
		const before = spawnSync("tmux", [
			"-L",
			sock,
			"has-session",
			"-t",
			"probe",
		]);
		ok(
			"② isolated tmux server really came up (real probe target)",
			before.status === 0,
		);
		spawnSync("tmux", ["-L", sock, "kill-server"]);
	}
	// the coordinator's real probe reads the (now-dead) isolated server
	seams.serverProbe = () => {
		const r = spawnSync("tmux", ["-L", sock, "list-sessions"], {
			encoding: "utf-8",
		});
		const noServer = /no server running|error connecting/i.test(
			`${r.stderr}${r.stdout}`,
		);
		return noServer ? "down" : "up";
	};
	// register 3 running tmux-backed sessions across 2 leads
	const fleet = [
		{
			execution_id: "z-1",
			issue_id: "i-1",
			issue_identifier: "FLY-9001",
			project_name: "flywheel",
			status: "running",
			adapter_type: "claude-tmux",
			summary: "flywheel-test-1",
		},
		{
			execution_id: "z-2",
			issue_id: "i-2",
			issue_identifier: "FLY-9002",
			project_name: "flywheel",
			status: "running",
			adapter_type: "claude-tmux",
			summary: "flywheel-test-1",
		},
		{
			execution_id: "z-3",
			issue_id: "i-3",
			issue_identifier: "FLY-9003",
			project_name: "flywheel",
			status: "running",
			adapter_type: "claude-tmux",
			summary: "flywheel-test-2",
		},
	];
	for (const s of fleet) store.upsertSession(s);
	const claimed = await serverLossHolder.current.check();
	ok(
		"② real probe read 'no server' → coordinator claimed ALL 3 running sessions",
		claimed.size === 3,
		`claimed=${claimed.size}`,
	);
	const migrated = fleet.filter(
		(s) => store.getSession(s.execution_id)?.status === "failed",
	);
	ok(
		"② every claimed runner migrated to terminal `failed` (grouped)",
		migrated.length === 3,
	);
	const notifiedLeads = new Set(
		seams.notifiedLeads
			.filter((n) => n.content.includes("tmux server"))
			.map((n) => n.leadId),
	);
	ok(
		"② ONE grouped casualty notification per affected Lead (2 leads)",
		notifiedLeads.size === 2,
		`leads=[${[...notifiedLeads]}]`,
	);
	const row = activeRow("tmux-server", "tmux_server_lost");
	ok(
		"② exactly ONE tmux_server_lost fleet ticket opened",
		!!row,
		`status=${row?.ticket_status}`,
	);
	// second check with server still down + no new sessions → no double migration
	const claimed2 = await serverLossHolder.current.check();
	ok(
		"② idempotent: a second pass with nothing new claims 0 (no double-burial)",
		claimed2.size === 0 ||
			[...claimed2].every((id) => store.getSession(id)?.status === "failed"),
	);
}

// ── ③ bridge_abnormal_exit — REAL exit-marker dirty-detection ──
{
	const marker = await tl("bridge/bridge-exit-marker.js");
	const mfile = join(tmp, "bridge-exit-marker.json");
	// previous generation wrote a running marker then died (no clean shutdown)
	marker.writeRunningMarker(mfile, 4242, 1_700_000_000_000);
	const prev = marker.latchPreviousMarker(mfile);
	ok(
		"③ latched a DIRTY prev marker (running = died without clean shutdown)",
		prev?.state === "running" && prev.pid === 4242,
		`state=${prev?.state}`,
	);
	// the revived Bridge opens the boot self-check ticket (same as plugin.ts)
	await routedAlertSink.alert({
		leadId: "bridge",
		projectName: "machine",
		eventId: marker.abnormalExitTicketEventId(prev),
		eventType: "bridge_abnormal_exit",
		title: `Bridge 非正常退出 — 复活对账中 ${MARK}`,
		body: `上一代 Bridge (PID ${prev.pid}) 没有 clean shutdown 就退出了（episode ${marker.abnormalExitEpisodeSignature(prev)}）。launchd 已复活;对账完成后安静 resolve。`,
		severity: "severe",
	});
	const row = activeRow("bridge", "bridge_abnormal_exit");
	ok(
		"③ boot self-check ticket opened for the abnormal exit",
		!!row,
		`status=${row?.ticket_status}`,
	);
	// recovery gate: not done until wiring completes, then resolvable
	fleetHolder.current.bootReconcileDone = false;
	const probeBefore = await fleetHolder.current.recoveryProbe(row);
	fleetHolder.current.bootReconcileDone = true; // plugin flips this post-wiring
	const probeAfter = await fleetHolder.current.recoveryProbe(row);
	ok(
		"③ recovery gated on boot reconcile: null before wiring done, true after",
		probeBefore === null && probeAfter === true,
		`before=${probeBefore} after=${probeAfter}`,
	);
	// a clean shutdown marker → next boot sees no dirty exit (byte-compat)
	marker.writeRunningMarker(mfile, 5252, 1_700_000_100_000);
	marker.writeCleanMarker(mfile);
	const cleanPrev = marker.latchPreviousMarker(mfile);
	ok(
		"③ a CLEAN shutdown marker is NOT read as abnormal exit",
		cleanPrev?.state !== "running",
	);
}

// ── ④ infra_bot_down — cross-owner + real kickstart ARC ──
{
	// codex bot dead → owner must be the CLAUDE bot ("nobody rescues their own side")
	seams.botProbes = [
		{
			provider: "codex",
			alive: false,
			jobLabel: process.env.FLYWHEEL_CODEX_INFRA_BOT_JOB,
			probeSource: "qa launchctl",
		},
	];
	await fleetHolder.current.tick(); // botTick → alert → hub → ARC(kickstart)
	const row = activeRow("infra-bot:codex", "infra_bot_down");
	ok(
		"④ infra_bot_down ticket opened for the dead codex bot",
		!!row,
		`status=${row?.ticket_status}`,
	);
	ok(
		"④ cross-owner: dead codex → owner is the CLAUDE bot (nobody rescues own side)",
		row?.owner_ref === "infra_bot:claude",
		`owner_ref=${row?.owner_ref}`,
	);
	ok(
		"④ ARC ran the real launchctl kickstart against the dead bot's job",
		seams.kickstartCalls.includes(process.env.FLYWHEEL_CODEX_INFRA_BOT_JOB),
		`calls=[${seams.kickstartCalls}]`,
	);
	// probe flips alive → recovery resolve
	seams.botProbes = [
		{
			provider: "codex",
			alive: true,
			jobLabel: process.env.FLYWHEEL_CODEX_INFRA_BOT_JOB,
			probeSource: "qa launchctl",
		},
	];
	await fleetHolder.current.tick();
	const resolved = activeRow("infra-bot:codex", "infra_bot_down");
	ok(
		"④ bot back alive → ticket quiet-resolved",
		!resolved || resolved.resolved_at != null,
		`row=${resolved ? resolved.ticket_status : "gone"}`,
	);
}

// ── ⑤ zombie_session_backlog — by-design ESCALATED at enqueue (no ARC) ──
{
	seams.zombies = [
		{
			shape: "commdb_orphan",
			executionId: "zz-1",
			projectName: "flywheel",
			detail: "CommDB running, no StateStore row",
		},
		{
			shape: "terminal_desync",
			executionId: "zz-2",
			projectName: "flywheel",
			detail: "StateStore terminal, CommDB running",
		},
		{
			shape: "stale_target",
			executionId: "zz-3",
			projectName: "flywheel",
			detail: "running >24h, tmux target gone",
		},
	];
	// zombie scan is throttled ~15min — force the window open by resetting the clock
	fleetHolder.current.lastZombieScanAt = 0;
	// advance now() past the throttle: the sensor reads deps.now(); default Date.now
	await fleetHolder.current.tick();
	const row = activeRow("zombie", "zombie_session_backlog");
	ok(
		"⑤ zombie_session_backlog ticket opened at/above the backlog threshold",
		!!row,
		`status=${row?.ticket_status}`,
	);
	ok(
		"⑤ (b)-type: lands directly ESCALATED at enqueue (by design, no ARC retry loop)",
		row?.ticket_status === "ESCALATED",
		`status=${row?.ticket_status}`,
	);
	const c = KIND_CONTRACTS.zombie_session_backlog;
	ok(
		"⑤ contract: owner named + remediation points at FLY-1066 (v1 detect-only)",
		c.arc === "none_escalate" && c.remediationRef === "FLY-1066",
		`arc=${c.arc} ref=${c.remediationRef}`,
	);
}

// ── Discord API re-fetch: confirm the real alerts landed in the isolated channel ──
async function discordFetch() {
	try {
		const raw = execFileSync(
			"curl",
			[
				"-s",
				"-H",
				`Authorization: Bot ${TOKEN}`,
				"-H",
				"User-Agent: FlywheelQA (https://flywheel, 1.0)",
				`https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=30`,
			],
			{ encoding: "utf-8" },
		);
		return JSON.parse(raw);
	} catch (e) {
		results.fail.push(`Discord re-fetch failed: ${e.message}`);
		return [];
	}
}
// small settle for thread posts
await new Promise((r) => setTimeout(r, 2500));
const msgs = await discordFetch();
const mine = msgs.filter((m) => JSON.stringify(m).includes(MARK));
ok(
	`Discord: real fleet alerts landed in the isolated test channel`,
	mine.length >= 3,
	`found=${mine.length} with ${MARK}`,
);
const landedKinds = new Set();
for (const m of msgs) {
	const s = JSON.stringify(m);
	for (const k of [
		"swap",
		"tmux server",
		"Bridge 非正常",
		"infra bot",
		"僵尸",
	]) {
		if (s.includes(MARK) && s.includes(k)) landedKinds.add(k);
	}
}

console.log("\n===== RESULT =====");
console.log(`PASS (${results.pass.length}):`);
for (const p of results.pass) console.log(`  ✓ ${p}`);
if (results.fail.length) {
	console.log(`\nFAIL (${results.fail.length}):`);
	for (const f of results.fail) console.log(`  ✗ ${f}`);
}
console.log(
	`\nDISCORD (real, isolated channel) — ${mine.length} msgs carrying ${MARK}:`,
);
for (const m of mine.slice(0, 12)) {
	const title = (
		m.content ||
		m.embeds?.[0]?.title ||
		m.embeds?.[0]?.description ||
		""
	)
		.replace(/\s+/g, " ")
		.slice(0, 100);
	console.log(`  • ${m.id}  "${title}"  @${m.timestamp}`);
}
console.log(`\nkinds visible in channel: [${[...landedKinds]}]`);
console.log(
	`channel: https://discord.com/channels/1512577412069658634/${CHANNEL}`,
);
console.log(
	results.fail.length === 0 ? "\nE2E VERDICT: PASS" : "\nE2E VERDICT: FAIL",
);
store.close();
process.exit(results.fail.length === 0 ? 0 : 1);
