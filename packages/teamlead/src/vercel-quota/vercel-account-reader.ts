/**
 * FLY-2875 — read-only reader for the report-hosting Vercel account.
 *
 * Three fixed GETs against `https://api.vercel.com`: the token's user, its
 * default team (plan and billing period) and the report Blob store. Never
 * writes, never follows redirects, and never lets a response body, an error
 * message or the token reach its result: every failure becomes a fixed note.
 */

import { createHash } from "node:crypto";
import {
	VERCEL_BLOB_STATUS,
	VERCEL_PLAN,
	VERCEL_TEAM_SLUG,
	VERCEL_USERNAME,
	type VercelAccountFacts,
	type VercelAccountStore,
	type VercelBlobFacts,
	type VercelReadNote,
	vercelAccountFailure,
} from "./vercel-account-store.js";

const ORIGIN = "https://api.vercel.com";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TEAM_ID = /^team_[A-Za-z0-9]{1,64}$/;
const STORE_API_ID = /^store_[A-Za-z0-9]{1,64}$/;
const MIN_PERIOD_MS = Date.UTC(2020, 0, 1);
const MAX_PERIOD_MS = Date.UTC(2100, 0, 1);

export interface ObserveVercelAccountOptions {
	token: string | undefined;
	/** The report registry's current store; a throw means it is unreadable. */
	resolveStoreApiId: () => string | undefined;
	signal?: AbortSignal;
	now?: () => Date;
	fetchImpl?: typeof fetch;
	requestTimeoutMs?: number;
}

type Read<T> = { ok: true; value: T } | { ok: false; note: VercelReadNote };

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (note: VercelReadNote): { ok: false; note: VercelReadNote } => ({
	ok: false,
	note,
});

async function boundedText(response: Response): Promise<string | null> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function statusNote(status: number, body: unknown): VercelReadNote {
	if (status === 401) return "unauthorized";
	if (status === 403) {
		return record(body) &&
			record(body.error) &&
			body.error.invalidToken === true
			? "unauthorized"
			: "forbidden";
	}
	if (status === 404) return "not_found";
	if (status === 429) return "rate_limited";
	return "http_error";
}

