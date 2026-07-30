import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import { FenceViolation, type Kernel, type WriteTx } from "flywheel-v2-kernel";
import type { ManualAdjudicationRecord } from "./ledger.js";

export interface LegacyCommMessage {
	source: "messages";
	project: string;
	id: string;
	fromAgent: string;
	toAgent: string;
	type: "question" | "response" | "instruction" | "progress" | "ack_receipt";
	content: string;
	readAt: string | null;
	relayState: "open" | "protected" | "terminal_disposed";
	createdAt: string;
	expiresAt: string;
	logicalEventId: string | null;
}

export interface LegacyLeadInboxRow {
	source: "lead_inbox";
	project: string;
	id: string;
	toLead: string;
	sourceName: string;
	type: string;
	messageClass: "protocol" | "model";
	content: string;
	refMessageId: string | null;
	createdAt: string;
	deadlineAt: string | null;
	carrier: "inbox" | "external";
	disposition: string | null;
	deliveredAt: string | null;
	consumedAt: string | null;
	processedAt: string | null;
	disposedAt: string | null;
	receiptExemptReason: "internal_mirror" | null;
}

export interface LegacyJsonEntry {
	source: "json";
	project: string;
	team: string;
	relativePath: string;
	index: number;
	toAgent: string;
	from: string;
	text: string;
	timestamp: string;
	read: boolean;
	flywheelId?: string;
}

export interface LegacyAgentState {
	kind: "lead" | "runner";
	terminal: boolean;
}

export interface LegacyRunnerLivenessEvidence {
	authoritativeDatabase: string | null;
	liveSessionIds: string[];
	terminalSessionIds: string[];
	ignoredStatusCounts: Record<string, number>;
}

export interface JournalUnfinished {
	journalPath: string;
	count: number;
}

export type LegacyMigrationDisposition =
	| "migrate"
	| "dead"
	| "tombstone"
	| "manual";

export interface LegacyMigrationDecision {
	nativeId: string;
	sourceType: "messages" | "lead_inbox" | "json";
	sourceKind: "discord" | "legacy-comm" | "legacy-json";
	sourceId: string;
	messageUid: string;
	payload: string;
	payloadDigest: string;
	toAgent: string;
	kind: string;
	retentionClass: "notice" | "business" | "dlq";
	createdAt: string;
	disposition: LegacyMigrationDisposition;
	reason: string;
}

interface ClassifiedRecord {
	decision: LegacyMigrationDecision;
	conflictReason?: string;
}

export interface LegacyMigrationPlan {
	windowId: string | null;
	epoch: number;
	nowIso: string;
	leadLiveness: {
		authoritativeLiveLeadIds: string[];
		unknownRecipientIds: string[];
	};
	runnerLiveness: LegacyRunnerLivenessEvidence;
	manualAdjudications: ManualAdjudicationRecord[];
	inputSnapshot: {
		messages: LegacyCommMessage[];
		leadInbox: LegacyLeadInboxRow[];
		jsonEntries: LegacyJsonEntry[];
	};
	domains: {
		a: { messages: number; leadInbox: number; json: number };
		b: {
			deliveryObligations: number;
			receiptObligations: number;
			journalUnfinished: number;
			blockingManual: number;
		};
		c: {
			messages: number;
			leadInbox: number;
			json: number;
			anomalies: {
				disposedButUnconsumed: number;
				processedButUnconsumed: number;
			};
		};
	};
	decisions: LegacyMigrationDecision[];
	overlapCopies: Array<{
		nativeId: string;
		sourceKind: string;
		sourceId: string;
	}>;
	conservation: {
		rawCommUnread: number;
		rawJsonUnread: number;
		uniqueCanonical: number;
		overlapCopies: number;
		migrated: number;
		dead: number;
		tombstoned: number;
		manual: number;
		conflicts: number;
		balanced: boolean;
	};
	go: boolean;
}

type CommRecord = LegacyCommMessage | LegacyLeadInboxRow;

function nonEmpty(value: string, name: string): string {
	if (value.trim().length === 0) {
		throw new TypeError(`${name} must not be empty`);
	}
	return value;
}

function iso(value: string, name: string): string {
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
		throw new TypeError(`${name} must be canonical UTC ISO-8601`);
	}
	return value;
}

function legacyIso(value: string, name: string): string {
	const direct = Date.parse(value);
	const sqliteUtc =
		Number.isFinite(direct) || /(?:Z|[+-]\d\d:\d\d)$/.test(value)
			? direct
			: Date.parse(`${value.replace(" ", "T")}Z`);
	if (!Number.isFinite(sqliteUtc)) {
		throw new TypeError(`${name} must be a parseable timestamp`);
	}
	return new Date(sqliteUtc).toISOString();
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: Record<string, unknown>): string {
	const sorted = Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
	);
	return JSON.stringify(sorted);
}

function isMessageA(row: LegacyCommMessage): boolean {
	return row.readAt === null && row.relayState !== "terminal_disposed";
}

function isLeadA(row: LegacyLeadInboxRow): boolean {
	return (
		row.carrier === "inbox" &&
		row.consumedAt === null &&
		row.processedAt === null &&
		row.disposedAt === null &&
		row.disposition === null
	);
}

function isDeliveryObligation(row: LegacyLeadInboxRow): boolean {
	return (
		row.carrier === "external" &&
		row.deliveredAt === null &&
		row.disposedAt === null
	);
}

function isReceiptObligation(row: LegacyLeadInboxRow): boolean {
	return (
		row.carrier === "external" &&
		row.deliveredAt !== null &&
		row.processedAt === null &&
		row.disposedAt === null &&
		row.receiptExemptReason === null
	);
}

type RecipientState = "live-lead" | "live-runner" | "terminal" | "unknown";

