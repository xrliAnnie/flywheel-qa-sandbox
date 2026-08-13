import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { describe, expect, it, vi } from "vitest";
import { formatPatrolTick } from "../bridge/hook-payload.js";
import { enqueueLeadEvent as enqueueDurableLeadEvent } from "../bridge/lead-event-queue.js";
import { leadEventEnvelopeFromJournalRow } from "../bridge/legacy-lead-event-reconciler.js";
import {
	createLeadPatrolTickPass,
	type PatrolTickDeps,
	patrolSessionKey,
} from "../bridge/patrol-tick.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { LeadEventRow, Session, StateStore } from "../StateStore.js";

const project: ProjectEntry = {
	projectName: "foo_bar",
	projectRoot: "/mainline/foo_bar",
	leads: [
		{
			agentId: "eng-lead",
			chatChannel: "eng",
			match: { labels: ["Engineering"] },
		},
	],
};

function session(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "12345678-aaaa-bbbb-cccc-123456789012",
		issue_id: "issue-1",
		issue_identifier: "FLY-1",
		project_name: project.projectName,
		status: "running",
		session_role: "implement",
		issue_labels: '["Engineering"]',
		...overrides,
	};
}

function harness(input?: { roster?: Session[]; nowMs?: number }) {
	const rows: LeadEventRow[] = [];
	const enqueued: LeadEventRow[] = [];
	const alerts: Parameters<NonNullable<PatrolTickDeps["alertFailure"]>>[0][] =
		[];
	const settlements = new Map<
		string,
		ReturnType<PatrolTickDeps["inspectDeliveryState"]>
	>();
	let nowMs = input?.nowMs ?? Date.parse("2026-08-13T12:00:00.000Z");
	const store = {
		getPatrolRosterSessions: vi.fn(() => input?.roster ?? [session()]),
		getLatestPatrolTickEvent: vi.fn(
			(leadId: string, sessionKey: string) =>
				[...rows]
					.reverse()
					.find(
						(row) => row.lead_id === leadId && row.session_key === sessionKey,
					) ?? null,
		),
		appendLeadEvent: vi.fn(
			(
				leadId: string,
				eventId: string,
				eventType: string,
				payload: string,
				sessionKey: string,
			) => {
				const existing = rows.find(
					(row) => row.lead_id === leadId && row.event_id === eventId,
				);
				if (existing) return existing.seq;
				const row: LeadEventRow = {
					seq: rows.length + 1,
					lead_id: leadId,
					event_id: eventId,
					event_type: eventType,
					payload,
					session_key: sessionKey,
					created_at: new Date(nowMs).toISOString(),
				};
				rows.push(row);
				return row.seq;
			},
		),
		getLeadEventBySeq: vi.fn(
			(seq: number) => rows.find((row) => row.seq === seq) ?? null,
		),
	} as unknown as StateStore;
	const deps: PatrolTickDeps = {
		projects: [project],
		store,
		now: () => nowMs,
		getGlobalConfig: () => ({ interval_minutes: 60 }),
		getProjectConfig: () => ({ interval_minutes: 10 }),
		inspectDeliveryState: (_projectName, deliveryId) =>
			settlements.get(deliveryId) ?? { kind: "absent_identity" },
		enqueueLeadEvent: (envelope) => {
			const row = rows.find((candidate) => candidate.seq === envelope.seq);
			if (!row) throw new Error("missing journal row");
			enqueued.push(row);
			return {
				queued: true,
				deliveryId: `lead_event:${envelope.leadId}:${envelope.eventId}`,
				seq: envelope.seq,
			};
		},
		alertFailure: async (failure) => {
			alerts.push(failure);
		},
		log: vi.fn(),
	};
	return {
		deps,
		rows,
		enqueued,
		alerts,
		settlements,
		setNow: (value: number) => {
			nowMs = value;
		},
	};
}

