import type { PersonaPin } from "flywheel-config";

export type MigrationCompatiblePersonaPin = PersonaPin & {
	migrationCompatible: true;
};

export type PersonaActivationView =
	| { kind: "unmanaged" }
	| { kind: "legacy-managed" }
	| {
			kind: "pre-m0";
			contractDigest: string;
			a0Digest: string;
			revision: string;
	  }
	| { kind: "fenced"; windowId: string; revision: string }
	| {
			kind: "post-m0";
			windowId: string;
			contractDigest: string;
			expected: PersonaPin;
			fallback: MigrationCompatiblePersonaPin | null;
			dbIdentity: string;
			migrationReceiptDigest: string;
			revision: string;
	  }
	| { kind: "refused"; reason: string };

export interface PersonaActivationClientOptions {
	baseUrl: string;
	token: string;
	projectName: string;
	leadId: string;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function exact(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return (
		Object.keys(value).length === keys.length &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}

function approval(value: unknown): boolean {
	return (
		object(value) &&
		exact(value, ["channelId", "messageId", "contentSha256"]) &&
		typeof value.channelId === "string" &&
		/^\d{17,20}$/.test(value.channelId) &&
		typeof value.messageId === "string" &&
		/^\d{17,20}$/.test(value.messageId) &&
		typeof value.contentSha256 === "string" &&
		SHA256_RE.test(value.contentSha256)
	);
}

function pin(value: unknown, fallback = false): boolean {
	return (
		object(value) &&
		exact(
			value,
			fallback
				? ["commit", "personaBlobDigest", "approval", "migrationCompatible"]
				: ["commit", "personaBlobDigest", "approval"],
		) &&
		typeof value.commit === "string" &&
		COMMIT_RE.test(value.commit) &&
		typeof value.personaBlobDigest === "string" &&
		SHA256_RE.test(value.personaBlobDigest) &&
		approval(value.approval) &&
		(!fallback || value.migrationCompatible === true)
	);
}

export function parsePersonaActivationView(
	value: unknown,
): PersonaActivationView {
	if (!object(value) || typeof value.kind !== "string") {
		throw new Error("persona_activation_response_invalid");
	}
	if (value.kind === "unmanaged" || value.kind === "legacy-managed") {
		if (!exact(value, ["kind"]))
			throw new Error("persona_activation_response_invalid");
		return value as PersonaActivationView;
	}
	if (value.kind === "refused") {
		if (
			!exact(value, ["kind", "reason"]) ||
			typeof value.reason !== "string" ||
			!value.reason
		) {
			throw new Error("persona_activation_response_invalid");
		}
		return value as PersonaActivationView;
	}
	if (value.kind === "pre-m0") {
		if (
			!exact(value, ["kind", "contractDigest", "a0Digest", "revision"]) ||
			typeof value.contractDigest !== "string" ||
			!SHA256_RE.test(value.contractDigest) ||
			typeof value.a0Digest !== "string" ||
			!SHA256_RE.test(value.a0Digest) ||
			typeof value.revision !== "string" ||
			!/^\d+$/.test(value.revision)
		)
			throw new Error("persona_activation_response_invalid");
		return value as PersonaActivationView;
	}
	if (value.kind === "fenced") {
		if (
			!exact(value, ["kind", "windowId", "revision"]) ||
			typeof value.windowId !== "string" ||
			!value.windowId ||
			typeof value.revision !== "string" ||
			!/^\d+$/.test(value.revision)
		)
			throw new Error("persona_activation_response_invalid");
		return value as PersonaActivationView;
	}
	if (value.kind === "post-m0") {
		if (
			!exact(value, [
				"kind",
				"windowId",
				"contractDigest",
				"expected",
				"fallback",
				"dbIdentity",
				"migrationReceiptDigest",
				"revision",
			]) ||
			typeof value.windowId !== "string" ||
			!value.windowId ||
			typeof value.contractDigest !== "string" ||
			!SHA256_RE.test(value.contractDigest) ||
			!pin(value.expected) ||
			!(value.fallback === null || pin(value.fallback, true)) ||
			typeof value.dbIdentity !== "string" ||
			!SHA256_RE.test(value.dbIdentity) ||
			typeof value.migrationReceiptDigest !== "string" ||
			!SHA256_RE.test(value.migrationReceiptDigest) ||
			typeof value.revision !== "string" ||
			!/^\d+$/.test(value.revision)
		)
			throw new Error("persona_activation_response_invalid");
		return value as PersonaActivationView;
	}
	throw new Error("persona_activation_response_invalid");
}

export async function readPersonaActivation(
	options: PersonaActivationClientOptions,
): Promise<PersonaActivationView> {
	if (!options.token) throw new Error("persona_activation_token_missing");
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	let response: Response;
	try {
		response = await (options.fetchFn ?? fetch)(
			`${baseUrl}/api/lead-persona/activation?${new URLSearchParams({
				projectName: options.projectName,
				leadId: options.leadId,
			})}`,
			{
				method: "GET",
				headers: { Authorization: `Bearer ${options.token}` },
				...(options.signal ? { signal: options.signal } : {}),
			},
		);
	} catch {
		throw new Error("persona_activation_unavailable");
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error("persona_activation_response_invalid");
	}
	if (!response.ok) {
		const reason =
			object(body) && typeof body.reason === "string"
				? body.reason
				: object(body) && typeof body.error === "string"
					? body.error
					: `http_${response.status}`;
		throw new Error(`persona_activation_rejected:${reason}`);
	}
	return parsePersonaActivationView(body);
}
