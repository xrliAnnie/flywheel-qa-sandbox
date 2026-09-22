export function readbackRequired(input: {
	action: "note" | "question" | "meeting" | "merge" | "deploy" | "ship";
	attributedToFounder: boolean;
	currentSession: boolean;
}): boolean {
	return (
		(input.action === "merge" ||
			input.action === "deploy" ||
			input.action === "ship") &&
		input.attributedToFounder &&
		input.currentSession
	);
}