function recipientState(
	agents: Record<string, LegacyAgentState>,
	agentId: string,
): RecipientState {
	const agent = agents[agentId];
	if (!agent) return "unknown";
	if (agent.terminal) return "terminal";
	return agent.kind === "lead" ? "live-lead" : "live-runner";
}

function discordClaims(row: CommRecord): string[] {
	const claims: string[] = [];
	if (row.source === "lead_inbox") {
		if (/^discord(?:$|[_:-])/i.test(row.sourceName)) {
			if (row.refMessageId?.trim()) claims.push(row.refMessageId.trim());
			try {
				const parsed = JSON.parse(row.content) as Record<string, unknown>;
				for (const key of [
					"discord_message_id",
					"source_message_id",
					"message_id",
				]) {
					if (typeof parsed[key] === "string" && parsed[key].trim()) {
						claims.push(parsed[key].trim());
					}
				}
			} catch {
				// Plain text is valid; ref_message_id remains the durable claim.
			}
			if (claims.length === 0) return [""];
		}
		return claims;
	}
	if (row.logicalEventId?.startsWith("discord:")) {
		claims.push(row.logicalEventId.slice("discord:".length).trim());
	}
	try {
		const parsed = JSON.parse(row.content) as Record<string, unknown>;
		const claimedDiscord =
			parsed.source === "discord" ||
			parsed.source_kind === "discord" ||
			typeof parsed.discord_message_id === "string";
		if (claimedDiscord) {
			for (const key of [
				"discord_message_id",
				"source_message_id",
				"message_id",
			]) {
				if (typeof parsed[key] === "string" && parsed[key].trim()) {
					claims.push(parsed[key].trim());
				}
			}
			if (claims.length === 0) claims.push("");
		}
	} catch {
		// Messages without structured provenance are legacy-comm.
	}
	return claims;
}

function commCanonical(row: CommRecord): {
	sourceKind: "discord" | "legacy-comm";
	sourceId: string;
	invalid?: string;
} {
	const claims = discordClaims(row);
	if (claims.length > 0) {
		const unique = new Set(claims);
		if (unique.size !== 1 || unique.has("")) {
			return {
				sourceKind: "legacy-comm",
				sourceId:
					row.source === "messages"
						? `${row.project}/${row.id}`
						: `${row.project}/inbox/${row.id}`,
				invalid: "claimed Discord provenance is missing or conflicting",
			};
		}
		return { sourceKind: "discord", sourceId: claims[0] as string };
	}
	return {
		sourceKind: "legacy-comm",
		sourceId:
			row.source === "messages"
				? `${row.project}/${row.id}`
				: `${row.project}/inbox/${row.id}`,
	};
}

function jsonCanonical(row: LegacyJsonEntry): {
	sourceKind: "legacy-comm" | "legacy-json";
	sourceId: string;
} {
	if (row.flywheelId?.trim()) {
		return {
			sourceKind: "legacy-comm",
			sourceId: `${row.project}/${row.flywheelId.trim()}`,
		};
	}
	const key = stableJson({
		team: row.team,
		relative_path: row.relativePath,
		from: row.from,
		timestamp: row.timestamp,
		text: row.text,
		collision_ordinal: row.index,
	});
	return { sourceKind: "legacy-json", sourceId: sha256(key) };
}

function classifyComm(
	row: CommRecord,
	agents: Record<string, LegacyAgentState>,
	nowIso: string,
): LegacyMigrationDecision {
	const canonical = commCanonical(row);
	const payload = row.content;
	const toAgent = row.source === "messages" ? row.toAgent : row.toLead;
	const nativeId = row.id;
	const messageUid = nativeId;
	const createdAt =
		row.source === "messages"
			? legacyIso(row.createdAt, "messages.createdAt")
			: legacyIso(row.createdAt, "lead_inbox.createdAt");
	const base = {
		nativeId,
		sourceType: row.source,
		sourceKind: canonical.sourceKind,
		sourceId: canonical.sourceId,
		messageUid,
		payload,
		payloadDigest: sha256(payload),
		toAgent,
		kind: row.type,
		createdAt,
	};
	if (canonical.invalid) {
		return {
			...base,
			retentionClass: "dlq",
			disposition: "manual",
			reason: canonical.invalid,
		};
	}
	if (row.source === "messages") {
		const notice = row.type === "progress" || row.type === "ack_receipt";
		const expired = Date.parse(row.expiresAt) < Date.parse(nowIso);
		if (expired) {
			return {
				...base,
				retentionClass: notice ? "notice" : "business",
				disposition: notice ? "tombstone" : "dead",
				reason: "messages row expired before cutover",
			};
		}
		if (notice) {
			return {
				...base,
				retentionClass: "notice",
				disposition: "tombstone",
				reason: "notice rows do not replay across cutover",
			};
		}
		const recipient = recipientState(agents, row.toAgent);
		if (recipient !== "live-lead") {
			return {
				...base,
				retentionClass:
					recipient === "unknown" || recipient === "live-runner"
						? "dlq"
						: "business",
				disposition:
					recipient === "unknown" || recipient === "live-runner"
						? "manual"
						: "dead",
				reason:
					recipient === "unknown"
						? "business recipient liveness is unknown"
						: recipient === "live-runner"
							? "business recipient is a live Runner, not a live Lead"
							: "business recipient is explicitly terminal",
			};
		}
		return {
			...base,
			retentionClass: "business",
			disposition: "migrate",
			reason: "unread business row for live Lead",
		};
	}

	const expired =
		row.deadlineAt !== null && Date.parse(row.deadlineAt) < Date.parse(nowIso);
	if (expired) {
		return {
			...base,
			retentionClass: row.messageClass === "protocol" ? "notice" : "business",
			disposition: row.messageClass === "protocol" ? "tombstone" : "dead",
			reason: "lead inbox deadline expired before cutover",
		};
	}
	if (row.messageClass === "protocol") {
		return {
			...base,
			retentionClass: "notice",
			disposition: "tombstone",
			reason: "protocol rows do not replay across cutover",
		};
	}
	const recipient = recipientState(agents, row.toLead);
	if (recipient !== "live-lead") {
		return {
			...base,
			retentionClass:
				recipient === "unknown" || recipient === "live-runner"
					? "dlq"
					: "business",
			disposition:
				recipient === "unknown" || recipient === "live-runner"
					? "manual"
					: "dead",
			reason:
				recipient === "unknown"
					? "model recipient liveness is unknown"
					: recipient === "live-runner"
						? "model recipient is a live Runner, not a live Lead"
						: "model recipient is explicitly terminal",
		};
	}
	return {
		...base,
		retentionClass: "business",
		disposition: "migrate",
		reason: "unconsumed model row for live Lead",
	};
}

