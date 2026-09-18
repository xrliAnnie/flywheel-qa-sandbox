import { sanitizeDiscordText } from "../formatting/discord-text.js";

export type ParsedDriftEnvelope =
	| { kind: "silent_no_divergence" }
	| { kind: "silent_insufficient" }
	| {
			kind: "drift";
			snapshotId: string;
			goalIds: string[];
			readingRefs: string[];
			body: string;
	  }
	| { kind: "invalid"; reason: string };

export interface DriftEvidenceSnapshot {
	snapshotId: string;
	projects: Array<Record<string, unknown> & { projectName: string }>;
}

export type ValidatedDriftEnvelope =
	| { kind: "valid"; content: string }
	| { kind: "invalid"; reason: string };

const GOAL_ID = /^g-\d{8}-\d{2}$/;
const PROJECT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const READING_PATHS = new Set([
	"checkoutHead.lastCommit",
	"checkoutHead.lastNonChoreCommit",
	"checkoutHead.branch",
	"canonical.lastCommit",
	"prActivity.updatedAt",
	"openPrs.returnedCount",
	"openPrs.newestUpdatedAt",
	"activity.daysSinceLatestObservedActivity",
	"linear.activeIssues",
]);

function invalid(reason: string): ParsedDriftEnvelope {
	return { kind: "invalid", reason };
}

function hasDuplicates(values: string[]): boolean {
	return new Set(values).size !== values.length;
}

function parseReadingRef(
	value: string,
): { projectName: string; path: string } | undefined {
	const separator = value.indexOf(".");
	if (separator < 1) return undefined;
	const projectName = value.slice(0, separator);
	const path = value.slice(separator + 1);
	if (!PROJECT_NAME.test(projectName) || !READING_PATHS.has(path)) {
		return undefined;
	}
	return { projectName, path };
}

export function parseDriftEnvelope(text: string): ParsedDriftEnvelope {
	const raw = text.trim();
	const normalized = raw.normalize("NFKC");
	if (normalized === "【无话】") return { kind: "silent_no_divergence" };
	if (normalized === "【证据不足】") return { kind: "silent_insufficient" };
	const lines = raw.split("\n");
	if (lines[0]?.normalize("NFKC") !== "【偏离】") {
		return invalid(raw.length === 0 ? "empty" : "unknown_shape");
	}
	const evidence =
		/^依据:\s*snapshot=(\S+)\s+goals=(\S+)\s+readings=(\S+)$/.exec(
			lines[1]?.normalize("NFKC") ?? "",
		);
	if (!evidence) return invalid("missing_evidence");
	const snapshotId = evidence[1] ?? "";
	const goalIds = (evidence[2] ?? "").split(",");
	const readingRefs = (evidence[3] ?? "").split(",");
	if (
		goalIds.length < 1 ||
		readingRefs.length < 1 ||
		goalIds.length > 5 ||
		readingRefs.length > 8
	) {
		return invalid("too_many");
	}
	if (hasDuplicates(goalIds) || hasDuplicates(readingRefs)) {
		return invalid("duplicate");
	}
	if (goalIds.some((goalId) => !GOAL_ID.test(goalId))) {
		return invalid("bad_goal_id");
	}
	if (readingRefs.some((readingRef) => !parseReadingRef(readingRef))) {
		return invalid("bad_reading_ref");
	}
	const body = lines.slice(2).join("\n");
	const bodyLength = Array.from(body).length;
	if (body.trim().length === 0) return invalid("empty_body");
	if (bodyLength > 1_500) return invalid("too_long");
	return { kind: "drift", snapshotId, goalIds, readingRefs, body };
}

function readEvidence(
	snapshot: DriftEvidenceSnapshot,
	readingRef: string,
): "ok" | "missing" | "unavailable" {
	const parsed = parseReadingRef(readingRef);
	if (!parsed) return "missing";
	const project = snapshot.projects.find(
		(candidate) => candidate.projectName === parsed.projectName,
	);
	if (!project) return "missing";
	let value: unknown = project;
	for (const segment of parsed.path.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return "missing";
		}
		value = (value as Record<string, unknown>)[segment];
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return "missing";
	}
	return (value as Record<string, unknown>).ok === true ? "ok" : "unavailable";
}

