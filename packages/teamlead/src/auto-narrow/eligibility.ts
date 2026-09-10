export interface AutoNarrowBinding {
	runId: string;
	questionId: string;
	gateExecutionId: string;
	repoIdentity: string;
	prNumber: number;
	headSha: string;
}

export interface AutoNarrowObservationFacts {
	run_id: string;
	question_id: string;
	gate_execution_id: string;
	repo_identity: string;
	pr_number: number;
	head_sha: string;
	machine_class: "docs_only" | "ship_relevant" | "unknown";
	machine_reason: string | null;
	s2_ran_status: "satisfied" | "unsatisfied";
	s2_ran_reason: string;
	s2_record_status: "satisfied" | "unsatisfied";
	s2_record_reason: string;
	s2_verdict: "satisfied" | "unsatisfied";
	s2_basis_record_id: string | null;
}

export interface AutoNarrowDeclarationFacts {
	declaration_id: string;
	declaration_seq: number;
	question_id: string;
	run_id: string;
	declared_by: string;
	declared_class:
		| "pure_docs"
		| "config_only"
		| "single_point_change"
		| "other_code";
}

export interface AutoNarrowEligibilityInput {
	binding: AutoNarrowBinding;
	observation: AutoNarrowObservationFacts;
	declaration?: AutoNarrowDeclarationFacts;
	hasFounderRework: boolean;
	hasPendingFounderInput: boolean;
}

export type AutoNarrowEligibilityReason =
	| "eligible"
	| "gate1_failed"
	| "gate2_failed"
	| "gate3_failed"
	| "multiple_failed"
	| "negative_guard";

export interface AutoNarrowEligibility {
	eligible: boolean;
	gate1: boolean;
	gate2: boolean;
	gate3: boolean;
	reasonCode: AutoNarrowEligibilityReason;
}

export function evaluateAutoNarrowEligibility(
	input: AutoNarrowEligibilityInput,
): AutoNarrowEligibility {
	const { binding, observation, declaration } = input;
	const observationBound =
		observation.run_id === binding.runId &&
		observation.question_id === binding.questionId &&
		observation.gate_execution_id === binding.gateExecutionId &&
		observation.repo_identity === binding.repoIdentity &&
		observation.pr_number === binding.prNumber &&
		observation.head_sha === binding.headSha;
	const gate1 =
		observationBound &&
		observation.machine_class === "docs_only" &&
		observation.machine_reason === null;
	const gate2 = Boolean(
		declaration &&
			declaration.run_id === binding.runId &&
			declaration.question_id === binding.questionId &&
			declaration.declared_by === "flywheel-eng-lead" &&
			declaration.declared_class === "pure_docs",
	);
	const gate3 = Boolean(
		observationBound &&
			observation.s2_ran_status === "satisfied" &&
			observation.s2_ran_reason === "ok" &&
			observation.s2_record_status === "satisfied" &&
			observation.s2_record_reason === "ok" &&
			observation.s2_verdict === "satisfied" &&
			observation.s2_basis_record_id,
	);
	if (input.hasFounderRework || input.hasPendingFounderInput) {
		return {
			eligible: false,
			gate1,
			gate2,
			gate3,
			reasonCode: "negative_guard",
		};
	}
	const failed = [gate1, gate2, gate3].filter((passed) => !passed).length;
	return {
		eligible: failed === 0,
		gate1,
		gate2,
		gate3,
		reasonCode:
			failed === 0
				? "eligible"
				: failed > 1
					? "multiple_failed"
					: !gate1
						? "gate1_failed"
						: !gate2
							? "gate2_failed"
							: "gate3_failed",
	};
}
