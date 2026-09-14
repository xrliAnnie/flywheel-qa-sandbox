import { canonicalJsonString } from "flywheel-config";
import { expect, it } from "vitest";
import { assertEpicPage, EPIC_PAGE_MAX_DOCUMENT_BYTES } from "../model.js";
import { renderEpicPageBundle } from "../render-html.js";
import { EPIC_SHAPE_NOW } from "./fixtures/epic-shape.js";
import { pageForBudgetBase } from "./fixtures/founder-budget.js";

it("fits the 60-child E1 baseline before sibling note and attention integration", () => {
	const page = pageForBudgetBase(60);
	const bytes = Buffer.byteLength(
		renderEpicPageBundle(page, EPIC_SHAPE_NOW).html,
	);
	console.info(
		JSON.stringify({
			baseline_children: 60,
			html_bytes: bytes,
			notes_and_attention: "not integrated",
		}),
	);
	expect(bytes).toBeLessThanOrEqual(491520);
});

it("fits the unchanged eight-root sixty-child scale with notes, judgments and twenty saturated history rows", async () => {
	const { pageForShipJudgmentBudget } = await import(
		"./fixtures/founder-budget.js"
	);
	const { hostedBundleBytes } = await import("../optional-budget.js");
	const page = pageForShipJudgmentBudget();
	expect(() => assertEpicPage(page)).not.toThrow();
	expect(Buffer.byteLength(canonicalJsonString(page))).toBeLessThanOrEqual(
		EPIC_PAGE_MAX_DOCUMENT_BYTES,
	);
	const bundle = renderEpicPageBundle(page, EPIC_SHAPE_NOW);
	expect(page.header.roots.value).toHaveLength(8);
	expect(page.items).toHaveLength(60);
	expect(
		page.items.every(
			(item) => Array.from(item.lead_note![0]!.value!).length === 280,
		),
	).toBe(true);
	expect(bundle.html.match(/data-history-row/g)).toHaveLength(20);
	expect(bundle.html.match(/<div data-judgment>/g)).toHaveLength(60);
	expect(Buffer.byteLength(bundle.html)).toBeLessThanOrEqual(491520);
	expect(hostedBundleBytes(bundle)).toBeLessThanOrEqual(524288);
	console.info(
		JSON.stringify({
			roots: 8,
			children: 60,
			notesPerIssue: 1,
			noteCodepoints: 280,
			historyRows: 20,
			judgmentRows: 60,
			rawBytes: Buffer.byteLength(bundle.html),
			hardenedWithBindingBytes: hostedBundleBytes(bundle),
			attention: "excluded in this v1 baseline; combined case follows",
		}),
	);
});

it("measures the combined child cap with the real attention warning and budgets 200 attention candidates at that cap", async () => {
	const { pageForShipJudgmentAttentionBudget } = await import(
		"./fixtures/founder-budget.js"
	);
	const { applyAttentionBudget } = await import("../attention-budget.js");
	const { rebuildAttention } = await import("../attention.js");
	const { injectHeadMeta } = await import("../../bridge/report-registry.js");
	const binding = ` data-previous-audit="${"0".repeat(64)}"`;
	const render = (
		page: Awaited<ReturnType<typeof pageForShipJudgmentAttentionBudget>>,
	) =>
		injectHeadMeta(renderEpicPageBundle(page, EPIC_SHAPE_NOW).html) + binding;
	const zero = async (n: number) => {
		const page = await pageForShipJudgmentAttentionBudget(n);
		Object.assign(page, rebuildAttention(page, [], page.generated_at, true));
		return page;
	};
	const baseline = await zero(60);
	expect(
		Buffer.byteLength(renderEpicPageBundle(baseline, EPIC_SHAPE_NOW).html),
	).toBeLessThanOrEqual(491520);
	let cap = 59;
	for (let n = 60; n <= 200; n++) {
		if (Buffer.byteLength(render(await zero(n))) > 524288) break;
		cap = n;
	}
	expect(cap).toBeGreaterThanOrEqual(60);
	const capBytes = Buffer.byteLength(render(await zero(cap)));
	expect(capBytes).toBeLessThanOrEqual(524288);
	if (cap < 200)
		expect(Buffer.byteLength(render(await zero(cap + 1)))).toBeGreaterThan(
			524288,
		);
	const full = await pageForShipJudgmentAttentionBudget(cap);
	const selected = applyAttentionBudget(full, render);
	expect(selected.items).toHaveLength(cap);
	expect(selected.header.roots.value).toHaveLength(8);
	expect(selected.ship_judgment_history!.value!.rows).toHaveLength(20);
	expect(selected.attention_sources.budget.missing?.reason).toBe(
		"source_truncated",
	);
	expect(Buffer.byteLength(render(selected))).toBeLessThanOrEqual(524288);
	console.info(
		JSON.stringify({
			combinedChildCap: cap === 200 ? ">=200" : cap,
			capBytes,
			notesPerIssue: 1,
			noteCodepoints: 280,
			historyRows: 20,
			inputAttention: 200,
			retainedAttention: selected.attention.length,
		}),
	);
});