function classifyJson(
	row: LegacyJsonEntry,
	agents: Record<string, LegacyAgentState>,
	canonical: {
		sourceKind: "discord" | "legacy-comm" | "legacy-json";
		sourceId: string;
	},
): LegacyMigrationDecision {
	const payloadDigest = sha256(row.text);
	const recipient = recipientState(agents, row.toAgent);
	const requiresManual = recipient !== "terminal";
	return {
		nativeId: row.flywheelId?.trim() || `${row.relativePath}#${row.index}`,
		sourceType: "json",
		sourceKind: canonical.sourceKind,
		sourceId: canonical.sourceId,
		messageUid: `legacy-json-${sha256(
			`${row.project}\0${row.relativePath}\0${row.index}`,
		)}`,
		payload: row.text,
		payloadDigest,
		toAgent: row.toAgent,
		kind: "legacy-json",
		retentionClass: requiresManual ? "dlq" : "notice",
		createdAt: legacyIso(row.timestamp, "json.timestamp"),
		disposition: requiresManual ? "manual" : "tombstone",
		reason:
			recipient === "live-lead"
				? "JSON-only row for a live Lead requires manual classification"
				: recipient === "live-runner"
					? "JSON-only row for a live Runner requires manual classification"
					: recipient === "unknown"
						? "JSON-only recipient liveness is unknown"
						: "JSON-only row has an explicitly terminal or non-Lead recipient",
	};
}

function assertInputs(input: {
	nowIso: string;
	epoch: number;
	windowId?: string;
	authoritativeLiveLeadIds?: string[];
	runnerLiveness?: LegacyRunnerLivenessEvidence;
	messages: LegacyCommMessage[];
	leadInbox: LegacyLeadInboxRow[];
	jsonEntries: LegacyJsonEntry[];
	journalUnfinished: JournalUnfinished[];
}): void {
	iso(input.nowIso, "nowIso");
	if (!Number.isSafeInteger(input.epoch) || input.epoch <= 0) {
		throw new TypeError("epoch must be a positive safe integer");
	}
	if (input.windowId !== undefined) {
		nonEmpty(input.windowId, "windowId");
	}
	const authoritativeLiveLeadIds = input.authoritativeLiveLeadIds ?? [];
	for (const leadId of authoritativeLiveLeadIds) {
		nonEmpty(leadId, "authoritativeLiveLeadIds");
	}
	if (
		new Set(authoritativeLiveLeadIds).size !== authoritativeLiveLeadIds.length
	) {
		throw new TypeError("authoritativeLiveLeadIds must not contain duplicates");
	}
	for (const row of [...input.messages, ...input.leadInbox]) {
		nonEmpty(row.project, "project");
		nonEmpty(row.id, "legacy id");
	}
	for (const row of input.jsonEntries) {
		nonEmpty(row.project, "project");
		nonEmpty(row.relativePath, "relativePath");
		if (!Number.isSafeInteger(row.index) || row.index < 0) {
			throw new TypeError("JSON index must be a non-negative safe integer");
		}
	}
	for (const journal of input.journalUnfinished) {
		nonEmpty(journal.journalPath, "journalPath");
		if (!Number.isSafeInteger(journal.count) || journal.count < 0) {
			throw new TypeError("journal unfinished count must be non-negative");
		}
	}
}

export function finalizeMigrationPlan(
	plan: LegacyMigrationPlan,
	decisions: LegacyMigrationDecision[] = plan.decisions,
	manualAdjudications: ManualAdjudicationRecord[] = plan.manualAdjudications,
): LegacyMigrationPlan {
	const count = (disposition: LegacyMigrationDisposition) =>
		decisions.filter((row) => row.disposition === disposition).length;
	const conservation = {
		...plan.conservation,
		uniqueCanonical: decisions.length,
		overlapCopies: plan.overlapCopies.length,
		migrated: count("migrate"),
		dead: count("dead"),
		tombstoned: count("tombstone"),
		manual: count("manual"),
		balanced:
			plan.conservation.rawCommUnread + plan.conservation.rawJsonUnread ===
				decisions.length + plan.overlapCopies.length &&
			decisions.length ===
				count("migrate") + count("dead") + count("tombstone") + count("manual"),
	};
	const noOutstandingB =
		plan.domains.b.deliveryObligations === 0 &&
		plan.domains.b.receiptObligations === 0 &&
		plan.domains.b.journalUnfinished === 0 &&
		plan.domains.b.blockingManual === 0;
	return {
		...plan,
		manualAdjudications: manualAdjudications.map((record) =>
			structuredClone(record),
		),
		decisions,
		conservation,
		go:
			conservation.balanced &&
			conservation.manual === 0 &&
			conservation.conflicts === 0 &&
			noOutstandingB,
	};
}

