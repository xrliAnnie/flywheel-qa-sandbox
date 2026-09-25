/**
 * FLY-2864 — each Codex (ChatGPT) account's next charge date.
 *
 * One read-only GET per slot to `chatgpt.com/backend-api/subscriptions`, with
 * the same bearer + account-id binding as the WHAM usage reader. Deliberately
 * `node:https`, not `fetch`: the endpoint's Cloudflare rule challenges undici
 * (403 `cf-mitigated: challenge`) but serves a plain client that names itself.
 * Never refreshes, persists or rotates any token; never follows a redirect.
 */

import { readFileSync } from "node:fs";
import type {
	ClientRequest,
	IncomingHttpHeaders,
	IncomingMessage,
	RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import {
	type CodexAccountPool,
	identifyCodexAuth,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { codexInstallAccountKey } from "flywheel-claude-runner/bin/codex-account-install.mjs";
import { normalizeExternalInstant } from "../quota-external-instant.js";
import type {
	CodexSubscriptionReading,
	CodexSubscriptionStore,
} from "./codex-subscription-store.js";
import { readVerifiedCodexAuth } from "./readonly-usage-reader.js";

const ENDPOINT = "https://chatgpt.com/backend-api/subscriptions";
const USER_AGENT = "flywheel-accounts-page/1";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TOTAL_DEADLINE_MS = 20_000;
const ACCOUNT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodexSubscriptionResponse {
	status: number;
	headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
	body: string;
}

export type CodexSubscriptionRequest = (input: {
	method: "GET";
	url: string;
	headers: Record<string, string>;
	timeoutMs: number;
	maxBytes: number;
	signal?: AbortSignal;
}) => Promise<CodexSubscriptionResponse>;

export type CodexSubscriptionFact =
	| { status: "active"; renewsAt: string }
	| { status: "canceled"; endsAt: string | null }
	| { status: "none" };

export type CodexSubscriptionError =
	| "unauthorized"
	| "forbidden"
	| "blocked"
	| "network"
	| "malformed";

export type CodexSubscriptionResult =
	| { ok: CodexSubscriptionFact }
	| { error: CodexSubscriptionError };

type RequestImpl = (
	url: string,
	options: RequestOptions,
	callback: (response: IncomingMessage) => void,
) => ClientRequest;

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function header(
	headers: CodexSubscriptionResponse["headers"],
	name: string,
): string {
	const value = headers[name];
	return (Array.isArray(value) ? value.join(",") : (value ?? "")).toLowerCase();
}

/**
 * A GET with a total wall clock and a body cap. `requestImpl` is `https.request`
 * in production; tests pass `http.request` against a loopback server.
 */
export function createCodexSubscriptionTransport(
	requestImpl: RequestImpl = httpsRequest,
): CodexSubscriptionRequest {
	return (input) =>
		new Promise((resolve, reject) => {
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				req.destroy();
				reject(error);
			};
			const req = requestImpl(
				input.url,
				{
					method: input.method,
					headers: input.headers,
					...(input.signal ? { signal: input.signal } : {}),
				},
				(response) => {
					const chunks: Buffer[] = [];
					let size = 0;
					response.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > input.maxBytes) {
							fail(new Error("codex_subscription_response_too_large"));
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						resolve({
							status: response.statusCode ?? 0,
							headers: response.headers,
							body: Buffer.concat(chunks).toString("utf8"),
						});
					});
					response.on("error", (error) => fail(error));
				},
			);
			const timer = setTimeout(
				() => fail(new Error("codex_subscription_timeout")),
				input.timeoutMs,
			);
			req.on("error", (error) => fail(error));
			req.end();
		});
}

function optionalInstant(value: unknown): string | null | "invalid" {
	if (value === undefined || value === null) return null;
	return normalizeExternalInstant(value) ?? "invalid";
}

export function parseCodexSubscriptionResponse(
	response: CodexSubscriptionResponse,
): CodexSubscriptionResult {
	if (response.status === 401) return { error: "unauthorized" };
	if (response.status === 403) {
		const html =
			header(response.headers, "content-type").includes("text/html") ||
			/^\s*</.test(response.body);
		return header(response.headers, "cf-mitigated") === "challenge" || html
			? { error: "blocked" }
			: { error: "forbidden" };
	}
	if (response.status < 200 || response.status > 299) {
		return { error: "network" };
	}
	let body: unknown;
	try {
		body = JSON.parse(response.body);
	} catch {
		return { error: "malformed" };
	}
	if (!record(body) || !record(body.entitlement)) return { error: "malformed" };
	const entitlement = body.entitlement;
	if (entitlement.has_active_subscription === false) {
		return { ok: { status: "none" } };
	}
	if (entitlement.has_active_subscription !== true) {
		return { error: "malformed" };
	}
	// Validate every date first: an invalid cancels_at must never decide "canceled".
	const cancelsAt = optionalInstant(entitlement.cancels_at);
	const activeUntil = optionalInstant(body.active_until);
	const expiresAt = optionalInstant(entitlement.expires_at);
	const renewsAt = optionalInstant(entitlement.renews_at);
	if ([cancelsAt, activeUntil, expiresAt, renewsAt].includes("invalid")) {
		return { error: "malformed" };
	}
	if (cancelsAt !== null || body.will_renew === false) {
		return {
			ok: { status: "canceled", endsAt: cancelsAt ?? activeUntil ?? expiresAt },
		};
	}
	return renewsAt === null
		? { error: "malformed" }
		: { ok: { status: "active", renewsAt: renewsAt as string } };
}

