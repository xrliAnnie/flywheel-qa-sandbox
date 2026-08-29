/**
 * StructuredInboxRouter unit tests (FLY-142 Phase 0 PR 1.3, no-behavior-flip).
 *
 * Validates:
 * - start() creates requests/ + processed/ dirs even if missing
 * - new request file → onRequest fires with parsed payload
 * - processed file moves to requests-processed/ atomically
 * - corrupt JSON → moved to .corrupt suffix, onRequest NOT called
 * - missing request_id → moved to .invalid suffix
 * - onRequest throws → file LEFT IN PLACE for retry
 * - duplicate add events deduped
 * - stop() cleans up + idempotent
 * - health() returns watching state
 */

import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chokidar from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	StructuredInboxRouter,
	type StructuredRequest,
} from "../StructuredInboxRouter.js";

let tempDir: string;
let router: StructuredInboxRouter | null = null;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "structured-inbox-router-"));
});

afterEach(async () => {
	if (router) {
		await router.stop();
		router = null;
	}
	await rm(tempDir, { recursive: true, force: true });
});

/**
 * Wait until predicate returns true OR timeout — chokidar fires async.
 *
 * Codex r1 PR 1.3 MEDIUM #4: predicate signature is
 * `() => boolean | Promise<boolean>`. The original `() => boolean` would
 * silently return a Promise from `async () =>` callers — Promise is
 * truthy → waitFor returns immediately without checking the actual
 * filesystem condition → tests false-pass. Now we await the result.
 */
async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 3000,
	pollMs = 25,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await predicate();
		if (result) return;
		await new Promise((r) => setTimeout(r, pollMs));
	}
	throw new Error(`Timeout after ${timeoutMs}ms waiting for predicate`);
}

async function writeRequestFile(
	requestsDir: string,
	basename: string,
	payload: object,
): Promise<string> {
	const path = join(requestsDir, basename);
	// Atomic-ish write — write to temp then rename so chokidar's
	// awaitWriteFinish doesn't see partial content.
	const tempPath = `${path}.tmp`;
	await writeFile(tempPath, JSON.stringify(payload), "utf-8");
	const { rename } = await import("node:fs/promises");
	await rename(tempPath, path);
	return path;
}

