/**
 * FLY-247 inc2a (§2.5): the two independent exhaustive mappings from the durable
 * batch journal to the console's progress display.
 *
 * Two enums, each with its OWN exhaustive CI assertion (R8 #3):
 *   - `BatchStatus` → the batch-level top banner copy/tone.
 *   - `KeyStatus`   → per-key monotonic rank + step copy.
 *
 * The rank is monotonic-by-construction: the engine only advances a key forward
 * (pending → config-writing → config-written → applying → applied, or a restore
 * branch config-restoring → failed-restored). The UI additionally clamps to the
 * max rank seen so a reconnect/SSE replay can never visually regress a key
 * (R5 #5 + R9 #2).
 */

import type { CanonicalRequest } from "./fleet-admin.js";

// ── Enums mirroring the bash journal (flywheel-fleet-journal.sh) ─────────────

export const BATCH_STATUSES = [
	"launching",
	"running",
	"applied",
	"partially-applied",
	"failed",
	"rejected",
	"recover-required",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const KEY_STATUSES = [
	"pending",
	"config-writing",
	"config-written",
	"applying",
	"applied",
	"config-restoring",
	"failed-restored",
	"config-restore-conflict",
	"manual-intervention",
	"skipped",
	"unapplied",
] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

// ── Display tones (UI maps these to colors; html-report-style palette) ───────

export type ProgressTone = "wait" | "doing" | "done" | "warn" | "error";

export interface BatchStatusView {
	label: string;
	tone: ProgressTone;
	/** True once the batch will not change further. */
	terminal: boolean;
}

export interface KeyStatusView {
	/** Monotonic rank 0..5 (UI clamps to the max seen). */
	rank: number;
	label: string;
	tone: ProgressTone;
	/** True once the key will not change further. */
	terminal: boolean;
	/** Surface a runbook / manual-intervention hint (never claims "kept as-is"). */
	manual?: boolean;
}

/** ① BatchStatus → batch-level banner (R8 #3 exhaustive). */
export const BATCH_STATUS_VIEW: Record<BatchStatus, BatchStatusView> = {
	launching: { label: "排队", tone: "wait", terminal: false },
	running: { label: "执行中", tone: "doing", terminal: false },
	applied: { label: "全部完成", tone: "done", terminal: true },
	"partially-applied": { label: "部分完成", tone: "warn", terminal: true },
	failed: { label: "全部失败", tone: "error", terminal: true },
	rejected: { label: "已拒绝", tone: "error", terminal: true },
	"recover-required": { label: "需恢复", tone: "error", terminal: true },
};

/** ② KeyStatus → per-key rank/copy (R8 #3 exhaustive). */
export const KEY_STATUS_VIEW: Record<KeyStatus, KeyStatusView> = {
	pending: { rank: 0, label: "排队", tone: "wait", terminal: false },
	"config-writing": { rank: 1, label: "备份", tone: "doing", terminal: false },
	"config-written": { rank: 3, label: "应用", tone: "doing", terminal: false },
	applying: { rank: 3, label: "应用", tone: "doing", terminal: false },
	applied: { rank: 5, label: "✓ 完成", tone: "done", terminal: true },
	"config-restoring": {
		rank: 4,
		label: "正在回滚",
		tone: "doing",
		terminal: false,
	},
	"failed-restored": {
		rank: 5,
		label: "已回滚,保原状",
		tone: "warn",
		terminal: true,
	},
	"config-restore-conflict": {
		rank: 5,
		label: "需人工",
		tone: "error",
		terminal: true,
		manual: true,
	},
	"manual-intervention": {
		rank: 5,
		label: "需人工",
		tone: "error",
		terminal: true,
		manual: true,
	},
	skipped: { rank: 5, label: "未动", tone: "wait", terminal: true },
	unapplied: { rank: 5, label: "未动", tone: "wait", terminal: true },
};

export function isBatchStatus(s: string): s is BatchStatus {
	return (BATCH_STATUSES as readonly string[]).includes(s);
}
export function isKeyStatus(s: string): s is KeyStatus {
	return (KEY_STATUSES as readonly string[]).includes(s);
}

// ── Journal → progress DTO ──────────────────────────────────────────────────

/** The on-disk batch journal record (flywheel-fleet-journal.sh schema). */
export interface BatchJournal {
	batchId: string;
	batchStatus: BatchStatus;
	owner?: { pid?: number; created?: number };
	preImageSha?: string;
	canonicalRequest?: CanonicalRequest;
	keys: Record<
		string,
		{
			// FLY-671: `effort` present only when the change touches effort (three-state).
			from: { model: string | null; effort?: string | null };
			to: { model: string | null; effort?: string | null };
			status: KeyStatus;
			intendedPostSha?: string;
		}
	>;
}

export interface KeyProgress {
	key: string;
	/** Model dimension (kept; legacy model-only journals read identically). */
	from: string | null;
	to: string | null;
	/**
	 * FLY-671: effort dimension, field-level. `null` when the change did NOT touch
	 * effort (UI shows only the model diff); a present effort key surfaces its own
	 * from→to so "only effort changed" is never invisible (Codex R1 MEDIUM-9).
	 */
	fromEffort: string | null;
	toEffort: string | null;
	/** True iff this change actually touched the effort dimension. */
	touchesEffort: boolean;
	status: KeyStatus;
	rank: number;
	label: string;
	tone: ProgressTone;
	terminal: boolean;
	manual: boolean;
}

export interface BatchProgress {
	batchId: string;
	batchStatus: BatchStatus;
	batchLabel: string;
	batchTone: ProgressTone;
	terminal: boolean;
	keys: KeyProgress[];
}

/**
 * Map a parsed journal to the console progress DTO. Unknown enum members fall
 * back to a loud error/manual state rather than throwing (a malformed journal
 * must still be visible, never silently swallowed).
 */
export function buildBatchProgress(journal: BatchJournal): BatchProgress {
	const bv = BATCH_STATUS_VIEW[journal.batchStatus] ?? {
		label: `未知(${journal.batchStatus})`,
		tone: "error" as ProgressTone,
		terminal: true,
	};
	const keys: KeyProgress[] = Object.entries(journal.keys ?? {}).map(
		([key, k]) => {
			const kv = KEY_STATUS_VIEW[k.status] ?? {
				rank: 5,
				label: `未知(${k.status})`,
				tone: "error" as ProgressTone,
				terminal: true,
				manual: true,
			};
			// FLY-671: effort is part of the change iff the `to` carries the key.
			const touchesEffort = k.to != null && Object.hasOwn(k.to, "effort");
			return {
				key,
				from: k.from?.model ?? null,
				to: k.to?.model ?? null,
				fromEffort: touchesEffort ? (k.from?.effort ?? null) : null,
				toEffort: touchesEffort ? (k.to?.effort ?? null) : null,
				touchesEffort,
				status: k.status,
				rank: kv.rank,
				label: kv.label,
				tone: kv.tone,
				terminal: kv.terminal,
				manual: kv.manual === true,
			};
		},
	);
	return {
		batchId: journal.batchId,
		batchStatus: journal.batchStatus,
		batchLabel: bv.label,
		batchTone: bv.tone,
		terminal: bv.terminal,
		keys,
	};
}
