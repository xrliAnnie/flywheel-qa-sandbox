import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	collectRootCauseFacts,
	fetchRootCauseChildren,
	type LinearRequest,
	parseRootCauseMetadata,
	ROOT_CAUSE_LINEAR_PROJECT_ID,
	type RootCauseAskRecord,
	type RootCauseChild,
	type RootCauseFacts,
	renderRootCauseLines,
	rootCauseScheduleKey,
	selectRootCauseCandidates,
	validateRootCauseStructure,
	verifyRootCauseEvidence,
} from "../patrol-root-causes.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
	readFileSync(join(here, "fixtures/fly2914/fly2072-children.json"), "utf8"),
) as {
	parent: { id: string; identifier: string };
	children: RootCauseChild[];
};
const PARENT = fixture.parent.id;
const NOW = Date.parse("2026-09-26T06:00:00.000Z");
const noState = {
	activeRunId: () => undefined,
	openAsk: () => undefined,
};

function child(
	n: number,
	title: string,
	description: string | null,
	state = "backlog",
): RootCauseChild {
	const hex = n.toString(16).padStart(12, "0");
	return {
		id: `00000000-0000-4000-8000-${hex}`,
		identifier: `FLY-${9000 + n}`,
		title,
		description,
		url: `https://linear.app/x/issue/FLY-${9000 + n}`,
		state: { name: state, type: state },
		parent: { id: PARENT },
		project: { id: ROOT_CAUSE_LINEAR_PROJECT_ID },
	};
}

function linear(children: RootCauseChild[], pageSize = 100): LinearRequest {
	return (async (query: string, variables: Record<string, unknown>) => {
		if (query.includes("RootCauseParent"))
			return {
				data: {
					issue: {
						id: PARENT,
						identifier: "FLY-2072",
						team: { key: "FLY" },
						project: { id: ROOT_CAUSE_LINEAR_PROJECT_ID },
					},
				},
			};
		const start = variables.after ? Number(variables.after) : 0;
		const nodes = children.slice(start, start + pageSize);
		const more = start + pageSize < children.length;
		return {
			data: {
				issue: {
					id: PARENT,
					children: {
						nodes,
						pageInfo: {
							hasNextPage: more,
							endCursor: more ? String(start + pageSize) : null,
						},
					},
				},
			},
		};
	}) as LinearRequest;
}

describe("FLY-2914 occurrence parsing", () => {
	it("takes the larger of title and description and reports the gap", () => {
		const m = parseRootCauseMetadata(
			"[病根] x · ×34",
			"class_key: `" + "a".repeat(64) + "`\noccurrences: 31",
		);
		expect(m).toMatchObject({
			titleCount: 34,
			descriptionCount: 31,
			occurrences: 34,
			classKey: "a".repeat(64),
			category: true,
		});
		expect(m.diagnostics).toContain("count_mismatch");
		expect(
			parseRootCauseMetadata("[病根] y · ×2", "occurrences: 3"),
		).toMatchObject({ occurrences: 3, titleCount: 2, descriptionCount: 3 });
	});
	it("never defaults unreadable or conflicting metadata to zero", () => {
		expect(
			parseRootCauseMetadata("[病根] z", "occurrences: -1\noccurrences: abc"),
		).toMatchObject({ occurrences: null, category: true });
		const conflict = parseRootCauseMetadata(
			"[病根] c",
			"occurrences: 2\noccurrences: 7",
		);
		expect(conflict.occurrences).toBe(7);
		expect(conflict.diagnostics).toContain("description_count_conflict");
		const overflow = parseRootCauseMetadata(
			"[病根] o · ×99999999999999999999",
			null,
		);
		expect(overflow.occurrences).toBeNull();
		expect(overflow.diagnostics).toContain("title_count_invalid");
		expect(
			parseRootCauseMetadata(
				"[病根] k",
				`class_key: ${"b".repeat(64)}\nclass_key: ${"c".repeat(64)}`,
			).diagnostics,
		).toContain("class_key_conflict");
	});
	it("treats an Epic management child without markers as non-category", () => {
		expect(parseRootCauseMetadata("[2072 盘点] 逐张核实", null).category).toBe(
			false,
		);
	});
});

