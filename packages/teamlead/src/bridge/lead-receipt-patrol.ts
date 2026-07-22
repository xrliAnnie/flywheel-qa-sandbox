import type { CommDB, UnprocessedReceiptAlertPayload } from "flywheel-comm/db";
import { CommDB as CommDatabase } from "flywheel-comm/db";
import type {
	ReceiptAlertOutboxRow,
	ReceiptPriorityWindowsMs,
} from "flywheel-comm/lead-inbox-queue";
import { msToSnowflakeLowerBound } from "./founder-notify-utils.js";

export interface LeadReceiptPatrolOptions {
	projectNames: readonly string[];
	leadIdsForProject?: (projectName: string) => readonly string[];
	commDbPathForProject: (projectName: string) => string;
	receiptFoundationEnabled: () => boolean;
	ownerEpoch: () => string;
	now?: () => number;
	windowMs: number;
	receiptWindowsMs?: ReceiptPriorityWindowsMs;
	activationDryRun?: () => boolean;
	resendCap: number;
	chatPendingQuarantineAfterMs?: number;
	chatPendingQuarantineLimitPerLead?: number;
	notifyUnprocessed: (input: {
		projectName: string;
		alert: ReceiptAlertOutboxRow;
		payload: UnprocessedReceiptAlertPayload;
	}) => Promise<boolean>;
	notifyAdvisory: (input: {
		projectName: string;
		alert: ReceiptAlertOutboxRow;
	}) => Promise<boolean>;
	openDb?: (path: string) => CommDB;
	logger?: (message: string) => void;
}

/** Restore project authority lost by ref-less external receipt rows. */
export function normalizeUnprocessedReceiptAlertProject(
	payload: UnprocessedReceiptAlertPayload,
	patrolProjectName: string,
): UnprocessedReceiptAlertPayload | null {
	if (payload.projectName !== "unknown") return payload;
	const projectName = patrolProjectName.trim();
	if (!projectName || projectName === "unknown") return null;
	return {
		...payload,
		projectName,
		targetKey: `${projectName}:${payload.toLead}`,
	};
}

/**
 * The Lead-facing half of FLY-1392's receipt patrol. GatePoller supplies the
 * cadence; comm.db supplies every cursor, retry round, and outbox claim.
 */
export class LeadReceiptPatrol {
	private readonly openDb: (path: string) => CommDB;
	private readonly logger: (message: string) => void;
	private readonly chatPendingCursor = new Map<string, number>();

	constructor(private readonly options: LeadReceiptPatrolOptions) {
		this.openDb = options.openDb ?? ((path) => new CommDatabase(path, false));
		this.logger =
			options.logger ??
			((message) => console.warn(`[lead-receipt-patrol] ${message}`));
	}

	async pass(): Promise<void> {
		const enabled = this.options.receiptFoundationEnabled();
		const nowMs = (this.options.now ?? Date.now)();
		const now = new Date(nowMs).toISOString();
		for (const projectName of this.options.projectNames) {
			let db: CommDB | undefined;
			try {
				db = this.openDb(this.options.commDbPathForProject(projectName));
				const receiptWindows =
					this.options.receiptWindowsMs ??
					([
						this.options.windowMs,
						this.options.windowMs,
						this.options.windowMs,
						this.options.windowMs,
					] as const);
				db.reconcileReceiptActivation({
					enabled,
					now,
					receiptWindowsMs: receiptWindows,
					highWaterMark: msToSnowflakeLowerBound(nowMs),
					dryRun: this.options.activationDryRun?.() ?? false,
				});
				if (!enabled || (this.options.activationDryRun?.() ?? false)) continue;
				try {
					db.promoteDueFounderRebinds({
						ownerEpoch: this.options.ownerEpoch(),
						now,
					});
				} catch (error) {
					// A temporarily absent protocol owner must not suppress the independent
					// question/founder-route reminder axis.
					this.logger(
						`${projectName} rebind promotion deferred: ${(error as Error).message}`,
					);
				}
				db.advanceDueUnprocessedReceipts({
					now,
					windowMs: this.options.windowMs,
					...(this.options.receiptWindowsMs
						? { receiptWindowsMs: this.options.receiptWindowsMs }
						: {}),
					resendCap: this.options.resendCap,
				});
				this.quarantineStaleChatReceipts(db, projectName, nowMs);
				await this.drainAlerts(db, projectName, nowMs);
			} catch (error) {
				this.logger(`${projectName}: ${(error as Error).message}`);
			} finally {
				db?.close();
			}
		}
	}

	private quarantineStaleChatReceipts(
		db: CommDB,
		projectName: string,
		nowMs: number,
	): void {
		const ageMs = this.options.chatPendingQuarantineAfterMs ?? 60 * 60_000;
		const limit = this.options.chatPendingQuarantineLimitPerLead ?? 20;
		if (!Number.isSafeInteger(ageMs) || ageMs <= 0) {
			throw new Error(
				"chatPendingQuarantineAfterMs must be a positive safe integer",
			);
		}
		if (!Number.isSafeInteger(limit) || limit <= 0) {
			throw new Error(
				"chatPendingQuarantineLimitPerLead must be a positive safe integer",
			);
		}
		const createdBefore = new Date(nowMs - ageMs).toISOString();
		for (const leadId of this.options.leadIdsForProject?.(projectName) ?? []) {
			const key = `${projectName}:${leadId}`;
			try {
				const cursorSeq = this.chatPendingCursor.get(key) ?? 0;
				const rows = db.listChatReceiptPending({
					toLead: leadId,
					cursorSeq,
					limit,
					createdBefore,
					excludeQuarantined: true,
				});
				for (const row of rows) {
					if (
						!db.quarantineChatReceipt({
							receiptId: row.id,
							now: new Date(nowMs).toISOString(),
						})
					) {
						this.logger(
							`${projectName}/${leadId} could not quarantine ${row.id}`,
						);
					}
				}
				this.chatPendingCursor.set(
					key,
					rows.length === limit ? (rows.at(-1)?.seq ?? cursorSeq) : 0,
				);
			} catch (error) {
				this.logger(
					`${projectName}/${leadId} chat quarantine deferred: ${(error as Error).message}`,
				);
			}
		}
	}

	private async drainAlerts(
		db: CommDB,
		projectName: string,
		nowMs: number,
	): Promise<void> {
		for (const alert of db.listPendingReceiptAlerts(
			[
				"receipt_unprocessed",
				"unprocessed",
				"dead_letter",
				"wake_cap",
				"external_saga_unknown",
			],
			100,
		)) {
			const current = db.revalidateReceiptAlert(alert.id, nowMs);
			if (!current) continue;
			let delivered = false;
			try {
				if (
					current.kind === "receipt_unprocessed" ||
					current.kind === "unprocessed"
				) {
					const payload = JSON.parse(
						current.payload,
					) as UnprocessedReceiptAlertPayload;
					delivered = await this.options.notifyUnprocessed({
						projectName,
						alert: current,
						payload,
					});
					if (delivered) {
						db.markUnprocessedReceiptEscalated(current.id, nowMs);
					}
				} else {
					delivered = await this.options.notifyAdvisory({
						projectName,
						alert: current,
					});
					if (delivered) db.markReceiptAlertDelivered(current.id, nowMs);
				}
			} catch (error) {
				this.logger(
					`${projectName} alert ${current.id} delivery failed: ${(error as Error).message}`,
				);
			}
		}
	}
}
