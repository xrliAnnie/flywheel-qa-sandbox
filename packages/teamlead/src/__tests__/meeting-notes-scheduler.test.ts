import { describe, expect, it, vi } from "vitest";
import {
	buildMeetingIssueDescription,
	canBootstrapMeetingLabel,
	collectLinearPages,
	executeMeetingNotesActions,
	findUnarchivedTerminalMeetings,
	indexMeetingIssues,
	MEETING_LABEL_DESCRIPTION,
	type MeetingIssueObservation,
	parseMeetingRecord,
	planMeetingNotesActions,
	resolveLinearLabel,
	selectMeetingTranscript,
} from "../meeting-notes-scheduler.js";

const MEETING_ID = "11111111-1111-4111-8111-111111111111";

function meeting(
	status: "scheduled" | "ended" | "cancelled" | "missed",
): Record<string, unknown> {
	return {
		schemaVersion: 2,
		id: MEETING_ID,
		leadId: "flywheel-product-lead",
		topic: "Raya meeting artifacts",
		scheduledAt: "2026-08-29T17:00:00.000Z",
		durationMinutes: 30,
		requestedBy: "founder",
		requestedAt: "2026-08-29T16:00:00.000Z",
		status,
		...(status === "ended"
			? {
					endedAt: "2026-08-29T17:30:00.000Z",
					endReason: "she-left",
				}
			: status === "cancelled" || status === "missed"
				? { endedAt: "2026-08-29T17:30:00.000Z" }
				: {}),
	};
}

function issue(
	overrides: Partial<MeetingIssueObservation> = {},
): MeetingIssueObservation {
	return {
		id: "linear-issue-1",
		identifier: "FLY-3000",
		description: buildMeetingIssueDescription(
			parseMeetingRecord(meeting("ended")),
		),
		stateName: "In Progress",
		stateType: "started",
		comments: [],
		...overrides,
	};
}

function archiveContext(...meetingIds: string[]) {
	return { archivedMeetingIds: new Set(meetingIds) };
}

