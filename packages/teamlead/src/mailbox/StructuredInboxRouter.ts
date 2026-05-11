/**
 * StructuredInboxRouter — vendor-neutral fs.watch monitor for the
 * structured-inbox request directory.
 *
 * Per plan v1.27.1 §B-1 + §2.6 (Codex r2 critical #2):
 *
 * - Watches `<FLYWHEEL_STATE_DIR>/inbox-structured/<leadName>/requests/` for
 *   new structured request files (`{ts}-{request_id}.json`).
 * - On each new file: read, parse, hand to caller-supplied `onRequest`
 *   callback, then atomic-move to `requests-processed/<basename>` for audit.
 * - **Vendor-neutral**: lives entirely outside any vendor inbox path —
 *   stock claude-code's `useInboxPoller` does NOT read this directory, so
 *   no race with vendor pollers (resolves Codex r2 critical #2 race where
 *   stock poller would consume + mark-read structured messages before
 *   InboundRouter saw them).
 *
 * **PR 1.3 scope (no-behavior-flip)**: this class exists but no Bridge
 * code instantiates it yet. PR 2.x (Batch 2) will wire it into Bridge
 * `gate-poller` to source pending gate requests (replacing CommDB query)
 * once `await-mcp` is shipping structured requests to this dir.
 */

import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

/**
 * Vendor-neutral structured request envelope (matches what `await-mcp`
 * writes per plan §C-1 / §2.6). All fields opaque to the router — only
 * `request_id` is required for dedupe + matching with response files.
 */
export interface StructuredRequest {
	request_id: string;
	checkpoint?: string;
	from?: string;
	to?: string;
	content?: string;
	created_at?: number;
	[key: string]: unknown;
}

export interface StructuredInboxRouterOptions {
	/** Lead name — used to derive watch path `<state>/inbox-structured/<lead>/requests/`. */
	leadName: string;
	/** State dir base (typically `transport.getStateDir()`). */
	stateDir: string;
	/**
	 * Callback fired for each new structured request file. If the callback
	 * throws, the file is NOT moved to processed (so a retry on next
	 * watcher event can re-deliver). For idempotency, the callback should
	 * dedupe by `request.request_id`.
	 */
	onRequest: (request: StructuredRequest) => Promise<void> | void;
	/** Optional logger (default = console). */
	logger?: {
		info: (msg: string, ctx?: Record<string, unknown>) => void;
		warn: (msg: string, ctx?: Record<string, unknown>) => void;
		error: (msg: string, ctx?: Record<string, unknown>) => void;
	};
}

const noopLogger: NonNullable<StructuredInboxRouterOptions["logger"]> = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

export class StructuredInboxRouter {
	private watcher: FSWatcher | null = null;
	private readonly requestsDir: string;
	private readonly processedDir: string;
	private readonly logger: NonNullable<StructuredInboxRouterOptions["logger"]>;
	/** Dedupe set — basenames already delivered, prevents double-fire on chokidar replay. */
	private readonly delivered = new Set<string>();
	/**
	 * Cached startup promise. Per Codex r2 PR 1.3 MEDIUM #2: concurrent
	 * `start()` callers must all await the same chokidar `ready` boundary,
	 * not just the first caller. Without this, second caller's `await
	 * router.start()` returns immediately on the idempotent-watcher check
	 * before the first call's `ready` event has fired → second caller can
	 * write a request immediately and hit the same pre-ready window the
	 * fix is trying to close.
	 */
	private startPromise: Promise<void> | null = null;

	constructor(private readonly options: StructuredInboxRouterOptions) {
		this.requestsDir = join(
			options.stateDir,
			"inbox-structured",
			options.leadName,
			"requests",
		);
		this.processedDir = join(
			options.stateDir,
			"inbox-structured",
			options.leadName,
			"requests-processed",
		);
		this.logger = options.logger ?? noopLogger;
	}

