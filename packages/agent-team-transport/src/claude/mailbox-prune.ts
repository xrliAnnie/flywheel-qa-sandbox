/**
 * FLY-182 Track A — mailbox + sidecar bounding (prune) + unread-overflow marker.
 *
 * Root cause (FLY-182): the claude-code mailbox (`<teams>/<lead>/inboxes/<agent>.json`)
 * and its `.flywheel.jsonl` sidecar are both append-only with no prune. Stock
 * claude-code bounds mailboxes via team lifecycle (`TeamDelete` → `rm -rf`);
 * Flywheel's permanent Leads never TeamDelete, so both files grow unbounded
 * until `writeVerified` times out and delivery cascades.
 *
 * This module provides the prune logic, invoked from `ClaudeMailboxCodec`
 * INSIDE the existing inbox / sidecar lock critical sections (zero extra lock,
 * zero new race vs stock `markMessagesAsRead`).
 *
 * Design invariants (Codex design review R1+R2):
 * - **Never delete `read:false`** (A1). `read` missing/non-boolean → treated as
 *   unread (safe side). This is a property of the prune CODE — NOT an
 *   end-to-end no-loss guarantee (stock `useInboxPoller` read-then-mark-all
 *   race is pre-existing stock behavior; the retention window buffers it).
 * - **Output preserves original append order** — we only DROP old read entries,
 *   keeping the rest in their original positions. No re-sort → no unpredictable
 *   reordering (Codex R1#11). Timestamp sort is used ONLY internally to select
 *   which read entries are the most-recent `READ_KEEP`.
 * - **Sidecar idempotency-first** (Codex R1#2 + R2#1): finalized records within
 *   `SIDECAR_RETENTION_MS` (7d default) are ALWAYS kept — never dropped by the
 *   count cap. `SIDECAR_KEEP` only provides EXTRA protection for records OLDER
 *   than retention. pending records are never time-pruned. This covers the
 *   timed-out-but-eventually-finalized `flywheelId` retry path.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getStateDir } from "../path-helpers.js";
import type { SidecarRecord, TeammateMessage } from "./ClaudeMailboxCodec.js";

// ----------------------------------------------------------------------------
// Policy + env resolution
// ----------------------------------------------------------------------------

export interface PrunePolicy {
	/** Keep the most recent N read entries regardless of age. */
	readKeep: number;
	/** Read entries older than this (and beyond readKeep) are dropped. ms. */
	readRetentionMs: number;
	/** Unread count >= this triggers the overflow marker. */
	unreadWarn: number;
	/** Finalized sidecar records older than this MAY be dropped. ms. */
	sidecarRetentionMs: number;
	/** Extra protection: keep the most recent N finalized records older than retention. */
	sidecarKeep: number;
}

export const DEFAULT_PRUNE_POLICY: PrunePolicy = {
	readKeep: 50,
	readRetentionMs: 86_400_000, // 24h
	unreadWarn: 200,
	sidecarRetentionMs: 604_800_000, // 7 days
	sidecarKeep: 2000,
};

/**
 * Read a positive-integer env var, falling back to `fallback` when unset,
 * empty, non-numeric, negative, or zero (zero would disable retention/keep in
 * surprising ways — require explicit positive values).
 */
function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim().length === 0) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
	return n;
}

/** Resolve the prune policy from env, falling back to defaults. */
export function resolvePrunePolicy(): PrunePolicy {
	return {
		readKeep: envPositiveInt(
			"FLYWHEEL_MAILBOX_READ_KEEP",
			DEFAULT_PRUNE_POLICY.readKeep,
		),
		readRetentionMs: envPositiveInt(
			"FLYWHEEL_MAILBOX_READ_RETENTION_MS",
			DEFAULT_PRUNE_POLICY.readRetentionMs,
		),
		unreadWarn: envPositiveInt(
			"FLYWHEEL_MAILBOX_UNREAD_WARN",
			DEFAULT_PRUNE_POLICY.unreadWarn,
		),
		sidecarRetentionMs: envPositiveInt(
			"FLYWHEEL_MAILBOX_SIDECAR_RETENTION_MS",
			DEFAULT_PRUNE_POLICY.sidecarRetentionMs,
		),
		sidecarKeep: envPositiveInt(
			"FLYWHEEL_MAILBOX_SIDECAR_KEEP",
			DEFAULT_PRUNE_POLICY.sidecarKeep,
		),
	};
}

