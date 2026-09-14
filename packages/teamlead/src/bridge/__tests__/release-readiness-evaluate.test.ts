import { describe, expect, it } from "vitest";
import {
	evaluateReadiness,
	type ReadinessInput,
} from "../release-readiness/evaluate.js";
import { readReadinessPolicy } from "../release-readiness/policy.js";

const sha = "a".repeat(40);
const now = "2026-09-11T12:00:00.000Z";
const start = "2026-09-11T00:00:00.000Z";
function empty(): ReadinessInput {
	return {
		subject: { baseVersion: "1.56.0", sourceCommit: sha },
		now,
		policy: readReadinessPolicy({ FLYWHEEL_READINESS_REPORT_CHANNEL: "c" }),
		localDeployedSha: sha,
		anchor: null,
		heartbeats: [],
		events: [],
		gaps: [],
		bugs: [],
		bugSourceHealth: null,
		publications: [],
		founderVerdicts: [],
		outbox: {
			gapsPending: 0,
			gapsInvalid: 0,
			publicationsPending: 0,
			publicationsInvalid: 0,
			oldestPendingAt: null,
			readErrors: [],
		},
	};
}
const codes = (input: ReadinessInput) =>
	evaluateReadiness(input).reasons.map((r) => r.code);
function healthy(): ReadinessInput {
	const input = empty();
	input.anchor = { sourceCommit: sha, episodeFrom: start, episodeTo: null };
	input.heartbeats = Array.from({ length: 721 }, (_, i) => ({
		tickAt: new Date(Date.parse(start) + i * 60_000).toISOString(),
		sourceCommit: sha,
		baseVersion: "1.56.0",
		w1Freshness: "fresh",
		alertDeliveryEnabled: true,
		claimsDbOk: true,
		ingestOk: true,
		gapsDirOk: true,
		bridgeCaptureFailures: 0,
		rejectedRows: 0,
		backlogAgeS: 0,
		outboxPending: 0,
		outboxInvalid: 0,
	}));
	input.publications = [
		{
			publicationId: "current-report",
			day: "2026-09-11",
			subjectCommit: sha,
			baseVersion: "1.56.0",
			status: "published",
			channelId: "c",
			messageId: "current-message",
			intentAt: start,
			publishedAt: start,
			firstScanOkAt: start,
			lastScanOkAt: now,
			lastScanAt: now,
			lastScanError: null,
		},
	];
	return input;
}

