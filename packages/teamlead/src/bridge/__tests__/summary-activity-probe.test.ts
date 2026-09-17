import { describe, expect, it } from "vitest";
import { LEAD_EVENT_TYPES } from "../../terminal-row-archive.js";
import { GUARDRAIL_EVENT_TYPES } from "../lead-runtime.js";
import {
	activityRetentionFailure,
	captureActivitySource,
	classifyActivitySources,
	classifyMailboxSnapshot,
	isSummaryActivityNoiseEventType,
	parsePreviousDecisionRows,
	SUMMARY_ACTIVITY_BUSINESS_EVENT_TYPES,
	SUMMARY_ACTIVITY_NOISE_EVENT_TYPES,
} from "../summary-activity-probe.js";

const ok = (count: number) => ({ status: "ok" as const, count });
const unavailable = (reason: string) => ({
	status: "unavailable" as const,
	reason,
});
const notBound = { status: "not_bound" as const, count: 0 as const };

describe("FLY-2634 summary activity probe", () => {
	it("classifies only complete zero evidence as quiet", () => {
		expect(
			classifyActivitySources({
				lead_events: ok(0),
				mailbox: ok(0),
				linear: notBound,
			}),
		).toBe("quiet");
		expect(
			classifyActivitySources({
				lead_events: ok(0),
				mailbox: ok(0),
				linear: unavailable("linear_zero_unprovable"),
			}),
		).toBe("unknown");
	});

	it("lets a positive source override unavailable evidence", () => {
		expect(
			classifyActivitySources({
				lead_events: ok(1),
				mailbox: unavailable("comm_db_unavailable"),
				linear: unavailable("linear_timeout"),
			}),
		).toBe("active");
	});

	it("converts collector exceptions to bounded unavailable evidence", async () => {
		const result = await captureActivitySource(async () => {
			throw new Error(`bad\n${"x".repeat(240)}`);
		});
		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") {
			expect(result.reason).not.toContain("\n");
			expect(result.reason.length).toBeLessThanOrEqual(200);
		}
	});

	it("keeps the activity classification closed over durable event families", () => {
		const noise = new Set<string>(SUMMARY_ACTIVITY_NOISE_EVENT_TYPES);
		const business = new Set<string>(SUMMARY_ACTIVITY_BUSINESS_EVENT_TYPES);
		const productionSnapshot = [
			"runner_question",
			"stage_changed",
			"gate_question",
			"workflow_engine_escalation",
			"founder_reply",
			"patrol_tick",
			"session_started",
			"summary_due",
			"workflow_claim_recorded",
			"mailbox_dead_letter",
			"session_monitoring_reestablished",
			"quota_switch_confirmation",
			"usage_limit",
			"flag_scan_no_clock",
			"receipt_foundation_off",
			"summary_slot_settled",
			"summary_absorption_round",
			"checkpoint_park_nudge",
			"zombie_session_backlog",
			"session_zombie_detected",
			"session_failed",
			"session_completed",
			"epic_intake",
			"action_executed",
			"review_job_failed",
			"workflow_replacement_eligibility",
		];
		const known = new Set([
			...LEAD_EVENT_TYPES,
			...GUARDRAIL_EVENT_TYPES,
			...productionSnapshot,
		]);

		for (const eventType of known) {
			const memberships =
				Number(noise.has(eventType)) + Number(business.has(eventType));
			expect(memberships, eventType).toBe(1);
		}
		expect(isSummaryActivityNoiseEventType("brand_new_event")).toBe(false);
	});

	it("fails open when either observation point exceeds the hot retention budget", () => {
		const hour = 60 * 60_000;
		const nowMs = Date.parse("2026-09-16T18:00:00.000Z");
		expect(
			activityRetentionFailure({
				nowMs,
				fromMs: nowMs - 6 * hour,
				previousDecisionAtMs: nowMs - 6 * hour,
				retentionMs: 72 * hour,
			}),
		).toBeNull();
		expect(
			activityRetentionFailure({
				nowMs,
				fromMs: nowMs - 71 * hour,
				previousDecisionAtMs: nowMs - 6 * hour,
				retentionMs: 72 * hour,
			}),
		).toBe("retention_window_exceeded");
		expect(
			activityRetentionFailure({
				nowMs,
				fromMs: nowMs - 6 * hour,
				previousDecisionAtMs: nowMs - 71 * hour,
				retentionMs: 72 * hour,
			}),
		).toBe("retention_window_exceeded");
	});

	it("parses the latest window and searches mailbox cursors only through activity rows", () => {
		const activity = (mailbox: unknown) =>
			JSON.stringify({
				summary_due: {
					activity: {
						window: {
							from: "2026-09-16T00:00:00.000Z",
							to: "2026-09-16T06:00:00.000Z",
						},
						cursors: { mailbox },
					},
				},
			});
		const cursor = {
			allocated_seq: 7,
			instance: { schema_generation: "v1", completed_at: "born" },
		};
		expect(
			parsePreviousDecisionRows([
				{
					seq: 9,
					event_type: "summary_due",
					created_at: "2026-09-16 06:00:01",
					payload: activity(null),
				},
				{
					seq: 8,
					event_type: "summary_due",
					created_at: "2026-09-16 00:00:01",
					payload: activity(cursor),
				},
			]),
		).toMatchObject({
			decisionAtMs: Date.parse("2026-09-16T06:00:01.000Z"),
			decisionSeq: 9,
			window: {
				fromMs: Date.parse("2026-09-16T00:00:00.000Z"),
				toMs: Date.parse("2026-09-16T06:00:00.000Z"),
			},
			mailboxCursor: cursor,
			error: null,
		});

		expect(
			parsePreviousDecisionRows([
				{
					seq: 10,
					event_type: "summary_due",
					created_at: "2026-09-16 12:00:01",
					payload: JSON.stringify({ summary_due: {} }),
				},
				{
					seq: 9,
					event_type: "summary_due",
					created_at: "2026-09-16 06:00:01",
					payload: activity(cursor),
				},
			]),
		).toMatchObject({ window: null, mailboxCursor: null, error: null });
	});

	it("fails mailbox evidence open while advancing only trustworthy baselines", () => {
		const previous = {
			allocated_seq: 7,
			instance: { schema_generation: "v1", completed_at: "born" },
		};
		const current = {
			count: 0,
			allocatedSeq: 8,
			instance: { schema_generation: "v1", completed_at: "born" },
		};
		expect(
			classifyMailboxSnapshot({
				previousCursor: previous,
				snapshot: current,
				contiguous: true,
			}),
		).toEqual({
			source: { status: "ok", count: 0 },
			cursor: { allocated_seq: 8, instance: current.instance },
		});
		for (const [snapshot, reason] of [
			[{ ...current, allocatedSeq: 6 }, "sequence_regression"],
			[
				{
					...current,
					instance: { schema_generation: "v1", completed_at: "replaced" },
				},
				"instance_changed",
			],
		] as const) {
			expect(
				classifyMailboxSnapshot({
					previousCursor: previous,
					snapshot,
					contiguous: true,
				}).source,
			).toEqual({ status: "unavailable", reason });
		}
		expect(
			classifyMailboxSnapshot({
				previousCursor: null,
				snapshot: current,
				contiguous: false,
			}),
		).toMatchObject({
			source: { status: "unavailable", reason: "no_previous_cursor" },
			cursor: { allocated_seq: 8 },
		});
		expect(
			classifyMailboxSnapshot({
				previousCursor: previous,
				snapshot: current,
				contiguous: false,
			}),
		).toMatchObject({
			source: { status: "unavailable", reason: "window_discontinuous" },
			cursor: { allocated_seq: 8 },
		});
		expect(
			classifyMailboxSnapshot({
				previousCursor: null,
				snapshot: current,
				contiguous: false,
				continuityFailure: "corrupt_cursor",
			}),
		).toMatchObject({
			source: { status: "unavailable", reason: "corrupt_cursor" },
			cursor: { allocated_seq: 8 },
		});
		expect(
			classifyMailboxSnapshot({
				previousCursor: previous,
				snapshot: current,
				contiguous: true,
				continuityFailure: "retention_window_exceeded",
			}),
		).toMatchObject({
			source: {
				status: "unavailable",
				reason: "retention_window_exceeded",
			},
			cursor: { allocated_seq: 8 },
		});
	});
});
