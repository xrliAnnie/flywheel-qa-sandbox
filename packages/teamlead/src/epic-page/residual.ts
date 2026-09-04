import type { LinearActiveScopeSnapshot } from "../bridge/linear-epic-query.js";
import type { EpicPage } from "./model.js";

export type EpicResidualTrigger = "roster" | "scope";

export interface EpicResidualOwner {
	agentId: string;
	matchMethod: "label" | "general";
	canSpawn: boolean;
}

export interface EpicResidualAvailable {
	schemaVersion: 1;
	kind: "available";
	generatedAt: string;
	linearObservedAt: string;
	rule: "ready.v1";
	trigger: EpicResidualTrigger;
	roots: number;
	remaining: number;
	ready: number;
	running: number;
	blocked: number;
	readyForLead: Array<{
		identifier: string;
		priority: number;
		ownership: "label" | "general";
	}>;
	readyForLeadTotal: number;
	remainingForLead: number;
	generalCount: number;
}

export interface EpicResidualUnavailable {
	schemaVersion: 1;
	kind: "unavailable";
	token: string;
	trigger: EpicResidualTrigger;
	generatedAt: string | null;
	linearObservedAt: string | null;
}

export type EpicResidualFact = EpicResidualAvailable | EpicResidualUnavailable;

export const EPIC_RESIDUAL_UNAVAILABLE_TOKENS = new Set([
	"transient: linear_unavailable",
	"structural: active_scope_not_found",
	"structural: scope_too_large",
	"structural: scope_snapshot_truncated",
	"structural: epic_page_invalid",
	"structural: epic_residual_invalid",
	"transient: session_ledger_unreadable",
	"transient: epic_scan_failed",
]);

const UNAVAILABLE_TOKEN_GRAMMAR =
	/^(?:structural|transient): [a-z][a-z0-9_]{0,47}$/;
const PATROL_TOKEN_GRAMMAR = /^[A-Za-z0-9._-]{1,64}$/;
const PATROL_DIRECTIVE_WORDS = /check|verify|suggest|inspect|建议|怀疑|该查/iu;

