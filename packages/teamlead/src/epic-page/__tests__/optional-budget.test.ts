import { expect, it } from "vitest";
import { decodeAuditSidecar } from "../audit-sidecar.js";
import {
	hostedBundleBytes,
	renderEpicPageBudgetBundle,
} from "../optional-budget.js";
import { renderEpicPageBundle } from "../render-html.js";
import { EPIC_SHAPE_NOW } from "./fixtures/epic-shape.js";
import { pageForBudgetBase } from "./fixtures/founder-budget.js";

it("shrinks only optional rows against hardened bytes and keeps all audit evidence", () => {
	const page = pageForBudgetBase(60);
	for (const item of page.items)
		item.ship_judgment = {
			value: {
				question_id: item.identifier,
				opinion_id: item.identifier,
				input_id: null,
				evaluation_id: null,
				source: "machine",
				overall: "undetermined",
				alignment: null,
				conflict: null,
				coverage: null,
				display: "pending",
				reason: "no_qa",
				policy_version: "v1",
				model_snapshot_digest: null,
				evidence: { evaluation: null, mechanical: null },
			},
			observed_at: EPIC_SHAPE_NOW.toISOString(),
			provenance: {
				kind: "statestore",
				table: "ship_judgment_opinion",
				key: { issue_identifier: item.identifier },
			},
		};
	const original = structuredClone(page);
	const minimum = renderEpicPageBundle(page, EPIC_SHAPE_NOW, {
		historyRows: 0,
		judgmentRows: 0,
	});
	const limit = hostedBundleBytes(minimum) + 500;
	const fitted = renderEpicPageBudgetBundle(page, EPIC_SHAPE_NOW, limit);
	expect(hostedBundleBytes(fitted)).toBeLessThanOrEqual(limit);
	expect(fitted.html.match(/class="kid"/g)).toHaveLength(60);
	expect(fitted.html.match(/data-root=/g)).toHaveLength(8);
	expect(fitted.html).toContain("机器意见摘要已缩减");
	expect(decodeAuditSidecar(fitted.audit.json)).toContainEqual(
		page.items[59]!.ship_judgment,
	);
	expect(page).toEqual(original);
	const impossible = renderEpicPageBudgetBundle(page, EPIC_SHAPE_NOW, 100);
	expect(hostedBundleBytes(impossible)).toBeGreaterThan(100);
	expect(impossible.html.match(/class="kid"/g)).toHaveLength(60);
});

it("keeps the history footer independent of preview-row budgets and retains history audit evidence", async () => {
	const { pageForShipJudgmentBudget } = await import(
		"./fixtures/founder-budget.js"
	);
	const page = pageForShipJudgmentBudget();
	const full = renderEpicPageBundle(page, EPIC_SHAPE_NOW);
	const noHistory = renderEpicPageBundle(page, EPIC_SHAPE_NOW, {
		historyRows: 0,
	});
	expect(noHistory).toEqual(full);
	const limit = hostedBundleBytes(full);
	const fitted = renderEpicPageBudgetBundle(page, EPIC_SHAPE_NOW, limit);
	expect(fitted.html).not.toContain("data-history-row");
	expect(fitted.html.match(/机器试判历史按需生成/g)).toHaveLength(1);
	expect(fitted.html.match(/<div data-judgment>/g)).toHaveLength(60);
	expect(hostedBundleBytes(fitted)).toBeLessThanOrEqual(limit);
	expect(decodeAuditSidecar(fitted.audit.json)).toContainEqual(
		page.ship_judgment_history,
	);
});
