/**
 * FLY-294 QA — Layer A: reliability boundaries of the #277 archiveChatThread /
 * removeUserFromChatThread, exercised over a REAL socket against the local
 * fake-Discord server. The functions run unchanged; only the destination is
 * faked (real Discord can't emit 429/5xx/hangs on demand). Timers are real
 * except where noted "value-asserted" (we check the sleep argument instead of
 * sleeping for the full capped/backoff window).
 */
import {
	type ArchiveChatThreadResult,
	archiveChatThread,
	removeUserFromChatThread,
} from "../packages/teamlead/src/bridge/chat-thread-utils.ts";
import { check, startFakeDiscord, summary } from "./fake-discord.mts";

/** A sleep that records its argument and really waits. */
function realMeasuredSleep() {
	const calls: number[] = [];
	const impl = async (ms: number) => {
		calls.push(ms);
		await new Promise((r) => setTimeout(r, ms));
	};
	return { calls, impl };
}
/** A sleep that records its argument but does NOT wait (value-assertion only). */
function recordingSleep() {
	const calls: number[] = [];
	const impl = async (ms: number) => {
		calls.push(ms);
	};
	return { calls, impl };
}

console.log(
	"######## FLY-294 LAYER A — reliability (real socket, fake Discord) ########\n",
);

// A0 — PR-#277 guard: refuse to run unless the imported archiveChatThread is
// the hardened #277 version. The pre-#277 base returns Promise<void> (undefined)
// and has no deps seam; #277 returns a structured ArchiveChatThreadResult. A
// behavioral probe is stronger than a commit pin — it proves the actually-loaded
// code is #277, so this harness can't silently certify the wrong checkout.
{
	const probe = await startFakeDiscord(() => ({
		status: 200,
		body: { thread_metadata: { archived: true } },
	}));
	const r = await archiveChatThread("pr277-guard", "bot", {
		fetchImpl: probe.rewritingFetch,
	});
	await probe.close();
	if (!r || typeof r.reason !== "string" || typeof r.attempts !== "number") {
		console.error(
			`FATAL: archiveChatThread is NOT the #277 version (got ${JSON.stringify(r)}). ` +
				"This harness must run against the #277 code (worktree at flywheel-FLY-292).",
		);
		process.exit(2);
	}
	check(
		"A0",
		"PR-#277 guard: loaded archiveChatThread returns ArchiveChatThreadResult (not base void)",
		r.reason === "ok" && r.archived === true,
		`probeResult={archived:${r.archived},attempts:${r.attempts},reason:${r.reason}} (base would be undefined → harness aborts)`,
	);
}

// A1 — first-try 2xx archives in a single real PATCH.
{
	const fake = await startFakeDiscord(() => ({
		status: 200,
		body: { thread_metadata: { archived: true } },
	}));
	const t0 = Date.now();
	const res = await archiveChatThread("tA1", "bot", {
		fetchImpl: fake.rewritingFetch,
	});
	const ms = Date.now() - t0;
	const req = fake.requests[0];
	check(
		"A1",
		"happy 200 → archived in 1 real PATCH",
		res.archived &&
			res.attempts === 1 &&
			res.reason === "ok" &&
			req.method === "PATCH" &&
			req.body === JSON.stringify({ archived: true }),
		`archived=${res.archived} attempts=${res.attempts} reason=${res.reason} method=${req.method} body=${req.body} elapsed=${ms}ms requests=${fake.requests.length}`,
	);
	await fake.close();
}

// A2 — 429 then 200; Retry-After honored with a REAL wall-clock wait (~1s).
{
	const fake = await startFakeDiscord((r) =>
		r.n === 1
			? {
					status: 429,
					body: { message: "rate" },
					headers: { "retry-after": "1" },
				}
			: { status: 200, body: { thread_metadata: { archived: true } } },
	);
	const sleep = realMeasuredSleep();
	const t0 = Date.now();
	const res = await archiveChatThread("tA2", "bot", {
		fetchImpl: fake.rewritingFetch,
		sleepImpl: sleep.impl,
	});
	const ms = Date.now() - t0;
	check(
		"A2",
		"429 + Retry-After honored (real ~1s wait) then 200",
		res.archived && res.attempts === 2 && sleep.calls[0] === 1000 && ms >= 950,
		`archived=${res.archived} attempts=${res.attempts} sleepArg=${sleep.calls[0]}ms realElapsed=${ms}ms (proves Retry-After:1s was waited)`,
	);
	await fake.close();
}

