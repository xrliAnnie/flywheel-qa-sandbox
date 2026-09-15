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
	const bindings = (raw as RegistrySnapshot).proactiveBindings;
	if (
		bindings !== undefined &&
		(!bindings ||
			typeof bindings !== "object" ||
			Array.isArray(bindings) ||
			Object.entries(bindings).some(
				([eventId, v]) =>
					!eventId ||
					eventId.length > 512 ||
					!v ||
					typeof v !== "object" ||
					!/^\d{17,20}$/.test(v.threadId) ||
					!/^\d{17,20}$/.test(v.parentChannelId) ||
					!/^[a-f0-9]{64}$/.test(v.payloadHash),
			))
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
			!validTime(e.expiresAt) ||
			(e.proactive !== undefined &&
				(!e.proactive ||
					typeof e.proactive !== "object" ||
					typeof e.proactive.eventId !== "string" ||
					!e.proactive.eventId ||
					typeof e.proactive.payloadHash !== "string" ||
					!/^[a-f0-9]{64}$/.test(e.proactive.payloadHash) ||
					typeof e.proactive.after !== "string" ||
					!/^\d{17,20}$/.test(e.proactive.after) ||
					(e.proactive.through !== undefined &&
						(typeof e.proactive.through !== "string" ||
							!/^\d{17,20}$/.test(e.proactive.through))) ||
					!["pending", "ready"].includes(e.proactive.engagement))) ||
			(e.continuation !== undefined &&
				(!e.continuation ||
					typeof e.continuation !== "object" ||
					!Number.isSafeInteger(e.continuation.remaining) ||
					e.continuation.remaining < 0 ||
					!e.continuation.admissions ||
					typeof e.continuation.admissions !== "object" ||
					Array.isArray(e.continuation.admissions) ||
					Object.entries(e.continuation.admissions).some(
						([id, admitted]) =>
							!/^\d{17,20}$/.test(id) || typeof admitted !== "boolean",
					)))
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
				...(e.proactive ? { proactive: structuredClone(e.proactive) } : {}),
				...(e.continuation
					? { continuation: structuredClone(e.continuation) }
					: {}),
			});
	}
	return {
		ok: true,
		snapshot: {
			version: 1,
			entries,
			...(bindings ? { proactiveBindings: structuredClone(bindings) } : {}),
		},
		dropped,
	};
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
