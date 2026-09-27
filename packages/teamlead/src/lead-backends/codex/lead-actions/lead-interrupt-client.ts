/**
 * FLY-2883 — the Codex Lead's side of a controlled interrupt: read the urgent
 * letters addressed to this Lead and answer one by interrupt id. Identity is
 * the carrier-bound canonical identity (same inputs as the attachment reader);
 * the raw carrier claim and bearer stay in the MCP child env.
 */

import { LEAD_INTERRUPT_ID_PATTERN } from "../../../bridge/lead-interrupt-contract.js";

export interface LeadInterruptToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: true;
}

export interface LeadInterruptClientOptions {
	bridgeUrl?: string;
	apiToken?: string;
	projectName: string;
	leadId: string;
	identityDigest?: string;
	carrierClaim?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export interface LeadInterruptClient {
	pending(): Promise<LeadInterruptToolResult>;
	reply(interruptId: string, text: string): Promise<LeadInterruptToolResult>;
}

function failure(reason: string): LeadInterruptToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: reason }) }],
		isError: true,
	};
}

export function createLeadInterruptClient(
	options: LeadInterruptClientOptions,
): LeadInterruptClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const post = async (
		path: string,
		extra: Record<string, unknown> = {},
	): Promise<LeadInterruptToolResult> => {
		if (
			!options.bridgeUrl ||
			!options.apiToken ||
			!options.identityDigest ||
			!options.carrierClaim
		)
			return failure("transport_unavailable");
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			options.timeoutMs ?? 10_000,
		);
		try {
			let response: Response;
			try {
				response = await fetchImpl(
					`${options.bridgeUrl.replace(/\/+$/u, "")}${path}`,
					{
						method: "POST",
						redirect: "error",
						signal: controller.signal,
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${options.apiToken}`,
						},
						body: JSON.stringify({
							project: options.projectName,
							leadId: options.leadId,
							identityDigest: options.identityDigest,
							carrierClaim: options.carrierClaim,
							...extra,
						}),
					},
				);
			} catch {
				return failure("bridge_unavailable");
			}
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (!response.ok) {
				const code =
					payload &&
					typeof payload === "object" &&
					typeof (payload as { error?: unknown }).error === "string"
						? (payload as { error: string }).error
						: `http_${response.status}`;
				return failure(code);
			}
			if (!payload || typeof payload !== "object")
				return failure("invalid_bridge_response");
			return {
				content: [{ type: "text", text: JSON.stringify(payload) }],
				structuredContent: payload as Record<string, unknown>,
			};
		} finally {
			clearTimeout(timer);
		}
	};
	return {
		pending: () => post("/api/lead-interrupts/pending/query"),
		reply: async (interruptId, text) => {
			if (!LEAD_INTERRUPT_ID_PATTERN.test(interruptId))
				return failure("invalid_interrupt_id");
			return post(`/api/lead-interrupts/${interruptId}/reply`, { text });
		},
	};
}
