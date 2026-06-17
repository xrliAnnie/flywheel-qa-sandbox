/**
 * FLY-294 QA — Layer C: reverse control against the BASE (pre-#277)
 * archiveChatThread. Runs the SAME fake-Discord scenarios that #277 passes in
 * Layer A and proves the base code REGRESSES — i.e. the reliability properties
 * #277 adds genuinely did not exist before, so #277's tests are a real gate.
 *
 * The base function calls the global `fetch` directly (no fetchImpl seam), so
 * we monkeypatch `globalThis.fetch` with the same origin-rewriting real fetch.
 * A PASS here means "base exhibits the OLD broken behavior that #277 fixes".
 */
import { archiveChatThread as archiveBase } from "./chat-thread-utils.base.mts";
import { check, startFakeDiscord, summary } from "./fake-discord.mts";

const realFetch = globalThis.fetch;
function patchFetch(f: typeof fetch) {
	globalThis.fetch = f;
}
function restoreFetch() {
	globalThis.fetch = realFetch;
}

console.log(
	"######## FLY-294 LAYER C — reverse control: BASE (pre-#277) regresses ########\n",
);
console.log(
	"(In Layer A, #277 PASSED all of these. Here base must FAIL them — proving the gate.)\n",
);

// C1 — 429: base does a single fire-and-forget PATCH, NO retry → not archived.
{
	const fake = await startFakeDiscord((r) =>
		r.n === 1
			? {
					status: 429,
					body: { message: "rate" },
					headers: { "retry-after": "0" },
				}
			: { status: 200, body: { thread_metadata: { archived: true } } },
	);
	patchFetch(fake.rewritingFetch);
	const ret = await archiveBase("tC1", "bot");
	restoreFetch();
	check(
		"C1",
		"BASE on 429: NO retry — gives up after 1 request (#277 retries→archives)",
		fake.requests.length === 1 && ret === undefined,
		`baseRequests=${fake.requests.length} (no 2nd attempt) baseReturn=${JSON.stringify(ret)} — #277 made 2 attempts & archived (Layer A2)`,
	);
	await fake.close();
}

// C2 — 5xx: base single request, no retry budget.
{
	const fake = await startFakeDiscord(() => ({ status: 503, body: "nope" }));
	patchFetch(fake.rewritingFetch);
	await archiveBase("tC2", "bot");
	restoreFetch();
	check(
		"C2",
		"BASE on 5xx: NO retry — 1 request only (#277 made 3, Layer A4)",
		fake.requests.length === 1,
		`baseRequests=${fake.requests.length} vs #277 realRequests=3`,
	);
	await fake.close();
}

// C3 — 404: base has NO markDiscordMissing (GEO-200) and no structured result.
{
	const fake = await startFakeDiscord(() => ({
		status: 404,
		body: { message: "Unknown Channel" },
	}));
	patchFetch(fake.rewritingFetch);
	const ret = await archiveBase("tC3gone", "bot");
	restoreFetch();
	check(
		"C3",
		"BASE on 404: NO markDiscordMissing, NO structured result (#277 → reason=missing + marks, Layer A5)",
		ret === undefined,
		`baseReturn=${JSON.stringify(ret)} (void — cannot mark thread missing, cannot audit) — #277 returned {reason:"missing"} and called markDiscordMissing`,
	);
	await fake.close();
}

// C4 — slow response: base has NO per-attempt timeout → it WAITS the full delay.
{
	const SERVER_DELAY = 3000;
	const fake = await startFakeDiscord(() => ({
		status: 200,
		body: { thread_metadata: { archived: true } },
		delayMs: SERVER_DELAY,
	}));
	patchFetch(fake.rewritingFetch);
	const t0 = Date.now();
	await archiveBase("tC4", "bot");
	const ms = Date.now() - t0;
	restoreFetch();
	check(
		"C4",
		"BASE on hung socket: NO timeout — blocks the full server delay (#277 aborts at 700ms, Layer A10)",
		ms >= 2800,
		`baseElapsed=${ms}ms (waited the full ${SERVER_DELAY}ms server hold; a real hang would block teardown indefinitely) vs #277 aborted at ~700ms`,
	);
	await fake.close();
}

// C5 — base returns void: no structured outcome → archive cannot be audited.
{
	const fake = await startFakeDiscord(() => ({
		status: 200,
		body: { thread_metadata: { archived: true } },
	}));
	patchFetch(fake.rewritingFetch);
	const ret = await archiveBase("tC5", "bot");
	restoreFetch();
	check(
		"C5",
		"BASE returns void: no ArchiveChatThreadResult → post-ship can't emit a real audit event",
		ret === undefined,
		`baseReturn=${JSON.stringify(ret)} (Promise<void>) — #277 returns {archived,attempts,status,reason} that post-ship-finalization audits`,
	);
	await fake.close();
}

process.exit(summary("LAYER C") === 0 ? 0 : 1);
