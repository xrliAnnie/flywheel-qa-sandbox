/** Bounded transport for runner tools. No retries and no backend error text escapes. */
export interface RunnerBridgeClient {
	bridgeUrl: string;
	apiToken: string;
	fetchImpl?: typeof fetch;
}
export interface RunnerBridgeResponse {
	httpStatus?: number;
	body?: Record<string, unknown>;
	retryAfter?: string | null;
}
export async function requestRunnerBridge(
	client: RunnerBridgeClient,
	path: string,
	body?: unknown,
): Promise<RunnerBridgeResponse> {
	const base = new URL(client.bridgeUrl);
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		!client.apiToken
	)
		throw new Error("runner Bridge configuration invalid");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);
	const result: RunnerBridgeResponse = {};
	try {
		const response = await (client.fetchImpl ?? fetch)(
			`${client.bridgeUrl.replace(/\/+$/, "")}${path}`,
			{
				method: body === undefined ? "GET" : "POST",
				redirect: "error",
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${client.apiToken}`,
					"Content-Type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
		);
		result.httpStatus = response.status;
		result.retryAfter = response.headers.get("Retry-After");
		if (!response.body) return result;
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				size += next.value.byteLength;
				if (size > 256 * 1024) {
					await reader.cancel();
					return result;
				}
				chunks.push(next.value);
			}
		} finally {
			reader.releaseLock();
		}
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			result.body = parsed as Record<string, unknown>;
	} catch {
		/* Ambiguous transport/parse failure: preserve status, never error diagnostics. */
	} finally {
		clearTimeout(timer);
	}
	return result;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ADMISSION_REASONS = new Set([
	"load_pressure",
	"memory_pressure",
	"admission_paused",
	"pressure_hold",
]);
export function classifyRunnerStart(
	response: RunnerBridgeResponse,
	idempotencyKey: string,
): Record<string, unknown> {
	const { httpStatus, body, retryAfter } = response;
	let outcome = "unknown";
	if (body && httpStatus === 202 && body.code === "LAUNCH_PENDING")
		outcome = "pending";
	else if (
		body &&
		httpStatus !== undefined &&
		httpStatus >= 200 &&
		httpStatus < 300 &&
		body.success === true
	)
		outcome = "started";
	else if (
		body &&
		(httpStatus === 400 || httpStatus === 401 || httpStatus === 403)
	)
		outcome = "refused";
	else if (
		httpStatus === 429 &&
		body?.success === false &&
		typeof body.reason === "string" &&
		ADMISSION_REASONS.has(body.reason)
	)
		outcome = "refused";
	const result: Record<string, unknown> = {
		outcome,
		...(httpStatus === undefined ? {} : { httpStatus }),
		idempotencyKey,
	};
	if (
		typeof body?.code === "string" &&
		/^[A-Z][A-Z0-9_]{0,95}$/.test(body.code)
	)
		result.code = body.code;
	for (const key of [
		"executionId",
		"workflowRunId",
		"workflowNodeId",
		"issueId",
	]) {
		const value = body?.[key];
		if (
			typeof value === "string" &&
			(UUID.test(value) ||
				(key === "issueId" && /^[A-Z][A-Z0-9]*-[0-9]+$/.test(value)))
		)
			result[key] = value;
	}
	if (
		httpStatus === 429 &&
		outcome === "refused" &&
		retryAfter &&
		/^\d+$/.test(retryAfter) &&
		Number.isSafeInteger(Number(retryAfter))
	)
		result.retryAfterSeconds = Number(retryAfter);
	return result;
}