export function buildMigrationPlan(input: {
	nowIso: string;
	epoch: number;
	windowId?: string;
	authoritativeLiveLeadIds?: string[];
	runnerLiveness?: LegacyRunnerLivenessEvidence;
	agents: Record<string, LegacyAgentState>;
	messages: LegacyCommMessage[];
	leadInbox: LegacyLeadInboxRow[];
	jsonEntries: LegacyJsonEntry[];
	journalUnfinished: JournalUnfinished[];
}): LegacyMigrationPlan {
	assertInputs(input);
	const authoritativeLiveLeadIds = [
		...(input.authoritativeLiveLeadIds ?? []),
	].sort();
	const runnerLiveness: LegacyRunnerLivenessEvidence = input.runnerLiveness
		? {
				authoritativeDatabase: input.runnerLiveness.authoritativeDatabase,
				liveSessionIds: [...input.runnerLiveness.liveSessionIds].sort(),
				terminalSessionIds: [...input.runnerLiveness.terminalSessionIds].sort(),
				ignoredStatusCounts: Object.fromEntries(
					Object.entries(input.runnerLiveness.ignoredStatusCounts).sort(
						([left], [right]) => left.localeCompare(right),
					),
				),
			}
		: {
				authoritativeDatabase: null,
				liveSessionIds: [],
				terminalSessionIds: [],
				ignoredStatusCounts: {},
			};
	const effectiveAgents = structuredClone(input.agents);
	for (const leadId of authoritativeLiveLeadIds) {
		const observed = effectiveAgents[leadId];
		if (observed?.kind === "runner") {
			throw new Error(
				`authoritative live Lead conflicts with observed runner identity: ${leadId}`,
			);
		}
		effectiveAgents[leadId] = { kind: "lead", terminal: false };
	}
	const messageA = input.messages.filter(isMessageA);
	const leadA = input.leadInbox.filter(isLeadA);
	const jsonA = input.jsonEntries.filter((row) => !row.read);
	const delivery = input.leadInbox.filter(isDeliveryObligation);
	const receipts = input.leadInbox.filter(isReceiptObligation);
	const cMessages = input.messages.filter((row) => !isMessageA(row));
	const cLead = input.leadInbox.filter(
		(row) =>
			!isLeadA(row) && !isDeliveryObligation(row) && !isReceiptObligation(row),
	);
	const cJson = input.jsonEntries.filter((row) => row.read);

	const allComm = [...input.messages, ...input.leadInbox];
	const commByNativeId = new Map<string, CommRecord>();
	for (const row of allComm) {
		const prior = commByNativeId.get(row.id);
		if (prior) {
			throw new Error(
				`legacy native id is ambiguous across comm sources: ${row.id}`,
			);
		}
		commByNativeId.set(row.id, row);
	}
	const aCommIds = new Set<CommRecord>([...messageA, ...leadA]);
	const classified: ClassifiedRecord[] = [
		...messageA.map((row) => ({
			decision: classifyComm(row, effectiveAgents, input.nowIso),
		})),
		...leadA.map((row) => ({
			decision: classifyComm(row, effectiveAgents, input.nowIso),
		})),
	];
	for (const row of jsonA) {
		const flywheelId = row.flywheelId?.trim();
		const linked = !flywheelId ? undefined : commByNativeId.get(flywheelId);
		if (linked) {
			const linkedCanonical = commCanonical(linked);
			const canonical = {
				sourceKind: linkedCanonical.sourceKind,
				sourceId: linkedCanonical.sourceId,
			} as const;
			if (aCommIds.has(linked)) {
				const inherited = classifyComm(linked, effectiveAgents, input.nowIso);
				classified.push({
					decision: {
						...inherited,
						nativeId: flywheelId as string,
						sourceType: "json",
						payload: row.text,
						payloadDigest: sha256(row.text),
						createdAt: legacyIso(row.timestamp, "json.timestamp"),
					},
					...(inherited.payloadDigest !== sha256(row.text)
						? { conflictReason: "JSON/comm payload digest conflict" }
						: {}),
				});
				continue;
			}
			classified.push({
				decision: classifyJson(row, effectiveAgents, canonical),
				...(linkedCanonical.invalid
					? { conflictReason: linkedCanonical.invalid }
					: {}),
			});
			continue;
		}
		classified.push({
			decision: classifyJson(row, effectiveAgents, jsonCanonical(row)),
		});
	}

	const groups = new Map<string, ClassifiedRecord[]>();
	for (const record of classified) {
		const key = `${record.decision.sourceKind}\0${record.decision.sourceId}`;
		const group = groups.get(key) ?? [];
		group.push(record);
		groups.set(key, group);
	}
	const decisions: LegacyMigrationDecision[] = [];
	const overlapCopies: LegacyMigrationPlan["overlapCopies"] = [];
	let conflicts = 0;
	for (const group of groups.values()) {
		const preferred =
			group.find((record) => record.decision.sourceType !== "json") ?? group[0];
		if (!preferred) continue;
		const digests = new Set(
			group.map((record) => record.decision.payloadDigest),
		);
		const conflict =
			digests.size !== 1 ||
			group.some((record) => record.conflictReason !== undefined);
		const decision = conflict
			? {
					...preferred.decision,
					retentionClass: "dlq" as const,
					disposition: "manual" as const,
					reason:
						group.find((record) => record.conflictReason)?.conflictReason ??
						"canonical source has conflicting payload digests",
				}
			: preferred.decision;
		if (conflict) conflicts += 1;
		decisions.push(decision);
		for (const copy of group.slice(1)) {
			overlapCopies.push({
				nativeId: copy.decision.nativeId,
				sourceKind: copy.decision.sourceKind,
				sourceId: copy.decision.sourceId,
			});
		}
	}
	decisions.sort((left, right) =>
		`${left.sourceKind}\0${left.sourceId}`.localeCompare(
			`${right.sourceKind}\0${right.sourceId}`,
		),
	);
	const conservation = {
		rawCommUnread: messageA.length + leadA.length,
		rawJsonUnread: jsonA.length,
		uniqueCanonical: decisions.length,
		overlapCopies: overlapCopies.length,
		migrated: 0,
		dead: 0,
		tombstoned: 0,
		manual: 0,
		conflicts,
		balanced: false,
	};
	const journalUnfinished = input.journalUnfinished.reduce(
		(sum, row) => sum + row.count,
		0,
	);
	const domains = {
		a: {
			messages: messageA.length,
			leadInbox: leadA.length,
			json: jsonA.length,
		},
		b: {
			deliveryObligations: delivery.length,
			receiptObligations: receipts.length,
			journalUnfinished,
			blockingManual: delivery.filter(
				(row) => row.disposition === "delivery_quarantined",
			).length,
		},
		c: {
			messages: cMessages.length,
			leadInbox: cLead.length,
			json: cJson.length,
			anomalies: {
				disposedButUnconsumed: input.leadInbox.filter(
					(row) => row.disposedAt !== null && row.consumedAt === null,
				).length,
				processedButUnconsumed: input.leadInbox.filter(
					(row) =>
						row.processedAt !== null &&
						row.consumedAt === null &&
						row.disposedAt === null,
				).length,
			},
		},
	};
	const unknownRecipientIds = [
		...new Set([
			...messageA.map((row) => row.toAgent),
			...leadA.map((row) => row.toLead),
			...jsonA.map((row) => row.toAgent),
		]),
	]
		.filter((agentId) => recipientState(effectiveAgents, agentId) === "unknown")
		.sort();
	return finalizeMigrationPlan({
		windowId: input.windowId ?? null,
		epoch: input.epoch,
		nowIso: input.nowIso,
		leadLiveness: {
			authoritativeLiveLeadIds,
			unknownRecipientIds,
		},
		runnerLiveness,
		manualAdjudications: [],
		inputSnapshot: {
			messages: structuredClone(input.messages),
			leadInbox: structuredClone(input.leadInbox),
			jsonEntries: structuredClone(input.jsonEntries),
		},
		domains,
		decisions,
		overlapCopies,
		conservation,
		go: false,
	});
}

