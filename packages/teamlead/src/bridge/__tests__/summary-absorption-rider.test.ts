import { summaryDeliveryBranch } from "flywheel-comm/summary-contract";
import { describe, expect, it, vi } from "vitest";
import { type LeadEventRow, StateStore } from "../../StateStore.js";
import {
	createSummaryAbsorptionPass,
	summaryAbsorptionRoundId,
} from "../summary-absorption-rider.js";
import { SummaryPresentationController } from "../summary-presentation-controller.js";

function harness(options: { now?: number; cadences?: number[] } = {}) {
	const now = options.now ?? 190_000;
	const cadences = [...(options.cadences ?? [60_000])];
	const rows = new Map<string, LeadEventRow>();
	let seq = 0;
	for (const slotStartMs of [0, 120_000]) {
		const slotStart = new Date(slotStartMs).toISOString();
		const eventId = `summary_due:flywheel/reflection-lead:${slotStart}`;
		rows.set(eventId, {
			seq: ++seq,
			lead_id: "reflection-lead",
			event_id: eventId,
			event_type: "summary_due",
			payload: JSON.stringify({
				event_type: "summary_due",
				execution_id: eventId,
				issue_id: "FLY-2382",
				project_name: "flywheel",
				summary_due: {
					slot_start: slotStart,
					cadence_ms: 60_000,
					period: `slot-${slotStartMs}`,
					last_delivered: { status: "none" },
					command_hint: "ignored",
				},
			}),
			session_key: "summary-due",
			created_at: "2026-08-29 01:00:00",
		} as LeadEventRow);
	}
	const appendLeadEvent = vi.fn(
		(
			leadId: string,
			eventId: string,
			eventType: string,
			payload: string,
			sessionKey?: string,
		) => {
			const existing = rows.get(eventId);
			if (existing) return existing.seq;
			const row = {
				seq: ++seq,
				lead_id: leadId,
				event_id: eventId,
				event_type: eventType,
				payload,
				session_key: sessionKey ?? "summary-absorption",
				created_at: "2026-08-29 01:00:00",
			} as LeadEventRow;
			rows.set(eventId, row);
			return row.seq;
		},
	);
	const getLeadEventBySeq = vi.fn(
		(target: number) =>
			[...rows.values()].find((row) => row.seq === target) ?? null,
	);
	const enqueueLeadEvent = vi.fn(() => ({
		queued: true as const,
		deliveryId: "delivery",
		seq,
	}));
	const pass = createSummaryAbsorptionPass({
		projects: [
			{
				projectName: "flywheel",
				projectRoot: "/tmp/flywheel",
				leads: [{ agentId: "raya", summaryRole: "recipient" }],
			} as never,
		],
		store: {
			appendLeadEvent,
			getLeadEventBySeq,
			appendSummaryDueRows: vi.fn(),
			listSummaryDueRows: vi.fn((slotStart: string) =>
				[...rows.values()].filter(
					(row) =>
						row.event_type === "summary_due" &&
						row.event_id.endsWith(`:${slotStart}`),
				),
			),
			getLeadEventByLeadAndId: vi.fn((leadId: string, eventId: string) => {
				const row = rows.get(eventId);
				return row?.lead_id === leadId ? row : null;
			}),
			tryClaimLeadEvent: vi.fn(
				(
					leadId: string,
					eventId: string,
					eventType: string,
					payload: string,
					sessionKey?: string,
				) => {
					if (rows.has(eventId)) return false;
					appendLeadEvent(leadId, eventId, eventType, payload, sessionKey);
					return true;
				},
			),
		},
		enqueueLeadEvent,
		inspectDeliveryState: vi.fn(() => ({
			kind: "archived_terminal" as const,
			state: "ACKED" as const,
			settledAt: "2026-08-29T01:01:00.000Z",
			deadReason: null,
			lastError: null,
			createdAt: "2026-08-29T01:00:00.000Z",
			deliveredAt: "2026-08-29T01:00:01.000Z",
			notifiedAt: null,
		})),
		readSummaryGranularity: vi.fn(() => ({
			state: "selected" as const,
			granularity: "per-lead" as const,
			setBy: "founder",
			setAt: "2026-09-06T00:00:00Z",
		})),
		listSummaryPulls: vi.fn(async () => ({
			status: "unavailable" as const,
			reason: "fixture ledger unavailable",
		})),
		alertFailure: vi.fn(async () => undefined),
		cadenceMs: () => cadences.shift() ?? 60_000,
		now: () => now,
		log: vi.fn(),
	});
	return { appendLeadEvent, enqueueLeadEvent, pass, rows };
}

