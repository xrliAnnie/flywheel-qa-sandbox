import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePatrolReport } from "../patrol-report.js";

const id = "a".repeat(64),
	key = "b".repeat(64);
const uuid = "123e4567-e89b-12d3-a456-426614174000";
function report(mode = "existing") {
	const absent = mode === "no_issue";
	const d = {
		ref: "disposition:one",
		findingId: id,
		mode,
		reason: absent
			? "没有相关 Linear 源 issue，因此仅记录报告内的不立单理由"
			: "该机制问题已经核对并明确记录处理原因",
		issueIdentifier: absent ? null : "FLY-1945",
		issueUuid: absent ? null : uuid,
		issueUrl: absent
			? null
			: "https://linear.app/geoforge3d/issue/FLY-1945/example",
		receiptUuid: absent ? null : uuid,
		verifiedAt: absent ? null : "2026-09-14T12:00:00Z",
		rootCause: "冻结状态行导致真实任务进展未计入",
		counterexample: "输入未变状态行但已有推送，原报停滞，应报活跃",
		dedupEvidence: absent
			? null
			: {
					complete: true,
					includeArchived: true,
					fullDescriptions: true,
					beforeCount: mode === "created" ? 0 : 1,
					afterCount: 1,
					markerVerified: true,
					classKey: key,
					findingId: id,
					scopeVerified: true,
				},
		linear_record: absent ? "not_applicable" : "issue",
	};
	return [
		"patrol_schema=2",
		"MECHANISM_REVIEW result=findings count=1",
		"STEP 6: FINDING",
		`MECHANISM_DEFECT id=${id} step=6 class_key=${key} root_cause_ref=disposition:one counterexample_ref=disposition:one`,
		`FINDING id=${id} category=mechanism_defect step=6 bridge_problem=no result=advanced evidence=fixture owner=n/a next=n/a epic=n/a epic_marker=n/a disposition=${mode} repair_issue=${absent ? "n/a" : "FLY-1945"} repair_receipt=${absent ? "n/a" : uuid} disposition_ref=disposition:one`,
		`MECHANISM_DISPOSITION ${JSON.stringify(d)}`,
	].join("\n");
}
describe("patrol report closure", () => {
	it("rejects the recorded baseline gap", () =>
		expect(
			validatePatrolReport(
				readFileSync(
					join(
						__dirname,
						"../../../../engineering/doc/FLY-1945-patrol-evidence-gate/current-gate-gap.txt",
					),
					"utf8",
				),
			).valid,
		).toBe(false));
	for (const mode of ["existing", "created", "no_issue"])
		it(`accepts complete ${mode}`, () =>
			expect(validatePatrolReport(report(mode))).toEqual({
				valid: true,
				errors: [],
			}));
	it("accepts no_issue with a source-issue comment receipt", () => {
		const value = report()
			.replace("disposition=existing", "disposition=no_issue")
			.replace("repair_issue=FLY-1945", "repair_issue=n/a")
			.replace('"mode":"existing"', '"mode":"no_issue"')
			.replace('"linear_record":"issue"', '"linear_record":"comment"');
		expect(validatePatrolReport(value).valid).toBe(true);
	});
	it("accepts the Bridge root issue as the repair issue with both receipts", () => {
		const value = report()
			.replace("bridge_problem=no", "bridge_problem=yes")
			.replace(
				"epic=n/a epic_marker=n/a",
				`epic=FLY-2072#${uuid} epic_marker=${key}`,
			);
		expect(validatePatrolReport(value).valid).toBe(true);
	});

	it("requires explicit zero review", () => {
		expect(
			validatePatrolReport(
				"patrol_schema=2\nMECHANISM_REVIEW result=none count=0",
			).valid,
		).toBe(true);
		expect(validatePatrolReport("patrol_schema=2").valid).toBe(false);
	});
	const mutants: [string, (s: string) => string][] = [
		[
			"missing disposition",
			(s) =>
				s
					.split("\n")
					.filter((l) => !l.startsWith("MECHANISM_DISPOSITION "))
					.join("\n"),
		],
		["missing category", (s) => s.replace("category=mechanism_defect ", "")],
		[
			"unknown category",
			(s) => s.replace("category=mechanism_defect", "category=other"),
		],
		[
			"duplicate key",
			(s) =>
				s.replace(
					"category=mechanism_defect",
					"category=mechanism_defect category=incident",
				),
		],
		[
			"unknown field",
			(s) =>
				s.replace(
					"category=mechanism_defect",
					"category=mechanism_defect surprise=yes",
				),
		],
		["duplicate declaration", (s) => `${s}\n${s.split("\n")[3]}`],
		["duplicate finding", (s) => `${s}\n${s.split("\n")[4]}`],
		["duplicate JSON ref", (s) => `${s}\n${s.split("\n")[5]}`],
		["blank reason", (s) => s.replace(/"reason":"[^"]*"/, '"reason":"   "')],
		[
			"placeholder cause",
			(s) =>
				s.replace(
					/"rootCause":"[^"]*"/,
					'"rootCause":"TODO fill in the root cause"',
				),
		],
		[
			"incomplete pagination",
			(s) => s.replace('"complete":true', '"complete":false'),
		],
		[
			"missing marker",
			(s) => s.replace('"markerVerified":true', '"markerVerified":false'),
		],
		["duplicate class", (s) => s.replace('"afterCount":1', '"afterCount":2')],
		[
			"wrong receipt",
			(s) => s.replace(`repair_receipt=${uuid}`, "repair_receipt=n/a"),
		],
		[
			"unknown JSON field",
			(s) =>
				s.replace('"linear_record":', '"unexpected":true,"linear_record":'),
		],
		[
			"changed step hides finding",
			(s) => s.replace("STEP 6: FINDING", "STEP 6: OK"),
		],
		[
			"extra unclosed declaration",
			(s) =>
				s +
				`\nMECHANISM_DEFECT id=${"c".repeat(64)} step=6 class_key=${key} root_cause_ref=other counterexample_ref=other`,
		],
		["old schema", (s) => s.replace("patrol_schema=2", "patrol_schema=1")],
		["duplicate schema", (s) => `${s}\npatrol_schema=2`],
		["unparsed record", (s) => `${s}\nMECHANISM_DEFECT`],
	];
	const rules = readFileSync(
		join(__dirname, "../../lead-rules-base/runbooks/patrol-v1.md"),
		"utf8",
	);
	const awk =
		rules.match(
			/# FLY-2080-FINDING-GATE-BEGIN\nawk '\n([\s\S]*?)\n' "\$REPORT_PATH"/,
		)?.[1] ?? "";
	it("executes original awk plus helper for three modes", () => {
		expect(awk).toContain("mechanism_finding");
		for (const mode of ["existing", "created", "no_issue"])
			expect(
				spawnSync("awk", [awk], { input: report(mode), encoding: "utf8" })
					.status,
			).toBe(0);
	});
	for (const name of [
		"missing category",
		"unknown category",
		"duplicate key",
		"unknown field",
		"duplicate declaration",
		"duplicate finding",
		"changed step hides finding",
		"extra unclosed declaration",
		"old schema",
		"duplicate schema",
		"unparsed record",
	])
		it(`awk rejects ${name}`, () => {
			const mutate = mutants.find((m) => m[0] === name)![1];
			expect(
				spawnSync("awk", [awk], { input: mutate(report()), encoding: "utf8" })
					.status,
			).not.toBe(0);
		});
	for (const [name, mutate] of mutants)
		it(`rejects ${name}`, () =>
			expect(validatePatrolReport(mutate(report())).valid).toBe(false));
	it("cannot replace Bridge receipt with no_issue", () =>
		expect(
			validatePatrolReport(
				report("no_issue").replace("bridge_problem=no", "bridge_problem=yes"),
			).valid,
		).toBe(false));
	it("rejects unavailable Linear disguised as no_issue", () =>
		expect(
			validatePatrolReport(
				report("no_issue").replace(
					/"reason":"[^"]*"/,
					'"reason":"Linear 不可用，所以暂时不建立修复单"',
				),
			).valid,
		).toBe(false));
});