describe("release readiness evaluation", () => {
	it("allows green with a scanned publication and no thumbs down", () => {
		expect(evaluateReadiness(healthy()).state).toBe("green");
	});
	it("fails closed with no founder publication", () => {
		const input = healthy();
		input.publications = [];
		expect(evaluateReadiness(input).state).toBe("unknown");
		expect(codes(input)).toContain("founder_signal_unobserved");
	});
	it.each([undefined, "", "   "])(
		"fails closed with an unset founder channel %j",
		(channel) => {
			const input = healthy();
			input.policy = readReadinessPolicy({
				FLYWHEEL_READINESS_REPORT_CHANNEL: channel,
			});
			expect(evaluateReadiness(input).state).toBe("unknown");
			expect(codes(input)).toContain("founder_channel_unset");
		},
	);

	it("cannot reuse a closed deployment episode even when its SHA again matches the local file", () => {
		const input = healthy();
		input.policy.soakHours = 1;
		input.anchor!.episodeTo = "2026-09-11T11:59:00.000Z";
		expect(codes(input)).toContain("no_deployment_evidence");
	});
	it("bounds a protected 20-day episode to the shared 14-day retention window, including founder publication age", () => {
		const input = healthy();
		input.anchor!.episodeFrom = "2026-08-22T12:00:00.000Z";
		const from = "2026-08-28T12:00:00.000Z";
		const heartbeat = input.heartbeats[0]!;
		input.heartbeats = Array.from({ length: 2017 }, (_, i) => ({
			...heartbeat,
			tickAt: new Date(Date.parse(from) + i * 600_000).toISOString(),
		}));
		input.events = [
			{
				eventId: "old-severe",
				sourceCommit: sha,
				baseVersion: "1.56.0",
				occurrence: 1,
				projectName: "flywheel",
				kind: "deploy_failed",
				severity: "severe",
				observedAt: "2026-08-27T12:00:00.000Z",
			},
		];
		input.publications = [
			...input.publications,
			{
				publicationId: "old-report",
				day: "2026-08-27",
				subjectCommit: sha,
				baseVersion: "1.56.0",
				status: "published",
				channelId: "c",
				messageId: "old-message",
				intentAt: "2026-08-27T12:00:00.000Z",
				publishedAt: "2026-08-27T12:01:00.000Z",
				firstScanOkAt: "2026-08-27T12:02:00.000Z",
				lastScanOkAt: now,
				lastScanAt: now,
				lastScanError: null,
			},
		];
		input.founderVerdicts = [
			{
				day: "2026-08-27",
				messageId: "old-message",
				sentiment: "down",
				founderUserId: "annie",
				subjectCommit: sha,
				observedAt: now,
			},
		];
		const verdict = evaluateReadiness(input);
		expect(verdict.state).toBe("green");
		expect(verdict.evidence.window).toMatchObject({
			from,
			to: now,
			episodeFrom: input.anchor!.episodeFrom,
			windowTruncated: true,
		});
		input.events[0]!.observedAt = from;
		expect(evaluateReadiness(input).state).toBe("hold");
	});
	it("scans every publication and keeps any day down despite later up or no reaction", () => {
		const input = healthy();
		input.now = "2026-09-13T12:00:00.000Z";
		const heartbeat = input.heartbeats[0]!;
		input.heartbeats = Array.from({ length: 3601 }, (_, i) => ({
			...heartbeat,
			tickAt: new Date(Date.parse(start) + i * 60_000).toISOString(),
		}));
		input.publications = [11, 12, 13].map((day) => ({
			publicationId: `rp-${day}`,
			day: `2026-09-${day}`,
			subjectCommit: sha,
			baseVersion: "1.56.0",
			status: "published",
			channelId: "c",
			messageId: `m${day}`,
			intentAt: `2026-09-${day}T01:00:00.000Z`,
			publishedAt: `2026-09-${day}T01:00:01.000Z`,
			firstScanOkAt: `2026-09-${day}T01:01:00.000Z`,
			lastScanOkAt: input.now,
			lastScanAt: input.now,
			lastScanError: null,
		}));
		const publication = input.publications[0]!;
		input.founderVerdicts = [
			{
				day: publication.day,
				messageId: publication.messageId!,
				sentiment: "down",
				founderUserId: "annie",
				subjectCommit: sha,
				observedAt: publication.firstScanOkAt!,
			},
			{
				day: "2026-09-12",
				messageId: "m12",
				sentiment: "up",
				founderUserId: "annie",
				subjectCommit: sha,
				observedAt: "2026-09-12T01:01:00.000Z",
			},
		];
		expect(evaluateReadiness(input).state).toBe("hold");
		expect(codes(input)).toContain("founder_thumbs_down");
		for (const patch of [
			{ status: "intent" as const },
			{ status: "failed" as const },
			{ firstScanOkAt: null },
			{ lastScanError: "403" },
			{ lastScanOkAt: "2026-09-13T11:49:00.000Z" },
		]) {
			input.publications[0] = { ...publication, ...patch };
			expect(evaluateReadiness(input).state).toBe("unknown");
			expect(codes(input)).toContain("founder_signal_unobserved");
		}
		input.publications[0] = publication;
		input.founderVerdicts.shift();
		expect(evaluateReadiness(input).state).toBe("green");
		input.heartbeats = [];
		expect(evaluateReadiness(input).state).toBe("unknown");
	});
	it("holds attributed bugs and keeps unresolved or unclassified bug evidence unknown until resolved", () => {
		const input = healthy();
		const bug = {
			intentId: "bi-1",
			issueIdentifier: "FLY-123",
			status: "finalized" as const,
			sourceCommit: sha,
			baseVersion: "1.56.0",
			createdAt: start,
		};
		input.bugs = [bug];
		expect(codes(input)).toContain("bug_reports_over_threshold");
		input.bugs = [{ ...bug, sourceCommit: null }];
		expect(codes(input)).toContain("unattributed_bug");
		input.bugs = [{ ...bug, issueIdentifier: null, status: "pending" }];
		expect(codes(input)).toContain("bug_intent_unresolved");
		input.bugs = [{ ...bug, status: "abandoned" }];
		expect(evaluateReadiness(input).state).toBe("green");
		input.bugSourceHealth = {
			label: "Bug",
			lastFailureAt: start,
			lastSuccessAt: null,
			lastError: "label lookup failed",
		};
		expect(codes(input)).toContain("bug_source_unhealthy");
		input.bugSourceHealth.lastSuccessAt = now;
		expect(evaluateReadiness(input).state).toBe("green");
		input.bugs = [
			{ ...bug, sourceCommit: "b".repeat(40) },
			{ ...bug, intentId: "old", createdAt: "2026-09-10T23:59:00.000Z" },
		];
		expect(evaluateReadiness(input).state).toBe("green");
	});
	it("counts an event once at its highest severity in this episode, while unattributed severe or capture gaps take priority", () => {
		const input = healthy();
		const event = {
			eventId: "event-1",
			sourceCommit: sha,
			baseVersion: "1.56.0",
			occurrence: 1,
			projectName: "flywheel",
			kind: "deploy_failed",
			severity: "warning" as const,
			observedAt: "2026-09-11T01:00:00.000Z",
		};
		input.events = [
			event,
			{ ...event, occurrence: 2 },
			{ ...event, occurrence: 3, severity: "severe" },
			{
				...event,
				eventId: "old",
				observedAt: "2026-09-10T23:59:59.000Z",
				severity: "severe",
			},
			{
				...event,
				eventId: "other",
				sourceCommit: "b".repeat(40),
				severity: "severe",
			},
		];
		let verdict = evaluateReadiness(input);
		expect(verdict.state).toBe("hold");
		expect(verdict.evidence.counts).toMatchObject({ severe: 1, warning: 0 });
		expect(verdict.reasons).toContainEqual({
			code: "severe_alerts",
			detail: { count: 1, threshold: 1, byKind: { deploy_failed: 1 } },
		});
		input.events.push({
			...event,
			eventId: "unknown",
			sourceCommit: null,
			severity: "severe",
		});
		verdict = evaluateReadiness(input);
		expect(verdict.state).toBe("unknown");
		expect(codes(input)).toEqual(
			expect.arrayContaining(["unattributed_severe", "severe_alerts"]),
		);
		input.events = [];
		input.gaps = [
			{
				gapId: "gap-1",
				eventId: null,
				projectName: "machine",
				sourceCommit: null,
				reason: "shell_preflight",
				observedAt: event.observedAt,
			},
		];
		expect(codes(input)).toContain("capture_gap");
		input.gaps[0]!.sourceCommit = "b".repeat(40);
		expect(evaluateReadiness(input).state).toBe("green");
		input.gaps = [];
		input.events = Array.from({ length: 5 }, (_, i) => ({
			...event,
			eventId: `warning-${i}`,
		}));
		expect(codes(input)).toContain("warning_alerts_over_threshold");
		input.policy.ignoreKinds = [event.kind];
		expect(evaluateReadiness(input).state).toBe("green");
		input.policy.ignoreKinds = [];
		input.events = input.events.map((e) => ({ ...e, projectName: "other" }));
		expect(evaluateReadiness(input).state).toBe("green");
	});
	it("keeps every unhealthy source tick and synchronous outbox failure fail-closed", () => {
		for (const patch of [
			{ w1Freshness: "stale" },
			{ alertDeliveryEnabled: false },
			{ claimsDbOk: false },
			{ ingestOk: false },
			{ gapsDirOk: false },
			{ bridgeCaptureFailures: 1 },
			{ rejectedRows: 1 },
			{ backlogAgeS: 601 },
			{ outboxPending: 1 },
			{ outboxInvalid: 1 },
		]) {
			const input = healthy();
			Object.assign(input.heartbeats[100]!, patch);
			expect(codes(input), JSON.stringify(patch)).toContain("source_unhealthy");
		}
		for (const patch of [
			{ gapsPending: 1 },
			{ gapsInvalid: 1 },
			{ publicationsPending: 1 },
			{ publicationsInvalid: 1 },
			{ readErrors: ["EACCES"] },
		]) {
			const input = healthy();
			Object.assign(input.outbox, patch);
			expect(codes(input)).toContain("outbox_pending");
		}
	});
	it("requires complete fresh coverage for the exact currently deployed subject, including both window edges", () => {
		const input = healthy();
		expect(evaluateReadiness(input).state).toBe("green");
		expect(evaluateReadiness(input).evidence.heartbeat.coveredHours).toBe(12);
		input.heartbeats = input.heartbeats.filter((_, i) => i > 60 && i < 660);
		expect(codes(input)).toEqual(
			expect.arrayContaining([
				"soak_insufficient",
				"heartbeat_stale",
				"heartbeat_gap",
			]),
		);
		input.heartbeats = healthy().heartbeats.filter(
			(_, i) => i < 300 || i > 360,
		);
		expect(codes(input)).toContain("heartbeat_gap");
		input.heartbeats = healthy().heartbeats;
		input.localDeployedSha = "b".repeat(40);
		expect(codes(input)).toContain("not_currently_deployed");
		input.localDeployedSha = sha;
		input.heartbeats[0]!.baseVersion = "1.55.0";
		expect(codes(input)).toContain("subject_mismatch");
		input.heartbeats = healthy().heartbeats.map((h) => ({
			...h,
			sourceCommit: "b".repeat(40),
		}));
		expect(codes(input)).toContain("soak_insufficient");
	});
	it("does not treat missing deployment and observer evidence as health", () => {
		const verdict = evaluateReadiness(empty());
		expect(verdict.state).toBe("unknown");
		expect(codes(empty())).toEqual(
			expect.arrayContaining([
				"no_deployment_evidence",
				"soak_insufficient",
				"heartbeat_stale",
			]),
		);
	});
});
