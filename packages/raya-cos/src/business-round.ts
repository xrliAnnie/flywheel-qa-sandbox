import { createHash } from "node:crypto";
import { join } from "node:path";
import { projectDailyReportArtifacts } from "./daily-report/artifacts.js";
import { recordReportFailure } from "./daily-report/failure-notice.js";
import {
	prepareReportReply,
	recordReportReply,
	reportReplyView,
} from "./daily-report/reply-round.js";
import {
	dailyReportView,
	prepareDailyReport,
	recordDailyReport,
} from "./daily-report/round.js";
import { recordReportSend } from "./daily-report/send-round.js";
import {
	associateInboundReply,
	inboundReplyView,
	prepareInboundReply,
} from "./inbound-reply.js";
import { adoptLegacyMeeting, legacyMeetingView } from "./legacy-meetings.js";
import {
	legacyQuestionView,
	recoverLegacyQuestion,
	validateLegacyQuestionPreparation,
} from "./legacy-questions.js";
import {
	prepareMeetingArchive,
	prepareMeetingStart,
	projectMeetingStart,
} from "./meeting-artifact.js";
import { meetingView, prepareMeeting, recordMeeting } from "./meeting-round.js";
import { recordMeetingVoice } from "./meeting-voice.js";
import {
	type JsonValue,
	OperationStore,
	type StoredOperation,
} from "./operation-store.js";
import {
	goalUpdateView,
	prepareGoalUpdate,
	recordGoalUpdate,
} from "./portfolio/goal-round.js";
import {
	patrolBlock,
	patrolSpecialView,
	preparePatrol,
	recordPatrol,
	resumePatrolQuestion,
} from "./portfolio/patrol-round.js";
import {
	portfolioSampleView,
	preparePortfolioSample,
	recordPortfolioSample,
	resumePortfolioSample,
} from "./portfolio/sample-round.js";
import { SnapshotStore } from "./portfolio/snapshot-store.js";
import type { PortfolioSnapshot } from "./portfolio/types.js";
import {
	hasConfirmedQuestionSend,
	observeQuestionReply,
	prepareQuestionIntent,
} from "./question-intent.js";
import {
	appendLegacyReceipt,
	prepareSummaryRound,
	projectSummaryRound,
	recordSummaryRound,
	summaryRoundView,
} from "./summary-round.js";
import {
	prepareSummary,
	recordSummary,
	summaryView,
} from "./summary-workflow.js";

type ObjectValue = { [key: string]: JsonValue };
function object(value: unknown): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("expected JSON object");
	return value as ObjectValue;
}
function text(value: unknown, label: string, max = 1024): string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new Error(`invalid ${label}`);
	return value;
}
function keys(value: ObjectValue, allowed: string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key)))
		throw new Error("unknown input field");
}
function version(value: ObjectValue): void {
	if (value.schemaVersion !== 2)
		throw new Error("unsupported business input version");
}
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const messageId = (value: unknown) =>
	typeof value === "string" && /^\d{17,20}$/.test(value);

interface AnnouncementMaterial extends ObjectValue {
	prepared: {
		tool: string;
		eventId: string;
		target: string;
		payloadDigest: string;
		payload: ObjectValue;
	};
	receipts: ObjectValue[];
}
export interface BusinessRoundView {
	schemaVersion: 2;
	operationId: string;
	revision: number;
	stage: string;
	next: { tool: string; arguments: ObjectValue } | null;
	needsReconciliation: boolean;
	nextAttemptAt?: number;
	receipts: ObjectValue[];
	material?: ObjectValue;
}

/** Produces intentions, never executes tools or authenticates supplied tool results. */
export class BusinessRound {
	private readonly store: OperationStore;
	constructor(
		private readonly workspace: string,
		private readonly now: () => number = Date.now,
	) {
		this.store = new OperationStore(workspace);
	}
	status(): { schemaVersion: 2; operations: BusinessRoundView[] } {
		return {
			schemaVersion: 2,
			operations: this.store
				.list()
				.filter(
					(operation) =>
						!["report_send_budget", "migration_backup"].includes(
							operation.kind,
						),
				)
				.map((operation) => this.view(operation)),
		};
	}

