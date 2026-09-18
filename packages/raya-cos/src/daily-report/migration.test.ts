import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { planDailyReportMigration } from "./migration.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fixture(status: string) {
	const root = mkdtempSync(join(tmpdir(), "report-migration-"));
	roots.push(root);
	const dir = join(root, "state/daily-report");
	mkdirSync(dir, { recursive: true });
	const body = "事实与判断",
		bodySha256 = createHash("sha256").update(body).digest("hex");
	const bodyFile = `2026-09-08.body.${bodySha256}.md`;
	const state = {
		v: 1,
		date: "2026-09-08",
		status,
		bodyFile,
		bodySha256,
		bodyBytes: Buffer.byteLength(body),
	};
	writeFileSync(join(dir, bodyFile), body);
	writeFileSync(join(dir, "2026-09-08.json"), JSON.stringify(state));
	return { root, dir, state };
}
it.each([
	["generated", "reconcile_repository"],
	["file_written", "reconcile_repository"],
	["ingesting", "reconcile_context"],
	["ingested", "reconcile_context"],
	["posting", "reconcile_delivery"],
	["posted_unknown", "reconcile_delivery"],
	["recovered_unknown", "reconcile_delivery"],
	["posted", "preserve_posted"],
])("plans %s without old driver or inferred success", (status, action) => {
	const { root, dir } = fixture(status);
	const before = readFileSync(join(dir, "2026-09-08.json"), "utf8");
	const plan = planDailyReportMigration(root);
	expect(plan.entries[0]).toMatchObject({
		date: "2026-09-08",
		action,
		bodyVerified: true,
	});
	expect(readFileSync(join(dir, "2026-09-08.json"), "utf8")).toBe(before);
	expect(readdirSync(dir)).toHaveLength(2);
});
it("keeps corrupt and unknown schema files visible without changing them", () => {
	const { root, dir } = fixture("posted");
	writeFileSync(join(dir, "2026-09-08.json"), '{"v":77}');
	const plan = planDailyReportMigration(root);
	expect(plan.entries[0]).toMatchObject({ action: "quarantine_required" });
	expect(readFileSync(join(dir, "2026-09-08.json"), "utf8")).toBe('{"v":77}');
});
it("refuses missing or changed body evidence", () => {
	const { root, dir, state } = fixture("ingested");
	writeFileSync(join(dir, state.bodyFile), "changed");
	expect(planDailyReportMigration(root).entries[0]).toMatchObject({
		action: "quarantine_required",
		bodyVerified: false,
	});
});
it("rejects symlinked state roots", () => {
	const { root, dir } = fixture("posted");
	rmSync(dir, { recursive: true });
	symlinkSync(tmpdir(), dir);
	expect(() => planDailyReportMigration(root)).toThrow(/symlink|unsafe/);
});

it("backs up exact legacy evidence before reserving its date and preserves replay identity", async () => {
	const { root, dir } = fixture("posted");
	const { applyDailyReportMigration } = await import("./migration.js");
	const { BusinessRound } = await import("../business-round.js");
	const plan = planDailyReportMigration(root);
	const identity = { flywheelSha: "a".repeat(40), rayaSha: "b".repeat(40) };
	const result = applyDailyReportMigration(root, plan.digest, identity);
	expect(result.imported).toEqual(["daily-report:2026-09-08"]);
	expect(
		new BusinessRound(root).resume("daily-report:2026-09-08"),
	).toMatchObject({ stage: "posted", next: null });
	expect(applyDailyReportMigration(root, plan.digest, identity)).toEqual(
		result,
	);
	expect(readFileSync(join(dir, "2026-09-08.json"), "utf8")).toContain(
		'"status":"posted"',
	);
});
it("rejects a changed inventory before reserving any date", async () => {
	const { root, dir } = fixture("posting");
	const { applyDailyReportMigration } = await import("./migration.js");
	const plan = planDailyReportMigration(root);
	writeFileSync(join(dir, "2026-09-08.json"), "{}");
	expect(() =>
		applyDailyReportMigration(root, plan.digest, {
			flywheelSha: "a".repeat(40),
			rayaSha: "b".repeat(40),
		}),
	).toThrow(/changed/);
});