// ----------------------------------------------------------------------------
// Main inbox prune
// ----------------------------------------------------------------------------

/** An entry is unread unless `read === true` (malformed/undefined → unread). */
function isUnread(entry: TeammateMessage): boolean {
	return entry.read !== true;
}

/** Parse ISO timestamp → ms, or null when invalid. */
function parseTs(entry: TeammateMessage): number | null {
	const t = Date.parse(entry.timestamp);
	return Number.isNaN(t) ? null : t;
}

export interface MainPruneResult {
	/** The entries to write back, in ORIGINAL order (only old read dropped). */
	kept: TeammateMessage[];
	/** Number of unread entries (all preserved). */
	unreadCount: number;
	/** Oldest unread timestamp (ms), or null when no unread. */
	oldestUnreadTs: number | null;
	/** How many read entries were dropped. */
	droppedCount: number;
}

/**
 * Prune read entries while preserving ALL unread and original order.
 *
 * Kept read = (most recent `readKeep` read entries) ∪ (read entries newer than
 * `now - readRetentionMs`). Everything else read is dropped. Unread is always
 * fully preserved.
 */
export function pruneMainEntries(
	entries: TeammateMessage[],
	policy: PrunePolicy,
	now: number,
): MainPruneResult {
	const readItems: Array<{ entry: TeammateMessage; idx: number }> = [];
	let unreadCount = 0;
	let oldestUnreadTs: number | null = null;

	entries.forEach((entry, idx) => {
		if (isUnread(entry)) {
			unreadCount++;
			const ts = parseTs(entry);
			if (ts !== null && (oldestUnreadTs === null || ts < oldestUnreadTs)) {
				oldestUnreadTs = ts;
			}
		} else {
			readItems.push({ entry, idx });
		}
	});

	// Fast path: nothing read to consider.
	if (readItems.length === 0) {
		return {
			kept: entries.slice(),
			unreadCount,
			oldestUnreadTs,
			droppedCount: 0,
		};
	}

	const keep = new Set<number>();

	// (a) most recent `readKeep` read entries, by (ts asc, original index asc).
	// Invalid timestamps sort LAST (treated as +Infinity) — deterministic.
	const sorted = readItems.slice().sort((a, b) => {
		const va = parseTs(a.entry) ?? Number.POSITIVE_INFINITY;
		const vb = parseTs(b.entry) ?? Number.POSITIVE_INFINITY;
		if (va !== vb) return va - vb;
		return a.idx - b.idx; // stable tie-break on original index
	});
	const keepCount = Math.min(policy.readKeep, sorted.length);
	for (let k = sorted.length - keepCount; k < sorted.length; k++) {
		const it = sorted[k];
		if (it) keep.add(it.idx);
	}

	// (b) read entries newer than the retention window.
	const cutoff = now - policy.readRetentionMs;
	for (const it of readItems) {
		const ts = parseTs(it.entry);
		// Invalid-timestamp read entries are NOT retained by the time rule
		// (only by the recent-count rule above) — they cannot prove freshness.
		if (ts !== null && ts >= cutoff) keep.add(it.idx);
	}

	// Build output preserving original order; keep all unread + kept read.
	const kept: TeammateMessage[] = [];
	let droppedCount = 0;
	entries.forEach((entry, idx) => {
		if (isUnread(entry) || keep.has(idx)) {
			kept.push(entry);
		} else {
			droppedCount++;
		}
	});

	return { kept, unreadCount, oldestUnreadTs, droppedCount };
}

// ----------------------------------------------------------------------------
// Sidecar prune
// ----------------------------------------------------------------------------

/** Effective timestamp for a sidecar record (finalizedAt preferred). */
function recordTs(r: SidecarRecord): number {
	return r.finalizedAt ?? r.pendingAt;
}

/**
 * Prune finalized sidecar records, idempotency-first.
 *
 * - All `pending` records are kept (may be in-flight).
 * - All `finalized` records within `sidecarRetentionMs` are kept (HARD — never
 *   dropped by the count cap; this preserves idempotency for retries).
 * - Finalized records OLDER than retention: keep only the most recent
 *   `sidecarKeep` of them (extra protection), drop the rest.
 *
 * Output preserves original order.
 */