interface LegacyMessageRow {
	id: string;
	from_agent: string;
	to_agent: string;
	type: LegacyCommMessage["type"];
	content: string;
	read_at: string | null;
	relay_state: LegacyCommMessage["relayState"];
	created_at: string;
	expires_at: string;
	logical_event_id: string | null;
}

interface LegacyInboxRow {
	id: string;
	to_lead: string;
	source: string;
	type: string;
	msg_class: LegacyLeadInboxRow["messageClass"];
	content: string;
	ref_message_id: string | null;
	created_at: string;
	deadline_at: string | null;
	carrier: LegacyLeadInboxRow["carrier"];
	disposition: string | null;
	delivered_at: string | null;
	consumed_at: string | null;
	processed_at: string | null;
	disposed_at: string | null;
	receipt_exempt_reason: "internal_mirror" | null;
}

interface LegacySessionRow {
	execution_id: string;
	lead_id: string | null;
	status: string;
}

interface AuthoritativeRunnerSessionRow {
	execution_id: string;
	status: string;
	session_role: string;
}

interface StockMailboxRow {
	from: string;
	text: string;
	timestamp: string;
	read: boolean;
}

interface StockSidecarRow {
	flywheelId: string;
	status: "pending" | "finalized";
	payloadFingerprint: string;
	mainEntryRef?: { from: string; timestamp: string };
}

function tableExists(db: Database.Database, table: string): boolean {
	return (
		db
			.prepare(
				"SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?",
			)
			.get(table) !== undefined
	);
}

function tableColumns(db: Database.Database, table: string): Set<string> {
	return new Set(
		(
			db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
				name: string;
			}>
		).map((row) => row.name),
	);
}

const TERMINAL_RUNNER_SESSION_STATUSES = new Set([
	"completed",
	"terminated",
	"failed",
	"blocked",
	"timeout",
	"canceled",
	"cancelled",
	"rejected",
	"deferred",
	"shelved",
]);

const LIVE_RUNNER_SESSION_STATUSES = new Set([
	"pending",
	"running",
	"ship_parked",
	"awaiting_review",
	"design_done",
	"approved_to_ship",
]);

function projectForCommDb(path: string): string {
	const project = basename(dirname(resolve(path)));
	return nonEmpty(project, `project derived from ${path}`);
}

function mergeAgent(
	agents: Record<string, LegacyAgentState>,
	agentId: string,
	next: LegacyAgentState,
): void {
	if (!agentId.trim()) return;
	const prior = agents[agentId];
	if (!prior) {
		agents[agentId] = next;
		return;
	}
	if (prior.kind !== next.kind) {
		throw new Error(`legacy agent kind conflict for ${agentId}`);
	}
	agents[agentId] = {
		kind: prior.kind,
		terminal: prior.terminal && next.terminal,
	};
}

function authoritativeRunnerSessionRow(
	value: unknown,
	path: string,
	index: number,
): AuthoritativeRunnerSessionRow {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(
			`authoritative Runner sessions[${index}] must be an object: ${path}`,
		);
	}
	const row = value as Record<string, unknown>;
	const requiredString = (
		field: keyof AuthoritativeRunnerSessionRow,
	): string => {
		const candidate = row[field];
		if (typeof candidate !== "string" || candidate.trim().length === 0) {
			throw new TypeError(
				`authoritative Runner sessions[${index}].${field} must be a non-empty string: ${path}`,
			);
		}
		return candidate.trim();
	};
	return {
		execution_id: requiredString("execution_id"),
		status: requiredString("status"),
		session_role: requiredString("session_role"),
	};
}

function setAuthoritativeRunnerState(
	agents: Record<string, LegacyAgentState>,
	executionId: string,
	terminal: boolean | undefined,
): void {
	const prior = agents[executionId];
	if (prior?.kind === "lead") {
		throw new Error(`legacy agent kind conflict for ${executionId}`);
	}
	if (terminal === undefined) {
		delete agents[executionId];
		return;
	}
	agents[executionId] = { kind: "runner", terminal };
}

