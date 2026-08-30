import { describe, expect, it } from "vitest";
import {
	buildWorkflowSelectionDigestBody,
	CATEGORY_SOURCES,
	canonicalizeEngTier,
	canonicalizeRoutingOverrides,
	canonicalizeWorkKind,
	DEFAULT_ENG_TIER,
	DEPT_SUGGESTED_CATEGORY,
	ENG_TIERS,
	formatWorkflowRouteVisibility,
	ROUTING_OVERRIDES_ALLOWLIST,
	WORK_KIND_CATEGORIES,
	WORKFLOW_SNAPSHOT_TASK_CATEGORIES,
} from "../work-kind.js";

describe("work-kind vocabulary", () => {
	it("exports the single contract vocabularies", () => {
		expect(WORK_KIND_CATEGORIES).toEqual([
			"code",
			"simple_code",
			"prd",
			"product_design_flow",
			"prototype",
			"generic",
		]);
		expect(WORKFLOW_SNAPSHOT_TASK_CATEGORIES).toEqual([
			...WORK_KIND_CATEGORIES,
			"design",
		]);
		expect(ENG_TIERS).toEqual(["trivial", "light", "heavy"]);
		expect(DEFAULT_ENG_TIER).toBe("heavy");
		expect(ROUTING_OVERRIDES_ALLOWLIST).toEqual(["no-three-stage"]);
		expect(CATEGORY_SOURCES).toEqual([
			"task_category",
			"template_override",
			"default_fallback",
		]);
		expect(DEPT_SUGGESTED_CATEGORY).toEqual({
			product: "prd",
			engineering: "code",
		});
	});

	it.each([undefined, null, "", "   "])(
		"treats %j as an absent work-kind",
		(raw) => expect(canonicalizeWorkKind(raw)).toEqual({ status: "absent" }),
	);

	it("canonicalizes case and surrounding whitespace", () => {
		expect(canonicalizeWorkKind("  PrOdUcT_DeSiGn_FlOw ")).toEqual({
			status: "valid",
			category: "product_design_flow",
		});
	});

	it("fails loud for the retired research and designer spellings", () => {
		expect(canonicalizeWorkKind("research")).toEqual({
			status: "invalid",
			reason: "unknown_category",
		});
		expect(canonicalizeWorkKind("designer")).toEqual({
			status: "invalid",
			reason: "unknown_category",
		});
		expect(canonicalizeWorkKind("design")).toEqual({
			status: "invalid",
			reason: "unknown_category",
		});
	});

	it("distinguishes non-string and unknown explicit values", () => {
		expect(canonicalizeWorkKind(42)).toEqual({
			status: "invalid",
			reason: "not_string",
		});
		expect(canonicalizeWorkKind("coding")).toEqual({
			status: "invalid",
			reason: "unknown_category",
		});
	});

	it("canonicalizes tiers without inventing a value for absent input", () => {
		expect(canonicalizeEngTier(undefined)).toEqual({ status: "absent" });
		expect(canonicalizeEngTier(" LiGhT ")).toEqual({
			status: "valid",
			tier: "light",
		});
		expect(canonicalizeEngTier("medium")).toEqual({
			status: "invalid",
			reason: "unknown_tier",
		});
	});

	it("accepts only the dispatch-time routing override allowlist", () => {
		expect(canonicalizeRoutingOverrides(undefined)).toEqual({
			status: "valid",
			overrides: [],
		});
		expect(canonicalizeRoutingOverrides(["no-three-stage"])).toEqual({
			status: "valid",
			overrides: ["no-three-stage"],
		});
		expect(canonicalizeRoutingOverrides("no-three-stage")).toEqual({
			status: "invalid",
			reason: "not_array",
		});
		expect(canonicalizeRoutingOverrides(["no-qa"])).toEqual({
			status: "invalid",
			reason: "unknown_override",
		});
	});

	it("renders one founder-facing route line without mutating the issue title", () => {
		expect(
			formatWorkflowRouteVisibility({
				route: "pipeline_dag_v1",
				category: "code",
				source: "task_category",
				tier: "heavy",
			}),
		).toBe(
			"🧭 **Route**: `code` → `pipeline_dag_v1` · tier `heavy` · source `task_category`",
		);
		expect(
			formatWorkflowRouteVisibility({
				route: "generic_fallback",
				source: "default_fallback",
			}),
		).toBe("🧭 **Route**: `generic` · source `default_fallback`");
	});
});

describe("buildWorkflowSelectionDigestBody", () => {
	const legacy = {
		project: "flywheel",
		issueId: "FLY-1407",
		category: "code",
		templateId: "tpl_eng",
		revision: 3,
		selectionSource: "binding" as const,
		selectedBy: "flywheel-eng-lead",
		reason: "binding:code",
	};

	it("preserves the exact legacy digest body when work-kind is off", () => {
		expect(buildWorkflowSelectionDigestBody(legacy)).toEqual(legacy);
	});

	it("adds category source and tier only in the active work-kind domain", () => {
		expect(
			buildWorkflowSelectionDigestBody(legacy, {
				categorySource: "task_category",
				tier: "heavy",
			}),
		).toEqual({
			...legacy,
			categorySource: "task_category",
			tier: "heavy",
		});
	});
});
