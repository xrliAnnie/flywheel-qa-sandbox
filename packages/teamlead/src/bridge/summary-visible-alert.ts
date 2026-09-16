import { createHash } from "node:crypto";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import { FLEET_ALERT_PROJECT } from "../LeadAlertNotifier.js";
import type { SummaryRoundResult } from "./summary-round-classify.js";

export interface SummaryVisibleFailureAlert {
	diagnosticRef: string;
	payload: AlertPayload;
}

/**
 * Founder-visible fleet alerts carry only impact plus an opaque lookup key.
 * The frozen slot event remains the internal source for roster/count/error detail.
 */
export function formatSummaryVisibleFailureAlert(input: {
	slotStart: string;
	result: SummaryRoundResult;
}): SummaryVisibleFailureAlert {
	const diagnosticRef = `summary-alert:${createHash("sha256")
		.update(
			JSON.stringify({
				slotStart: input.slotStart,
				undelivered: input.result.undelivered,
				deliveryUnknown: input.result.delivery_unknown,
				reportLine: input.result.report_line,
			}),
		)
		.digest("hex")
		.slice(0, 20)}`;
	return {
		diagnosticRef,
		payload: {
			leadId: "raya-summary",
			projectName: FLEET_ALERT_PROJECT,
			eventId: diagnosticRef,
			eventType: "inbox_loop_stalled",
			title: "进展收集出现送达问题",
			body: `部分后台进展未能完成收集，工程侧正在处理。\n诊断编号：${diagnosticRef}`,
			severity: "warning",
		},
	};
}

export function formatSummaryVisibleStaleAlert(input: {
	diagnosticRef: string;
}): AlertPayload {
	if (!/^summary-stale:[0-9a-f]{20}$/u.test(input.diagnosticRef)) {
		throw new Error("summary_visible_alert_invalid_diagnostic_ref");
	}
	return {
		leadId: "raya-summary",
		projectName: FLEET_ALERT_PROJECT,
		eventId: input.diagnosticRef,
		eventType: "inbox_loop_stalled",
		title: "进展汇总处理停滞",
		body: `后台汇总处理长时间没有进展，工程侧需要核对。\n诊断编号：${input.diagnosticRef}`,
		severity: "warning",
	};
}
