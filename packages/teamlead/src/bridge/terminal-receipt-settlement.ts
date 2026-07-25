import { CommDB } from "flywheel-comm/db";
import { isOperationalTerminalStatus } from "../operational-terminal-status.js";
import type {
	DetectionEscalationRow,
	ReceiptSettlementIntent,
	StateStore,
} from "../StateStore.js";

export interface TerminalReceiptSettlementProjectorOptions {
	store: StateStore;
	projectNames: readonly string[];
	commDbPathForProject: (projectName: string) => string;
	now?: () => number;
	openDb?: (path: string) => CommDB;
	logger?: (message: string) => void;
}

export type TerminalAuthorityRevalidation = () => Promise<
	"authorized" | "reopened" | "unknown"
>;

export interface IssueDoneReceiptSettlementInput {
	projectName: string;
	canonicalIssueId: string;
	issueAliases: readonly string[];
	authorityCredential: string;
	revalidate: TerminalAuthorityRevalidation;
}

export interface PrMergedReceiptSettlementInput
	extends IssueDoneReceiptSettlementInput {
	prNumber: number;
}

/**
 * FLY-1448 E2: recoverable StateStore → CommDB terminal settlement projector.
 * The StateStore claim is the linearization point. Once claimed, a later
 * session revival cannot strand the already-authorized cross-database work;
 * every CommDB effect and the final detection resolution are idempotent.
 */
export class TerminalReceiptSettlementProjector {
	private readonly openDb: (path: string) => CommDB;
	private readonly logger: (message: string) => void;

	constructor(
		private readonly options: TerminalReceiptSettlementProjectorOptions,
	) {
		this.openDb = options.openDb ?? ((path) => new CommDB(path, false));
		this.logger =
			options.logger ??
			((message) => console.warn(`[terminal-receipt-settlement] ${message}`));
	}

	async pass(): Promise<void> {
		for (const projectName of this.options.projectNames) {
			for (const session of this.options.store.getProjectSessions(
				projectName,
			)) {
				if (
					isOperationalTerminalStatus(session.status) &&
					session.terminal_lifecycle_id
				) {
					this.options.store.ensureTerminalSettlementIntent(
						session.execution_id,
						session.terminal_lifecycle_id,
					);
				}
			}
		}
		for (const intent of this.options.store.listReceiptSettlementIntents([
			"pending",
			"applying",
		])) {
			if (!this.options.projectNames.includes(intent.project_name)) continue;
			await this.applyIntent(intent);
		}
	}

	/**
	 * FLY-1448 E1: settle receipts for every session alias of an issue that a
	 * caller just observed as Done/Canceled. Unlike session-terminal authority,
	 * a running session is intentionally eligible. The caller supplies the
	 * existing uncached Linear recheck seam; every irreversible family mutation
	 * is preceded by a fresh authorization and a reopen/lookup failure fences
	 * the durable intent.
	 */
	async settleIssueDone(input: IssueDoneReceiptSettlementInput): Promise<void> {
		if (!this.options.projectNames.includes(input.projectName)) return;
		const intents = this.options.store.ensureIssueDoneSettlementIntents({
			projectName: input.projectName,
			canonicalIssueId: input.canonicalIssueId,
			issueAliases: input.issueAliases,
			authorityCredential: input.authorityCredential,
		});
		for (const intent of intents) {
			if (intent.state === "completed" || intent.state === "fenced") continue;
			await this.applyExternalAuthorityIntent(
				intent,
				input,
				"issue_done",
				"superseded_issue_done",
			);
		}
	}

	/** FLY-1448 E1: the separate fresh-GitHub-MERGED authority lane. */
	async settlePrMerged(input: PrMergedReceiptSettlementInput): Promise<void> {
		if (!this.options.projectNames.includes(input.projectName)) return;
		const intents = this.options.store.ensurePrMergedSettlementIntents({
			projectName: input.projectName,
			canonicalIssueId: input.canonicalIssueId,
			issueAliases: input.issueAliases,
			prNumber: input.prNumber,
			authorityCredential: input.authorityCredential,
		});
		for (const intent of intents) {
			if (intent.state === "completed" || intent.state === "fenced") continue;
			await this.applyExternalAuthorityIntent(
				intent,
				input,
				"pr_merged",
				"superseded_merged",
			);
		}
	}

	private async externalAuthorityStillFresh(
		intent: ReceiptSettlementIntent,
		revalidate: TerminalAuthorityRevalidation,
	): Promise<boolean> {
		let verdict: Awaited<ReturnType<TerminalAuthorityRevalidation>>;
		try {
			verdict = await revalidate();
		} catch {
			verdict = "unknown";
		}
		if (verdict === "authorized") return true;
		const reason =
			verdict === "reopened"
				? `${intent.authority_kind}_revoked_before_settlement_mutation`
				: `${intent.authority_kind}_authority_unknown_before_settlement_mutation`;
		if (verdict === "reopened") {
			this.options.store.fenceReceiptSettlementIntent(intent.intent_id, reason);
		} else {
			this.options.store.retryReceiptSettlementIntent(intent.intent_id, reason);
		}
		return false;
	}

