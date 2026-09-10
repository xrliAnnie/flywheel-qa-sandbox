import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { computeReady, computeRootCounts, isSchedulable } from "./rules.js";
import { EpicPageSchemaError } from "./schema-error.js";
import { computeDependencyReview } from "./subtraction.js";

export { EpicPageSchemaError } from "./schema-error.js";

export const EPIC_PAGE_MAX_DOCUMENT_BYTES = 1_507_328;

export const RULE_IDS = [
	"scope.v2",
	"counts.v1",
	"ready.v1",
	"dependents.v1",
	"founder.v1",
	"done.v1",
	"gaps.v1",
	"subtraction.v1",
	"freshness.v1",
	"signals.v1",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const MISSING_REASONS = [
	"no_parent",
	"unknown_state_type",
	"no_acceptance_section",
	"statestore_error",
	"commdb_error",
	"commdb_truncated",
	"no_children",
	"no_prior_generation",
	"no_prior_publication",
	"no_prior_failure",
	"no_publication",
	"no_scan_schedule",
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

export type Provenance =
	| {
			kind: "linear";
			entity: "issue" | "issues" | "relation" | "label" | "children";
			id: string;
			field?: string;
			url?: string;
	  }
	| {
			kind: "statestore";
			table: string;
			key: Record<string, string>;
	  }
	| {
			kind: "commdb";
			table: string;
			key: Record<string, string>;
	  }
	| { kind: "derived"; rule: RuleId; from: string[] };

export const REFRESH_REASONS = [
	"session_started",
	"session_completed",
	"session_failed",
	"run_started",
	"run_resumed",
	"linear_done",
	"dependency_changed",
	"scan",
	"manual",
] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];

export const SIGNAL_KINDS = [
	"declared_blocked",
	"runner_stopped",
	"question_pending",
	"run_held",
	"waiting_founder",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const STOP_REASONS = [
	"blocked",
	"quota",
	"context_full",
	"error",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const ID8_GRAMMAR = /^[A-Za-z0-9._-]{1,8}$/;

export interface Signal {
	kind: SignalKind;
	since: string;
	execution_id8: string;
	reason?: StopReason;
	provenance: Exclude<Provenance, { kind: "linear" | "derived" }>;
	observed_at: string;
}

export interface StuckItem {
	item: string;
	kind: Exclude<SignalKind, "waiting_founder">;
	since: string;
	execution_id8: string;
}

export interface Cell<T> {
	value: T | null;
	provenance: Provenance;
	observed_at: string;
	source_updated_at?: string;
	missing?: { reason: MissingReason; detail?: string };
}

export interface BlockedByValue {
	identifier: string;
	title: string;
	url: string;
	in_scope: boolean;
	blocker_state_type: string;
}

export type DependencyReviewEntry =
	| { kind: "canceled_blocker"; item: string; blocker: string }
	| { kind: "dependency_cycle"; members: string[] }
	| {
			kind: "all_blocked";
			non_terminal: number;
			blocking_edges: Array<{
				blocker: string;
				blocked: string;
				blocker_state_type: string;
				in_scope: boolean;
			}>;
			blocking_edges_truncated: boolean;
	  };

export interface RootCounts {
	root: string;
	counts: {
		live: number;
		waiting: number;
		free: number;
		idle: number;
		done: number;
		canceled: number;
		total: number;
	};
}

export interface RootCountsResult {
	root: string;
	value: RootCounts | null;
	missing?: { reason: "unknown_state_type"; detail: string };
	from: string[];
}

export interface EpicItem {
	parent: Cell<string>;
	identifier: string;
	title: Cell<string>;
	url: Cell<string>;
	state: Cell<{ name: string; type: string }>;
	priority: Cell<number>;
	blocked_by: Cell<BlockedByValue[]>;
	blocks: Cell<
		Array<{
			identifier: string;
			title: string;
			url: string;
			state_type: string;
		}>
	>;
	acceptance: Cell<{ text: string; truncated: boolean }>;
	founder_named: Cell<boolean>;
	session: Cell<{
		latest: Array<{
			status: string;
			role: string | null;
			branch: string | null;
			execution_id8: string;
		}>;
		ledger_live_count: number;
	}>;
	run: Cell<
		Array<{
			run_id: string;
			status: "active" | "held";
			current_node_id: string;
			current_node_label: string;
			label_source: "manifest" | "legacy" | "id";
			template_id: string;
		}>
	>;
	attempt: Cell<
		Array<{ state: string; attempt: number; ledger_open: boolean }>
	>;
	gates: Cell<Array<{ state: string }>>;
	carriers: Cell<Array<{ state: string }>>;
	land: Cell<
		Array<{ pr_number: number; state: string; current_step: string | null }>
	>;
	signals: Signal[];
	signal_sources: {
		statestore: Cell<{ signals: number }>;
		commdb: Cell<{ signals: number }>;
	};
}

export interface FreshnessSection {
	current: Cell<{
		version: number;
		trigger: "manual" | "event" | "scan";
		reasons: RefreshReason[];
	}>;
	last_generated: Cell<{
		version: number;
		trigger: "manual" | "event" | "scan";
	}>;
	last_published: Cell<{
		version: number;
		trigger: "manual" | "event" | "scan";
	}>;
	publish_failures: Cell<{ count: number }>;
	last_failure: Cell<{ token: string }>;
	last_publish_failure: Cell<{ token: string }>;
	hosted: Cell<{
		token8: string;
		published: boolean;
		last_version: number | null;
	}>;
	oldest_source: Cell<{ path: string }>;
	next_scan: Cell<{ expected_in_seconds: number }>;
}

export interface EpicPage {
	schema_version: 1;
	key: {
		project_name: string;
	};
	generated_at: string;
	generator: {
		version: "epic-page/1";
		trigger: "manual" | "event" | "scan";
		reasons: RefreshReason[];
	};
	header: {
		scope_definition: Cell<{
			root_state_type: "started";
			daily_title_contains: "日常";
			item_state_filter: "none";
		}>;
		roots: Cell<
			Array<{
				identifier: string;
				title: string;
				url: string;
				state: { name: string; type: string };
			}>
		>;
		items: Cell<string[]>;
		root_counts: Array<Cell<RootCounts>>;
	};
	items: EpicItem[];
	done_definition: Cell<{ terminal_state: "completed" }>;
	founder_items: Cell<string[]>;
	ready_items: Cell<string[]>;
	dependency_review: Cell<DependencyReviewEntry[]>;
	freshness: FreshnessSection;
	stuck_items: Cell<StuckItem[]>;
	gaps: Cell<
		Array<{
			item: string;
			face:
				| "parent"
				| "what"
				| "done"
				| "founder"
				| "session"
				| "run"
				| "attempt"
				| "gates"
				| "carriers"
				| "land"
				| "signals_statestore"
				| "signals_commdb";
			reason: MissingReason;
		}>
	>;
}

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CELL_KEYS = new Set([
	"value",
	"provenance",
	"observed_at",
	"source_updated_at",
	"missing",
]);

function fail(path: string, message: string): never {
	throw new EpicPageSchemaError(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) fail(path, "expected object");
	return value;
}

function requireExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	path: string,
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) fail(`${path}/${key}`, "unsourced structural field");
	}
	for (const key of required) {
		if (!(key in value)) fail(`${path}/${key}`, "required field is missing");
	}
}

function requireNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		fail(path, "expected non-empty string");
	}
	return value;
}

function requireTimestamp(value: unknown, path: string): void {
	if (typeof value !== "string" || !RFC3339_UTC.test(value)) {
		fail(path, "expected RFC3339 UTC timestamp");
	}
}

function assertNoTimestampKeys(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		value.forEach((entry, index) =>
			assertNoTimestampKeys(entry, `${path}/${index}`),
		);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (key.endsWith("_at"))
			fail(`${path}/${key}`, "timestamp belongs on Cell");
		assertNoTimestampKeys(child, `${path}/${key}`);
	}
}

function isCell(value: unknown): value is Cell<unknown> {
	return (
		isRecord(value) &&
		"value" in value &&
		"provenance" in value &&
		"observed_at" in value
	);
}

function isSignalNode(value: unknown): boolean {
	return (
		isRecord(value) &&
		SIGNAL_KINDS.includes(value.kind as SignalKind) &&
		"since" in value &&
		"execution_id8" in value &&
		"provenance" in value &&
		"observed_at" in value &&
		!("value" in value)
	);
}

function resolvePointer(root: unknown, pointer: string): unknown {
	if (pointer === "") return root;
	if (!pointer.startsWith("/")) return undefined;
	let cursor: unknown = root;
	for (const rawPart of pointer.slice(1).split("/")) {
		const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(cursor)) {
			if (!/^\d+$/.test(part)) return undefined;
			cursor = cursor[Number(part)];
		} else if (isRecord(cursor) && part in cursor) {
			cursor = cursor[part];
		} else {
			return undefined;
		}
	}
	return cursor;
}

