import { CommDB } from "flywheel-comm/db";
import {
	getProcessStart,
	type MessageProvenance,
} from "flywheel-comm/lead-lease";
import { isMailboxTerminalStatus } from "flywheel-comm/session-terminal";
import type {
	ReviewRecoveryNotice,
	ReviewRecoveryNoticeBinding,
	Session,
	StateStore,
} from "../StateStore.js";

export interface ReviewRecoveryNoticeSinkOptions {
	store: StateStore;
	commDbPathFor: (projectName: string) => string;
	resolveOwningLead: (session: Session) => string | undefined;
	provenance?: () => MessageProvenance;
	markerDir?: string;
}

function binding(notice: ReviewRecoveryNotice): ReviewRecoveryNoticeBinding {
	return {
		requestId: notice.request_id,
		attemptGeneration: notice.attempt_generation,
		stage: notice.stage,
		questionId: notice.question_id,
		executionId: notice.execution_id,
		projectName: notice.project_name,
	};
}

function noticeId(notice: ReviewRecoveryNotice): string {
	return `review-recovery:${notice.request_id}:${notice.attempt_generation}:${notice.stage}`;
}

function utcStamp(value: string): string {
	// StateStore also stamps SQLite UTC datetime text, which lacks a zone suffix.
	return new Date(
		/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
			? `${value.replace(" ", "T")}Z`
			: value,
	).toISOString();
}

