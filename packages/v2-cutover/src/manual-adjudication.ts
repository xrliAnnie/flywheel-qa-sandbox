import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CutoverLedger, type ManualAdjudicationRecord } from "./ledger.js";
import type { CutoverTargetManifest } from "./manifest.js";
import {
	finalizeMigrationPlan,
	type LegacyMigrationDecision,
	type LegacyMigrationPlan,
} from "./migration.js";

interface AdjudicationPlanEvidence {
	windowId: string;
	epoch: number;
	decisions: LegacyMigrationDecision[];
}

function malformedPlan(path: string, detail: string): never {
	throw new Error(
		`manual adjudication migration plan is malformed at ${path}: ${detail}`,
	);
}

function planObject(
	value: unknown,
	path: string,
	name: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		malformedPlan(path, `${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function planString(value: unknown, path: string, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		malformedPlan(path, `${name} must be a non-empty string`);
	}
	return value;
}

function planInteger(value: unknown, path: string, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		malformedPlan(path, `${name} must be a non-negative safe integer`);
	}
	return value as number;
}

function planBoolean(value: unknown, path: string, name: string): boolean {
	if (typeof value !== "boolean") {
		malformedPlan(path, `${name} must be a boolean`);
	}
	return value;
}

function planArray(value: unknown, path: string, name: string): unknown[] {
	if (!Array.isArray(value)) {
		malformedPlan(path, `${name} must be an array`);
	}
	return value;
}

function planStrings(value: unknown, path: string, name: string): string[] {
	return planArray(value, path, name).map((entry, index) =>
		planString(entry, path, `${name}[${index}]`),
	);
}

function planEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
	name: string,
): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		malformedPlan(path, `${name} has an unsupported value`);
	}
	return value as T;
}

function planDecision(
	value: unknown,
	path: string,
	index: number,
): LegacyMigrationDecision {
	const name = `decisions[${index}]`;
	const row = planObject(value, path, name);
	const payloadDigest = planString(
		row.payloadDigest,
		path,
		`${name}.payloadDigest`,
	);
	if (!/^[0-9a-f]{64}$/.test(payloadDigest)) {
		malformedPlan(path, `${name}.payloadDigest must be lowercase SHA-256`);
	}
	return {
		nativeId: planString(row.nativeId, path, `${name}.nativeId`),
		sourceType: planEnum(
			row.sourceType,
			["messages", "lead_inbox", "json"] as const,
			path,
			`${name}.sourceType`,
		),
		sourceKind: planEnum(
			row.sourceKind,
			["discord", "legacy-comm", "legacy-json"] as const,
			path,
			`${name}.sourceKind`,
		),
		sourceId: planString(row.sourceId, path, `${name}.sourceId`),
		messageUid: planString(row.messageUid, path, `${name}.messageUid`),
		payload: planString(row.payload, path, `${name}.payload`),
		payloadDigest,
		toAgent: planString(row.toAgent, path, `${name}.toAgent`),
		kind: planString(row.kind, path, `${name}.kind`),
		retentionClass: planEnum(
			row.retentionClass,
			["notice", "business", "dlq"] as const,
			path,
			`${name}.retentionClass`,
		),
		createdAt: planString(row.createdAt, path, `${name}.createdAt`),
		disposition: planEnum(
			row.disposition,
			["migrate", "dead", "tombstone", "manual"] as const,
			path,
			`${name}.disposition`,
		),
		reason: planString(row.reason, path, `${name}.reason`),
	};
}

function validateMigrationPlanEvidence(
	value: unknown,
	path: string,
): AdjudicationPlanEvidence {
	const plan = planObject(value, path, "plan");
	const windowId = planString(plan.windowId, path, "windowId");
	const epoch = planInteger(plan.epoch, path, "epoch");
	if (epoch === 0) malformedPlan(path, "epoch must be positive");
	const nowIso = planString(plan.nowIso, path, "nowIso");
	if (
		!Number.isFinite(Date.parse(nowIso)) ||
		new Date(Date.parse(nowIso)).toISOString() !== nowIso
	) {
		malformedPlan(path, "nowIso must be canonical UTC ISO-8601");
	}
	const decisions = planArray(plan.decisions, path, "decisions").map(
		(entry, index) => planDecision(entry, path, index),
	);
	const canonicalKeys = decisions.map(
		(decision) => `${decision.sourceKind}\0${decision.sourceId}`,
	);
	if (new Set(canonicalKeys).size !== canonicalKeys.length) {
		malformedPlan(path, "decisions contain duplicate canonical keys");
	}

	const leadLiveness = planObject(plan.leadLiveness, path, "leadLiveness");
	planStrings(
		leadLiveness.authoritativeLiveLeadIds,
		path,
		"leadLiveness.authoritativeLiveLeadIds",
	);
	planStrings(
		leadLiveness.unknownRecipientIds,
		path,
		"leadLiveness.unknownRecipientIds",
	);
	const runnerLiveness = planObject(
		plan.runnerLiveness,
		path,
		"runnerLiveness",
	);
	if (
		runnerLiveness.authoritativeDatabase !== null &&
		typeof runnerLiveness.authoritativeDatabase !== "string"
	) {
		malformedPlan(
			path,
			"runnerLiveness.authoritativeDatabase must be a string or null",
		);
	}
	planStrings(
		runnerLiveness.liveSessionIds,
		path,
		"runnerLiveness.liveSessionIds",
	);
	planStrings(
		runnerLiveness.terminalSessionIds,
		path,
		"runnerLiveness.terminalSessionIds",
	);
	const ignoredStatuses = planObject(
		runnerLiveness.ignoredStatusCounts,
		path,
		"runnerLiveness.ignoredStatusCounts",
	);
	for (const [status, count] of Object.entries(ignoredStatuses)) {
		planString(status, path, "runnerLiveness.ignoredStatusCounts key");
		planInteger(count, path, `runnerLiveness.ignoredStatusCounts.${status}`);
	}
	planArray(plan.manualAdjudications, path, "manualAdjudications");
	const inputSnapshot = planObject(plan.inputSnapshot, path, "inputSnapshot");
	for (const field of ["messages", "leadInbox", "jsonEntries"] as const) {
		planArray(inputSnapshot[field], path, `inputSnapshot.${field}`);
	}

	const domains = planObject(plan.domains, path, "domains");
	const domainA = planObject(domains.a, path, "domains.a");
	const domainB = planObject(domains.b, path, "domains.b");
	const domainC = planObject(domains.c, path, "domains.c");
	for (const field of ["messages", "leadInbox", "json"] as const) {
		planInteger(domainA[field], path, `domains.a.${field}`);
		planInteger(domainC[field], path, `domains.c.${field}`);
	}
	for (const field of [
		"deliveryObligations",
		"receiptObligations",
		"journalUnfinished",
		"blockingManual",
	] as const) {
		planInteger(domainB[field], path, `domains.b.${field}`);
	}
	const anomalies = planObject(domainC.anomalies, path, "domains.c.anomalies");
	for (const field of [
		"disposedButUnconsumed",
		"processedButUnconsumed",
	] as const) {
		planInteger(anomalies[field], path, `domains.c.anomalies.${field}`);
	}

	const overlaps = planArray(plan.overlapCopies, path, "overlapCopies");
	for (const [index, value] of overlaps.entries()) {
		const overlap = planObject(value, path, `overlapCopies[${index}]`);
		for (const field of ["nativeId", "sourceKind", "sourceId"] as const) {
			planString(overlap[field], path, `overlapCopies[${index}].${field}`);
		}
	}
	const conservation = planObject(plan.conservation, path, "conservation");
	const counts = {
		rawCommUnread: planInteger(
			conservation.rawCommUnread,
			path,
			"conservation.rawCommUnread",
		),
		rawJsonUnread: planInteger(
			conservation.rawJsonUnread,
			path,
			"conservation.rawJsonUnread",
		),
		uniqueCanonical: planInteger(
			conservation.uniqueCanonical,
			path,
			"conservation.uniqueCanonical",
		),
		overlapCopies: planInteger(
			conservation.overlapCopies,
			path,
			"conservation.overlapCopies",
		),
		migrated: planInteger(conservation.migrated, path, "conservation.migrated"),
		dead: planInteger(conservation.dead, path, "conservation.dead"),
		tombstoned: planInteger(
			conservation.tombstoned,
			path,
			"conservation.tombstoned",
		),
		manual: planInteger(conservation.manual, path, "conservation.manual"),
		conflicts: planInteger(
			conservation.conflicts,
			path,
			"conservation.conflicts",
		),
	};
	const dispositionCount = (
		disposition: LegacyMigrationDecision["disposition"],
	) =>
		decisions.filter((decision) => decision.disposition === disposition).length;
	const balanced =
		counts.rawCommUnread + counts.rawJsonUnread ===
			decisions.length + overlaps.length &&
		decisions.length ===
			dispositionCount("migrate") +
				dispositionCount("dead") +
				dispositionCount("tombstone") +
				dispositionCount("manual");
	if (
		counts.rawCommUnread !==
			planInteger(domainA.messages, path, "domains.a.messages") +
				planInteger(domainA.leadInbox, path, "domains.a.leadInbox") ||
		counts.rawJsonUnread !==
			planInteger(domainA.json, path, "domains.a.json") ||
		counts.uniqueCanonical !== decisions.length ||
		counts.overlapCopies !== overlaps.length ||
		counts.migrated !== dispositionCount("migrate") ||
		counts.dead !== dispositionCount("dead") ||
		counts.tombstoned !== dispositionCount("tombstone") ||
		counts.manual !== dispositionCount("manual") ||
		planBoolean(conservation.balanced, path, "conservation.balanced") !==
			balanced
	) {
		malformedPlan(path, "conservation does not match decisions and domains");
	}
	const noOutstandingB = [
		domainB.deliveryObligations,
		domainB.receiptObligations,
		domainB.journalUnfinished,
		domainB.blockingManual,
	].every((count) => count === 0);
	const expectedGo =
		balanced && counts.manual === 0 && counts.conflicts === 0 && noOutstandingB;
	if (planBoolean(plan.go, path, "go") !== expectedGo) {
		malformedPlan(path, "go does not match conservation and domain B");
	}
	return { windowId, epoch, decisions };
}

function readMigrationPlan(
	target: CutoverTargetManifest,
): AdjudicationPlanEvidence {
	const path = join(target.evidenceDir, "migration-plan.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`manual adjudication requires a readable migration plan at ${path}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return validateMigrationPlanEvidence(parsed, path);
}

export interface ManualAdjudicationInput {
	sourceKind: ManualAdjudicationRecord["sourceKind"];
	sourceId: string;
	payloadDigest: string;
	disposition: ManualAdjudicationRecord["disposition"];
	reason: string;
}

function exactManualDecision(
	plan: AdjudicationPlanEvidence,
	input: ManualAdjudicationInput,
): LegacyMigrationDecision {
	const matches = plan.decisions.filter(
		(decision) =>
			decision.sourceKind === input.sourceKind &&
			decision.sourceId === input.sourceId,
	);
	if (matches.length !== 1) {
		throw new Error(
			`manual adjudication must identify exactly one canonical row: ${input.sourceKind}/${input.sourceId}`,
		);
	}
	const decision = matches[0] as LegacyMigrationDecision;
	if (decision.disposition !== "manual") {
		throw new Error(
			`manual adjudication target is not manual: ${input.sourceKind}/${input.sourceId}`,
		);
	}
	if (decision.payloadDigest !== input.payloadDigest) {
		throw new Error(
			`manual adjudication payload digest mismatch for ${input.sourceKind}/${input.sourceId}`,
		);
	}
	return decision;
}

export function adjudicateManual(
	target: CutoverTargetManifest,
	input: ManualAdjudicationInput,
): ManualAdjudicationRecord {
	if (target.windowId.trim().length === 0) {
		throw new TypeError("manual adjudication requires a windowId");
	}
	if (!Number.isSafeInteger(target.epoch) || target.epoch <= 0) {
		throw new TypeError("manual adjudication requires a positive epoch");
	}
	const reason = input.reason.trim();
	if (reason.length === 0) {
		throw new TypeError("manual adjudication reason must not be empty");
	}
	if (!/^[0-9a-f]{64}$/.test(input.payloadDigest)) {
		throw new TypeError(
			"manual adjudication payload digest must be lowercase SHA-256",
		);
	}
	const ledger = new CutoverLedger(target.ledgerDir);
	const existing = ledger
		.manualAdjudications()
		.find(
			(record) =>
				record.sourceKind === input.sourceKind &&
				record.sourceId === input.sourceId,
		);
	if (existing) {
		if (
			existing.windowId !== target.windowId ||
			existing.epoch !== target.epoch ||
			existing.payloadDigest !== input.payloadDigest ||
			existing.disposition !== input.disposition ||
			existing.reason !== reason
		) {
			throw new Error(
				`manual adjudication conflicts with the ledger for ${input.sourceKind}/${input.sourceId}`,
			);
		}
		return ledger.recordManualAdjudication(existing);
	}
	const plan = readMigrationPlan(target);
	if (plan.windowId !== target.windowId) {
		throw new Error(
			`manual adjudication migration plan window ${plan.windowId} does not match target window ${target.windowId}`,
		);
	}
	if (plan.epoch !== target.epoch) {
		throw new Error(
			`manual adjudication migration plan epoch ${plan.epoch} does not match target epoch ${target.epoch}`,
		);
	}
	const decision = exactManualDecision(plan, input);
	const record: ManualAdjudicationRecord = {
		v: 1,
		windowId: target.windowId,
		epoch: target.epoch,
		sourceKind: input.sourceKind,
		sourceId: input.sourceId,
		payloadDigest: input.payloadDigest,
		disposition: input.disposition,
		reason,
		originalReason: decision.reason,
	};
	return ledger.recordManualAdjudication(record);
}

function canonicalKey(input: { sourceKind: string; sourceId: string }): string {
	return `${input.sourceKind}\0${input.sourceId}`;
}

export function applyManualAdjudications(
	target: CutoverTargetManifest,
	plan: LegacyMigrationPlan,
	records: ManualAdjudicationRecord[],
): LegacyMigrationPlan {
	if (plan.epoch !== target.epoch) {
		throw new Error(
			`manual adjudication plan epoch ${plan.epoch} does not match target epoch ${target.epoch}`,
		);
	}
	const byKey = new Map(
		plan.decisions.map((decision) => [canonicalKey(decision), decision]),
	);
	const adjudications = [...records].sort((left, right) =>
		canonicalKey(left).localeCompare(canonicalKey(right)),
	);
	const replacements = new Map<string, LegacyMigrationDecision>();
	for (const record of adjudications) {
		if (record.windowId !== target.windowId || record.epoch !== target.epoch) {
			throw new Error(
				`manual adjudication belongs to a different window/epoch: ${record.sourceKind}/${record.sourceId}`,
			);
		}
		const key = canonicalKey(record);
		const decision = byKey.get(key);
		if (!decision || decision.disposition !== "manual") {
			throw new Error(
				`manual adjudication no longer matches a manual row: ${record.sourceKind}/${record.sourceId}`,
			);
		}
		if (
			decision.payloadDigest !== record.payloadDigest ||
			decision.reason !== record.originalReason
		) {
			throw new Error(
				`manual adjudication evidence changed for ${record.sourceKind}/${record.sourceId}`,
			);
		}
		replacements.set(key, {
			...decision,
			disposition: record.disposition,
			retentionClass:
				record.disposition === "tombstone"
					? "notice"
					: record.disposition === "migrate"
						? "business"
						: decision.retentionClass,
			reason: `manual adjudication: ${record.reason} (original: ${record.originalReason})`,
		});
	}
	const decisions = plan.decisions.map(
		(decision) => replacements.get(canonicalKey(decision)) ?? decision,
	);
	return finalizeMigrationPlan(plan, decisions, adjudications);
}
