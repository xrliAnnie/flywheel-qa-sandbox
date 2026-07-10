/**
 * FLY-1082 (Task 2.3): the server-loss coordinator — ONE episode, exactly one
 * migration per runner, one grouped notification per Lead (the incident shape:
 * 3 Leads / 13 runners), boot fresh-server aggregation, and honest
 * needs_human evidence when a Lead notification fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
	let notifications: Array<{ leadId: string; content: string }>;

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
			notifyLead: async (leadId, content) => {
				notifications.push({ leadId, content });
				return opts.notifyOk ? opts.notifyOk(leadId) : true;
			},
			alert: async (p): Promise<AlertResult> => {
				alerts.push(p);
				return { sent: true };
			},
			currentWatermark: () => "90.4%",
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
		expect(tadashi!.content).toContain("90.4%");
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

	it("failed Lead notification → leadsFailed in metadata (drives needs_human escalation)", async () => {
		const coordinator = makeCoordinator({
			sessions: incidentFleet(),
			probe: "down",
			notifyOk: (leadId) => leadId !== "peter",
		});
		await coordinator.check();
		expect(alerts[0]!.metadata?.tmuxServerLost).toEqual({
			migrated: 13,
			leadsNotified: 2,
			leadsFailed: 1,
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
});
