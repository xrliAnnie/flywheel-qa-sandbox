import { isDeepStrictEqual } from "node:util";
import { attemptBytes } from "./decisions.js";
import { validateAttemptResult } from "./results.js";
import type {
	CustomerAttemptResult,
	CustomerReadyAttempt,
	CustomerReleasePermit,
} from "./types.js";

interface MailboxOptions {
	endpoint: string;
	token: string;
	audience: string;
	activationEpoch: number;
	fetch?: typeof fetch;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
function fail(): never {
	throw new Error("customer release transport unavailable");
}
function exact(
	value: unknown,
	keys: string[],
): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
function cursorValid(value: unknown): value is string {
	return typeof value === "string" && /^[\x21-\x7e]{1,1024}$/.test(value);
}

/** Decision-writer transport only. No executor token, publication operation,
 * readiness inference, retry loop or second cycle authority lives here. */
export class CustomerReleaseMailbox {
	private readonly endpoint: string;
	private readonly token: string;
	private readonly fetch: typeof fetch;
	private readonly audience: string;
	private readonly activationEpoch: number;
	constructor(options: MailboxOptions) {
		let url: URL;
		try {
			url = new URL(options.endpoint);
		} catch {
			fail();
		}
		if (
			(url.protocol !== "https:" &&
				!(
					url.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
				)) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			!options.token ||
			/[\r\n]/.test(options.token) ||
			!id.test(options.audience) ||
			!Number.isSafeInteger(options.activationEpoch) ||
			options.activationEpoch < 0
		)
			fail();
		this.endpoint = url.origin;
		this.token = options.token;
		this.fetch = options.fetch ?? fetch;
		this.audience = options.audience;
		this.activationEpoch = options.activationEpoch;
	}
	private attempt(value: unknown, currentEpoch: boolean): CustomerReadyAttempt {
		if (!value || typeof value !== "object") fail();
		const attempt = value as CustomerReadyAttempt;
		attemptBytes(attempt); // rejects unknown/missing fields including the full B0 tuple
		const binding = attempt.fullBinding;
		if (
			!uuid.test(attempt.attemptId) ||
			!id.test(attempt.cycleId) ||
			attempt.projectId !== "flywheel" ||
			attempt.audience !== this.audience ||
			!Number.isSafeInteger(attempt.activationEpoch) ||
			attempt.activationEpoch < 0 ||
			(currentEpoch && attempt.activationEpoch !== this.activationEpoch) ||
			!digest.test(attempt.nonce) ||
			typeof attempt.baseEtag !== "string" ||
			!/^[\x21-\x7e]{1,128}$/.test(attempt.baseEtag) ||
			!Number.isSafeInteger(attempt.readyAt) ||
			attempt.readyAt < 0 ||
			!digest.test(attempt.readbackSha256) ||
			typeof binding.releaseId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(binding.releaseId) ||
			typeof binding.betaVersion !== "string" ||
			typeof binding.releaseVersion !== "string" ||
			!digest.test(binding.betaPayloadSha256) ||
			!digest.test(binding.releasePayloadSha256) ||
			!/^[a-f0-9]{40}$/.test(binding.sourceCommit) ||
			attempt.readbackSha256 !== binding.releasePayloadSha256
		)
			fail();
		return attempt;
	}
	private async request(
		path: string,
		method = "GET",
		body?: string,
	): Promise<unknown> {
		try {
			const response = await this.fetch(`${this.endpoint}${path}`, {
				method,
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
				headers: {
					authorization: `Bearer ${this.token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body }),
			});
			if (!response.ok || response.redirected || !response.body) {
				await response.body?.cancel();
				fail();
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder("utf-8", { fatal: true });
			let bytes = 0,
				text = "";
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					bytes += chunk.value.byteLength;
					if (bytes > 4 * 1024 * 1024) {
						await reader.cancel();
						fail();
					}
					text += decoder.decode(chunk.value, { stream: true });
				}
				text += decoder.decode();
			} finally {
				reader.releaseLock();
			}
			return JSON.parse(text);
		} catch {
			fail();
		}
	}
	async pending(
		cursor?: string,
	): Promise<{ attempts: CustomerReadyAttempt[]; cursor: string | null }> {
		if (cursor !== undefined && !cursorValid(cursor)) fail();
		const params = new URLSearchParams({ limit: "1" });
		if (cursor !== undefined) params.set("cursor", cursor);
		const page = await this.request(
			`/admin/release-attempts/pending?${params}`,
		);
		if (
			!exact(page, ["attempts", "cursor"]) ||
			!Array.isArray(page.attempts) ||
			page.attempts.length > 1 ||
			(page.cursor !== null &&
				(!cursorValid(page.cursor) || page.cursor === cursor))
		)
			fail();
		return {
			attempts: page.attempts.map((value) => this.attempt(value, true)),
			cursor: page.cursor as string | null,
		};
	}
	private permitAttempt(permit: CustomerReleasePermit): CustomerReadyAttempt {
		// The persisted permit adds authorization fields to the immutable attempt.
		const {
			attemptId,
			cycleId,
			projectId,
			audience,
			activationEpoch,
			nonce,
			baseEtag,
			readyAt,
			fullBinding,
			readbackSha256,
		} = permit;
		return this.attempt(
			{
				attemptId,
				cycleId,
				projectId,
				audience,
				activationEpoch,
				nonce,
				baseEtag,
				readyAt,
				fullBinding,
				readbackSha256,
			},
			false,
		);
	}
	async deliverPermit(permit: CustomerReleasePermit): Promise<void> {
		const attempt = this.permitAttempt(permit);
		const result = await this.request(
			`/admin/release-attempts/${attempt.attemptId}/permit`,
			"PUT",
			JSON.stringify(permit),
		);
		if (!exact(result, ["ok"]) || result.ok !== true) fail();
	}
	async observe(
		permit: CustomerReleasePermit,
	): Promise<CustomerAttemptResult | null> {
		const expected = this.permitAttempt(permit);
		const observation = await this.request(
			`/admin/release-attempts/${expected.attemptId}`,
		);
		if (
			!exact(observation, ["attempt", "permit", "result"]) ||
			attemptBytes(this.attempt(observation.attempt, false)) !==
				attemptBytes(expected) ||
			(observation.permit !== null &&
				!isDeepStrictEqual(observation.permit, permit))
		)
			fail();
		// Lost permit delivery and an executor that has not started are both
		// unresolved. Neither is evidence that a previous execution made no write.
		if (observation.result === null) return null;
		if (observation.permit === null) fail();
		const result = observation.result as CustomerAttemptResult;
		validateAttemptResult(result, permit);
		return result;
	}
	async requestFence(
		permit: CustomerReleasePermit,
		reason: string,
	): Promise<void> {
		const attempt = this.permitAttempt(permit);
		if (!id.test(reason)) fail();
		const result = await this.request(
			`/admin/release-attempts/${attempt.attemptId}/fence-intent`,
			"PUT",
			JSON.stringify({
				decisionId: permit.decisionId,
				nonce: permit.nonce,
				baseEtag: permit.baseEtag,
				fullBinding: permit.fullBinding,
				reason,
			}),
		);
		if (!exact(result, ["ok"]) || result.ok !== true) fail();
	}
}