describe("FLY-2914 candidate selection on the census fixture", () => {
	it("lists FLY-2373 at 34 with its 34/31 gap only while it has no active run", () => {
		const free = selectRootCauseCandidates({
			projectName: "flywheel",
			parentUuid: PARENT,
			children: fixture.children,
			state: noState,
		});
		const ids = free.candidates.map((c) => c.identifier);
		expect(ids.slice(0, 5)).toEqual([
			"FLY-2114",
			"FLY-2373",
			"FLY-2371",
			"FLY-2344",
			"FLY-2891",
		]);
		const fly2373 = free.candidates.find((c) => c.identifier === "FLY-2373")!;
		expect(fly2373).toMatchObject({
			occurrences: 34,
			titleCount: 34,
			descriptionCount: 31,
		});
		expect(fly2373.diagnostics).toContain("count_mismatch");
		// terminal, below-threshold and duplicate-state rows
		expect(ids).not.toContain("FLY-2107");
		expect(ids).not.toContain("FLY-2828");
		expect(ids).not.toContain("FLY-2892");
		// unreadable-count categories stay listed (sorted last), never silently dropped
		expect(ids.at(-1)).toMatch(/^FLY-(2637|2721)$/);
		expect(
			free.candidates.find((c) => c.identifier === "FLY-2637")?.occurrences,
		).toBeNull();
		const missingKey = free.candidates.find(
			(c) => c.identifier === "FLY-2120",
		)!;
		expect(missingKey.classKey).toBeNull();
		expect(missingKey.diagnostics).toContain("class_key_missing");

		const activeRunId = vi.fn((_project: string, aliases: string[]) =>
			aliases.includes("FLY-2373") ? "run-2373" : undefined,
		);
		const busy = selectRootCauseCandidates({
			projectName: "flywheel",
			parentUuid: PARENT,
			children: fixture.children,
			state: { ...noState, activeRunId },
		});
		expect(busy.candidates.map((c) => c.identifier)).not.toContain("FLY-2373");
		expect(busy.excluded).toEqual([
			expect.objectContaining({
				identifier: "FLY-2373",
				runId: "run-2373",
				titleCount: 34,
				descriptionCount: 31,
				diagnostics: expect.arrayContaining(["count_mismatch"]),
			}),
		]);
		const call = activeRunId.mock.calls.find((c) => c[1][0] === "FLY-2373")!;
		expect(call[1]).toEqual([
			"FLY-2373",
			fixture.children.find((c) => c.identifier === "FLY-2373")!.id,
		]);
	});
	it("excludes a UUID-keyed active run and ignores another project's run", () => {
		const c = child(1, "[病根] a · ×5", "occurrences: 5");
		const activeRunId = (project: string, aliases: string[]) =>
			project === "flywheel" && aliases.includes(c.id) ? "uuid-run" : undefined;
		expect(
			selectRootCauseCandidates({
				projectName: "flywheel",
				parentUuid: PARENT,
				children: [c],
				state: { ...noState, activeRunId },
			}).candidates,
		).toEqual([]);
	});
	it("keeps duplicate class keys as separate items and flags them", () => {
		const key = "d".repeat(64);
		const result = selectRootCauseCandidates({
			projectName: "flywheel",
			parentUuid: PARENT,
			children: [
				child(1, "[病根] a · ×3", `class_key: ${key}`),
				child(2, "[病根] b · ×4", `class_key: ${key}`),
			],
			state: noState,
		});
		expect(result.candidates).toHaveLength(2);
		expect(
			result.candidates.every((c) =>
				c.diagnostics.includes("duplicate_class_key"),
			),
		).toBe(true);
		expect(result.candidates[0]!.scheduleKey).not.toBe(
			result.candidates[1]!.scheduleKey,
		);
	});
	it("uses a key that survives title/count edits but not a rebuilt child", () => {
		const base = {
			projectName: "flywheel",
			parentUuid: PARENT,
			childUuid: child(1, "", null).id,
			classKey: "e".repeat(64),
		};
		expect(rootCauseScheduleKey(base)).toBe(rootCauseScheduleKey({ ...base }));
		expect(
			rootCauseScheduleKey({ ...base, childUuid: child(2, "", null).id }),
		).not.toBe(rootCauseScheduleKey(base));
		expect(rootCauseScheduleKey({ ...base, classKey: null })).not.toBe(
			rootCauseScheduleKey(base),
		);
	});
});

