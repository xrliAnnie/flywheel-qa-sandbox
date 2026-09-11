import { canonicalJsonString } from "flywheel-config";
import { EPIC_PAGE_MAX_HTML_BYTES } from "../bridge/epic-page-publisher.js";
import { rebuildAttention } from "./attention.js";
import {
	assertEpicPage,
	type Cell,
	EPIC_PAGE_MAX_DOCUMENT_BYTES,
	type EpicPageV2,
} from "./model.js";
import { EpicPageSchemaError } from "./schema-error.js";

export interface AttentionBudgetOptions {
	maxJsonBytes?: number;
	maxHtmlBytes?: number;
}
function collect(
	value: unknown,
	path: string,
	result: Map<string, string>,
): void {
	if (!value || typeof value !== "object") return;
	if ("value" in value && "provenance" in value && "observed_at" in value) {
		const cell = value as Cell<unknown>;
		if (cell.provenance.kind !== "derived") result.set(path, cell.observed_at);
		return;
	}
	for (const [key, child] of Object.entries(value))
		collect(child, `${path}/${key}`, result);
}
function pointer(root: unknown, path: string): Cell<unknown> | undefined {
	let value = root;
	for (const key of path.slice(1).split("/")) {
		if (!value || typeof value !== "object") return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value as Cell<unknown> | undefined;
}
function prefix(page: EpicPageV2, count: number): EpicPageV2 {
	const copy = structuredClone(page);
	const extension = rebuildAttention(
		copy,
		copy.attention.slice(0, count),
		copy.generated_at,
		true,
	);
	Object.assign(copy, extension);
	const sources = new Map<string, string>();
	const prior = page.freshness.oldest_source.provenance;
	if (prior.kind === "derived")
		for (const path of prior.from) {
			if (
				path.startsWith("/attention/") ||
				path.startsWith("/attention_sources/") ||
				path.startsWith("/discord/")
			)
				continue;
			const cell = pointer(copy, path);
			if (cell) sources.set(path, cell.observed_at);
		}
	collect(
		{
			discord: copy.discord,
			attention_sources: copy.attention_sources,
			attention: copy.attention,
		},
		"",
		sources,
	);
	const sorted = [...sources].sort(
		(a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]),
	);
	copy.freshness.oldest_source = {
		value: { path: sorted[0]?.[0] ?? "/freshness/current" },
		provenance: {
			kind: "derived",
			rule: "freshness.v1",
			from: [...sources.keys()].sort(),
		},
		observed_at: copy.generated_at,
	};
	return copy;
}
/** Measures the final renderer and canonical JSON, retaining only whole sourced rows. */
export function applyAttentionBudget(
	page: EpicPageV2,
	renderHtml: (page: EpicPageV2) => string,
	options: AttentionBudgetOptions = {},
): EpicPageV2 {
	const maxJson = Math.min(
		options.maxJsonBytes ?? EPIC_PAGE_MAX_DOCUMENT_BYTES,
		EPIC_PAGE_MAX_DOCUMENT_BYTES,
	);
	const maxHtml = Math.min(
		options.maxHtmlBytes ?? EPIC_PAGE_MAX_HTML_BYTES,
		EPIC_PAGE_MAX_HTML_BYTES,
	);
	if (
		!Number.isSafeInteger(maxJson) ||
		!Number.isSafeInteger(maxHtml) ||
		maxJson < 1 ||
		maxHtml < 1
	)
		throw new EpicPageSchemaError("invalid attention size budget", "size");
	const fits = (candidate: EpicPageV2) =>
		Buffer.byteLength(canonicalJsonString(candidate), "utf8") <= maxJson &&
		Buffer.byteLength(renderHtml(candidate), "utf8") <= maxHtml;
	if (fits(page)) {
		assertEpicPage(page);
		return page;
	}
	// All search candidates include the actual incomplete warning. The full/partial
	// warning transition is tested separately above, so a shorter prefix cannot be
	// accepted on the strength of a size measured without its warning.
	let best = prefix(page, 0);
	if (!fits(best))
		throw new EpicPageSchemaError(
			"Epic document plus minimum attention warning exceeds size budget",
			"size",
		);
	let low = 1;
	let high = page.attention.length - 1;
	while (low <= high) {
		const count = Math.floor((low + high) / 2);
		const candidate = prefix(page, count);
		if (fits(candidate)) {
			best = candidate;
			low = count + 1;
		} else high = count - 1;
	}
	// Always verify the actual selected candidate again. Never infer acceptance
	// from an average row size, or split a Cell/source list to fit a byte limit.
	if (!fits(best))
		throw new EpicPageSchemaError(
			"attention renderer size changed during budgeting",
			"size",
		);
	assertEpicPage(best);
	return best;
}
