/**
 * FLY-929 B2 — the notify-digest expectation watchdog tick.
 *
 * Treats the missing daily token report as ITSELF a notification ("该发的
 * digest 没发成功 → 本身算一条通知" — the anti-silent-failure clause of the
 * FLY-915 PRD). Piggybacks the Bridge's existing 30s poll (`onPollComplete`,
 * FLY-169 discipline: zero new timers).
 *
 * Semantics: the 00:30 launchd job publishes YESTERDAY's report. So at any
 * instant past the 01:00 local deadline, the receipt must carry
 * `date === yesterday-in-report-tz`. No receipt / wrong date ⇒ ONE
 * `notify_digest_failed` alert per expected day — the eventId embeds the
 * expected date and the LeadAlertNotifier claims-table dedup (shared with
 * lead-alert.sh) makes repeated ticks a no-op.
 *
 * FLY-1243: the FLYWHEEL_NOTIFY_DIGEST_EXPECT gate is retired (固化 default-on);
 * the check always runs past the 01:00 deadline.
 */

import type { AlertPayload } from "../LeadAlertNotifier.js";
import { type NotifyReceipts, readNotifyReceipts } from "./notify-receipts.js";

/** Civil date (YYYY-MM-DD) of `now` in `tz` — same semantics as token-usage's todayInTz. */
export function localDate(now: Date, tz: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
}

/** Hour-of-day (0-23) of `now` in `tz`. */
export function localHour(now: Date, tz: string): number {
	return Number(
		new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hour: "2-digit",
			hourCycle: "h23",
		}).format(now),
	);
}

/** Shift a YYYY-MM-DD civil date by `delta` days (UTC arithmetic on the civil date). */
function shiftDay(day: string, delta: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + delta);
	return d.toISOString().slice(0, 10);
}

/** The report day the daily job should have delivered by now: yesterday in the report tz. */
export function expectedReportDate(now: Date, tz: string): string {
	return shiftDay(localDate(now, tz), -1);
}

export type NotifyDigestExpectOutcome =
	| "before-deadline" // local time < 01:00 — too early to judge
	| "receipt-ok" // receipt present with the expected date — quiet
	| "alerted"; // missing/wrong-date receipt → alert fired (deduped downstream)

export interface NotifyDigestExpectDeps {
	now: Date;
	/** Report timezone — MUST match the CLI's TOKEN_USAGE_TIMEZONE semantics. */
	tz: string;
	receiptsPath: string;
	/** The LeadAlertNotifier alert entry point (claims-deduped). */
	alert: (payload: AlertPayload) => Promise<unknown>;
	/** Test seam. */
	readReceipts?: (path: string) => NotifyReceipts;
}

/** FLY-929 B2 alert-identity contract (Codex design R1#5). */
export function notifyDigestFailedPayload(expectedDate: string): AlertPayload {
	return {
		leadId: "codex-infra-bot-lead",
		projectName: "flywheel",
		eventId: `notify_digest_failed:${expectedDate}`,
		eventType: "notify_digest_failed",
		title: "每日 token report 未送达",
		body:
			`到点（01:00 报告时区)未见 ${expectedDate} 的 token report 投递回执。` +
			"检查 launchd com.flywheel.token-usage-daily / Bridge /api/reports 投递 / " +
			"/tmp/flywheel-token-usage-daily.err。",
		severity: "warning",
	};
}

export async function notifyDigestExpectTick(
	deps: NotifyDigestExpectDeps,
): Promise<NotifyDigestExpectOutcome> {
	if (localHour(deps.now, deps.tz) < 1) return "before-deadline";

	const expected = expectedReportDate(deps.now, deps.tz);
	const read = deps.readReceipts ?? readNotifyReceipts;
	const receipts = read(deps.receiptsPath);
	if (receipts.token_report?.date === expected) return "receipt-ok";

	await deps.alert(notifyDigestFailedPayload(expected));
	return "alerted";
}