describe("FLY-2914 read-only paginated Linear source", () => {
	const many = Array.from({ length: 215 }, (_, i) =>
		child(i + 1, `[病根] c${i} · ×${i % 5}`, `occurrences: ${i % 5}`),
	);
	it("reads every page (archived included) and only issues queries", async () => {
		const request = vi.fn(linear(many));
		const result = await fetchRootCauseChildren(
			request as LinearRequest,
			NOW + 30_000,
			() => NOW,
		);
		expect(result.children).toHaveLength(215);
		expect(result.pages).toBe(3);
		for (const [query] of request.mock.calls) {
			expect(query).toMatch(/^query /);
			expect(query).not.toMatch(/mutation/i);
		}
		expect(request.mock.calls[1]![0]).toContain("includeArchived: true");
	});
	it.each([
		[
			"cursor cycle",
			(async (q: string) =>
				q.includes("RootCauseParent")
					? linear([])(q, {})
					: {
							data: {
								issue: {
									id: PARENT,
									children: {
										nodes: [],
										pageInfo: { hasNextPage: true, endCursor: "same" },
									},
								},
							},
						}) as LinearRequest,
			"cursor_invalid",
		],
		[
			"missing cursor",
			(async (q: string) =>
				q.includes("RootCauseParent")
					? linear([])(q, {})
					: {
							data: {
								issue: {
									id: PARENT,
									children: {
										nodes: [],
										pageInfo: { hasNextPage: true, endCursor: null },
									},
								},
							},
						}) as LinearRequest,
			"cursor_invalid",
		],
		[
			"GraphQL/HTTP failure (429)",
			(async () => {
				throw new Error("Linear 429");
			}) as LinearRequest,
			"linear_request_failed",
		],
		[
			"foreign parent",
			(async (q: string) =>
				q.includes("RootCauseParent")
					? {
							data: {
								issue: {
									id: PARENT,
									identifier: "FLY-2072",
									team: { key: "FLY" },
									project: { id: "other" },
								},
							},
						}
					: linear([])(q, {})) as LinearRequest,
			"parent_scope_mismatch",
		],
		[
			"child under another parent",
			linear([{ ...child(1, "x", null), parent: { id: "other" } }]),
			"child_parent_mismatch",
		],
		[
			"duplicate child",
			linear([child(1, "x", null), child(1, "x", null)]),
			"duplicate_child",
		],
	])("fails closed on %s", async (_name, request, token) => {
		await expect(
			fetchRootCauseChildren(request, NOW + 30_000, () => NOW),
		).rejects.toMatchObject({ token });
	});
	it("returns unavailable (never an empty healthy list) past the deadline", async () => {
		let t = NOW;
		const slow = (async (q: string, v: Record<string, unknown>) => {
			t += 20_000;
			return linear(many)(q, v);
		}) as LinearRequest;
		const facts = await collectRootCauseFacts({
			projectName: "flywheel",
			leadId: "flywheel-eng-lead",
			request: slow,
			state: noState,
			now: () => t,
		});
		expect(facts).toMatchObject({ status: "unavailable", candidates: [] });
		expect(renderRootCauseLines(facts)).toContain(
			"UNAVAILABLE_CAUSE step=6 class=transient token=root_cause_source_unavailable",
		);
	});
	it("records not_applicable for other projects and non-owner Leads without reading Linear", async () => {
		const request = vi.fn();
		for (const [projectName, leadId, token] of [
			["geoforge3d", "product-lead", "project_scope"],
			["flywheel", "flywheel-product-lead", "owner:flywheel-eng-lead"],
		]) {
			const facts = await collectRootCauseFacts({
				projectName: projectName!,
				leadId: leadId!,
				request: request as unknown as LinearRequest,
				state: noState,
			});
			expect(facts).toMatchObject({ status: "not_applicable", token });
		}
		expect(request).not.toHaveBeenCalled();
	});
});

async function factsFor(
	children: RootCauseChild[],
	state = noState as Parameters<typeof collectRootCauseFacts>[0]["state"],
): Promise<RootCauseFacts> {
	return collectRootCauseFacts({
		projectName: "flywheel",
		leadId: "flywheel-eng-lead",
		request: linear(children),
		state,
		now: () => NOW,
	});
}

