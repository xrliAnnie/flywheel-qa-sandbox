/**
 * FLY-2033 meeting-artifact scheduler — pure planning and transcript ownership.
 *
 * IO belongs in scripts/meeting-notes-scheduler.ts. This module deliberately
 * accepts snapshots and observations so every retry/idempotency decision can be
 * exercised without Linear, Raya, or the Bridge.
 */

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRIGGER_MARKER = "[meeting-notes-trigger:v1]";
const DISPATCH_RECEIPT = "[meeting-notes-dispatched]";
const TERMINAL_RECEIPT = "[meeting-terminal:v1]";

export type MeetingStatus =
	| "scheduled"
	| "starting"
	| "live"
	| "interrupted"
	| "ended"
	| "cancelled"
	| "missed";

const TERMINAL_MEETING_STATUSES = new Set<MeetingStatus>([
	"ended",
	"cancelled",
	"missed",
]);

export interface MeetingRecord {
	schemaVersion: 2;
	id: string;
	leadId: string;
	topic: string;
	scheduledAt: string;
	durationMinutes: number;
	requestedBy: string;
	requestedAt: string;
	status: MeetingStatus;
	continuesFrom?: string;
	voice?: Record<string, unknown>;
	endedAt?: string;
	endReason?: string;
}

export interface MeetingIssueObservation {
	id: string;
	identifier: string;
	description: string;
	stateName: string;
	stateType: string;
	comments: string[];
}

export interface MeetingIssueIndex {
	byMeetingId: ReadonlyMap<string, MeetingIssueObservation>;
}

export interface MeetingNotesPlanningContext {
	archivedMeetingIds: ReadonlySet<string>;
}

export interface LinearPage<T> {
	nodes: T[];
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export interface LinearLabelRef {
	id: string;
	name: string;
	description?: string | null;
}

export const MEETING_LABEL_DESCRIPTION =
	"FLY-2033 canonical meeting issue label";

/** Auto-create only before any meeting evidence exists; later label loss is fail-closed. */
export function canBootstrapMeetingLabel(input: {
	meetingCount: number;
	archivedMeetingCount: number;
	scanErrorCount: number;
}): boolean {
	return (
		input.meetingCount === 0 &&
		input.archivedMeetingCount === 0 &&
		input.scanErrorCount === 0
	);
}

/** Resolve one exact label, optionally creating only a caller-approved missing label. */
export async function resolveLinearLabel(input: {
	labels: readonly LinearLabelRef[];
	name: string;
	canonicalDescription?: string;
	create?: () => Promise<LinearLabelRef>;
}): Promise<LinearLabelRef> {
	const matches = input.labels.filter((label) => label.name === input.name);
	if (matches.length > 1) {
		throw new Error(
			`Linear label ${input.name} must resolve uniquely; found ${matches.length}`,
		);
	}
	if (matches.length === 1) return matches[0]!;
	if (
		input.canonicalDescription &&
		input.labels.some(
			(label) => label.description === input.canonicalDescription,
		)
	) {
		throw new Error(
			`Linear label ${input.name} canonical identity exists under an unexpected name`,
		);
	}
	if (!input.create) {
		throw new Error(
			`Linear label ${input.name} must resolve uniquely; found 0`,
		);
	}
	const created = await input.create!();
	if (
		!created.id ||
		created.name !== input.name ||
		(input.canonicalDescription !== undefined &&
			created.description !== input.canonicalDescription)
	) {
		throw new Error(
			`Linear label ${input.name} creation returned an unexpected identity`,
		);
	}
	return created;
}

/** Complete pagination: any unreadable page or cursor inconsistency rejects. */
export async function collectLinearPages<T>(
	fetchPage: (after: string | null) => Promise<LinearPage<T>>,
): Promise<T[]> {
	const nodes: T[] = [];
	const cursors = new Set<string>();
	let after: string | null = null;
	for (;;) {
		const page = await fetchPage(after);
		if (!Array.isArray(page.nodes) || !isRecord(page.pageInfo)) {
			throw new Error("Linear page is unreadable");
		}
		nodes.push(...page.nodes);
		if (!page.pageInfo.hasNextPage) return nodes;
		const next = page.pageInfo.endCursor;
		if (typeof next !== "string" || next.length === 0 || cursors.has(next)) {
			throw new Error("Linear pagination cursor is missing or repeated");
		}
		cursors.add(next);
		after = next;
	}
}

export type MeetingNotesAction =
	| { kind: "create_issue"; meeting: MeetingRecord }
	| {
			kind: "dispatch_notes";
			meeting: MeetingRecord;
			issue: MeetingIssueObservation;
			idempotencyKey: string;
	  }
	| {
			kind: "add_terminal_comment";
			meeting: MeetingRecord;
			issue: MeetingIssueObservation;
	  }
	| {
			kind: "cancel_issue";
			meeting: MeetingRecord;
			issue: MeetingIssueObservation;
	  };

export type MeetingNotesFailureClass =
	| "schema"
	| "identity"
	| "linear"
	| "bridge"
	| "config";

export interface MeetingNotesExecutorDeps {
	createIssue: (meeting: MeetingRecord) => Promise<unknown>;
	startRun: (input: {
		issueId: string;
		idempotencyKey: string;
	}) => Promise<{ status: number; code?: string }>;
	addComment: (issueId: string, body: string) => Promise<unknown>;
	cancelIssue: (issueId: string) => Promise<unknown>;
}

export interface MeetingNotesExecutionReport {
	completed: string[];
	pending: string[];
	errors: Array<{
		meetingId: string;
		failureClass: MeetingNotesFailureClass;
		detail: string;
	}>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
	value: unknown,
	field: string,
	options: { uuid?: boolean; iso?: boolean } = {},
): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`meeting ${field} must be a non-empty string`);
	}
	const normalized = value.trim();
	if (options.uuid && !UUID_RE.test(normalized)) {
		throw new Error(`meeting ${field} must be a UUID`);
	}
	if (options.iso && !Number.isFinite(Date.parse(normalized))) {
		throw new Error(`meeting ${field} must be an ISO timestamp`);
	}
	return normalized;
}