	/**
	 * Begin watching. Idempotent — calling start() multiple times is a
	 * no-op after the first.
	 *
	 * Codex r1 → r2 PR 1.3 HIGH #2 + MEDIUM #2:
	 * - AWAITS chokidar's `ready` event before resolving so files written
	 *   immediately after `await start()` are guaranteed to be picked up.
	 * - Caches the startup promise so concurrent `start()` callers all wait
	 *   for the SAME `ready` boundary (not just the first caller — the
	 *   second caller's idempotent return would otherwise race the ready).
	 */
	async start(): Promise<void> {
		// Cached promise: every concurrent caller awaits the same boundary.
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.doStart();
		try {
			await this.startPromise;
		} catch (err) {
			// On failure, clear cache so next call retries cleanly.
			this.startPromise = null;
			throw err;
		}
	}

	private async doStart(): Promise<void> {
		// Ensure both directories exist before chokidar attaches (chokidar
		// silently fails to detect adds if the watched dir doesn't exist
		// at start time — only later on dir create).
		await mkdir(this.requestsDir, { recursive: true });
		await mkdir(this.processedDir, { recursive: true });

		const watcher = chokidar.watch(this.requestsDir, {
			ignoreInitial: false, // pick up files that already exist
			depth: 0, // don't recurse
			awaitWriteFinish: {
				// Wait 100ms after the last write before delivering, so we don't
				// read partial atomic-write artifacts (the writer should use
				// temp+rename, but defense in depth).
				stabilityThreshold: 100,
				pollInterval: 50,
			},
			// Use polling instead of native fsevents to avoid EMFILE under
			// suite-wide load (Codex r2 sandbox saw "too many open files,
			// watch") + reduce flake on macOS where fsevents can drop events
			// under contention. 200ms interval matches our awaitWriteFinish
			// stability for predictable latency.
			usePolling: true,
			interval: 200,
			binaryInterval: 200,
		});

		watcher.on("add", (path) => {
			this.handleFile(path).catch((err) => {
				this.logger.error("[StructuredInboxRouter] handleFile failed", {
					path,
					error: (err as Error).message,
				});
			});
		});

		watcher.on("error", (err) => {
			this.logger.error("[StructuredInboxRouter] watcher error", {
				error: (err as Error).message,
			});
		});

		// Wait for chokidar to complete initial scan + be ready for new events.
		// Per Codex r2 MEDIUM #2: assign `this.watcher` AFTER ready resolves,
		// so a concurrent `start()` caller can't see the watcher field set
		// while the initial scan is still in progress.
		await new Promise<void>((resolve) => {
			watcher.once("ready", () => resolve());
		});
		this.watcher = watcher;

		this.logger.info("[StructuredInboxRouter] started", {
			leadName: this.options.leadName,
			requestsDir: this.requestsDir,
		});
	}

	/**
	 * Stop watching and clean up. Idempotent.
	 */
	async stop(): Promise<void> {
		if (!this.watcher) {
			// Even with no watcher, clear startPromise in case stop() is
			// called between start() initiation and ready (e.g. test cleanup
			// in beforeEach failure path).
			this.startPromise = null;
			return;
		}
		await this.watcher.close();
		this.watcher = null;
		this.startPromise = null;
		this.delivered.clear();
		this.inFlight.clear();
		this.logger.info("[StructuredInboxRouter] stopped", {
			leadName: this.options.leadName,
		});
	}

	/**
	 * Health probe — used by Bridge LeadWatchdog to surface watcher state.
	 */
	async health(): Promise<{
		ok: boolean;
		watching: boolean;
		deliveredCount: number;
	}> {
		const watching = this.watcher !== null;
		// Verify requests dir is still readable.
		let ok = watching;
		try {
			await stat(this.requestsDir);
		} catch {
			ok = false;
		}
		return { ok, watching, deliveredCount: this.delivered.size };
	}

	/**
	 * Get watch path (for tests / introspection).
	 */
	getRequestsDir(): string {
		return this.requestsDir;
	}

	getProcessedDir(): string {
		return this.processedDir;
	}