describe("activity report evidence", () => {
	const entry = {
		identity: { executionId: "exec-one", activationId: "activation-one" },
		sourcesComplete: true,
		semanticDigest: key,
		coverageSinceMs: 100000,
		refs: [
			{
				repoIdentity: "github:org/repo",
				fullRef: "refs/heads/feature",
				headSha: "c".repeat(40),
				observedAtMs: 3700000,
			},
		],
	};
	const complete = [
		"patrol_schema=2",
		"MECHANISM_REVIEW result=none count=0",
		`PANE_EVIDENCE pane=p1 schema=2 exec=exec-one activity=STALLED_60M activity_evidence=${id}`,
		`ACTIVITY_EVIDENCE id=${id} exec=exec-one activation=activation-one interval_start=100 interval_end=3700 source=remote_ref ref_complete=yes refs_sha256=${key} semantic_sha256=${key} coverage_since=100 reason=unchanged branch_activity=no`,
		`ACTIVITY_RECORD ${JSON.stringify({ id, entry, sampledAtMs: 3700000, activity: "STALLED_60M", interval_start: 100, interval_end: 3700 })}`,
	].join("\n");
	const queueFields =
		"queue_request=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa queue_position=3 queue_wait_seconds=65";
	const modern = complete
		.replace(
			`activity_evidence=${id}`,
			`activity_evidence=${id} ${queueFields}`,
		)
		.replace("branch_activity=no", `branch_activity=no ${queueFields}`);
	it("accepts queue evidence emitted by the current snapshot", () =>
		expect(validatePatrolReport(modern)).toEqual({ valid: true, errors: [] }));
	it("keeps accepting legacy evidence without queue fields", () =>
		expect(validatePatrolReport(complete)).toEqual({
			valid: true,
			errors: [],
		}));
	for (const [field, value] of [
		[
			"note",
			"completed_design_session_window_rehydrated_by_shuttle_restart_closed_again",
		],
		[
			"evidence_note",
			"nudge_sent_4f356ce6:qa_parked_at_founder_gate_after_pass",
		],
	] as const) {
		it(`accepts historical pane ${field} evidence`, () =>
			expect(
				validatePatrolReport(
					complete.replace(
						`activity_evidence=${id}`,
						`activity_evidence=${id} ${field}=${value}`,
					),
				),
			).toEqual({ valid: true, errors: [] }));
	}
	for (const field of ["note", "evidence_note"] as const) {
		it(`rejects invalid pane ${field} tokens`, () =>
			expect(
				validatePatrolReport(
					complete.replace(
						`activity_evidence=${id}`,
						`activity_evidence=${id} ${field}=not/a/token`,
					),
				).errors,
			).toContain("invalid_pane_evidence"));
	}
	for (const [name, value] of [
		[
			"request token",
			"queue_request=request/one queue_position=3 queue_wait_seconds=65",
		],
		[
			"negative position",
			"queue_request=request-one queue_position=-1 queue_wait_seconds=65",
		],
		[
			"fractional position",
			"queue_request=request-one queue_position=1.5 queue_wait_seconds=65",
		],
		[
			"negative wait",
			"queue_request=request-one queue_position=3 queue_wait_seconds=-1",
		],
		[
			"fractional wait",
			"queue_request=request-one queue_position=3 queue_wait_seconds=1.5",
		],
	] as const) {
		it(`rejects invalid pane ${name}`, () => {
			const verdict = validatePatrolReport(
				complete.replace(
					`activity_evidence=${id}`,
					`activity_evidence=${id} ${value}`,
				),
			);
			expect(verdict.errors).toContain("invalid_queue_evidence");
		});
		it(`rejects invalid activity ${name}`, () => {
			const verdict = validatePatrolReport(
				complete.replace("branch_activity=no", `branch_activity=no ${value}`),
			);
			expect(verdict.errors).toContain("invalid_queue_evidence");
		});
	}
	it("rejects unknown fields on both machine evidence rows", () => {
		expect(
			validatePatrolReport(
				complete.replace(
					`activity_evidence=${id}`,
					`activity_evidence=${id} surprise=yes`,
				),
			).errors,
		).toContain("invalid_or_duplicate_field");
		expect(
			validatePatrolReport(
				complete.replace(
					"branch_activity=no",
					"branch_activity=no surprise=yes",
				),
			).errors,
		).toContain("invalid_or_duplicate_field");
	});
	it("accepts millisecond observations rendered as whole seconds", () =>
		expect(
			validatePatrolReport(
				complete
					.replace('"sampledAtMs":3700000', '"sampledAtMs":3700999')
					.replace('"coverageSinceMs":100000', '"coverageSinceMs":100500'),
			).valid,
		).toBe(true));
	it("accepts complete interval and exact ref", () =>
		expect(validatePatrolReport(complete).valid).toBe(true));
	for (const [name, mutate] of [
		[
			"missing evidence",
			(s: string) =>
				s
					.split("\n")
					.filter((l) => !l.startsWith("ACTIVITY_EVIDENCE"))
					.join("\n"),
		],
		[
			"missing record",
			(s: string) =>
				s
					.split("\n")
					.filter((l) => !l.startsWith("ACTIVITY_RECORD"))
					.join("\n"),
		],
		[
			"partial ref",
			(s: string) => s.replace("ref_complete=yes", "ref_complete=no"),
		],
		[
			"short interval",
			(s: string) => s.replaceAll("interval_end=3700", "interval_end=3699"),
		],
		[
			"wrong identity",
			(s: string) =>
				s.replace('"executionId":"exec-one"', '"executionId":"exec-other"'),
		],
		[
			"missing hash",
			(s: string) => s.replace(`refs_sha256=${key}`, "refs_sha256=unavailable"),
		],
	] as const)
		it(`rejects ${name}`, () =>
			expect(validatePatrolReport(mutate(complete)).valid).toBe(false));
	it("rejects repeated JSON keys", () =>
		expect(
			validatePatrolReport(
				report().replace(
					'"reason":',
					'"reason":"first reason repeated","reason":',
				),
			).valid,
		).toBe(false));
});