function fingerprint(row: StockMailboxRow, to: string): string {
	return sha256(`${row.from}|${to}|${row.text}|${row.timestamp}`);
}

function readSidecar(path: string): StockSidecarRow[] {
	if (!existsSync(path)) return [];
	const rows: StockSidecarRow[] = [];
	for (const [index, line] of readFileSync(path, "utf8")
		.split("\n")
		.entries()) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`malformed mailbox sidecar ${path}:${index + 1}`);
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as StockSidecarRow).flywheelId !== "string" ||
			typeof (parsed as StockSidecarRow).payloadFingerprint !== "string" ||
			!["pending", "finalized"].includes((parsed as StockSidecarRow).status)
		) {
			throw new Error(`invalid mailbox sidecar row ${path}:${index + 1}`);
		}
		rows.push(parsed as StockSidecarRow);
	}
	return rows;
}

function mailboxFiles(root: string): string[] {
	const results: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name);
			if (entry.isSymbolicLink()) {
				throw new Error(`mailbox snapshot refuses symbolic link ${path}`);
			}
			if (entry.isDirectory()) {
				walk(path);
			} else if (
				entry.isFile() &&
				entry.name.endsWith(".json") &&
				!entry.name.endsWith(".flywheel.json")
			) {
				results.push(path);
			}
		}
	};
	if (!lstatSync(root).isDirectory()) {
		throw new Error(`JSON inbox root is not a directory: ${root}`);
	}
	walk(resolve(root));
	return results.sort();
}

function identityForMailbox(
	root: string,
	path: string,
): {
	project: string;
	team: string;
	toAgent: string;
	relativePath: string;
} {
	const relativePath = relative(resolve(root), resolve(path));
	const segments = relativePath.split("/");
	const inbox = segments.lastIndexOf("inboxes");
	const team =
		(inbox > 0 ? segments[inbox - 1] : undefined) ?? basename(resolve(root));
	return {
		project: team,
		team,
		toAgent: basename(path, ".json"),
		relativePath,
	};
}

function flywheelIdFor(
	row: StockMailboxRow,
	toAgent: string,
	sidecar: StockSidecarRow[],
	path: string,
): string | undefined {
	const matches = sidecar.filter(
		(entry) =>
			entry.mainEntryRef?.from === row.from &&
			entry.mainEntryRef.timestamp === row.timestamp,
	);
	if (matches.length === 0) return undefined;
	const ids = new Set<string>();
	const expected = fingerprint(row, toAgent);
	for (const match of matches) {
		if (match.payloadFingerprint !== expected) {
			throw new Error(`mailbox sidecar fingerprint conflict for ${path}`);
		}
		ids.add(match.flywheelId);
	}
	if (ids.size !== 1) {
		throw new Error(`mailbox sidecar identity conflict for ${path}`);
	}
	return [...ids][0];
}

export interface LegacySourceSnapshot {
	agents: Record<string, LegacyAgentState>;
	runnerLiveness: LegacyRunnerLivenessEvidence;
	messages: LegacyCommMessage[];
	leadInbox: LegacyLeadInboxRow[];
	jsonEntries: LegacyJsonEntry[];
	journalUnfinished: JournalUnfinished[];
	journalStateCounts: Record<string, Record<string, number>>;
}

