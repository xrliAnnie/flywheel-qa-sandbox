import { readFileSync } from "node:fs";

export async function workflowUsageSource(input: {
	event: "turn-start";
	stdin?: string;
	env?: NodeJS.ProcessEnv;
	fetchFn?: typeof fetch;
}): Promise<void> {
	const env = input.env ?? process.env;
	const payload = JSON.parse(input.stdin ?? readFileSync(0, "utf8")) as Record<
		string,
		unknown
	>;
	const executionId = env.FLYWHEEL_EXEC_ID?.trim();
	const activationId = env.FLYWHEEL_WORKFLOW_ACTIVATION_ID?.trim();
	const bridgeUrl = env.FLYWHEEL_BRIDGE_URL?.trim();
	const token = env.FLYWHEEL_INGEST_TOKEN?.trim();
	const sessionId =
		typeof payload.session_id === "string" ? payload.session_id.trim() : "";
	const transcriptPath =
		typeof payload.transcript_path === "string"
			? payload.transcript_path.trim()
			: "";
	if (!executionId || !activationId || !bridgeUrl || !token)
		throw new Error("workflow usage source environment is incomplete");
	if (!sessionId || !transcriptPath)
		throw new Error("workflow usage source payload is incomplete");
	const response = await (input.fetchFn ?? fetch)(
		`${bridgeUrl.replace(/\/$/, "")}/api/workflow/usage-source`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				event: input.event,
				execution_id: executionId,
				activation_id: activationId,
				session_id: sessionId,
				transcript_path: transcriptPath,
			}),
		},
	);
	if (!response.ok)
		throw new Error(
			`workflow usage source failed: ${response.status} ${await response.text()}`,
		);
}
