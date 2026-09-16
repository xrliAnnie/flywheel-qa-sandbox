import { basename, join } from "node:path";
import { leadOperationInputDigest } from "../lead-capabilities/broker.js";
import type {
	OperationReceipt,
	OperationReceiptStore,
} from "../lead-capabilities/receipts.js";
import {
	executeLeadPatrolSnapshot,
	readLeadPatrolReport,
} from "./lead-patrol-snapshot.js";

type Options = Parameters<typeof executeLeadPatrolSnapshot>[0] & {
	activationId: string;
	requestId: string;
	receipts: OperationReceiptStore;
	receiptOnly?: boolean;
};
export interface RegisteredPatrolSnapshot {
	requestId: string;
	status: "succeeded" | "unknown" | "rejected";
	resourceRefs: string[];
	errorCode?: string;
	data?: ReturnType<typeof readLeadPatrolReport> & {
		evidenceHandle: string;
		observedAt: string;
	};
}
/** Bridge owns the report and SQLite receipt. A snapshot replay never reruns the helper. */
export async function registerLeadPatrolSnapshot(
	options: Options,
): Promise<RegisteredPatrolSnapshot> {
	const key = {
		projectName: options.projectName,
		leadId: options.leadId,
		operationId: "patrol.snapshot",
		requestId: options.requestId,
	};
	const inputDigest = leadOperationInputDigest({
		tickId: options.tickId,
	});
	const base = { ...key, inputDigest, activationId: options.activationId };
	const result = (
		status: RegisteredPatrolSnapshot["status"],
		errorCode?: string,
	): RegisteredPatrolSnapshot => ({
		requestId: options.requestId,
		status,
		resourceRefs: [],
		...(errorCode ? { errorCode } : {}),
	});
	async function current() {
		options.signal.throwIfAborted();
		await options.assertCurrent();
		options.signal.throwIfAborted();
	}
	async function replay(
		receipt: OperationReceipt | undefined,
	): Promise<RegisteredPatrolSnapshot> {
		await current();
		if (!receipt) return result("unknown");
		if (receipt.inputDigest !== inputDigest)
			return result("rejected", "input_digest_conflict");
		if (receipt.state !== "succeeded" || !receipt.providerRef)
			return result(receipt.state === "rejected" ? "rejected" : "unknown");
		const match =
			/^patrol:([0-9]{8}T[0-9]{6}Z-tick(?:NA|[0-9]{1,16})\.md):([a-f0-9]{64})$/.exec(
				receipt.providerRef,
			);
		if (!match) return result("unknown");
		try {
			const data = readLeadPatrolReport(
				options,
				join(options.stateDir, "patrol-reports", options.leadId, match[1]!),
				match[2]!,
			);
			await current();
			return {
				...result("succeeded"),
				resourceRefs: [receipt.providerRef],
				data: {
					...data,
					evidenceHandle: `patrol_${options.requestId}`,
					observedAt: new Date(receipt.updatedAt).toISOString(),
				},
			};
		} catch {
			return result("unknown");
		}
	}
	await current();
	if (options.receiptOnly) return replay(options.receipts.get(key));
	let prepared: ReturnType<OperationReceiptStore["prepare"]>;
	try {
		prepared = options.receipts.prepare({ ...base, now: Date.now() });
	} catch (error) {
		if (error instanceof Error && error.message === "input_digest_conflict")
			return result("rejected", "input_digest_conflict");
		throw error;
	}
	if (prepared.disposition !== "prepared") return replay(prepared.receipt);
	try {
		await current();
	} catch {
		options.receipts.transition({
			...base,
			now: Date.now(),
			from: "prepared",
			to: "rejected",
			errorCode: "scope_unavailable",
		});
		return result("rejected", "scope_unavailable");
	}
	options.receipts.transition({
		...base,
		now: Date.now(),
		from: "prepared",
		to: "dispatched",
	});
	try {
		const report = await executeLeadPatrolSnapshot(options);
		await current();
		const receipt = options.receipts.transition({
			...base,
			now: Date.now(),
			from: "dispatched",
			to: "succeeded",
			providerRef: `patrol:${basename(report.path)}:${report.sha256}`,
		});
		return replay(receipt);
	} catch {
		const receipt = options.receipts.get(key);
		if (receipt?.state === "dispatched")
			options.receipts.transition({
				...base,
				now: Date.now(),
				from: "dispatched",
				to: "unknown",
				errorCode: "snapshot_interrupted",
			});
		return result("unknown");
	}
}
