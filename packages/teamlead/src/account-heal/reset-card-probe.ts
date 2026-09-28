/**
 * FLY-2896 — production wiring of the reset-card runtime for the quota daemon.
 *
 * Reads are the two GETs the account-detail observer already makes (profile,
 * usage with the card block) under the installed CLI's UA; the one POST lives
 * in reset-card-redeem.ts. The origin is fixed unless a test injects both
 * `baseUrl` and `fetchFn`; no environment variable can redirect it.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseProfile } from "../claude-quota/account-detail-observer.js";
import { readClaudeAccountDetailStore } from "../claude-quota/account-detail-store.js";
import {
	commitResetCardRecoveryInStore,
	readStoreStrict,
} from "./account-store.js";
import { readClaudeCliVersion } from "./claude-cli-version.js";
import { readPoolMonitorCredentialSnapshot } from "./quota-monitor-credentials.js";
import { validatePayload } from "./quota-usage-api.js";
import { parseCedarStatus } from "./reset-card-contract.js";
import { makeResetCardFiles } from "./reset-card-files.js";
import type {
	CardProfileRead,
	CardStatusRead,
	ResetCardRuntime,
} from "./reset-card-flow.js";
import { redeemResetCard } from "./reset-card-redeem.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const USAGE_PATH = "/api/oauth/usage?cedar_ember=1&skip_spend=1";

export interface ResetCardRuntimeOptions {
	dir: string;
	poolDir: string;
	storePath: string;
	/** Test-only; must come with `fetchFn`. */
	baseUrl?: string;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
	readCliVersion?: () => Promise<string | null>;
}

async function boundedJson(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (reader === undefined) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return null;
	}
}

export function makeResetCardRuntime(
	options: ResetCardRuntimeOptions,
): ResetCardRuntime {
	if (options.baseUrl !== undefined && options.fetchFn === undefined) {
		throw new Error("reset_card_test_origin_requires_fetch_injection");
	}
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
	const fetchFn = options.fetchFn ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const get = async (
		path: string,
		accessToken: string,
		userAgent: string | null,
	): Promise<{ ok: unknown } | { error: string }> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchFn(`${baseUrl}${path}`, {
				method: "GET",
				redirect: "error",
				signal: controller.signal,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"anthropic-beta": "oauth-2025-04-20",
					Accept: "application/json",
					...(userAgent === null ? {} : { "User-Agent": userAgent }),
				},
			});
			if (response.status === 401) return { error: "unauthorized" };
			if (response.status === 403) return { error: "forbidden" };
			if (response.status === 429) return { error: "rate_limited" };
			if (!response.ok) return { error: "http" };
			const body = await boundedJson(response);
			return body === null ? { error: "malformed" } : { ok: body };
		} catch {
			return { error: controller.signal.aborted ? "timeout" : "network" };
		} finally {
			clearTimeout(timer);
		}
	};

	return {
		files: makeResetCardFiles(options.dir),
		readAccountCards: () =>
			new Map(
				(
					readClaudeAccountDetailStore(
						join(options.dir, "account-details.json"),
					)?.accounts ?? []
				).map((account) => [
					account.name,
					account.resetGrants?.known
						? (account.resetGrants.grants?.map((grant) => ({
								count: grant.resetsLeft,
								endsAt: grant.endsAt,
							})) ?? null)
						: null,
				]),
			),
		async fetchCardStatus(accessToken, cliVersion): Promise<CardStatusRead> {
			const read = await get(
				USAGE_PATH,
				accessToken,
				`claude-cli/${cliVersion} (external, cli)`,
			);
			if ("error" in read) return read;
			const payload = validatePayload(read.ok);
			if (payload === null) return { error: "usage_malformed" };
			const cedar = parseCedarStatus(read.ok);
			if ("error" in cedar) return { error: `cedar_${cedar.error}` };
			return {
				ok: {
					usage: {
						raw: payload,
						fiveH: {
							pct: payload.five_hour.utilization,
							resetsAt: payload.five_hour.resets_at,
						},
						sevenD: {
							pct: payload.seven_day.utilization,
							resetsAt: payload.seven_day.resets_at,
						},
					},
					cedar: cedar.ok,
				},
			};
		},
		async fetchProfile(accessToken): Promise<CardProfileRead> {
			const read = await get("/api/oauth/profile", accessToken, null);
			if ("error" in read) return read;
			const profile = parseProfile(read.ok);
			return profile === null
				? { error: "profile_malformed" }
				: {
						ok: {
							organizationUuid: profile.organizationUuid,
							subscription: profile.subscription,
						},
					};
		},
		readCliVersion: options.readCliVersion ?? (() => readClaudeCliVersion()),
		redeem: (approved, request) =>
			redeemResetCard(approved, {
				...request,
				...(options.baseUrl === undefined
					? {}
					: { baseUrl: options.baseUrl, fetchFn }),
			}),
		readPoolCredentialSnapshot: async (name) =>
			readPoolMonitorCredentialSnapshot(options.poolDir, name),
		readStoreStrict: async () => readStoreStrict(options.storePath),
		commitRecovery: async (input) =>
			commitResetCardRecoveryInStore(options.storePath, input),
		randomUUID: () => randomUUID(),
	};
}
