import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { OperationReceiptStore } from "../lead-capabilities/receipts.js";
/** Read parent-owned terminal evidence. A current provider value is never proof of an old request. */
export function readVoiceTargetTerminalProof(
	stateDir: string,
	lock: {
		projectName: string;
		leadId: string;
		holderActivation: string;
		requestId: string;
		targetKey: string;
	},
	bridgeReceipts?: OperationReceiptStore,
): { outcome: "succeeded"; operationId: string; providerRef: string } | null {
	const match =
		/^voice:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(
			lock.holderActivation,
		);
	if (!match) return null;
	// A Bridge inner broker can finish after its original HTTP response was
	// unknown. Its parent-owned journal is equally authoritative for this exact
	// activation/request/target; no provider retry or current-value lookup occurs.
	if (bridgeReceipts) {
		try {
			const receipts = bridgeReceipts
				.listByActivation({
					projectName: lock.projectName,
					leadId: lock.leadId,
					activationId: lock.holderActivation,
				})
				.filter(
					(receipt) =>
						receipt.requestId === lock.requestId &&
						receipt.targetKey === lock.targetKey,
				);
			if (
				receipts.length === 1 &&
				receipts[0]?.state === "succeeded" &&
				receipts[0].providerRef &&
				/^[A-Za-z0-9_.:-]{1,256}$/.test(receipts[0].providerRef)
			)
				return {
					outcome: "succeeded",
					operationId: receipts[0].operationId,
					providerRef: receipts[0].providerRef,
				};
		} catch {
			/* Unavailable evidence never clears a lock. */
		}
	}
	let db: Database.Database | undefined;
	try {
		const root = realpathSync(stateDir);
		const directory = join(root, "voice-capability", match[1]!);
		const file = join(directory, "journal.db");
		if (
			realpathSync(directory) !== directory ||
			lstatSync(file).isSymbolicLink() ||
			!lstatSync(file).isFile()
		)
			return null;
		db = new Database(file, {
			readonly: true,
			fileMustExist: true,
			timeout: 1000,
		});
		const rows = db
			.prepare(
				"SELECT operation_id, provider_ref FROM lead_operation_receipts WHERE project_name=? AND lead_id=? AND activation_id=? AND request_id=? AND target_key=? AND state='succeeded' LIMIT 2",
			)
			.all(
				lock.projectName,
				lock.leadId,
				lock.holderActivation,
				lock.requestId,
				lock.targetKey,
			) as Array<{ operation_id: string; provider_ref: string }>;
		if (
			rows.length !== 1 ||
			!/^[a-z][a-z0-9_.]{0,255}$/.test(rows[0]!.operation_id) ||
			!/^[A-Za-z0-9_.:-]{1,256}$/.test(rows[0]!.provider_ref)
		)
			return null;
		return {
			outcome: "succeeded",
			operationId: rows[0]!.operation_id,
			providerRef: rows[0]!.provider_ref,
		};
	} catch {
		return null;
	} finally {
		db?.close();
	}
}
