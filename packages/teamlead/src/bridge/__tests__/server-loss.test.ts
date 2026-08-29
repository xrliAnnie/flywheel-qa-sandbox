/**
 * FLY-1082 (Task 2.3): the server-loss coordinator — ONE episode, exactly one
 * migration per runner, one grouped notification per Lead (the incident shape:
 * 3 Leads / 13 runners), boot fresh-server aggregation, and honest
 * needs_human evidence when a Lead notification fails.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AlertPayload, AlertResult } from "../../LeadAlertNotifier.js";
import type { Session, StateStore } from "../../StateStore.js";
import { StateStore as RealStateStore } from "../../StateStore.js";
import { ServerLossCoordinator, type ServerProbe } from "../server-loss.js";

function session(i: number, lead: string): Session {
	return {
		execution_id: `exec-${i}`,
		issue_id: `issue-${i}`,
		issue_identifier: `FLY-${1000 + i}`,
		project_name: "flywheel",
		status: "running",
		adapter_type: "claude-tmux",
		// stash the lead on the session for the test resolver
		summary: lead,
	} as Session;
}

/** The 2026-07-09 incident shape: 13 runners across 3 Leads. */
function incidentFleet(): Session[] {
	const out: Session[] = [];
	let i = 0;
	for (const [lead, count] of [
		["tadashi", 5],
		["honey-lemon", 5],
		["peter", 3],
	] as const) {
		for (let k = 0; k < count; k++) out.push(session(++i, lead));
	}
	return out;
}