/** Projects the StateStore outbox into the existing mailbox transport, never a direct wake. */
export function createReviewRecoveryNoticeSink(
	options: ReviewRecoveryNoticeSinkOptions,
) {
	const { store } = options;
	const provenance =
		options.provenance ??
		(() => ({
			writerPid: process.pid,
			writerStart: getProcessStart(process.pid),
		}));
	const persistedNotice = (input: ReviewRecoveryNotice) => {
		const persisted = store.getReviewRecoveryNotice(binding(input));
		return persisted?.source_request_id === input.source_request_id &&
			persisted.text === input.text
			? persisted
			: undefined;
	};
	const markActed = (input: ReviewRecoveryNotice): void => {
		const notice = persistedNotice(input);
		if (!notice?.acted_at) return;
		const db = new CommDB(options.commDbPathFor(notice.project_name), false);
		try {
			db.markReviewRecoveryNoticeActed(
				noticeId(notice),
				utcStamp(notice.acted_at),
			);
		} finally {
			db.close();
		}
	};
	return {
		markActed,
		// All work is bounded synchronous DB/file I/O. There is no detached work that
		// can enqueue after the coordinator aborts a delivery or stops recovery.
		async deliver(
			input: ReviewRecoveryNotice,
			signal: AbortSignal,
		): Promise<{ accepted: boolean }> {
			if (signal.aborted) return { accepted: false };
			const notice = persistedNotice(input);
			if (!notice) return { accepted: false };
			if (notice.acted_at) {
				markActed(notice);
				return { accepted: true };
			}
			const job = store.getCodexReviewJob(notice.source_request_id);
			if (!job || job.project_name !== notice.project_name)
				return { accepted: false };
			const follower =
				notice.request_id === job.request_id
					? undefined
					: store.getCodexReviewReuseBinding(notice.request_id);
			const exactBinding =
				notice.request_id === job.request_id
					? job.question_id === notice.question_id &&
						job.execution_id === notice.execution_id
					: follower?.source_request_id === job.request_id &&
						follower.question_id === notice.question_id &&
						follower.execution_id === notice.execution_id &&
						follower.source_attempt_generation === notice.attempt_generation;
			if (!exactBinding) return { accepted: false };
			const db = new CommDB(options.commDbPathFor(notice.project_name), false);
			try {
				const id = noticeId(notice);
				const checkpoint =
					job.review_type === "design" ? "review_design" : "review_code";
				const question = db.getMessageById(notice.question_id);
				if (
					!question ||
					question.type !== "question" ||
					question.from_agent !== notice.execution_id ||
					question.checkpoint !== checkpoint
				)
					return { accepted: false };
				const registered = db.getSession(notice.execution_id);
				if (registered && registered.project_name !== notice.project_name)
					return { accepted: false };
				const closed =
					question.resolved_at ||
					question.superseded_at ||
					question.relay_state === "terminal_disposed" ||
					db.getResponse(question.id) ||
					(question.expires_at &&
						Date.parse(question.expires_at) <= Date.now());
				const obsolete =
					job.attempt_generation !== notice.attempt_generation ||
					job.status !== "failed" ||
					job.failure_reason !== "bridge_restart_retired" ||
					follower?.released_at ||
					follower?.responded_at;
				const session = store.getSession(notice.execution_id);
				if (session && session.project_name !== notice.project_name)
					return { accepted: false };
				const node = store.getWorkflowRunNodeForExecution(notice.execution_id);
				const run = store.resolveWorkflowRunForExecution(notice.execution_id);
				const currentNode = node
					? store.listWorkflowRunNodes(node.run_id, node.node_id).at(-1)
					: undefined;
				const currentHolder =
					run.kind === "none" && !session?.workflow_node_id
						? true
						: run.kind === "one" &&
							node?.run_id === run.runId &&
							currentNode?.execution_id === notice.execution_id &&
							currentNode.state === "running";
				const reachable =
					!!session &&
					!!registered &&
					!isMailboxTerminalStatus(session.status) &&
					!isMailboxTerminalStatus(registered.status) &&
					currentHolder;
				if (
					(!reachable && !closed && !obsolete) ||
					notice.stage === "operator_required"
				) {
					// A removed follower can still route through its durable source author.
					const owner = session ??
						store.getSession(job.execution_id) ?? {
							execution_id: job.execution_id,
							issue_id: job.issue_id ?? "",
							project_name: job.project_name,
							status: "missing",
						};
					const lead = options.resolveOwningLead(owner);
					if (!lead || !(lead === "lead" || lead.endsWith("-lead")))
						return { accepted: false };
					const attempt = store.getCodexReviewAttempt(
						job.request_id,
						notice.attempt_generation,
					);
					const text = `${notice.text}\nReview recovery ${notice.stage}; R=${notice.request_id}; source R=${notice.source_request_id}; Q=${notice.question_id}; execution=${notice.execution_id}; generation=${notice.attempt_generation}.\nReviewer session UUID=${attempt?.reviewer_session_uuid ?? "unknown"}; original start=${attempt?.reviewer_started_at ?? "unknown"}; original budget ms=${attempt?.configured_timeout_ms ?? "unknown"}; original deadline=${attempt?.deadline_at ?? "unknown"}.\nEvidence required: verify the exact reviewer session/process start identity and original budget, prove the retired reviewer has exited, and confirm the current workflow holder before authorizing recovery. Check TURN; this notice is not a final verdict or ship authority.`;
					const existing = db.getMessageById(`${id}:lead`);
					if (existing) {
						if (
							existing.type !== "instruction" ||
							existing.from_agent !== "bridge" ||
							existing.to_agent !== lead ||
							existing.content !== text
						)
							throw new Error("review recovery Lead identity collision");
					} else {
						if (signal.aborted) return { accepted: false };
						db.insertInstructionAndClearDeclaredState(
							`${id}:lead`,
							"bridge",
							lead,
							text,
							provenance(),
						);
					}
				}
				if (closed || obsolete || !reachable) {
					store.markReviewRecoveryNoticeActed(binding(notice));
					const acted = store.getReviewRecoveryNotice(
						binding(notice),
					)?.acted_at;
					if (acted) db.markReviewRecoveryNoticeActed(id, utcStamp(acted));
					return { accepted: true };
				}
				if (signal.aborted) return { accepted: false };
				db.projectReviewRecoveryNotice(
					{
						requestId: notice.request_id,
						sourceRequestId: notice.source_request_id,
						questionId: notice.question_id,
						executionId: notice.execution_id,
						projectName: notice.project_name,
						generation: notice.attempt_generation,
						stage: notice.stage,
						checkpoint,
						text: notice.text,
						actedAt: null,
						...(node
							? {
									workflow: {
										issueId: store.getWorkflowRun(node.run_id)!.issue_id,
										runId: node.run_id,
										nodeId: node.node_id,
										attempt: node.attempt,
									},
								}
							: {}),
					},
					db.getMessageById(id) ? {} : provenance(),
				);
				// The marker hint is optional. Never rewrite the marker here: a stale
				// read/modify/write could erase a concurrent final answeredAt stamp.
				// The hold consumer independently verifies the durable projection.

				return { accepted: true };
			} finally {
				db.close();
			}
		},
	};
}
