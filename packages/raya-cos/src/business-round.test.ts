import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "raya-round-"));
	roots.push(root);
	return { root, round: new BusinessRound(root) };
}
const input = {
	schemaVersion: 2,
	operationId: "question:q1:1",
	kind: "announcement",
	sourceRefs: ["summary:round-1"],
	target: "roundtable",
	text: "<@12345678901234567> Which release owns this?",
	eventId: "question:q1:1",
};
function receipt(revision: number, status: string, extra = {}) {
	return {
		schemaVersion: 2,
		operationId: input.operationId,
		expectedRevision: revision,
		tool: "lead_actions.discord_send",
		callId: "call-1",
		result: {
			project: "raya",
			leadId: "raya",
			target: input.target,
			eventId: input.eventId,
			status,
			...extra,
		},
	};
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("business tool round", () => {
	it("persists exact intent before exposing it and resumes after process reconstruction", () => {
		const { root, round } = fixture();
		const prepared = round.prepare(input);
		expect(prepared).toMatchObject({
			schemaVersion: 2,
			revision: 1,
			stage: "prepared",
			next: {
				tool: "lead_actions.discord_send",
				arguments: {
					target: input.target,
					text: input.text,
					eventId: input.eventId,
				},
			},
		});
		expect(new BusinessRound(root).resume(input.operationId)).toEqual(prepared);
		expect(round.prepare(input)).toEqual(prepared);
		expect(() => round.prepare({ ...input, text: "different" })).toThrow(
			/binding/,
		);
	});
	it("keeps sent-but-unengaged pending and only completes on ready with the same message", () => {
		const { round } = fixture();
		round.prepare(input);
		const pending = round.record(
			receipt(1, "pending", {
				sendStatus: "sent",
				messageId: "12345678901234568",
				channelId: "12345678901234569",
				engagement: "pending",
			}),
		);
		expect(pending).toMatchObject({
			stage: "pending",
			revision: 2,
			next: { arguments: { eventId: input.eventId, text: input.text } },
		});
		expect(() =>
			round.record(
				receipt(2, "sent", {
					messageId: "12345678901234570",
					channelId: "12345678901234569",
					engagement: "ready",
					threadId: "12345678901234570",
				}),
			),
		).toThrow(/message/);
		const complete = round.record(
			receipt(2, "sent", {
				messageId: "12345678901234568",
				channelId: "12345678901234569",
				engagement: "ready",
				threadId: "12345678901234568",
			}),
		);
		expect(complete).toMatchObject({
			stage: "complete",
			revision: 3,
			next: null,
		});
		expect(round.resume(input.operationId)).toEqual(complete);
	});
	it("preserves ambiguous outcomes without returning a send intent", () => {
		const { round } = fixture();
		round.prepare(input);
		expect(round.record(receipt(1, "ambiguous"))).toMatchObject({
			stage: "unknown",
			next: null,
			needsReconciliation: true,
		});
		expect(round.resume(input.operationId).next).toBeNull();
		expect(round.prepare(input).next).toBeNull();
	});
	it("rejects stale, mismatched and incomplete receipts before advancing", () => {
		const { round } = fixture();
		round.prepare(input);
		for (const bad of [
			receipt(0, "sent"),
			receipt(1, "sent"),
			receipt(1, "sent", { project: "other" }),
			{ ...receipt(1, "unavailable"), callId: "" },
			receipt(1, "unavailable", { eventId: "other" }),
		]) {
			expect(() => round.record(bad)).toThrow();
		}
		expect(round.resume(input.operationId).revision).toBe(1);
	});
	it("persists rate limit deadline and does not offer an early retry", () => {
		const { root } = fixture();
		let now = 1000;
		const round = new BusinessRound(root, () => now);
		round.prepare(input);
		expect(
			round.record(receipt(1, "rate_limited", { retryAfterMs: 2000 })),
		).toMatchObject({ stage: "pending", next: null, nextAttemptAt: 3000 });
		now = 2999;
		expect(round.resume(input.operationId).next).toBeNull();
		now = 3000;
		expect(round.resume(input.operationId).next).toMatchObject({
			tool: "lead_actions.discord_send",
		});
	});
	it("records call provenance while rejecting unversioned and unknown input fields", () => {
		const { round } = fixture();
		expect(() => round.prepare({ ...input, schemaVersion: 1 })).toThrow();
		expect(() => round.prepare({ ...input, token: "unexpected" })).toThrow();
		round.prepare(input);
		const recorded = round.record(receipt(1, "unavailable"));
		expect(recorded.receipts).toEqual([
			expect.objectContaining({
				tool: "lead_actions.discord_send",
				callId: "call-1",
				result: expect.objectContaining({ status: "unavailable" }),
			}),
		]);
	});
});
