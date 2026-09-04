import { canonicalSubmissionDigest } from "flywheel-config";
import type { EpicPage, Provenance } from "./model.js";

type SourceProvenance = Exclude<Provenance, { kind: "derived" }>;

export interface EpicPageRenderReceiptSource {
	path: string;
	provenance: SourceProvenance;
	observed_at: string;
	source_updated_at?: string;
}

export interface EpicPageRenderReceipt {
	schema_version: 1;
	project_name: string;
	generated_at: string;
	trigger: "manual" | "event" | "scan";
	sources: EpicPageRenderReceiptSource[];
}

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const COMPUTED_ORDER_FIELD =
	/(?:^|[_/])(?:batch(?:es)?|next_candidates?|ready_items?|order)(?:[_/]|$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	path: string,
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) {
		if (COMPUTED_ORDER_FIELD.test(key)) {
			throw new Error(
				`${path}/${key}: computed order is forbidden in a render receipt`,
			);
		}
		if (!allowed.has(key)) throw new Error(`${path}/${key}: unexpected field`);
	}
	for (const key of required) {
		if (!(key in value))
			throw new Error(`${path}/${key}: required field is missing`);
	}
}

function requireString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${path}: expected non-empty string`);
	}
}

function requireTimestamp(
	value: unknown,
	path: string,
): asserts value is string {
	if (typeof value !== "string" || !RFC3339_UTC.test(value)) {
		throw new Error(`${path}: expected RFC3339 UTC timestamp`);
	}
}

function assertNoComputedOrderFields(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		value.forEach((entry, index) =>
			assertNoComputedOrderFields(entry, `${path}/${index}`),
		);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (COMPUTED_ORDER_FIELD.test(key)) {
			throw new Error(
				`${path}/${key}: computed order is forbidden in a render receipt`,
			);
		}
		assertNoComputedOrderFields(child, `${path}/${key}`);
	}
}

export function assertEpicPageRenderReceipt(
	value: unknown,
): asserts value is EpicPageRenderReceipt {
	assertNoComputedOrderFields(value, "");
	if (!isRecord(value)) throw new Error("render receipt: expected object");
	requireExactKeys(
		value,
		["schema_version", "project_name", "generated_at", "trigger", "sources"],
		[],
		"",
	);
	if (value.schema_version !== 1) {
		throw new Error("/schema_version: expected 1");
	}
	requireString(value.project_name, "/project_name");
	requireTimestamp(value.generated_at, "/generated_at");
	if (!(["manual", "event", "scan"] as unknown[]).includes(value.trigger)) {
		throw new Error("/trigger: unsupported trigger");
	}
	if (!Array.isArray(value.sources))
		throw new Error("/sources: expected array");
	value.sources.forEach((source, index) => {
		const path = `/sources/${index}`;
		if (!isRecord(source)) throw new Error(`${path}: expected object`);
		requireExactKeys(
			source,
			["path", "provenance", "observed_at"],
			["source_updated_at"],
			path,
		);
		requireString(source.path, `${path}/path`);
		if (COMPUTED_ORDER_FIELD.test(source.path)) {
			throw new Error(
				`${path}/path: computed order is forbidden in a render receipt`,
			);
		}
		requireTimestamp(source.observed_at, `${path}/observed_at`);
		if (source.source_updated_at !== undefined) {
			requireTimestamp(source.source_updated_at, `${path}/source_updated_at`);
		}
		if (!isRecord(source.provenance)) {
			throw new Error(`${path}/provenance: expected object`);
		}
		if (source.provenance.kind === "linear") {
			requireExactKeys(
				source.provenance,
				["kind", "entity", "id"],
				["field", "url"],
				`${path}/provenance`,
			);
			requireString(source.provenance.entity, `${path}/provenance/entity`);
			requireString(source.provenance.id, `${path}/provenance/id`);
			if (source.provenance.field !== undefined) {
				requireString(source.provenance.field, `${path}/provenance/field`);
			}
			if (source.provenance.url !== undefined) {
				requireString(source.provenance.url, `${path}/provenance/url`);
			}
		} else if (source.provenance.kind === "statestore") {
			requireExactKeys(
				source.provenance,
				["kind", "table", "key"],
				[],
				`${path}/provenance`,
			);
			requireString(source.provenance.table, `${path}/provenance/table`);
			if (!isRecord(source.provenance.key)) {
				throw new Error(`${path}/provenance/key: expected object`);
			}
			for (const [key, value] of Object.entries(source.provenance.key)) {
				requireString(key, `${path}/provenance/key`);
				requireString(value, `${path}/provenance/key/${key}`);
			}
		} else {
			throw new Error(`${path}/provenance: source provenance required`);
		}
	});
}

export function buildEpicPageRenderReceipt(
	page: EpicPage,
): EpicPageRenderReceipt {
	const sources: EpicPageRenderReceiptSource[] = [];
	const visit = (value: unknown, path: string): void => {
		if (Array.isArray(value)) {
			value.forEach((entry, index) => visit(entry, `${path}/${index}`));
			return;
		}
		if (!isRecord(value)) return;
		if (
			"value" in value &&
			isRecord(value.provenance) &&
			(value.provenance.kind === "linear" ||
				value.provenance.kind === "statestore")
		) {
			const source: EpicPageRenderReceiptSource = {
				path,
				provenance: value.provenance as SourceProvenance,
				observed_at: String(value.observed_at),
			};
			if (typeof value.source_updated_at === "string") {
				source.source_updated_at = value.source_updated_at;
			}
			sources.push(source);
			return;
		}
		for (const [key, child] of Object.entries(value)) {
			visit(child, `${path}/${key}`);
		}
	};
	visit(page, "");
	const receipt: EpicPageRenderReceipt = {
		schema_version: 1,
		project_name: page.key.project_name,
		generated_at: page.generated_at,
		trigger: page.generator.trigger,
		sources,
	};
	assertEpicPageRenderReceipt(receipt);
	return receipt;
}

export function epicPageReceiptSourceDigest(
	receipt: EpicPageRenderReceipt,
): string {
	assertEpicPageRenderReceipt(receipt);
	return canonicalSubmissionDigest(receipt.sources);
}
