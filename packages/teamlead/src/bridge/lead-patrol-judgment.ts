import { basename, join } from "node:path";
import { leadOperationInputDigest } from "../lead-capabilities/broker.js";
import { getLeadCapability } from "../lead-capabilities/catalog.js";
import { readManifestMarkdown } from "../lead-capabilities/manifest-instructions.js";
import { applyPatrolJudgment } from "../lead-capabilities/patrol-judgment.js";
import type {
	OperationReceipt,
	OperationReceiptStore,
} from "../lead-capabilities/receipts.js";
import {
	type RootCauseAskRecord,
	verifyRootCauseEvidence,
} from "../patrol-root-causes.js";
import { readLeadPatrolReport } from "./lead-patrol-snapshot.js";

type Gates = ReturnType<typeof applyPatrolJudgment>["gates"];
interface Result {
	requestId: string;
	status: "succeeded" | "rejected" | "unknown";
	resourceRefs: string[];
	errorCode?: string;
	data?: {
		judgmentId: string;
		complete: boolean;
		gates: Gates;
		reportSha256: string;
		receiptId: string;
		observedAt: string;
	};
}
/** Same-report judgment, with Bridge-owned durable receipts and no new judgment table. */
export function recordLeadPatrolJudgment(options: {
	projectName: string;
	leadId: string;
	activationId: string;
	stateDir: string;
	requestId: string;
	receipts: OperationReceiptStore;
	receiptOnly?: boolean;
	input: Record<string, unknown>;
	source: { path: string; sha256: string };
	secrets: readonly string[];
	signal: AbortSignal;
	assertCurrent(): void;
	/** FLY-2914: Bridge-owned founder_ask reader; the registered report is the baseline. */
	rootCauseAsk(askId: string): RootCauseAskRecord | undefined;
}): Result {
	const result = (status: Result["status"], errorCode?: string): Result => ({
		requestId: options.requestId,
		status,
		resourceRefs: [],
		...(errorCode ? { errorCode } : {}),
	});
	function current() {
		options.signal.throwIfAborted();
		options.assertCurrent();
		options.signal.throwIfAborted();
	}
	current();
	const parsed = getLeadCapability(
		"patrol.judgment.record",
	)!.inputSchema.safeParse(options.input);
	if (!parsed.success) return result("rejected", "invalid_input");
	const input = parsed.data;
	const key = {
		projectName: options.projectName,
		leadId: options.leadId,
		operationId: "patrol.judgment.record",
		requestId: options.requestId,
	};
	const inputDigest = leadOperationInputDigest(input);
	const base = { ...key, inputDigest, activationId: options.activationId };
	function replay(prior: OperationReceipt | undefined): Result {
		current();
		if (!prior) return result("unknown");
		if (prior.inputDigest !== inputDigest)
			return result("rejected", "input_digest_conflict");
		if (prior.state !== "succeeded" || !prior.providerRef)
			return result(prior.state === "rejected" ? "rejected" : "unknown");
		const match =
			/^pj:([0-9]{8}T[0-9]{6}Z-tick(?:NA|[0-9]{1,16})\.md):([a-f0-9]{64}):([a-f0-9]{64}):(n|-?[0-9]{1,3})\.(n|-?[0-9]{1,3})\.(n|-?[0-9]{1,3})$/.exec(
				prior.providerRef,
			);
		if (!match) return result("unknown");
		const gates = match.slice(4).map((code, index) => ({
			gate: index + 1,
			passed: code === "0",
			exitCode: code === "n" ? null : Number(code),
		}));
		return {
			...result("succeeded"),
			resourceRefs: [prior.providerRef],
			data: {
				judgmentId: options.requestId,
				complete: gates.every((g) => g.passed),
				gates,
				reportSha256: match[2]!,
				receiptId: options.requestId,
				observedAt: new Date(prior.updatedAt).toISOString(),
			},
		};
	}
	const prior = options.receipts.get(key);
	if (options.receiptOnly || prior) return replay(prior);
	// Evidence names identify a scoped snapshot receipt, never an arbitrary path or grant.
	const handle = /^patrol_([a-f0-9-]{36})$/.exec(
		input.evidenceHandle as string,
	);
	if (!handle) return result("rejected", "patrol_evidence_unverified");
	let report: ReturnType<typeof readLeadPatrolReport>;
	try {
		readManifestMarkdown([options.source], options.secrets);
		const snapshot = options.receipts.get({
			...key,
			operationId: "patrol.snapshot",
			requestId: handle[1]!,
		});
		const reference =
			snapshot?.state === "succeeded"
				? /^patrol:([0-9]{8}T[0-9]{6}Z-tick(?:NA|[0-9]{1,16})\.md):([a-f0-9]{64})$/.exec(
						snapshot.providerRef ?? "",
					)
				: null;
		if (!reference) throw new Error("unverified");
		report = readLeadPatrolReport(
			{ ...options, tickId: input.tickId as string },
			join(options.stateDir, "patrol-reports", options.leadId, reference[1]!),
		);
		if (
			report.sha256 !== reference[2] &&
			!options.receipts.hasSucceededProviderPrefix({
				projectName: options.projectName,
				leadId: options.leadId,
				operationId: key.operationId,
				providerPrefix: `pj:${basename(report.path)}:${report.sha256}:`,
			})
		)
			throw new Error("unverified");
		current();
	} catch {
		return result("rejected", "patrol_evidence_unverified");
	}
	const prepared = options.receipts.prepare({ ...base, now: Date.now() });
	if (prepared.disposition !== "prepared") return replay(prepared.receipt);
	options.receipts.transition({
		...base,
		now: Date.now(),
		from: "prepared",
		to: "dispatched",
	});
	try {
		const outcome = applyPatrolJudgment({
			source: options.source,
			secrets: options.secrets,
			assertCurrent: current,
			verifyRootCauses: (text) =>
				verifyRootCauseEvidence(text, {
					getAsk: options.rootCauseAsk,
					nowMs: Date.now(),
				}),
			report: {
				path: report.path,
				sha256: report.sha256,
				tickId: input.tickId as string,
				evidenceHandle: input.evidenceHandle as string,
			},
			input,
		});
		current();
		const codes = outcome.gates
			.map((g) => (g.exitCode === null ? "n" : String(g.exitCode)))
			.join(".");
		const receipt = options.receipts.transition({
			...base,
			now: Date.now(),
			from: "dispatched",
			to: "succeeded",
			providerRef: `pj:${basename(report.path)}:${outcome.reportSha256}:${outcome.ruleSha256}:${codes}`,
		});
		return replay(receipt);
	} catch {
		if (options.receipts.get(key)?.state === "dispatched")
			options.receipts.transition({
				...base,
				now: Date.now(),
				from: "dispatched",
				to: "unknown",
				errorCode: "judgment_interrupted",
			});
		return result("unknown");
	}
}
