/**
 * FLY-929 B1 — the notify delivery receipt file.
 *
 * Written by the Bridge (single writer) after a successful token-report
 * delivery; read by the P-expect watchdog (notify-digest-expect.ts). The WHOLE
 * surface hangs under P-expect (`FLYWHEEL_NOTIFY_DIGEST_EXPECT=1`): unset ⇒
 * zero filesystem side effects, byte-compat.
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

/** P-expect: the self-health-check activation predicate. */
export function isDigestExpectEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.FLYWHEEL_NOTIFY_DIGEST_EXPECT === "1";
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
 * Record a successful token-report delivery. Gated on P-expect (unset ⇒ no fs
 * side effects at all). temp+rename atomic write; a write failure is logged
 * and never thrown — the delivery already succeeded and the HTTP response
 * must not be blocked on the receipt.
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
	if (!isDigestExpectEnabled(env)) return;
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
