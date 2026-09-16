import type Database from "better-sqlite3";

/** Read-only current facts. Workflow success, elapsed time and projection state
 * are never used to infer that publication occurred. */
export function customerReleaseReport(db: Database.Database, now: number) {
	if (!Number.isSafeInteger(now) || now < 0)
		throw new Error("release report clock invalid");
	return db
		.transaction(() => {
			const source = `SELECT 'cycle:'||e.event_id AS id FROM customer_release_events e JOIN customer_release_cycles c ON c.cycle_id=e.cycle_id WHERE c.project_id='flywheel'
   UNION ALL SELECT 'activation:'||event_id AS id FROM customer_release_activation_events WHERE project_id='flywheel'`;
			const counts = db
				.prepare(`WITH source AS (${source}) SELECT COUNT(*) AS sourceEvents,
   COALESCE(SUM(EXISTS(SELECT 1 FROM customer_release_projections p WHERE p.event_id=source.id AND target='linear' AND state='delivered')),0) AS linear,
   COALESCE(SUM(EXISTS(SELECT 1 FROM customer_release_projections p WHERE p.event_id=source.id AND target='github' AND state='delivered')),0) AS github FROM source`)
				.get() as { sourceEvents: number; linear: number; github: number };
			const rows = db
				.prepare(`SELECT cycle_id AS cycleId,release_id AS releaseId,slot_date AS slotDate,state,cancel_reason AS cancelReason,
   window_opened_at AS windowOpenedAt,deadline_at AS deadlineAt,
   COALESCE(json_extract(binding_json,'$.releaseVersion'),json_extract(frozen_beta_json,'$.baseVersion')) AS version,
   EXISTS(SELECT 1 FROM customer_release_events e WHERE e.cycle_id=c.cycle_id AND e.kind='manual_intake') AS manualIntake
   FROM customer_release_cycles c WHERE project_id='flywheel' ORDER BY created_at DESC,cycle_id LIMIT 101`)
				.all() as {
				cycleId: string;
				releaseId: string;
				slotDate: string;
				version: string | null;
				state: string;
				cancelReason: string | null;
				windowOpenedAt: number | null;
				deadlineAt: number | null;
				manualIntake: number;
			}[];
			return {
				observedAt: now,
				missedSlots: db
					.prepare(`SELECT json_extract(payload_json,'$.weekStart') AS weekStart,json_extract(payload_json,'$.reason') AS reason
                  FROM customer_release_activation_events WHERE project_id='flywheel' AND kind='cycle_slot_missed' ORDER BY happened_at DESC,event_id LIMIT 10`)
					.all() as { weekStart: string; reason: string }[],
				accounting: {
					sourceEvents: counts.sourceEvents,
					linear: {
						delivered: counts.linear,
						pending: counts.sourceEvents - counts.linear,
					},
					github: {
						delivered: counts.github,
						pending: counts.sourceEvents - counts.github,
					},
					consistent:
						counts.sourceEvents > 0 &&
						counts.linear === counts.sourceEvents &&
						counts.github === counts.sourceEvents,
				},
				cyclesTruncated: rows.length > 100,
				cycles: rows.slice(0, 100).map(({ manualIntake, ...cycle }) => ({
					...cycle,
					origin: manualIntake ? "manual_intake" : "automatic",
					results: db
						.prepare(
							`SELECT attempt_id AS attemptId,kind,observed_at AS observedAt FROM customer_release_attempt_results WHERE cycle_id=? ORDER BY observed_at DESC,attempt_id`,
						)
						.all(cycle.cycleId),
				})),
			};
		})
		.deferred();
}

export function renderCustomerReleaseSummary(
	report: ReturnType<typeof customerReleaseReport>,
): string {
	const esc = (v: unknown) =>
		String(v)
			.slice(0, 160)
			.replace(
				/[&<>"']/g,
				(c) =>
					({
						"&": "&amp;",
						"<": "&lt;",
						">": "&gt;",
						'"': "&quot;",
						"'": "&#39;",
					})[c]!,
			);
	const labels: Record<string, string> = {
		evaluating: "正在检查发布判据",
		preparing: "正在准备发布物",
		notice_pending: "等待通知送达确认",
		window_open: "否决窗口已开启",
		awaiting_attempt: "等待执行",
		committing: "正在提交发布",
		commit_unknown: "发布结果未确认",
		cancelled: "本周期已停止自动发布",
		manual_ready: "等待人工发布执行",
		published: "已确认发布",
	};
	const a = report.accounting;
	if (a.sourceEvents === 0) return "";
	return `<section aria-label="客户发布审计"><h2>客户发布审计</h2><p>当前快照：${esc(new Date(report.observedAt).toISOString())}</p><p>Bridge 事件 ${a.sourceEvents} · Linear 待补 ${a.linear.pending} · GitHub 待补 ${a.github.pending}${a.consistent ? " · 三本账一致" : " · 记账待补齐"}</p><ul>${report.cycles
		.slice(0, 10)
		.map(
			(c) =>
				`<li>${esc(c.version ?? c.releaseId)} · ${c.origin === "manual_intake" ? "人工验收周期" : "发布周期"} · ${esc(labels[c.state] ?? "状态待确认")}${c.state === "window_open" && c.deadlineAt !== null ? `<br>截止 ${esc(new Date(c.deadlineAt).toISOString())}（UTC）；如需拦下，请在候选卡点「别发」。` : ""}</li>`,
		)
		.join(
			"",
		)}</ul><ul>${report.missedSlots.map((s) => `<li>${esc(s.weekStart)} 当周：${s.reason === "no_candidate" ? "没有合格候选，本周未自动发布" : "信号未知，本周未自动发布"}</li>`).join("")}</ul>${report.cycles.length > 10 || report.cyclesTruncated ? "<p>仅显示最近 10 个周期。</p>" : ""}<p>记账状态不代表发布授权。结果未确认时，继续核对实际发布状态。</p></section>`;
}
