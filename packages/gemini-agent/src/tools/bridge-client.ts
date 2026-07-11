/**
 * FLY-1018 BridgeClient (plan §2.1/§2.8) — the agent's ONLY outbound HTTP
 * face. Guardrail layer 3 lives here structurally:
 *
 *  1. Endpoint whitelist checked BEFORE fetch — a URL outside the 6+1 tool
 *     routes (including any reserved action path) throws without ever
 *     touching the network (Codex R1-3).
 *  2. Single allowed origin: the configured FLYWHEEL_BRIDGE_URL.
 *  3. Bearer credential is the agent-scoped token only (config red line:
 *     never the master teamlead token in production — see README).
 *
 * Error bodies pass through verbatim (the model self-corrects on 4xx —
 * spike N4). Transport-layer failures (timeout/disconnect) retry ONCE;
 * HTTP >= 400 is NOT a transport failure and never retries (§2.4).
 */

import { AbortedError } from "../errors.js";
import type { ToolResult } from "../types.js";

export class EndpointNotAllowedError extends Error {
	constructor(method: string, path: string) {
		super(
			`endpoint not in whitelist: ${method} ${path} — gemini-agent may only call its 6+1 tool routes`,
		);
		this.name = "EndpointNotAllowedError";
	}
}

/** The complete reachable set (mirrors the M4 server-side scoped-token map). */
const WHITELIST: Array<{ method: string; pattern: RegExp }> = [
	{ method: "POST", pattern: /^\/api\/linear\/create-issue$/ },
	{ method: "POST", pattern: /^\/api\/runs\/start$/ },
	{ method: "GET", pattern: /^\/api\/sessions\/[^/]+\/status$/ },
	{ method: "POST", pattern: /^\/api\/memory\/search$/ },
	{ method: "POST", pattern: /^\/api\/memory\/add$/ },
	{ method: "POST", pattern: /^\/api\/ship-approval-request$/ },
];

export function isWhitelistedEndpoint(method: string, path: string): boolean {
	return WHITELIST.some((w) => w.method === method && w.pattern.test(path));
}

export interface BridgeClientOptions {
	baseUrl: string;
	token: string;
	timeoutMs: number;
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

export class BridgeClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly fetchFn: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(opts: BridgeClientOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.token = opts.token;
		this.timeoutMs = opts.timeoutMs;
		this.fetchFn = opts.fetchFn ?? fetch;
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	/**
	 * Whitelist-gated request. Throws EndpointNotAllowedError BEFORE any
	 * network activity for a path outside the reachable set.
	 */
	async request(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<ToolResult> {
		if (!isWhitelistedEndpoint(method, path)) {
			throw new EndpointNotAllowedError(method, path);
		}

		const doFetch = async (): Promise<ToolResult> => {
			const signals = [AbortSignal.timeout(this.timeoutMs)];
			if (signal) signals.push(signal);
			const res = await this.fetchFn(`${this.baseUrl}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${this.token}`,
					...(body !== undefined && { "content-type": "application/json" }),
				},
				...(body !== undefined && { body: JSON.stringify(body) }),
				signal: AbortSignal.any(signals),
			});
			const text = await res.text();
			const bodyOut = isJson(text)
				? text
				: JSON.stringify({
						error: "non-JSON response",
						raw: text.slice(0, 500),
					});
			return { ok: res.ok, httpStatus: res.status, body: bodyOut };
		};

		try {
			return await doFetch();
		} catch (err) {
			if (signal?.aborted) throw new AbortedError();
			// transport-layer failure only (fetch threw — timeout/disconnect):
			// single retry, then propagate (§2.4 tool row)
			await this.sleep(500);
			try {
				return await doFetch();
			} catch (err2) {
				if (signal?.aborted) throw new AbortedError();
				throw err2 ?? err;
			}
		}
	}
}

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}
