import { injectHeadMeta } from "../bridge/report-registry.js";
import type { EpicPage } from "./model.js";
import { type EpicPageBundle, renderEpicPageBundle } from "./render-html.js";

const PREVIOUS_AUDIT_BYTES = Buffer.byteLength(
	` data-previous-audit="${"0".repeat(64)}"`,
);
/** Measurement string only: reserves the Blob binding attribute after actual hardening. */
export function hostedBudgetHtml(bundle: EpicPageBundle): string {
	return injectHeadMeta(bundle.html) + " ".repeat(PREVIOUS_AUDIT_BYTES);
}
export function hostedBundleBytes(bundle: EpicPageBundle): number {
	return Math.max(
		Buffer.byteLength(bundle.html),
		Buffer.byteLength(hostedBudgetHtml(bundle)),
	);
}
/** Reduce optional presentation only; the publisher still enforces both final limits. */
export function renderEpicPageBudgetBundle(
	page: EpicPage,
	now: Date,
	maxBytes = 524288,
): EpicPageBundle {
	const render = (historyRows: number, judgmentRows: number) =>
		renderEpicPageBundle(page, now, { historyRows, judgmentRows });
	const historyCount = page.ship_judgment_history?.value?.rows.length ?? 0;
	const judgmentCount = page.items.filter(
		(item) => item.ship_judgment !== undefined,
	).length;
	const full = render(historyCount, judgmentCount);
	if (hostedBundleBytes(full) <= maxBytes) return full;
	const withoutHistory = render(0, judgmentCount);
	function largest(
		count: number,
		build: (n: number) => EpicPageBundle,
		minimum: EpicPageBundle,
	) {
		let low = 0,
			high = count - 1,
			best = minimum;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2),
				candidate = build(mid);
			if (hostedBundleBytes(candidate) <= maxBytes) {
				best = candidate;
				low = mid + 1;
			} else high = mid - 1;
		}
		return best;
	}
	if (hostedBundleBytes(withoutHistory) <= maxBytes)
		return largest(
			historyCount,
			(n) => render(n, judgmentCount),
			withoutHistory,
		);
	const minimum = render(0, 0);
	if (hostedBundleBytes(minimum) > maxBytes) return minimum;
	return largest(judgmentCount, (n) => render(0, n), minimum);
}