export interface ObserveCodexSubscriptionsOptions {
	profilesRoot: string;
	/** `<codex home>/auth.json`; the in-use account reads its live token here. */
	canonicalAuthPath: string;
	pool: () => CodexAccountPool;
	previous?: CodexSubscriptionStore | null;
	now?: () => number;
	signal?: AbortSignal;
	totalDeadlineMs?: number;
	/** Test-only transport injection; production uses `node:https`. */
	request?: CodexSubscriptionRequest;
}

type SlotOutcome =
	| { ok: CodexSubscriptionFact }
	| { note: string; carry: boolean };

async function readSlot(
	authPath: string,
	pool: CodexAccountPool,
	accountKey: string,
	request: CodexSubscriptionRequest,
	signal: AbortSignal,
): Promise<SlotOutcome> {
	const verified = readVerifiedCodexAuth(authPath, pool, accountKey);
	if (verified === null) return { note: "identity_mismatch", carry: true };
	if (!ACCOUNT_ID.test(verified.accountId)) {
		return { note: "account_id_invalid", carry: true };
	}
	try {
		const response = await request({
			method: "GET",
			url: `${ENDPOINT}?account_id=${encodeURIComponent(verified.accountId)}`,
			headers: {
				Authorization: `Bearer ${verified.accessToken}`,
				"ChatGPT-Account-Id": verified.accountId,
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			timeoutMs: REQUEST_TIMEOUT_MS,
			maxBytes: MAX_RESPONSE_BYTES,
			signal,
		});
		const parsed = parseCodexSubscriptionResponse(response);
		return "ok" in parsed ? parsed : { note: parsed.error, carry: true };
	} catch {
		return { note: signal.aborted ? "deadline" : "network", carry: true };
	}
}

export async function observeCodexSubscriptions(
	options: ObserveCodexSubscriptionsOptions,
): Promise<CodexSubscriptionStore> {
	const nowIso = new Date((options.now ?? Date.now)()).toISOString();
	const pool = options.pool();
	const request = options.request ?? createCodexSubscriptionTransport();
	const previousByName = new Map(
		(options.previous?.accounts ?? []).map((account) => [
			account.name,
			account,
		]),
	);
	let canonicalAccountKey: string | null = null;
	try {
		canonicalAccountKey = codexInstallAccountKey(
			identifyCodexAuth(readFileSync(options.canonicalAuthPath, "utf8"), pool),
		);
	} catch {
		/* an unreadable canonical home only means "no slot is provably in use" */
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) controller.abort();
	const timer = setTimeout(
		() => controller.abort(),
		options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS,
	);

	const settle = (
		name: string,
		identityKey: string,
		outcome: SlotOutcome,
	): CodexSubscriptionReading => {
		if ("ok" in outcome) {
			return {
				name,
				identityKey,
				observedAt: nowIso,
				status: outcome.ok.status,
				renewsAt: outcome.ok.status === "active" ? outcome.ok.renewsAt : null,
				endsAt: outcome.ok.status === "canceled" ? outcome.ok.endsAt : null,
				note: null,
			};
		}
		const previous = previousByName.get(name);
		// Only the same login's last real reading may stand in for this round.
		if (
			outcome.carry &&
			previous?.identityKey === identityKey &&
			previous.status !== "unknown"
		) {
			return { ...previous, name, identityKey, note: outcome.note };
		}
		return {
			name,
			identityKey,
			observedAt: null,
			status: "unknown",
			renewsAt: null,
			endsAt: null,
			note: outcome.note,
		};
	};

	try {
		const slots = pool.slots.filter((slot) => slot.state !== "invalid_name");
		const accounts = await Promise.all(
			slots.map(async (slot): Promise<CodexSubscriptionReading> => {
				const orphan = (note: string): CodexSubscriptionReading => ({
					name: slot.name,
					observedAt: null,
					status: "unknown",
					renewsAt: null,
					endsAt: null,
					note,
				});
				const problem = pool.problems.find(
					(entry) => entry.name === slot.name,
				)?.code;
				if (problem) {
					return slot.identity
						? settle(slot.name, codexInstallAccountKey(slot.identity), {
								note: `problem:${problem}`,
								carry: true,
							})
						: orphan(`problem:${problem}`);
				}
				const slotAuthPath = join(options.profilesRoot, slot.name, "auth.json");
				let accountKey: string;
				try {
					accountKey = codexInstallAccountKey(
						identifyCodexAuth(readFileSync(slotAuthPath, "utf8"), pool),
					);
				} catch {
					return orphan("problem:read_failed");
				}
				if (controller.signal.aborted) {
					return settle(slot.name, accountKey, {
						note: "deadline",
						carry: true,
					});
				}
				return settle(
					slot.name,
					accountKey,
					await readSlot(
						accountKey === canonicalAccountKey
							? options.canonicalAuthPath
							: slotAuthPath,
						pool,
						accountKey,
						request,
						controller.signal,
					),
				);
			}),
		);
		return { version: 1, generatedAt: nowIso, accounts };
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