	private async applyExternalAuthorityIntent(
		intent: ReceiptSettlementIntent,
		input: IssueDoneReceiptSettlementInput,
		authorityKind: "issue_done" | "pr_merged",
		shipDisposition: "superseded_issue_done" | "superseded_merged",
	): Promise<void> {
		if (
			intent.authority_kind !== authorityKind ||
			!intent.execution_id ||
			intent.authority_credential !== input.authorityCredential
		) {
			return;
		}
		if (!(await this.externalAuthorityStillFresh(intent, input.revalidate))) {
			return;
		}
		const claimed =
			authorityKind === "issue_done"
				? this.options.store.claimIssueDoneSettlementIntent(
						intent.intent_id,
						input.authorityCredential,
					)
				: this.options.store.claimPrMergedSettlementIntent(
						intent.intent_id,
						input.authorityCredential,
					);
		if (!claimed?.claim_token) return;

		let db: CommDB | undefined;
		try {
			db = this.openDb(this.options.commDbPathForProject(intent.project_name));
			this.attachActiveLegacyReceiptDetectionLineage(
				db,
				intent,
				input.issueAliases,
			);
			const receiptIds = db.listReceiptRootsForExecution(intent.execution_id);
			for (const receiptId of receiptIds) {
				const lineage = db.getReceiptSettlementLineage(receiptId);
				if (
					!lineage ||
					lineage.executionId !== intent.execution_id ||
					lineage.projectName !== intent.project_name
				) {
					throw new Error(`receipt lineage mismatch for ${receiptId}`);
				}
				if (
					!(await this.externalAuthorityStillFresh(intent, input.revalidate))
				) {
					return;
				}
			}

			const shipSettledReceiptIds = new Set<string>();
			for (const question of db.getPendingGatesByRunner(intent.execution_id)) {
				if (question.checkpoint !== "approve_to_ship") continue;
				if (
					!(await this.externalAuthorityStillFresh(intent, input.revalidate))
				) {
					return;
				}
				const result = db.supersedeShipGateAndReceiptFamily({
					questionId: question.id,
					reason: shipDisposition,
					now: new Date((this.options.now ?? Date.now)()).toISOString(),
				});
				for (const receiptId of result.receiptIds) {
					shipSettledReceiptIds.add(receiptId);
				}
			}

			const nowMs = (this.options.now ?? Date.now)();
			const now = new Date(nowMs).toISOString();
			for (const receiptId of receiptIds) {
				if (shipSettledReceiptIds.has(receiptId)) continue;
				if (
					!(await this.externalAuthorityStillFresh(intent, input.revalidate))
				) {
					return;
				}
				db.settleReceiptFamilyForTerminalSubject({
					receiptId,
					expectedExecutionId: intent.execution_id,
					reason: authorityKind,
					now,
				});
			}
			if (!(await this.externalAuthorityStillFresh(intent, input.revalidate))) {
				return;
			}
			this.options.store.resolveReceiptDetectionsForExecution(
				intent.execution_id,
				nowMs,
			);
			if (
				!this.options.store.completeReceiptSettlementIntent(
					intent.intent_id,
					claimed.claim_token,
				)
			) {
				throw new Error(`${authorityKind} settlement completion CAS failed`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.store.recordReceiptSettlementIntentError(
				intent.intent_id,
				claimed.claim_token,
				message,
			);
			this.logger(`${intent.intent_id}: ${message}`);
		} finally {
			db?.close();
		}
	}

	private attachActiveLegacyReceiptDetectionLineage(
		db: CommDB,
		intent: ReceiptSettlementIntent,
		issueAliases: readonly string[],
	): void {
		if (!intent.execution_id) return;
		const receiptIds = db.listReceiptRootsForExecution(intent.execution_id);
		const issueAliasSet = new Set(
			[intent.issue_id, ...issueAliases].filter((value) => value.trim()),
		);
		const detections = this.options.store.listActiveLegacyReceiptDetections({
			projectName: intent.project_name,
			issueAliases: [...issueAliasSet],
		});
		for (const receiptId of receiptIds) {
			detections.push(
				...this.options.store.listActiveLegacyReceiptDetectionsForReceipt(
					receiptId,
				),
			);
		}
		const seen = new Set<string>();
		for (const detection of detections) {
			const candidateKey = `${detection.target_key}\0${detection.kind}\0${detection.episode_fingerprint}`;
			if (seen.has(candidateKey)) continue;
			seen.add(candidateKey);
			const receiptId = detection.episode_fingerprint;
			const lineage = db.getReceiptSettlementLineage(receiptId);
			if (!lineage) {
				this.failLegacyReceiptLineage(
					intent,
					detection,
					`unresolved legacy receipt detection ${receiptId}: CommDB root missing`,
				);
			}
			if (lineage.projectName !== intent.project_name) {
				this.failLegacyReceiptLineage(
					intent,
					detection,
					`unresolved legacy receipt detection ${receiptId}: project lineage mismatch`,
				);
			}
			const trustedLeadId = lineage.sessionLeadId ?? lineage.rootLeadId;
			if (
				lineage.issueId === null ||
				!issueAliasSet.has(lineage.issueId) ||
				(detection.issue_id !== null && !issueAliasSet.has(detection.issue_id))
			) {
				this.failLegacyReceiptLineage(
					intent,
					detection,
					`unresolved legacy receipt detection ${receiptId}: issue lineage mismatch`,
					trustedLeadId,
				);
			}
			const expectedTargetKey = `${intent.project_name}:${lineage.rootLeadId}`;
			if (
				!lineage.rootLeadId ||
				lineage.sessionLeadId !== lineage.rootLeadId ||
				detection.target_key !== expectedTargetKey ||
				detection.owner_lead_id !== lineage.rootLeadId
			) {
				this.failLegacyReceiptLineage(
					intent,
					detection,
					`unresolved legacy receipt detection ${receiptId}: Lead lineage mismatch`,
					trustedLeadId,
				);
			}
			if (lineage.executionId !== intent.execution_id) continue;
			try {
				this.options.store.attachLegacyReceiptDetectionLineage(receiptId, {
					sourceExecutionId: lineage.executionId,
					sourceQuestionId: lineage.questionId,
				});
			} catch (error) {
				this.failLegacyReceiptLineage(
					intent,
					detection,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	}

	private failLegacyReceiptLineage(
		intent: ReceiptSettlementIntent,
		detection: DetectionEscalationRow,
		reason: string,
		trustedLeadId?: string,
	): never {
		const targetPrefix = `${intent.project_name}:`;
		const targetLeadId = detection.target_key.startsWith(targetPrefix)
			? detection.target_key.slice(targetPrefix.length)
			: "";
		const leadId =
			trustedLeadId?.trim() || detection.owner_lead_id || targetLeadId;
		if (leadId) {
			this.options.store.appendLeadEvent(
				leadId,
				`receipt-settlement-lineage-invalid:${detection.kind}:${detection.episode_fingerprint}`,
				"receipt_settlement_lineage_invalid",
				JSON.stringify({
					event_type: "receipt_settlement_lineage_invalid",
					project_name: intent.project_name,
					issue_id: detection.issue_id ?? intent.issue_id,
					execution_id: intent.execution_id,
					target_key: detection.target_key,
					receipt_id: detection.episode_fingerprint,
					reason,
				}),
				intent.execution_id ?? undefined,
			);
		}
		throw new Error(reason);
	}

	private async applyIntent(intent: ReceiptSettlementIntent): Promise<void> {
		if (
			intent.authority_kind !== "session_terminal" ||
			!intent.execution_id ||
			!intent.terminal_lifecycle_id
		) {
			return;
		}
		const claimed = this.options.store.claimTerminalSettlementIntent(
			intent.intent_id,
			intent.terminal_lifecycle_id,
		);
		if (!claimed?.claim_token) return;

		let db: CommDB | undefined;
		try {
			db = this.openDb(this.options.commDbPathForProject(intent.project_name));
			this.attachActiveLegacyReceiptDetectionLineage(db, intent, [
				intent.issue_id,
			]);
			const receiptIds = db.listReceiptRootsForExecution(intent.execution_id);
			for (const receiptId of receiptIds) {
				const lineage = db.getReceiptSettlementLineage(receiptId);
				if (
					!lineage ||
					lineage.executionId !== intent.execution_id ||
					lineage.projectName !== intent.project_name
				) {
					throw new Error(`receipt lineage mismatch for ${receiptId}`);
				}
			}

			const shipSettledReceiptIds = new Set<string>();
			for (const question of db.getPendingGatesByRunner(intent.execution_id)) {
				if (question.checkpoint !== "approve_to_ship") continue;
				const result = db.supersedeShipGateAndReceiptFamily({
					questionId: question.id,
					reason: "superseded_session_terminal",
					now: new Date((this.options.now ?? Date.now)()).toISOString(),
				});
				for (const receiptId of result.receiptIds) {
					shipSettledReceiptIds.add(receiptId);
				}
			}

			const nowMs = (this.options.now ?? Date.now)();
			const now = new Date(nowMs).toISOString();
			for (const receiptId of receiptIds) {
				if (shipSettledReceiptIds.has(receiptId)) continue;
				db.settleReceiptFamilyForTerminalSubject({
					receiptId,
					expectedExecutionId: intent.execution_id,
					reason: "session_terminal",
					now,
				});
			}
			this.options.store.resolveReceiptDetectionsForExecution(
				intent.execution_id,
				nowMs,
			);
			if (
				!this.options.store.completeReceiptSettlementIntent(
					intent.intent_id,
					claimed.claim_token,
				)
			) {
				throw new Error("settlement completion CAS failed");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.store.recordReceiptSettlementIntentError(
				intent.intent_id,
				claimed.claim_token,
				message,
			);
			this.logger(`${intent.intent_id}: ${message}`);
		} finally {
			db?.close();
		}
	}
}