// A3 — hostile Retry-After (999s) is CAPPED at 10s (value-asserted, no real 10s wait).
{
	const fake = await startFakeDiscord((r) =>
		r.n === 1
			? { status: 429, body: {}, headers: { "retry-after": "999" } }
			: { status: 200, body: { thread_metadata: { archived: true } } },
	);
	const sleep = recordingSleep();
	const res = await archiveChatThread("tA3", "bot", {
		fetchImpl: fake.rewritingFetch,
		sleepImpl: sleep.impl,
	});
	check(
		"A3",
		"hostile Retry-After 999s capped at 10s (MAX_RETRY_AFTER_MS)",
		res.archived && sleep.calls[0] === 10_000,
		`archived=${res.archived} sleepArg=${sleep.calls[0]}ms (capped from 999000ms) [value-asserted]`,
	);
	await fake.close();
}

// A4 — persistent 5xx exhausts the retry budget (3 real attempts).
{
	const fake = await startFakeDiscord(() => ({ status: 503, body: "nope" }));
	const sleep = recordingSleep();
	const res = await archiveChatThread("tA4", "bot", {
		fetchImpl: fake.rewritingFetch,
		sleepImpl: sleep.impl,
		maxAttempts: 3,
	});
	check(
		"A4",
		"persistent 5xx → 3 real attempts then reason=exhausted",
		!res.archived &&
			res.attempts === 3 &&
			res.reason === "exhausted" &&
			res.status === 503 &&
			fake.requests.length === 3,
		`archived=${res.archived} attempts=${res.attempts} reason=${res.reason} status=${res.status} realRequests=${fake.requests.length} backoff=${JSON.stringify(sleep.calls)}`,
	);
	await fake.close();
}

// A5 — 404 → markDiscordMissing, reason=missing, no retry, never throws.
{
	const fake = await startFakeDiscord(() => ({
		status: 404,
		body: { message: "Unknown Channel" },
	}));
	const missing: string[] = [];
	let threw = false;
	let res: ArchiveChatThreadResult | undefined;
	try {
		res = await archiveChatThread("tA5gone", "bot", {
			fetchImpl: fake.rewritingFetch,
			markDiscordMissing: (id) => missing.push(id),
		});
	} catch {
		threw = true;
	}
	check(
		"A5",
		"404 → markDiscordMissing(threadId), reason=missing, 1 attempt, no throw",
		!threw &&
			res?.reason === "missing" &&
			res?.status === 404 &&
			res?.attempts === 1 &&
			missing.length === 1 &&
			missing[0] === "tA5gone",
		`threw=${threw} reason=${res?.reason} status=${res?.status} attempts=${res?.attempts} markedMissing=${JSON.stringify(missing)}`,
	);
	await fake.close();
}

// A6 — 401 unauthorized is NOT retried.
{
	const fake = await startFakeDiscord(() => ({
		status: 401,
		body: "bad token",
	}));
	const res = await archiveChatThread("tA6", "bot", {
		fetchImpl: fake.rewritingFetch,
	});
	check(
		"A6",
		"401 → reason=unauthorized, single attempt (no pointless retry)",
		!res.archived &&
			res.reason === "unauthorized" &&
			res.status === 401 &&
			fake.requests.length === 1,
		`archived=${res.archived} reason=${res.reason} status=${res.status} realRequests=${fake.requests.length}`,
	);
	await fake.close();
}

// A7 — 2xx that reports archived:false triggers a verify-retry.
{
	const fake = await startFakeDiscord((r) => ({
		status: 200,
		body: { thread_metadata: { archived: r.n >= 2 } },
	}));
	const res = await archiveChatThread("tA7", "bot", {
		fetchImpl: fake.rewritingFetch,
		sleepImpl: async () => {},
	});
	check(
		"A7",
		"post-archive verify: 200 archived:false → retry → archived:true",
		res.archived && res.attempts === 2 && res.reason === "ok",
		`archived=${res.archived} attempts=${res.attempts} reason=${res.reason} (1st body archived:false, 2nd archived:true)`,
	);
	await fake.close();
}

// A8 — 2xx with no archived flag is accepted (lenient verify / byte-compat).
{
	const fake = await startFakeDiscord(() => ({ status: 200, body: {} }));
	const res = await archiveChatThread("tA8", "bot", {
		fetchImpl: fake.rewritingFetch,
	});
	check(
		"A8",
		"lenient verify: 200 with no archived field accepted as success",
		res.archived && res.attempts === 1 && res.reason === "ok",
		`archived=${res.archived} attempts=${res.attempts} reason=${res.reason}`,
	);
	await fake.close();
}

