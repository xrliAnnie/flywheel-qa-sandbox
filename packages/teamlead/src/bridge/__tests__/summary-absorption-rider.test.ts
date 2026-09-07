import { summaryDeliveryBranch } from "flywheel-comm/summary-contract";
import { describe, expect, it, vi } from "vitest";
import { type LeadEventRow, StateStore } from "../../StateStore.js";
import {
	createSummaryAbsorptionPass,
	summaryAbsorptionRoundId,
} from "../summary-absorption-rider.js";

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
		listSummaryPulls: vi.fn(async () => ({ status: "ok" as const, pulls: [] })),
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
		expect(enqueueLeadEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "summary_due:growth/reflection-lead:1970-01-01T00:03:00.000Z",
				leadId: "reflection-lead",
			}),
		);
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

	it("freezes a mature called slot and appends its exact report line to Raya", async () => {
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
			producer_count: 1,
			delivered_count: 0,
			absent: ["reflection-lead"],
			report_line: "本轮 0/1 份已交;未交:reflection-lead",
		});
		const rayaRound = store.getLeadEventByLeadAndId(
			"raya",
			summaryAbsorptionRoundId(180_000),
		);
		expect(rayaRound).not.toBeNull();
		expect(JSON.parse(rayaRound!.payload).notification_context).toContain(
			"本轮 0/1 份已交;未交:reflection-lead",
		);
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
				leadId: "patrol-roster:summary-due",
				projectName: "machine",
				eventId: `summary_due_undelivered:${slotStart}`,
				eventType: "inbox_loop_stalled",
				title: "summary_due not delivered to 1 Lead inbox(es)",
				body: expect.stringContaining("growth/reflection-lead: undelivered"),
				severity: "warning",
			}),
		);
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
			report_line: "本轮 1/1 份已交。",
		});
		expect(listSummaryPulls).toHaveBeenCalledTimes(3);
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
