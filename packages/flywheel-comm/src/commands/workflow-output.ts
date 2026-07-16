import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export interface WorkflowOutputOpts {
	payloadFile: string;
	requestId?: string;
}

export function buildWorkflowOutputRequest(input: {
	credential: string;
	clientRequestId: string;
	payload: string;
}) {
	return {
		credential: input.credential,
		client_request_id: input.clientRequestId,
		payload: input.payload,
	};
}

export async function workflowOutput(opts: WorkflowOutputOpts): Promise<void> {
	const credential = process.env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL?.trim();
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL?.trim();
	if (!credential)
		throw new Error("FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL is required");
	if (!bridgeUrl) throw new Error("FLYWHEEL_BRIDGE_URL is required");
	if (!opts.payloadFile?.trim()) throw new Error("--payload-file is required");
	const payload = readFileSync(opts.payloadFile, "utf8");
	const body = buildWorkflowOutputRequest({
		credential,
		clientRequestId: opts.requestId?.trim() || randomUUID(),
		payload,
	});
	let lastError = "unknown";
	for (let attempt = 1; attempt <= 4; attempt += 1) {
		try {
			const response = await fetch(
				`${bridgeUrl.replace(/\/$/, "")}/api/workflow/output`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			if (response.ok) {
				const result = (await response.json()) as { outputId?: number };
				console.log(
					JSON.stringify({
						ok: true,
						outputId: result.outputId,
						requestId: body.client_request_id,
					}),
				);
				return;
			}
			lastError = `Bridge returned ${response.status}: ${await response.text()}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		if (attempt < 4) {
			await new Promise((resolve) =>
				setTimeout(resolve, 250 * 2 ** (attempt - 1)),
			);
		}
	}
	throw new Error(`workflow output failed closed: ${lastError}`);
}