describe("FLY-1687 Lead patrol tick pass", () => {
	it("emits genesis only when a Lead has a non-terminal roster", async () => {
		const h = harness();
		await createLeadPatrolTickPass(h.deps)();
		expect(h.rows).toHaveLength(1);
		expect(h.enqueued).toHaveLength(1);
		expect(h.rows[0]).toMatchObject({
			event_type: "patrol_tick",
			session_key: patrolSessionKey("foo_bar", "eng-lead"),
			event_id: "patrol_tick:foo_bar:eng-lead:after-genesis",
		});
		expect(JSON.parse(h.rows[0]!.payload)).toMatchObject({
			event_type: "patrol_tick",
			project_name: "foo_bar",
			roster: [
				{ identifier: "FLY-1", sessionRole: "implement", status: "running" },
			],
		});

		const quiet = harness({ roster: [] });
		await createLeadPatrolTickPass(quiet.deps)();
		expect(quiet.rows).toHaveLength(0);
	});

	it("keeps an idle Lead silent when another Lead in the project has runners", async () => {
		const h = harness();
		h.deps.projects = [
			{
				...project,
				leads: [
					...project.leads,
					{
						agentId: "qa-lead",
						chatChannel: "qa",
						match: { labels: ["QA"] },
					},
				],
			},
		];

		await createLeadPatrolTickPass(h.deps)();

		expect(h.rows.map((row) => row.lead_id)).toEqual(["eng-lead"]);
	});

	it("alerts instead of silently losing fallback sessions owned by a non-spawning Lead", async () => {
		const h = harness({
			roster: [
				session({
					execution_id: "cos-fallback",
					issue_identifier: "FLY-0",
					issue_labels: "[]",
				}),
				session(),
			],
		});
		h.deps.projects = [
			{
				...project,
				leads: [
					{
						agentId: "cos-lead",
						chatChannel: "cos",
						match: { labels: ["CoS"] },
						canSpawnRunners: false,
					},
					...project.leads,
				],
			},
		];

		await createLeadPatrolTickPass(h.deps)();

		expect(h.rows.map((row) => row.lead_id)).toEqual(["eng-lead"]);
		expect(h.alerts).toEqual([
			expect.objectContaining({
				kind: "unowned_roster",
				projectName: "foo_bar",
				leadId: "eng-lead",
				detail: expect.stringContaining("cos-fallback"),
			}),
		]);
		const firstEpisode = h.alerts[0]!.episodeId;
		await createLeadPatrolTickPass(h.deps)();
		expect(h.alerts[1]!.episodeId).toBe(firstEpisode);
		h.setNow(Date.parse("2026-08-13T12:30:00.000Z"));
		await createLeadPatrolTickPass(h.deps)();
		expect(h.alerts[2]!.episodeId).not.toBe(firstEpisode);
	});

	it("uses fleet attribution when a project has no patrol-capable Lead", async () => {
		const h = harness({
			roster: [session({ issue_labels: "[]" })],
		});
		h.deps.projects = [
			{
				...project,
				leads: [
					{
						agentId: "companion-lead",
						chatChannel: "companion",
						match: { labels: [] },
						canSpawnRunners: false,
						companion: true,
					},
				],
			},
		];

		await createLeadPatrolTickPass(h.deps)();

		expect(h.rows).toHaveLength(0);
		expect(h.alerts[0]).toMatchObject({
			kind: "unowned_roster",
			leadId: null,
			projectName: "foo_bar",
		});
	});

	it("caps live QUEUED/LEASED at one and anchors ACKED/DEAD cadence to settlement time", async () => {
		const h = harness();
		h.deps.getProjectConfig = () => ({ interval_minutes: 60 });
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const deliveryId = `lead_event:eng-lead:${h.rows[0]!.event_id}`;

		for (const state of ["QUEUED", "LEASED"] as const) {
			h.settlements.set(deliveryId, { kind: "live", state, settledAt: null });
			await pass();
			expect(h.rows).toHaveLength(1);
		}

		const settledAt = "2026-08-13T12:00:00.000Z";
		h.settlements.set(deliveryId, {
			kind: "live",
			state: "ACKED",
			settledAt,
		});
		h.setNow(Date.parse(settledAt) + 10 * 60_000);
		await pass();
		expect(h.rows).toHaveLength(1);
		// The next decision hot-reads the changed interval without recreating pass.
		h.deps.getProjectConfig = () => ({ interval_minutes: 10 });
		await pass();
		expect(h.rows).toHaveLength(2);
		expect(h.rows[1]!.event_id).toBe(
			`patrol_tick:foo_bar:eng-lead:after-${h.rows[0]!.seq}`,
		);
	});

	it("treats a live DEAD row as settled instead of wedging the chain", async () => {
		const h = harness();
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const first = h.rows[0]!;
		h.settlements.set(`lead_event:eng-lead:${first.event_id}`, {
			kind: "live",
			state: "DEAD",
			// CommDB timestamps use SQLite UTC text without a zone suffix.
			settledAt: "2026-08-13 10:00:00",
		});
		await pass();
		expect(h.rows).toHaveLength(2);
	});

	it("redrives a true append/enqueue gap but treats archived terminal rows as settled", async () => {
		const h = harness();
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const first = h.rows[0]!;
		const deliveryId = `lead_event:eng-lead:${first.event_id}`;
		h.enqueued.length = 0;
		await pass();
		expect(h.rows).toHaveLength(1);
		expect(h.enqueued).toEqual([first]);

		h.enqueued.length = 0;
		h.settlements.set(deliveryId, {
			kind: "archived_terminal",
			state: "DEAD",
			settledAt: "2026-08-13T10:00:00.000Z",
		});
		await pass();
		expect(h.rows).toHaveLength(2);
		expect(h.enqueued).toEqual([h.rows[1]]);
	});

	it("is single-flight and converges concurrent producers on the durable journal winner", async () => {
		const h = harness();
		const pass = createLeadPatrolTickPass(h.deps);
		const first = pass();
		const second = pass();
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(h.rows).toHaveLength(1);
		expect(h.enqueued).toHaveLength(1);
	});

	it("makes two unguarded producers converge on the journal winner byte-for-byte", async () => {
		const h = harness();
		const sharedStore = h.deps.store;
		const alwaysGenesis = () => null;
		const firstDeps: PatrolTickDeps = {
			...h.deps,
			store: {
				...sharedStore,
				getLatestPatrolTickEvent: alwaysGenesis,
				getPatrolRosterSessions: () => [session()],
			} as PatrolTickDeps["store"],
			now: () => Date.parse("2026-08-13T12:00:00.000Z"),
		};
		const secondDeps: PatrolTickDeps = {
			...h.deps,
			store: {
				...sharedStore,
				getLatestPatrolTickEvent: alwaysGenesis,
				getPatrolRosterSessions: () => [
					session({
						execution_id: "99999999-bbbb",
						issue_id: "issue-loser",
						issue_identifier: "FLY-LOSER",
					}),
				],
			} as PatrolTickDeps["store"],
			now: () => Date.parse("2026-08-13T13:00:00.000Z"),
		};

		await Promise.all([
			createLeadPatrolTickPass(firstDeps)(),
			createLeadPatrolTickPass(secondDeps)(),
		]);
		expect(h.rows).toHaveLength(1);
		expect(h.enqueued).toHaveLength(2);
		expect(h.enqueued[0]).toBe(h.rows[0]);
		expect(h.enqueued[1]).toBe(h.rows[0]);
		expect(h.enqueued[0]!.payload).toBe(h.enqueued[1]!.payload);
	});

	it("replays the durable winner twice through a real MailboxQueue without projection conflict", async () => {
		const h = harness();
		await createLeadPatrolTickPass(h.deps)();
		const envelope = leadEventEnvelopeFromJournalRow(h.rows[0]!, 2);
		const queue = new MailboxQueue(":memory:");
		try {
			const enqueue = () =>
				enqueueDurableLeadEvent({
					queue,
					envelope,
					content: formatPatrolTick(envelope),
				});
			expect(enqueue).not.toThrow();
			expect(enqueue).not.toThrow();
		} finally {
			queue.close();
		}
	});

	it("isolates one lead failure from the rest of the fleet", async () => {
		const twoLeadProject: ProjectEntry = {
			...project,
			leads: [
				...project.leads,
				{
					agentId: "ops-lead",
					chatChannel: "ops",
					match: { labels: ["Operations"] },
				},
			],
		};
		const h = harness({
			roster: [
				session(),
				session({
					execution_id: "87654321-bbbb",
					issue_id: "issue-2",
					issue_identifier: "FLY-2",
					issue_labels: '["Operations"]',
				}),
			],
		});
		h.deps.projects = [twoLeadProject];
		const projectConfig = vi.fn(() => ({ interval_minutes: 10 }));
		h.deps.getProjectConfig = projectConfig;
		h.deps.inspectDeliveryState = (_projectName, deliveryId) => {
			if (deliveryId.includes("eng-lead")) throw new Error("broken queue");
			return { kind: "absent_identity" };
		};
		// Seed prior journal events so both paths consult settlement.
		for (const leadId of ["eng-lead", "ops-lead"]) {
			(h.deps.store as StateStore).appendLeadEvent(
				leadId,
				`patrol_tick:foo_bar:${leadId}:after-genesis`,
				"patrol_tick",
				JSON.stringify({
					event_type: "patrol_tick",
					execution_id: `patrol:foo_bar:${leadId}`,
					issue_id: "",
				}),
				patrolSessionKey("foo_bar", leadId),
			);
		}
		h.enqueued.length = 0;
		await createLeadPatrolTickPass(h.deps)();
		expect(h.deps.log).toHaveBeenCalledWith(
			expect.stringContaining("eng-lead"),
		);
		expect(h.enqueued.some((row) => row.lead_id === "ops-lead")).toBe(true);
		expect(projectConfig).toHaveBeenCalledTimes(1);
	});

	it("alerts once after three consecutive failures and rearms after recovery", async () => {
		const h = harness();
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const deliveryId = `lead_event:eng-lead:${h.rows[0]!.event_id}`;
		const broken = vi.fn(() => {
			throw new Error("broken settlement");
		});
		h.deps.inspectDeliveryState = broken;
		await pass();
		await pass();
		expect(h.alerts).toHaveLength(0);
		await pass();
		expect(h.alerts).toEqual([
			expect.objectContaining({
				kind: "lead_failure",
				leadId: "eng-lead",
				detail: "broken settlement",
			}),
		]);
		await pass();
		expect(h.alerts).toHaveLength(1);

		h.deps.inspectDeliveryState = () => ({
			kind: "live",
			state: "QUEUED",
			settledAt: null,
		});
		await pass();
		h.deps.inspectDeliveryState = broken;
		await pass();
		await pass();
		await pass();
		expect(h.alerts).toHaveLength(1);

		h.setNow(Date.parse("2026-08-13T12:30:00.000Z"));
		await pass();
		expect(h.alerts).toHaveLength(2);
		expect(broken).toHaveBeenCalled();
		expect(deliveryId).toContain("eng-lead");
	});
});
