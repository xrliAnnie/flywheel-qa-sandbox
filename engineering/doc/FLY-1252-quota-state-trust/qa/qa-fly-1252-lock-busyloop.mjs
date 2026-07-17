// FLY-1252 QA — regression probe for advisory ③ (lock busy-loop).
//
// withMkdirLock must be BOUNDED even when the lock's PARENT directory is
// missing: it must time out / fail-loud / back off, never spin. Pre-FLY-1252
// the acquire loop did `if (code !== "EEXIST") throw err;` (bounded fail-loud);
// FLY-1252 changed the missing-parent (ENOENT) case to `continue` WITHOUT the
// deadline check or the retry backoff (both live only in the EEXIST branch), so
// a persistently-missing parent spins synchronously at ~100% CPU forever and
// wedges the event loop.
//
// This probe calls withMkdirLock against a lockPath under a non-existent parent
// with a short timeoutMs. Correct = settles (throws) within the deadline; the
// parent watchdog (qa-fly-1252-lock-busyloop.sh) kills it if it does not.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.argv[2];
if (!dist) {
	console.error(
		"usage: node qa-fly-1252-lock-busyloop.mjs <teamlead-dist-dir>",
	);
	process.exit(2);
}
const { withMkdirLock } = await import(
	pathToFileURL(join(dist, "account-heal/mkdir-lock.js")).href
);

const base = mkdtempSync(join(tmpdir(), "fly1252-lock-busyloop-"));
const missingParentLock = join(base, "does-not-exist", "sub", "accounts.lock");

const start = Date.now();
let settled;
try {
	await withMkdirLock(missingParentLock, async () => "ok", {
		timeoutMs: 500,
		retryMs: 20,
	});
	settled = "RESOLVED";
} catch (e) {
	settled = `THREW:${e?.message ? e.message.slice(0, 100) : String(e)}`;
}
const ms = Date.now() - start;
// Reaching this line at all means the loop is BOUNDED. A busy-loop never prints
// (the synchronous spin blocks the event loop; the watchdog kills the process).
console.log(`SETTLED=${settled} elapsedMs=${ms}`);