	prepare(value: unknown): BusinessRoundView {
		const input = object(value);
		version(input);
		if (input.kind === "meeting") return prepareMeeting(this.store, input);
		if (input.kind === "report_reply")
			return prepareReportReply(this.store, this.workspace, input);
		if (input.kind === "daily_report")
			return this.projectDailyReport(
				prepareDailyReport(this.store, input, this.now()),
			);
		if (input.kind === "patrol")
			return this.view(preparePatrol(this.store, this.workspace, input));
		if (input.kind === "goal_update")
			return prepareGoalUpdate(this.store, input);
		if (input.kind === "portfolio_sample")
			return this.projectPortfolio(
				preparePortfolioSample(
					this.store,
					input,
					this.now(),
					new SnapshotStore(join(this.workspace, "state")).readLatest()?.seq ??
						0,
				),
			);
		if (input.kind === "inbound_reply")
			return prepareInboundReply(this.store, input);
		if (input.kind === "summary_round")
			return prepareSummaryRound(this.store, this.workspace, input);
		if (input.kind === "summary") return prepareSummary(this.store, input);
		if (input.kind !== "question")
			keys(input, [
				"schemaVersion",
				"operationId",
				"kind",
				"sourceRefs",
				"target",
				"text",
				"eventId",
			]);
		const operationId = text(input.operationId, "operation identity");
		if (input.kind !== "announcement" && input.kind !== "question")
			throw new Error("unsupported business kind");
		if (
			input.kind === "announcement" &&
			input.target !== "chat" &&
			input.target !== "roundtable"
		)
			throw new Error("invalid target");
		if (!Array.isArray(input.sourceRefs) || !input.sourceRefs.length)
			throw new Error("source references required");
		const sourceRefs = input.sourceRefs.map((ref) =>
			text(ref, "source reference"),
		);
		if (input.kind === "question")
			validateLegacyQuestionPreparation(this.store, input);
		const directed =
			input.kind === "question"
				? prepareQuestionIntent(input, this.now())
				: undefined;
		const summaries = directed
			? sourceRefs
					.map((ref) => this.store.read(ref))
					.filter((op) => op?.kind === "summary")
			: [];
		if (summaries.length > 1)
			throw new Error("a summary question must aggregate exactly one PR");
		const summary = summaries[0]
			? object(object(summaries[0].material).snapshot)
			: undefined;
		if (
			summary &&
			(object(directed?.question.to).project !== summary.project ||
				object(directed?.question.to).leadId !== summary.lead)
		)
			throw new Error("summary question recipient mismatch");
		const payload = directed?.payload ?? {
			target: input.target,
			text: text(input.text, "announcement text", 1800),
			eventId: text(input.eventId, "event identity", 200),
		};
		const inputDigest = hash({
			operationId,
			kind: input.kind,
			sourceRefs,
			payload,
			...(directed
				? { question: { ...directed.question, preparedAt: undefined } }
				: {}),
		});
		const current = this.store.read(operationId);
		if (current) {
			if (current.inputDigest !== inputDigest || current.kind !== input.kind)
				throw new Error("operation input binding conflict");
			return this.resume(operationId);
		}
		if (directed && Number(directed.question.expiresAt) <= this.now())
			throw new Error("question expiry must be in the future");
		const created = this.store.commit(
			{
				operationId,
				inputDigest,
				kind: input.kind,
				stage: summary ? "registering" : "prepared",
				sourceRefs,
				material: {
					prepared: {
						tool: "lead_actions.discord_send",
						eventId: payload.eventId,
						target: payload.target,
						payloadDigest: hash(payload),
						payload,
					},
					receipts: [],
					...(directed ? { question: directed.question } : {}),
					...(summary
						? { summary: { roundId: summary.roundId, pr: summary.pr } }
						: {}),
				},
			},
			0,
		);
		return this.resume(created.operationId);
	}
	resume(operationId: string): BusinessRoundView {
		let current = this.store.read(operationId);
		if (!current) throw new Error("unknown operation");
		if (current.kind === "meeting")
			current = projectMeetingStart(this.store, this.workspace, current);
		if (current.kind === "daily_report")
			current = projectDailyReportArtifacts(
				this.store,
				this.workspace,
				current,
			);
		if (current.kind === "patrol")
			current = resumePatrolQuestion(this.store, current);
		if (current.kind === "portfolio_sample")
			return this.projectPortfolio(
				resumePortfolioSample(this.store, current, this.now()),
			);
		if (current.kind === "summary_round")
			current = projectSummaryRound(this.store, this.workspace, current);
		if (current.kind === "question")
			current = this.projectSummaryQuestion(current);
		if (
			current.kind === "question" &&
			!["answered", "cancelled", "expired", "unknown"].includes(
				current.stage,
			) &&
			Number(object(this.material(current).question).expiresAt) < this.now()
		) {
			return this.view(
				this.store.commit({ ...current, stage: "expired" }, current.revision),
			);
		}
		return this.view(current);
	}
	record(value: unknown): BusinessRoundView {
		const input = object(value);
		version(input);
		keys(input, [
			"schemaVersion",
			"operationId",
			"expectedRevision",
			"tool",
			"callId",
			"result",
		]);
		const current = this.store.read(
			text(input.operationId, "operation identity"),
		);
		if (!current) throw new Error("unknown operation");
		if (current.revision !== input.expectedRevision)
			throw new Error("operation revision conflict");
		if (current.kind === "legacy_meeting")
			return this.view(
				adoptLegacyMeeting(this.store, this.workspace, current, input),
			);
		if (current.kind === "legacy_question")
			return this.view(
				recoverLegacyQuestion(this.store, current, input, this.now()),
			);
		if (
			current.kind === "meeting" &&
			input.tool === "current_turn" &&
			object(input.result).action === "begin_start"
		) {
			const started = prepareMeetingStart(
				this.store,
				this.workspace,
				current,
				input,
				this.now(),
			);
			return meetingView(
				projectMeetingStart(this.store, this.workspace, started),
			);
		}
		if (
			current.kind === "meeting" &&
			input.tool === "current_turn" &&
			["begin_voice_start", "begin_voice_stop", "voice_result"].includes(
				String(object(input.result).action),
			)
		)
			return recordMeetingVoice(
				this.store,
				this.workspace,
				current,
				input,
				this.now(),
			);
		if (
			current.kind === "meeting" &&
			input.tool === "current_turn" &&
			object(input.result).action === "archive_terminal"
		)
			return meetingView(
				projectMeetingStart(
					this.store,
					this.workspace,
					prepareMeetingArchive(
						this.store,
						this.workspace,
						current,
						input,
						this.now(),
					),
				),
			);
		if (current.kind === "meeting")
			return recordMeeting(this.store, current, input, this.now());
		if (
			current.kind === "daily_report" &&
			input.tool === "current_turn" &&
			["failure", "confirm_failure_notice"].includes(
				String(object(input.result).action),
			)
		)
			return recordReportFailure(this.store, current, input, this.now());
		if (current.kind === "report_reply")
			return recordReportReply(this.store, current, input);
		if (
			current.kind === "daily_report" &&
			(input.tool === "lead_actions.discord_send" ||
				object(input.result).action === "begin_send")
		) {
			const verified = projectDailyReportArtifacts(
				this.store,
				this.workspace,
				current,
			);
			if (verified.revision !== current.revision)
				throw new Error("report artifacts updated; resume before sending");
			return recordReportSend(this.store, current, input, this.now());
		}
		if (current.kind === "daily_report")
			return this.projectDailyReport(
				recordDailyReport(this.store, current, input, this.now()),
			);
		if (current.kind === "patrol" && input.tool === "current_turn")
			return this.view(
				recordPatrol(this.store, this.workspace, current, input, this.now()),
			);
		if (current.kind === "goal_update")
			return recordGoalUpdate(this.store, current, input);
		if (current.kind === "portfolio_sample")
			return this.projectPortfolio(
				recordPortfolioSample(this.store, current, input, this.now()),
			);
		if (current.kind === "inbound_reply")
			return associateInboundReply(this.store, current, input, (value) =>
				this.record(value),
			);
		if (current.kind === "summary_round")
			return recordSummaryRound(this.store, this.workspace, current, input);
		if (current.kind === "summary")
			return recordSummary(this.store, current, input);
		if (["complete", "answered", "cancelled"].includes(current.stage))
			throw new Error("operation already complete");
		const material = this.material(current);

