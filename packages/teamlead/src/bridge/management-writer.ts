import { canonicalJsonString } from "flywheel-config";
import {
	type ManagementConsequence,
	type ManagementTargetKind,
	parseTargetId,
	type WriteCapability,
} from "./management-console-contract.js";

export interface ManagementChangeRequest {
	targetId: string;
	desiredValue: unknown;
	observedRevision: string;
}

/** Server-resolved target. No client path/root/writer metadata is accepted. */
export interface ManagementResolvedTarget {
	targetId: string;
	kind: ManagementTargetKind;
	currentValue: unknown;
	sourceRevision: string;
	writeCapability: WriteCapability;
}

/** Safe canonical item that can be shown in the old-value -> new-value dialog. */
export interface ManagementPreparedChange {
	targetId: string;
	kind: ManagementTargetKind;
	writerId: string;
	oldValue: unknown;
	newValue: unknown;
	sourceRevision: string;
	consequence: ManagementConsequence;
	requiresAcknowledgement: boolean;
}

export type ManagementRejectCode =
	| "unknown_target"
	| "readonly"
	| "readonly_cross_provider"
	| "readonly_registry_policy"
	| "invalid_desired_value"
	| "stale_source"
	| "conflicting_duplicate"
	| "apply_failed";

export type ManagementPreflightResult =
	| {
			ok: true;
			status: "ready" | "no_op";
			change: ManagementPreparedChange;
	  }
	| { ok: false; code: ManagementRejectCode; reason: string };

export interface ManagementWriterResult {
	status:
		| "applied"
		| "accepted"
		| "no_op"
		| "rejected"
		| "rolled_back"
		| "partial";
	reason?: string;
	details?: unknown;
}

export interface ManagementWriter {
	id: string;
	kind: ManagementTargetKind;
	resolve(
		targetId: string,
	): ManagementResolvedTarget | null | Promise<ManagementResolvedTarget | null>;
	preflight(
		target: ManagementResolvedTarget,
		desiredValue: unknown,
		observedRevision: string,
	): ManagementPreflightResult | Promise<ManagementPreflightResult>;
	apply(
		change: ManagementPreparedChange,
	): ManagementWriterResult | Promise<ManagementWriterResult>;
	applyGroup?(
		changes: readonly ManagementPreparedChange[],
	): ManagementWriterResult[] | Promise<ManagementWriterResult[]>;
	validateGroup?(
		changes: readonly ManagementPreparedChange[],
	):
		| { ok: true }
		| { ok: false; code: ManagementRejectCode; reason: string }
		| Promise<
				{ ok: true } | { ok: false; code: ManagementRejectCode; reason: string }
		  >;
	rollback?(
		change: ManagementPreparedChange,
		result: ManagementWriterResult,
	): ManagementWriterResult | Promise<ManagementWriterResult>;
}

export class ManagementWriterRegistry {
	private readonly byKind = new Map<ManagementTargetKind, ManagementWriter>();

	constructor(writers: readonly ManagementWriter[] = []) {
		for (const writer of writers) this.register(writer);
	}

	register(writer: ManagementWriter): void {
		if (!writer.id.trim()) throw new Error("writer id is required");
		const previous = this.byKind.get(writer.kind);
		if (previous) {
			throw new Error(
				`duplicate writer for ${writer.kind}: ${previous.id}, ${writer.id}`,
			);
		}
		this.byKind.set(writer.kind, writer);
	}

	writerForTarget(targetId: string): ManagementWriter {
		const parsed = parseTargetId(targetId);
		if (!parsed) throw new Error(`invalid management target id: ${targetId}`);
		const writer = this.byKind.get(parsed.kind);
		if (!writer) throw new Error(`no writer registered for ${parsed.kind}`);
		return writer;
	}

	async resolve(targetId: string): Promise<ManagementResolvedTarget | null> {
		return this.writerForTarget(targetId).resolve(targetId);
	}
}

/** Deterministic duplicate handling before any writer preflight or mutation. */
export function coalesceManagementChangeRequests(
	requests: readonly ManagementChangeRequest[],
): ManagementChangeRequest[] {
	const byTarget = new Map<string, ManagementChangeRequest>();
	for (const request of requests) {
		const previous = byTarget.get(request.targetId);
		if (!previous) {
			byTarget.set(request.targetId, request);
			continue;
		}
		if (
			previous.observedRevision !== request.observedRevision ||
			canonicalJsonString(previous.desiredValue) !==
				canonicalJsonString(request.desiredValue)
		) {
			throw new Error(`conflicting duplicate target: ${request.targetId}`);
		}
	}
	return [...byTarget.values()].sort((a, b) =>
		a.targetId.localeCompare(b.targetId),
	);
}

export function rejectedPreflight(
	code: ManagementRejectCode,
	reason: string,
): ManagementPreflightResult {
	return { ok: false, code, reason };
}

export function preparedChange(input: {
	writer: ManagementWriter;
	target: ManagementResolvedTarget;
	newValue: unknown;
}): ManagementPreflightResult {
	const change: ManagementPreparedChange = {
		targetId: input.target.targetId,
		kind: input.target.kind,
		writerId: input.writer.id,
		oldValue: input.target.currentValue,
		newValue: input.newValue,
		sourceRevision: input.target.sourceRevision,
		consequence: input.target.writeCapability.consequence,
		requiresAcknowledgement:
			input.target.writeCapability.requiresAcknowledgement,
	};
	return {
		ok: true,
		status:
			canonicalJsonString(change.oldValue) ===
			canonicalJsonString(change.newValue)
				? "no_op"
				: "ready",
		change,
	};
}