async function getJson(
	path: string,
	options: ObserveVercelAccountOptions & { token: string },
): Promise<Read<unknown>> {
	const signals = [
		AbortSignal.timeout(options.requestTimeoutMs ?? 10_000),
		...(options.signal ? [options.signal] : []),
	];
	try {
		const response = await (options.fetchImpl ?? fetch)(`${ORIGIN}${path}`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${options.token}`,
				Accept: "application/json",
			},
			redirect: "error",
			signal: AbortSignal.any(signals),
		});
		const text = await boundedText(response);
		if (text === null) return fail("malformed");
		const body = parseJson(text);
		if (!response.ok) return fail(statusNote(response.status, body));
		return body === undefined ? fail("malformed") : { ok: true, value: body };
	} catch (error) {
		const name =
			typeof error === "object" && error !== null && "name" in error
				? (error as { name: unknown }).name
				: undefined;
		return fail(
			options.signal?.aborted ||
				signals[0]!.aborted ||
				name === "AbortError" ||
				name === "TimeoutError"
				? "deadline"
				: "network",
		);
	}
}

function lowerToken(value: unknown, pattern: RegExp): string | null {
	if (typeof value !== "string") return null;
	const lower = value.toLowerCase();
	return pattern.test(lower) ? lower : null;
}

function validEmail(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 320 &&
		value.includes("@") &&
		![...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	);
}

interface VercelUser {
	emailSha256: string;
	username: string;
	teamId: string;
}

function parseUser(body: unknown): Read<VercelUser> {
	const user = record(body) ? body.user : undefined;
	if (
		!record(user) ||
		!validEmail(user.email) ||
		typeof user.username !== "string" ||
		!VERCEL_USERNAME.test(user.username) ||
		typeof user.defaultTeamId !== "string" ||
		!TEAM_ID.test(user.defaultTeamId)
	) {
		return fail("malformed");
	}
	return {
		ok: true,
		value: {
			emailSha256: createHash("sha256")
				.update(user.email.trim().toLowerCase())
				.digest("hex"),
			username: user.username,
			teamId: user.defaultTeamId,
		},
	};
}

function parsePeriodEnd(period: unknown): Read<string | null> {
	if (period === null || period === undefined) return { ok: true, value: null };
	if (!record(period)) return fail("malformed");
	const end = period.end;
	if (
		typeof end !== "number" ||
		!Number.isSafeInteger(end) ||
		end < MIN_PERIOD_MS ||
		end >= MAX_PERIOD_MS
	) {
		return fail("malformed");
	}
	return { ok: true, value: new Date(end).toISOString() };
}

function parseTeam(body: unknown, user: VercelUser): Read<VercelAccountFacts> {
	if (!record(body) || !record(body.billing)) return fail("malformed");
	const billing = body.billing;
	const slug = typeof body.slug === "string" ? body.slug : null;
	const plan = lowerToken(billing.plan, VERCEL_PLAN);
	const status =
		billing.status === null || billing.status === undefined
			? null
			: lowerToken(billing.status, VERCEL_PLAN);
	const periodEnd = parsePeriodEnd(billing.period);
	if (
		slug === null ||
		!VERCEL_TEAM_SLUG.test(slug) ||
		plan === null ||
		(billing.status !== null &&
			billing.status !== undefined &&
			status === null) ||
		!periodEnd.ok
	) {
		return fail("malformed");
	}
	return {
		ok: true,
		value: {
			emailSha256: user.emailSha256,
			username: user.username,
			teamSlug: slug,
			plan,
			billingStatus: status,
			periodEnd: periodEnd.value,
			canceled:
				billing.cancelation !== null && billing.cancelation !== undefined,
		},
	};
}

function parseStore(body: unknown, teamId: string): Read<VercelBlobFacts> {
	const store = record(body) ? body.store : undefined;
	if (!record(store) || typeof store.ownerId !== "string") {
		return fail("malformed");
	}
	const status = lowerToken(store.status, VERCEL_BLOB_STATUS);
	if (
		status === null ||
		!Number.isSafeInteger(store.size) ||
		(store.size as number) < 0 ||
		!Number.isSafeInteger(store.count) ||
		(store.count as number) < 0 ||
		typeof store.usageQuotaExceeded !== "boolean"
	) {
		return fail("malformed");
	}
	if (store.ownerId !== teamId) return fail("owner_mismatch");
	return {
		ok: true,
		value: {
			status,
			sizeBytes: store.size as number,
			count: store.count as number,
			usageQuotaExceeded: store.usageQuotaExceeded,
		},
	};
}

function resolveStore(
	resolveStoreApiId: () => string | undefined,
): Read<string> {
	let id: string | undefined;
	try {
		id = resolveStoreApiId();
	} catch {
		return fail("registry_unreadable");
	}
	return typeof id === "string" && STORE_API_ID.test(id)
		? { ok: true, value: id }
		: fail("no_store_binding");
}

/**
 * Fail closed if a response echoes the credential: every response-derived
 * string that is persisted or displayed is checked against the whole token and
 * its 8-character prefix (the leak-detection probe), case-insensitively.
 */
function echoesToken(values: Array<string | null>, token: string): boolean {
	const fragments = [token, token.slice(0, 8)].map((fragment) =>
		fragment.toLowerCase(),
	);
	return values.some(
		(value) =>
			value !== null &&
			fragments.some((fragment) => value.toLowerCase().includes(fragment)),
	);
}

/** Never rejects: every failure is a fixed note in the returned reading. */
export async function observeVercelAccount(
	options: ObserveVercelAccountOptions,
): Promise<VercelAccountStore> {
	const now = options.now?.() ?? new Date();
	const token = options.token?.trim();
	if (!token) return vercelAccountFailure("no_token", now);
	const authed = { ...options, token };

	const userRead = await getJson("/v2/user", authed);
	const user = userRead.ok ? parseUser(userRead.value) : userRead;
	if (!user.ok) return vercelAccountFailure(user.note, now);

	const storeId = resolveStore(options.resolveStoreApiId);
	const [teamRead, storeRead] = await Promise.all([
		getJson(`/v2/teams/${encodeURIComponent(user.value.teamId)}`, authed),
		storeId.ok
			? getJson(
					`/v1/storage/stores/${encodeURIComponent(storeId.value)}?teamId=${encodeURIComponent(user.value.teamId)}`,
					authed,
				)
			: Promise.resolve(storeId),
	]);
	const account = teamRead.ok
		? parseTeam(teamRead.value, user.value)
		: teamRead;
	// "In use" means account and Blob together: without the team there is no
	// account to own the store, so the store facts are dropped with its reason.
	if (!account.ok) return vercelAccountFailure(account.note, now);
	const facts = account.value;
	if (
		echoesToken(
			[facts.username, facts.teamSlug, facts.plan, facts.billingStatus],
			token,
		)
	) {
		return vercelAccountFailure("malformed", now);
	}
	const parsedBlob = storeRead.ok
		? parseStore(storeRead.value, user.value.teamId)
		: storeRead;
	const blob =
		parsedBlob.ok && echoesToken([parsedBlob.value.status], token)
			? fail("malformed")
			: parsedBlob;
	return {
		version: 1,
		observedAt: now.toISOString(),
		account: facts,
		accountNote: null,
		blob: blob.ok ? blob.value : null,
		blobNote: blob.ok ? null : blob.note,
	};
}