it("reserves uncertain delivery without offering a resend and keeps exact backup bytes", async () => {
	const { root, dir } = fixture("posting");
	const { applyDailyReportMigration } = await import("./migration.js");
	const { BusinessRound } = await import("../business-round.js");
	const { OperationStore } = await import("../operation-store.js");
	const raw = readFileSync(join(dir, "2026-09-08.json"), "utf8"),
		plan = planDailyReportMigration(root);
	applyDailyReportMigration(root, plan.digest, {
		flywheelSha: "a".repeat(40),
		rayaSha: "b".repeat(40),
	});
	const v = new BusinessRound(root).resume("daily-report:2026-09-08");
	expect(v).toMatchObject({
		stage: "legacy_reconciliation",
		needsReconciliation: true,
		next: {
			arguments: {
				action: "reconcile_legacy_report",
				recovery: "reconcile_delivery",
			},
		},
	});
	const store = new OperationStore(root);
	const backup = store.read(String(v.next?.arguments.backupId));
	expect(backup?.material).toMatchObject({
		rawState: raw,
		rawBody: "事实与判断",
	});
	expect(new BusinessRound(root).status().operations).toHaveLength(1);
});

it.each([
	["ingested", "context_ready"],
	["ingested_unknown", "send_unknown"],
	["posting", "send_unknown"],
	["posted", "posted"],
])(
	"reconciles %s from exact repository evidence without upgrading delivery",
	async (status, stage) => {
		const {
			root,
			dir,
			state: oldState,
		} = fixture(status === "ingested_unknown" ? "ingested" : status);
		if (status === "posting")
			writeFileSync(
				join(dir, "2026-09-08.json"),
				JSON.stringify({
					...oldState,
					chunkPlan: {
						catchUp: false,
						chunks: [
							{
								index: 0,
								kind: "body",
								sha256: createHash("sha256").update("事实与判断").digest("hex"),
							},
						],
					},
					messageIds: { "0": "111111111111111111" },
				}),
			);
		if (status === "ingested_unknown")
			writeFileSync(
				join(dir, "2026-09-08.json"),
				JSON.stringify({ ...oldState, receipts: "unknown" }),
			);
		const { applyDailyReportMigration } = await import("./migration.js");
		const { BusinessRound } = await import("../business-round.js");
		const { serializeReportDocument } = await import(
			"../contracts/daily-report.js"
		);
		const { reportBlob } = await import("./repository-round.js");
		applyDailyReportMigration(root, planDailyReportMigration(root).digest, {
			flywheelSha: "a".repeat(40),
			rayaSha: "b".repeat(40),
		});
		const round = new BusinessRound(root);
		const v = round.resume("daily-report:2026-09-08");
		const document = serializeReportDocument(
			{
				issue: "FLY-2380",
				date: "2026-09-08",
				timezone: "America/Los_Angeles",
				generated_at: "2026-09-09T01:00:00Z",
				generation_turn_key: "daily-report:2026-09-08:gen:1",
				main_commit: "a".repeat(40),
				sources: [],
				silent: [],
			},
			"## 今天各项目发生了什么\n进度已核对。\n## 我的判断\n明天继续确认。",
		);
		const result = {
			action: "reconcile_legacy_repository",
			repo: "xrliAnnie/raya",
			ref: "main",
			path: "reports/2026-09-08.md",
			status: "exists",
			document,
			fileSha: reportBlob(document),
		};
		const call = (r: object) =>
			round.record({
				schemaVersion: 2,
				operationId: v.operationId,
				expectedRevision: v.revision,
				tool: "current_turn",
				callId: "repo-read",
				result: r,
			});
		expect(() => call({ ...result, fileSha: "f".repeat(40) })).toThrow(/blob/);
		expect(call(result).stage).toBe(stage);
		expect(round.resume(v.operationId).stage).toBe(stage);
		if (status === "posting") {
			const current = round.resume(v.operationId);
			const result = {
				action: "reconcile_legacy_delivery",
				index: 0,
				identity: {
					project: "raya",
					leadId: "raya",
					botUserId: "333333333333333333",
					channelId: "222222222222222222",
				},
				message: {
					id: "111111111111111111",
					channel_id: "222222222222222222",
					author: { id: "333333333333333333", bot: true },
					content: "事实与判断",
				},
			};
			const observe = (r: object) =>
				round.record({
					schemaVersion: 2,
					operationId: current.operationId,
					expectedRevision: current.revision,
					tool: "current_turn",
					callId: "actual-message-read",
					result: r,
				});
			expect(() =>
				observe({
					...result,
					message: { ...result.message, content: "changed" },
				}),
			).toThrow(/content/);
			expect(() =>
				observe({
					...result,
					message: {
						...result.message,
						author: { id: "444444444444444444", bot: true },
					},
				}),
			).toThrow(/identity/);
			expect(observe(result).stage).toBe("posted");
			const reply = round.prepare({
				schemaVersion: 2,
				kind: "report_reply",
				founderUserId: "777777777777777777",
				source: {
					messageId: "555555555555555555",
					channelId: "222222222222222222",
					authorId: "777777777777777777",
					body: "补充判断",
					observedAt: Date.now() + 1000,
					replyTo: {
						messageId: "111111111111111111",
						channelId: "222222222222222222",
					},
				},
			});
			expect(reply.stage).toBe("awaiting_report_read");
		}
	},
);