export function isEpicResidualUnavailableToken(
	value: unknown,
): value is string {
	return (
		typeof value === "string" &&
		UNAVAILABLE_TOKEN_GRAMMAR.test(value) &&
		EPIC_RESIDUAL_UNAVAILABLE_TOKENS.has(value)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export class EpicResidualFactError extends Error {
	constructor(path: string) {
		super(`Invalid Epic residual fact at ${path}`);
		this.name = "EpicResidualFactError";
	}
}

function invalid(path: string): never {
	throw new EpicResidualFactError(path);
}

export function assertEpicResidualFact(
	value: unknown,
): asserts value is EpicResidualFact {
	if (!isRecord(value)) invalid("/");
	if (value.schemaVersion !== 1) invalid("/schemaVersion");
	if (value.trigger !== "roster" && value.trigger !== "scope") {
		invalid("/trigger");
	}
	if (value.kind === "unavailable") {
		if (!isEpicResidualUnavailableToken(value.token)) invalid("/token");
		for (const field of ["generatedAt", "linearObservedAt"] as const) {
			if (value[field] !== null && !isTimestamp(value[field])) {
				invalid(`/${field}`);
			}
		}
		return;
	}
	if (value.kind !== "available") invalid("/kind");
	if (value.rule !== "ready.v1") invalid("/rule");
	if (!isTimestamp(value.generatedAt)) invalid("/generatedAt");
	if (!isTimestamp(value.linearObservedAt)) invalid("/linearObservedAt");

	const countFields = [
		"roots",
		"remaining",
		"ready",
		"running",
		"blocked",
		"readyForLeadTotal",
		"remainingForLead",
		"generalCount",
	] as const;
	for (const field of countFields) {
		if (!isNonNegativeSafeInteger(value[field])) invalid(`/${field}`);
	}
	const remaining = value.remaining as number;
	const ready = value.ready as number;
	const running = value.running as number;
	const blocked = value.blocked as number;
	const remainingForLead = value.remainingForLead as number;
	const generalCount = value.generalCount as number;
	const readyForLeadTotal = value.readyForLeadTotal as number;
	if (ready + running + blocked !== remaining) invalid("/remaining");
	if (remainingForLead > remaining) invalid("/remainingForLead");
	if (readyForLeadTotal > remainingForLead) invalid("/remainingForLead");
	if (generalCount > remaining) invalid("/generalCount");
	if (!Array.isArray(value.readyForLead)) invalid("/readyForLead");
	if (
		value.readyForLead.length > 5 ||
		value.readyForLead.length > readyForLeadTotal ||
		readyForLeadTotal > ready
	) {
		invalid("/readyForLead");
	}
	const identifiers = new Set<string>();
	for (const [index, rawItem] of value.readyForLead.entries()) {
		if (!isRecord(rawItem)) invalid(`/readyForLead/${index}`);
		const identifier = rawItem.identifier;
		if (
			typeof identifier !== "string" ||
			!PATROL_TOKEN_GRAMMAR.test(identifier) ||
			PATROL_DIRECTIVE_WORDS.test(identifier) ||
			identifiers.has(identifier)
		) {
			invalid(`/readyForLead/${index}/identifier`);
		}
		identifiers.add(identifier);
		if (
			!Number.isInteger(rawItem.priority) ||
			(rawItem.priority as number) < 0 ||
			(rawItem.priority as number) > 4
		) {
			invalid(`/readyForLead/${index}/priority`);
		}
		if (rawItem.ownership !== "label" && rawItem.ownership !== "general") {
			invalid(`/readyForLead/${index}/ownership`);
		}
	}
}

export interface MaterializedEpicScope {
	page: EpicPage;
	snapshot: LinearActiveScopeSnapshot;
}

export class EpicResidualSessionUnreadableError extends Error {
	constructor() {
		super("An Epic item's session ledger is unreadable");
		this.name = "EpicResidualSessionUnreadableError";
	}
}

export function summarizeEpicResidual(input: {
	materialized: MaterializedEpicScope;
	leadId: string;
	resolveOwner: (labels: string[]) => EpicResidualOwner;
	trigger: EpicResidualTrigger;
}): EpicResidualAvailable {
	const { page, snapshot } = input.materialized;
	const snapshotByIdentifier = new Map(
		snapshot.items.map((item) => [item.identifier, item]),
	);
	const remainingItems = page.items.filter((item) => {
		const stateType = item.state.value?.type;
		return stateType !== "completed" && stateType !== "canceled";
	});
	if (
		remainingItems.some(
			(item) =>
				item.session.value === null || item.session.missing !== undefined,
		)
	) {
		throw new EpicResidualSessionUnreadableError();
	}
	const runningIdentifiers = new Set(
		remainingItems
			.filter((item) => (item.session.value?.ledger_live_count ?? 0) > 0)
			.map((item) => item.identifier),
	);
	const remainingByIdentifier = new Map(
		remainingItems.map((item) => [item.identifier, item]),
	);
	const readyItems = (page.ready_items.value ?? [])
		.map((identifier) => remainingByIdentifier.get(identifier))
		.filter(
			(item): item is (typeof remainingItems)[number] =>
				item !== undefined && !runningIdentifiers.has(item.identifier),
		);

	const ownerFor = (identifier: string) =>
		input.resolveOwner(snapshotByIdentifier.get(identifier)?.labels ?? []);
	const eligibleForLead = (identifier: string) => {
		const owner = ownerFor(identifier);
		return (
			owner.agentId === input.leadId &&
			!(owner.matchMethod === "general" && !owner.canSpawn)
		);
	};

	const readyForLeadAll = readyItems
		.filter((item) => eligibleForLead(item.identifier))
		.map((item) => {
			const owner = ownerFor(item.identifier);
			return {
				identifier: item.identifier,
				priority: item.priority.value ?? 0,
				ownership: owner.matchMethod,
			};
		});

	const fact: EpicResidualAvailable = {
		schemaVersion: 1,
		kind: "available",
		generatedAt: page.generated_at,
		linearObservedAt: snapshot.fetchedAt,
		rule: "ready.v1",
		trigger: input.trigger,
		roots: page.header.roots.value?.length ?? 0,
		remaining: remainingItems.length,
		ready: readyItems.length,
		running: runningIdentifiers.size,
		blocked:
			remainingItems.length - readyItems.length - runningIdentifiers.size,
		readyForLead: readyForLeadAll.slice(0, 5),
		readyForLeadTotal: readyForLeadAll.length,
		remainingForLead: remainingItems.filter((item) =>
			eligibleForLead(item.identifier),
		).length,
		generalCount: remainingItems.filter(
			(item) => ownerFor(item.identifier).matchMethod === "general",
		).length,
	};
	assertEpicResidualFact(fact);
	return fact;
}