describe("meeting notes issue identity and reconciliation", () => {
	it("fully paginates beyond 250 and fails closed when a later page is unreadable", async () => {
		const pages = new Map([
			[
				null,
				{
					nodes: Array.from({ length: 250 }, (_, index) => index),
					pageInfo: { hasNextPage: true, endCursor: "page-2" },
				},
			],
			[
				"page-2",
				{
					nodes: [250],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			],
		]);
		await expect(
			collectLinearPages(async (after) => pages.get(after)!),
		).resolves.toHaveLength(251);
		await expect(
			collectLinearPages(async (after) => {
				if (after === null) return pages.get(null)!;
				throw new Error("Linear page 2 unavailable");
			}),
		).rejects.toThrow(/page 2 unavailable/);
	});

	it("uses the immutable meeting UUID in a strict trigger block", () => {
		const description = buildMeetingIssueDescription(
			parseMeetingRecord(meeting("scheduled")),
		);
		expect(description).toContain("[meeting-notes-trigger:v1]");
		expect(description).toContain(`meeting_id: ${MEETING_ID}`);
		expect(description).toContain("lead_id: flywheel-product-lead");
		expect(description).not.toContain("rayaStateDir");
		expect(description).not.toContain("/Users/");
	});

	it("creates an issue for a scheduled meeting and for an ended meeting missed by an earlier tick", () => {
		for (const status of ["scheduled", "ended"] as const) {
			const parsed = parseMeetingRecord(meeting(status));
			expect(
				planMeetingNotesActions(
					[parsed],
					indexMeetingIssues([]),
					archiveContext(...(status === "ended" ? [MEETING_ID] : [])),
				),
			).toEqual([{ kind: "create_issue", meeting: parsed }]);
		}
	});

	it("treats the selected Lead as meeting data, never as a Raya-only filter", () => {
		const rayaMeeting = parseMeetingRecord(meeting("scheduled"));
		const tadashiMeeting = parseMeetingRecord({
			...meeting("scheduled"),
			id: "22222222-2222-4222-8222-222222222222",
			leadId: "flywheel-eng-lead",
			topic: "Tadashi architecture review",
		});
		const actions = planMeetingNotesActions(
			[rayaMeeting, tadashiMeeting],
			indexMeetingIssues([]),
			archiveContext(),
		);
		expect(actions).toEqual([
			{ kind: "create_issue", meeting: rayaMeeting },
			{ kind: "create_issue", meeting: tadashiMeeting },
		]);
		expect(buildMeetingIssueDescription(tadashiMeeting)).toContain(
			"lead_id: flywheel-eng-lead",
		);
		expect(buildMeetingIssueDescription(tadashiMeeting)).not.toMatch(
			/trusted Raya/i,
		);
	});

	it("creates only the fixed meeting label when absent and fails closed on ambiguity", async () => {
		const create = vi.fn(async () => ({
			id: "label-meeting",
			name: "meeting",
			description: MEETING_LABEL_DESCRIPTION,
		}));
		await expect(
			resolveLinearLabel({
				labels: [],
				name: "meeting",
				canonicalDescription: MEETING_LABEL_DESCRIPTION,
				create,
			}),
		).resolves.toEqual({
			id: "label-meeting",
			name: "meeting",
			description: MEETING_LABEL_DESCRIPTION,
		});
		expect(create).toHaveBeenCalledTimes(1);

		await expect(
			resolveLinearLabel({
				labels: [{ id: "label-product", name: "Flywheel-Product" }],
				name: "Flywheel-Product",
			}),
		).resolves.toEqual({ id: "label-product", name: "Flywheel-Product" });
		await expect(
			resolveLinearLabel({ labels: [], name: "Flywheel-Product" }),
		).rejects.toThrow(/must resolve uniquely.*found 0/i);
		await expect(
			resolveLinearLabel({
				labels: [
					{ id: "label-a", name: "meeting" },
					{ id: "label-b", name: "meeting" },
				],
				name: "meeting",
				create,
			}),
		).rejects.toThrow(/must resolve uniquely.*found 2/i);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("never re-keys meeting history after its canonical label is renamed or removed", async () => {
		const create = vi.fn(async () => ({
			id: "new-label",
			name: "meeting",
			description: MEETING_LABEL_DESCRIPTION,
		}));
		await expect(
			resolveLinearLabel({
				labels: [
					{
						id: "old-label",
						name: "meeting-auto",
						description: MEETING_LABEL_DESCRIPTION,
					},
				],
				name: "meeting",
				canonicalDescription: MEETING_LABEL_DESCRIPTION,
				create,
			}),
		).rejects.toThrow(/canonical identity.*unexpected name/i);
		await expect(
			resolveLinearLabel({
				labels: [],
				name: "meeting",
				canonicalDescription: MEETING_LABEL_DESCRIPTION,
			}),
		).rejects.toThrow(/must resolve uniquely.*found 0/i);
		expect(create).not.toHaveBeenCalled();
	});

	it("allows meeting label creation only before any meeting evidence exists", () => {
		expect(
			canBootstrapMeetingLabel({
				meetingCount: 0,
				archivedMeetingCount: 0,
				scanErrorCount: 0,
			}),
		).toBe(true);
		for (const input of [
			{ meetingCount: 1, archivedMeetingCount: 0, scanErrorCount: 0 },
			{ meetingCount: 0, archivedMeetingCount: 1, scanErrorCount: 0 },
			{ meetingCount: 0, archivedMeetingCount: 0, scanErrorCount: 1 },
		]) {
			expect(canBootstrapMeetingLabel(input)).toBe(false);
		}
	});

	it("dispatches an ended meeting exactly until the durable receipt is present", () => {
		const parsed = parseMeetingRecord(meeting("ended"));
		const first = issue();
		expect(
			planMeetingNotesActions(
				[parsed],
				indexMeetingIssues([first]),
				archiveContext(MEETING_ID),
			),
		).toEqual([
			{
				kind: "dispatch_notes",
				meeting: parsed,
				issue: first,
				idempotencyKey: `meeting-notes:v1:${MEETING_ID}`,
			},
		]);

		const receipted = issue({
			comments: [`[meeting-notes-dispatched] meeting_id=${MEETING_ID}`],
		});
		expect(
			planMeetingNotesActions(
				[parsed],
				indexMeetingIssues([receipted]),
				archiveContext(MEETING_ID),
			),
		).toEqual([]);
	});

	it("uses a mutable terminal snapshot only to create the issue and waits for the immutable archive before dispatch", () => {
		const parsed = parseMeetingRecord(meeting("ended"));
		expect(
			planMeetingNotesActions(
				[parsed],
				indexMeetingIssues([issue()]),
				archiveContext(),
			),
		).toEqual([]);
	});

	it("surfaces a terminal snapshot that remains unarchived after its issue exists", () => {
		const parsed = parseMeetingRecord(meeting("ended"));
		expect(
			findUnarchivedTerminalMeetings(
				[parsed],
				indexMeetingIssues([issue()]),
				archiveContext(),
			),
		).toEqual([parsed]);
		expect(
			findUnarchivedTerminalMeetings(
				[parsed],
				indexMeetingIssues([]),
				archiveContext(),
			),
		).toEqual([]);
		expect(
			findUnarchivedTerminalMeetings(
				[parsed],
				indexMeetingIssues([issue()]),
				archiveContext(MEETING_ID),
			),
		).toEqual([]);
		const interrupted = parseMeetingRecord({
			...meeting("scheduled"),
			status: "interrupted",
		});
		expect(
			findUnarchivedTerminalMeetings(
				[interrupted],
				indexMeetingIssues([issue()]),
				archiveContext(),
			),
		).toEqual([]);
	});

	it("reconciles terminal comment and Canceled state as independent side effects", () => {
		for (const status of ["cancelled", "missed"] as const) {
			const parsed = parseMeetingRecord(meeting(status));
			const observed = issue();
			expect(
				planMeetingNotesActions(
					[parsed],
					indexMeetingIssues([observed]),
					archiveContext(MEETING_ID),
				),
			).toEqual([
				{ kind: "add_terminal_comment", meeting: parsed, issue: observed },
				{ kind: "cancel_issue", meeting: parsed, issue: observed },
			]);

			const withComment = issue({
				comments: [
					`[meeting-terminal:v1] meeting_id=${MEETING_ID} status=${status}`,
				],
			});
			expect(
				planMeetingNotesActions(
					[parsed],
					indexMeetingIssues([withComment]),
					archiveContext(MEETING_ID),
				),
			).toEqual([
				{ kind: "cancel_issue", meeting: parsed, issue: withComment },
			]);

			const canceled = issue({
				comments: withComment.comments,
				stateName: "Canceled",
				stateType: "canceled",
			});
			expect(
				planMeetingNotesActions(
					[parsed],
					indexMeetingIssues([canceled]),
					archiveContext(MEETING_ID),
				),
			).toEqual([]);
		}
	});

	it("fails closed when two Linear issues claim the same meeting UUID", () => {
		expect(() =>
			indexMeetingIssues([
				issue(),
				issue({ id: "linear-issue-2", identifier: "FLY-3001" }),
			]),
		).toThrow(/duplicate.*meeting_id.*11111111/i);
	});

	it("rejects malformed meeting archives instead of guessing", () => {
		expect(() =>
			parseMeetingRecord({ ...meeting("ended"), schemaVersion: 1 }),
		).toThrow(/schemaVersion/);
		expect(() =>
			parseMeetingRecord({ ...meeting("ended"), id: "not-a-uuid" }),
		).toThrow(/id/);
		expect(() =>
			parseMeetingRecord({ ...meeting("ended"), endedAt: undefined }),
		).toThrow(/endedAt/);
	});
});

describe("meeting notes side-effect convergence", () => {
	it("keeps a 202 launch pending and writes the receipt only after the same key settles", async () => {
		const parsed = parseMeetingRecord(meeting("ended"));
		const observed = issue();
		const actions = planMeetingNotesActions(
			[parsed],
			indexMeetingIssues([observed]),
			archiveContext(MEETING_ID),
		);
		const comments: string[] = [];
		const startRun = vi
			.fn()
			.mockResolvedValueOnce({ status: 202, code: "LAUNCH_PENDING" })
			.mockResolvedValueOnce({ status: 200, code: "STARTED" });
		const deps = {
			createIssue: vi.fn(),
			startRun,
			addComment: vi.fn(async (_issueId: string, body: string) => {
				comments.push(body);
			}),
			cancelIssue: vi.fn(),
		};

		const pending = await executeMeetingNotesActions(actions, deps);
		expect(pending.pending).toEqual([MEETING_ID]);
		expect(comments).toEqual([]);
		const settled = await executeMeetingNotesActions(actions, deps);
		expect(settled.completed).toEqual([MEETING_ID]);
		expect(comments).toEqual([
			`[meeting-notes-dispatched] meeting_id=${MEETING_ID}`,
		]);
		expect(startRun).toHaveBeenNthCalledWith(1, {
			issueId: observed.id,
			idempotencyKey: `meeting-notes:v1:${MEETING_ID}`,
		});
		expect(startRun).toHaveBeenNthCalledWith(2, {
			issueId: observed.id,
			idempotencyKey: `meeting-notes:v1:${MEETING_ID}`,
		});
	});

	it("fails closed on an unrecognized 202 instead of writing a false dispatch receipt", async () => {
		const actions = planMeetingNotesActions(
			[parseMeetingRecord(meeting("ended"))],
			indexMeetingIssues([issue()]),
			archiveContext(MEETING_ID),
		);
		const addComment = vi.fn();
		const report = await executeMeetingNotesActions(actions, {
			createIssue: vi.fn(),
			startRun: vi.fn(async () => ({ status: 202, code: "UNKNOWN_PENDING" })),
			addComment,
			cancelIssue: vi.fn(),
		});

		expect(report.pending).toEqual([]);
		expect(report.errors).toEqual([
			expect.objectContaining({
				meetingId: MEETING_ID,
				failureClass: "bridge",
			}),
		]);
		expect(addComment).not.toHaveBeenCalled();
	});

	it("treats a terminal idempotent replay as settled but rejects unrelated 409s", async () => {
		const parsed = parseMeetingRecord(meeting("ended"));
		const actions = planMeetingNotesActions(
			[parsed],
			indexMeetingIssues([issue()]),
			archiveContext(MEETING_ID),
		);
		const addComment = vi.fn(async () => {});
		const terminal = await executeMeetingNotesActions(actions, {
			createIssue: vi.fn(),
			startRun: vi.fn(async () => ({
				status: 409,
				code: "RUN_NOT_REWORKABLE_VIA_START",
			})),
			addComment,
			cancelIssue: vi.fn(),
		});
		expect(terminal.errors).toEqual([]);
		expect(addComment).toHaveBeenCalledTimes(1);

		const conflict = await executeMeetingNotesActions(actions, {
			createIssue: vi.fn(),
			startRun: vi.fn(async () => ({ status: 409, code: "ROUTE_CONFLICT" })),
			addComment: vi.fn(),
			cancelIssue: vi.fn(),
		});
		expect(conflict.errors[0]?.failureClass).toBe("bridge");
	});

	it("attempts terminal comment and cancel independently when either one fails", async () => {
		const parsed = parseMeetingRecord(meeting("cancelled"));
		const observed = issue();
		const addComment = vi.fn(async () => {
			throw new Error("Linear comment down");
		});
		const cancelIssue = vi.fn(async () => {});
		const report = await executeMeetingNotesActions(
			planMeetingNotesActions(
				[parsed],
				indexMeetingIssues([observed]),
				archiveContext(MEETING_ID),
			),
			{
				createIssue: vi.fn(),
				startRun: vi.fn(),
				addComment,
				cancelIssue,
			},
		);
		expect(addComment).toHaveBeenCalledTimes(1);
		expect(cancelIssue).toHaveBeenCalledTimes(1);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toMatchObject({
			meetingId: MEETING_ID,
			failureClass: "linear",
		});
	});

	it("classifies a dispatch receipt comment failure as Linear after Bridge settles", async () => {
		const report = await executeMeetingNotesActions(
			planMeetingNotesActions(
				[parseMeetingRecord(meeting("ended"))],
				indexMeetingIssues([issue()]),
				archiveContext(MEETING_ID),
			),
			{
				createIssue: vi.fn(),
				startRun: vi.fn(async () => ({ status: 200, code: "STARTED" })),
				addComment: vi.fn(async () => {
					throw new Error("Linear comment down");
				}),
				cancelIssue: vi.fn(),
			},
		);
		expect(report.errors).toEqual([
			expect.objectContaining({ failureClass: "linear" }),
		]);
	});
});

function evidence(rows: Array<Record<string, unknown> | string>): string {
	return `${rows
		.map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
		.join("\n")}\n`;
}

const LIVE_AT = "2026-08-29T17:00:05.000Z";
const SIGNAL_AT = "2026-08-29T17:29:55.000Z";

function liveRow(ts = LIVE_AT): Record<string, unknown> {
	return {
		ts,
		kind: "meeting_container_live",
		meetingId: MEETING_ID,
		leadId: "flywheel-product-lead",
		processGeneration: 4,
	};
}

function transcript(
	ts: string,
	text: string,
	generation = 7,
): Record<string, unknown> {
	return { ts, kind: "realtime_transcript", role: "user", text, generation };
}

function signal(state: "ended" | "interrupted" | "live" = "ended") {
	return {
		schemaVersion: 1,
		meetingId: MEETING_ID,
		state,
		at: SIGNAL_AT,
		bootId: "22222222-2222-4222-8222-222222222222",
		...(state === "ended" ? { reason: "she-left" } : {}),
	};
}

describe("meeting transcript ownership window", () => {
	it("includes only transcripts in the final proven container span and preserves generation as metadata", () => {
		const result = selectMeetingTranscript({
			meeting: parseMeetingRecord(meeting("ended")),
			signal: signal(),
			evidenceText: evidence([
				transcript("2026-08-29T16:59:59.000Z", "ordinary mode"),
				liveRow(),
				transcript("2026-08-29T17:01:00.000Z", "decision", 1),
				transcript("2026-08-29T17:02:00.000Z", "generation reused", 1),
				{ ts: "2026-08-29T17:25:00.000Z", kind: "voice_exit" },
				transcript("2026-08-29T17:29:56.000Z", "after signal"),
			]),
		});
		expect(result.trusted).toBe(true);
		expect(result.transcripts.map((row) => row.text)).toEqual([
			"decision",
			"generation reused",
		]);
		expect(result.transcripts.map((row) => row.generation)).toEqual([1, 1]);
		expect(result.disclosures).toContain("excluded_outside_proven_span");
	});

	it("fails closed with zero transcript when the final meeting signal is absent or non-terminal", () => {
		for (const finalSignal of [null, signal("live")]) {
			const result = selectMeetingTranscript({
				meeting: parseMeetingRecord(meeting("ended")),
				signal: finalSignal,
				evidenceText: evidence([
					liveRow(),
					transcript("2026-08-29T17:01:00.000Z", "must not leak"),
					{
						ts: "2026-08-29T17:02:00.000Z",
						kind: "voice_exit",
					},
				]),
			});
			expect(result.trusted).toBe(false);
			expect(result.transcripts).toEqual([]);
			expect(result.disclosures).toContain("meeting_container_exit_unproven");
		}
	});

	it("excludes an earlier crashed span and keeps only the span that emitted the final signal", () => {
		const result = selectMeetingTranscript({
			meeting: parseMeetingRecord(meeting("ended")),
			signal: signal(),
			evidenceText: evidence([
				liveRow("2026-08-29T17:00:05.000Z"),
				transcript("2026-08-29T17:01:00.000Z", "first span"),
				{
					ts: "2026-08-29T17:10:00.000Z",
					kind: "meeting_container_starting",
					meetingId: MEETING_ID,
				},
				liveRow("2026-08-29T17:10:05.000Z"),
				transcript("2026-08-29T17:11:00.000Z", "final span"),
			]),
		});
		expect(result.transcripts.map((row) => row.text)).toEqual(["final span"]);
		expect(result.disclosures).toContain("excluded_previous_container_span");
	});

	it("rejects a span when another container starts after its last live anchor", () => {
		const result = selectMeetingTranscript({
			meeting: parseMeetingRecord(meeting("ended")),
			signal: signal(),
			evidenceText: evidence([
				liveRow(),
				transcript("2026-08-29T17:01:00.000Z", "old owner"),
				{
					ts: "2026-08-29T17:20:00.000Z",
					kind: "meeting_container_starting",
					meetingId: "33333333-3333-4333-8333-333333333333",
				},
				transcript("2026-08-29T17:21:00.000Z", "unknown owner"),
			]),
		});
		expect(result.trusted).toBe(false);
		expect(result.transcripts).toEqual([]);
		expect(result.disclosures).toContain("container_continuity_unproven");
	});

	it("fails closed when malformed evidence inside the proven span could hide a continuity marker", () => {
		const result = selectMeetingTranscript({
			meeting: parseMeetingRecord(meeting("ended")),
			signal: signal(),
			evidenceText: evidence([
				liveRow(),
				transcript("2026-08-29T17:01:00.000Z", "before corruption"),
				'{"ts":"2026-08-29T17:02:00.000Z","kind":"meeting_container_starting"',
				transcript("2026-08-29T17:03:00.000Z", "must not leak"),
			]),
		});
		expect(result.trusted).toBe(false);
		expect(result.transcripts).toEqual([]);
		expect(result.disclosures).toContain("malformed_evidence_in_proven_span");
	});

	it("discloses a torn tail after the last accepted row without discarding the proven span", () => {
		const result = selectMeetingTranscript({
			meeting: parseMeetingRecord(meeting("ended")),
			signal: signal(),
			evidenceText: evidence([
				liveRow(),
				transcript("2026-08-29T17:01:00.000Z", "recoverable note"),
				'{"ts":"truncated tail"',
			]),
		});
		expect(result.trusted).toBe(true);
		expect(result.transcripts).toEqual([
			expect.objectContaining({ text: "recoverable note" }),
		]);
		expect(result.disclosures).toContain("excluded_malformed_evidence");
	});

	it("bounds an interrupted meeting at the signal and excludes malformed or ambiguous boundary rows", () => {
		const interrupted = {
			...signal("interrupted"),
			at: "2026-08-29T17:10:00.000Z",
		};
		const result = selectMeetingTranscript({
			meeting: parseMeetingRecord(meeting("ended")),
			signal: interrupted,
			evidenceText: evidence([
				liveRow(),
				transcript(LIVE_AT, "same timestamp as anchor"),
				transcript("2026-08-29T17:05:00.000Z", "kept"),
				transcript("2026-08-29T17:10:00.000Z", "same timestamp as signal"),
				'{"ts":"broken tail"',
			]),
		});
		expect(result.transcripts.map((row) => row.text)).toEqual(["kept"]);
		expect(result.disclosures).toContain("excluded_ambiguous_boundary");
		expect(result.disclosures).toContain("excluded_malformed_evidence");
	});
});
