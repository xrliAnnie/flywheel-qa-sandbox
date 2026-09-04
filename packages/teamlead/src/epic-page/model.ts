import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";

export const EPIC_PAGE_MAX_DOCUMENT_BYTES = 1_507_328;

export const RULE_IDS = [
	"scope.v1",
	"ready.v1",
	"dependents.v1",
	"founder.v1",
	"done.v1",
	"gaps.v1",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const MISSING_REASONS = [
	"no_acceptance_section",
	"statestore_error",
	"no_children",
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
	| { kind: "derived"; rule: RuleId; from: string[] };

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

export interface EpicItem {
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
	signals: [];
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
	};
	header: {
		scope_definition: Cell<{
			root_state_type: "started";
			daily_title_contains: "日常";
			excluded_item_state_type: "backlog";
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
	};
	items: EpicItem[];
	done_definition: Cell<{ terminal_state: "completed" }>;
	founder_items: Cell<string[]>;
	ready_items: Cell<string[]>;
	gaps: Cell<
		Array<{
			item: string;
			face:
				| "what"
				| "done"
				| "founder"
				| "session"
				| "run"
				| "attempt"
				| "gates"
				| "carriers"
				| "land";
			reason: MissingReason;
		}>
	>;
}

export class EpicPageSchemaError extends Error {
	constructor(
		message: string,
		public readonly code: "invalid" | "size" = "invalid",
	) {
		super(message);
		this.name = "EpicPageSchemaError";
	}
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
	if (provenance.kind === "statestore") {
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
			if (
				typeof pointer !== "string" ||
				!isCell(resolvePointer(root, pointer))
			) {
				fail(`${path}/from/${index}`, "pointer must resolve to a Cell");
			}
		}
		return;
	}
	fail(`${path}/kind`, "unknown provenance kind");
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
	"gaps",
] as const;
const ITEM_CELLS = [
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
	requireExactKeys(generator, ["version", "trigger"], [], "/generator");
	if (generator.version !== "epic-page/1")
		fail("/generator/version", "unexpected generator version");
	if (!new Set(["manual", "event", "scan"]).has(String(generator.trigger))) {
		fail("/generator/trigger", "unexpected trigger");
	}

	const header = requireRecord(root.header, "/header");
	requireExactKeys(
		header,
		["scope_definition", "roots", "items"],
		[],
		"/header",
	);
	for (const name of ["scope_definition", "roots", "items"]) {
		assertCell(header[name], `/header/${name}`, root);
	}

	for (const name of ROOT_CELLS) assertCell(root[name], `/${name}`, root);
	if (!Array.isArray(root.items)) fail("/items", "expected array");
	for (const [index, rawItem] of root.items.entries()) {
		const itemPath = `/items/${index}`;
		const item = requireRecord(rawItem, itemPath);
		requireExactKeys(
			item,
			["identifier", ...ITEM_CELLS, "signals"],
			[],
			itemPath,
		);
		requireNonEmptyString(item.identifier, `${itemPath}/identifier`);
		for (const name of ITEM_CELLS) {
			assertCell(item[name], `${itemPath}/${name}`, root);
		}
		if (!Array.isArray(item.signals) || item.signals.length !== 0) {
			fail(`${itemPath}/signals`, "v1 signals must be empty");
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

	if (!Array.isArray(page.gaps.value)) fail("/gaps/value", "expected array");
	const faces = [
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
