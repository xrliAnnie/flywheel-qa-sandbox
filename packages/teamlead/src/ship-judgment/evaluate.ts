import { z } from "zod";
import {
	type Citation,
	citationSchema,
	type FrozenPacket,
	validateCitation,
	verdictSchema,
} from "./contract.js";

const text = z
	.string()
	.min(1)
	.refine((value) => Array.from(value).length <= 2000);
const evidence = z.array(citationSchema).max(100);
const point = z
	.object({ verdict: verdictSchema, evidence, reason_code: text })
	.strict();
export const semanticOutputSchema = z
	.object({
		schema_version: z.literal(1),
		alignment: point,
		coverage: point,
		requirements: z
			.array(
				z
					.object({
						requirement_id: text,
						implementation_evidence: evidence,
						use_cases: z
							.array(
								z
									.object({
										use_case_id: text,
										test_ref: text,
										result: z.enum(["pass", "fail", "undetermined", "na"]),
										report_evidence: evidence,
									})
									.strict(),
							)
							.max(200),
					})
					.strict(),
			)
			.max(100),
	})
	.strict();
export type SemanticOutput = z.infer<typeof semanticOutputSchema>;
export interface ValidatedEvaluation {
	alignment: z.infer<typeof verdictSchema>;
	coverage: z.infer<typeof verdictSchema>;
	resultCode: string;
	result: SemanticOutput | { reason: string };
}

/** The model supplies semantic judgments, never overall advice or authority. Reject unverifiable output. */
export function validateEvaluation(
	raw: string,
	packet: FrozenPacket,
): ValidatedEvaluation {
	const invalid = (reason: string): ValidatedEvaluation => ({
		alignment: "undetermined",
		coverage: "undetermined",
		resultCode: reason,
		result: { reason },
	});
	if (Buffer.byteLength(raw) > 65_536) return invalid("output_budget_exceeded");
	let value: SemanticOutput;
	try {
		value = semanticOutputSchema.parse(JSON.parse(raw));
	} catch {
		return invalid("output_schema_invalid");
	}
	const ids = packet.requirements.map(
		(requirement) => requirement.requirement_id,
	);
	const returned = value.requirements.map(
		(requirement) => requirement.requirement_id,
	);
	if (
		!ids.length ||
		new Set(ids).size !== ids.length ||
		new Set(returned).size !== returned.length ||
		ids.length !== returned.length ||
		returned.some((id) => !ids.includes(id))
	)
		return invalid("requirement_map_invalid");
	if (
		value.requirements.reduce(
			(count, requirement) => count + requirement.use_cases.length,
			0,
		) > 200
	)
		return invalid("use_case_budget_exceeded");
	const files = packet.files.flatMap((file) => [
		file.path,
		...(file.previous_path ? [file.previous_path] : []),
	]);
	const all = [
		...value.alignment.evidence,
		...value.coverage.evidence,
		...value.requirements.flatMap((requirement) => [
			...requirement.implementation_evidence,
			...requirement.use_cases.flatMap((useCase) => useCase.report_evidence),
		]),
	];
	if (
		all.some((citation) => !validateCitation(citation, packet.sources, files))
	)
		return invalid("citation_invalid");
	const hasKind = (
		citations: Citation[],
		kinds: FrozenPacket["sources"][number]["kind"][],
	) =>
		citations.some((citation) =>
			packet.sources.some(
				(source) =>
					source.source_id === citation.source_id &&
					kinds.includes(source.kind),
			),
		);
	const scopeKinds = ["issue", "plan", "prd", "revision"] as const;
	if (
		value.alignment.verdict !== "undetermined" &&
		!hasKind(value.alignment.evidence, [...scopeKinds])
	)
		return invalid("alignment_evidence_missing");
	if (
		value.coverage.verdict !== "undetermined" &&
		!hasKind(value.coverage.evidence, ["qa"])
	)
		return invalid("coverage_evidence_missing");
	for (const requirement of value.requirements) {
		if (
			new Set(requirement.use_cases.map((useCase) => useCase.use_case_id))
				.size !== requirement.use_cases.length
		)
			return invalid("use_case_duplicate");
		if (
			value.alignment.verdict === "pass" &&
			!hasKind(requirement.implementation_evidence, ["diff"])
		)
			return invalid("implementation_evidence_missing");
		if (value.coverage.verdict !== "pass") continue;
		if (!requirement.use_cases.length) return invalid("use_case_missing");
		for (const useCase of requirement.use_cases) {
			if (!["pass", "na"].includes(useCase.result))
				return invalid("coverage_result_inconsistent");
			if (!hasKind(useCase.report_evidence, ["qa"]))
				return invalid("test_evidence_missing");
			if (useCase.result === "na") {
				// N/A reason lives in test_ref; approved scope and QA must both support the exemption.
				if (!hasKind(useCase.report_evidence, [...scopeKinds]))
					return invalid("exemption_scope_missing");
			} else if (
				!useCase.report_evidence.some(
					(citation) =>
						packet.sources.some(
							(source) =>
								source.source_id === citation.source_id && source.kind === "qa",
						) && citation.quote.includes(useCase.test_ref),
				)
			)
				return invalid("test_reference_unverified");
		}
	}
	return {
		alignment: value.alignment.verdict,
		coverage: value.coverage.verdict,
		resultCode: "evaluated",
		result: value,
	};
}
