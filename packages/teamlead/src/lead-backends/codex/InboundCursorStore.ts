/**
 * FLY-224 (FLY code-review HIGH-4 fix) — InboundCursorStore: durable per-channel
 * "last seen Discord message id" so a Codex Lead RESTART RESUMES from where it left
 * off instead of re-baselining to the latest message (which silently drops every
 * message sent during the restart/downtime window).
 *
 * Semantics:
 *   - load(channelId) === undefined  → FIRST run for this channel → baseline to the
 *     channel's latest message (don't replay all history).
 *   - load(channelId) === <id>       → RESUME: the next poll fetches `after=<id>`, so
 *     messages sent while the Lead was down are delivered (no gap loss).
 *
 * The file store persists a `{ [channelId]: messageId }` JSON map atomically. Tests
 * use the in-memory store. No store wired → RestPollDiscordInboundSource keeps its
 * old baseline-to-latest behavior (byte-compat).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface InboundCursorStore {
	load(channelId: string): string | undefined;
	save(channelId: string, messageId: string): void;
}

/** In-memory cursor store (tests + reference). */
export class InMemoryInboundCursorStore implements InboundCursorStore {
	private readonly m = new Map<string, string>();
	load(channelId: string): string | undefined {
		return this.m.get(channelId);
	}
	save(channelId: string, messageId: string): void {
		this.m.set(channelId, messageId);
	}
}

/**
 * File-backed cursor store: a single JSON `{channelId: messageId}` map. Reads are
 * lazy + cached; writes are atomic (temp file + rename) so a crash mid-write never
 * corrupts the map. A missing/corrupt file → empty map (→ first-run baseline).
 */
export class FileInboundCursorStore implements InboundCursorStore {
	private readonly path: string;
	private cache: Record<string, string> | null = null;

	constructor(path: string) {
		this.path = path;
	}

	private read(): Record<string, string> {
		if (this.cache) return this.cache;
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
			this.cache =
				parsed && typeof parsed === "object"
					? (parsed as Record<string, string>)
					: {};
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	load(channelId: string): string | undefined {
		const v = this.read()[channelId];
		return typeof v === "string" && v ? v : undefined;
	}

	save(channelId: string, messageId: string): void {
		const map = this.read();
		if (map[channelId] === messageId) return;
		map[channelId] = messageId;
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, JSON.stringify(map), "utf8");
		renameSync(tmp, this.path);
	}
}
