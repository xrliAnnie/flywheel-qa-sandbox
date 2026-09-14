import { describe, expect, it } from "vitest";
import type { FrozenPacket } from "../contract.js";
import { validateEvaluation } from "../evaluate.js";

const sources: FrozenPacket["sources"] = [
	{ source_id: "plan", kind: "plan", revision: "1", text: "R1: require login" },
	{ source_id: "diff", kind: "diff", revision: "1", text: "+requireLogin();" },
	{ source_id: "qa", kind: "qa", revision: "1", text: "login test: PASS" },
];
const citation = (id: string) => {
	const source = sources.find((s) => s.source_id === id)!;
	return {
		source_id: id,
		quote_start: 0,
		quote_end: Array.from(source.text).length,
		quote: source.text,
	};
};
const packet = {
	sources,
	files: [{ repo_identity: "repo", path: "login.ts" }],
	requirements: [
		{ requirement_id: "R1", source_id: "plan", quote_start: 0, quote_end: 17 },
	],
} as FrozenPacket;
const good = () => ({
	schema_version: 1,
	alignment: {
		verdict: "pass",
		evidence: [citation("plan"), citation("diff")],
		reason_code: "implemented",
	},
	coverage: {
		verdict: "pass",
		evidence: [citation("qa")],
		reason_code: "covered",
	},
	requirements: [
		{
			requirement_id: "R1",
			implementation_evidence: [citation("diff")],
			use_cases: [
				{
					use_case_id: "login",
					test_ref: "login test",
					result: "pass",
					report_evidence: [citation("qa")],
				},
			],
		},
	],
});

describe("strict semantic evaluation", () => {
	it("accepts a complete evidenced code case, preserving failed and unknown judgments", () => {
		expect(validateEvaluation(JSON.stringify(good()), packet)).toMatchObject({
			alignment: "pass",
			coverage: "pass",
			resultCode: "evaluated",
		});
		const failed = good();
		failed.alignment.verdict = "fail";
		expect(validateEvaluation(JSON.stringify(failed), packet).alignment).toBe(
			"fail",
		);
		const unknown = good();
		unknown.coverage.verdict = "undetermined";
		expect(validateEvaluation(JSON.stringify(unknown), packet).coverage).toBe(
			"undetermined",
		);
	});
	it("rejects missing, duplicate, invented, and vacuous requirement maps", () => {
		for (const requirements of [
			[],
			[good().requirements[0], good().requirements[0]],
			[{ ...good().requirements[0], requirement_id: "invented" }],
		]) {
			expect(
				validateEvaluation(JSON.stringify({ ...good(), requirements }), packet),
			).toMatchObject({ alignment: "undetermined", coverage: "undetermined" });
		}
		expect(
			validateEvaluation(JSON.stringify({ ...good(), requirements: [] }), {
				...packet,
				requirements: [],
			}).coverage,
		).toBe("undetermined");
	});
	it("blocks fake citations, wrong source kinds, missing tests and unsupported exemptions", () => {
		for (const mutate of [
			(value: ReturnType<typeof good>) => {
				value.alignment.evidence[0]!.quote = "fake";
			},
			(value: ReturnType<typeof good>) => {
				value.requirements[0]!.implementation_evidence = [citation("qa")];
			},
			(value: ReturnType<typeof good>) => {
				value.requirements[0]!.use_cases = [];
			},
			(value: ReturnType<typeof good>) => {
				value.requirements[0]!.use_cases[0]!.report_evidence = [
					citation("plan"),
				];
			},
			(value: ReturnType<typeof good>) => {
				value.requirements[0]!.use_cases[0]!.result = "fail";
			},
			(value: ReturnType<typeof good>) => {
				value.requirements[0]!.use_cases[0]!.test_ref = "invented test";
			},
			(value: ReturnType<typeof good>) => {
				value.requirements[0]!.use_cases[0]!.result = "na";
			},
		]) {
			const value = good();
			mutate(value);
			const result = validateEvaluation(JSON.stringify(value), packet);
			expect(result.alignment === "pass" && result.coverage === "pass").toBe(
				false,
			);
		}
	});
	it("rejects unexpected fields, tool envelopes, malformed JSON and oversized stdout", () => {
		for (const raw of [
			JSON.stringify({ ...good(), overall: "can" }),
			JSON.stringify({ type: "tool_use", ...good() }),
			"```json\n{}\n```",
			" ".repeat(65537),
		]) {
			expect(validateEvaluation(raw, packet)).toMatchObject({
				alignment: "undetermined",
				coverage: "undetermined",
			});
		}
	});
	it("requires both approved scope and QA citations for N/A, and bounds use cases across requirements", () => {
		const value = good();
		const useCase = value.requirements[0]!.use_cases[0]!;
		useCase.result = "na";
		useCase.test_ref = "Accepted scope excludes this case";
		useCase.report_evidence.push(citation("plan"));
		expect(validateEvaluation(JSON.stringify(value), packet).resultCode).toBe(
			"evaluated",
		);
		value.requirements[0]!.use_cases.push({ ...useCase });
		expect(validateEvaluation(JSON.stringify(value), packet).resultCode).toBe(
			"use_case_duplicate",
		);
		const oversized = good();
		oversized.alignment.reason_code = "x".repeat(2001);
		expect(
			validateEvaluation(JSON.stringify(oversized), packet).resultCode,
		).toBe("output_schema_invalid");
	});
});