	/**
	 * In-flight set: basenames currently being processed (between the first
	 * `add` event and either successful delivery or thrown callback). Codex
	 * r1 PR 1.3 MEDIUM #3: distinct from `delivered` so that concurrent
	 * duplicate `add` events don't both pass the dedupe check + both invoke
	 * `onRequest`.
	 *
	 * Invariant: a basename is in EITHER `inFlight` OR `delivered`, never
	 * both. After successful delivery + move, basename moves from inFlight
	 * → delivered. After callback throw, basename is removed from inFlight
	 * (file left in place for retry on next watcher restart).
	 */
	private readonly inFlight = new Set<string>();

	private async handleFile(filePath: string): Promise<void> {
		// Only process .json files; skip swap files / other noise.
		if (!filePath.endsWith(".json")) return;

		const basename = filePath.split("/").pop() ?? "";

		// Dedupe — chokidar can fire `add` multiple times for the same file
		// in some edge cases (e.g. rename across devices). The in-flight check
		// covers concurrent duplicate events; the delivered check covers
		// post-completion re-fires (Codex r1 PR 1.3 MEDIUM #3).
		if (this.inFlight.has(basename) || this.delivered.has(basename)) {
			this.logger.warn(
				"[StructuredInboxRouter] duplicate add event, skipping",
				{
					basename,
					state: this.inFlight.has(basename) ? "in-flight" : "delivered",
				},
			);
			return;
		}
		// Mark in-flight BEFORE the first await — synchronous reservation
		// closes the race where two add events both pass the check above.
		this.inFlight.add(basename);

		try {
			let parsed: StructuredRequest;
			try {
				const content = await readFile(filePath, "utf-8");
				parsed = JSON.parse(content) as StructuredRequest;
			} catch (err) {
				this.logger.error(
					"[StructuredInboxRouter] failed to read/parse request",
					{
						filePath,
						error: (err as Error).message,
					},
				);
				// Move corrupt file to processed/ with .corrupt suffix so it doesn't
				// get retried on next watcher restart, but we keep the artifact.
				// Promote to delivered set so chokidar replay events for the same
				// basename don't re-process the (already-moved) file.
				this.delivered.add(basename);
				await this.moveProcessedSafe(filePath, `${basename}.corrupt`);
				return;
			}

			if (!parsed.request_id) {
				this.logger.error(
					"[StructuredInboxRouter] request missing request_id, dropping",
					{ filePath },
				);
				this.delivered.add(basename);
				await this.moveProcessedSafe(filePath, `${basename}.invalid`);
				return;
			}

			// Hand to caller. If callback throws, do NOT move file — leave it for
			// retry on next watcher restart (StructuredInboxRouter recovery is
			// caller responsibility per plan §B-1).
			try {
				await this.options.onRequest(parsed);
			} catch (err) {
				this.logger.error(
					"[StructuredInboxRouter] onRequest callback threw, leaving file in place",
					{
						filePath,
						request_id: parsed.request_id,
						error: (err as Error).message,
					},
				);
				// IMPORTANT: do NOT promote to `delivered` — file is still in
				// requests/, must be re-tried on next watcher restart. The
				// in-flight removal in finally{} is the only state cleanup.
				return;
			}

			// Mark delivered + atomic move to processed/ for audit.
			this.delivered.add(basename);
			await this.moveProcessedSafe(filePath, basename);
		} finally {
			// Always release the in-flight reservation. If we reached here
			// successfully OR via any error path, the basename's status is
			// now reflected in `delivered` (success/.corrupt/.invalid) OR
			// requires retry (callback throw, file still in requests/).
			// Either way, future `add` events for the same basename should
			// re-evaluate via the (delivered + inFlight) check.
			this.inFlight.delete(basename);
		}
	}

	private async moveProcessedSafe(
		filePath: string,
		targetName: string,
	): Promise<void> {
		const target = join(this.processedDir, targetName);
		try {
			// Ensure target dir exists (in case caller didn't pre-create or it
			// was deleted mid-flight).
			await mkdir(dirname(target), { recursive: true });
			await rename(filePath, target);
		} catch (err) {
			this.logger.warn(
				"[StructuredInboxRouter] move-to-processed failed (non-fatal)",
				{
					filePath,
					target,
					error: (err as Error).message,
				},
			);
		}
	}
}