/** Strict subset of meeting schema v2 consumed by this pipeline. */
export function parseMeetingRecord(value: unknown): MeetingRecord {
	if (!isRecord(value)) throw new Error("meeting archive must be an object");
	if (value.schemaVersion !== 2) {
		throw new Error("meeting schemaVersion must be 2");
	}
	const statuses = new Set<MeetingStatus>([
		"scheduled",
		"starting",
		"live",
		"interrupted",
		"ended",
		"cancelled",
		"missed",
	]);
	if (
		typeof value.status !== "string" ||
		!statuses.has(value.status as MeetingStatus)
	) {
		throw new Error("meeting status is invalid");
	}
	const status = value.status as MeetingStatus;
	if (
		typeof value.durationMinutes !== "number" ||
		!Number.isInteger(value.durationMinutes) ||
		value.durationMinutes <= 0
	) {
		throw new Error("meeting durationMinutes must be a positive integer");
	}
	const endedAt =
		value.endedAt === undefined
			? undefined
			: requiredString(value.endedAt, "endedAt", { iso: true });
	if (TERMINAL_MEETING_STATUSES.has(status) && !endedAt) {
		throw new Error(`meeting endedAt is required for ${status}`);
	}
	if (value.voice !== undefined && !isRecord(value.voice)) {
		throw new Error("meeting voice must be an object");
	}
	return {
		schemaVersion: 2,
		id: requiredString(value.id, "id", { uuid: true }),
		leadId: requiredString(value.leadId, "leadId"),
		topic: requiredString(value.topic, "topic"),
		scheduledAt: requiredString(value.scheduledAt, "scheduledAt", {
			iso: true,
		}),
		durationMinutes: value.durationMinutes,
		requestedBy: requiredString(value.requestedBy, "requestedBy"),
		requestedAt: requiredString(value.requestedAt, "requestedAt", {
			iso: true,
		}),
		status,
		...(typeof value.continuesFrom === "string"
			? {
					continuesFrom: requiredString(value.continuesFrom, "continuesFrom", {
						uuid: true,
					}),
				}
			: {}),
		...(value.voice !== undefined ? { voice: value.voice } : {}),
		...(endedAt ? { endedAt } : {}),
		...(typeof value.endReason === "string"
			? { endReason: requiredString(value.endReason, "endReason") }
			: {}),
	};
}

function yamlDisplay(value: string): string {
	return JSON.stringify(value);
}