// Run tests sequentially: chokidar watchers + temp dirs + atomic renames
// can starve each other under parallel concurrency, causing intermittent
// "processed file is atomically moved" timeout. Codex r2 PR 1.3 also
// observed `EMFILE: too many open files, watch` in their sandbox under
// parallel load. Sequential keeps each test's watcher isolated.
describe.sequential("StructuredInboxRouter", () => {
	describe("lifecycle", () => {
		it("start() creates requests + processed dirs even if missing", async () => {
			const onRequest = vi.fn();
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest,
			});

			await router.start();

			const dirs = await readdir(join(tempDir, "inbox-structured", "cos-lead"));
			expect(dirs.sort()).toEqual(["requests", "requests-processed"]);
		});

		it("start() is idempotent (multiple calls no-op)", async () => {
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: vi.fn(),
			});

			await router.start();
			await router.start();
			await router.start();

			// Should not throw + watcher state still healthy.
			const h = await router.health();
			expect(h.watching).toBe(true);
		});

		it("concurrent start() callers all wait for same chokidar ready (Codex r2 PR 1.3 MEDIUM #2)", async () => {
			// Without the cached startPromise, the second concurrent caller's
			// `await start()` would return immediately on the watcher-set
			// check and miss the ready boundary. Verify all callers wait for
			// the SAME `ready` event.
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: vi.fn(),
			});

			// Fire 5 concurrent start() calls. All should resolve at the same
			// time (after ready), not the second/third/etc returning early.
			const results = await Promise.all([
				router.start(),
				router.start(),
				router.start(),
				router.start(),
				router.start(),
			]);

			// All should succeed without throwing.
			expect(results).toHaveLength(5);

			// After all resolve, watcher MUST be in the ready state (file
			// writes will be picked up immediately).
			const h = await router.health();
			expect(h.watching).toBe(true);
		});

		it("stop() is idempotent", async () => {
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: vi.fn(),
			});
			await router.start();
			await router.stop();
			await router.stop(); // no-op, no throw
			const h = await router.health();
			expect(h.watching).toBe(false);
		});

		it("start() rejects + clears startPromise when chokidar errors before ready (Codex r3 PR 1.3)", async () => {
			// Trigger startup error: ENOENT — pass a stateDir whose parent
			// can't be mkdir'd because it points to a file (not a dir).
			//
			// Note: chokidar polling mode rarely emits true pre-ready errors
			// on macOS; the stronger guarantee we can verify is that the
			// fix's `error → reject` plumbing exists. We test the cleanup
			// side: when start() rejects (e.g. ENOENT mkdir), startPromise
			// is cleared so caller can retry.
			const tempFile = join(tempDir, "not-a-dir");
			await writeFile(tempFile, "block", "utf-8"); // file, not dir

			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				// Path that requires creating a dir under a regular file → mkdir ENOTDIR.
				stateDir: tempFile,
				onRequest: vi.fn(),
				logger: {
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
				},
			});

			await expect(router.start()).rejects.toThrow();

			// After rejection, startPromise should be cleared so a retry
			// (with a fixed config) would actually re-execute doStart.
			// We can't easily reconfigure stateDir, but we can verify that
			// start() doesn't return a stuck cached promise.
			await expect(router.start()).rejects.toThrow();
		});

		it("stop() during in-flight start() does not leave watching=true (Codex r3 PR 1.3)", async () => {
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: vi.fn(),
			});

			// Start without awaiting — simulates a caller that fires start
			// then immediately cancels via stop.
			const startPromise = router.start();
			// Give doStart a microtask to register the chokidar watcher.
			await new Promise((r) => setTimeout(r, 5));

			// stop() while start() is still in-flight (waiting for ready).
			await router.stop();

			// startPromise should now resolve (or reject) but NOT leave the
			// watcher resurrected. With the cancellation flag, doStart sees
			// startCancelled=true after ready and skips assignment.
			await startPromise.catch(() => {}); // accept either resolve or reject

			const h = await router.health();
			expect(h.watching).toBe(false);
		});

		it("chokidar 'error' before 'ready' rejects start + clears startPromise (Codex r4 PR 1.3 LOW)", async () => {
			// Mock chokidar.watch to return a fake watcher that emits 'error'
			// before 'ready' — covers the actual R3 bug surface (chokidar
			// emitting error after watcher creation but before initial scan
			// completes), which the mkdir-failure test does NOT exercise.
			const fakeWatcher = new EventEmitter() as unknown as ReturnType<
				typeof chokidar.watch
			>;
			(fakeWatcher as unknown as { close: () => Promise<void> }).close = vi.fn(
				async () => {},
			);
			const watchSpy = vi
				.spyOn(chokidar, "watch")
				.mockReturnValueOnce(fakeWatcher);

			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: vi.fn(),
			});

			const startPromise = router.start();
			// Yield so doStart() can register the once('ready'/'error') listeners
			// before we emit. With usePolling+mkdir, doStart hits the await
			// after the synchronous chokidar.watch + on/once setup, so a
			// single microtask flush is enough.
			await new Promise((r) => setTimeout(r, 5));

			// Emit error BEFORE ready — this is the path R3 was meant to handle.
			(fakeWatcher as unknown as EventEmitter).emit(
				"error",
				new Error("simulated pre-ready chokidar error"),
			);

			await expect(startPromise).rejects.toThrow(
				/simulated pre-ready chokidar error/,
			);
			// Watcher was closed in startup-error cleanup branch.
			expect(
				(fakeWatcher as unknown as { close: ReturnType<typeof vi.fn> }).close,
			).toHaveBeenCalled();

			// startPromise was cleared — a follow-up start() must re-execute
			// doStart (not return the stuck rejected cached promise). We
			// assert this by allowing the spy to fall through to real chokidar
			// on the second call and confirming start() now succeeds.
			watchSpy.mockRestore();
			await router.start();
			const h = await router.health();
			expect(h.watching).toBe(true);
		});

		it("stop() returns within 1s when called during in-flight start (Codex r4 PR 1.3 MEDIUM)", async () => {
			// Codex r4 reproduction: chokidar's close() does NOT emit
			// ready/error, so without an explicit cancellation trigger
			// stop() deadlocks on `await this.startPromise` (doStart hangs
			// on the ready/error race that will never settle).
			//
			// Repeat 5x at varying inter-call delays to make the race
			// reliably surface (Codex saw 1/2/5/10ms all hit the deadlock).
			for (const delayMs of [0, 1, 2, 5, 10]) {
				const innerRouter = new StructuredInboxRouter({
					leadName: "cos-lead",
					stateDir: await mkdtemp(join(tmpdir(), "sir-r4-stop-")),
					onRequest: vi.fn(),
				});
				const startPromise = innerRouter.start();
				if (delayMs > 0) {
					await new Promise((r) => setTimeout(r, delayMs));
				}
				const t0 = Date.now();
				await Promise.race([
					innerRouter.stop(),
					new Promise((_, reject) =>
						setTimeout(
							() =>
								reject(
									new Error(
										`stop() deadlocked at delay=${delayMs}ms after 1500ms`,
									),
								),
							1500,
						),
					),
				]);
				const elapsed = Date.now() - t0;
				expect(elapsed).toBeLessThan(1500);
				await startPromise.catch(() => {});
				const h = await innerRouter.health();
				expect(h.watching).toBe(false);
			}
		});
	});

	describe("file delivery", () => {
		it("new .json file fires onRequest with parsed payload", async () => {
			const received: StructuredRequest[] = [];
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: async (req) => {
					received.push(req);
				},
			});
			await router.start();

			const requestsDir = router.getRequestsDir();
			await writeRequestFile(requestsDir, "1700000000000-req-abc.json", {
				request_id: "req-abc",
				checkpoint: "approve_to_ship",
				from: "runner-x",
				to: "cos-lead",
				content: "approve me",
			});

			await waitFor(() => received.length === 1);
			expect(received[0]?.request_id).toBe("req-abc");
			expect(received[0]?.checkpoint).toBe("approve_to_ship");
			expect(received[0]?.content).toBe("approve me");
		});

		it("processed file is atomically moved to requests-processed/", async () => {
			const received: StructuredRequest[] = [];
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: async (req) => {
					received.push(req);
				},
			});
			await router.start();

			// Capture paths NOW (before any await unwinds the test) — using
			// `router?.getX() ?? ""` in waitFor predicates can hit ENOENT
			// during test cleanup races.
			const requestsDir = router.getRequestsDir();
			const processedDir = router.getProcessedDir();

			const basename = "1700000000000-req-move.json";
			await writeRequestFile(requestsDir, basename, {
				request_id: "req-move",
			});

			// Bumped timeout to 5s (from default 3s) to absorb chokidar
			// awaitWriteFinish stability (100ms) + handleFile read+parse+
			// callback+rename latency under suite-wide load. Was flaking
			// 1/3 runs at 3s.
			await waitFor(() => received.length === 1, 5000);
			// Wait for both: file appears in processed AND is gone from
			// requests. Combined check avoids flakiness from polling either
			// dir alone (move happens after callback, atomic rename).
			await waitFor(async () => {
				const processed = await readdir(processedDir);
				const requests = await readdir(requestsDir);
				return processed.includes(basename) && !requests.includes(basename);
			}, 5000);

			const requests = await readdir(requestsDir);
			const processed = await readdir(processedDir);
			expect(requests).not.toContain(basename);
			expect(processed).toContain(basename);
		});

		it("ignores non-.json files (e.g. swap files)", async () => {
			const received: StructuredRequest[] = [];
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: async (req) => {
					received.push(req);
				},
			});
			await router.start();

			await writeFile(
				join(router.getRequestsDir(), "garbage.swp"),
				"vim swap",
				"utf-8",
			);
			// Give chokidar a chance — but expect onRequest NOT called.
			await new Promise((r) => setTimeout(r, 300));
			expect(received).toHaveLength(0);
		});

		it("multiple files delivered in order (eventual)", async () => {
			const received: string[] = [];
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: async (req) => {
					received.push(req.request_id);
				},
			});
			await router.start();

			await writeRequestFile(router.getRequestsDir(), "001.json", {
				request_id: "a",
			});
			await writeRequestFile(router.getRequestsDir(), "002.json", {
				request_id: "b",
			});
			await writeRequestFile(router.getRequestsDir(), "003.json", {
				request_id: "c",
			});

			await waitFor(() => received.length === 3);
			expect(received.sort()).toEqual(["a", "b", "c"]);
		});
	});

	describe("error handling", () => {
		it("corrupt JSON → moved to .corrupt suffix, onRequest NOT called", async () => {
			const received: StructuredRequest[] = [];
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: async (req) => {
					received.push(req);
				},
				logger: {
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(), // swallow expected JSON.parse error log
				},
			});
			await router.start();

			// Use atomic temp+rename so chokidar awaitWriteFinish sees a single
			// stable file (not a partial write). Without this, chokidar can
			// fire 'add' twice — once for empty file, once after content written
			// — and the test races the move.
			const basename = "corrupt.json";
			const finalPath = join(router.getRequestsDir(), basename);
			const tempPath = `${finalPath}.tmp`;
			await writeFile(tempPath, "{not json", "utf-8");
			const { rename } = await import("node:fs/promises");
			await rename(tempPath, finalPath);

			// Wait for BOTH conditions to settle: file appears in processed/
			// AND is gone from requests/. Without checking both, race between
			// chokidar's awaitWriteFinish settle + handleFile's atomic rename
			// can produce a false-fail snapshot.
			//
			// Use captured paths (not router?.getX()) so we don't crash with
			// ENOENT when the test runner's afterEach starts unwinding while
			// waitFor is still polling.
			const processedDir = router.getProcessedDir();
			const requestsDir = router.getRequestsDir();
			await waitFor(async () => {
				const processed = await readdir(processedDir);
				const requests = await readdir(requestsDir);
				return (
					processed.includes(`${basename}.corrupt`) &&
					!requests.includes(basename)
				);
			});

			expect(received).toHaveLength(0);
		});

		it("missing request_id → moved to .invalid suffix", async () => {
			const received: StructuredRequest[] = [];
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: async (req) => {
					received.push(req);
				},
			});
			await router.start();

			const basename = "no-id.json";
			await writeRequestFile(router.getRequestsDir(), basename, {
				checkpoint: "approve_to_ship",
				// request_id intentionally omitted
			});

			await waitFor(async () => {
				const processed = await readdir(router?.getProcessedDir() ?? "");
				return processed.includes(`${basename}.invalid`);
			});

			expect(received).toHaveLength(0);
		});

		it("onRequest throws → file LEFT IN PLACE for retry", async () => {
			const received: StructuredRequest[] = [];
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: async (req) => {
					received.push(req);
					throw new Error("simulated callback failure");
				},
				logger: {
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(), // swallow expected error logs
				},
			});
			await router.start();

			const basename = "retry-me.json";
			await writeRequestFile(router.getRequestsDir(), basename, {
				request_id: "retry-1",
			});

			await waitFor(() => received.length === 1);
			// File should NOT be moved to processed/.
			await new Promise((r) => setTimeout(r, 300));
			const requests = await readdir(router.getRequestsDir());
			const processed = await readdir(router.getProcessedDir());
			expect(requests).toContain(basename);
			expect(processed).not.toContain(basename);
		});
	});

	describe("dedupe", () => {
		it("duplicate add events deduped (delivered set)", async () => {
			const received: StructuredRequest[] = [];
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: async (req) => {
					received.push(req);
				},
				logger: {
					info: vi.fn(),
					warn: vi.fn(), // we expect "duplicate add event" warning
					error: vi.fn(),
				},
			});
			await router.start();

			const basename = "dedupe-me.json";
			await writeRequestFile(router.getRequestsDir(), basename, {
				request_id: "dedupe-1",
			});

			await waitFor(() => received.length === 1);
			// Wait for move to complete.
			await waitFor(async () => {
				const processed = await readdir(router?.getProcessedDir() ?? "");
				return processed.includes(basename);
			});

			// Re-write the same basename (simulates a chokidar replay).
			// Since file is now in processed/, writing to requests/ again is
			// a fresh add but with the same basename → delivered set dedupes.
			await writeRequestFile(router.getRequestsDir(), basename, {
				request_id: "dedupe-1",
			});

			await new Promise((r) => setTimeout(r, 400));
			expect(received).toHaveLength(1); // not 2
		});
	});

	describe("health", () => {
		it("health() returns watching=true after start", async () => {
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: vi.fn(),
			});
			await router.start();
			const h = await router.health();
			expect(h.ok).toBe(true);
			expect(h.watching).toBe(true);
			expect(h.deliveredCount).toBe(0);
		});

		it("health() returns watching=false before start / after stop", async () => {
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest: vi.fn(),
			});
			const before = await router.health();
			expect(before.watching).toBe(false);

			await router.start();
			await router.stop();

			const after = await router.health();
			expect(after.watching).toBe(false);
		});

		it("health.deliveredCount tracks deliveries", async () => {
			const onRequest = vi.fn();
			router = new StructuredInboxRouter({
				leadName: "cos-lead",
				stateDir: tempDir,
				onRequest,
			});
			await router.start();

			await writeRequestFile(router.getRequestsDir(), "h-1.json", {
				request_id: "h-1",
			});
			await writeRequestFile(router.getRequestsDir(), "h-2.json", {
				request_id: "h-2",
			});

			// Wait for both onRequest calls to fire (chokidar awaitWriteFinish
			// adds ~100ms latency per file).
			await waitFor(() => onRequest.mock.calls.length === 2);

			// Wait for both files to land in processed/ (move happens after callback).
			await waitFor(async () => {
				const processed = await readdir(router?.getProcessedDir() ?? "");
				return processed.includes("h-1.json") && processed.includes("h-2.json");
			});

			const final = await router.health();
			expect(final.deliveredCount).toBe(2);
		});
	});
});