export function readLegacySourceSnapshot(input: {
	commDatabases: string[];
	runnerSessionDatabase?: string;
	jsonInboxRoots: string[];
	journalDatabases: string[];
}): LegacySourceSnapshot {
	const messages: LegacyCommMessage[] = [];
	const leadInbox: LegacyLeadInboxRow[] = [];
	const jsonEntries: LegacyJsonEntry[] = [];
	const agents: Record<string, LegacyAgentState> = {};
	const runnerLiveness: LegacyRunnerLivenessEvidence = {
		authoritativeDatabase: input.runnerSessionDatabase ?? null,
		liveSessionIds: [],
		terminalSessionIds: [],
		ignoredStatusCounts: {},
	};
	const journalUnfinished: JournalUnfinished[] = [];
	const journalStateCounts: Record<string, Record<string, number>> = {};
	for (const path of input.commDatabases) {
		if (!existsSync(path)) {
			throw new Error(`legacy comm database is missing: ${path}`);
		}
		const project = projectForCommDb(path);
		const db = new Database(path, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			if (!tableExists(db, "messages") || !tableExists(db, "lead_inbox")) {
				throw new Error(`legacy comm schema is incomplete: ${path}`);
			}
			for (const row of db
				.prepare(
					`SELECT id,from_agent,to_agent,type,content,read_at,
					        relay_state,created_at,expires_at,logical_event_id
					   FROM messages`,
				)
				.all() as LegacyMessageRow[]) {
				messages.push({
					source: "messages",
					project,
					id: row.id,
					fromAgent: row.from_agent,
					toAgent: row.to_agent,
					type: row.type,
					content: row.content,
					readAt: row.read_at,
					relayState: row.relay_state,
					createdAt: row.created_at,
					expiresAt: row.expires_at,
					logicalEventId: row.logical_event_id,
				});
			}
			for (const row of db
				.prepare(
					`SELECT id,to_lead,source,type,msg_class,content,ref_message_id,
					        created_at,deadline_at,carrier,disposition,delivered_at,
					        consumed_at,processed_at,disposed_at,receipt_exempt_reason
					   FROM lead_inbox`,
				)
				.all() as LegacyInboxRow[]) {
				leadInbox.push({
					source: "lead_inbox",
					project,
					id: row.id,
					toLead: row.to_lead,
					sourceName: row.source,
					type: row.type,
					messageClass: row.msg_class,
					content: row.content,
					refMessageId: row.ref_message_id,
					createdAt: row.created_at,
					deadlineAt: row.deadline_at,
					carrier: row.carrier,
					disposition: row.disposition,
					deliveredAt: row.delivered_at,
					consumedAt: row.consumed_at,
					processedAt: row.processed_at,
					disposedAt: row.disposed_at,
					receiptExemptReason: row.receipt_exempt_reason,
				});
			}
			if (tableExists(db, "sessions")) {
				for (const row of db
					.prepare("SELECT execution_id,lead_id,status FROM sessions")
					.all() as LegacySessionRow[]) {
					// Once a dedicated Runner registry is supplied, comm.db
					// session rows are historical hints only. They must not
					// resolve either present or absent Runner identities.
					if (!input.runnerSessionDatabase) {
						mergeAgent(agents, row.execution_id, {
							kind: "runner",
							terminal: row.status !== "running",
						});
					}
					// A running Runner is positive evidence that its Lead survives.
					// A completed/failed Runner is not evidence that the Lead itself
					// terminated, so absence from the authoritative manifest must
					// remain unknown and flow to the manual gate.
					if (row.lead_id && row.status === "running") {
						mergeAgent(agents, row.lead_id, {
							kind: "lead",
							terminal: false,
						});
					}
				}
			}
		} finally {
			db.close();
		}
	}
	if (input.runnerSessionDatabase) {
		const path = input.runnerSessionDatabase;
		if (!existsSync(path)) {
			throw new Error(
				`authoritative Runner session database is missing: ${path}`,
			);
		}
		const db = new Database(path, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			if (!tableExists(db, "sessions")) {
				throw new Error(
					`authoritative Runner session schema is incomplete: ${path}`,
				);
			}
			const columns = tableColumns(db, "sessions");
			for (const required of ["execution_id", "status", "session_role"]) {
				if (!columns.has(required)) {
					throw new Error(
						`authoritative Runner session schema is missing ${required}: ${path}`,
					);
				}
			}
			const seenExecutionIds = new Set<string>();
			for (const [index, value] of db
				.prepare(
					"SELECT execution_id,status,session_role FROM sessions ORDER BY execution_id",
				)
				.all()
				.entries()) {
				const row = authoritativeRunnerSessionRow(value, path, index);
				if (seenExecutionIds.has(row.execution_id)) {
					throw new Error(
						`authoritative Runner registry contains duplicate execution_id ${row.execution_id} (${row.session_role}): ${path}`,
					);
				}
				seenExecutionIds.add(row.execution_id);
				if (TERMINAL_RUNNER_SESSION_STATUSES.has(row.status)) {
					setAuthoritativeRunnerState(agents, row.execution_id, true);
					runnerLiveness.terminalSessionIds.push(row.execution_id);
				} else if (LIVE_RUNNER_SESSION_STATUSES.has(row.status)) {
					setAuthoritativeRunnerState(agents, row.execution_id, false);
					runnerLiveness.liveSessionIds.push(row.execution_id);
				} else {
					setAuthoritativeRunnerState(agents, row.execution_id, undefined);
					runnerLiveness.ignoredStatusCounts[row.status] =
						(runnerLiveness.ignoredStatusCounts[row.status] ?? 0) + 1;
				}
			}
		} finally {
			db.close();
		}
	}
	for (const root of input.jsonInboxRoots) {
		if (!existsSync(root)) {
			throw new Error(`legacy JSON inbox root is missing: ${root}`);
		}
		for (const path of mailboxFiles(root)) {
			const identity = identityForMailbox(root, path);
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				throw new Error(`legacy JSON inbox is malformed: ${path}`);
			}
			if (!Array.isArray(parsed)) {
				throw new Error(`legacy JSON inbox must contain an array: ${path}`);
			}
			const sidecar = readSidecar(`${path}.flywheel.jsonl`);
			for (const [index, raw] of parsed.entries()) {
				if (
					typeof raw !== "object" ||
					raw === null ||
					typeof (raw as StockMailboxRow).from !== "string" ||
					typeof (raw as StockMailboxRow).text !== "string" ||
					typeof (raw as StockMailboxRow).timestamp !== "string" ||
					typeof (raw as StockMailboxRow).read !== "boolean"
				) {
					throw new Error(
						`legacy JSON inbox row is malformed: ${path}#${index}`,
					);
				}
				const row = raw as StockMailboxRow;
				jsonEntries.push({
					source: "json",
					...identity,
					index,
					from: row.from,
					text: row.text,
					timestamp: row.timestamp,
					read: row.read,
					...(flywheelIdFor(row, identity.toAgent, sidecar, path)
						? {
								flywheelId: flywheelIdFor(row, identity.toAgent, sidecar, path),
							}
						: {}),
				});
			}
		}
	}
	for (const path of input.journalDatabases) {
		if (!existsSync(path)) {
			throw new Error(`legacy journal database is missing: ${path}`);
		}
		const db = new Database(path, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			if (!tableExists(db, "journal")) {
				throw new Error(`legacy journal schema is incomplete: ${path}`);
			}
			const counts = Object.fromEntries(
				(
					db
						.prepare(
							"SELECT state,count(*) AS count FROM journal GROUP BY state",
						)
						.all() as Array<{ state: string; count: number }>
				).map((row) => [row.state, row.count]),
			);
			journalStateCounts[path] = counts;
			const count = Object.entries(counts)
				.filter(
					([state]) =>
						!["completed", "ambiguous", "dead_letter"].includes(state),
				)
				.reduce((sum, [, value]) => sum + value, 0);
			journalUnfinished.push({ journalPath: path, count });
		} finally {
			db.close();
		}
	}
	return {
		agents,
		runnerLiveness,
		messages,
		leadInbox,
		jsonEntries,
		journalUnfinished,
		journalStateCounts,
	};
}

