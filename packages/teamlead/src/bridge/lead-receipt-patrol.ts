import type { CommDB, UnprocessedReceiptAlertPayload } from "flywheel-comm/db";
import { CommDB as CommDatabase } from "flywheel-comm/db";
import type {
	ReceiptAlertOutboxRow,
	ReceiptPriorityWindowsMs,
} from "flywheel-comm/lead-inbox-queue";
import { msToSnowflakeLowerBound } from "./founder-notify-utils.js";

export interface LeadReceiptPatrolOptions {
	projectNames: readonly string[];
	commDbPathForProject: (projectName: string) => string;
	receiptFoundationEnabled: () => boolean;
	ownerEpoch: () => string;
	now?: () => number;
	windowMs: number;
	receiptWindowsMs?: ReceiptPriorityWindowsMs;
	activationDryRun?: () => boolean;
	resendCap: number;
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

/**
 * The Lead-facing half of FLY-1392's receipt patrol. GatePoller supplies the
 * cadence; comm.db supplies every cursor, retry round, and outbox claim.
 */
export class LeadReceiptPatrol {
	private readonly openDb: (path: string) => CommDB;
	private readonly logger: (message: string) => void;

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
				await this.drainAlerts(db, projectName, nowMs);
			} catch (error) {
				this.logger(`${projectName}: ${(error as Error).message}`);
			} finally {
				db?.close();
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