it("uses original nonce and waits for every legacy chunk", async () => {
	const { reconcileLegacyDelivery } = await import("./legacy-recovery.js");
	const sha = (s: string) => createHash("sha256").update(s).digest("hex");
	const fileSha = "a".repeat(40),
		date = "2026-09-08";
	const material = {
		fileSha,
		legacyMigration: {
			date,
			repositoryConfirmed: true,
			state: {
				chunkPlan: {
					chunks: [
						{ index: 0, kind: "title", sha256: sha("title") },
						{ index: 1, kind: "body", sha256: sha("body") },
					],
				},
			},
		},
	};
	const identity = {
		project: "raya",
		leadId: "raya",
		botUserId: "333333333333333333",
		channelId: "222222222222222222",
	};
	const message = {
		id: "111111111111111111",
		channel_id: identity.channelId,
		author: { id: identity.botUserId, bot: true },
		content: "title",
		nonce: sha(`daily-report:${date}:${fileSha}:title:0`).slice(0, 25),
	};
	const result = {
		action: "reconcile_legacy_delivery",
		index: 0,
		identity,
		message,
	};
	expect(() =>
		reconcileLegacyDelivery(
			"send_unknown",
			material,
			{ ...result, message: { ...message, nonce: "wrong" } },
			10,
		),
	).toThrow(/identity/);
	const partial = reconcileLegacyDelivery("send_unknown", material, result, 10);
	expect(partial.stage).toBe("send_unknown");
	const done = reconcileLegacyDelivery(
		partial.stage,
		partial.material,
		{
			...result,
			index: 1,
			message: {
				...message,
				id: "444444444444444444",
				content: "body",
				nonce: sha(`daily-report:${date}:${fileSha}:body:1`).slice(0, 25),
			},
		},
		20,
	);
	expect(done.stage).toBe("posted");
});

it("recovers a generated draft only after absence evidence, preserving backed-up body", async () => {
	const { root, dir, state } = fixture("generated");
	const body = "## 今天各项目发生了什么\n原始事实。\n## 我的判断\n原始判断。",
		bodySha256 = createHash("sha256").update(body).digest("hex"),
		bodyFile = `2026-09-08.body.${bodySha256}.md`;
	writeFileSync(join(dir, bodyFile), body);
	writeFileSync(
		join(dir, "2026-09-08.json"),
		JSON.stringify({
			...state,
			bodyFile,
			bodySha256,
			bodyBytes: Buffer.byteLength(body),
			mainCommit: "a".repeat(40),
			sources: [],
			silent: [],
			generationTurnKey: "daily-report:2026-09-08:gen:1",
		}),
	);
	const { applyDailyReportMigration } = await import("./migration.js");
	const { BusinessRound } = await import("../business-round.js");
	applyDailyReportMigration(root, planDailyReportMigration(root).digest, {
		flywheelSha: "a".repeat(40),
		rayaSha: "b".repeat(40),
	});
	const round = new BusinessRound(root);
	let v = round.resume("daily-report:2026-09-08");
	const record = (result: object) => {
		v = round.record({
			schemaVersion: 2,
			operationId: v.operationId,
			expectedRevision: v.revision,
			tool: "current_turn",
			callId: String(v.revision),
			result,
		});
		return v;
	};
	expect(() =>
		record({ action: "recover_legacy_draft", timezone: "America/Los_Angeles" }),
	).toThrow();
	record({
		action: "reconcile_legacy_repository",
		repo: "xrliAnnie/raya",
		ref: "main",
		path: "reports/2026-09-08.md",
		status: "absent",
	});
	const recovered = record({
		action: "recover_legacy_draft",
		timezone: "America/Los_Angeles",
	});
	expect(recovered).toMatchObject({
		stage: "generated",
		material: { body },
		next: { arguments: { action: "probe_report" } },
	});
	expect(round.resume(v.operationId).stage).toBe("generated");
	record({
		action: "probe",
		repo: "xrliAnnie/raya",
		ref: "main",
		path: "reports/2026-09-08.md",
		status: "absent",
	});
	expect(v.next?.arguments.action).toBe("create_report");
	const { reportBlob } = await import("./repository-round.js");
	record({
		action: "create",
		repo: "xrliAnnie/raya",
		ref: "main",
		path: "reports/2026-09-08.md",
		status: "created",
		fileSha: reportBlob(String(v.material?.document)),
	});
	expect(v.stage).toBe("context_ready");
});

