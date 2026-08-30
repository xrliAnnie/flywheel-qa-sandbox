import {
	type PatrolTurnJudgmentSnapshot,
	patrolJudgmentFingerprint,
} from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { describe, expect, it, vi } from "vitest";
import { formatPatrolTick, type HookPayload } from "../bridge/hook-payload.js";
import { enqueueLeadEvent as enqueueDurableLeadEvent } from "../bridge/lead-event-queue.js";
import { leadEventEnvelopeFromJournalRow } from "../bridge/legacy-lead-event-reconciler.js";
import {
	createLeadPatrolTickPass,
	type PatrolTickDeps,
	patrolSessionKey,
	patrolTickOffsetMs,
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
	let roster = input?.roster ?? [session()];
	const store = {
		getPatrolRosterSessions: vi.fn(() => roster),
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
		setRoster: (value: Session[]) => {
			roster = value;
		},
	};
}

function payload(row: LeadEventRow): HookPayload {
	return JSON.parse(row.payload) as HookPayload;
}

function deliveryId(row: LeadEventRow): string {
	return `lead_event:${row.lead_id}:${row.event_id}`;
}

function scheduledAtOrBefore(
	nowMs: number,
	leadId: string,
	intervalMs: number,
): number {
	const offsetMs = patrolTickOffsetMs(leadId, intervalMs);
	return Math.floor((nowMs - offsetMs) / intervalMs) * intervalMs + offsetMs;
}