function report(lines: string[], step6 = "FINDING"): string {
	return [
		"# Lead Patrol Snapshot",
		"patrol_schema=2",
		"project: flywheel",
		"lead: flywheel-eng-lead",
		"## STEP 6",
		`STEP 6: ${step6}`,
		...lines,
		"MECHANISM_REVIEW result=none count=0",
	].join("\n");
}

function scheduled(
	facts: RootCauseFacts,
	index: number,
	over: Record<string, unknown> = {},
): string[] {
	const c = facts.candidates[index]!;
	return [
		`FINDING id=${c.findingId} category=incident step=6 bridge_problem=no result=escalated-with-plan evidence=${c.ref} owner=agent:flywheel-eng-lead next=inspect:rootcause-schedule epic=n/a epic_marker=n/a disposition_ref=${c.ref}`,
		`ROOT_CAUSE_DISPOSITION ${JSON.stringify({
			ref: c.ref,
			findingId: c.findingId,
			scheduleKey: c.scheduleKey,
			mode: "scheduled",
			askId: null,
			threadId: null,
			messageId: null,
			reason: "排在 FLY-2915 盘点之后，由工程 Lead 复查",
			owner: "agent:flywheel-eng-lead",
			nextReviewAt: "2026-09-28T06:00:00.000Z",
			sourceDigest: facts.sourceDigest,
			...over,
		})}`,
	];
}

function reported(
	facts: RootCauseFacts,
	index: number,
	mode: "reported" | "waiting_founder" = "reported",
): string[] {
	const c = facts.candidates[index]!;
	return [
		`FINDING id=${c.findingId} category=incident step=6 bridge_problem=no result=escalated-with-plan evidence=${c.ref} owner=founder next=route:rootcause-schedule epic=n/a epic_marker=n/a disposition_ref=${c.ref}`,
		`ROOT_CAUSE_DISPOSITION ${JSON.stringify({
			ref: c.ref,
			findingId: c.findingId,
			scheduleKey: c.scheduleKey,
			mode,
			askId: "11111111-1111-4111-8111-111111111111",
			threadId: "1553272103002701905",
			messageId: "1553272103002709999",
			reason: null,
			owner: "founder",
			nextReviewAt: null,
			sourceDigest: facts.sourceDigest,
		})}`,
	];
}

const twoCategories = [
	child(1, "[病根] alpha · ×5", `class_key: ${"1".repeat(64)}\noccurrences: 5`),
	child(2, "[病根] beta · ×3", `class_key: ${"2".repeat(64)}\noccurrences: 3`),
];