function assertProvenance(value: unknown, path: string, root: unknown): void {
	const provenance = requireRecord(value, path);
	if (provenance.kind === "linear") {
		requireExactKeys(
			provenance,
			["kind", "entity", "id"],
			["field", "url"],
			path,
		);
		if (
			!new Set(["issue", "issues", "relation", "label", "children"]).has(
				String(provenance.entity),
			)
		) {
			fail(`${path}/entity`, "unknown Linear entity");
		}
		requireNonEmptyString(provenance.id, `${path}/id`);
		if (provenance.field !== undefined)
			requireNonEmptyString(provenance.field, `${path}/field`);
		if (provenance.url !== undefined)
			requireNonEmptyString(provenance.url, `${path}/url`);
		return;
	}
	if (provenance.kind === "statestore" || provenance.kind === "commdb") {
		requireExactKeys(provenance, ["kind", "table", "key"], [], path);
		requireNonEmptyString(provenance.table, `${path}/table`);
		const key = requireRecord(provenance.key, `${path}/key`);
		for (const [name, child] of Object.entries(key)) {
			requireNonEmptyString(name, `${path}/key`);
			requireNonEmptyString(child, `${path}/key/${name}`);
		}
		return;
	}
	if (provenance.kind === "derived") {
		requireExactKeys(provenance, ["kind", "rule", "from"], [], path);
		if (!RULE_IDS.includes(provenance.rule as RuleId)) {
			fail(`${path}/rule`, "unknown derived rule");
		}
		if (!Array.isArray(provenance.from)) fail(`${path}/from`, "expected array");
		for (const [index, pointer] of provenance.from.entries()) {
			const resolved =
				typeof pointer === "string" ? resolvePointer(root, pointer) : undefined;
			if (
				typeof pointer !== "string" ||
				(!isCell(resolved) &&
					!(provenance.rule === "signals.v1" && isSignalNode(resolved)))
			) {
				fail(
					`${path}/from/${index}`,
					"pointer must resolve to a Cell or signals.v1 Signal",
				);
			}
		}
		return;
	}
	fail(`${path}/kind`, "unknown provenance kind");
}

export function normalizeRefreshReasons(
	reasons: readonly RefreshReason[],
): RefreshReason[] {
	return [...new Set(reasons)].sort() as RefreshReason[];
}

function assertRefreshReasons(
	value: unknown,
	path: string,
	trigger: "manual" | "event" | "scan",
): asserts value is RefreshReason[] {
	if (!Array.isArray(value) || value.length === 0) {
		fail(path, "expected non-empty refresh reason array");
	}
	for (const [index, reason] of value.entries()) {
		if (!REFRESH_REASONS.includes(reason as RefreshReason)) {
			fail(`${path}/${index}`, "unknown refresh reason");
		}
	}
	if (
		canonicalJsonString(value) !==
		canonicalJsonString(normalizeRefreshReasons(value as RefreshReason[]))
	) {
		fail(path, "refresh reasons must be unique and sorted");
	}
	if (trigger === "manual" && canonicalJsonString(value) !== '["manual"]') {
		fail(path, "manual trigger requires exactly manual reason");
	}
	if (trigger === "scan" && canonicalJsonString(value) !== '["scan"]') {
		fail(path, "scan trigger requires exactly scan reason");
	}
}

function assertSignal(
	value: unknown,
	path: string,
	root: unknown,
): asserts value is Signal {
	const signal = requireRecord(value, path);
	const kind = signal.kind as SignalKind;
	if (!SIGNAL_KINDS.includes(kind)) fail(`${path}/kind`, "unknown signal kind");
	const required = [
		"kind",
		"since",
		"execution_id8",
		"provenance",
		"observed_at",
	];
	requireExactKeys(
		signal,
		kind === "runner_stopped" ? [...required, "reason"] : required,
		[],
		path,
	);
	requireTimestamp(signal.since, `${path}/since`);
	requireTimestamp(signal.observed_at, `${path}/observed_at`);
	if (
		typeof signal.execution_id8 !== "string" ||
		!ID8_GRAMMAR.test(signal.execution_id8)
	) {
		fail(
			`${path}/execution_id8`,
			"expected opaque identifier prefix of at most 8 characters",
		);
	}
	if (
		kind === "runner_stopped" &&
		!STOP_REASONS.includes(signal.reason as StopReason)
	) {
		fail(`${path}/reason`, "unknown runner stop reason");
	}
	assertProvenance(signal.provenance, `${path}/provenance`, root);
	const provenance = signal.provenance as Record<string, unknown>;
	const expectedKind =
		kind === "declared_blocked" || kind === "run_held"
			? "statestore"
			: "commdb";
	if (provenance.kind !== expectedKind) {
		fail(`${path}/provenance/kind`, `expected ${expectedKind}`);
	}
}

function requireNonNegativeInteger(value: unknown, path: string): number {
	if (!Number.isInteger(value) || Number(value) < 0) {
		fail(path, "expected non-negative integer");
	}
	return Number(value);
}