		if (current.kind === "question" && input.tool === "business_decision") {
			const result = object(input.result);
			keys(result, ["action", "reason", "sourceRef"]);
			if (result.action !== "cancel")
				throw new Error("unsupported question decision");
			text(result.reason, "cancellation reason");
			text(result.sourceRef, "cancellation source");
			return this.view(
				this.store.commit(
					{
						...current,
						stage: "cancelled",
						material: {
							...material,
							receipts: [
								...material.receipts,
								{
									tool: input.tool,
									callId: text(input.callId, "decision identity"),
									result,
								},
							],
						},
					},
					current.revision,
				),
			);
		}
		if (current.kind === "question" && input.tool === "lead_inbound") {
			if (!["awaiting_reply", "expired"].includes(current.stage))
				throw new Error("question is not awaiting a reply");
			const result = object(input.result);
			const observation = observeQuestionReply(
				object(material.question),
				material,
				result,
			);
			const updated = {
				...material,
				receipts: [
					...material.receipts,
					{
						tool: input.tool,
						callId: text(input.callId, "inbound identity"),
						result,
						late: observation.late,
					},
				],
			};
			return this.view(
				this.store.commit(
					{
						...current,
						stage:
							observation.late || current.stage === "expired"
								? "expired"
								: "answered",
						material: updated,
					},
					current.revision,
				),
			);
		}
		if (
			current.kind === "question" &&
			["awaiting_reply", "expired"].includes(current.stage)
		)
			throw new Error("question no longer needs a send result");
		if (input.tool !== material.prepared.tool)
			throw new Error("tool binding mismatch");
		const callId = text(input.callId, "tool call identity");
		const result = object(input.result);
		if (
			result.project !== "raya" ||
			result.leadId !== "raya" ||
			result.target !== material.prepared.target ||
			result.eventId !== material.prepared.eventId
		)
			throw new Error("receipt binding mismatch");
		if (
			![
				"sent",
				"pending",
				"ambiguous",
				"unavailable",
				"rejected",
				"rate_limited",
			].includes(String(result.status))
		)
			throw new Error("invalid receipt status");
		if (result.messageId !== undefined && !messageId(result.messageId))
			throw new Error("invalid message receipt");
		if (
			material.messageId !== undefined &&
			result.messageId !== undefined &&
			material.messageId !== result.messageId
		)
			throw new Error("message receipt changed");
		if (
			material.channelId !== undefined &&
			result.channelId !== undefined &&
			material.channelId !== result.channelId
		)
			throw new Error("channel receipt changed");
		if (
			current.kind === "question" &&
			result.channelId !== undefined &&
			result.channelId !== object(material.question).parentChannelId
		)
			throw new Error("question parent channel mismatch");
		if (result.status === "sent" || result.sendStatus === "sent") {
			if (!messageId(result.messageId) || !messageId(result.channelId))
				throw new Error("sent receipt requires message and channel");
		}
		if (
			result.status === "sent" &&
			material.prepared.target === "roundtable" &&
			(result.engagement !== "ready" || result.threadId !== result.messageId)
		)
			throw new Error("roundtable receipt requires ready engagement");
		let nextAttemptAt: number | undefined;
		if (result.status === "rate_limited") {
			if (
				typeof result.retryAfterMs !== "number" ||
				!Number.isSafeInteger(result.retryAfterMs) ||
				result.retryAfterMs <= 0
			)
				throw new Error("invalid retry deadline");
			nextAttemptAt = this.now() + result.retryAfterMs;
			if (!Number.isSafeInteger(nextAttemptAt))
				throw new Error("invalid retry deadline");
		}
		// An unknown send may only advance with positive evidence; transient failures do not erase it.
		const stage =
			result.status === "sent"
				? current.kind === "question"
					? "awaiting_reply"
					: "complete"
				: result.status === "ambiguous" || current.stage === "unknown"
					? "unknown"
					: current.kind === "question" &&
							(result.sendStatus === "sent" || material.messageId !== undefined)
						? "sent"
						: "pending";
		const updated: AnnouncementMaterial = {
			...material,
			receipts: [...material.receipts, { tool: input.tool, callId, result }],
		};
		delete updated.nextAttemptAt;
		if (nextAttemptAt !== undefined) updated.nextAttemptAt = nextAttemptAt;
		if (result.messageId !== undefined) updated.messageId = result.messageId;
		if (result.channelId !== undefined) updated.channelId = result.channelId;
		const stored = this.store.commit(
			{ ...current, stage, material: updated },
			current.revision,
		);
		return this.resume(stored.operationId);
	}
	private projectPortfolio(view: BusinessRoundView): BusinessRoundView {
		if (view.stage !== "complete" || view.material?.snapshotProjected === true)
			return view;
		const current = this.store.read(view.operationId);
		if (!current) throw new Error("missing frozen portfolio snapshot");
		const material = object(current.material);
		new SnapshotStore(join(this.workspace, "state")).write(
			material.snapshot as unknown as PortfolioSnapshot,
		);
		return portfolioSampleView(
			this.store.commit(
				{ ...current, material: { ...material, snapshotProjected: true } },
				current.revision,
			),
		);
	}
	private projectSummaryQuestion(current: StoredOperation): StoredOperation {
		const material = this.material(current);
		if (!material.summary) return current;
		const summary = object(material.summary),
			question = object(material.question);
		const binding = {
			type: "question",
			roundId: summary.roundId,
			pr: summary.pr,
			eventId: material.prepared.eventId,
			payloadDigest: material.prepared.payloadDigest,
			requestId: question.requestId,
			requestRevision: question.requestRevision,
		};
		if (current.stage === "registering") {
			const ready = appendLegacyReceipt(this.workspace, {
				...binding,
				status: "posting",
			});
			return this.store.commit(
				{ ...current, stage: ready ? "prepared" : "unknown" },
				current.revision,
			);
		}
		if (hasConfirmedQuestionSend(material))
			appendLegacyReceipt(this.workspace, {
				...binding,
				status: "posted",
				messageId: material.messageId,
				channelId: material.channelId,
			});
		return current;
	}
	private projectDailyReport(view: BusinessRoundView): BusinessRoundView {
		const current = this.store.read(view.operationId);
		if (!current) throw new Error("missing daily report operation");
		return dailyReportView(
			projectDailyReportArtifacts(this.store, this.workspace, current),
			this.now(),
		);
	}
	private material(operation: StoredOperation): AnnouncementMaterial {
		if (
			operation.kind !== "announcement" &&
			operation.kind !== "question" &&
			operation.kind !== "patrol"
		)
			throw new Error("unsupported stored operation");
		const material = object(operation.material);
		const prepared = object(material.prepared);
		const payload = object(prepared.payload);
		if (
			prepared.tool !== "lead_actions.discord_send" ||
			prepared.payloadDigest !== hash(payload) ||
			prepared.eventId !== payload.eventId ||
			prepared.target !== payload.target ||
			!Array.isArray(material.receipts)
		)
			throw new Error("corrupt prepared operation");
		return material as AnnouncementMaterial;
	}
	private view(operation: StoredOperation): BusinessRoundView {
		if (operation.kind === "legacy_meeting")
			return legacyMeetingView(operation, this.store);
		if (operation.kind === "legacy_question")
			return legacyQuestionView(operation, this.store);
		if (operation.kind === "meeting") return meetingView(operation);
		if (operation.kind === "report_reply") return reportReplyView(operation);
		if (operation.kind === "daily_report")
			return dailyReportView(operation, this.now());
		if (operation.kind === "patrol" && !object(operation.material).prepared)
			return patrolSpecialView(operation, this.store);
		if (operation.kind === "goal_update") return goalUpdateView(operation);
		if (operation.kind === "portfolio_sample")
			return portfolioSampleView(operation);
		if (operation.kind === "inbound_reply") return inboundReplyView(operation);
		if (operation.kind === "summary_round") return summaryRoundView(operation);
		if (operation.kind === "summary") return summaryView(operation);
		const material = this.material(operation);
		const nextAttemptAt =
			typeof material.nextAttemptAt === "number"
				? material.nextAttemptAt
				: undefined;
		const needsReconciliation = operation.stage === "unknown";
		const publishBlocked =
			operation.kind === "patrol" && operation.stage !== "complete"
				? patrolBlock(
						this.workspace,
						operation,
						this.now(),
						String(object(material.decision).text),
					)
				: null;
		return {
			schemaVersion: 2,
			operationId: operation.operationId,
			revision: operation.revision,
			stage: operation.stage,
			next:
				[
					"complete",
					"registering",
					"awaiting_reply",
					"answered",
					"expired",
					"cancelled",
				].includes(operation.stage) ||
				needsReconciliation ||
				!!publishBlocked ||
				(nextAttemptAt !== undefined && nextAttemptAt > this.now())
					? null
					: {
							tool: material.prepared.tool,
							arguments: material.prepared.payload,
						},
			needsReconciliation,
			...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
			receipts: material.receipts,
			...(operation.kind === "patrol"
				? {
						material: {
							...material,
							...(publishBlocked ? { publishBlocked } : {}),
						},
					}
				: {}),
		};
	}
}