/** Human-readable trigger data. Only meeting_id is a machine identity. */
export function buildMeetingIssueDescription(meeting: MeetingRecord): string {
	return [
		"FLY-2033 meeting artifact run (managed automatically).",
		"",
		TRIGGER_MARKER,
		`meeting_id: ${meeting.id}`,
		`lead_id: ${meeting.leadId}`,
		`scheduled_at: ${meeting.scheduledAt}`,
		`topic: ${yamlDisplay(meeting.topic)}`,
		"",
		"The trusted meeting-state root comes only from .flywheel/meeting-notes.yaml.",
	].join("\n");
}

export function meetingIdFromIssueDescription(description: string): string {
	const markerCount = description.split(TRIGGER_MARKER).length - 1;
	if (markerCount !== 1) {
		throw new Error(`meeting issue must contain exactly one ${TRIGGER_MARKER}`);
	}
	const after = description.slice(
		description.indexOf(TRIGGER_MARKER) + TRIGGER_MARKER.length,
	);
	const match = after.match(/^\s*\nmeeting_id:\s*([^\s]+)\s*$/m);
	if (!match || !UUID_RE.test(match[1]!)) {
		throw new Error("meeting issue trigger block has an invalid meeting_id");
	}
	return match[1]!;
}

export function indexMeetingIssues(
	issues: readonly MeetingIssueObservation[],
): MeetingIssueIndex {
	const byMeetingId = new Map<string, MeetingIssueObservation>();
	for (const issue of issues) {
		const meetingId = meetingIdFromIssueDescription(issue.description);
		const prior = byMeetingId.get(meetingId);
		if (prior) {
			throw new Error(
				`duplicate meeting_id ${meetingId}: ${prior.identifier}, ${issue.identifier}`,
			);
		}
		byMeetingId.set(meetingId, issue);
	}
	return { byMeetingId };
}

function hasExactComment(comments: readonly string[], marker: string): boolean {
	return comments.some((body) =>
		body.split("\n").some((line) => line.trim() === marker),
	);
}

/** Independent side-effect planning; a later tick only retries the missing step. */
export function planMeetingNotesActions(
	meetings: readonly MeetingRecord[],
	issues: MeetingIssueIndex,
	context: MeetingNotesPlanningContext,
): MeetingNotesAction[] {
	const actions: MeetingNotesAction[] = [];
	const ordered = [...meetings].sort(
		(a, b) =>
			a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id),
	);
	for (const meeting of ordered) {
		const issue = issues.byMeetingId.get(meeting.id);
		if (!issue) {
			actions.push({ kind: "create_issue", meeting });
			continue;
		}
		if (!context.archivedMeetingIds.has(meeting.id)) continue;
		if (meeting.status === "ended") {
			const receipt = `${DISPATCH_RECEIPT} meeting_id=${meeting.id}`;
			if (!hasExactComment(issue.comments, receipt)) {
				actions.push({
					kind: "dispatch_notes",
					meeting,
					issue,
					idempotencyKey: `meeting-notes:v1:${meeting.id}`,
				});
			}
			continue;
		}
		if (meeting.status === "cancelled" || meeting.status === "missed") {
			const receipt = `${TERMINAL_RECEIPT} meeting_id=${meeting.id} status=${meeting.status}`;
			if (!hasExactComment(issue.comments, receipt)) {
				actions.push({ kind: "add_terminal_comment", meeting, issue });
			}
			if (
				issue.stateType.toLowerCase() !== "canceled" &&
				issue.stateName.toLowerCase() !== "canceled" &&
				issue.stateName.toLowerCase() !== "cancelled"
			) {
				actions.push({ kind: "cancel_issue", meeting, issue });
			}
		}
	}
	return actions;
}

export function findUnarchivedTerminalMeetings(
	meetings: readonly MeetingRecord[],
	issues: MeetingIssueIndex,
	context: MeetingNotesPlanningContext,
): MeetingRecord[] {
	return meetings.filter(
		(meeting) =>
			TERMINAL_MEETING_STATUSES.has(meeting.status) &&
			issues.byMeetingId.has(meeting.id) &&
			!context.archivedMeetingIds.has(meeting.id),
	);
}

