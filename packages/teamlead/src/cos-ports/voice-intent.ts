import { normalizeOptionalBearer } from "flywheel-config";

export interface VoiceIntentInput {
	meetingId: string;
	action: "start" | "stop";
}

export type VoiceIntentResult =
	| { status: "accepted" }
	| { status: "unavailable"; reason: string };

export function createVoiceIntentPort(input: {
	bridgeUrl: string;
	tokenEnv: string;
	env?: Readonly<Record<string, string | undefined>>;
	fetchImpl?: typeof fetch;
}): { voiceIntent(intent: VoiceIntentInput): Promise<VoiceIntentResult> } {
	const base = input.bridgeUrl.replace(/\/+$/, "");
	const env = input.env ?? process.env;
	const fetchImpl = input.fetchImpl ?? fetch;
	return {
		voiceIntent: async (intent) => {
			const token = normalizeOptionalBearer(env[input.tokenEnv]);
			if (!token) return { status: "unavailable", reason: "token_unset" };
			const request = async (
				path: string,
				method: "GET" | "POST",
				body?: unknown,
			) => {
				const response = await fetchImpl(`${base}${path}`, {
					method,
					headers: {
						Authorization: `Bearer ${token}`,
						...(body === undefined
							? {}
							: { "Content-Type": "application/json" }),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				});
				let payload: Record<string, unknown> = {};
				try {
					payload = (await response.json()) as Record<string, unknown>;
				} catch {
					// The HTTP status remains authoritative when an upstream body is absent.
				}
				return { response, payload };
			};
			try {
				let result: Awaited<ReturnType<typeof request>>;
				if (intent.action === "start") {
					result = await request("/api/voice/sessions", "POST", {
						meetingId: intent.meetingId,
					});
				} else {
					const lookup = await request(
						`/api/voice/sessions/by-meeting/${encodeURIComponent(intent.meetingId)}`,
						"GET",
					);
					if (!lookup.response.ok) result = lookup;
					else if (typeof lookup.payload.sessionId !== "string") {
						return { status: "unavailable", reason: "session_lookup_invalid" };
					} else {
						result = await request(
							`/api/voice/sessions/${encodeURIComponent(lookup.payload.sessionId)}/stop`,
							"POST",
						);
					}
				}
				if (result.response.ok) return { status: "accepted" };
				return {
					status: "unavailable",
					reason:
						(typeof result.payload.reason === "string" &&
							result.payload.reason) ||
						(typeof result.payload.error === "string" &&
							result.payload.error) ||
						`http_${result.response.status}`,
				};
			} catch {
				return { status: "unavailable", reason: "bridge_unreachable" };
			}
		},
	};
}
