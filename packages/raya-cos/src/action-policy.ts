export type CoSAction =
	| "note"
	| "question"
	| "meeting"
	| "merge"
	| "deploy"
	| "ship";

export type ActionPolicyResult =
	| {
			status: "business_action_allowed";
			action: "note" | "question" | "meeting";
	  }
	| {
			status: "external_authority_required";
			action: "merge" | "deploy" | "ship";
	  };

export function evaluateActionPolicy(input: {
	action: CoSAction;
	actor: "founder" | "lead" | "unknown";
}): ActionPolicyResult {
	if (
		input.action === "merge" ||
		input.action === "deploy" ||
		input.action === "ship"
	) {
		return { status: "external_authority_required", action: input.action };
	}
	return { status: "business_action_allowed", action: input.action };
}