export function pruneSidecarRecords(
	records: SidecarRecord[],
	policy: PrunePolicy,
	now: number,
): SidecarRecord[] {
	const cutoff = now - policy.sidecarRetentionMs;
	const olderFinalized: SidecarRecord[] = [];
	for (const r of records) {
		if (r.status === "finalized" && recordTs(r) < cutoff) {
			olderFinalized.push(r);
		}
	}
	if (olderFinalized.length <= policy.sidecarKeep) {
		// Nothing exceeds the extra-protection cap → keep everything.
		return records.slice();
	}
	// Keep the most recent `sidecarKeep` older-finalized; drop the rest.
	const keepOlder = new Set(
		olderFinalized
			.slice()
			.sort((a, b) => recordTs(b) - recordTs(a))
			.slice(0, policy.sidecarKeep),
	);
	return records.filter((r) => {
		if (r.status === "finalized" && recordTs(r) < cutoff) {
			return keepOlder.has(r);
		}
		return true; // pending OR within-retention finalized → always keep
	});
}

// ----------------------------------------------------------------------------
// Unread-overflow marker
// ----------------------------------------------------------------------------

/** Parse `<...>/teams/<team>/inboxes/<recipient>.json` → identity. */
export function parseInboxIdentity(inboxPath: string): {
	team: string;
	recipient: string;
} {
	const parts = inboxPath.split(/[/\\]/);
	const last = parts[parts.length - 1] ?? "";
	const recipient = last.replace(/\.json$/, "");
	const inboxesIdx = parts.lastIndexOf("inboxes");
	const team =
		inboxesIdx > 0 ? (parts[inboxesIdx - 1] ?? "unknown") : "unknown";
	return { team, recipient };
}

/** Directory holding overflow markers. */
export function overflowMarkerDir(): string {
	return join(getStateDir(), "mailbox-overflow");
}

/** Marker path = `<stateDir>/mailbox-overflow/<sha1(inboxPath)>.json`. */
export function overflowMarkerPath(inboxPath: string): string {
	const hash = createHash("sha1").update(inboxPath).digest("hex");
	return join(overflowMarkerDir(), `${hash}.json`);
}

export interface OverflowMarker {
	team: string;
	recipient: string;
	inboxPath: string;
	unread: number;
	oldestUnreadTs: number | null;
	observedAt: string;
}

/**
 * Write the overflow marker when unread >= threshold, else delete it.
 *
 * Idempotent: overwrite (atomic temp+rename) on overflow; unlink (ignore
 * ENOENT) when unread drops below threshold so PR2 self-monitoring does not
 * alert on stale markers. Never throws — marker I/O must not break delivery.
 */
export async function updateOverflowMarker(args: {
	inboxPath: string;
	unreadCount: number;
	oldestUnreadTs: number | null;
	policy: PrunePolicy;
	now: number;
	logger?: (msg: string, ctx?: Record<string, unknown>) => void;
}): Promise<void> {
	const markerPath = overflowMarkerPath(args.inboxPath);
	const log =
		args.logger ??
		((msg, ctx) => {
			console.warn(`[mailbox-prune] ${msg}`, ctx ?? {});
		});
	try {
		if (args.unreadCount >= args.policy.unreadWarn) {
			const { team, recipient } = parseInboxIdentity(args.inboxPath);
			const marker: OverflowMarker = {
				team,
				recipient,
				inboxPath: args.inboxPath,
				unread: args.unreadCount,
				oldestUnreadTs: args.oldestUnreadTs,
				observedAt: new Date(args.now).toISOString(),
			};
			await mkdir(dirname(markerPath), { recursive: true });
			const tmp = `${markerPath}.tmp.${process.pid}.${args.now}`;
			await writeFile(tmp, JSON.stringify(marker, null, 2), "utf-8");
			await rename(tmp, markerPath);
			log("unread overflow — Lead not consuming mailbox", {
				team,
				recipient,
				unread: args.unreadCount,
				threshold: args.policy.unreadWarn,
			});
		} else {
			await unlink(markerPath).catch((err) => {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			});
		}
	} catch (err) {
		// Marker I/O is best-effort — never break the delivery write path.
		log(`overflow marker update failed: ${(err as Error).message}`, {
			inboxPath: args.inboxPath,
		});
	}
}
