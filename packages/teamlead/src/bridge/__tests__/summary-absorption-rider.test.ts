import { describe, expect, it, vi } from "vitest";
import type { LeadEventRow } from "../../StateStore.js";
import {
	createSummaryAbsorptionPass,
	summaryAbsorptionRoundId,
} from "../summary-absorption-rider.js";

function harness(options: { now?: number; cadences?: number[] } = {}) {
	const now = options.now ?? 190_000;
	const cadences = [...(options.cadences ?? [60_000])];
	const rows = new Map<string, LeadEventRow>();
	let seq = 0;
	const appendLeadEvent = vi.fn(
		(leadId: string, eventId: string, eventType: string, payload: string) => {
			const existing = rows.get(eventId);
			if (existing) return existing.seq;
			const row = {
				seq: ++seq,
				lead_id: leadId,
				event_id: eventId,
				event_type: eventType,
				payload,
				session_key: "summary-absorption",
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
		store: { appendLeadEvent, getLeadEventBySeq },
		enqueueLeadEvent,
		cadenceMs: () => cadences.shift() ?? 60_000,
		now: () => now,
	});
	return { appendLeadEvent, enqueueLeadEvent, pass, rows };
}

describe("FLY-2131 summary absorption GatePoller rider", () => {
	it("mints a deterministic roundId and renders it into Raya's inbox instruction", async () => {
		const h = harness();
		await h.pass();
		const roundId = summaryAbsorptionRoundId(180_000);
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
		expect(h.rows).toHaveLength(1);
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
		await expect(h.pass()).rejects.toThrow("injected enqueue crash");
		await expect(h.pass()).resolves.toBeUndefined();
		expect(h.rows).toHaveLength(1);
		expect(h.enqueueLeadEvent.mock.calls[1]?.[0]).toMatchObject({
			eventId: h.enqueueLeadEvent.mock.calls[0]?.[0].eventId,
		});
	});

	it("observes a hot shorter cadence on the next pass", async () => {
		const h = harness({ cadences: [120_000, 60_000] });
		await h.pass();
		await h.pass();
		expect([...h.rows.keys()]).toEqual([
			summaryAbsorptionRoundId(120_000),
			summaryAbsorptionRoundId(180_000),
		]);
	});

	it("is a no-op until exactly one Raya registry identity is active", async () => {
		const enqueueLeadEvent = vi.fn();
		const pass = createSummaryAbsorptionPass({
			projects: [],
			store: { appendLeadEvent: vi.fn(), getLeadEventBySeq: vi.fn() },
			enqueueLeadEvent,
			cadenceMs: () => 60_000,
		});
		await pass();
		expect(enqueueLeadEvent).not.toHaveBeenCalled();
	});
});
