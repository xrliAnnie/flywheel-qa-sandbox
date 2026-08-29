/**
 * FLY-294 QA — local fake-Discord HTTP server.
 *
 * Layer A / C cannot make the REAL Discord API emit 429 / 5xx / a hung socket
 * on demand, so the reliability boundaries are exercised against this local
 * server. Everything else stays real: the code under test runs unchanged, the
 * request crosses a real TCP socket via the real global `fetch`, a real
 * `AbortController` aborts a real connection, and a real `Response` is parsed.
 * Only the destination (this server) is fake — and that is stated in the report.
 */
import http from "node:http";

/**
 * Bind the genuine global fetch ONCE at module load, before any test patches
 * `globalThis.fetch` (Layer C does, to reach base code that has no fetch seam).
 * The rewriting fetch must call THIS, never the late-bound global, or a global
 * patch turns it into infinite recursion.
 */
const REAL_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

export interface FakeReq {
	method: string;
	url: string;
	headers: http.IncomingHttpHeaders;
	body: string;
	/** 1-based request ordinal across the server's lifetime. */
	n: number;
}

export interface FakeRes {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
	/** Hold the response open this long before sending (to trip abort timeouts). */
	delayMs?: number;
}

export type FakeHandler = (req: FakeReq) => FakeRes;

export interface FakeDiscord {
	origin: string;
	port: number;
	requests: FakeReq[];
	/** Real fetch that rewrites the discord.com origin to this local server. */
	rewritingFetch: typeof fetch;
	close: () => Promise<void>;
}

export async function startFakeDiscord(
	handler: FakeHandler,
): Promise<FakeDiscord> {
	let n = 0;
	const requests: FakeReq[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c as Buffer));
		req.on("end", () => {
			n += 1;
			const fr: FakeReq = {
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf8"),
				n,
			};
			requests.push(fr);
			const r = handler(fr);
			const send = () => {
				const payload =
					r.body === undefined
						? ""
						: typeof r.body === "string"
							? r.body
							: JSON.stringify(r.body);
				res.writeHead(r.status, {
					"content-type": "application/json",
					...(r.headers ?? {}),
				});
				res.end(payload);
			};
			if (r.delayMs && r.delayMs > 0) {
				const timer = setTimeout(send, r.delayMs);
				// If the client aborts (per-attempt timeout), the socket closes —
				// drop the pending response so the process can exit cleanly.
				res.on("close", () => clearTimeout(timer));
			} else {
				send();
			}
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	const origin = `http://127.0.0.1:${port}`;
	const rewritingFetch = ((url: unknown, init?: unknown) => {
		const rewritten = String(url).replace("https://discord.com", origin);
		return REAL_FETCH(rewritten, init as RequestInit);
	}) as typeof fetch;
	return {
		origin,
		port,
		requests,
		rewritingFetch,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

// ── tiny PASS/FAIL evidence harness ──────────────────────────
let passes = 0;
let fails = 0;
export function check(id: string, desc: string, ok: boolean, evidence: string) {
	const tag = ok ? "PASS" : "FAIL";
	if (ok) passes += 1;
	else fails += 1;
	console.log(`[${tag}] ${id}  ${desc}\n        ↳ ${evidence}`);
}
export function summary(layer: string): number {
	console.log(
		`\n=== ${layer} SUMMARY: ${passes} PASS / ${fails} FAIL (${passes + fails} checks) ===`,
	);
	return fails;
}
export function resetCounters() {
	passes = 0;
	fails = 0;
}
