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
	 */
	async start(): Promise<void> {
		if (this.watcher) return;

		// Ensure both directories exist before chokidar attaches (chokidar
		// silently fails to detect adds if the watched dir doesn't exist
		// at start time — only later on dir create).
		await mkdir(this.requestsDir, { recursive: true });
		await mkdir(this.processedDir, { recursive: true });

		this.watcher = chokidar.watch(this.requestsDir, {
			ignoreInitial: false, // pick up files that already exist
			depth: 0, // don't recurse
			awaitWriteFinish: {
				// Wait 100ms after the last write before delivering, so we don't
				// read partial atomic-write artifacts (the writer should use
				// temp+rename, but defense in depth).
				stabilityThreshold: 100,
				pollInterval: 50,
			},
		});

		this.watcher.on("add", (path) => {
			this.handleFile(path).catch((err) => {
				this.logger.error("[StructuredInboxRouter] handleFile failed", {
					path,
					error: (err as Error).message,
				});
			});
		});

		this.watcher.on("error", (err) => {
			this.logger.error("[StructuredInboxRouter] watcher error", {
				error: (err as Error).message,
			});
		});

		this.logger.info("[StructuredInboxRouter] started", {
			leadName: this.options.leadName,
			requestsDir: this.requestsDir,
		});
	}

	/**
	 * Stop watching and clean up. Idempotent.
	 */
	async stop(): Promise<void> {
		if (!this.watcher) return;
		await this.watcher.close();
		this.watcher = null;
		this.delivered.clear();
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

	private async handleFile(filePath: string): Promise<void> {
		// Only process .json files; skip swap files / other noise.
		if (!filePath.endsWith(".json")) return;

		const basename = filePath.split("/").pop() ?? "";

		// Dedupe — chokidar can fire `add` multiple times for the same file
		// in some edge cases (e.g. rename across devices). Our delivered set
		// prevents double-fire within process lifetime.
		if (this.delivered.has(basename)) {
			this.logger.warn(
				"[StructuredInboxRouter] duplicate add event, skipping",
				{
					basename,
				},
			);
			return;
		}

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
			// Add to delivered set so chokidar replay events for the same
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
			return;
		}

		// Mark delivered + atomic move to processed/ for audit.
		this.delivered.add(basename);
		await this.moveProcessedSafe(filePath, basename);
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
