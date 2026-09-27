/**
 * FLY-2900 §7 — the account page's "额度待命中的节点" section and the STEP 2
 * one-liner, projected from the standby carrier, the resume audit and the
 * resume loop's last evaluation. Pure data; the page escapes every string.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CodexQuotaStandbyRow } from "../bridge/codex-quota-store.js";
import type { CodexAccountQuotaStore } from "./codex-account-quota-store.js";
import {
	type CodexPoolMember,
	evaluatePoolExhaustionFromReadings,
} from "./quota-fallback.js";
import type { CodexQuotaResumeLoopSnapshot } from "./resume-loop.js";

export interface CodexStandbyPageRow {
	issue: string;
	node: string;
	enteredAt: string;
	status: string;
	earliestResetAt: string | null;
}

export interface CodexStandbyPageSection {
	rows: CodexStandbyPageRow[];
	claudeFallbacks14d: number;
	resumed24h: number;
	fallbacks24h: { codex: number; claude: number };
	oldestEnteredAt: string | null;
}

export interface CodexStandbyPageInput {
	rows: readonly CodexQuotaStandbyRow[];
	audit: readonly Record<string, unknown>[];
	issueOf(executionId: string): string | undefined;
	loop: CodexQuotaResumeLoopSnapshot | null;
	claudeFallbackEnabled: boolean;
	readings: CodexAccountQuotaStore | null;
	pool: readonly CodexPoolMember[];
	nowMs: number;
}

function blockedBy(
	audit: readonly Record<string, unknown>[],
	row: CodexQuotaStandbyRow,
): string | null {
	const prefix = `${row.execution_id}:${row.entry_seq}:fallback_blocked:`;
	const hit = [...audit]
		.reverse()
		.find((entry) => String(entry.event_uid).startsWith(prefix));
	return hit ? String(hit.detail_code ?? "") : null;
}

export function buildCodexStandbyPageSection(
	input: CodexStandbyPageInput,
): CodexStandbyPageSection {
	const verdict = evaluatePoolExhaustionFromReadings(
		input.readings,
		input.pool,
		input.nowMs,
	);
	const earliestResetAt = verdict.exhausted
		? new Date(verdict.earliestResetMs).toISOString()
		: null;
	const rows = input.rows.map((row) => {
		let status = "等额度";
		if (row.state === "resuming") status = "恢复中";
		else if (row.state === "fallback_prepared") status = "兜底准备中";
		else {
			const blocked = blockedBy(input.audit, row);
			if (blocked === "same_vendor_review")
				status = "等 Codex（同厂商评审禁止改派）";
			else if (blocked === "claude_model_unavailable")
				status = "等 Codex（Claude 模型不可用）";
			else if (blocked?.startsWith("wip_checkpoint_"))
				status = `兜底被阻止：${blocked}`;
			else if (verdict.exhausted && !input.claudeFallbackEnabled)
				status = "全池满 · Claude 兜底开关关闭（排队中）";
			else if (input.loop?.precondition)
				status = `permit 前提不满足：${input.loop.precondition}`;
		}
		return {
			issue: input.issueOf(row.execution_id) ?? row.run_id,
			node: row.node_id,
			enteredAt: row.entered_at,
			status,
			earliestResetAt,
		};
	});
	const since = (ms: number) => new Date(input.nowMs - ms).toISOString();
	const within = (entry: Record<string, unknown>, ms: number) =>
		String(entry.at ?? "") >= since(ms);
	const count = (
		action: string,
		ms: number,
		vendor?: "codex" | "claude",
	): number =>
		input.audit.filter(
			(entry) =>
				entry.action === action &&
				within(entry, ms) &&
				(vendor === undefined || entry.vendor === vendor),
		).length;
	const oldest = input.rows
		.map((row) => row.entered_at)
		.sort()
		.at(0);
	return {
		rows,
		claudeFallbacks14d: count("fallback_committed", 14 * 86_400_000, "claude"),
		resumed24h: count("resumed", 86_400_000),
		fallbacks24h: {
			codex: count("fallback_committed", 86_400_000, "codex"),
			claude: count("fallback_committed", 86_400_000, "claude"),
		},
		oldestEnteredAt: oldest ?? null,
	};
}

/** STEP 2: `CODEX_STANDBY count=<n> oldest=<dur> resumed_24h=<n> fallback_24h=<codex>/<claude>`. */
export function formatCodexStandbyStepLine(
	section: CodexStandbyPageSection,
	nowMs: number,
): string {
	const oldest = section.oldestEnteredAt
		? Math.max(
				0,
				Math.round((nowMs - Date.parse(section.oldestEnteredAt)) / 60_000),
			)
		: null;
	return `CODEX_STANDBY count=${section.rows.length} oldest=${oldest === null ? "-" : `${oldest}m`} resumed_24h=${section.resumed24h} fallback_24h=${section.fallbacks24h.codex}/${section.fallbacks24h.claude}`;
}

/**
 * FLY-2900: atomically project the STEP 2 counts for the patrol helper
 * (`scripts/lib/codex-quota-summary.mjs`). Written every maintenance tick, so
 * a stale file means the Bridge stopped projecting.
 */
export function writeCodexStandbySummary(
	path: string,
	section: CodexStandbyPageSection,
	nowMs: number,
): void {
	const oldestMinutes = section.oldestEnteredAt
		? Math.max(
				0,
				Math.round((nowMs - Date.parse(section.oldestEnteredAt)) / 60_000),
			)
		: null;
	const body = `${JSON.stringify({
		schemaVersion: 1,
		generatedAt: new Date(nowMs).toISOString(),
		count: section.rows.length,
		oldestMinutes: Number.isSafeInteger(oldestMinutes) ? oldestMinutes : null,
		resumed24h: section.resumed24h,
		fallback24hCodex: section.fallbacks24h.codex,
		fallback24hClaude: section.fallbacks24h.claude,
	})}\n`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}`;
	writeFileSync(temp, body, { mode: 0o600 });
	renameSync(temp, path);
}
