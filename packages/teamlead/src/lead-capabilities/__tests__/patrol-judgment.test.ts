import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { applyPatrolJudgment } from "../patrol-judgment.js";

const hash = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
it("updates the same report, preserves pane facts, and returns actual completion gates", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-judgment-")));
	const path = join(root, "report.md");
	const rules = realpathSync(resolve("lead-rules-base/runbooks/patrol-v1.md"));
	const pane = `PANE_EVIDENCE pane=%1 schema=2 activity=STALLED_60M activity_evidence=${"c".repeat(64)} target=target owner=owned exec=exec capture_sha256=${"a".repeat(64)} state_sha256=${"b".repeat(64)} last_change_epoch=1 findings=STALLED_60M action=REQUIRED result=UNSET`;
	const activity = `ACTIVITY_EVIDENCE id=${"c".repeat(64)} exec=exec activation=activation interval_start=100 interval_end=3700 source=remote_ref ref_complete=yes refs_sha256=${"d".repeat(64)} semantic_sha256=${"d".repeat(64)} coverage_since=100 reason=unchanged branch_activity=no\nACTIVITY_RECORD ${JSON.stringify({ id: "c".repeat(64), entry: { identity: { executionId: "exec", activationId: "activation" }, sourcesComplete: true, semanticDigest: "d".repeat(64), coverageSinceMs: 100000, refs: [{ repoIdentity: "github:org/repo", fullRef: "refs/heads/feature", headSha: "e".repeat(40) }] }, sampledAtMs: 3700000, activity: "STALLED_60M", interval_start: 100, interval_end: 3700 })}`;
	const initial = `patrol_schema=2\nROOT_CAUSE_REVIEW status=not_applicable parent=FLY-2072 observed_at=2026-09-26T00:00:00.000Z token=project_scope\nMECHANISM_REVIEW result=LEAD-JUDGMENT-REQUIRED\n${Array.from(
		{ length: 6 },
		(_, i) =>
			`## STEP ${i + 1}\nSTEP ${i + 1}: ${i === 1 ? "FINDING-CANDIDATE" : "OK"}\n${i === 1 ? `pane_count=1\n${pane}\n${activity}` : i === 4 ? "disk_below_threshold=no" : ""}`,
	).join("\n")}\n## STEP DWELL\nSTEP DWELL: OK\n`;
	writeFileSync(path, initial, { mode: 0o600 });
	const options = {
		source: { path: rules, sha256: hash(readFileSync(rules)) },
		report: {
			path,
			sha256: hash(initial),
			tickId: "1",
			evidenceHandle: "evidence",
		},
		secrets: [],
		assertCurrent: () => {},
	};
	const input = {
		mechanismReview: { result: "none", count: 0 },
		tickId: "1",
		executionId: "exec",
		evidenceHandle: "evidence",
		step: 2,
		judgment: "unhealthy",
		findings: [
			{
				id: "a".repeat(64),
				category: "incident",
				bridgeProblem: false,
				result: "advanced",
				evidence: "receipt-1",
				owner: "n/a",
				next: "n/a",
				epic: "n/a",
				epicMarker: "n/a",
			},
		],
		paneResults: [{ pane: "%1", action: "sent-resume", result: "advanced" }],
	};
	try {
		expect(() =>
			applyPatrolJudgment({
				...options,
				input: { ...input, evidenceHandle: "foreign" },
			}),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(initial);
		expect(() =>
			applyPatrolJudgment({
				...options,
				input: { ...input, judgment: "unknown", findings: [] },
			}),
		).toThrow();
		expect(() =>
			applyPatrolJudgment({
				...options,
				input: {
					...input,
					paneResults: [
						{ pane: "%1", action: "sent\nSTEP 6: OK", result: "advanced" },
					],
				},
			}),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(initial);
		const result = applyPatrolJudgment({ ...options, input });
		expect(result.complete).toBe(true);
		const after = readFileSync(path, "utf8");
		expect(after).toContain(
			pane.replace(
				"action=REQUIRED result=UNSET",
				"action=sent-resume result=advanced",
			),
		);
		expect(after).toContain("STEP 2: FINDING");
		expect(after).toContain(
			`FINDING id=${"a".repeat(64)} category=incident step=2 bridge_problem=no result=advanced`,
		);
		expect(() => applyPatrolJudgment({ ...options, input })).toThrow();
		expect(readFileSync(path, "utf8")).toBe(after);
		const unknown = applyPatrolJudgment({
			...options,
			report: { ...options.report, sha256: hash(after) },
			input: {
				...input,
				judgment: "unknown",
				findings: [],
				unavailable: { class: "structural", token: "evidence_unavailable" },
			},
		});
		expect(unknown.complete).toBe(true);
		expect(readFileSync(path, "utf8")).toContain(
			"STEP 2: UNAVAILABLE(structural: evidence_unavailable)",
		);
		expect(readFileSync(path, "utf8")).toContain(
			"UNAVAILABLE_CAUSE step=2 class=structural token=evidence_unavailable",
		);
		const beforeRepeat = readFileSync(path, "utf8");
		applyPatrolJudgment({
			...options,
			report: { ...options.report, sha256: hash(beforeRepeat) },
			input: {
				...input,
				judgment: "unknown",
				findings: [],
				unavailable: { class: "structural", token: "evidence_unavailable" },
			},
		});
		expect(readFileSync(path, "utf8")).toBe(beforeRepeat);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("FLY-2914 closes root-cause candidates through judgment dispositions and trusted ask evidence", async () => {
	const {
		renderRootCauseLines,
		rootCauseSourceDigest,
		selectRootCauseCandidates,
		verifyRootCauseEvidence,
	} = await import("../../patrol-root-causes.js");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-rootcause-")));
	const path = join(root, "report.md");
	const rules = realpathSync(resolve("lead-rules-base/runbooks/patrol-v1.md"));
	const parent = "5914cef5-05bf-45a3-be14-edbc858147a2";
	const ask = {
		ask_id: "11111111-1111-4111-8111-111111111111",
		thread_id: "1553272103002701905",
		message_id: "1553272103002709999",
		asked_at: "2026-09-25T01:00:00.000Z",
	};
	const children = [1, 2].map((n) => ({
		id: `00000000-0000-4000-8000-00000000000${n}`,
		identifier: `FLY-900${n}`,
		title: `[病根] c${n} · ×${n + 3}`,
		description: `class_key: ${String(n).repeat(64)}`,
		url: `https://linear.app/x/issue/FLY-900${n}`,
		state: { name: "Backlog", type: "backlog" },
		parent: { id: parent },
		project: null,
	}));
	const selected = selectRootCauseCandidates({
		projectName: "flywheel",
		parentUuid: parent,
		children,
		state: {
			activeRunId: () => undefined,
			openAsk: (_p, key) =>
				key ===
				selectRootCauseCandidates({
					projectName: "flywheel",
					parentUuid: parent,
					children: [children[0]!],
					state: { activeRunId: () => undefined, openAsk: () => undefined },
				}).candidates[0]!.scheduleKey
					? ask
					: undefined,
		},
	});
	const facts = {
		version: 1 as const,
		status: "complete" as const,
		token: null,
		projectName: "flywheel",
		leadId: "flywheel-eng-lead",
		observedAt: "2026-09-26T06:00:00.000Z",
		parentUuid: parent,
		children: 2,
		pages: 1,
		nonCategory: 0,
		candidates: selected.candidates,
		excluded: [],
		sourceDigest: rootCauseSourceDigest(selected.candidates),
	};
	const section = renderRootCauseLines(facts, {
		nowMs: Date.parse(facts.observedAt),
	});
	const initial = `# Lead Patrol Snapshot\npatrol_schema=2\nproject: flywheel\nlead: flywheel-eng-lead\n${Array.from(
		{ length: 6 },
		(_, i) =>
			`## STEP ${i + 1}\nSTEP ${i + 1}: ${i === 5 ? "LEAD-JUDGMENT-REQUIRED" : "OK"}\n${i === 1 ? "pane_count=0" : i === 4 ? "disk_below_threshold=no" : i === 5 ? `${section.join("\n")}\nMECHANISM_REVIEW result=LEAD-JUDGMENT-REQUIRED` : ""}`,
	).join("\n")}\n## STEP DWELL\nSTEP DWELL: OK\n`;
	writeFileSync(path, initial, { mode: 0o600 });
	const waiting = selected.candidates.find((c) => c.waiting)!;
	const fresh = selected.candidates.find((c) => !c.waiting)!;
	const bound = {
		...ask,
		project_name: "flywheel",
		lead_id: "flywheel-eng-lead",
		settled_at: null,
		settled_by: null,
		patrol_schedule_key: waiting.scheduleKey,
	};
	const options = (
		text: string,
		getAsk = (id: string) => (id === ask.ask_id ? bound : undefined),
	) => ({
		source: { path: rules, sha256: hash(readFileSync(rules)) },
		report: {
			path,
			sha256: hash(text),
			tickId: "1",
			evidenceHandle: "evidence",
		},
		secrets: [],
		assertCurrent: () => {},
		verifyRootCauses: (report: string) =>
			verifyRootCauseEvidence(report, {
				getAsk,
				nowMs: Date.parse("2026-09-26T06:10:00.000Z"),
			}),
	});
	const base = {
		mechanismReview: { result: "none", count: 0 },
		tickId: "1",
		executionId: "exec",
		evidenceHandle: "evidence",
		step: 6,
		judgment: "unhealthy",
	};
	try {
		// Only the pre-filled waiting category is disposed: gate 3 must fail.
		const partial = applyPatrolJudgment({
			...options(initial),
			input: { ...base, findings: [] },
		});
		expect(partial.complete).toBe(false);
		expect(partial.gates[2]!.passed).toBe(false);
		const afterPartial = readFileSync(path, "utf8");
		expect(afterPartial).toContain(`evidence=${waiting.ref}`);
		expect(afterPartial).toContain("STEP 6: FINDING");
		const finding = {
			id: fresh.findingId,
			category: "incident",
			dispositionRef: fresh.ref,
			bridgeProblem: false,
			result: "escalated-with-plan",
			evidence: fresh.ref,
			owner: "agent:flywheel-eng-lead",
			next: "inspect:rootcause-schedule",
			epic: "n/a",
			epicMarker: "n/a",
		};
		const disposition = {
			ref: fresh.ref,
			findingId: fresh.findingId,
			scheduleKey: fresh.scheduleKey,
			mode: "scheduled",
			askId: null,
			threadId: null,
			messageId: null,
			reason: "排在 FLY-2915 盘点之后复查，由工程 Lead 负责",
			owner: "agent:flywheel-eng-lead",
			nextReviewAt: "2026-09-28T06:00:00.000Z",
			sourceDigest: facts.sourceDigest,
		};
		const complete = applyPatrolJudgment({
			...options(afterPartial),
			input: {
				...base,
				findings: [finding],
				rootCauseDispositions: [disposition],
			},
		});
		expect(complete.gates.map((g) => g.passed)).toEqual([true, true, true]);
		const afterComplete = readFileSync(path, "utf8");
		// the waiting category's pre-filled finding survived the step-6 rewrite
		expect(afterComplete).toContain(`evidence=${waiting.ref}`);
		// the same report fails once the bound ask can no longer be proven
		expect(
			applyPatrolJudgment({
				...options(afterComplete, () => undefined),
				input: {
					...base,
					findings: [finding],
					rootCauseDispositions: [disposition],
				},
			}).complete,
		).toBe(false);
		// an ordinary incident still cannot carry a disposition reference
		expect(() =>
			applyPatrolJudgment({
				...options(readFileSync(path, "utf8")),
				input: {
					...base,
					findings: [
						{ ...finding, evidence: "ordinary", dispositionRef: "ordinary" },
					],
				},
			}),
		).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