function readMeta(tx: WriteTx, key: string): string | undefined {
	return tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
		key,
	})?.value;
}

function writeDecisionEvent(
	tx: WriteTx,
	decision: LegacyMigrationDecision,
	plan: LegacyMigrationPlan,
): boolean {
	const eventUid = `cutover:${decision.disposition}:${sha256(
		`${decision.sourceKind}\0${decision.sourceId}`,
	)}`;
	const payload = JSON.stringify({
		v: 1,
		message_uid: decision.messageUid,
		payload_digest: decision.payloadDigest,
		disposition: decision.disposition,
		reason: decision.reason,
	});
	const result = tx.run(
		`INSERT OR IGNORE INTO events(
		   event_uid,task_id,attempt_id,kind,source_kind,source_id,payload,
		   cutover_epoch,created_at
		 ) VALUES (
		   @eventUid,NULL,NULL,@kind,@sourceKind,@sourceId,@payload,
		   @epoch,@createdAt
		 )`,
		{
			eventUid,
			kind: `cutover.mailbox.${decision.disposition}`,
			sourceKind: decision.sourceKind,
			sourceId: decision.sourceId,
			payload,
			epoch: plan.epoch,
			createdAt: plan.nowIso,
		},
	);
	if (result.changes === 0) {
		const existing = tx.get<{
			kind: string;
			source_kind: string;
			source_id: string;
			payload: string;
			cutover_epoch: number;
		}>(
			`SELECT kind,source_kind,source_id,payload,cutover_epoch
			   FROM events WHERE event_uid=@eventUid`,
			{ eventUid },
		);
		if (
			!existing ||
			existing.kind !== `cutover.mailbox.${decision.disposition}` ||
			existing.source_kind !== decision.sourceKind ||
			existing.source_id !== decision.sourceId ||
			existing.payload !== payload ||
			existing.cutover_epoch !== plan.epoch
		) {
			throw new FenceViolation(
				`migration event collision for ${decision.sourceKind}/${decision.sourceId}`,
			);
		}
		return false;
	}
	return true;
}

export function migrateLegacyPlan(
	kernel: Kernel,
	plan: LegacyMigrationPlan,
): { inserted: number; duplicates: number; events: number } {
	if (!plan.go) {
		const reason =
			plan.conservation.manual > 0
				? "manual classifications remain"
				: "migration plan is NO-GO";
		throw new FenceViolation(`legacy migration rejected: ${reason}`);
	}
	return kernel.write("cutover.migrate-legacy", (tx) => {
		if (readMeta(tx, "cutover_authority_state") !== "cutover") {
			throw new FenceViolation("legacy migration requires cutover authority");
		}
		if (readMeta(tx, "rollback_state") !== "clear") {
			throw new FenceViolation(
				"legacy migration rejected after rollback started",
			);
		}
		if (readMeta(tx, "cutover_epoch") !== String(plan.epoch)) {
			throw new FenceViolation("legacy migration epoch mismatch");
		}
		let inserted = 0;
		let duplicates = 0;
		let events = 0;
		for (const decision of plan.decisions) {
			if (decision.disposition !== "migrate") {
				if (writeDecisionEvent(tx, decision, plan)) events += 1;
				continue;
			}
			// FLY-1543 ⑤: agents is lead-only and the v2dag: namespace belongs to
			// sessions. The 0010 triggers enforce this in DDL; refusing here keeps
			// the import's own error message specific.
			if (decision.toAgent.startsWith("v2dag:")) {
				throw new FenceViolation(
					`migration recipient ${decision.toAgent} uses the session namespace`,
				);
			}
			tx.run(
				`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
				 VALUES (@agentId,'lead',0,NULL,'offline')
				 ON CONFLICT(agent_id) DO NOTHING`,
				{ agentId: decision.toAgent },
			);
			const recipient = tx.get<{ kind: string }>(
				"SELECT kind FROM agents WHERE agent_id=@agentId",
				{ agentId: decision.toAgent },
			);
			if (recipient?.kind !== "lead") {
				throw new FenceViolation(
					`migration recipient collision for ${decision.toAgent}`,
				);
			}
			const result = tx.run(
				`INSERT OR IGNORE INTO mailbox(
				   message_uid,source_kind,source_id,payload,payload_digest,
				   to_agent,kind,retention_class,cutover_epoch,state,retry_count,
				   next_retry_at,created_at,applied_at
				 ) VALUES (
				   @messageUid,@sourceKind,@sourceId,@payload,@payloadDigest,
				   @toAgent,@kind,@retentionClass,@epoch,'pending',0,NULL,
				   @createdAt,NULL
				 )`,
				{ ...decision, epoch: plan.epoch },
			);
			if (result.changes === 1) {
				inserted += 1;
				continue;
			}
			const existing = tx.get<{
				message_uid: string;
				payload: string;
				payload_digest: string;
				to_agent: string;
				kind: string;
				retention_class: string;
				cutover_epoch: number;
				state: string;
			}>(
				`SELECT message_uid,payload,payload_digest,to_agent,kind,
				        retention_class,cutover_epoch,state
				   FROM mailbox
				  WHERE source_kind=@sourceKind AND source_id=@sourceId`,
				decision,
			);
			if (
				!existing ||
				existing.message_uid !== decision.messageUid ||
				existing.payload !== decision.payload ||
				existing.payload_digest !== decision.payloadDigest ||
				existing.to_agent !== decision.toAgent ||
				existing.kind !== decision.kind ||
				existing.retention_class !== decision.retentionClass ||
				existing.cutover_epoch !== plan.epoch ||
				existing.state !== "pending"
			) {
				throw new FenceViolation(
					`migration canonical conflict for ${decision.sourceKind}/${decision.sourceId}`,
				);
			}
			duplicates += 1;
		}
		return { inserted, duplicates, events };
	});
}