describe("FLY-1687/FLY-1771 Lead patrol tick pass", () => {
	it("maps each Lead to a deterministic offset inside the configured interval", () => {
		const intervalMs = 60 * 60_000;
		const engOffset = patrolTickOffsetMs("eng-lead", intervalMs);
		expect(engOffset).toBe(2_002_707);
		expect(patrolTickOffsetMs("qa-lead", intervalMs)).toBe(3_447_123);
		expect(patrolTickOffsetMs("eng-lead", intervalMs)).toBe(engOffset);
		expect(engOffset).toBeGreaterThanOrEqual(0);
		expect(engOffset).toBeLessThan(intervalMs);
		expect(patrolTickOffsetMs("qa-lead", intervalMs)).not.toBe(engOffset);
	});

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
			generated_at: "2026-08-13T12:00:00.000Z",
			scheduled_at: new Date(
				scheduledAtOrBefore(
					Date.parse("2026-08-13T12:00:00.000Z"),
					"eng-lead",
					10 * 60_000,
				),
			).toISOString(),
			roster: [
				{ identifier: "FLY-1", sessionRole: "implement", status: "running" },
			],
		});

		const quiet = harness({ roster: [] });
		await createLeadPatrolTickPass(quiet.deps)();
		expect(quiet.rows).toHaveLength(0);
	});

	it("keeps every steady-state tick on the wall-clock slot with no missed or duplicate slot", async () => {
		const intervalMs = 60 * 60_000;
		const offsetMs = patrolTickOffsetMs("eng-lead", intervalMs);
		const startMs = Date.parse("2026-08-13T00:00:00.000Z") + offsetMs;
		const h = harness({ nowMs: startMs });
		h.deps.getProjectConfig = () => ({ interval_minutes: 60 });
		const pass = createLeadPatrolTickPass(h.deps);
		const settlementLagMinutes = [1, 2, 3, 4, 5];

		await pass();
		let settledRows = 0;
		for (let minute = 1; minute <= 12 * 60; minute += 1) {
			while (settledRows < h.rows.length) {
				const row = h.rows[settledRows]!;
				const generatedAt = Date.parse(payload(row).generated_at!);
				const lagMinutes =
					settlementLagMinutes[settledRows % settlementLagMinutes.length]!;
				h.settlements.set(deliveryId(row), {
					kind: "live",
					state: "ACKED",
					settledAt: new Date(generatedAt + lagMinutes * 60_000).toISOString(),
				});
				settledRows += 1;
			}
			h.setNow(startMs + minute * 60_000);
			await pass();
		}

		const steadyState = h.rows.slice(1).map(payload);
		expect(steadyState).toHaveLength(12);
		const scheduled = steadyState.map((event) =>
			Date.parse(event.scheduled_at!),
		);
		for (let index = 0; index < steadyState.length; index += 1) {
			const event = steadyState[index]!;
			const scheduledAt = scheduled[index]!;
			const generatedAt = Date.parse(event.generated_at!);
			expect(scheduledAt % intervalMs).toBe(offsetMs);
			expect(generatedAt - scheduledAt).toBeGreaterThanOrEqual(0);
			expect(generatedAt - scheduledAt).toBeLessThanOrEqual(60_000);
			if (index > 0) {
				expect(scheduledAt - scheduled[index - 1]!).toBe(intervalMs);
			}
		}
	});

	it("fires different Leads at their own stable wall-clock phases", async () => {
		const intervalMs = 60 * 60_000;
		const baseMs = Date.parse("2026-08-13T00:00:00.000Z");
		const runLead = async (leadId: string, label: string) => {
			const offsetMs = patrolTickOffsetMs(leadId, intervalMs);
			const h = harness({
				nowMs: baseMs + offsetMs,
				roster: [session({ issue_labels: JSON.stringify([label]) })],
			});
			h.deps.projects = [
				{
					...project,
					leads: [
						{
							agentId: leadId,
							chatChannel: leadId,
							match: { labels: [label] },
						},
					],
				},
			];
			h.deps.getProjectConfig = () => ({ interval_minutes: 60 });
			const pass = createLeadPatrolTickPass(h.deps);
			await pass();
			h.settlements.set(deliveryId(h.rows[0]!), {
				kind: "live",
				state: "ACKED",
				settledAt: new Date(baseMs + offsetMs + 60_000).toISOString(),
			});
			h.setNow(baseMs + offsetMs + intervalMs);
			await pass();
			return payload(h.rows[1]!);
		};

		const eng = await runLead("eng-lead", "Engineering");
		const qa = await runLead("qa-lead", "QA");
		expect(eng.generated_at).toBe(eng.scheduled_at);
		expect(qa.generated_at).toBe(qa.scheduled_at);
		expect(eng.scheduled_at).not.toBe(qa.scheduled_at);
		expect(Date.parse(eng.scheduled_at!) % intervalMs).toBe(
			patrolTickOffsetMs("eng-lead", intervalMs),
		);
		expect(Date.parse(qa.scheduled_at!) % intervalMs).toBe(
			patrolTickOffsetMs("qa-lead", intervalMs),
		);
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

	it("caps live rows at one, then returns a late settlement to the next wall-clock slot", async () => {
		const intervalMs = 60 * 60_000;
		const startMs =
			Date.parse("2026-08-13T02:00:00.000Z") +
			patrolTickOffsetMs("eng-lead", intervalMs);
		const h = harness({ nowMs: startMs });
		h.deps.getProjectConfig = () => ({ interval_minutes: 60 });
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const firstDeliveryId = deliveryId(h.rows[0]!);

		for (const state of ["QUEUED", "LEASED"] as const) {
			h.settlements.set(firstDeliveryId, {
				kind: "live",
				state,
				settledAt: null,
			});
			await pass();
			expect(h.rows).toHaveLength(1);
		}

		h.settlements.set(firstDeliveryId, {
			kind: "live",
			state: "ACKED",
			settledAt: new Date(startMs + 3 * intervalMs + 3 * 60_000).toISOString(),
		});
		h.setNow(startMs + 3 * intervalMs + 4 * 60_000);
		await pass();
		expect(h.rows).toHaveLength(1);

		h.setNow(startMs + 4 * intervalMs);
		await pass();
		expect(h.rows).toHaveLength(2);
		expect(payload(h.rows[1]!)).toMatchObject({
			scheduled_at: new Date(startMs + 4 * intervalMs).toISOString(),
			generated_at: new Date(startMs + 4 * intervalMs).toISOString(),
		});
	});

	it("does not double-fire within one rider minute when settlement lands just before a Lead phase", async () => {
		const intervalMs = 60 * 60_000;
		const startMs =
			Date.parse("2026-08-13T02:00:00.000Z") +
			patrolTickOffsetMs("eng-lead", intervalMs);
		const h = harness({ nowMs: startMs });
		h.deps.getProjectConfig = () => ({ interval_minutes: 60 });
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const nextScheduledAt = startMs + intervalMs;
		h.settlements.set(deliveryId(h.rows[0]!), {
			kind: "live",
			state: "ACKED",
			settledAt: new Date(nextScheduledAt - 30_000).toISOString(),
		});

		h.setNow(nextScheduledAt);
		await pass();
		expect(h.rows).toHaveLength(1);

		h.setNow(nextScheduledAt + 60_000);
		await pass();
		expect(payload(h.rows[1]!)).toMatchObject({
			scheduled_at: new Date(nextScheduledAt).toISOString(),
			generated_at: new Date(nextScheduledAt + 60_000).toISOString(),
		});
	});

	it("treats a live DEAD row as settled instead of wedging the chain", async () => {
		const intervalMs = 10 * 60_000;
		const startMs =
			Date.parse("2026-08-13T12:00:00.000Z") +
			patrolTickOffsetMs("eng-lead", intervalMs);
		const h = harness({ nowMs: startMs });
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const first = h.rows[0]!;
		h.settlements.set(deliveryId(first), {
			kind: "live",
			state: "DEAD",
			// CommDB timestamps use SQLite UTC text without a zone suffix.
			settledAt: new Date(startMs + 7 * 60_000)
				.toISOString()
				.replace("T", " ")
				.replace("Z", ""),
		});
		h.setNow(startMs + 9 * 60_000);
		await pass();
		expect(h.rows).toHaveLength(1);
		h.setNow(startMs + intervalMs);
		await pass();
		expect(h.rows).toHaveLength(2);
	});

	it("falls back to legacy generated_at and hot-reads shorter and longer slots", async () => {
		const intervalMs = 60 * 60_000;
		const startMs =
			Date.parse("2026-08-13T02:00:00.000Z") +
			patrolTickOffsetMs("eng-lead", intervalMs);
		const h = harness({ nowMs: startMs });
		h.deps.getProjectConfig = () => ({ interval_minutes: 60 });
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const first = h.rows[0]!;
		const legacy = payload(first);
		delete legacy.scheduled_at;
		first.payload = JSON.stringify(legacy);
		h.settlements.set(deliveryId(first), {
			kind: "live",
			state: "ACKED",
			settledAt: new Date(startMs + 3 * 60_000).toISOString(),
		});

		h.setNow(startMs + intervalMs);
		await pass();
		expect(payload(h.rows[1]!)).toMatchObject({
			scheduled_at: new Date(startMs + intervalMs).toISOString(),
		});

		const second = h.rows[1]!;
		h.settlements.set(deliveryId(second), {
			kind: "live",
			state: "ACKED",
			settledAt: new Date(startMs + intervalMs + 2 * 60_000).toISOString(),
		});
		const longerIntervalMs = 120 * 60_000;
		const longerDueAt =
			scheduledAtOrBefore(startMs + intervalMs, "eng-lead", longerIntervalMs) +
			longerIntervalMs;
		h.deps.getProjectConfig = () => ({ interval_minutes: 120 });
		h.setNow(longerDueAt - 1);
		await pass();
		expect(h.rows).toHaveLength(2);
		h.setNow(longerDueAt);
		await pass();
		expect(payload(h.rows[2]!)).toMatchObject({
			scheduled_at: new Date(longerDueAt).toISOString(),
		});

		const shorter = harness({ nowMs: startMs });
		shorter.deps.getProjectConfig = () => ({ interval_minutes: 60 });
		const shorterPass = createLeadPatrolTickPass(shorter.deps);
		await shorterPass();
		shorter.settlements.set(deliveryId(shorter.rows[0]!), {
			kind: "live",
			state: "ACKED",
			settledAt: new Date(startMs + 3 * 60_000).toISOString(),
		});
		shorter.deps.getProjectConfig = () => ({ interval_minutes: 30 });
		shorter.setNow(startMs + 40 * 60_000);
		await shorterPass();
		expect(payload(shorter.rows[1]!)).toMatchObject({
			scheduled_at: new Date(startMs + 30 * 60_000).toISOString(),
			generated_at: new Date(startMs + 40 * 60_000).toISOString(),
		});
	});

	it("catches up once after a mid-slot restart or roster re-entry, then returns to the boundary", async () => {
		const intervalMs = 60 * 60_000;
		const startMs =
			Date.parse("2026-08-13T02:00:00.000Z") +
			patrolTickOffsetMs("eng-lead", intervalMs);
		const h = harness({ nowMs: startMs });
		h.deps.getProjectConfig = () => ({ interval_minutes: 60 });
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		h.settlements.set(deliveryId(h.rows[0]!), {
			kind: "live",
			state: "ACKED",
			settledAt: new Date(startMs + 3 * 60_000).toISOString(),
		});
		h.setRoster([]);
		h.setNow(startMs + 3 * intervalMs);
		await pass();
		expect(h.rows).toHaveLength(1);

		h.setRoster([session()]);
		h.setNow(startMs + 3 * intervalMs + 30 * 60_000);
		await pass();
		expect(payload(h.rows[1]!)).toMatchObject({
			scheduled_at: new Date(startMs + 3 * intervalMs).toISOString(),
			generated_at: new Date(
				startMs + 3 * intervalMs + 30 * 60_000,
			).toISOString(),
		});
		h.settlements.set(deliveryId(h.rows[1]!), {
			kind: "live",
			state: "ACKED",
			settledAt: new Date(startMs + 3 * intervalMs + 33 * 60_000).toISOString(),
		});
		h.setNow(startMs + 4 * intervalMs);
		await pass();
		expect(payload(h.rows[2]!)).toMatchObject({
			scheduled_at: new Date(startMs + 4 * intervalMs).toISOString(),
			generated_at: new Date(startMs + 4 * intervalMs).toISOString(),
		});
	});

	it("fails loud when a settled patrol payload has no valid scheduling basis", async () => {
		const h = harness();
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const first = h.rows[0]!;
		first.payload = JSON.stringify({
			event_type: "patrol_tick",
			execution_id: patrolSessionKey("foo_bar", "eng-lead"),
			issue_id: "",
		});
		h.settlements.set(deliveryId(first), {
			kind: "live",
			state: "ACKED",
			settledAt: "2026-08-13T10:00:00.000Z",
		});

		await pass();
		await pass();
		await pass();
		expect(h.rows).toHaveLength(1);
		expect(h.alerts).toEqual([
			expect.objectContaining({
				kind: "lead_failure",
				detail: "patrol_tick payload lacks scheduled_at/generated_at",
			}),
		]);
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
		h.setNow(Date.parse("2026-08-13T12:10:00.000Z"));
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

	it("does not double mint when the current wall-clock slot has a torn identity", async () => {
		const intervalMs = 10 * 60_000;
		const startMs =
			Date.parse("2026-08-13T12:00:00.000Z") +
			patrolTickOffsetMs("eng-lead", intervalMs);
		const h = harness({ nowMs: startMs });
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		h.settlements.set(deliveryId(h.rows[0]!), { kind: "torn_identity" });

		await pass();
		await pass();
		await pass();
		await pass();

		expect(h.rows).toHaveLength(1);
		expect(h.enqueued).toHaveLength(1);
		expect(h.alerts).toEqual([]);
	});

	it("advances an old torn slot with a fresh journal and delivery identity", async () => {
		const intervalMs = 10 * 60_000;
		const startMs =
			Date.parse("2026-08-13T12:00:00.000Z") +
			patrolTickOffsetMs("eng-lead", intervalMs);
		const h = harness({ nowMs: startMs });
		const inspect = vi.fn(
			(_projectName: string, id: string) =>
				h.settlements.get(id) ?? { kind: "absent_identity" as const },
		);
		h.deps.inspectDeliveryState = inspect;
		const pass = createLeadPatrolTickPass(h.deps);
		await pass();
		const first = h.rows[0]!;
		const poisonedDeliveryId = deliveryId(first);
		h.settlements.set(poisonedDeliveryId, { kind: "torn_identity" });

		h.setNow(startMs + intervalMs);
		await pass();
		expect(h.rows).toHaveLength(2);
		expect(h.enqueued).toEqual([first, h.rows[1]]);
		expect(h.rows[1]!.event_id).toBe(
			`patrol_tick:foo_bar:eng-lead:after-${first.seq}`,
		);
		expect(h.deps.log).toHaveBeenCalledWith(
			expect.stringContaining(`torn delivery=${poisonedDeliveryId}`),
		);

		const freshDeliveryId = deliveryId(h.rows[1]!);
		h.settlements.set(freshDeliveryId, {
			kind: "live",
			state: "QUEUED",
			settledAt: null,
		});
		await pass();
		expect(h.rows).toHaveLength(2);
		expect(
			inspect.mock.calls.filter(([, id]) => id === poisonedDeliveryId),
		).toHaveLength(1);
		expect(inspect).toHaveBeenLastCalledWith("foo_bar", freshDeliveryId);
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

	it("collects one Lead loop snapshot only on the branch that mints a tick", async () => {
		const h = harness();
		const firstSeenAt = Date.parse("2026-08-13T11:29:00.000Z");
		const judgment: PatrolTurnJudgmentSnapshot = {
			available: true,
			turns: new Map([
				[
					"issue-1",
					{
						issueId: "issue-1",
						holderExecId: "holder-exec",
						phase: "qa",
						epoch: 3,
						targetRunId: "run-1",
						targetNodeId: "qa",
						targetAttempt: 1,
						activationId: "activation-holder",
					},
				],
			]),
			waits: new Map([
				[
					"12345678-aaaa-bbbb-cccc-123456789012",
					[
						{
							executionId: "12345678-aaaa-bbbb-cccc-123456789012",
							holderExecId: "holder-exec",
							epoch: 3,
							firstSeenAt,
						},
					],
				],
			]),
			wakes: new Map(),
		};
		const close = vi.fn();
		const reader = {
			readPatrolTurnSnapshot: vi.fn(() => ({
				judgment,
				display: { available: true as const, declared: new Map() },
			})),
			rereadJudgmentFingerprint: vi.fn(
				(issueId: string, executionIds: string[]) => ({
					available: true as const,
					fingerprint: patrolJudgmentFingerprint(
						judgment,
						issueId,
						executionIds,
					),
				}),
			),
			close,
		};
		const openCommReadonly = vi.fn(() => reader);
		const probeProcessLiveness = vi.fn(async (executionId: string) =>
			executionId === "holder-exec" ? ("dead" as const) : ("alive" as const),
		);
		Object.assign(h.deps, { openCommReadonly, probeProcessLiveness });
		Object.assign(h.deps.store, {
			getPatrolWorkflowRuns: vi.fn(() => [
				{
					runId: "run-1",
					status: "active",
					currentNodeId: "implement",
				},
			]),
			listActiveNodeAttempts: vi.fn(() => []),
			getLatestNodeAttempt: vi.fn(() => ({
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				state: "done",
				executionId: "12345678-aaaa-bbbb-cccc-123456789012",
			})),
			listOpenReworkDeliveries: vi.fn(() => []),
			listOpenLandOperations: vi.fn(() => []),
			listOpenGateAuthorities: vi.fn(() => []),
			getSession: vi.fn(() => undefined),
		});
		const pass = createLeadPatrolTickPass(h.deps);

		await pass();
		expect(openCommReadonly).toHaveBeenCalledTimes(1);
		expect(reader.readPatrolTurnSnapshot).toHaveBeenCalledWith({
			issueIds: ["issue-1"],
			executionIds: ["12345678-aaaa-bbbb-cccc-123456789012"],
			nowMs: Date.parse("2026-08-13T12:00:00.000Z"),
		});
		expect(payload(h.rows[0]!).loops).toEqual([
			expect.objectContaining({
				issueId: "issue-1",
				identifier: "FLY-1",
				currentNode: "implement",
				currentAttempt: 2,
				turnHolderExecId8: "holder-e",
				light: "red",
				redCause: { kind: "holder_process_dead" },
			}),
		]);
		expect(probeProcessLiveness).toHaveBeenCalledWith(
			"12345678-aaaa-bbbb-cccc-123456789012",
			"foo_bar",
		);
		expect(probeProcessLiveness).toHaveBeenCalledWith("holder-exec", "foo_bar");
		expect(close).toHaveBeenCalledTimes(1);

		await pass();
		expect(openCommReadonly).toHaveBeenCalledTimes(1);
	});

	it("scopes each minted snapshot to that Lead's roster", async () => {
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
		h.deps.projects = [
			{
				...project,
				leads: [
					...project.leads,
					{
						agentId: "ops-lead",
						chatChannel: "ops",
						match: { labels: ["Operations"] },
					},
				],
			},
		];
		const snapshotInputs: Array<{
			issueIds: string[];
			executionIds: string[];
			nowMs: number;
		}> = [];
		const emptyJudgment: PatrolTurnJudgmentSnapshot = {
			available: true,
			turns: new Map(),
			waits: new Map(),
			wakes: new Map(),
		};
		Object.assign(h.deps, {
			openCommReadonly: () => ({
				readPatrolTurnSnapshot: (input: (typeof snapshotInputs)[number]) => {
					snapshotInputs.push(input);
					return {
						judgment: emptyJudgment,
						display: { available: true as const, declared: new Map() },
					};
				},
				rereadJudgmentFingerprint: (
					issueId: string,
					executionIds: string[],
				) => ({
					available: true as const,
					fingerprint: patrolJudgmentFingerprint(
						emptyJudgment,
						issueId,
						executionIds,
					),
				}),
				close: () => undefined,
			}),
		});
		Object.assign(h.deps.store, {
			getPatrolWorkflowRuns: () => [],
			listActiveNodeAttempts: () => [],
			getLatestNodeAttempt: () => undefined,
			listOpenReworkDeliveries: () => [],
			listOpenLandOperations: () => [],
			listOpenGateAuthorities: () => [],
			getSession: () => undefined,
		});

		await createLeadPatrolTickPass(h.deps)();
		expect(snapshotInputs).toEqual([
			{
				issueIds: ["issue-1"],
				executionIds: ["12345678-aaaa-bbbb-cccc-123456789012"],
				nowMs: Date.parse("2026-08-13T12:00:00.000Z"),
			},
			{
				issueIds: ["issue-2"],
				executionIds: ["87654321-bbbb"],
				nowMs: Date.parse("2026-08-13T12:00:00.000Z"),
			},
		]);
	});

	it.each([
		{
			name: "an unavailable comm database",
			open: () => null,
			reason: "ledger_unreadable:comm_db",
		},
		{
			name: "an unexpected collector failure",
			open: () => {
				throw new Error("broken reader");
			},
			reason: "ledger_unreadable:collector",
		},
	])("keeps the roster minting through $name", async ({ open, reason }) => {
		const h = harness();
		Object.assign(h.deps, { openCommReadonly: open });
		await createLeadPatrolTickPass(h.deps)();
		expect(payload(h.rows[0]!).roster).toHaveLength(1);
		expect(payload(h.rows[0]!).loops).toEqual([
			expect.objectContaining({
				issueId: "issue-1",
				light: "unknown",
				unknownReason: reason,
			}),
		]);
	});
});
