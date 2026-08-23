import { describe, expect, it } from "vitest";
import { loadWorkKindConfigStrict } from "../bridge/pipeline-config-source.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const PROJECT = {
	projectName: "flywheel",
	projectRoot: "/projects/flywheel",
	leads: [],
} as unknown as ProjectEntry;

function yaml(pipeline: string): string {
	return [
		"project: flywheel",
		"linear:",
		"  team_id: FLY",
		"runners:",
		"  default: claude",
		"  available:",
		"    claude:",
		"      type: claude",
		"teams:",
		"  - name: default",
		"    orchestrators: []",
		"decision_layer:",
		"  autonomy_level: advisor",
		"  escalation_channel: discord",
		"pipeline:",
		...pipeline.split("\n").map((line) => `  ${line}`),
		"",
	].join("\n");
}

describe("loadWorkKindConfigStrict", () => {
	it("enrolls only an explicit boolean work_kind with dag enabled", () => {
		expect(
			loadWorkKindConfigStrict(PROJECT, () =>
				yaml("work_kind: true\ndag: true"),
			),
		).toEqual({ ok: true, workKind: true, dag: true });
	});

	it("returns a typed cause for a malformed work_kind value", () => {
		expect(
			loadWorkKindConfigStrict(PROJECT, () =>
				yaml('work_kind: "yes"\ndag: true'),
			),
		).toEqual({ ok: false, cause: "work_kind_not_boolean" });
	});

	it("requires dag:true when work_kind is enabled", () => {
		expect(
			loadWorkKindConfigStrict(PROJECT, () =>
				yaml("work_kind: true\ndag: false"),
			),
		).toEqual({ ok: false, cause: "work_kind_requires_dag" });
	});

	it("keeps unrelated malformed pipeline fields on the legacy route", () => {
		expect(
			loadWorkKindConfigStrict(PROJECT, () =>
				yaml('work_kind: false\ndag: "yes"\nunrelated: "yes"'),
			),
		).toEqual({ ok: true, workKind: false, dag: false });
	});

	it("defaults a missing project config to DAG-on with work-kind disabled", () => {
		expect(
			loadWorkKindConfigStrict(PROJECT, () => {
				const error = new Error("missing") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}),
		).toEqual({ ok: true, workKind: false, dag: true });
	});
});
