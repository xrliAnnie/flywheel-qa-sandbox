import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

function findRepoRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(join(dir, ".flywheel", "config.yaml"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("repository root with .flywheel/config.yaml not found");
}

const ROOT = findRepoRoot();

describe("FLY-1436 PR-B production assets", () => {
	it("enrolls flywheel in work-kind routing with the founder-gated rollback note", () => {
		const source = readFileSync(join(ROOT, ".flywheel", "config.yaml"), "utf8");
		const config = parseYaml(source) as {
			pipeline?: { dag?: boolean; work_kind?: boolean };
		};
		const migrationRunbook = readFileSync(
			join(
				ROOT,
				"engineering",
				"doc",
				"FLY-2166-pre-cutover-audit-fix",
				"g2-runbook.md",
			),
			"utf8",
		);
		expect(config.pipeline).toBeUndefined();
		expect(migrationRunbook).toContain(
			'{ name: "pipeline_dag", scope: "flywheel", raw: "1" }',
		);
		expect(migrationRunbook).toContain(
			'{ name: "pipeline_work_kind", scope: "flywheel", raw: "1" }',
		);
	});

	it("keeps the FLY-2103 manual config audit fail-closed", () => {
		const runbook = readFileSync(
			join(
				ROOT,
				"engineering",
				"doc",
				"FLY-2166-pre-cutover-audit-fix",
				"g2-runbook.md",
			),
			"utf8",
		);

		expect(runbook).toContain(
			'if (Object.hasOwn(c, "pipeline")) hit.push("pipeline");',
		);
		expect(runbook).toContain('test -n "$upstream_ref"');
		expect(runbook).toContain('2> "$upstream_error"');
		expect(runbook).toContain(
			'if (hit.length) console.log(hit.sort().join("\\n"));',
		);
	});

	it.each([
		["pm-executor.md", "prd"],
		["prototype-executor.md", "prototype"],
	])(
		"replaces label routing in %s with canonical taskCategory=%s",
		(file, category) => {
			const source = readFileSync(
				join(ROOT, ".flywheel", "agents", "engineering", file),
				"utf8",
			);
			expect(source).not.toContain("no-three-stage");
			expect(source).toContain("FLY-1436 work-kind routing");
			expect(source).toContain(`\"taskCategory\":\"${category}\"`);
			expect(source).toContain("pipeline.work_kind");
			expect(source).toContain("default_fallback");
		},
	);
});
