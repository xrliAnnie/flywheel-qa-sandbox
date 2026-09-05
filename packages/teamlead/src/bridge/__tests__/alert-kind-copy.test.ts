import { describe, expect, it } from "vitest";
import {
	bodyFor,
	deliveryContractFrozenCopy,
	deliveryContractStalledCopy,
	deliveryOperationStalledCopy,
	deliveryRerouteOutcomeCopy,
	severityFor,
	titleFor,
} from "../alert-kind-copy.js";

describe("alert kind copy", () => {
	it("keeps run id, evidence stamp, and the hold-list gate on every FLY-2278 delivery alert", () => {
		const runId = "run-copy-contract";
		const evidenceAt = "2026-09-03T17:00:00.000Z";
		const copies = [
			deliveryContractFrozenCopy({
				issueId: "FLY-2278",
				shape: "mailbox_inflight_slots_exhausted",
				ageMs: 30 * 60_000,
				recipientExecutionId: "exec-abcdefghijk",
				sessionStatus: "running",
				liveness: "unknown",
				heartbeatAt: null,
				lastActivityAt: null,
				recentOutboundInWindow: false,
				runId,
				evidenceAt,
			}),
			deliveryRerouteOutcomeCopy({
				issueId: "FLY-2278",
				outcome: "rerouted",
				targetExecutionId: "target-abcdefgh",
				rerouteCount: 1,
				runId,
				evidenceAt,
			}),
			deliveryOperationStalledCopy({
				issueId: "FLY-2278",
				operationKind: "reroute",
				state: "staged",
				ageMs: 10 * 60_000,
				runId,
				evidenceAt,
			}),
			deliveryContractStalledCopy({
				issueId: "FLY-2278",
				family: "rework",
				stage: "received",
				recipientLiveness: "absent",
				runId,
				evidenceAt,
			}),
		];

		for (const copy of copies) {
			expect.soft(copy.body).toContain(`runId ${runId}`);
			expect.soft(copy.body).toContain(`证据戳 ${evidenceAt}`);
			expect
				.soft(copy.body)
				.toContain(`flywheel-comm hold list --run ${runId}`);
		}
	});

	it("renders a frozen delivery with threshold, liveness evidence, and the official hold gate", () => {
		expect(
			deliveryContractFrozenCopy({
				issueId: "FLY-2278",
				shape: "mailbox_inflight_slots_exhausted",
				ageMs: 30 * 60_000,
				recipientExecutionId: "exec-abcdefghijk",
				sessionStatus: "running",
				liveness: "unknown",
				heartbeatAt: null,
				lastActivityAt: null,
				recentOutboundInWindow: false,
				runId: "run-1",
				evidenceAt: "2026-09-03T17:00:00.000Z",
			}),
		).toEqual({
			title: "FLY-2278 delivery contract frozen",
			body: "FLY-2278 一份交接在「收件箱三批未读」卡了 30 分钟；收件体 exec-abc 状态 running，活性 无心跳记录（心跳 无、状态变化 无、最近出站 无）；run 已冻结。runId run-1；证据戳 2026-09-03T17:00:00.000Z；正门：`flywheel-comm hold list --run run-1`",
		});
	});

	it("renders every reroute outcome with only the decisions accepted by the hold gate", () => {
		expect(
			deliveryRerouteOutcomeCopy({
				issueId: "FLY-2278",
				outcome: "rerouted",
				targetExecutionId: "target-abcdefgh",
				rerouteCount: 2,
				runId: "run-1",
				evidenceAt: "2026-09-03T17:00:00.000Z",
			}),
		).toEqual({
			title: "FLY-2278 delivery rerouted",
			body: "FLY-2278 收件体已终结，已改派给 target-a（第 2 次）。runId run-1；证据戳 2026-09-03T17:00:00.000Z；正门：`flywheel-comm hold list --run run-1`",
		});

		const phaseWake = deliveryRerouteOutcomeCopy({
			issueId: "FLY-2278",
			outcome: "operator_required",
			family: "phase_wake",
			runHeld: true,
			liveness: "unknown",
			runId: "run-1",
			evidenceAt: "2026-09-03T17:00:00.000Z",
			holdEventUid: "delivery_reroute_operator_required:episode-1",
		});
		expect(phaseWake.body).toContain(
			"收件体已终结且 15 分钟内无后继、无活性证据(无心跳记录)，run 已冻结",
		);
		expect(phaseWake.body).toContain("--decision '<reroute_to <exec>>'");
		expect(phaseWake.body).not.toContain("cancel");

		const mailbox = deliveryRerouteOutcomeCopy({
			issueId: "FLY-2278",
			outcome: "operator_required",
			family: "mailbox",
			runHeld: true,
			liveness: "absent",
			runId: "run-2",
			evidenceAt: "2026-09-03T17:00:00.000Z",
			holdEventUid: "delivery_reroute_operator_required:episode-2",
		});
		expect(mailbox.body).toContain("--decision '<reroute_to <exec> | cancel>'");

		expect(
			deliveryRerouteOutcomeCopy({
				issueId: "FLY-2278",
				outcome: "operator_required",
				family: "mailbox",
				runHeld: false,
				rerouteCount: 2,
				runId: "run-3",
				evidenceAt: "2026-09-03T17:00:00.000Z",
				holdEventUid: "delivery_reroute_operator_required:episode-3",
			}).body,
		).toContain(
			"已自动改派 2 次仍未送达，run 未冻结，需要你确认再改派一次或取消",
		);

		expect(
			deliveryRerouteOutcomeCopy({
				issueId: "FLY-2278",
				outcome: "operator_required",
				family: "turn_wake",
				runHeld: false,
				rerouteCount: 1,
				reason: "delivery_reroute_retry_requires_operator",
				runId: "run-3",
				evidenceAt: "2026-09-03T17:00:00.000Z",
				holdEventUid: "delivery_reroute_operator_required:episode-4",
			}).body,
		).toContain(
			"自动改派失败，下一轮已把决定权交到正门，run 未冻结，需要你确认再改派一次或取消",
		);

		expect(
			deliveryRerouteOutcomeCopy({
				issueId: "FLY-2278",
				outcome: "failed",
				reason: "commdb_timeout",
				runId: "run-4",
				evidenceAt: "2026-09-03T17:00:00.000Z",
			}),
		).toEqual({
			title: "FLY-2278 delivery reroute retrying",
			body: "FLY-2278 改派未能自动完成(commdb_timeout)，run 未冻结，下一轮重试。runId run-4；证据戳 2026-09-03T17:00:00.000Z；正门：`flywheel-comm hold list --run run-4`",
		});
	});

	it("renders stalled reroute and resume operations with age and a non-holding recovery path", () => {
		expect(
			deliveryOperationStalledCopy({
				issueId: "FLY-2278",
				operationKind: "reroute",
				state: "staged",
				ageMs: 10 * 60_000,
				runId: "run-1",
				evidenceAt: "2026-09-03T16:50:00.000Z",
			}),
		).toEqual({
			title: "FLY-2278 delivery operation stalled",
			body: "FLY-2278 一次自动改派卡在 staged 超过 10 分钟，run 未冻结。runId run-1；证据戳 2026-09-03T16:50:00.000Z；正门：`flywheel-comm hold list --run run-1`。",
		});
		expect(
			deliveryOperationStalledCopy({
				issueId: "FLY-2278",
				operationKind: "hold_resume",
				state: "applied",
				ageMs: 11 * 60_000,
				runId: "run-2",
				evidenceAt: "2026-09-03T16:49:00.000Z",
			}).body,
		).toContain("一次恢复卡在 applied 超过 11 分钟");
	});

	it("appends recipient liveness to the existing rework received stall copy", () => {
		expect(
			deliveryContractStalledCopy({
				issueId: "FLY-2278",
				family: "rework",
				stage: "received",
				recipientLiveness: "absent",
				runId: "run-1",
				evidenceAt: "2026-09-03T17:00:00.000Z",
			}),
		).toEqual({
			title: "FLY-2278 delivery contract stalled",
			body: "A rework handoff has not advanced from received. 收件体活性 absent。runId run-1；证据戳 2026-09-03T17:00:00.000Z；正门：`flywheel-comm hold list --run run-1`",
		});
		expect(
			deliveryContractStalledCopy({
				issueId: "FLY-2278",
				family: "mailbox",
				stage: "sent",
				runId: "run-2",
				evidenceAt: "2026-09-03T17:00:00.000Z",
			}).body,
		).toBe(
			"A mailbox handoff has not advanced from sent.runId run-2；证据戳 2026-09-03T17:00:00.000Z；正门：`flywheel-comm hold list --run run-2`",
		);
	});

	it("renders Fable family updates as informational registry receipts", () => {
		expect(titleFor("model_family_updated")).toBe(
			"Fable model family authority updated",
		);
		expect(bodyFor("model_family_updated", "ignored")).toContain("models.json");
		expect(severityFor("model_family_updated")).toBe("info");
	});

	it("describes Discord plugin integrity failures with recovery guidance", () => {
		expect(titleFor("discord_plugin_integrity_failed")).toBe(
			"Discord plugin fork integrity failed",
		);
		expect(bodyFor("discord_plugin_integrity_failed", "ignored")).toBe(
			"A Lead could not prove the configured Discord plugin came from the Flywheel fork at the expected remote SHA. Keep that Lead stopped, repair the pointer install, then rerun the integrity check before restarting it.",
		);
	});

	it("FLY-2313 does not claim physical death in generic CommDB failure copy", () => {
		const body = bodyFor("commdb_finalize_stuck", "ignored");
		expect(body).not.toMatch(/physically gone/i);
		expect(body).toContain("atomic finalization keeps failing");
	});

	it("keeps the historical auto_qa_stuck kind but gives it neutral recovery copy", () => {
		expect(titleFor("auto_qa_stuck")).toBe("Review or ship authorization held");
		const body = bodyFor("auto_qa_stuck", "ignored");
		expect(body).toContain("authorization invariant");
		expect(body).toContain("cancel unsafe state");
		expect(body).toContain("DAG recovery and redispatch");
		expect(body).not.toMatch(/spawn|auto-QA|QA Runner/i);
	});

	it("keeps generic review failure copy neutral about the recovery path", () => {
		const body = bodyFor("review_job_failed", "ignored");
		expect(body).toBe(
			"Cross-family review failed closed. Inspect the failure reason and live bound-gate state before choosing the recovery path; obsolete or non-replayable requests require a fresh gate or request.",
		);
		expect(body).not.toMatch(/same requestId/i);
	});

	it("points Bridge deploy failures at rotating, startup, and marker evidence", () => {
		const body = bodyFor("deploy_failed", "ignored");
		expect(body).toContain("/tmp/flywheel-bridge.log");
		expect(body).toContain("bridge-startup.log");
		expect(body).toContain("bridge-log-rotation-error.json");
		expect(body).toContain("deployed-sha");
	});

	it("provides a static fail-closed fallback for meeting artifact failures", () => {
		expect(titleFor("meeting_notes_failed")).toBe("会议留痕管线故障");
		expect(bodyFor("meeting_notes_failed", "ignored")).toContain(
			"idempotent tick",
		);
		expect(bodyFor("meeting_notes_failed", "ignored")).toContain(
			"failureClass",
		);
	});

	it("renders founder-calendar wild writes as an actionable warning", () => {
		expect(titleFor("calendar_wild_write")).toBe(
			"Founder calendar write governance finding",
		);
		expect(bodyFor("calendar_wild_write", "ignored")).toContain(
			"raya_meeting_id",
		);
		expect(bodyFor("calendar_wild_write", "ignored")).toContain("FLY-2137");
		expect(severityFor("calendar_wild_write")).toBe("warning");
	});
});
