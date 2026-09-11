import { randomUUID } from "node:crypto";
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appendRotatedLogSync } from "flywheel-config";
import type {
	RegistrySnapshot,
	SubscriptionEntry,
} from "./RoundtableThreadRegistry.js";
export const ledgerPath = (stateDir: string): string =>
	join(stateDir, "roundtable-subscriptions.json");
export const auditPath = (stateDir: string): string =>
	join(stateDir, "roundtable-subscriptions-audit.jsonl");
export type LedgerParseResult =
	| {
			ok: true;
			snapshot: RegistrySnapshot;
			dropped: Array<{ raw: unknown; why: string }>;
	  }
	| { ok: false; reason: "missing" | "corrupt" };
/** Read-only schema validation; domain, expiry, duplicates and cap belong to restore. */
export function parseLedgerFile(path: string): LedgerParseResult {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return {
			ok: false,
			reason:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "missing"
					: "corrupt",
		};
	}
	if (
		!raw ||
		typeof raw !== "object" ||
		(raw as RegistrySnapshot).version !== 1 ||
		!Array.isArray((raw as RegistrySnapshot).entries)
	)
		return { ok: false, reason: "corrupt" };
	const entries: SubscriptionEntry[] = [];
	const dropped: Array<{ raw: unknown; why: string }> = [];
	for (const item of (raw as RegistrySnapshot).entries) {
		const e = item as SubscriptionEntry | null;
		const validTime = (v: unknown) =>
			typeof v === "string" &&
			/^\d{4}-\d\d-\d\dT/.test(v) &&
			Number.isFinite(Date.parse(v));
		if (
			!e ||
			typeof e !== "object" ||
			typeof e.threadId !== "string" ||
			!/^\d{17,20}$/.test(e.threadId) ||
			typeof e.parentChannelId !== "string" ||
			!/^\d{17,20}$/.test(e.parentChannelId) ||
			!["mention", "discovery", "restore"].includes(e.source) ||
			!validTime(e.subscribedAt) ||
			!validTime(e.lastActivityAt) ||
			!validTime(e.expiresAt)
		)
			dropped.push({ raw: item, why: "invalid_entry" });
		else
			entries.push({
				threadId: e.threadId,
				parentChannelId: e.parentChannelId,
				source: e.source,
				subscribedAt: e.subscribedAt,
				lastActivityAt: e.lastActivityAt,
				expiresAt: e.expiresAt,
			});
	}
	return { ok: true, snapshot: { version: 1, entries }, dropped };
}
export function persistSnapshot(
	path: string,
	snapshot: RegistrySnapshot,
): void {
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(snapshot), { flag: "wx", mode: 0o600 });
		renameSync(tmp, path);
	} finally {
		if (existsSync(tmp)) unlinkSync(tmp);
	}
}
export function quarantineCorrupt(path: string): void {
	renameSync(path, `${path}.corrupt.${Date.now()}.${randomUUID().slice(0, 8)}`);
}
export function appendAudit(path: string, row: Record<string, unknown>): void {
	try {
		appendRotatedLogSync(path, `${JSON.stringify(row)}\n`);
	} catch {
		/* Audit cannot change subscription authority. */
	}
}
