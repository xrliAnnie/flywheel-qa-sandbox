import { describe, expect, it } from "vitest";
import { buildFounderView } from "../founder-view.js";
import { generateEpicPage } from "../generate.js";
import { assertEpicPage, type EpicPage } from "../model.js";
import { buildEpicPageRenderReceipt } from "../receipt.js";
import { renderEpicPageBundle } from "../render-html.js";
import { summarizeEpicResidual } from "../residual.js";
import {
	EPIC_SHAPE_NOW,
	epicShapeSnapshot,
	v3ItemFacts,
} from "./fixtures/epic-shape.js";

function fixture() {
	const snapshot = epicShapeSnapshot();
	const page = generateEpicPage({
		snapshot,
		itemFacts: v3ItemFacts(snapshot),
		now: EPIC_SHAPE_NOW,
		projectName: "example",
		trigger: "scan",
	});
	const root = page.header.roots.value!.find(
		(r) => r.identifier === "EPX-200",
	)!;
	Object.assign(root, {
		has_child_issues: false,
		intake: {
			value: {
				event_uid: `epic_intake:uuid:${page.generated_at}`,
				started_at: page.generated_at,
				intake_at: page.generated_at,
				backfill: false,
				work_state: "pending",
			},
			observed_at: page.generated_at,
			provenance: {
				kind: "statestore",
				table: "epic_intakes",
				key: { event_uid: `epic_intake:uuid:${page.generated_at}` },
			},
		},
	});
	Object.assign(page.header.scope_definition, {
		value: {
			root_state_type: "started",
			daily_title_contains: null,
			item_state_filter: "none",
		},
		provenance: {
			...page.header.scope_definition.provenance,
			rule: "scope.v3",
		},
	});
	return page as EpicPage;
}
describe("intake page compatibility", () => {
	it("accepts scope.v3 and retains an honest zero-child pending Epic", () => {
		const page = fixture();
		expect(() => assertEpicPage(page)).not.toThrow();
		expect(buildFounderView(page).epics.map((e) => e.identifier)).toContain(
			"EPX-200",
		);
		const html = renderEpicPageBundle(page, EPIC_SHAPE_NOW).html;
		expect(html).toContain("待拆解（intake 于");
		expect(
			buildEpicPageRenderReceipt(page).sources.some((s) =>
				s.path.includes("/intake"),
			),
		).toBe(true);
	});
	it("rejects malformed intake data instead of silently treating it as zero", () => {
		const page = fixture();
		Object.assign(page.header.roots.value![0], { has_child_issues: "false" });
		expect(() => assertEpicPage(page)).toThrow();
	});
	it("does not show an archived-children root as undecomposed", () => {
		const page = fixture();
		Object.assign(
			page.header.roots.value!.find((r) => r.identifier === "EPX-200")!,
			{ has_child_issues: true },
		);
		expect(renderEpicPageBundle(page, EPIC_SHAPE_NOW).html).toContain(
			"待核依赖",
		);
		expect(renderEpicPageBundle(page, EPIC_SHAPE_NOW).html).not.toContain(
			"待拆解（intake 于",
		);
	});
	it("generates intake only for the current root's matching episode", () => {
		const snapshot = epicShapeSnapshot();
		const root = snapshot.roots.find((r) => r.identifier === "EPX-200")!;
		Object.assign(root, {
			hasChildIssues: false,
			startedAt: snapshot.fetchedAt,
		});
		const record = {
			eventUid: `epic_intake:${root.id}:${snapshot.fetchedAt}`,
			issueUuid: root.id,
			identifier: root.identifier,
			startedAt: snapshot.fetchedAt,
			intakeAt: snapshot.fetchedAt,
			observedAt: snapshot.fetchedAt,
			projectName: "example",
			leadId: "lead",
			bindingDigest: "binding",
			sourceSpanIds: ["span"],
			backfill: false,
			active: true,
			workState: "pending" as const,
			leadEventSeq: 1,
			pageDirty: true,
			result: null,
		};
		const input = {
			snapshot,
			itemFacts: v3ItemFacts(snapshot),
			now: EPIC_SHAPE_NOW,
			projectName: "example",
			trigger: "scan" as const,
			intakes: [record],
		};
		const page = generateEpicPage(input);
		const residual = summarizeEpicResidual({
			materialized: { page, snapshot },
			leadId: "lead",
			resolveOwner: () => ({
				agentId: "lead",
				matchMethod: "label",
				canSpawn: true,
			}),
			trigger: "scope",
			pendingIntakes: [record],
		});
		expect(residual.pendingIntakeForLeadTotal).toBe(1);
		expect(residual.pendingIntakeForLead?.[0]).toMatchObject({
			eventUid: record.eventUid,
			identifier: root.identifier,
		});
		expect(residual.remaining).toBe(
			residual.ready + residual.running + residual.blocked,
		);
		expect(page.header.scope_definition.provenance).toMatchObject({
			rule: "scope.v3",
		});
		expect(
			page.header.roots.value!.find((r) => r.identifier === root.identifier)
				?.intake?.value?.event_uid,
		).toBe(record.eventUid);
		expect(
			generateEpicPage({
				...input,
				intakes: [{ ...record, startedAt: "2000-01-01T00:00:00.000Z" }],
			}).header.roots.value!.find((r) => r.identifier === root.identifier)
				?.intake,
		).toBeUndefined();
	});
	it("reads old scope.v2 and rejects a mismatched scope rule", () => {
		const page = fixture();
		page.header.scope_definition.value!.daily_title_contains = "日常";
		Object.assign(page.header.scope_definition.provenance, {
			rule: "scope.v2",
		});
		expect(() => assertEpicPage(page)).not.toThrow();
		page.header.scope_definition.value!.daily_title_contains = null;
		expect(() => assertEpicPage(page)).toThrow();
	});
});