function assertCellValueShape(
	cell: unknown,
	path: string,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> | undefined {
	const record = requireRecord(cell, path);
	if (record.value === null) return undefined;
	const value = requireRecord(record.value, `${path}/value`);
	requireExactKeys(value, required, optional, `${path}/value`);
	return value;
}

function assertFreshness(
	value: unknown,
	path: string,
	root: Record<string, unknown>,
): void {
	const freshness = requireRecord(value, path);
	const leaves = [
		"current",
		"last_generated",
		"last_published",
		"publish_failures",
		"last_failure",
		"last_publish_failure",
		"hosted",
		"oldest_source",
		"next_scan",
	] as const;
	requireExactKeys(freshness, leaves, [], path);
	for (const leaf of leaves)
		assertCell(freshness[leaf], `${path}/${leaf}`, root);

	const expectedTables: Record<string, string> = {
		current: "epic_page",
		last_generated: "epic_page_refresh",
		last_published: "epic_page_refresh",
		publish_failures: "epic_page_refresh",
		last_failure: "epic_page_refresh",
		last_publish_failure: "epic_page_refresh",
		hosted: "epic_page_publication",
	};
	for (const [leaf, table] of Object.entries(expectedTables)) {
		const provenance = requireRecord(
			requireRecord(freshness[leaf], `${path}/${leaf}`).provenance,
			`${path}/${leaf}/provenance`,
		);
		if (provenance.kind !== "statestore" || provenance.table !== table) {
			fail(`${path}/${leaf}/provenance`, `expected statestore ${table}`);
		}
	}
	for (const leaf of ["oldest_source", "next_scan"] as const) {
		const provenance = requireRecord(
			requireRecord(freshness[leaf], `${path}/${leaf}`).provenance,
			`${path}/${leaf}/provenance`,
		);
		if (provenance.kind !== "derived" || provenance.rule !== "freshness.v1") {
			fail(`${path}/${leaf}/provenance`, "expected derived freshness.v1");
		}
	}

	const current = assertCellValueShape(freshness.current, `${path}/current`, [
		"version",
		"trigger",
		"reasons",
	]);
	if (!current) fail(`${path}/current/value`, "current freshness is required");
	if (!Number.isInteger(current.version) || Number(current.version) < 1) {
		fail(`${path}/current/value/version`, "expected positive integer");
	}
	if (!new Set(["manual", "event", "scan"]).has(String(current.trigger))) {
		fail(`${path}/current/value/trigger`, "unsupported trigger");
	}
	assertRefreshReasons(
		current.reasons,
		`${path}/current/value/reasons`,
		current.trigger as "manual" | "event" | "scan",
	);
	const generator = requireRecord(root.generator, "/generator");
	if (
		current.trigger !== generator.trigger ||
		canonicalJsonString(current.reasons) !==
			canonicalJsonString(generator.reasons)
	) {
		fail(`${path}/current/value`, "must match generator trigger and reasons");
	}

	for (const leaf of ["last_generated", "last_published"] as const) {
		const prior = assertCellValueShape(freshness[leaf], `${path}/${leaf}`, [
			"version",
			"trigger",
		]);
		if (!prior) continue;
		if (!Number.isInteger(prior.version) || Number(prior.version) < 1) {
			fail(`${path}/${leaf}/value/version`, "expected positive integer");
		}
		if (!new Set(["manual", "event", "scan"]).has(String(prior.trigger))) {
			fail(`${path}/${leaf}/value/trigger`, "unsupported trigger");
		}
	}
	const failures = assertCellValueShape(
		freshness.publish_failures,
		`${path}/publish_failures`,
		["count"],
	);
	if (failures)
		requireNonNegativeInteger(
			failures.count,
			`${path}/publish_failures/value/count`,
		);
	for (const leaf of ["last_failure", "last_publish_failure"] as const) {
		const failure = assertCellValueShape(freshness[leaf], `${path}/${leaf}`, [
			"token",
		]);
		if (failure)
			requireNonEmptyString(failure.token, `${path}/${leaf}/value/token`);
	}
	const hosted = assertCellValueShape(freshness.hosted, `${path}/hosted`, [
		"token8",
		"published",
		"last_version",
	]);
	if (hosted) {
		if (typeof hosted.token8 !== "string" || !ID8_GRAMMAR.test(hosted.token8)) {
			fail(`${path}/hosted/value/token8`, "expected token prefix");
		}
		if (typeof hosted.published !== "boolean")
			fail(`${path}/hosted/value/published`, "expected boolean");
		if (
			hosted.last_version !== null &&
			(!Number.isInteger(hosted.last_version) ||
				Number(hosted.last_version) < 1)
		) {
			fail(
				`${path}/hosted/value/last_version`,
				"expected null or positive integer",
			);
		}
	}
	const oldest = assertCellValueShape(
		freshness.oldest_source,
		`${path}/oldest_source`,
		["path"],
	);
	if (oldest) {
		const pointer = requireNonEmptyString(
			oldest.path,
			`${path}/oldest_source/value/path`,
		);
		if (!isCell(resolvePointer(root, pointer)))
			fail(`${path}/oldest_source/value/path`, "must resolve to a Cell");
	}
	const next = assertCellValueShape(freshness.next_scan, `${path}/next_scan`, [
		"expected_in_seconds",
	]);
	if (next)
		requireNonNegativeInteger(
			next.expected_in_seconds,
			`${path}/next_scan/value/expected_in_seconds`,
		);
}

function assertCell(value: unknown, path: string, root: unknown): void {
	const cell = requireRecord(value, path);
	for (const key of Object.keys(cell)) {
		if (!CELL_KEYS.has(key)) fail(`${path}/${key}`, "unknown Cell field");
	}
	for (const key of ["value", "provenance", "observed_at"]) {
		if (!(key in cell))
			fail(`${path}/${key}`, "required Cell field is missing");
	}
	requireTimestamp(cell.observed_at, `${path}/observed_at`);
	if (cell.source_updated_at !== undefined) {
		requireTimestamp(cell.source_updated_at, `${path}/source_updated_at`);
	}
	assertProvenance(cell.provenance, `${path}/provenance`, root);
	const hasMissing = cell.missing !== undefined;
	if ((cell.value === null) !== hasMissing) {
		fail(path, "value is null iff missing is present");
	}
	if (hasMissing) {
		const missing = requireRecord(cell.missing, `${path}/missing`);
		requireExactKeys(missing, ["reason"], ["detail"], `${path}/missing`);
		if (!MISSING_REASONS.includes(missing.reason as MissingReason)) {
			fail(`${path}/missing/reason`, "unknown missing reason");
		}
		if (missing.detail !== undefined && typeof missing.detail !== "string") {
			fail(`${path}/missing/detail`, "expected string");
		}
	}
	assertNoTimestampKeys(cell.value, `${path}/value`);
}

const ROOT_CELLS = [
	"done_definition",
	"founder_items",
	"ready_items",
	"dependency_review",
	"stuck_items",
	"gaps",
] as const;
const ITEM_CELLS = [
	"parent",
	"title",
	"url",
	"state",
	"priority",
	"blocked_by",
	"blocks",
	"acceptance",
	"founder_named",
	"session",
	"run",
	"attempt",
	"gates",
	"carriers",
	"land",
] as const;

export function assertEpicPage(
	document: unknown,
): asserts document is EpicPage {
	const canonical = canonicalJsonString(document);
	if (Buffer.byteLength(canonical, "utf8") > EPIC_PAGE_MAX_DOCUMENT_BYTES) {
		throw new EpicPageSchemaError(
			`document exceeds ${EPIC_PAGE_MAX_DOCUMENT_BYTES} bytes`,
			"size",
		);
	}
	const root = requireRecord(document, "");
	requireExactKeys(
		root,
		[
			"schema_version",
			"key",
			"generated_at",
			"generator",
			"header",
			"items",
			"freshness",
			...ROOT_CELLS,
		],
		[],
		"",
	);
	if (root.schema_version !== 1) fail("/schema_version", "expected 1");
	requireTimestamp(root.generated_at, "/generated_at");

	const key = requireRecord(root.key, "/key");
	requireExactKeys(key, ["project_name"], [], "/key");
	requireNonEmptyString(key.project_name, "/key/project_name");

	const generator = requireRecord(root.generator, "/generator");
	requireExactKeys(
		generator,
		["version", "trigger", "reasons"],
		[],
		"/generator",
	);
	if (generator.version !== "epic-page/1")
		fail("/generator/version", "unexpected generator version");
	if (!new Set(["manual", "event", "scan"]).has(String(generator.trigger))) {
		fail("/generator/trigger", "unexpected trigger");
	}
	assertRefreshReasons(
		generator.reasons,
		"/generator/reasons",
		generator.trigger as "manual" | "event" | "scan",
	);

	const header = requireRecord(root.header, "/header");
	requireExactKeys(
		header,
		["scope_definition", "roots", "items", "root_counts"],
		[],
		"/header",
	);
	for (const name of ["scope_definition", "roots", "items"]) {
		assertCell(header[name], `/header/${name}`, root);
	}

	const scope = assertCellValueShape(
		header.scope_definition,
		"/header/scope_definition",
		["root_state_type", "daily_title_contains", "item_state_filter"],
	);
	if (
		!scope ||
		scope.root_state_type !== "started" ||
		scope.daily_title_contains !== "日常" ||
		scope.item_state_filter !== "none"
	)
		fail("/header/scope_definition/value", "expected scope.v2 definition");
	const scopeCell = header.scope_definition as Cell<unknown>;
	if (
		scopeCell.provenance.kind !== "derived" ||
		scopeCell.provenance.rule !== "scope.v2"
	)
		fail("/header/scope_definition/provenance", "expected derived scope.v2");
	const rootValues = (header.roots as Cell<unknown>).value;
	if (!Array.isArray(rootValues)) fail("/header/roots/value", "expected array");
	const rootIds = new Set<string>();
	for (const [index, raw] of rootValues.entries()) {
		const path = `/header/roots/value/${index}`;
		const value = requireRecord(raw, path);
		requireExactKeys(value, ["identifier", "title", "url", "state"], [], path);
		for (const key of ["identifier", "title", "url"])
			requireNonEmptyString(value[key], `${path}/${key}`);
		const identifier = value.identifier as string;
		if (rootIds.has(identifier)) fail(path, "duplicate root identifier");
		rootIds.add(identifier);
		const state = requireRecord(value.state, `${path}/state`);
		requireExactKeys(state, ["name", "type"], [], `${path}/state`);
		requireNonEmptyString(state.name, `${path}/state/name`);
		requireNonEmptyString(state.type, `${path}/state/type`);
	}

	for (const name of ROOT_CELLS) assertCell(root[name], `/${name}`, root);
	assertFreshness(root.freshness, "/freshness", root);
	if (!Array.isArray(root.items)) fail("/items", "expected array");
	for (const [index, rawItem] of root.items.entries()) {
		const itemPath = `/items/${index}`;
		const item = requireRecord(rawItem, itemPath);
		requireExactKeys(
			item,
			["identifier", ...ITEM_CELLS, "signals", "signal_sources"],
			[],
			itemPath,
		);
		requireNonEmptyString(item.identifier, `${itemPath}/identifier`);
		for (const name of ITEM_CELLS) {
			assertCell(item[name], `${itemPath}/${name}`, root);
		}
		if (rootIds.has(item.identifier as string))
			fail(itemPath, "root and item identifiers must be disjoint");
		const state = assertCellValueShape(item.state, `${itemPath}/state`, [
			"name",
			"type",
		]);
		if (!state) fail(`${itemPath}/state`, "state cell must be known");
		requireNonEmptyString(state.name, `${itemPath}/state/value/name`);
		requireNonEmptyString(state.type, `${itemPath}/state/value/type`);
		const blockedBy = (item.blocked_by as Cell<unknown>).value;
		if (!Array.isArray(blockedBy))
			fail(`${itemPath}/blocked_by`, "blocked_by cell must be known array");
		for (const [index, raw] of blockedBy.entries()) {
			const path = `${itemPath}/blocked_by/value/${index}`;
			const blocker = requireRecord(raw, path);
			requireExactKeys(
				blocker,
				["identifier", "title", "url", "in_scope", "blocker_state_type"],
				[],
				path,
			);
			for (const key of ["identifier", "title", "url", "blocker_state_type"])
				requireNonEmptyString(blocker[key], `${path}/${key}`);
			if (typeof blocker.in_scope !== "boolean")
				fail(`${path}/in_scope`, "expected boolean");
		}
		const parent = item.parent as Cell<unknown>;
		if (parent.value === null) {
			if (parent.missing?.reason !== "no_parent")
				fail(`${itemPath}/parent/missing`, "expected no_parent");
		} else requireNonEmptyString(parent.value, `${itemPath}/parent/value`);
		const titleSource = (item.title as Cell<unknown>).provenance;
		if (
			parent.provenance.kind !== "linear" ||
			parent.provenance.entity !== "issue" ||
			parent.provenance.field !== "parent" ||
			titleSource.kind !== "linear" ||
			parent.provenance.id !== titleSource.id
		)
			fail(
				`${itemPath}/parent/provenance`,
				"expected this issue's Linear parent",
			);

		if (!Array.isArray(item.signals)) {
			fail(`${itemPath}/signals`, "expected array");
		}
		const seenSignals = new Set<string>();
		for (const [signalIndex, signal] of item.signals.entries()) {
			assertSignal(signal, `${itemPath}/signals/${signalIndex}`, root);
			const typed = signal as Signal;
			const key = `${typed.kind}\0${typed.execution_id8}`;
			if (seenSignals.has(key)) {
				fail(
					`${itemPath}/signals/${signalIndex}`,
					"duplicate kind and execution prefix",
				);
			}
			seenSignals.add(key);
		}
		const signalSources = requireRecord(
			item.signal_sources,
			`${itemPath}/signal_sources`,
		);
		requireExactKeys(
			signalSources,
			["statestore", "commdb"],
			[],
			`${itemPath}/signal_sources`,
		);
		for (const source of ["statestore", "commdb"] as const) {
			const sourcePath = `${itemPath}/signal_sources/${source}`;
			assertCell(signalSources[source], sourcePath, root);
			const sourceCell = signalSources[source] as Cell<{ signals: number }>;
			if (sourceCell.provenance.kind !== source) {
				fail(`${sourcePath}/provenance/kind`, `expected ${source}`);
			}
			const count = item.signals.filter(
				(signal) => signal.provenance.kind === source,
			).length;
			if (sourceCell.value === null) {
				if (count !== 0)
					fail(sourcePath, "missing source cannot contribute signals");
			} else {
				const shape = requireRecord(sourceCell.value, `${sourcePath}/value`);
				requireExactKeys(shape, ["signals"], [], `${sourcePath}/value`);
				if (shape.signals !== count) {
					fail(`${sourcePath}/value/signals`, "must equal source signal count");
				}
			}
		}
	}

	const page = root as unknown as EpicPage;
	if (page.done_definition.value?.terminal_state !== "completed") {
		fail("/done_definition/value/terminal_state", "expected completed");
	}
	if (!Array.isArray(page.header.items.value)) {
		fail("/header/items/value", "expected identifier array");
	}
	const childIds = [...page.header.items.value].sort();
	const itemIds = page.items.map((item) => item.identifier).sort();
	if (
		new Set(childIds).size !== childIds.length ||
		new Set(itemIds).size !== itemIds.length
	) {
		fail("/items", "duplicate identifiers are not allowed");
	}
	if (JSON.stringify(childIds) !== JSON.stringify(itemIds)) {
		fail("/header/items/value", "identifier set differs from items");
	}
	if (
		!Array.isArray(page.header.root_counts) ||
		page.header.root_counts.length !== rootValues.length
	)
		fail("/header/root_counts", "expected one count Cell per root");
	const expectedCounts = computeRootCounts(
		page.items,
		page.header.roots.value!,
	);
	for (const [index, countsCell] of page.header.root_counts.entries()) {
		const path = `/header/root_counts/${index}`;
		assertCell(countsCell, path, root);
		if (
			countsCell.provenance.kind !== "derived" ||
			countsCell.provenance.rule !== "counts.v1"
		)
			fail(`${path}/provenance`, "expected derived counts.v1");
		if (countsCell.value === null) {
			if (countsCell.missing?.reason !== "unknown_state_type")
				fail(`${path}/missing`, "expected unknown_state_type");
		} else {
			const value = requireRecord(countsCell.value, `${path}/value`);
			requireExactKeys(value, ["root", "counts"], [], `${path}/value`);
			if (value.root !== page.header.roots.value![index]!.identifier)
				fail(`${path}/value/root`, "root order mismatch");
			const counts = requireRecord(value.counts, `${path}/value/counts`);
			const keys = ["live", "waiting", "free", "idle", "done", "canceled"];
			requireExactKeys(counts, [...keys, "total"], [], `${path}/value/counts`);
			for (const key of [...keys, "total"])
				requireNonNegativeInteger(counts[key], `${path}/value/counts/${key}`);
			if (
				counts.total !==
				keys.reduce((sum, key) => sum + (counts[key] as number), 0)
			)
				fail(`${path}/value/counts/total`, "must equal sum");
		}
		const actual = {
			root:
				countsCell.value?.root ?? page.header.roots.value![index]!.identifier,
			value: countsCell.value,
			from: countsCell.provenance.from,
			...(countsCell.missing ? { missing: countsCell.missing } : {}),
		};
		if (
			canonicalJsonString(actual) !== canonicalJsonString(expectedCounts[index])
		)
			fail(path, "does not match counts.v1 recomputation");
	}

	if (!Array.isArray(page.ready_items.value)) {
		fail("/ready_items/value", "expected identifier array");
	}
	if (
		canonicalJsonString(page.ready_items.value) !==
		canonicalJsonString(computeReady(page.items))
	) {
		fail("/ready_items/value", "does not match ready.v1 recomputation");
	}
	if (
		page.stuck_items.provenance.kind !== "derived" ||
		page.stuck_items.provenance.rule !== "signals.v1"
	) {
		fail("/stuck_items/provenance", "expected derived signals.v1 provenance");
	}
	if (!Array.isArray(page.stuck_items.value)) {
		fail("/stuck_items/value", "expected array");
	}
	const expectedStuck: StuckItem[] = [];
	const expectedStuckPointers: string[] = [];
	for (const [itemIndex, item] of page.items.entries()) {
		if (!isSchedulable(item)) continue;
		for (const [signalIndex, signal] of item.signals.entries()) {
			if (signal.kind === "waiting_founder") continue;
			expectedStuck.push({
				item: item.identifier,
				kind: signal.kind,
				since: signal.since,
				execution_id8: signal.execution_id8,
			});
			expectedStuckPointers.push(`/items/${itemIndex}/signals/${signalIndex}`);
		}
		expectedStuckPointers.push(
			`/items/${itemIndex}/signal_sources/statestore`,
			`/items/${itemIndex}/signal_sources/commdb`,
		);
	}
	expectedStuck.sort(
		(left, right) =>
			left.since.localeCompare(right.since) ||
			left.item.localeCompare(right.item) ||
			left.kind.localeCompare(right.kind),
	);
	for (const [index, stuck] of page.stuck_items.value.entries()) {
		const path = `/stuck_items/value/${index}`;
		const record = requireRecord(stuck, path);
		requireExactKeys(
			record,
			["item", "kind", "since", "execution_id8"],
			[],
			path,
		);
		requireNonEmptyString(record.item, `${path}/item`);
		if (
			!SIGNAL_KINDS.includes(record.kind as SignalKind) ||
			record.kind === "waiting_founder"
		) {
			fail(`${path}/kind`, "expected stuck signal kind");
		}
		requireTimestamp(record.since, `${path}/since`);
		if (
			typeof record.execution_id8 !== "string" ||
			!ID8_GRAMMAR.test(record.execution_id8)
		) {
			fail(`${path}/execution_id8`, "expected identifier prefix");
		}
	}
	if (
		canonicalJsonString(page.stuck_items.value) !==
		canonicalJsonString(expectedStuck)
	) {
		fail("/stuck_items/value", "does not match signals.v1 recomputation");
	}
	if (
		canonicalJsonString(page.stuck_items.provenance.from) !==
		canonicalJsonString(expectedStuckPointers)
	) {
		fail(
			"/stuck_items/provenance/from",
			"must cover stuck signals and source health Cells",
		);
	}
	if (
		page.dependency_review.provenance.kind !== "derived" ||
		page.dependency_review.provenance.rule !== "subtraction.v1"
	) {
		fail(
			"/dependency_review/provenance",
			"expected derived subtraction.v1 provenance",
		);
	}
	if (!Array.isArray(page.dependency_review.value)) {
		fail("/dependency_review/value", "expected array");
	}
	if (
		canonicalJsonString(page.dependency_review.value) !==
		canonicalJsonString(
			computeDependencyReview(page.items, page.ready_items.value),
		)
	) {
		fail(
			"/dependency_review/value",
			"does not match subtraction.v1 recomputation",
		);
	}

	if (!Array.isArray(page.gaps.value)) fail("/gaps/value", "expected array");
	const faces = [
		["parent", "parent"],
		["title", "what"],
		["acceptance", "done"],
		["founder_named", "founder"],
		["session", "session"],
		["run", "run"],
		["attempt", "attempt"],
		["gates", "gates"],
		["carriers", "carriers"],
		["land", "land"],
	] as const;
	for (const item of page.items) {
		for (const [cellName, face] of faces) {
			const cell = item[cellName];
			if (
				cell.value === null &&
				!page.gaps.value.some(
					(gap) =>
						gap.item === item.identifier &&
						gap.face === face &&
						gap.reason === cell.missing?.reason,
				)
			) {
				fail(
					`/items/${item.identifier}/${cellName}`,
					"missing face is absent from gaps",
				);
			}
		}
		for (const [source, face] of [
			["statestore", "signals_statestore"],
			["commdb", "signals_commdb"],
		] as const) {
			const cell = item.signal_sources[source];
			if (
				cell.value === null &&
				!page.gaps.value.some(
					(gap) =>
						gap.item === item.identifier &&
						gap.face === face &&
						gap.reason === cell.missing?.reason,
				)
			) {
				fail(
					`/items/${item.identifier}/signal_sources/${source}`,
					"missing signal source is absent from gaps",
				);
			}
		}
	}
}

export function stripTimestamps<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((entry) => stripTimestamps(entry)) as T;
	}
	if (!isRecord(value)) return value;
	const stripped: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (
			key === "observed_at" ||
			key === "source_updated_at" ||
			key === "generated_at"
		) {
			continue;
		}
		stripped[key] = stripTimestamps(child);
	}
	return stripped as T;
}

export function contentDigest(document: EpicPage): string {
	return canonicalSubmissionDigest(stripTimestamps(document));
}
