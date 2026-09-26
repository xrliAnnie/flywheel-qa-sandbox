/**
 * FLY-929 B1 — the notify delivery receipt file.
 *
 * Written by the Bridge (single writer) after a successful token-report
 * delivery; read by the digest-expect watchdog (notify-digest-expect.ts).
 * FLY-1243: the notify self-health check is固化 default-on (the
 * FLYWHEEL_NOTIFY_DIGEST_EXPECT gate is retired) — the receipt is always written.
 *
 * Date contract (Codex design R1#5): the receipt `date` is the report day the
 * CLI computed under `TOKEN_USAGE_TIMEZONE` and passed through
 * `publish-report --expected-date` → `/api/reports/deliver` body. The Bridge
 * NEVER recomputes it from its own env (plist/process tz drift).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface NotifyReceipts {
	token_report?: {
		/** The report day (YYYY-MM-DD) this delivery covered — CLI-computed. */
		date: string;
		/** Delivery instant (ISO). */
		ts: string;
		messageId?: string;
	};
}

/** `FLYWHEEL_NOTIFY_RECEIPTS_PATH` override (tests) → ~/.flywheel/notify-receipts.json. */
export function defaultReceiptsPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return (
		env.FLYWHEEL_NOTIFY_RECEIPTS_PATH ??
		join(homedir(), ".flywheel", "notify-receipts.json")
	);
}

/** Missing / unreadable / corrupt file ⇒ {} — the expect check treats that as
 *  "no receipt" (better one deduped alert too many than a silent gap). */
export function readNotifyReceipts(path: string): NotifyReceipts {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object"
			? (parsed as NotifyReceipts)
			: {};
	} catch {
		return {};
	}
}

/**
 * Record a successful token-report delivery. FLY-1243: the notify self-health
 * check is固化 default-on, so the receipt is always written. temp+rename atomic
 * write; a write failure is logged and never thrown — the delivery already
 * succeeded and the HTTP response must not be blocked on the receipt.
 */
export function writeTokenReportReceipt(
	entry: { date: string; messageId?: string },
	opts: {
		env?: NodeJS.ProcessEnv;
		path?: string;
		now?: () => Date;
		log?: (msg: string) => void;
	} = {},
): void {
	const env = opts.env ?? process.env;
	const log = opts.log ?? ((m) => console.warn(m));
	const path = opts.path ?? defaultReceiptsPath(env);
	const now = opts.now ?? (() => new Date());
	try {
		const receipts = readNotifyReceipts(path);
		receipts.token_report = {
			date: entry.date,
			ts: now().toISOString(),
			...(entry.messageId ? { messageId: entry.messageId } : {}),
		};
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(receipts, null, "\t")}\n`, "utf-8");
		renameSync(tmp, path);
	} catch (err) {
		log(
			`[notify-receipts] receipt write failed (delivery already succeeded): ${(err as Error).message}`,
		);
	}
}