describe("ServerLossCoordinator (FLY-1082 Task 2.3)", () => {
	let store: StateStore;
	let alerts: AlertPayload[];
	let migrations: Array<{ execId: string; episode: string }>;
	let notifications: Array<{
		leadId: string;
		content: string;
		dedupeId?: string;
	}>;

	beforeEach(async () => {
		store = await RealStateStore.create(":memory:");
		alerts = [];
		migrations = [];
		notifications = [];
	});

	function makeCoordinator(opts: {
		sessions: Session[];
		probe: ServerProbe | (() => ServerProbe);
		targetGone?: (s: Session) => Promise<boolean | null>;
		notifyOk?: (leadId: string) => boolean;
		env?: NodeJS.ProcessEnv;
	}) {
		for (const s of opts.sessions) store.upsertSession(s);
		return new ServerLossCoordinator({
			store,
			probeServer: async () =>
				typeof opts.probe === "function" ? opts.probe() : opts.probe,
			targetGone: opts.targetGone ?? (async () => true),
			migrate: async (s, episode) => {
				migrations.push({ execId: s.execution_id, episode });
				// mimic the real transition: the session leaves `running`
				store.forceStatus(s.execution_id, "failed", "2026-07-09 21:30:00", "x");
				return true;
			},
			resolveLeadId: (s) => (s.summary as string) ?? null,
			notifyLead: async (leadId, content, dedupeId) => {
				notifications.push({ leadId, content, dedupeId });
				return opts.notifyOk ? opts.notifyOk(leadId) : true;
			},
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			currentWatermark: () => "41.3% free",
			env: opts.env ?? ({} as NodeJS.ProcessEnv),
			now: () => 1_720_000_000_000,
			logger: () => {},
		});
	}

	it("server DOWN: ONE episode, one migration per runner, one grouped notify per Lead", async () => {
		const fleet = incidentFleet();
		const coordinator = makeCoordinator({ sessions: fleet, probe: "down" });

		const claimed = await coordinator.check();

		// Every runner claimed + migrated exactly once.
		expect(claimed.size).toBe(13);
		expect(migrations).toHaveLength(13);
		expect(new Set(migrations.map((m) => m.execId)).size).toBe(13);
		// All migrations share ONE episode signature.
		expect(new Set(migrations.map((m) => m.episode)).size).toBe(1);
		// ONE alert (never 13), severe, with the coordinator's evidence.
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventType).toBe("tmux_server_lost");
		expect(alerts[0]!.projectName).toBe("machine");
		expect(alerts[0]!.metadata?.tmuxServerLost).toEqual({
			casualties: 13,
			migrated: 13,
			leadsNotified: 3,
			leadsFailed: 0,
		});
		// One grouped notification per Lead, each with ITS casualty list + resume
		// pointer + the watermark.
		expect(notifications).toHaveLength(3);
		const tadashi = notifications.find((n) => n.leadId === "tadashi");
		expect(tadashi!.content).toContain("5 个 runner");
		expect(tadashi!.content).toContain("FLY-1001");
		expect(tadashi!.content).toContain("$FLYWHEEL_PROGRESS_PATH");
		expect(tadashi!.content).toContain("41.3% free"); // FLY-1142: free%, not swap%
		expect(tadashi!.content).not.toContain("FLY-1006"); // honey-lemon's runner
	});

	it("second check after migration is quiet (sessions left running=0 → no re-fire)", async () => {
		const coordinator = makeCoordinator({
			sessions: incidentFleet(),
			probe: "down",
		});
		await coordinator.check();
		alerts.length = 0;
		migrations.length = 0;
		const second = await coordinator.check();
		expect(second.size).toBe(0);
		expect(alerts).toHaveLength(0);
		expect(migrations).toHaveLength(0);
	});

	it("TERMINALLY failed Lead notification → leadsFailed in the (held-until-settled) ticket", async () => {
		const coordinator = makeCoordinator({
			sessions: incidentFleet(),
			probe: "down",
			notifyOk: (leadId) => leadId !== "peter",
		});
		// The ticket is HELD while peter is still mid-retry (Codex R6 HIGH) —
		// only his 3rd (terminal) failure settles the outbox and releases it.
		await coordinator.check();
		expect(alerts).toHaveLength(0);
		await coordinator.check();
		expect(alerts).toHaveLength(0);
		await coordinator.check();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.metadata?.tmuxServerLost).toEqual({
			casualties: 13,
			migrated: 13,
			leadsNotified: 2,
			leadsFailed: 1,
		});
	});

	it("a TRANSIENT notify failure holds the ticket — never a false leadsFailed/needs_human (Codex R6 HIGH)", async () => {
		let peterDown = true;
		const coordinator = makeCoordinator({
			sessions: incidentFleet(),
			probe: "down",
			notifyOk: (leadId) => leadId !== "peter" || !peterDown,
		});
		await coordinator.check(); // peter attempt 1 fails → ticket HELD
		expect(alerts).toHaveLength(0);
		peterDown = false; // one-tick transient — recovers
		await coordinator.check();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.metadata?.tmuxServerLost).toEqual({
			casualties: 13,
			migrated: 13,
			leadsNotified: 3,
			leadsFailed: 0, // a retrying Lead was never reported as failed
		});
	});

	it("server UP + healthy targets: nothing happens", async () => {
		const coordinator = makeCoordinator({
			sessions: incidentFleet(),
			probe: "up",
			targetGone: async () => false,
		});
		expect((await coordinator.check()).size).toBe(0);
		expect(alerts).toHaveLength(0);
	});

	it("probe UNKNOWN never claims (indeterminate ≠ loss)", async () => {
		const coordinator = makeCoordinator({
			sessions: incidentFleet(),
			probe: "unknown",
		});
		expect((await coordinator.check()).size).toBe(0);
		expect(migrations).toHaveLength(0);
	});

	it("boot leg: fresh/empty server with ALL targets gone ≥ threshold fires the SAME kind", async () => {
		const coordinator = makeCoordinator({
			sessions: incidentFleet(),
			probe: "up",
			targetGone: async () => true,
		});
		const claimed = await coordinator.check();
		expect(claimed.size).toBe(13);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.body).toContain("重启");
	});

	it("boot leg respects the mass-loss threshold (2 sessions < default 3 → no fire)", async () => {
		const coordinator = makeCoordinator({
			sessions: [session(1, "tadashi"), session(2, "tadashi")],
			probe: "up",
			targetGone: async () => true,
		});
		expect((await coordinator.check()).size).toBe(0);
	});

	it("boot leg only fires on the FIRST check (later fresh-server checks are the tick leg's job)", async () => {
		const fleet = incidentFleet();
		const coordinator = makeCoordinator({
			sessions: [],
			probe: "up",
			targetGone: async () => true,
		});
		await coordinator.check(); // first check: no sessions → nothing
		for (const s of fleet) store.upsertSession(s);
		expect((await coordinator.check()).size).toBe(0); // not first — no boot leg
	});

	it("boot leg: ANY indeterminate target verdict vetoes the mass-loss claim", async () => {
		let i = 0;
		const coordinator = makeCoordinator({
			sessions: incidentFleet(),
			probe: "up",
			targetGone: async () => (++i === 5 ? null : true),
		});
		expect((await coordinator.check()).size).toBe(0);
	});

	it("partial migration failure: NEXT tick retries quietly under the SAME episode — no new ticket, no re-notify (Codex R1 HIGH-2)", async () => {
		const fleet = incidentFleet();
		for (const s of fleet) store.upsertSession(s);
		let failFor = new Set(["exec-1", "exec-2"]);
		const coordinator = new ServerLossCoordinator({
			store,
			probeServer: async () => "down",
			targetGone: async () => true,
			migrate: async (s, episode) => {
				migrations.push({ execId: s.execution_id, episode });
				if (failFor.has(s.execution_id)) throw new Error("boom");
				store.forceStatus(s.execution_id, "failed", "2026-07-09 21:30:00", "x");
				return true;
			},
			resolveLeadId: (s) => (s.summary as string) ?? null,
			notifyLead: async (leadId, content) => {
				notifications.push({ leadId, content });
				return true;
			},
			alert: async (p) => {
				alerts.push(p);
				return { sent: true };
			},
			env: {} as NodeJS.ProcessEnv,
			now: () => 1_720_000_000_000,
			logger: () => {},
		});

		const first = await coordinator.check();
		expect(first.size).toBe(13);
		expect(alerts).toHaveLength(1);
		expect(notifications).toHaveLength(3);
		const episode = migrations[0]!.episode;

		// Second tick: exec-1/exec-2 still running (their migration threw).
		failFor = new Set(); // failures clear this time
		const second = await coordinator.check();
		// Still claimed (suppress the per-runner reapers) — but NO second
		// episode, NO second fleet ticket, NO re-notification.
		expect(second.size).toBe(13);
		expect(alerts).toHaveLength(1);
		expect(notifications).toHaveLength(3);
		// The retries ran under the SAME episode signature.
		const retries = migrations.slice(13);
		expect(retries.map((m) => m.execId).sort()).toEqual(["exec-1", "exec-2"]);
		expect(new Set(retries.map((m) => m.episode))).toEqual(new Set([episode]));

		// Third tick: everything migrated → latch cleared, coordinator quiet.
		const third = await coordinator.check();
		expect(third.size).toBe(0);
		expect(alerts).toHaveLength(1);
	});

	it("metadata carries the casualty total; hasPendingMigrations reflects unmigrated sessions (Codex R2 HIGH)", async () => {
		const fleet = incidentFleet();
		for (const s of fleet) store.upsertSession(s);
		const failFor = new Set(["exec-1"]);
		const coordinator = new ServerLossCoordinator({
			store,
			probeServer: async () => "down",
			targetGone: async () => true,
			migrate: async (s) => {
				if (failFor.has(s.execution_id)) throw new Error("boom");
				store.forceStatus(s.execution_id, "failed", "2026-07-09 21:30:00", "x");
				return true;
			},
			resolveLeadId: (s) => (s.summary as string) ?? null,
			notifyLead: async () => true,
			alert: async (p) => {
				alerts.push(p);
				return { sent: true };
			},
			env: {} as NodeJS.ProcessEnv,
			now: () => 1_720_000_000_000,
			logger: () => {},
		});
		await coordinator.check();
		expect(alerts[0]!.metadata?.tmuxServerLost).toEqual({
			casualties: 13,
			migrated: 12,
			leadsNotified: 3,
			leadsFailed: 0,
		});
		// exec-1 is still running → the episode is PENDING (recovery must wait).
		expect(coordinator.hasPendingMigrations()).toBe(true);
		failFor.clear();
		await coordinator.check(); // retry lands
		expect(coordinator.hasPendingMigrations()).toBe(false);
	});

	it("Bridge restart mid-partial-migration resumes the DURABLE episode ledger — no duplicate ticket/notify (Codex R2 MED-2 + R3)", async () => {
		const fleet = incidentFleet().slice(0, 4);
		for (const s of fleet) store.upsertSession(s);
		// The durable evidence of the pre-restart episode: the LEDGER row —
		// ticket emitted + tadashi notified pre-crash (all side effects done).
		store.setServerLossEpisode("tmux-server-lost:1000", {
			shape: "server_down",
			claimed: fleet.map((s) => s.execution_id),
			ticketDone: true,
			notifiedLeads: ["tadashi"],
			failedLeads: [],
			notifyAttempts: {},
		});
		// A FRESH coordinator (post-restart: no in-memory state at all).
		const coordinator = makeCoordinator({ sessions: [], probe: "down" });
		const claimed = await coordinator.check();
		// Resumed: pending sessions migrated under the DURABLE episode
		// signature; no new fleet ticket, no Lead notifications.
		expect(claimed.size).toBe(4);
		expect(alerts).toHaveLength(0);
		expect(notifications).toHaveLength(0);
		expect(new Set(migrations.map((m) => m.episode))).toEqual(
			new Set(["tmux-server-lost:1000"]),
		);
	});

	it("a stale ACTIVE ticket alone (no ledger) never swallows a NEW incident (Codex R3 HIGH-2)", async () => {
		const fleet = incidentFleet().slice(0, 4);
		// An old permanently-ESCALATED ticket lingers — but its episode ledger
		// is gone (all of ITS sessions were handled long ago).
		store.openAlertThread({
			correlationKey: "machine|tmux-server|tmux_server_lost|",
			eventId: "tmux-server-lost:1000",
			threadId: "t-old",
			channelId: "c",
			leadId: "tmux-server",
			projectName: "machine",
			eventType: "tmux_server_lost",
			ticketStatus: "ESCALATED",
		});
		const coordinator = makeCoordinator({ sessions: fleet, probe: "down" });
		await coordinator.check();
		// The NEW incident gets its OWN episode: a fresh fleet ticket + fresh
		// notifications — never silently folded under the stale signature.
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventId).not.toBe("tmux-server-lost:1000");
		expect(notifications.length).toBeGreaterThan(0);
	});

	it("an UNKNOWN probe never migrates pending sessions (suppression only) (Codex R3 HIGH-1)", async () => {
		const fleet = incidentFleet().slice(0, 4);
		for (const s of fleet) store.upsertSession(s);
		store.setServerLossEpisode("tmux-server-lost:1000", {
			shape: "server_down",
			claimed: fleet.map((s) => s.execution_id),
			ticketDone: true,
			notifiedLeads: ["tadashi"],
			failedLeads: [],
			notifyAttempts: {},
		});
		const coordinator = makeCoordinator({
			sessions: [],
			probe: "unknown",
			targetGone: async () => null, // cannot tell — must not migrate
		});
		const claimed = await coordinator.check();
		expect(claimed.size).toBe(4); // reapers stay suppressed
		expect(migrations).toHaveLength(0); // but NOTHING is buried on unknown
		expect(alerts).toHaveLength(0);
	});

	it("within an ongoing episode, a pending session with a PROVABLY gone target migrates even while the server probe is up", async () => {
		const fleet = incidentFleet().slice(0, 3);
		for (const s of fleet) store.upsertSession(s);
		store.setServerLossEpisode("tmux-server-lost:1000", {
			shape: "server_down",
			claimed: fleet.map((s) => s.execution_id),
			ticketDone: true,
			notifiedLeads: ["tadashi"],
			failedLeads: [],
			notifyAttempts: {},
		});
		const coordinator = makeCoordinator({
			sessions: [],
			probe: "up",
			targetGone: async () => true,
		});
		await coordinator.check();
		expect(migrations).toHaveLength(3);
		expect(new Set(migrations.map((m) => m.episode))).toEqual(
			new Set(["tmux-server-lost:1000"]),
		);
	});

	it("crash BEFORE the announcement: the un-announced ledger replays ticket + notifications after restart (Codex R4 HIGH-1)", async () => {
		const fleet = incidentFleet().slice(0, 4);
		// Pre-crash state: sessions already migrated (terminal), ledger armed
		// but NO side effect landed — the crash hit between migration and the
		// notify/ticket phases (outbox empty, ticketDone=false).
		for (const s of fleet) {
			store.upsertSession(s);
			store.forceStatus(s.execution_id, "failed", "2026-07-09 21:30:00", "x");
		}
		store.setServerLossEpisode("tmux-server-lost:1000", {
			shape: "server_down",
			claimed: fleet.map((s) => s.execution_id),
			ticketDone: false,
			notifiedLeads: [],
			failedLeads: [],
			notifyAttempts: {},
		});
		const coordinator = makeCoordinator({ sessions: [], probe: "unknown" });
		await coordinator.check();
		// The owed announcement fires from the ledger: ONE ticket + grouped
		// notifications, under the ORIGINAL signature.
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.eventId).toBe("tmux-server-lost:1000");
		expect(alerts[0]!.metadata?.tmuxServerLost).toMatchObject({
			casualties: 4,
			migrated: 4,
		});
		expect(notifications.length).toBeGreaterThan(0);
		// Announced + nothing pending → the NEXT check clears the ledger.
		await coordinator.check();
		expect(store.getServerLossEpisode()).toBeUndefined();
	});

	it("NEW casualties during an ongoing server-down episode JOIN it — migrated + delta-notified, no second ticket (Codex R4 HIGH-2)", async () => {
		const fleet = incidentFleet().slice(0, 3); // tadashi ×3
		let failFor = new Set(fleet.map((s) => s.execution_id)); // keep pending
		const coordinator = makeCoordinator({
			sessions: fleet,
			probe: "down",
			targetGone: async () => true,
		});
		// Override migrate to control failures.
		const controlled = new ServerLossCoordinator({
			store,
			probeServer: async () => "down",
			targetGone: async () => true,
			migrate: async (s, episode) => {
				migrations.push({ execId: s.execution_id, episode });
				if (failFor.has(s.execution_id)) throw new Error("boom");
				store.forceStatus(s.execution_id, "failed", "2026-07-09 21:30:00", "x");
				return true;
			},
			resolveLeadId: (s) => (s.summary as string) ?? null,
			notifyLead: async (leadId, content) => {
				notifications.push({ leadId, content });
				return true;
			},
			alert: async (p) => {
				alerts.push(p);
				return { sent: true };
			},
			env: {} as NodeJS.ProcessEnv,
			now: () => 1_720_000_000_000,
			logger: () => {},
		});
		await controlled.check(); // episode opens; all 3 migrations fail (pending)
		expect(alerts).toHaveLength(1);
		const baseNotifies = notifications.length;
		// A NEW casualty appears while the server is still down.
		store.upsertSession(session(99, "peter"));
		failFor = new Set();
		const claimed = await controlled.check();
		// Joined the SAME episode: claimed + migrated under the original
		// signature; its Lead got a delta notification; NO second fleet ticket.
		expect(claimed.has("exec-99")).toBe(true);
		expect(alerts).toHaveLength(1);
		expect(
			migrations.filter((m) => m.execId === "exec-99").map((m) => m.episode),
		).toEqual([alerts[0]!.eventId]);
		const deltaNotify = notifications.slice(baseNotifies);
		expect(deltaNotify.some((n) => n.leadId === "peter")).toBe(true);
		void coordinator;
	});

	it("a migration failure still counts the runner as claimed (no double-burial by orphan reaper)", async () => {
		const fleet = [session(1, "tadashi")];
		for (const s of fleet) store.upsertSession(s);
		const coordinator = new ServerLossCoordinator({
			store,
			probeServer: async () => "down",
			targetGone: async () => true,
			migrate: async () => {
				throw new Error("boom");
			},
			resolveLeadId: () => "tadashi",
			notifyLead: async () => true,
			alert: async (p) => {
				alerts.push(p);
				return { sent: true };
			},
			env: {} as NodeJS.ProcessEnv,
			logger: () => {},
		});
		const claimed = await coordinator.check();
		expect(claimed.has("exec-1")).toBe(true);
		expect(alerts[0]!.metadata?.tmuxServerLost?.migrated).toBe(0);
	});

	it("notify-then-ticket-crash: replay emits the ticket WITHOUT duplicate Lead notifications (Codex R5 MED-1)", async () => {
		const fleet = incidentFleet();
		for (const s of fleet) store.upsertSession(s);
		let alertOk = false;
		const make = () =>
			new ServerLossCoordinator({
				store,
				probeServer: async () => "down",
				targetGone: async () => true,
				migrate: async (s, episode) => {
					migrations.push({ execId: s.execution_id, episode });
					store.forceStatus(
						s.execution_id,
						"failed",
						"2026-07-09 21:30:00",
						"x",
					);
					return true;
				},
				resolveLeadId: (s) => (s.summary as string) ?? null,
				notifyLead: async (leadId, content) => {
					notifications.push({ leadId, content });
					return true;
				},
				alert: async (p) => {
					if (!alertOk) throw new Error("notifier down");
					alerts.push(p);
					return { sent: true };
				},
				env: {} as NodeJS.ProcessEnv,
				now: () => 1_720_000_000_000,
				logger: () => {},
			});
		await make().check(); // notifications LAND, the ticket THROWS
		expect(notifications).toHaveLength(3);
		expect(alerts).toHaveLength(0);
		// Restart replay (fresh coordinator): ticket re-emitted, but the per-Lead
		// OUTBOX remembers all 3 were already delivered — no duplicates.
		alertOk = true;
		await make().check();
		expect(alerts).toHaveLength(1);
		expect(notifications).toHaveLength(3);
		expect(alerts[0]!.metadata?.tmuxServerLost).toEqual({
			casualties: 13,
			migrated: 13,
			leadsNotified: 3,
			leadsFailed: 0,
		});
	});

	it("extension delta is DURABLE: a crash between joining and delta delivery re-delivers from the outbox (Codex R5 HIGH)", async () => {
		const fleet = incidentFleet().slice(0, 3); // tadashi ×3
		let notifyOk = true;
		const make = () =>
			new ServerLossCoordinator({
				store,
				probeServer: async () => "down",
				targetGone: async () => true,
				migrate: async (s, episode) => {
					migrations.push({ execId: s.execution_id, episode });
					throw new Error("boom"); // keep everything pending (episode open)
				},
				resolveLeadId: (s) => (s.summary as string) ?? null,
				notifyLead: async (leadId, content) => {
					if (!notifyOk) throw new Error("discord down");
					notifications.push({ leadId, content });
					return true;
				},
				alert: async (p) => {
					alerts.push(p);
					return { sent: true };
				},
				env: {} as NodeJS.ProcessEnv,
				now: () => 1_720_000_000_000,
				logger: () => {},
			});
		for (const s of fleet) store.upsertSession(s);
		await make().check(); // episode open: tadashi notified, ticket done
		expect(notifications).toHaveLength(1);
		// A NEW tadashi casualty joins; the "crash" lands right after the
		// extension persists — the delta delivery FAILS this tick.
		store.upsertSession(session(50, "tadashi"));
		notifyOk = false;
		await make().check(); // fresh process: joined durably, delivery failed
		expect(notifications).toHaveLength(1);
		// Next restart: the outbox still OWES tadashi — the delta re-delivers
		// with the FULL updated casualty list, under the ONE original ticket.
		notifyOk = true;
		await make().check();
		expect(notifications).toHaveLength(2);
		const delta = notifications[1]!;
		expect(delta.leadId).toBe("tadashi");
		expect(delta.content).toContain("4 个 runner");
		expect(delta.content).toContain("FLY-1050");
		expect(alerts).toHaveLength(1);
	});

	it("replay preserves the loss SHAPE — a server_fresh episode keeps its body wording after restart (Codex R5 MED-2)", async () => {
		const fleet = incidentFleet().slice(0, 3);
		for (const s of fleet) {
			store.upsertSession(s);
			store.forceStatus(s.execution_id, "failed", "2026-07-09 21:30:00", "x");
		}
		store.setServerLossEpisode("tmux-server-lost:1000", {
			shape: "server_fresh",
			claimed: fleet.map((s) => s.execution_id),
			ticketDone: false,
			notifiedLeads: ["tadashi"], // already delivered pre-crash
			failedLeads: [],
			notifyAttempts: {},
		});
		const coordinator = makeCoordinator({ sessions: [], probe: "unknown" });
		await coordinator.check();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]!.body).toContain("重启"); // server_fresh wording survived
		expect(notifications).toHaveLength(0); // outbox says tadashi is settled
	});

	it("notify dedupeId is DETERMINISTIC across crash-replay and CHANGES with the casualty list (Codex R6 MED)", async () => {
		const fleet = incidentFleet().slice(0, 3); // tadashi ×3
		for (const s of fleet) {
			store.upsertSession(s);
			store.forceStatus(s.execution_id, "failed", "2026-07-09 21:30:00", "x");
		}
		const seed = (claimed: string[]) =>
			store.setServerLossEpisode("tmux-server-lost:1000", {
				shape: "server_down",
				claimed,
				ticketDone: true,
				notifiedLeads: [],
				failedLeads: [],
				notifyAttempts: {},
			});
		const ids = fleet.map((s) => s.execution_id);
		seed(ids);
		await makeCoordinator({ sessions: [], probe: "unknown" }).check();
		// The crash-replay window: CommDB committed but the StateStore
		// checkpoint was LOST — a fresh process re-runs the delivery. It must
		// go out under the SAME downstream identity so the sink dedups it.
		seed(ids);
		await makeCoordinator({ sessions: [], probe: "unknown" }).check();
		expect(notifications).toHaveLength(2);
		expect(notifications[0]!.dedupeId).toBeDefined();
		expect(notifications[0]!.dedupeId).toBe(notifications[1]!.dedupeId);
		expect(notifications[0]!.dedupeId).toContain("tmux-server-lost:1000");
		expect(notifications[0]!.dedupeId).toContain("tadashi");
		// A CHANGED casualty list (extension delta) is a genuinely new message
		// → different identity, never swallowed by the old one.
		const extra = session(9, "tadashi");
		store.upsertSession(extra);
		store.forceStatus("exec-9", "failed", "2026-07-09 21:30:00", "x");
		seed([...ids, "exec-9"]);
		await makeCoordinator({ sessions: [], probe: "unknown" }).check();
		expect(notifications).toHaveLength(3);
		expect(notifications[2]!.dedupeId).not.toBe(notifications[0]!.dedupeId);
	});
});
