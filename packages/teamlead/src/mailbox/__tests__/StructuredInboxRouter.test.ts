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

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Wait until predicate returns true OR timeout — chokidar fires async. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 3000,
	pollMs = 25,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
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

describe("StructuredInboxRouter", () => {
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

			const basename = "1700000000000-req-move.json";
			await writeRequestFile(router.getRequestsDir(), basename, {
				request_id: "req-move",
			});

			await waitFor(() => received.length === 1);
			// Wait briefly for the move to complete (post-callback).
			await waitFor(async () => {
				const processed = await readdir(router?.getProcessedDir() ?? "");
				return processed.includes(basename);
			});

			const requests = await readdir(router.getRequestsDir());
			const processed = await readdir(router.getProcessedDir());
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