describe("FLY-2914 completion gate structure", () => {
	it("fails when the list has a candidate but no disposition", async () => {
		const facts = await factsFor(twoCategories.slice(0, 1));
		const text = report(renderRootCauseLines(facts, { nowMs: NOW }));
		expect(validateRootCauseStructure(text).errors).toContain(
			"root_cause_disposition_missing",
		);
	});
	it("fails when only one of two candidates is disposed, and passes when both are", async () => {
		const facts = await factsFor(twoCategories);
		const section = renderRootCauseLines(facts, { nowMs: NOW });
		expect(
			validateRootCauseStructure(report([...section, ...scheduled(facts, 0)]))
				.errors,
		).toContain("root_cause_disposition_missing");
		expect(
			validateRootCauseStructure(
				report([...section, ...scheduled(facts, 0), ...scheduled(facts, 1)]),
			).errors,
		).toEqual([]);
	});
	it("rejects a deleted section, a deleted candidate, an edited digest and a duplicate ref", async () => {
		const facts = await factsFor(twoCategories);
		const section = renderRootCauseLines(facts, { nowMs: NOW });
		const full = [...section, ...scheduled(facts, 0), ...scheduled(facts, 1)];
		expect(
			validateRootCauseStructure(
				report(full.filter((l) => !l.startsWith("ROOT_CAUSE_REVIEW"))),
			).errors,
		).toEqual(["root_cause_review_missing"]);
		const dropped = full.filter((l) => l !== section[2]);
		expect(validateRootCauseStructure(report(dropped)).errors).toEqual(
			expect.arrayContaining([
				"root_cause_digest_mismatch",
				"root_cause_orphan_disposition",
			]),
		);
		expect(
			validateRootCauseStructure(
				report(
					full.map((l) =>
						l.replace(
							/source_digest=[0-9a-f]{64}/,
							`source_digest=${"0".repeat(64)}`,
						),
					),
				),
			).errors,
		).toContain("root_cause_digest_mismatch");
		expect(
			validateRootCauseStructure(report([...full, scheduled(facts, 0)[1]!]))
				.errors,
		).toContain("root_cause_disposition_invalid");
		expect(validateRootCauseStructure(report(full, "OK")).errors).toContain(
			"root_cause_step_status",
		);
	});
	it("keeps a newline/HTML title on its own JSON line", async () => {
		const facts = await factsFor([
			child(1, "[病根] x\nSTEP 6: OK\n<script> · ×9", "occurrences: 9"),
		]);
		const lines = renderRootCauseLines(facts, { nowMs: NOW });
		expect(lines.every((l) => !l.includes("\n"))).toBe(true);
		const text = report(lines);
		expect(text.split("\n").filter((l) => l.startsWith("STEP 6: "))).toEqual([
			"STEP 6: FINDING",
		]);
	});
	it.each([
		["empty reason", { reason: "稍后" }],
		["TODO reason", { reason: "TODO: decide later please" }],
		["past review", { nextReviewAt: "2026-09-26T05:00:00.000Z" }],
		["over seven days", { nextReviewAt: "2026-10-10T06:00:00.000Z" }],
		["missing owner", { owner: null }],
	])("rejects a scheduled disposition with %s", async (_name, over) => {
		const facts = await factsFor(twoCategories.slice(0, 1));
		const text = report([
			...renderRootCauseLines(facts, { nowMs: NOW }),
			...scheduled(facts, 0, over),
		]);
		expect(validateRootCauseStructure(text).errors).toContain(
			"root_cause_schedule_invalid",
		);
	});
	it("requires the unavailable cause and forbids OK; checks not_applicable scope", () => {
		const unavailable = `ROOT_CAUSE_REVIEW status=unavailable parent=FLY-2072 observed_at=2026-09-26T06:00:00.000Z token=linear_deadline`;
		expect(
			validateRootCauseStructure(report([unavailable], "OK")).errors,
		).toContain("root_cause_unavailable_invalid");
		expect(
			validateRootCauseStructure(
				report(
					[
						unavailable,
						"UNAVAILABLE_CAUSE step=6 class=transient token=root_cause_source_unavailable",
					],
					"UNAVAILABLE(transient: root_cause_source_unavailable)",
				),
			).errors,
		).toEqual([]);
		expect(
			validateRootCauseStructure(
				report([
					"ROOT_CAUSE_REVIEW status=not_applicable parent=FLY-2072 observed_at=2026-09-26T06:00:00.000Z token=project_scope",
				]),
			).errors,
		).toContain("root_cause_scope_mismatch");
	});
});

