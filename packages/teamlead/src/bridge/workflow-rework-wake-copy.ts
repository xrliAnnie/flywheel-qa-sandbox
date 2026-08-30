function isNodeReuseContext(context: unknown): boolean {
	if (!context || typeof context !== "object" || Array.isArray(context)) {
		return false;
	}
	const authorityContext = (context as { authorityContext?: unknown })
		.authorityContext;
	return (
		authorityContext !== null &&
		typeof authorityContext === "object" &&
		!Array.isArray(authorityContext) &&
		(authorityContext as { kind?: unknown }).kind === "node_reuse"
	);
}

export function renderWorkflowReworkWakeContent(input: {
	wakeId: string;
	activationId: string;
	epoch: number;
	executionId: string;
	context: unknown;
}): string {
	const nodeReuse = isNodeReuseContext(input.context);
	const activation = nodeReuse
		? "New verification round"
		: "Workflow rework activation";
	const contextLabel = nodeReuse ? "Verification context" : "Rework context";
	return `[phase-wake ${input.wakeId}] ${activation} ${input.activationId} is ready at TURN epoch ${input.epoch}. FIRST run flywheel-comm turn --exec-id ${input.executionId}; proceed only if it answers yours. ${contextLabel}: ${JSON.stringify(input.context)}`;
}