it("resumes an ungenerated original date only after absence and a matching valid wake", async () => {
	const { root, dir } = fixture("generating");
	writeFileSync(
		join(dir, "2026-09-08.json"),
		JSON.stringify({ v: 1, date: "2026-09-08", status: "generating" }),
	);
	const { applyDailyReportMigration } = await import("./migration.js");
	const { BusinessRound } = await import("../business-round.js");
	applyDailyReportMigration(root, planDailyReportMigration(root).digest, {
		flywheelSha: "a".repeat(40),
		rayaSha: "b".repeat(40),
	});
	const round = new BusinessRound(root);
	const input = {
		schemaVersion: 2,
		kind: "daily_report",
		sourceRefs: ["original-wake"],
		wake: {
			scheduleId: "daily-report",
			revision: 1,
			configDigest: "a".repeat(64),
			localDate: "2026-09-08",
			dueAt: "2026-09-09T01:00:00Z",
			timezone: "America/Los_Angeles",
		},
	};
	let v = round.prepare(input);
	expect(v.stage).toBe("legacy_reconciliation");
	round.record({
		schemaVersion: 2,
		operationId: v.operationId,
		expectedRevision: v.revision,
		tool: "current_turn",
		callId: "absent-proof",
		result: {
			action: "reconcile_legacy_repository",
			repo: "xrliAnnie/raya",
			ref: "main",
			path: "reports/2026-09-08.md",
			status: "absent",
		},
	});
	v = round.prepare(input);
	expect(v).toMatchObject({
		operationId: "daily-report:2026-09-08",
		stage: "prepared",
		next: { arguments: { action: "collect_report_sources" } },
	});
	expect(round.prepare(input).revision).toBe(v.revision);
});
it("preserves terminal failed state during import", async () => {
	const { root } = fixture("failed");
	const { applyDailyReportMigration } = await import("./migration.js");
	const { BusinessRound } = await import("../business-round.js");
	applyDailyReportMigration(root, planDailyReportMigration(root).digest, {
		flywheelSha: "a".repeat(40),
		rayaSha: "b".repeat(40),
	});
	expect(
		new BusinessRound(root).resume("daily-report:2026-09-08"),
	).toMatchObject({ stage: "failed", next: null, needsReconciliation: false });
});