describe("FLY-2131 summary absorption GatePoller rider", () => {
	it("materializes and enqueues the producer roster during the first beat even without Raya", async () => {
		const rows: LeadEventRow[] = [];
		const enqueueLeadEvent = vi.fn(() => ({
			queued: true as const,
			deliveryId: "delivery",
			seq: rows.length,
		}));
		const pass = createSummaryAbsorptionPass({
			projects: [
				{
					projectName: "growth",
					projectRoot: "/tmp/growth",
					leads: [{ agentId: "reflection-lead", summaryRole: "producer" }],
				} as never,
			],
			store: {
				appendLeadEvent: vi.fn(),
				getLeadEventBySeq: vi.fn((target: number) =>
					rows.find((row) => row.seq === target),
				),
				appendSummaryDueRows: vi.fn((dueRows) => {
					for (const due of dueRows) {
						rows.push({
							seq: rows.length + 1,
							lead_id: due.leadId,
							event_id: due.eventId,
							event_type: "summary_due",
							payload: due.payload,
							session_key: "summary-due",
							created_at: "2026-09-06 16:00:00",
						} as LeadEventRow);
					}
				}),
				listSummaryDueRows: vi.fn((slotStart: string) =>
					rows.filter((row) => row.event_id.endsWith(`:${slotStart}`)),
				),
				getLeadEventByLeadAndId: vi.fn(() => null),
				tryClaimLeadEvent: vi.fn(() => true),
			},
			enqueueLeadEvent,
			inspectDeliveryState: vi.fn(() => ({ kind: "absent_identity" as const })),
			readSummaryGranularity: vi.fn(() => ({
				state: "selected" as const,
				granularity: "per-lead" as const,
				setBy: "founder",
				setAt: "2026-09-06T00:00:00Z",
			})),
			listSummaryPulls: vi.fn(async () => ({
				status: "ok" as const,
				pulls: [],
			})),
			alertFailure: vi.fn(async () => undefined),
			cadenceMs: () => 60_000,
			now: () => 190_000,
			log: vi.fn(),
		});

		await pass();

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			lead_id: "reflection-lead",
			event_id: "summary_due:growth/reflection-lead:1970-01-01T00:03:00.000Z",
			event_type: "summary_due",
		});
		expect(JSON.parse(rows[0]!.payload)).toMatchObject({
			event_type: "summary_due",
			issue_id: "FLY-2382",
			project_name: "growth",
			summary_due: {
				slot_start: "1970-01-01T00:03:00.000Z",
				cadence_ms: 60_000,
				last_delivered: { status: "none" },
			},
		});
		expect(JSON.parse(rows[0]!.payload).summary_due).not.toHaveProperty(
			"activity",
		);
		expect(enqueueLeadEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "summary_due:growth/reflection-lead:1970-01-01T00:03:00.000Z",
				leadId: "reflection-lead",
			}),
		);
	});

	it("baselines once, skips a quiet slot, and resumes after a business event", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const cadenceMs = 60_000;
			const firstSlotMs = Date.parse("2026-09-16T00:00:00.000Z");
			let nowMs = firstSlotMs + 10_000;
			let mailboxUnavailable = false;
			let mailboxCount = 0;
			let mailboxAllocatedSeq = 0;
			const enqueueLeadEvent = vi.fn(() => ({
				queued: true as const,
				deliveryId: "delivery",
				seq: 1,
			}));
			const readMailboxActivity = vi.fn(async () => {
				if (mailboxUnavailable) throw new Error("comm db unavailable");
				return {
					count: mailboxCount,
					allocatedSeq: mailboxAllocatedSeq,
					instance: {
						schema_generation: "v1",
						completed_at: "2026-09-15T00:00:00.000Z",
					},
				};
			});
			const readLinearActivity = vi.fn(async () => ({
				status: "not_bound" as const,
				count: 0 as const,
			}));
			const pass = createSummaryAbsorptionPass({
				projects: [
					{
						projectName: "growth",
						projectRoot: "/tmp/growth",
						leads: [
							{
								agentId: "reflection-lead",
								summaryRole: "producer",
								botUserId: "producer-bot",
							},
							{
								agentId: "raya",
								summaryRole: "recipient",
								botUserId: "raya-bot",
							},
						],
					} as never,
				],
				store,
				enqueueLeadEvent,
				inspectDeliveryState: vi.fn(() => ({
					kind: "absent_identity" as const,
				})),
				readSummaryGranularity: vi.fn(() => ({
					state: "selected" as const,
					granularity: "per-lead" as const,
					setBy: "founder",
					setAt: "2026-09-15T00:00:00.000Z",
				})),
				listSummaryPulls: vi.fn(async () => ({
					status: "ok" as const,
					pulls: [],
				})),
				activityGateEnabled: () => true,
				readMailboxActivity,
				readLinearActivity,
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => cadenceMs,
				now: () => nowMs,
			});

			await pass();
			const firstSlot = new Date(firstSlotMs).toISOString();
			const firstDue = store.listSummaryDueRows(firstSlot);
			expect(firstDue).toHaveLength(1);
			expect(JSON.parse(firstDue[0]!.payload)).toMatchObject({
				summary_due: {
					activity: {
						verdict: "unknown",
						sources: {
							lead_events: {
								status: "unavailable",
								reason: "no_previous_decision",
							},
							mailbox: {
								status: "unavailable",
								reason: "no_previous_cursor",
							},
						},
					},
				},
			});
			store.db.run("UPDATE lead_events SET created_at=? WHERE seq=?", [
				new Date(nowMs).toISOString(),
				firstDue[0]!.seq,
			]);

			nowMs += cadenceMs;
			await pass();
			const quietSlot = new Date(firstSlotMs + cadenceMs).toISOString();
			const skipped = store.listSummaryDueSkippedRows(quietSlot);
			expect(skipped).toHaveLength(1);
			expect(JSON.parse(skipped[0]!.payload)).toMatchObject({
				event_type: "summary_due_skipped",
				issue_id: "FLY-2634",
				summary_due_skipped: {
					activity: { verdict: "quiet" },
				},
			});
			expect(
				enqueueLeadEvent.mock.calls.filter(
					([envelope]) => envelope.event.event_type === "summary_due",
				),
			).toHaveLength(1);
			store.db.run("UPDATE lead_events SET created_at=? WHERE seq=?", [
				new Date(nowMs).toISOString(),
				skipped[0]!.seq,
			]);

			for (let quietIndex = 2; quietIndex <= 12; quietIndex++) {
				nowMs = firstSlotMs + quietIndex * cadenceMs + 10_000;
				await pass();
				const quietRows = store.listSummaryDueSkippedRows(
					new Date(firstSlotMs + quietIndex * cadenceMs).toISOString(),
				);
				expect(quietRows, `quiet slot ${quietIndex}`).toHaveLength(1);
				store.db.run("UPDATE lead_events SET created_at=? WHERE seq=?", [
					new Date(nowMs).toISOString(),
					quietRows[0]!.seq,
				]);
			}
			expect(
				store.db.exec(
					"SELECT COUNT(*) AS count FROM lead_events WHERE event_type='summary_due_skipped'",
				)[0]?.values[0]?.[0],
			).toBe(12);

			const businessSeq = store.appendLeadEvent(
				"reflection-lead",
				"business-after-quiet",
				"runner_question",
				"{}",
			);
			store.db.run("UPDATE lead_events SET created_at=? WHERE seq=?", [
				new Date(firstSlotMs + 12 * cadenceMs + 30_000).toISOString(),
				businessSeq,
			]);
			nowMs = firstSlotMs + 13 * cadenceMs + 10_000;
			await pass();
			const activeSlot = new Date(firstSlotMs + 13 * cadenceMs).toISOString();
			const activeDue = store.listSummaryDueRows(activeSlot);
			expect(activeDue).toHaveLength(1);
			expect(JSON.parse(activeDue[0]!.payload)).toMatchObject({
				summary_due: {
					activity: {
						verdict: "active",
						sources: { lead_events: { status: "ok", count: 1 } },
					},
				},
			});
			const frozenQuiet = store.getLeadEventByLeadAndId(
				"summary-clock",
				`summary_slot_settled:${quietSlot}`,
			);
			expect(JSON.parse(frozenQuiet!.payload)).toMatchObject({
				raya_round: "not_issued",
				not_issued_reason: "nothing_to_read",
				skipped_count: 1,
				producer_count: 0,
			});
			expect(
				store.getLeadEventByLeadAndId(
					"raya",
					summaryAbsorptionRoundId(firstSlotMs + cadenceMs),
				),
			).toBeNull();

			mailboxUnavailable = true;
			nowMs += cadenceMs;
			await pass();
			const unavailableSlot = new Date(
				firstSlotMs + 14 * cadenceMs,
			).toISOString();
			const unavailableDue = store.listSummaryDueRows(unavailableSlot);
			expect(unavailableDue).toHaveLength(1);
			expect(JSON.parse(unavailableDue[0]!.payload)).toMatchObject({
				summary_due: {
					activity: {
						verdict: "unknown",
						sources: {
							mailbox: {
								status: "unavailable",
								reason: "comm db unavailable",
							},
						},
						cursors: { mailbox: { allocated_seq: 0 } },
					},
				},
			});

			mailboxUnavailable = false;
			mailboxCount = 1;
			mailboxAllocatedSeq = 1;
			nowMs += cadenceMs;
			await pass();
			const founderRequestSlot = new Date(
				firstSlotMs + 15 * cadenceMs,
			).toISOString();
			const founderRequestDue = store.listSummaryDueRows(founderRequestSlot);
			expect(founderRequestDue).toHaveLength(1);
			expect(JSON.parse(founderRequestDue[0]!.payload)).toMatchObject({
				summary_due: {
					activity: {
						verdict: "active",
						sources: { mailbox: { status: "ok", count: 1 } },
					},
				},
			});

			mailboxCount = 0;
			nowMs += cadenceMs;
			await pass();
			const postRequestQuietSlot = new Date(
				firstSlotMs + 16 * cadenceMs,
			).toISOString();
			expect(
				store.listSummaryDueSkippedRows(postRequestQuietSlot),
			).toHaveLength(1);
			expect(readLinearActivity).toHaveBeenCalledTimes(17);
		} finally {
			store.close();
		}
	});

	it("G7 never enqueues skipped decisions across a replayed slot sequence", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const cadenceMs = 60_000;
			const firstSlotMs = Date.parse("2026-09-16T00:00:00.000Z");
			let nowMs = firstSlotMs + 10_000;
			const enqueueLeadEvent = vi.fn(() => ({
				queued: true as const,
				deliveryId: "delivery",
				seq: 1,
			}));
			const pass = createSummaryAbsorptionPass({
				projects: [
					{
						projectName: "growth",
						projectRoot: "/tmp/growth",
						leads: [
							{
								agentId: "reflection-lead",
								summaryRole: "producer",
								botUserId: "producer-bot",
							},
							{
								agentId: "raya",
								summaryRole: "recipient",
								botUserId: "raya-bot",
							},
						],
					} as never,
				],
				store,
				enqueueLeadEvent,
				inspectDeliveryState: vi.fn(() => ({
					kind: "absent_identity" as const,
				})),
				readSummaryGranularity: vi.fn(() => ({
					state: "selected" as const,
					granularity: "per-lead" as const,
					setBy: "founder",
					setAt: "2026-09-15T00:00:00.000Z",
				})),
				listSummaryPulls: vi.fn(async () => ({
					status: "ok" as const,
					pulls: [],
				})),
				activityGateEnabled: () => true,
				readMailboxActivity: vi.fn(async () => ({
					count: 0,
					allocatedSeq: 0,
					instance: {
						schema_generation: "v1",
						completed_at: "2026-09-15T00:00:00.000Z",
					},
				})),
				readLinearActivity: vi.fn(async () => ({
					status: "not_bound" as const,
					count: 0 as const,
				})),
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => cadenceMs,
				now: () => nowMs,
			});

			const decisionTypes: string[] = [];
			const stampDecision = (slotMs: number) => {
				const slotStart = new Date(slotMs).toISOString();
				const decisions = [
					...store.listSummaryDueRows(slotStart),
					...store.listSummaryDueSkippedRows(slotStart),
				];
				expect(decisions, `decision for ${slotStart}`).toHaveLength(1);
				store.db.run("UPDATE lead_events SET created_at=? WHERE seq=?", [
					new Date(nowMs).toISOString(),
					decisions[0]!.seq,
				]);
				decisionTypes.push(decisions[0]!.event_type);
			};

			await pass();
			stampDecision(firstSlotMs);
			for (let slotIndex = 1; slotIndex <= 3; slotIndex++) {
				nowMs = firstSlotMs + slotIndex * cadenceMs + 10_000;
				await pass();
				stampDecision(firstSlotMs + slotIndex * cadenceMs);
			}

			const businessSeq = store.appendLeadEvent(
				"reflection-lead",
				"g7-business-change",
				"runner_question",
				"{}",
			);
			store.db.run("UPDATE lead_events SET created_at=? WHERE seq=?", [
				new Date(firstSlotMs + 3 * cadenceMs + 30_000).toISOString(),
				businessSeq,
			]);
			nowMs = firstSlotMs + 4 * cadenceMs + 10_000;
			await pass();
			stampDecision(firstSlotMs + 4 * cadenceMs);

			nowMs = firstSlotMs + 5 * cadenceMs + 10_000;
			await pass();
			stampDecision(firstSlotMs + 5 * cadenceMs);

			expect(decisionTypes).toEqual([
				"summary_due",
				"summary_due_skipped",
				"summary_due_skipped",
				"summary_due_skipped",
				"summary_due",
				"summary_due_skipped",
			]);
			expect(
				enqueueLeadEvent.mock.calls
					.filter(([envelope]) => envelope.leadId === "reflection-lead")
					.map(([envelope]) => envelope.event.event_type),
			).toEqual(["summary_due", "summary_due"]);
		} finally {
			store.close();
		}
	});

	it("shares one Linear probe across producers in the same project", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const readLinearActivity = vi.fn(async () => ({
				status: "not_bound" as const,
				count: 0 as const,
			}));
			const readMailboxActivity = vi.fn(async () => ({
				count: 0,
				allocatedSeq: 0,
				instance: {
					schema_generation: "v1",
					completed_at: "born",
				},
			}));
			const pass = createSummaryAbsorptionPass({
				projects: [
					{
						projectName: "growth",
						projectRoot: "/tmp/growth",
						leads: [
							{
								agentId: "alpha",
								summaryRole: "producer",
								botUserId: "alpha-bot",
							},
							{
								agentId: "beta",
								summaryRole: "producer",
							},
							{
								agentId: "raya",
								summaryRole: "recipient",
								botUserId: "raya-bot",
							},
						],
					} as never,
				],
				store,
				enqueueLeadEvent: vi.fn(() => ({
					queued: true as const,
					deliveryId: "delivery",
					seq: 1,
				})),
				inspectDeliveryState: vi.fn(() => ({
					kind: "absent_identity" as const,
				})),
				readSummaryGranularity: vi.fn(() => ({
					state: "selected" as const,
					granularity: "per-lead" as const,
					setBy: "founder",
					setAt: "2026-09-15T00:00:00.000Z",
				})),
				listSummaryPulls: vi.fn(async () => ({
					status: "ok" as const,
					pulls: [],
				})),
				activityGateEnabled: () => true,
				readMailboxActivity,
				readLinearActivity,
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => 60_000,
				now: () => Date.parse("2026-09-16T00:00:10.000Z"),
			});

			await pass();
			expect(readLinearActivity).toHaveBeenCalledTimes(1);
			expect(readMailboxActivity).toHaveBeenCalledTimes(1);
			const dueRows = store.listSummaryDueRows("2026-09-16T00:00:00.000Z");
			expect(dueRows).toHaveLength(2);
			expect(
				JSON.parse(dueRows.find((row) => row.lead_id === "beta")!.payload),
			).toMatchObject({
				summary_due: {
					activity: {
						verdict: "unknown",
						sources: {
							mailbox: {
								status: "unavailable",
								reason: "producer_bot_id_missing",
							},
						},
					},
				},
			});
		} finally {
			store.close();
		}
	});

	it("skips a first-seen slot after grace and logs that cold-start gap once", async () => {
		const appendSummaryDueRows = vi.fn();
		const log = vi.fn();
		const pass = createSummaryAbsorptionPass({
			projects: [
				{
					projectName: "growth",
					projectRoot: "/tmp/growth",
					leads: [{ agentId: "reflection-lead", summaryRole: "producer" }],
				} as never,
			],
			store: {
				appendLeadEvent: vi.fn(),
				getLeadEventBySeq: vi.fn(),
				appendSummaryDueRows,
				listSummaryDueRows: vi.fn(() => []),
				getLeadEventByLeadAndId: vi.fn(() => null),
				tryClaimLeadEvent: vi.fn(() => true),
			},
			enqueueLeadEvent: vi.fn(() => ({
				queued: true as const,
				deliveryId: "delivery",
				seq: 1,
			})),
			inspectDeliveryState: vi.fn(() => ({ kind: "absent_identity" as const })),
			readSummaryGranularity: vi.fn(() => ({
				state: "selected" as const,
				granularity: "per-lead" as const,
				setBy: "founder",
				setAt: "2026-09-06T00:00:00Z",
			})),
			listSummaryPulls: vi.fn(async () => ({
				status: "ok" as const,
				pulls: [],
			})),
			alertFailure: vi.fn(async () => undefined),
			cadenceMs: () => 2 * 60 * 60_000,
			now: () => 31 * 60_000,
			log,
		});

		await pass();
		await pass();

		expect(appendSummaryDueRows).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("first observed after grace"),
		);
	});

	it("freezes an acknowledged missing summary without waking Raya", async () => {
		const rows: LeadEventRow[] = [];
		let seq = 0;
		const appendLeadEvent = vi.fn(
			(
				leadId: string,
				eventId: string,
				eventType: string,
				payload: string,
				sessionKey?: string,
			) => {
				const existing = rows.find(
					(row) => row.lead_id === leadId && row.event_id === eventId,
				);
				if (existing) return existing.seq;
				const row = {
					seq: ++seq,
					lead_id: leadId,
					event_id: eventId,
					event_type: eventType,
					payload,
					session_key: sessionKey ?? null,
					created_at: "2026-09-06 16:00:00",
				} as LeadEventRow;
				rows.push(row);
				return row.seq;
			},
		);
		const previousSlot = "1970-01-01T00:03:00.000Z";
		appendLeadEvent(
			"reflection-lead",
			`summary_due:growth/reflection-lead:${previousSlot}`,
			"summary_due",
			JSON.stringify({
				event_type: "summary_due",
				execution_id: `summary_due:growth/reflection-lead:${previousSlot}`,
				issue_id: "FLY-2382",
				project_name: "growth",
				summary_due: {
					slot_start: previousSlot,
					cadence_ms: 60_000,
					period: "1969-12-31T16:02:00-08:00/1969-12-31T16:03:00-08:00",
					last_delivered: { status: "none" },
					command_hint: "ignored",
				},
			}),
			"summary-due",
		);
		const enqueueLeadEvent = vi.fn(() => ({
			queued: true as const,
			deliveryId: "delivery",
			seq,
		}));
		const store = {
			appendLeadEvent,
			getLeadEventBySeq: vi.fn(
				(target: number) => rows.find((row) => row.seq === target) ?? null,
			),
			appendSummaryDueRows: vi.fn((dueRows) => {
				for (const due of dueRows) {
					appendLeadEvent(
						due.leadId,
						due.eventId,
						"summary_due",
						due.payload,
						"summary-due",
					);
				}
			}),
			listSummaryDueRows: vi.fn((slotStart: string) =>
				rows.filter(
					(row) =>
						row.event_type === "summary_due" &&
						row.event_id.endsWith(`:${slotStart}`),
				),
			),
			getLeadEventByLeadAndId: vi.fn(
				(leadId: string, eventId: string) =>
					rows.find(
						(row) => row.lead_id === leadId && row.event_id === eventId,
					) ?? null,
			),
			tryClaimLeadEvent: vi.fn(
				(
					leadId: string,
					eventId: string,
					eventType: string,
					payload: string,
					sessionKey?: string,
				) => {
					if (
						rows.some(
							(row) => row.lead_id === leadId && row.event_id === eventId,
						)
					) {
						return false;
					}
					appendLeadEvent(leadId, eventId, eventType, payload, sessionKey);
					return true;
				},
			),
		};
		const pass = createSummaryAbsorptionPass({
			projects: [
				{
					projectName: "growth",
					projectRoot: "/tmp/growth",
					leads: [
						{ agentId: "reflection-lead", summaryRole: "producer" },
						{ agentId: "raya", summaryRole: "recipient" },
					],
				} as never,
			],
			store,
			enqueueLeadEvent,
			inspectDeliveryState: vi.fn((_, deliveryId: string) =>
				deliveryId.includes(previousSlot)
					? {
							kind: "archived_terminal" as const,
							state: "ACKED" as const,
							settledAt: "1970-01-01T00:03:30.000Z",
							deadReason: null,
							lastError: null,
							createdAt: "1970-01-01T00:03:00.000Z",
							deliveredAt: "1970-01-01T00:03:01.000Z",
							notifiedAt: null,
						}
					: { kind: "absent_identity" as const },
			),
			readSummaryGranularity: vi.fn(() => ({
				state: "selected" as const,
				granularity: "per-lead" as const,
				setBy: "founder",
				setAt: "2026-09-06T00:00:00Z",
			})),
			listSummaryPulls: vi.fn(async () => ({
				status: "ok" as const,
				pulls: [],
			})),
			alertFailure: vi.fn(async () => undefined),
			cadenceMs: () => 60_000,
			now: () => 240_000,
			log: vi.fn(),
		});

		await pass();

		const frozen = store.getLeadEventByLeadAndId(
			"summary-clock",
			`summary_slot_settled:${previousSlot}`,
		);
		expect(frozen).not.toBeNull();
		expect(JSON.parse(frozen!.payload)).toMatchObject({
			round_ledger: "ok",
			raya_round: "not_issued",
			not_issued_reason: "nothing_to_read",
			producer_count: 1,
			delivered_count: 0,
			absent: ["reflection-lead"],
			report_line: "本轮 0/1 份已交;未交:reflection-lead",
		});
		const rayaRound = store.getLeadEventByLeadAndId(
			"raya",
			summaryAbsorptionRoundId(180_000),
		);
		expect(rayaRound).toBeNull();
		expect(
			enqueueLeadEvent.mock.calls.some(
				([envelope]) =>
					envelope.event.event_type === "summary_absorption_round",
			),
		).toBe(false);
	});

	it.each([0, 2_000, 27_999, 29_999, 30_000, 32_000, 57_999, 59_999])(
		"keeps a 60s cadence first beat reachable at phase +%ims",
		async (phaseMs) => {
			const rows: LeadEventRow[] = [];
			const appendSummaryDueRows = vi.fn((dueRows) => {
				for (const due of dueRows) {
					rows.push({
						seq: rows.length + 1,
						lead_id: due.leadId,
						event_id: due.eventId,
						event_type: "summary_due",
						payload: due.payload,
						session_key: "summary-due",
						created_at: "2026-09-06 16:00:00",
					} as LeadEventRow);
				}
			});
			const pass = createSummaryAbsorptionPass({
				projects: [
					{
						projectName: "growth",
						projectRoot: "/tmp/growth",
						leads: [{ agentId: "reflection-lead", summaryRole: "producer" }],
					} as never,
				],
				store: {
					appendLeadEvent: vi.fn(),
					getLeadEventBySeq: vi.fn(
						(target: number) => rows.find((row) => row.seq === target) ?? null,
					),
					appendSummaryDueRows,
					listSummaryDueRows: vi.fn((slotStart: string) =>
						rows.filter((row) => row.event_id.endsWith(`:${slotStart}`)),
					),
					getLeadEventByLeadAndId: vi.fn(() => null),
					tryClaimLeadEvent: vi.fn(() => true),
				},
				enqueueLeadEvent: vi.fn(() => ({
					queued: true as const,
					deliveryId: "delivery",
					seq: 1,
				})),
				inspectDeliveryState: vi.fn(() => ({
					kind: "absent_identity" as const,
				})),
				readSummaryGranularity: vi.fn(() => ({
					state: "selected" as const,
					granularity: "per-lead" as const,
					setBy: "founder",
					setAt: "2026-09-06T00:00:00Z",
				})),
				listSummaryPulls: vi.fn(async () => ({
					status: "ok" as const,
					pulls: [],
				})),
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => 60_000,
				now: () => 600_000 + phaseMs,
				log: vi.fn(),
			});

			await pass();

			expect(appendSummaryDueRows).toHaveBeenCalledTimes(1);
			expect(rows[0]?.event_id).toContain("1970-01-01T00:10:00.000Z");
		},
	);

	it("freezes and alerts undelivered producers without Raya, isolating alert failure", async () => {
		const slotStart = "1970-01-01T00:03:00.000Z";
		const dueEventId = `summary_due:growth/reflection-lead:${slotStart}`;
		const rows: LeadEventRow[] = [
			{
				seq: 1,
				lead_id: "reflection-lead",
				event_id: dueEventId,
				event_type: "summary_due",
				payload: JSON.stringify({
					event_type: "summary_due",
					execution_id: dueEventId,
					issue_id: "FLY-2382",
					project_name: "growth",
					summary_due: {
						slot_start: slotStart,
						cadence_ms: 60_000,
						period: "1969-12-31T16:02:00-08:00/1969-12-31T16:03:00-08:00",
						last_delivered: { status: "none" },
						command_hint: "ignored",
					},
				}),
				session_key: "summary-due",
				created_at: "2026-09-06 16:00:00",
			} as LeadEventRow,
		];
		const appendLeadEvent = vi.fn(
			(
				leadId: string,
				eventId: string,
				eventType: string,
				payload: string,
				sessionKey?: string,
			) => {
				const row = {
					seq: rows.length + 1,
					lead_id: leadId,
					event_id: eventId,
					event_type: eventType,
					payload,
					session_key: sessionKey ?? null,
					created_at: "2026-09-06 16:01:00",
				} as LeadEventRow;
				rows.push(row);
				return row.seq;
			},
		);
		const getExact = (leadId: string, eventId: string) =>
			rows.find((row) => row.lead_id === leadId && row.event_id === eventId) ??
			null;
		const alertFailure = vi.fn(async () => {
			throw new Error("alert sink down");
		});
		const log = vi.fn();
		const pass = createSummaryAbsorptionPass({
			projects: [],
			store: {
				appendLeadEvent,
				getLeadEventBySeq: vi.fn(
					(target: number) => rows.find((row) => row.seq === target) ?? null,
				),
				appendSummaryDueRows: vi.fn(),
				listSummaryDueRows: vi.fn((target: string) =>
					rows.filter(
						(row) =>
							row.event_type === "summary_due" &&
							row.event_id.endsWith(`:${target}`),
					),
				),
				getLeadEventByLeadAndId: vi.fn(getExact),
				tryClaimLeadEvent: vi.fn(
					(
						leadId: string,
						eventId: string,
						eventType: string,
						payload: string,
						sessionKey?: string,
					) => {
						if (getExact(leadId, eventId)) return false;
						appendLeadEvent(leadId, eventId, eventType, payload, sessionKey);
						return true;
					},
				),
			},
			enqueueLeadEvent: vi.fn(() => ({
				queued: true as const,
				deliveryId: "delivery",
				seq: 1,
			})),
			inspectDeliveryState: vi.fn(() => ({ kind: "absent_identity" as const })),
			readSummaryGranularity: vi.fn(() => ({ state: "unselected" as const })),
			listSummaryPulls: vi.fn(async () => ({
				status: "ok" as const,
				pulls: [],
			})),
			alertFailure,
			cadenceMs: () => 60_000,
			now: () => 240_000,
			log,
		});

		await expect(pass()).resolves.toBeUndefined();
		await expect(pass()).resolves.toBeUndefined();

		expect(
			getExact("summary-clock", `summary_slot_settled:${slotStart}`),
		).not.toBeNull();
		expect(alertFailure).toHaveBeenCalledTimes(2);
		expect(alertFailure).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				leadId: "raya-summary",
				projectName: "machine",
				eventId: expect.stringMatching(/^summary-alert:[a-f0-9]{20}$/),
				eventType: "inbox_loop_stalled",
				title: "进展收集出现送达问题",
				body: expect.stringContaining("工程侧正在处理"),
				severity: "warning",
			}),
		);
		const visibleAlert = JSON.stringify(alertFailure.mock.calls[0]?.[0]);
		expect(visibleAlert).not.toContain(slotStart);
		expect(visibleAlert).not.toContain("0/1");
		expect(visibleAlert).not.toContain("reflection-lead");
		expect(visibleAlert).not.toContain("undelivered");
		expect(alertFailure.mock.calls[1]?.[0].eventId).toBe(
			alertFailure.mock.calls[0]?.[0].eventId,
		);
		expect(
			log.mock.calls
				.flat()
				.filter((value) => String(value).includes("DEGRADED")),
		).toHaveLength(1);
		expect(log.mock.calls.flat().join("\n")).toContain("DEGRADED");
		expect(log.mock.calls.flat().join("\n")).toContain("alert sink down");
	});

	it("uses a fresh settlement snapshot so a PR opened during grace counts", async () => {
		const rows: LeadEventRow[] = [];
		let seq = 0;
		let nowMs = 190_000;
		const ledgerResults: Array<{
			status: "ok";
			pulls: Array<{
				number: number;
				url: string;
				state: "OPEN";
				project: string;
				lead: string;
				headRefName: string;
				createdAt: number;
			}>;
		}> = [{ status: "ok", pulls: [] }];
		const appendLeadEvent = (
			leadId: string,
			eventId: string,
			eventType: string,
			payload: string,
			sessionKey?: string,
		) => {
			const existing = rows.find(
				(row) => row.lead_id === leadId && row.event_id === eventId,
			);
			if (existing) return existing.seq;
			rows.push({
				seq: ++seq,
				lead_id: leadId,
				event_id: eventId,
				event_type: eventType,
				payload,
				session_key: sessionKey ?? null,
				created_at: "2026-09-06 16:00:00",
			} as LeadEventRow);
			return seq;
		};
		const getExact = (leadId: string, eventId: string) =>
			rows.find((row) => row.lead_id === leadId && row.event_id === eventId) ??
			null;
		const listSummaryPulls = vi.fn(
			async () => ledgerResults.shift() ?? { status: "ok" as const, pulls: [] },
		);
		const pass = createSummaryAbsorptionPass({
			projects: [
				{
					projectName: "growth",
					projectRoot: "/tmp/growth",
					leads: [{ agentId: "reflection-lead", summaryRole: "producer" }],
				} as never,
			],
			store: {
				appendLeadEvent: vi.fn(appendLeadEvent),
				getLeadEventBySeq: vi.fn(
					(target: number) => rows.find((row) => row.seq === target) ?? null,
				),
				appendSummaryDueRows: vi.fn((dueRows) => {
					for (const due of dueRows) {
						appendLeadEvent(
							due.leadId,
							due.eventId,
							"summary_due",
							due.payload,
							"summary-due",
						);
					}
				}),
				listSummaryDueRows: vi.fn((slotStart: string) =>
					rows.filter(
						(row) =>
							row.event_type === "summary_due" &&
							row.event_id.endsWith(`:${slotStart}`),
					),
				),
				getLeadEventByLeadAndId: vi.fn(getExact),
				tryClaimLeadEvent: vi.fn(
					(
						leadId: string,
						eventId: string,
						eventType: string,
						payload: string,
						sessionKey?: string,
					) => {
						if (getExact(leadId, eventId)) return false;
						appendLeadEvent(leadId, eventId, eventType, payload, sessionKey);
						return true;
					},
				),
			},
			enqueueLeadEvent: vi.fn(() => ({
				queued: true as const,
				deliveryId: "delivery",
				seq,
			})),
			inspectDeliveryState: vi.fn(() => ({
				kind: "archived_terminal" as const,
				state: "ACKED" as const,
				settledAt: "1970-01-01T00:03:30.000Z",
				deadReason: null,
				lastError: null,
				createdAt: "1970-01-01T00:03:00.000Z",
				deliveredAt: "1970-01-01T00:03:01.000Z",
				notifiedAt: null,
			})),
			readSummaryGranularity: vi.fn(() => ({
				state: "selected" as const,
				granularity: "per-lead" as const,
				setBy: "founder",
				setAt: "2026-09-06T00:00:00Z",
			})),
			listSummaryPulls,
			alertFailure: vi.fn(async () => undefined),
			cadenceMs: () => 60_000,
			now: () => nowMs,
			log: vi.fn(),
		});

		await pass();
		const firstSlot = "1970-01-01T00:03:00.000Z";
		const due = rows.find(
			(row) =>
				row.event_type === "summary_due" &&
				row.event_id.endsWith(`:${firstSlot}`),
		)!;
		const period = JSON.parse(due.payload).summary_due.period as string;
		const headRefName = summaryDeliveryBranch({
			project: "growth",
			author: "reflection-lead",
			period,
		});
		ledgerResults.push(
			{ status: "ok", pulls: [] },
			{
				status: "ok",
				pulls: [
					{
						number: 25,
						url: "https://github.com/xrliAnnie/raya/pull/25",
						state: "OPEN",
						project: "growth",
						lead: "reflection-lead",
						headRefName,
						createdAt: 220_000,
					},
				],
			},
		);
		nowMs = 240_000;
		await pass();

		const frozen = getExact(
			"summary-clock",
			`summary_slot_settled:${firstSlot}`,
		);
		expect(JSON.parse(frozen!.payload)).toMatchObject({
			delivered_count: 1,
			absent: [],
			report_line: "本轮 1/1 份已交。 未读 open PR:1",
		});
		expect(listSummaryPulls).toHaveBeenCalledTimes(3);
	});

	it("issues the next frozen round when an open summary PR arrives after a silent freeze", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const cadenceMs = 60_000;
			const firstSlotMs = 60_000;
			const secondSlotMs = 120_000;
			for (const slotStartMs of [firstSlotMs, secondSlotMs]) {
				const slot = new Date(slotStartMs).toISOString();
				store.appendSummaryDecisionRows(() => [
					{
						leadId: "quiet-lead",
						eventId: `summary_due_skipped:growth/quiet-lead:${slot}`,
						eventType: "summary_due_skipped",
						payload: JSON.stringify({
							event_type: "summary_due_skipped",
							project_name: "growth",
							summary_due_skipped: { period: `period-${slotStartMs}` },
						}),
					},
				]);
			}
			let nowMs = secondSlotMs + 10_000;
			let openUnread = false;
			const pass = createSummaryAbsorptionPass({
				projects: [
					{
						projectName: "raya",
						projectRoot: "/tmp/raya",
						leads: [{ agentId: "raya", summaryRole: "recipient" }],
					} as never,
				],
				store,
				enqueueLeadEvent: vi.fn(() => ({
					queued: true as const,
					deliveryId: "delivery",
					seq: 1,
				})),
				inspectDeliveryState: vi.fn(() => ({
					kind: "absent_identity" as const,
				})),
				readSummaryGranularity: vi.fn(() => ({
					state: "selected" as const,
					granularity: "per-lead" as const,
					setBy: "founder",
					setAt: "1970-01-01T00:00:00.000Z",
				})),
				listSummaryPulls: vi.fn(async () => ({
					status: "ok" as const,
					pulls: openUnread
						? [
								{
									number: 25,
									url: "https://github.com/xrliAnnie/raya/pull/25",
									state: "OPEN" as const,
									project: "growth",
									lead: "quiet-lead",
									headRefName: "summary/growth/quiet-lead/late",
									createdAt: secondSlotMs + 1,
								},
							]
						: [],
				})),
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => cadenceMs,
				now: () => nowMs,
			});

			await pass();
			const firstFrozen = store.getLeadEventByLeadAndId(
				"summary-clock",
				`summary_slot_settled:${new Date(firstSlotMs).toISOString()}`,
			);
			expect(JSON.parse(firstFrozen!.payload)).toMatchObject({
				raya_round: "not_issued",
				open_unread_count: 0,
			});

			openUnread = true;
			nowMs += cadenceMs;
			await pass();
			const secondFrozen = store.getLeadEventByLeadAndId(
				"summary-clock",
				`summary_slot_settled:${new Date(secondSlotMs).toISOString()}`,
			);
			expect(JSON.parse(secondFrozen!.payload)).toMatchObject({
				raya_round: "issued",
				open_unread_count: 1,
			});
			expect(
				store.getLeadEventByLeadAndId(
					"raya",
					summaryAbsorptionRoundId(secondSlotMs),
				),
			).not.toBeNull();
		} finally {
			store.close();
		}
	});

	it("isolates one producer enqueue failure and retries only its absent identity", async () => {
		const rows: LeadEventRow[] = [];
		const queued = new Set<string>();
		let alphaAttempts = 0;
		const enqueueLeadEvent = vi.fn((envelope) => {
			if (envelope.leadId === "alpha-lead" && alphaAttempts++ === 0) {
				throw new Error("alpha renderer failed");
			}
			queued.add(envelope.leadId);
			return {
				queued: true as const,
				deliveryId: `delivery:${envelope.leadId}`,
				seq: envelope.seq,
			};
		});
		const log = vi.fn();
		const pass = createSummaryAbsorptionPass({
			projects: [
				{
					projectName: "growth",
					projectRoot: "/tmp/growth",
					leads: [
						{ agentId: "alpha-lead", summaryRole: "producer" },
						{ agentId: "beta-lead", summaryRole: "producer" },
					],
				} as never,
			],
			store: {
				appendLeadEvent: vi.fn(),
				getLeadEventBySeq: vi.fn(
					(target: number) => rows.find((row) => row.seq === target) ?? null,
				),
				appendSummaryDueRows: vi.fn((dueRows) => {
					for (const due of dueRows) {
						rows.push({
							seq: rows.length + 1,
							lead_id: due.leadId,
							event_id: due.eventId,
							event_type: "summary_due",
							payload: due.payload,
							session_key: "summary-due",
							created_at: "2026-09-06 16:00:00",
						} as LeadEventRow);
					}
				}),
				listSummaryDueRows: vi.fn((slotStart: string) =>
					rows.filter((row) => row.event_id.endsWith(`:${slotStart}`)),
				),
				getLeadEventByLeadAndId: vi.fn(() => null),
				tryClaimLeadEvent: vi.fn(() => true),
			},
			enqueueLeadEvent,
			inspectDeliveryState: vi.fn((_, deliveryId: string) => {
				const leadId = deliveryId.includes(":alpha-lead:")
					? "alpha-lead"
					: "beta-lead";
				return queued.has(leadId)
					? {
							kind: "live" as const,
							state: "QUEUED" as const,
							settledAt: null,
							deadReason: null,
							lastError: null,
							createdAt: "2026-09-06T16:00:00.000Z",
							deliveredAt: null,
							notifiedAt: null,
						}
					: { kind: "absent_identity" as const };
			}),
			readSummaryGranularity: vi.fn(() => ({
				state: "selected" as const,
				granularity: "per-lead" as const,
				setBy: "founder",
				setAt: "2026-09-06T00:00:00Z",
			})),
			listSummaryPulls: vi.fn(async () => ({
				status: "ok" as const,
				pulls: [],
			})),
			alertFailure: vi.fn(async () => undefined),
			cadenceMs: () => 60_000,
			now: () => 190_000,
			log,
		});

		await pass();
		await pass();

		expect(enqueueLeadEvent.mock.calls.map(([env]) => env.leadId)).toEqual([
			"alpha-lead",
			"beta-lead",
			"alpha-lead",
		]);
		expect(log.mock.calls.flat().join("\n")).toContain("alpha renderer failed");
	});

	it("warns every grace pass while granularity remains unselected", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const log = vi.fn();
			const pass = createSummaryAbsorptionPass({
				projects: [
					{
						projectName: "growth",
						projectRoot: "/tmp/growth",
						leads: [{ agentId: "reflection-lead", summaryRole: "producer" }],
					} as never,
				],
				store,
				enqueueLeadEvent: vi.fn(() => ({
					queued: true as const,
					deliveryId: "delivery",
					seq: 1,
				})),
				inspectDeliveryState: vi.fn(() => ({
					kind: "absent_identity" as const,
				})),
				readSummaryGranularity: vi.fn(() => ({
					state: "unselected" as const,
				})),
				listSummaryPulls: vi.fn(async () => ({
					status: "ok" as const,
					pulls: [],
				})),
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => 60_000,
				now: () => 190_000,
				log,
			});

			await pass();
			await pass();

			expect(store.listSummaryDueRows("1970-01-01T00:03:00.000Z")).toEqual([]);
			expect(
				log.mock.calls
					.flat()
					.filter((value) => String(value).includes("roster unavailable")),
			).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	it("contains one slot failure and still settles the other fixed-window slot", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const currentSlot = "1970-01-01T02:00:00.000Z";
			const previousSlot = "1970-01-01T00:00:00.000Z";
			store.appendSummaryDueRows([
				{
					leadId: "broken-lead",
					eventId: `summary_due:growth/broken-lead:${currentSlot}`,
					payload: JSON.stringify({
						event_type: "summary_due",
						project_name: "growth",
						summary_due: {},
					}),
				},
				{
					leadId: "healthy-lead",
					eventId: `summary_due:growth/healthy-lead:${previousSlot}`,
					payload: JSON.stringify({
						event_type: "summary_due",
						project_name: "growth",
						summary_due: {
							period: "1969-12-31T14:00:00-08:00/1969-12-31T16:00:00-08:00",
						},
					}),
				},
			]);
			const log = vi.fn();
			const pass = createSummaryAbsorptionPass({
				projects: [],
				store,
				enqueueLeadEvent: vi.fn(() => ({
					queued: true as const,
					deliveryId: "delivery",
					seq: 1,
				})),
				inspectDeliveryState: vi.fn(() => ({
					kind: "archived_terminal" as const,
					state: "ACKED" as const,
					settledAt: "1970-01-01T02:30:00.000Z",
					deadReason: null,
					lastError: null,
					createdAt: "1970-01-01T00:00:00.000Z",
					deliveredAt: "1970-01-01T00:00:01.000Z",
					notifiedAt: null,
				})),
				readSummaryGranularity: vi.fn(() => ({ state: "unselected" as const })),
				listSummaryPulls: vi.fn(async () => ({
					status: "ok" as const,
					pulls: [],
				})),
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => 2 * 60 * 60_000,
				now: () => 2 * 60 * 60_000 + 31 * 60_000,
				log,
			});

			await expect(pass()).resolves.toBeUndefined();

			expect(
				store.getLeadEventByLeadAndId(
					"summary-clock",
					`summary_slot_settled:${currentSlot}`,
				),
			).toBeNull();
			expect(
				store.getLeadEventByLeadAndId(
					"summary-clock",
					`summary_slot_settled:${previousSlot}`,
				),
			).not.toBeNull();
			expect(log.mock.calls.flat().join("\n")).toContain(
				`invalid summary_due payload: summary_due:growth/broken-lead:${currentSlot}`,
			);
		} finally {
			store.close();
		}
	});

	it("commits both mature slots as one batch before enqueueing either round", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const slots = [60 * 60_000, 2 * 60 * 60_000];
			store.appendSummaryDueRows(
				slots.map((slotStartMs) => {
					const slot = new Date(slotStartMs).toISOString();
					return {
						leadId: "reflection-lead",
						eventId: `summary_due:flywheel/reflection-lead:${slot}`,
						payload: JSON.stringify({
							event_type: "summary_due",
							project_name: "flywheel",
							summary_due: { period: `period-${slot}` },
						}),
					};
				}),
			);
			const appendBatch = vi.spyOn(store, "appendSummaryPresentationRounds");
			const enqueueLeadEvent = vi.fn(() => ({
				queued: true as const,
				deliveryId: "delivery",
				seq: 1,
			}));
			const pass = createSummaryAbsorptionPass({
				projects: [
					{
						projectName: "flywheel",
						projectRoot: "/tmp/flywheel",
						leads: [{ agentId: "raya", summaryRole: "recipient" }],
					} as never,
				],
				store,
				enqueueLeadEvent,
				inspectDeliveryState: vi.fn(() => ({
					kind: "archived_terminal" as const,
					state: "ACKED" as const,
					settledAt: "1970-01-01T00:04:30.000Z",
					deadReason: null,
					lastError: null,
					createdAt: "1970-01-01T00:00:00.000Z",
					deliveredAt: "1970-01-01T00:00:01.000Z",
					notifiedAt: null,
				})),
				readSummaryGranularity: vi.fn(() => ({ state: "unselected" as const })),
				listSummaryPulls: vi.fn(async () => ({
					status: "unavailable" as const,
					reason: "fixture ledger unavailable",
				})),
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => 60 * 60_000,
				now: () => 2 * 60 * 60_000 + 30 * 60_000,
			});

			await pass();

			expect(appendBatch).toHaveBeenCalledTimes(1);
			expect(appendBatch.mock.calls[0]![0]).toHaveLength(2);
			expect(enqueueLeadEvent).toHaveBeenCalledTimes(2);
			for (const slotStartMs of slots) {
				expect(
					store.summaryPresentations.getRound(
						"flywheel",
						"raya",
						summaryAbsorptionRoundId(slotStartMs),
					)?.disposition,
				).toBe("eligible");
			}
		} finally {
			store.close();
		}
	});

	it("settles the configured six-hour cadence without an automatic founder message", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const cadenceMs = 6 * 60 * 60_000;
			const slotStartMs = cadenceMs;
			const slot = new Date(slotStartMs).toISOString();
			store.summaryPresentations.beginMigration({
				projectName: "raya",
				leadId: "raya",
				boundarySeq: 0,
				sourceDigests: { journal: "empty-at-cutover" },
			});
			store.summaryPresentations.completeMigration({
				projectName: "raya",
				leadId: "raya",
				sourceDigests: { journal: "empty-at-cutover" },
			});
			store.appendSummaryDueRows([
				{
					leadId: "producer",
					eventId: `summary_due:raya/producer:${slot}`,
					payload: JSON.stringify({
						event_type: "summary_due",
						project_name: "raya",
						summary_due: { period: "six-hour-fixture" },
					}),
				},
			]);
			const pass = createSummaryAbsorptionPass({
				projects: [
					{
						projectName: "raya",
						projectRoot: "/tmp/raya-isolated",
						leads: [{ agentId: "raya", summaryRole: "recipient" }],
					} as never,
				],
				store,
				enqueueLeadEvent: vi.fn(() => ({
					queued: true as const,
					deliveryId: "backend-only",
					seq: 1,
				})),
				inspectDeliveryState: vi.fn(() => ({
					kind: "archived_terminal" as const,
					state: "ACKED" as const,
					settledAt: new Date(slotStartMs + 1).toISOString(),
					deadReason: null,
					lastError: null,
					createdAt: new Date(slotStartMs).toISOString(),
					deliveredAt: new Date(slotStartMs + 1).toISOString(),
					notifiedAt: null,
				})),
				readSummaryGranularity: vi.fn(() => ({ state: "unselected" as const })),
				listSummaryPulls: vi.fn(async () => ({
					status: "unavailable" as const,
					reason: "fixture ledger unavailable",
				})),
				alertFailure: vi.fn(async () => undefined),
				cadenceMs: () => cadenceMs,
				now: () => cadenceMs * 2 + 30 * 60_000,
			});
			await pass();

			const outbound = { handle: vi.fn() };
			const controller = new SummaryPresentationController({
				store,
				outbound: outbound as never,
				expectedApiToken: "isolated-token",
				canonicalIdentity: {
					projectName: "raya",
					leadId: "raya",
					channelId: "111111111111111111",
				},
			});
			const begun = await controller.handle({
				providedToken: "isolated-token",
				body: { operation: "begin", projectName: "raya", leadId: "raya" },
			});
			const group = begun.body.group as { id: string };
			const members = begun.body.members as Array<{ roundId: string }>;
			expect(members).toHaveLength(1);
			await controller.handle({
				providedToken: "isolated-token",
				body: {
					operation: "record",
					projectName: "raya",
					leadId: "raya",
					groupId: group.id,
					roundId: members[0]!.roundId,
					businessState: "complete",
					outcome: { substantive: false },
					evidenceRef: "qa:six-hour:empty",
				},
			});
			expect(
				await controller.handle({
					providedToken: "isolated-token",
					body: {
						operation: "finalize",
						projectName: "raya",
						leadId: "raya",
						groupId: group.id,
						decision: "silent",
						reason: "no substantive founder value",
					},
				}),
			).toMatchObject({ httpStatus: 200, body: { status: "silent" } });
			expect(outbound.handle).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});

	it("mints a deterministic roundId and renders it into Raya's inbox instruction", async () => {
		const h = harness();
		await h.pass();
		const roundId = summaryAbsorptionRoundId(120_000);
		expect(h.appendLeadEvent).toHaveBeenCalledWith(
			"raya",
			roundId,
			"summary_absorption_round",
			expect.stringContaining(roundId),
			"summary-absorption",
		);
		expect(h.enqueueLeadEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: roundId,
				leadId: "raya",
				priority: 2,
			}),
		);
	});

	it("reuses the durable journal identity on a duplicate pass", async () => {
		const h = harness();
		await h.pass();
		await h.pass();
		expect(
			[...h.rows.values()].filter(
				(row) => row.event_type === "summary_absorption_round",
			),
		).toHaveLength(1);
		expect(h.enqueueLeadEvent.mock.calls[1]?.[0]).toMatchObject({
			eventId: h.enqueueLeadEvent.mock.calls[0]?.[0].eventId,
			seq: h.enqueueLeadEvent.mock.calls[0]?.[0].seq,
		});
	});

	it("replays the same journal row after a crash between append and enqueue", async () => {
		const h = harness();
		h.enqueueLeadEvent.mockImplementationOnce(() => {
			throw new Error("injected enqueue crash");
		});
		await expect(h.pass()).resolves.toBeUndefined();
		await expect(h.pass()).resolves.toBeUndefined();
		expect(
			[...h.rows.values()].filter(
				(row) => row.event_type === "summary_absorption_round",
			),
		).toHaveLength(1);
		expect(h.enqueueLeadEvent.mock.calls[1]?.[0]).toMatchObject({
			eventId: h.enqueueLeadEvent.mock.calls[0]?.[0].eventId,
		});
	});

	it("observes a hot shorter cadence on the next pass", async () => {
		const h = harness({ cadences: [120_000, 60_000] });
		await h.pass();
		await h.pass();
		expect(
			[...h.rows.values()]
				.filter((row) => row.event_type === "summary_absorption_round")
				.map((row) => row.event_id),
		).toEqual([summaryAbsorptionRoundId(0), summaryAbsorptionRoundId(120_000)]);
	});

	it("is a no-op until exactly one Raya registry identity is active", async () => {
		const enqueueLeadEvent = vi.fn();
		const pass = createSummaryAbsorptionPass({
			projects: [],
			store: {
				appendLeadEvent: vi.fn(),
				getLeadEventBySeq: vi.fn(),
				appendSummaryDueRows: vi.fn(),
				listSummaryDueRows: vi.fn(() => []),
				getLeadEventByLeadAndId: vi.fn(() => null),
				tryClaimLeadEvent: vi.fn(() => true),
			},
			enqueueLeadEvent,
			inspectDeliveryState: vi.fn(() => ({ kind: "absent_identity" as const })),
			readSummaryGranularity: vi.fn(() => ({ state: "unselected" as const })),
			listSummaryPulls: vi.fn(async () => ({
				status: "ok" as const,
				pulls: [],
			})),
			alertFailure: vi.fn(async () => undefined),
			cadenceMs: () => 60_000,
			log: vi.fn(),
		});
		await pass();
		expect(enqueueLeadEvent).not.toHaveBeenCalled();
	});
});
