import {
	type CompletionObligationResolution,
	type DrainPage,
	paginateUnreadObligations,
} from "flywheel-comm/completion-obligations";
import { CommDB } from "flywheel-comm/db";
import { canonicalSubmissionDigest } from "flywheel-config";

export type CompletionDrainEnvelope =
	| {
			ok: true;
			completionSubmission: Record<string, unknown>;
			receiptChallengeId?: string;
	  }
	| { ok: false; reason: "drain_receipt_rejected" };

/** Strip the receipt from the authority-bearing business payload. */
export function parseCompletionDrainEnvelope(
	payload: Record<string, unknown> | undefined,
): CompletionDrainEnvelope {
	const source = payload ?? {};
	const { drainReceipt, ...completionSubmission } = source;
	if (drainReceipt === undefined) {
		return { ok: true, completionSubmission };
	}
	if (
		typeof drainReceipt !== "object" ||
		drainReceipt === null ||
		Array.isArray(drainReceipt) ||
		typeof (drainReceipt as Record<string, unknown>).challengeId !== "string" ||
		!/^[A-Za-z0-9:._-]{1,512}$/.test(
			(drainReceipt as Record<string, unknown>).challengeId as string,
		)
	) {
		return { ok: false, reason: "drain_receipt_rejected" };
	}
	return {
		ok: true,
		completionSubmission,
		receiptChallengeId: (drainReceipt as { challengeId: string }).challengeId,
	};
}

/**
 * FLY-2373: the server-derived proof that every obligation of one completion
 * was consumed. Built by the Bridge under the CommDB lock and handed to
 * StateStore in the same synchronous step; never decoded from a payload.
 */
export interface CompletionDrainProof {
	protocolVersion: 2;
	proofDigest: string;
	settledWakes: Array<{
		messageId: string;
		obligationDigest: string;
		reason: "content_consumed" | "signal_satisfied";
	}>;
	receiptIds: string[];
}

export function completionDrainProofDigest(
	proof: Omit<CompletionDrainProof, "proofDigest">,
): string {
	return canonicalSubmissionDigest({
		domain: "fly2373.completion-drain-proof",
		protocolVersion: proof.protocolVersion,
		settledWakes: proof.settledWakes,
		receiptIds: proof.receiptIds,
	});
}

export function buildCompletionDrainProof(
	resolution: CompletionObligationResolution,
): CompletionDrainProof {
	if (resolution.unread.length > 0) {
		throw new Error("completion drain proof requires every obligation read");
	}
	const settledWakes = resolution.wakes
		.map((wake) => {
			if (!wake.satisfied) {
				throw new Error(`completion drain wake ${wake.messageId} unsatisfied`);
			}
			return {
				messageId: wake.messageId,
				obligationDigest: wake.obligationDigest,
				reason:
					wake.evidence.receiptIds.length > 0
						? ("content_consumed" as const)
						: ("signal_satisfied" as const),
			};
		})
		.sort((left, right) => (left.messageId < right.messageId ? -1 : 1));
	const receiptIds = [
		...new Set(resolution.wakes.flatMap((wake) => wake.evidence.receiptIds)),
	].sort();
	const body = { protocolVersion: 2 as const, settledWakes, receiptIds };
	return { ...body, proofDigest: completionDrainProofDigest(body) };
}

export function isCompletionDrainProof(
	value: unknown,
): value is CompletionDrainProof {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proof = value as Record<string, unknown>;
	if (
		proof.protocolVersion !== 2 ||
		typeof proof.proofDigest !== "string" ||
		!Array.isArray(proof.settledWakes) ||
		!Array.isArray(proof.receiptIds) ||
		!proof.receiptIds.every((id) => typeof id === "string" && id.length > 0) ||
		!proof.settledWakes.every(
			(wake) =>
				wake &&
				typeof wake === "object" &&
				typeof (wake as Record<string, unknown>).messageId === "string" &&
				/^[0-9a-f]{64}$/.test(
					String((wake as Record<string, unknown>).obligationDigest),
				) &&
				((wake as Record<string, unknown>).reason === "content_consumed" ||
					(wake as Record<string, unknown>).reason === "signal_satisfied"),
		)
	) {
		return false;
	}
	return (
		completionDrainProofDigest({
			protocolVersion: 2,
			settledWakes: proof.settledWakes as CompletionDrainProof["settledWakes"],
			receiptIds: proof.receiptIds as string[],
		}) === proof.proofDigest
	);
}

