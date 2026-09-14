import type { ReadinessPolicy } from "./policy.js";
import type { ReadinessSubject } from "./subject.js";

export const READINESS_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

export interface ReleaseHeartbeat {
	tickAt: string;
	sourceCommit: string | null;
	baseVersion: string | null;
	w1Freshness: string;
	alertDeliveryEnabled: boolean;
	claimsDbOk: boolean;
	ingestOk: boolean;
	gapsDirOk: boolean;
	bridgeCaptureFailures: number;
	rejectedRows: number;
	backlogAgeS: number;
	outboxPending: number;
	outboxInvalid: number;
}
export interface ReleaseSignalEvent {
	eventId: string;
	sourceCommit: string | null;
	baseVersion: string | null;
	occurrence: number;
	projectName: string;
	kind: string;
	severity: "info" | "warning" | "severe";
	observedAt: string;
}
export interface ReleaseSignalGap {
	gapId: string;
	eventId: string | null;
	sourceCommit: string | null;
	projectName: string;
	reason: "shell_preflight" | "shell_claim_db" | "bridge_ledger_write";
	observedAt: string;
}
export interface ReleaseBugReport {
	intentId: string;
	issueIdentifier: string | null;
	status: "pending" | "finalized" | "abandoned";
	sourceCommit: string | null;
	baseVersion: string | null;
	createdAt: string;
}
export interface ReleasePublication {
	publicationId: string;
	day: string;
	subjectCommit: string;
	baseVersion: string;
	status: "intent" | "published" | "failed";
	channelId: string;
	messageId: string | null;
	intentAt: string;
	publishedAt: string | null;
	firstScanOkAt: string | null;
	lastScanOkAt: string | null;
	lastScanAt: string | null;
	lastScanError: string | null;
}
export interface ReleaseFounderVerdict {
	day: string;
	messageId: string;
	sentiment: "up" | "down";
	founderUserId: string;
	subjectCommit: string;
	observedAt: string;
}
export interface ReadinessInput {
	subject: ReadinessSubject;
	now: string;
	policy: ReadinessPolicy;
	localDeployedSha: string | null;
	anchor: {
		sourceCommit: string;
		episodeFrom: string;
		episodeTo: string | null;
	} | null;
	heartbeats: ReleaseHeartbeat[];
	events: ReleaseSignalEvent[];
	gaps: ReleaseSignalGap[];
	bugs: ReleaseBugReport[];
	bugSourceHealth: {
		label: string;
		lastSuccessAt: string | null;
		lastFailureAt: string | null;
		lastError: string | null;
	} | null;
	publications: ReleasePublication[];
	founderVerdicts: ReleaseFounderVerdict[];
	outbox: {
		gapsPending: number;
		gapsInvalid: number;
		publicationsPending: number;
		publicationsInvalid: number;
		oldestPendingAt: string | null;
		readErrors: string[];
	};
}
export interface ReadinessReason {
	code: string;
	detail: Record<string, unknown>;
}

export function isReadinessHeartbeatHealthy(
	h: ReleaseHeartbeat,
	backlogAgeMaxS: number,
): boolean {
	return (
		h.w1Freshness === "fresh" &&
		h.alertDeliveryEnabled &&
		h.claimsDbOk &&
		h.ingestOk &&
		h.gapsDirOk &&
		h.bridgeCaptureFailures === 0 &&
		h.rejectedRows === 0 &&
		h.backlogAgeS <= backlogAgeMaxS &&
		h.outboxPending === 0 &&
		h.outboxInvalid === 0
	);
}

