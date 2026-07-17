import { createHash } from "node:crypto";

const DEFAULT_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ProfileIdentity {
	email: string;
	uuid: string;
}

export interface ExpectedAccountIdentity {
	email: string;
	uuid?: string;
}

export type ProfileIdentityError =
	| "profile_network"
	| "profile_unauthorized"
	| "profile_malformed";

export type ProfileIdentityResult =
	| ProfileIdentity
	| { error: ProfileIdentityError };

export interface FetchProfileIdentityOptions {
	endpoint?: string;
	timeoutMs?: number;
	fetchFn?: typeof fetch;
}

export type IdentityComparison = "match" | "mismatch" | "unknown_missing";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
	return value.trim().toLowerCase();
}

function parseProfile(value: unknown): ProfileIdentity | null {
	if (!isRecord(value) || !isRecord(value.account)) return null;
	const { email, uuid } = value.account;
	if (typeof email !== "string" || typeof uuid !== "string") return null;
	const normalizedEmail = normalize(email);
	const normalizedUuid = normalize(uuid);
	if (normalizedEmail.length === 0 || normalizedUuid.length === 0) return null;
	return { email: normalizedEmail, uuid: normalizedUuid };
}

async function requestProfile(
	accessToken: string,
	opts: FetchProfileIdentityOptions,
	signal: AbortSignal,
): Promise<ProfileIdentityResult> {
	const fetchFn = opts.fetchFn ?? fetch;
	const endpoint =
		opts.endpoint ??
		process.env.FLYWHEEL_PROFILE_IDENTITY_ENDPOINT ??
		DEFAULT_PROFILE_ENDPOINT;
	const response = await fetchFn(endpoint, {
		method: "GET",
		signal,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"anthropic-beta": "oauth-2025-04-20",
			Accept: "application/json",
		},
	});
	if (response.status === 401) return { error: "profile_unauthorized" };
	if (!response.ok) return { error: "profile_network" };

	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		return { error: "profile_malformed" };
	}
	return parseProfile(raw) ?? { error: "profile_malformed" };
}

/** Resolve the real account identity for one OAuth token without returning secrets. */
export async function fetchProfileIdentity(
	accessToken: string,
	opts: FetchProfileIdentityOptions = {},
): Promise<ProfileIdentityResult> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<ProfileIdentityResult>((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve({ error: "profile_network" });
		}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	});

	try {
		return await Promise.race([
			requestProfile(accessToken, opts, controller.signal).catch(() => ({
				error: "profile_network" as const,
			})),
			timedOut,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Canonical comparison key: trusted uuid wins, otherwise normalized email. */
export function identityKey(identity: ExpectedAccountIdentity): string {
	const uuid = identity.uuid === undefined ? "" : normalize(identity.uuid);
	return uuid.length > 0
		? `uuid:${uuid}`
		: `email:${normalize(identity.email)}`;
}

export function compareAccountIdentity(
	expected: ExpectedAccountIdentity | undefined,
	actual: ProfileIdentity,
): IdentityComparison {
	if (expected === undefined) return "unknown_missing";
	const expectedUuid =
		expected.uuid === undefined ? "" : normalize(expected.uuid);
	const matches =
		expectedUuid.length > 0
			? expectedUuid === normalize(actual.uuid)
			: normalize(expected.email) === normalize(actual.email);
	return matches ? "match" : "mismatch";
}

/** Non-PII stable fingerprint suitable for mismatch facts and logs. */
export function identityDigest(identity: ProfileIdentity): string {
	return createHash("sha256").update(identityKey(identity)).digest("hex");
}

/** Non-PII fingerprint for a trusted operator-provided identity expectation. */
export function expectedIdentityDigest(
	identity: ExpectedAccountIdentity,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				email: normalize(identity.email),
				uuid: identity.uuid === undefined ? "" : normalize(identity.uuid),
			}),
		)
		.digest("hex");
}