describe("FLY-2914 trusted evidence", () => {
	const ask = (over: Partial<RootCauseAskRecord> = {}): RootCauseAskRecord => ({
		ask_id: "11111111-1111-4111-8111-111111111111",
		project_name: "flywheel",
		lead_id: "flywheel-eng-lead",
		thread_id: "1553272103002701905",
		message_id: "1553272103002709999",
		asked_at: "2026-09-26T06:05:00.000Z",
		settled_at: null,
		settled_by: null,
		patrol_schedule_key: null,
		...over,
	});
	it("accepts only an exact bound, delivered ask from this round", async () => {
		const facts = await factsFor(twoCategories.slice(0, 1));
		const key = facts.candidates[0]!.scheduleKey;
		const text = report([
			...renderRootCauseLines(facts, { nowMs: NOW }),
			...reported(facts, 0),
		]);
		const verify = (row?: RootCauseAskRecord) =>
			verifyRootCauseEvidence(text, { getAsk: () => row, nowMs: NOW }).errors;
		expect(verify(ask({ patrol_schedule_key: key }))).toEqual([]);
		expect(verify(undefined)).toContain("root_cause_ask_unbound");
		expect(verify(ask({ patrol_schedule_key: "f".repeat(64) }))).toContain(
			"root_cause_ask_unbound",
		);
		expect(
			verify(
				ask({ patrol_schedule_key: key, thread_id: "1553272103002700000" }),
			),
		).toContain("root_cause_ask_unbound");
		expect(
			verify(ask({ patrol_schedule_key: key, message_id: null })),
		).toContain("root_cause_ask_unbound");
		expect(
			verify(ask({ patrol_schedule_key: key, project_name: "other" })),
		).toContain("root_cause_ask_unbound");
		expect(
			verify(
				ask({
					patrol_schedule_key: key,
					settled_at: "2026-09-26T06:06:00.000Z",
					settled_by: "send_failed",
				}),
			),
		).toContain("root_cause_ask_not_delivered");
		expect(
			verify(
				ask({ patrol_schedule_key: key, asked_at: "2026-09-25T06:05:00.000Z" }),
			),
		).toContain("root_cause_report_not_this_round");
	});
	it("pre-fills waiting_founder from an open delivered ask and stops accepting it once settled", async () => {
		const open = ask();
		const facts = await factsFor(twoCategories.slice(0, 1), {
			activeRunId: () => undefined,
			openAsk: () => ({
				ask_id: open.ask_id,
				thread_id: open.thread_id,
				message_id: open.message_id,
				asked_at: "2026-09-25T01:00:00.000Z",
			}),
		});
		const key = facts.candidates[0]!.scheduleKey;
		const text = report(renderRootCauseLines(facts, { nowMs: NOW }));
		expect(text).toContain('"mode":"waiting_founder"');
		const bound = ask({
			patrol_schedule_key: key,
			asked_at: "2026-09-25T01:00:00.000Z",
		});
		expect(
			verifyRootCauseEvidence(text, { getAsk: () => bound, nowMs: NOW }).errors,
		).toEqual([]);
		expect(
			verifyRootCauseEvidence(text, {
				getAsk: () => ({
					...bound,
					settled_at: "2026-09-26T06:30:00.000Z",
					settled_by: "founder_reply",
				}),
				nowMs: NOW,
			}).errors,
		).toContain("root_cause_waiting_settled");
	});
	it("carries an unexpired scheduled disposition forward and drops an expired one", async () => {
		const facts = await factsFor(twoCategories);
		const prior = report([
			...renderRootCauseLines(facts, { nowMs: NOW }),
			...scheduled(facts, 0),
			...scheduled(facts, 1, { nextReviewAt: "2026-09-26T07:00:00.000Z" }),
		]);
		const later = Date.parse("2026-09-26T08:00:00.000Z");
		const next = renderRootCauseLines(facts, {
			priorReport: prior,
			nowMs: later,
		});
		expect(
			next.filter((l) => l.startsWith("ROOT_CAUSE_DISPOSITION")),
		).toHaveLength(1);
		const text = report(next);
		expect(validateRootCauseStructure(text).errors).toEqual([
			"root_cause_disposition_missing",
		]);
		expect(
			verifyRootCauseEvidence(report([...next, ...scheduled(facts, 1)]), {
				getAsk: () => undefined,
				nowMs: Date.parse("2026-09-29T00:00:00.000Z"),
			}).errors,
		).toContain("root_cause_schedule_expired");
	});
	it("marks a Lead-edited shell report stale when fresh facts show a hidden category", async () => {
		const both = await factsFor(twoCategories);
		const one = await factsFor(twoCategories.slice(0, 1));
		const text = report([
			...renderRootCauseLines(one, { nowMs: NOW }),
			...scheduled(one, 0),
		]);
		expect(
			verifyRootCauseEvidence(text, {
				getAsk: () => undefined,
				nowMs: NOW,
				fresh: both,
			}).errors,
		).toContain("root_cause_snapshot_stale");
		expect(
			verifyRootCauseEvidence(text, {
				getAsk: () => undefined,
				nowMs: NOW,
				fresh: { ...both, status: "unavailable", candidates: [] },
			}).errors,
		).toContain("root_cause_verifier_unavailable");
		const faked = report(
			[
				"ROOT_CAUSE_REVIEW status=unavailable parent=FLY-2072 observed_at=2026-09-26T06:00:00.000Z token=linear_deadline",
				"UNAVAILABLE_CAUSE step=6 class=transient token=root_cause_source_unavailable",
			],
			"UNAVAILABLE(transient: root_cause_source_unavailable)",
		);
		expect(
			verifyRootCauseEvidence(faked, {
				getAsk: () => undefined,
				nowMs: NOW,
				fresh: both,
			}).errors,
		).toContain("root_cause_snapshot_stale");
	});
});
