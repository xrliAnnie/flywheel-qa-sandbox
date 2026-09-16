import { createHmac, timingSafeEqual } from "node:crypto";

export const VOICE_SELF_FILTER_MAX_BYTES = 4096;
export interface VoiceSelfFilterRequest {
	version: 1;
	method: "probeVoiceSelfFilter";
	leadId: string;
	expectedBotUserId: string;
	nonce: string;
	auth: string;
}
export interface VoiceSelfFilterObservation {
	botUserId: string;
	ready: boolean;
	selfDropped: boolean;
	unknownDropped: boolean;
	otherPassed: boolean;
}
export interface VoiceSelfFilterResponse extends VoiceSelfFilterObservation {
	version: 1;
	leadId: string;
	runtimeId: string;
	nonce: string;
	auth: string;
}
const snowflake = /^\d{17,20}$/;
const hex = /^[a-f0-9]{64}$/;
const uuid =
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function selfAuthorAllowed(
	botId: string | undefined,
	ready: boolean,
	authorId: string,
): boolean {
	return Boolean(ready && botId && authorId && authorId !== botId);
}
export function observeVoiceSelfFilter(
	botId: string | undefined,
	ready: boolean,
	guard: typeof selfAuthorAllowed = selfAuthorAllowed,
): VoiceSelfFilterObservation {
	const other =
		botId === "100000000000000001"
			? "100000000000000002"
			: "100000000000000001";
	return {
		botUserId: botId ?? "",
		ready,
		selfDropped: !guard(botId, ready, botId ?? ""),
		unknownDropped:
			!guard(undefined, true, other) && !guard(botId, false, other),
		otherPassed: guard(botId, ready, other),
	};
}
export function canonicalVoiceSelfFilterRequest(
	request: Pick<
		VoiceSelfFilterRequest,
		"leadId" | "expectedBotUserId" | "nonce"
	>,
): string {
	return JSON.stringify([
		1,
		"voice-self-filter-v1",
		request.leadId,
		request.expectedBotUserId,
		request.nonce,
	]);
}
function mac(value: string, secret: string): string {
	return createHmac("sha256", secret).update(value).digest("hex");
}
function equalMac(actual: unknown, expected: string): boolean {
	return (
		typeof actual === "string" &&
		hex.test(actual) &&
		timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
	);
}
export function makeVoiceSelfFilterRequest(
	input: { leadId: string; expectedBotUserId: string; nonce: string },
	secret: string,
): VoiceSelfFilterRequest {
	return {
		version: 1,
		method: "probeVoiceSelfFilter",
		...input,
		auth: mac(canonicalVoiceSelfFilterRequest(input), secret),
	};
}
export function validVoiceSelfFilterRequestFields(
	value: unknown,
): value is VoiceSelfFilterRequest {
	if (!value || typeof value !== "object") return false;
	const r = value as VoiceSelfFilterRequest;
	return (
		r.version === 1 &&
		r.method === "probeVoiceSelfFilter" &&
		typeof r.leadId === "string" &&
		r.leadId.length > 0 &&
		r.leadId.length <= 200 &&
		typeof r.expectedBotUserId === "string" &&
		snowflake.test(r.expectedBotUserId) &&
		typeof r.nonce === "string" &&
		hex.test(r.nonce) &&
		typeof r.auth === "string" &&
		hex.test(r.auth) &&
		Object.keys(r).every((key) =>
			[
				"version",
				"method",
				"leadId",
				"expectedBotUserId",
				"nonce",
				"auth",
			].includes(key),
		)
	);
}
export function authenticateVoiceSelfFilterRequest(
	value: unknown,
	secret: string,
): value is VoiceSelfFilterRequest {
	return (
		validVoiceSelfFilterRequestFields(value) &&
		equalMac(value.auth, mac(canonicalVoiceSelfFilterRequest(value), secret))
	);
}
function canonicalResponse(r: Omit<VoiceSelfFilterResponse, "auth">): string {
	return JSON.stringify([
		r.version,
		r.leadId,
		r.botUserId,
		r.runtimeId,
		r.nonce,
		r.ready,
		r.selfDropped,
		r.unknownDropped,
		r.otherPassed,
	]);
}
export function signVoiceSelfFilterResponse(
	response: Omit<VoiceSelfFilterResponse, "auth">,
	secret: string,
): VoiceSelfFilterResponse {
	return { ...response, auth: mac(canonicalResponse(response), secret) };
}
export function verifyVoiceSelfFilterResponse(
	value: unknown,
	request: VoiceSelfFilterRequest,
	secret: string,
): VoiceSelfFilterResponse {
	if (!value || typeof value !== "object")
		throw new Error("self_filter_invalid_response");
	const r = value as VoiceSelfFilterResponse;
	if (
		r.version !== 1 ||
		r.leadId !== request.leadId ||
		r.botUserId !== request.expectedBotUserId ||
		r.nonce !== request.nonce ||
		typeof r.runtimeId !== "string" ||
		!uuid.test(r.runtimeId) ||
		r.ready !== true ||
		r.selfDropped !== true ||
		r.unknownDropped !== true ||
		r.otherPassed !== true ||
		Object.keys(r).some(
			(key) =>
				![
					"version",
					"leadId",
					"botUserId",
					"runtimeId",
					"nonce",
					"ready",
					"selfDropped",
					"unknownDropped",
					"otherPassed",
					"auth",
				].includes(key),
		) ||
		!equalMac(r.auth, mac(canonicalResponse(r), secret))
	)
		throw new Error("self_filter_unverified");
	return r;
}