it("settles an old failure notice only from its exact message evidence", async () => {
	const { root, dir } = fixture("failed_pending_notice");
	writeFileSync(
		join(dir, "2026-09-08.json"),
		JSON.stringify({
			v: 1,
			date: "2026-09-08",
			status: "failed_pending_notice",
			failStage: "generate",
			failCategory: "text_chat_unavailable",
			failedNotice: { attempts: 1, inFlight: { sentAt: 1 } },
		}),
	);
	const { applyDailyReportMigration } = await import("./migration.js");
	const { BusinessRound } = await import("../business-round.js");
	applyDailyReportMigration(root, planDailyReportMigration(root).digest, {
		flywheelSha: "a".repeat(40),
		rayaSha: "b".repeat(40),
	});
	const round = new BusinessRound(root),
		v = round.resume("daily-report:2026-09-08");
	const nonce = createHash("sha256")
		.update(`daily-report:2026-09-08:${"0".repeat(40)}:notice:0`)
		.digest("hex")
		.slice(0, 25);
	const result = {
		action: "reconcile_legacy_failure_notice",
		identity: {
			project: "raya",
			leadId: "raya",
			botUserId: "333333333333333333",
			channelId: "222222222222222222",
		},
		message: {
			id: "111111111111111111",
			channel_id: "222222222222222222",
			nonce,
			author: { id: "333333333333333333", bot: true },
			content: "⚠️ 今天的 Report 没生成：text_chat_unavailable",
		},
	};
	const record = (r: object) =>
		round.record({
			schemaVersion: 2,
			operationId: v.operationId,
			expectedRevision: v.revision,
			tool: "current_turn",
			callId: "notice-read",
			result: r,
		});
	expect(() =>
		record({ ...result, message: { ...result.message, nonce: "foreign" } }),
	).toThrow();
	expect(record(result)).toMatchObject({
		stage: "failed",
		next: null,
		material: { legacyFailureNotice: { messageId: "111111111111111111" } },
	});
});

it("prepares an unattempted legacy notice once and refuses an ambiguous prior attempt", async () => {
	const { prepareLegacyNotice } = await import("./legacy-notice.js");
	const state = {
		date: "2026-09-08",
		status: "failed_pending_notice",
		failStage: "generate",
		failCategory: "unavailable",
	};
	const material = { legacyMigration: { state }, receipts: [] };
	const prepared = prepareLegacyNotice("legacy_reconciliation", material, {
		action: "prepare_legacy_failure_notice",
	});
	expect(prepared.material.failureNotice).toMatchObject({
		status: "pending",
		input: {
			operationId: "report-notice:2026-09-08",
			text: "⚠️ 今天的 Report 没生成：unavailable",
		},
	});
	expect(
		prepareLegacyNotice(prepared.stage, prepared.material, {
			action: "prepare_legacy_failure_notice",
		}),
	).toEqual(prepared);
	expect(() =>
		prepareLegacyNotice(
			"legacy_reconciliation",
			{
				...material,
				legacyMigration: {
					state: {
						...state,
						failedNotice: { attempts: 1, inFlight: { sentAt: 1 } },
					},
				},
			},
			{ action: "prepare_legacy_failure_notice" },
		),
	).toThrow(/attempt/);
});

it("finishes an unattempted legacy failure notice through the standard announcement receipt", async () => {
	const { root, dir } = fixture("failed_pending_notice");
	writeFileSync(
		join(dir, "2026-09-08.json"),
		JSON.stringify({
			v: 1,
			date: "2026-09-08",
			status: "failed_pending_notice",
			failStage: "generate",
			failCategory: "unavailable",
		}),
	);
	const { applyDailyReportMigration } = await import("./migration.js");
	const { BusinessRound } = await import("../business-round.js");
	applyDailyReportMigration(root, planDailyReportMigration(root).digest, {
		flywheelSha: "a".repeat(40),
		rayaSha: "b".repeat(40),
	});
	const round = new BusinessRound(root);
	let v = round.resume("daily-report:2026-09-08");
	const record = (result: object) => {
		v = round.record({
			schemaVersion: 2,
			operationId: v.operationId,
			expectedRevision: v.revision,
			tool: "current_turn",
			callId: String(v.revision),
			result,
		});
		return v;
	};
	record({ action: "prepare_legacy_failure_notice" });
	const input = v.next?.arguments.input as Record<string, unknown>;
	const notice = round.prepare(input);
	expect(() =>
		record({
			action: "confirm_failure_notice",
			noticeOperationId: notice.operationId,
		}),
	).toThrow(/confirmed/);
	round.record({
		schemaVersion: 2,
		operationId: notice.operationId,
		expectedRevision: notice.revision,
		tool: "lead_actions.discord_send",
		callId: "sent",
		result: {
			status: "sent",
			project: "raya",
			leadId: "raya",
			target: "chat",
			eventId: input.eventId,
			messageId: "111111111111111111",
			channelId: "222222222222222222",
		},
	});
	expect(
		record({
			action: "confirm_failure_notice",
			noticeOperationId: notice.operationId,
		}),
	).toMatchObject({ stage: "failed", next: null });
});