/** Execute each planned effect independently; retries are driven by the next tick. */
export async function executeMeetingNotesActions(
	actions: readonly MeetingNotesAction[],
	deps: MeetingNotesExecutorDeps,
): Promise<MeetingNotesExecutionReport> {
	const completed = new Set<string>();
	const pending = new Set<string>();
	const errors: MeetingNotesExecutionReport["errors"] = [];
	for (const action of actions) {
		let failureClass: MeetingNotesFailureClass =
			action.kind === "dispatch_notes" ? "bridge" : "linear";
		try {
			switch (action.kind) {
				case "create_issue":
					await deps.createIssue(action.meeting);
					completed.add(action.meeting.id);
					break;
				case "dispatch_notes": {
					const response = await deps.startRun({
						issueId: action.issue.id,
						idempotencyKey: action.idempotencyKey,
					});
					if (response.status === 202) {
						if (response.code === "LAUNCH_PENDING") {
							pending.add(action.meeting.id);
							break;
						}
						throw new Error(
							`runs/start returned unrecognized pending response: ${response.code ?? "UNKNOWN"}`,
						);
					}
					const settled =
						(response.status >= 200 && response.status < 300) ||
						(response.status === 409 &&
							response.code === "RUN_NOT_REWORKABLE_VIA_START");
					if (!settled) {
						throw new Error(
							`runs/start failed: HTTP ${response.status} ${response.code ?? "UNKNOWN"}`,
						);
					}
					failureClass = "linear";
					await deps.addComment(
						action.issue.id,
						`${DISPATCH_RECEIPT} meeting_id=${action.meeting.id}`,
					);
					completed.add(action.meeting.id);
					break;
				}
				case "add_terminal_comment":
					await deps.addComment(
						action.issue.id,
						`${TERMINAL_RECEIPT} meeting_id=${action.meeting.id} status=${action.meeting.status}`,
					);
					completed.add(action.meeting.id);
					break;
				case "cancel_issue":
					await deps.cancelIssue(action.issue.id);
					completed.add(action.meeting.id);
					break;
			}
		} catch (error) {
			errors.push({
				meetingId: action.meeting.id,
				failureClass,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { completed: [...completed], pending: [...pending], errors };
}

export interface TranscriptRow {
	ts: string;
	role: string;
	text: string;
	generation?: number;
}

export interface TranscriptSelection {
	trusted: boolean;
	transcripts: TranscriptRow[];
	disclosures: string[];
	window?: { anchorAt: string; terminalAt: string };
}

interface EvidenceRow extends Record<string, unknown> {
	ts: string;
	kind?: string;
	sourceLine: number;
}

interface EvidenceDrop {
	sourceLine: number;
	previousTimestamp: number;
}

function parseEvidence(
	text: string,
	disclosures: Set<string>,
): { rows: EvidenceRow[]; drops: EvidenceDrop[] } {
	const rows: EvidenceRow[] = [];
	const drops: EvidenceDrop[] = [];
	let previous = Number.NEGATIVE_INFINITY;
	for (const [sourceLine, line] of text.split("\n").entries()) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			disclosures.add("excluded_malformed_evidence");
			drops.push({ sourceLine, previousTimestamp: previous });
			continue;
		}
		if (!isRecord(value) || typeof value.ts !== "string") {
			disclosures.add("excluded_malformed_evidence");
			drops.push({ sourceLine, previousTimestamp: previous });
			continue;
		}
		const timestamp = Date.parse(value.ts);
		if (!Number.isFinite(timestamp) || timestamp < previous) {
			disclosures.add("excluded_malformed_evidence");
			drops.push({ sourceLine, previousTimestamp: previous });
			continue;
		}
		previous = timestamp;
		rows.push({ ...value, sourceLine } as EvidenceRow);
	}
	return { rows, drops };
}

function parseTerminalSignal(
	signal: unknown,
	meetingId: string,
): { at: string } | null {
	if (!isRecord(signal)) return null;
	if (
		signal.schemaVersion !== 1 ||
		signal.meetingId !== meetingId ||
		(signal.state !== "ended" && signal.state !== "interrupted") ||
		typeof signal.at !== "string" ||
		!Number.isFinite(Date.parse(signal.at)) ||
		typeof signal.bootId !== "string" ||
		!UUID_RE.test(signal.bootId)
	) {
		return null;
	}
	return { at: signal.at };
}

function untrusted(disclosure: string): TranscriptSelection {
	return { trusted: false, transcripts: [], disclosures: [disclosure] };
}

/**
 * Select only the final container span whose ownership is proven by Raya's
 * terminal voice signal. voice_exit and generation are intentionally not
 * ownership signals (generation remains provenance metadata only).
 */
export function selectMeetingTranscript(input: {
	meeting: MeetingRecord;
	signal: unknown | null;
	evidenceText: string;
}): TranscriptSelection {
	if (input.meeting.status !== "ended" || !input.meeting.endedAt) {
		return untrusted("meeting_archive_not_ended");
	}
	const terminalSignal = parseTerminalSignal(input.signal, input.meeting.id);
	if (!terminalSignal) return untrusted("meeting_container_exit_unproven");

	const disclosures = new Set<string>();
	const evidence = parseEvidence(input.evidenceText, disclosures);
	const { rows } = evidence;
	const signalMs = Date.parse(terminalSignal.at);
	const endedMs = Date.parse(input.meeting.endedAt);
	const terminalMs = Math.min(signalMs, endedMs);
	const liveRows = rows.filter(
		(row) =>
			row.kind === "meeting_container_live" &&
			row.meetingId === input.meeting.id &&
			Date.parse(row.ts) <= signalMs,
	);
	const anchor = liveRows.at(-1);
	if (!anchor) {
		return {
			trusted: false,
			transcripts: [],
			disclosures: [...disclosures, "meeting_live_anchor_missing"],
		};
	}
	const anchorMs = Date.parse(anchor.ts);
	if (anchorMs >= terminalMs) {
		return {
			trusted: false,
			transcripts: [],
			disclosures: [...disclosures, "meeting_window_invalid"],
		};
	}
	const malformedInProvenSpan = evidence.drops.find(
		(drop) =>
			drop.sourceLine > anchor.sourceLine &&
			drop.previousTimestamp < terminalMs &&
			rows.some(
				(row) =>
					row.sourceLine > drop.sourceLine && Date.parse(row.ts) <= terminalMs,
			),
	);
	if (malformedInProvenSpan) {
		return {
			trusted: false,
			transcripts: [],
			disclosures: [
				...disclosures,
				"malformed_evidence_in_proven_span",
				`malformed_evidence_in_proven_span:line=${malformedInProvenSpan.sourceLine + 1}`,
			],
		};
	}

	const continuityBreak = rows.some((row) => {
		const ts = Date.parse(row.ts);
		if (ts <= anchorMs || ts > signalMs) return false;
		return (
			row.kind === "meeting_container_starting" ||
			(row.kind === "meeting_container_live" && row !== anchor)
		);
	});
	if (continuityBreak) {
		return {
			trusted: false,
			transcripts: [],
			disclosures: [...disclosures, "container_continuity_unproven"],
		};
	}

	if (liveRows.length > 1) disclosures.add("excluded_previous_container_span");
	const transcripts: TranscriptRow[] = [];
	for (const row of rows) {
		if (row.kind !== "realtime_transcript") continue;
		const ts = Date.parse(row.ts);
		if (ts === anchorMs || ts === terminalMs) {
			disclosures.add("excluded_ambiguous_boundary");
			continue;
		}
		if (ts < anchorMs || ts > terminalMs) {
			disclosures.add("excluded_outside_proven_span");
			continue;
		}
		if (
			typeof row.role !== "string" ||
			typeof row.text !== "string" ||
			row.text.trim().length === 0 ||
			(row.generation !== undefined &&
				(typeof row.generation !== "number" ||
					!Number.isInteger(row.generation)))
		) {
			disclosures.add("excluded_malformed_evidence");
			continue;
		}
		transcripts.push({
			ts: row.ts,
			role: row.role,
			text: row.text,
			...(typeof row.generation === "number"
				? { generation: row.generation }
				: {}),
		});
	}

	return {
		trusted: true,
		transcripts,
		disclosures: [...disclosures],
		window: {
			anchorAt: anchor.ts,
			terminalAt: new Date(terminalMs).toISOString(),
		},
	};
}

export const MEETING_NOTES_MARKERS = {
	trigger: TRIGGER_MARKER,
	dispatch: DISPATCH_RECEIPT,
	terminal: TERMINAL_RECEIPT,
} as const;