export function evaluateReadiness(input: ReadinessInput) {
	const { subject, policy } = input;
	const nowMs = Date.parse(input.now);
	const anchor =
		input.anchor?.sourceCommit === subject.sourceCommit ? input.anchor : null;
	const fromMs = Math.max(
		anchor ? Date.parse(anchor.episodeFrom) : nowMs,
		nowMs - READINESS_WINDOW_MS,
	);
	const toMs = Math.min(
		anchor?.episodeTo ? Date.parse(anchor.episodeTo) : nowMs,
		nowMs,
	);
	const inWindow = (at: string) =>
		Date.parse(at) >= fromMs && Date.parse(at) <= toMs;
	const reasons: ReadinessReason[] = [];
	const add = (code: string, detail: Record<string, unknown>) =>
		reasons.push({ code, detail });
	const identity = {
		sourceCommit: subject.sourceCommit,
		localDeployedSha: input.localDeployedSha,
	};
	if (
		!anchor ||
		fromMs > toMs ||
		(anchor.episodeTo !== null && Date.parse(anchor.episodeTo) <= nowMs)
	)
		add("no_deployment_evidence", identity);
	if (input.localDeployedSha !== subject.sourceCommit)
		add("not_currently_deployed", identity);
	const heartbeats = input.heartbeats
		.filter(
			(h) => h.sourceCommit === subject.sourceCommit && inWindow(h.tickAt),
		)
		.sort((a, b) => a.tickAt.localeCompare(b.tickAt));
	const observedBases = [...new Set(heartbeats.map((h) => h.baseVersion))];
	if (observedBases.some((base) => base !== subject.baseVersion))
		add("subject_mismatch", {
			requestedBase: subject.baseVersion,
			observedBases,
		});
	const first = heartbeats[0];
	const last = heartbeats.at(-1);
	const boundaries = [
		fromMs,
		...heartbeats.map((h) => Date.parse(h.tickAt)),
		toMs,
	];
	let gapMs = 0;
	let interiorGapMs = 0;
	let largestGap = { from: fromMs, to: fromMs };
	for (let i = 1; i < boundaries.length; i++) {
		const from = boundaries[i - 1]!;
		const to = boundaries[i]!;
		const edge = i === 1 || i === boundaries.length - 1;
		// Edges have no evidence outside the window. Interior intervals exceeding
		// the freshness allowance are entirely unobserved, not healthy soak.
		if (edge || to - from > policy.heartbeatFreshMin * 60_000) {
			gapMs += Math.max(0, to - from);
			if (!edge) interiorGapMs += to - from;
			if (to - from > largestGap.to - largestGap.from)
				largestGap = { from, to };
		}
	}
	const coveredHours =
		first && last
			? Math.max(
					0,
					Date.parse(last.tickAt) - Date.parse(first.tickAt) - interiorGapMs,
				) / 3_600_000
			: 0;
	const ageMin = last ? (nowMs - Date.parse(last.tickAt)) / 60_000 : null;
	if (coveredHours < policy.soakHours)
		add("soak_insufficient", { coveredHours, requiredHours: policy.soakHours });
	if (ageMin === null || ageMin > policy.heartbeatFreshMin)
		add("heartbeat_stale", {
			lastHeartbeatAt: last?.tickAt ?? null,
			ageMin,
			freshMin: policy.heartbeatFreshMin,
		});
	if (gapMs / 60_000 > policy.gapToleranceMin)
		add("heartbeat_gap", {
			gapMin: gapMs / 60_000,
			toleranceMin: policy.gapToleranceMin,
			largestGap: {
				from: new Date(largestGap.from).toISOString(),
				to: new Date(largestGap.to).toISOString(),
			},
		});
	const unhealthy = heartbeats.filter(
		(h) => !isReadinessHeartbeatHealthy(h, policy.backlogAgeMaxS),
	);
	if (unhealthy.length)
		add("source_unhealthy", {
			ticks: unhealthy.slice(0, 10),
			total: unhealthy.length,
		});
	const outbox = input.outbox;
	if (
		outbox.gapsPending ||
		outbox.gapsInvalid ||
		outbox.publicationsPending ||
		outbox.publicationsInvalid ||
		outbox.readErrors.length
	)
		add("outbox_pending", outbox);
	const events = input.events.filter(
		(e) =>
			inWindow(e.observedAt) &&
			policy.projects.includes(e.projectName) &&
			!policy.ignoreKinds.includes(e.kind),
	);
	const unattributed = [
		...new Set(
			events
				.filter((e) => e.sourceCommit === null && e.severity === "severe")
				.map((e) => e.eventId),
		),
	];
	if (unattributed.length)
		add("unattributed_severe", {
			count: unattributed.length,
			sampleEventIds: unattributed.slice(0, 3),
		});
	const gaps = input.gaps.filter(
		(g) =>
			inWindow(g.observedAt) &&
			policy.projects.includes(g.projectName) &&
			(g.sourceCommit === null || g.sourceCommit === subject.sourceCommit),
	);
	if (gaps.length) {
		const byReason: Record<string, number> = {};
		for (const gap of gaps)
			byReason[gap.reason] = (byReason[gap.reason] ?? 0) + 1;
		add("capture_gap", {
			count: gaps.length,
			byReason,
			sampleEventIds: gaps
				.map((g) => g.eventId)
				.filter((id) => id !== null)
				.slice(0, 3),
		});
	}
	const severity = { info: 0, warning: 1, severe: 2 };
	const unique = new Map<string, ReleaseSignalEvent>();
	for (const event of events) {
		if (event.sourceCommit !== subject.sourceCommit) continue;
		const previous = unique.get(event.eventId);
		if (!previous || severity[event.severity] > severity[previous.severity])
			unique.set(event.eventId, event);
	}
	const severe = [...unique.values()].filter((e) => e.severity === "severe");
	const warning = [...unique.values()].filter((e) => e.severity === "warning");
	const bugs = input.bugs.filter(
		(b) =>
			inWindow(b.createdAt) &&
			b.status !== "abandoned" &&
			(b.sourceCommit === subject.sourceCommit || b.sourceCommit === null),
	);
	const unattributedBugs = bugs.filter((b) => b.sourceCommit === null);
	const pendingBugs = bugs.filter((b) => b.status === "pending");
	const finalizedBugs = bugs.filter(
		(b) => b.status === "finalized" && b.sourceCommit === subject.sourceCommit,
	);
	if (unattributedBugs.length)
		add("unattributed_bug", {
			count: unattributedBugs.length,
			identifiersOrIntents: unattributedBugs
				.map((b) => b.issueIdentifier ?? b.intentId)
				.slice(0, 5),
		});
	if (pendingBugs.length)
		add("bug_intent_unresolved", {
			count: pendingBugs.length,
			intentIds: pendingBugs.map((b) => b.intentId).slice(0, 5),
		});
	const bugHealth = input.bugSourceHealth;
	if (
		bugHealth?.lastFailureAt &&
		Date.parse(bugHealth.lastFailureAt) <= nowMs &&
		(!bugHealth.lastSuccessAt ||
			bugHealth.lastFailureAt >= bugHealth.lastSuccessAt)
	)
		add("bug_source_unhealthy", {
			lastFailureAt: bugHealth.lastFailureAt,
			lastSuccessAt: bugHealth.lastSuccessAt,
			label: bugHealth.label,
		});
	if (!policy.founderChannelConfigured) add("founder_channel_unset", {});
	const publications = input.publications.filter(
		(p) => p.subjectCommit === subject.sourceCommit && inWindow(p.intentAt),
	);
	const unobserved = publications.filter(
		(p) =>
			p.status !== "published" ||
			!p.messageId ||
			!p.firstScanOkAt ||
			!p.lastScanOkAt ||
			p.lastScanError !== null ||
			nowMs - Date.parse(p.lastScanOkAt) > policy.heartbeatFreshMin * 60_000,
	);
	if (publications.length === 0 || unobserved.length)
		add("founder_signal_unobserved", {
			days: unobserved.map((p) => ({
				day: p.day,
				publicationStatus: p.status,
				lastScanOkAt: p.lastScanOkAt,
				lastScanError: p.lastScanError,
			})),
		});
	const founderVerdicts = input.founderVerdicts.filter((v) => {
		const publication = input.publications.find(
			(p) =>
				p.subjectCommit === v.subjectCommit &&
				p.messageId === v.messageId &&
				p.day === v.day,
		);
		return (
			v.subjectCommit === subject.sourceCommit &&
			inWindow(publication?.intentAt ?? `${v.day}T00:00:00.000Z`)
		);
	});
	const down = founderVerdicts.filter((v) => v.sentiment === "down");
	const unknown = reasons.length > 0;
	if (down.length)
		add("founder_thumbs_down", {
			days: down.map((v) => ({ day: v.day, messageId: v.messageId })),
		});
	if (finalizedBugs.length >= policy.bugHold)
		add("bug_reports_over_threshold", {
			count: finalizedBugs.length,
			threshold: policy.bugHold,
			identifiers: finalizedBugs.map((b) => b.issueIdentifier),
		});
	for (const [rows, threshold, code] of [
		[severe, policy.severeHold, "severe_alerts"],
		[warning, policy.warningHold, "warning_alerts_over_threshold"],
	] as const) {
		if (rows.length < threshold) continue;
		const byKind: Record<string, number> = Object.create(null);
		for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
		add(code, { count: rows.length, threshold, byKind });
	}
	return {
		state: unknown ? "unknown" : reasons.length ? "hold" : "green",
		reasons,
		evidence: {
			founder: { days: founderVerdicts },
			counts: {
				severe: severe.length,
				warning: warning.length,
				unattributedSevere: unattributed.length,
				captureGaps: gaps.length,
				bugs: finalizedBugs.length,
				pendingBugs: pendingBugs.length,
				unattributedBugs: unattributedBugs.length,
			},
			window: {
				from: new Date(fromMs).toISOString(),
				to: new Date(toMs).toISOString(),
				episodeFrom: anchor?.episodeFrom ?? null,
				episodeTo: anchor?.episodeTo ?? null,
				windowTruncated: !!anchor && Date.parse(anchor.episodeFrom) < fromMs,
			},
			heartbeat: {
				coveredHours,
				gapMin: gapMs / 60_000,
				lastHeartbeatAt: last?.tickAt ?? null,
				ageMin,
			},
			outbox: input.outbox,
			localDeployedSha: input.localDeployedSha,
			policy,
			policyDefaulted: policy.policyDefaulted,
		},
	};
}

export type ReleaseReadinessRecord = ReturnType<typeof evaluateReadiness> & {
	verdictId: string;
	subject: ReadinessSubject;
	evaluatedAt: string;
};