// A9 — real network error (connection refused) retries then reason=error, no throw.
{
	const dead = await startFakeDiscord(() => ({ status: 200 }));
	const deadFetch = dead.rewritingFetch;
	await dead.close(); // now the port is closed → real ECONNREFUSED
	let threw = false;
	let res: ArchiveChatThreadResult | undefined;
	try {
		res = await archiveChatThread("tA9", "bot", {
			fetchImpl: deadFetch,
			sleepImpl: async () => {},
			maxAttempts: 2,
		});
	} catch {
		threw = true;
	}
	check(
		"A9",
		"real connection-refused → retried then reason=error, never throws",
		!threw &&
			res?.archived === false &&
			res?.reason === "error" &&
			res?.attempts === 2 &&
			!!res?.error,
		`threw=${threw} archived=${res?.archived} reason=${res?.reason} attempts=${res?.attempts} error=${res?.error}`,
	);
}

// A10 — hung response is aborted by the per-attempt timeout (real AbortController).
{
	const fake = await startFakeDiscord(() => ({
		status: 200,
		body: { thread_metadata: { archived: true } },
		delayMs: 5000, // server holds the socket open 5s
	}));
	const t0 = Date.now();
	let threw = false;
	let res: ArchiveChatThreadResult | undefined;
	try {
		res = await archiveChatThread("tA10", "bot", {
			fetchImpl: fake.rewritingFetch,
			sleepImpl: async () => {},
			maxAttempts: 1,
			timeoutMs: 700, // abort well before the 5s server delay
		});
	} catch {
		threw = true;
	}
	const ms = Date.now() - t0;
	// Prove the abort actually fired (not some other fast failure): the PATCH
	// must have reached the server (1 request), exactly 1 attempt, and elapsed
	// must sit in [timeoutMs, serverDelay) — long enough to be the timeout, far
	// short of the 5000ms the server would otherwise hold.
	check(
		"A10",
		"hung socket aborted BY the per-attempt timeout (elapsed≈700ms, server held 5000ms)",
		!threw &&
			res?.archived === false &&
			res?.reason === "error" &&
			res?.attempts === 1 &&
			fake.requests.length === 1 &&
			fake.requests[0].method === "PATCH" &&
			ms >= 650 &&
			ms < 2000,
		`threw=${threw} archived=${res?.archived} reason=${res?.reason} attempts=${res?.attempts} realRequests=${fake.requests.length} method=${fake.requests[0]?.method} realElapsed=${ms}ms (≥650ms = waited for timeout; <2000ms = did NOT wait the 5000ms server hold → AbortController fired)`,
	);
	await fake.close();
}

// A11 — removeUserFromChatThread happy path (real DELETE, no throw).
{
	const fake = await startFakeDiscord(() => ({ status: 204 }));
	let threw = false;
	try {
		await removeUserFromChatThread("tA11", "u1", "bot", {
			fetchImpl: fake.rewritingFetch,
		});
	} catch {
		threw = true;
	}
	const req = fake.requests[0];
	check(
		"A11",
		"removeUser happy → real DELETE on thread-members, no throw",
		!threw && req.method === "DELETE" && req.url.includes("/thread-members/u1"),
		`threw=${threw} method=${req?.method} url=${req?.url}`,
	);
	await fake.close();
}

// A12 — removeUser 404 (already gone) is ignored.
{
	const fake = await startFakeDiscord(() => ({ status: 404, body: "" }));
	let threw = false;
	try {
		await removeUserFromChatThread("tA12", "u1", "bot", {
			fetchImpl: fake.rewritingFetch,
		});
	} catch {
		threw = true;
	}
	check("A12", "removeUser 404 ignored, no throw", !threw, `threw=${threw}`);
	await fake.close();
}

// A13 — removeUser hung DELETE is aborted by timeout (can't block the archive).
{
	const fake = await startFakeDiscord(() => ({ status: 204, delayMs: 5000 }));
	const t0 = Date.now();
	let threw = false;
	try {
		await removeUserFromChatThread("tA13", "u1", "bot", {
			fetchImpl: fake.rewritingFetch,
			timeoutMs: 700,
		});
	} catch {
		threw = true;
	}
	const ms = Date.now() - t0;
	// Prove a real DELETE was issued and the abort fired (not a no-op fast
	// return): 1 request, method DELETE, elapsed in [timeoutMs, serverDelay).
	check(
		"A13",
		"removeUser hung DELETE aborted BY timeout (elapsed≈700ms, server held 5000ms) → cannot block archive",
		!threw &&
			fake.requests.length === 1 &&
			fake.requests[0].method === "DELETE" &&
			ms >= 650 &&
			ms < 2000,
		`threw=${threw} realRequests=${fake.requests.length} method=${fake.requests[0]?.method} realElapsed=${ms}ms (≥650ms = waited for timeout; <2000ms = did NOT wait the 5000ms server hold)`,
	);
	await fake.close();
}

process.exit(summary("LAYER A") === 0 ? 0 : 1);