/**
 * The recoverable 409 a runner sees when a body is still unread. The first
 * page of full text rides along; commands are argument arrays for
 * `flywheel-comm`, never shell text.
 */
export function consumePendingMailResponse(input: {
	challengeId: string;
	readId: string;
	resolution: CompletionObligationResolution;
	firstPage: DrainPage;
}): Record<string, unknown> {
	const { resolution, firstPage } = input;
	const unavailable = resolution.unread.some(
		(obligation) => obligation.sourceStatus !== "ok",
	);
	return {
		error: "workflow_completion_rejected",
		reason: "consume_pending_mail",
		hint:
			"Unread Lead traffic must be read before this completion commits. " +
			"Read every page, act on it, acknowledge the read, then rerun the same complete command (no --drain-receipt needed)." +
			(unavailable
				? " At least one item has a missing source or unreadable body and cannot be acknowledged; report it to your Lead."
				: ""),
		protocolVersion: 2,
		challengeId: input.challengeId,
		readId: input.readId,
		unread: resolution.unread.map((obligation, index) => ({
			index: index + 1,
			type: obligation.type,
			subjectKind: obligation.subjectKind,
			subjectId: obligation.subjectId,
			sender: obligation.sender,
			createdAt: obligation.createdAt,
			...(obligation.leadInstructionId
				? { leadInstructionId: obligation.leadInstructionId }
				: {}),
			...(obligation.questionId ? { questionId: obligation.questionId } : {}),
			contentSha256: obligation.contentSha256,
			bytes: Buffer.byteLength(obligation.body, "utf8"),
			historical: obligation.historical,
			sourceStatus: obligation.sourceStatus,
		})),
		page: {
			index: firstPage.index,
			count: firstPage.count,
			sha256: firstPage.sha256,
			text: firstPage.text,
		},
		...(firstPage.count > 1
			? { pageCommand: ["inbox", "--drain-page", input.readId, "--page"] }
			: {}),
		ackCommand: ["inbox", "--ack-consumed", input.readId],
		mailbox: resolution.mailboxIds,
		phaseWakes: resolution.phaseWakeIds,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type SemanticCompletionDrainResult<T> =
	| { kind: "unread"; response: Record<string, unknown> }
	| { kind: "unavailable"; detail: string; error: string }
	| {
			kind: "committed";
			completion: T;
			settled: number;
			settlementError?: string;
	  };

/**
 * FLY-2373 completion boundary. Inside ONE CommDB IMMEDIATE transaction:
 * re-resolve every current obligation (not a frozen challenge), and only when
 * nothing is unread commit the StateStore completion synchronously with the
 * server proof, then settle the proven wakes (savepoint). Mail that lands
 * after this lock is a post-boundary message and stays queued for its reader.
 *
 * This is not a cross-database atomic commit: if StateStore commits and the
 * CommDB commit is lost, the recorded proof lets a replay re-apply settlement
 * (see `reconcileCompletionDrainSettlement`); the only cost meanwhile is a
 * redundant doorbell, never a lost or forged read.
 */
export function runSemanticCompletionDrain<
	T extends { ok: boolean; idempotentReplay?: boolean; eventUid?: string },
>(input: {
	commDbPath: string;
	store: {
		issueDrainChallenge(args: {
			executionId: string;
			activationId: string;
			businessDigest: string;
			readSetDigest: string;
			subjects: ReadonlyArray<{
				subjectKind: string;
				subjectId: string;
				contentSha256: string;
			}>;
			mailSet: { mailbox: string[]; phaseWakes: string[] };
			pages: readonly string[];
		}): { challengeId: string; readId: string };
	};
	executionId: string;
	activationId: string;
	businessDigest: string;
	commit: (proof: CompletionDrainProof) => T;
	nowMs?: () => number;
}): SemanticCompletionDrainResult<T> {
	const nowMs = input.nowMs ?? Date.now;
	let comm: CommDB;
	try {
		comm = new CommDB(input.commDbPath, false, false);
	} catch (error) {
		return {
			kind: "unavailable",
			detail: "commdb_unreadable",
			error: errorMessage(error),
		};
	}
	let resolution: CompletionObligationResolution | undefined;
	let commitStarted = false;
	let completion: T | undefined;
	let settled = 0;
	let settlementError: string | undefined;
	try {
		comm.withImmediateTransaction(() => {
			resolution = comm.resolveCompletionObligations(
				input.executionId,
				input.activationId,
			);
			if (resolution.unread.length > 0) return;
			const proof = buildCompletionDrainProof(resolution);
			commitStarted = true;
			completion = input.commit(proof);
			if (
				completion.ok &&
				!completion.idempotentReplay &&
				resolution.wakes.length > 0
			) {
				try {
					settled = comm.settleCompletionWakes({
						executionId: input.executionId,
						activationId: input.activationId,
						completionEventId: completion.eventUid ?? "unknown",
						wakes: resolution.wakes,
						nowMs: nowMs(),
					});
				} catch (error) {
					settlementError = errorMessage(error);
				}
			}
		});
	} catch (error) {
		if (commitStarted && completion === undefined) throw error;
		if (completion === undefined) {
			return {
				kind: "unavailable",
				detail: "commdb_unreadable",
				error: errorMessage(error),
			};
		}
		settled = 0;
		settlementError = errorMessage(error);
	} finally {
		comm.close();
	}
	if (completion !== undefined) {
		return {
			kind: "committed",
			completion,
			settled,
			...(settlementError ? { settlementError } : {}),
		};
	}
	const unread = resolution!;
	const pages = paginateUnreadObligations(unread.unread);
	let envelope: { challengeId: string; readId: string };
	try {
		envelope = input.store.issueDrainChallenge({
			executionId: input.executionId,
			activationId: input.activationId,
			businessDigest: input.businessDigest,
			readSetDigest: unread.readSetDigest,
			subjects: unread.unread,
			mailSet: { mailbox: unread.mailboxIds, phaseWakes: unread.phaseWakeIds },
			pages: pages.map((page) => page.text),
		});
	} catch (error) {
		return {
			kind: "unavailable",
			detail: "drain_envelope_unavailable",
			error: errorMessage(error),
		};
	}
	return {
		kind: "unread",
		response: consumePendingMailResponse({
			challengeId: envelope.challengeId,
			readId: envelope.readId,
			resolution: unread,
			firstPage: pages[0]!,
		}),
	};
}

/** Replay repair: re-apply settlement recorded by an already-committed proof. */
export function reconcileCompletionDrainSettlement(input: {
	commDbPath: string;
	store: {
		listCompletionDrainProofs(args: {
			runId: string;
			executionId: string;
			activationId: string;
		}): CompletionDrainProof["settledWakes"];
	};
	runId: string;
	executionId: string;
	activationId: string;
	completionEventId: string;
	nowMs?: number;
}): number {
	const recorded = input.store.listCompletionDrainProofs({
		runId: input.runId,
		executionId: input.executionId,
		activationId: input.activationId,
	});
	if (recorded.length === 0) return 0;
	const comm = new CommDB(input.commDbPath, false, false);
	try {
		return comm.reapplyCompletionWakeSettlement({
			executionId: input.executionId,
			activationId: input.activationId,
			completionEventId: input.completionEventId,
			recorded,
			nowMs: input.nowMs ?? Date.now(),
		});
	} finally {
		comm.close();
	}
}