export function validateDriftEnvelope(
	envelope: ParsedDriftEnvelope,
	context: {
		snapshot: DriftEvidenceSnapshot;
		activeGoalIds: readonly string[];
	},
): ValidatedDriftEnvelope {
	if (envelope.kind !== "drift") {
		return { kind: "invalid", reason: "invalid_envelope" };
	}
	if (
		envelope.goalIds.length < 1 ||
		envelope.goalIds.length > 5 ||
		envelope.readingRefs.length < 1 ||
		envelope.readingRefs.length > 8
	) {
		return { kind: "invalid", reason: "too_many" };
	}
	if (hasDuplicates(envelope.goalIds) || hasDuplicates(envelope.readingRefs)) {
		return { kind: "invalid", reason: "duplicate" };
	}
	if (envelope.snapshotId !== context.snapshot.snapshotId) {
		return { kind: "invalid", reason: "snapshot_mismatch" };
	}
	const activeGoalIds = new Set(context.activeGoalIds);
	if (envelope.goalIds.some((goalId) => !activeGoalIds.has(goalId))) {
		return { kind: "invalid", reason: "goal_not_active" };
	}
	for (const readingRef of envelope.readingRefs) {
		const evidence = readEvidence(context.snapshot, readingRef);
		if (evidence === "missing") {
			return { kind: "invalid", reason: "reading_missing" };
		}
		if (evidence === "unavailable") {
			return { kind: "invalid", reason: "reading_unavailable" };
		}
	}
	const body = sanitizeDiscordText(envelope.body);
	const content = `🔔 **Raya**: ${body}\n\n依据:读数 ${envelope.snapshotId} · 目标 ${envelope.goalIds.join(",")} · 读数键 ${envelope.readingRefs.join(",")}`;
	if (Array.from(content).length > 1_900) {
		return { kind: "invalid", reason: "too_long" };
	}
	return { kind: "valid", content };
}

export interface ScopedDriftContext {
	snapshot: DriftEvidenceSnapshot & { sampledAt: string };
	goals: Array<{ id: string; status: string; projects?: readonly string[] }>;
	now: Date;
	staleAfterMs: number;
}
export function validateScopedDriftEnvelope(
	envelope: ParsedDriftEnvelope,
	context: ScopedDriftContext,
): ValidatedDriftEnvelope {
	const base = validateDriftEnvelope(envelope, {
		snapshot: context.snapshot,
		activeGoalIds: context.goals
			.filter((goal) => goal.status === "active")
			.map((goal) => goal.id),
	});
	if (base.kind !== "valid" || envelope.kind !== "drift") return base;
	const now = context.now.getTime(),
		sampledAt = Date.parse(context.snapshot.sampledAt);
	if (
		!Number.isFinite(now) ||
		!Number.isFinite(sampledAt) ||
		!Number.isFinite(context.staleAfterMs) ||
		context.staleAfterMs <= 0 ||
		sampledAt > now ||
		now - sampledAt > context.staleAfterMs
	)
		return { kind: "invalid", reason: "stale_snapshot" };
	if (
		new Set(context.goals.map((goal) => goal.id)).size !==
			context.goals.length ||
		new Set(context.snapshot.projects.map((project) => project.projectName))
			.size !== context.snapshot.projects.length
	)
		return { kind: "invalid", reason: "ambiguous_evidence" };
	const goals = context.goals.filter((goal) =>
		envelope.goalIds.includes(goal.id),
	);
	if (
		goals.some(
			(goal) =>
				!goal.projects?.length ||
				goal.projects.some((project) => !PROJECT_NAME.test(project)),
		)
	)
		return { kind: "invalid", reason: "goal_scope_unknown" };
	const refs = envelope.readingRefs.map(parseReadingRef);
	if (
		goals.some(
			(goal) =>
				!refs.some((ref) => ref && goal.projects?.includes(ref.projectName)),
		) ||
		refs.some(
			(ref) =>
				!ref || !goals.some((goal) => goal.projects?.includes(ref.projectName)),
		)
	)
		return { kind: "invalid", reason: "goal_project_mismatch" };
	for (const ref of refs) {
		if (!ref) return { kind: "invalid", reason: "reading_missing" };
		let value: unknown = context.snapshot.projects.find(
			(project) => project.projectName === ref.projectName,
		);
		for (const segment of ref.path.split("."))
			value = (value as Record<string, unknown>)[segment];
		const reading = value as Record<string, unknown>,
			at = typeof reading.at === "string" ? Date.parse(reading.at) : NaN;
		if (
			!Number.isFinite(at) ||
			at > sampledAt ||
			now - at > context.staleAfterMs
		)
			return { kind: "invalid", reason: "stale_reading" };
	}
	return base;
}
