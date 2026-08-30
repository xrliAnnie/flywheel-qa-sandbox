import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanLegacyWorkflowNames } from "../../../../scripts/fly2121-legacy-name-guard.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "fly2121-name-guard-"));
	roots.push(root);
	mkdirSync(join(root, "packages/teamlead/src"), { recursive: true });
	mkdirSync(join(root, ".flywheel/agents"), { recursive: true });
	writeFileSync(
		join(root, ".flywheel/agents/registry.yaml"),
		"nodes:\n  eng_design:\n    file: nodes/eng_design.md\ngraphs:\n  product_design_flow:\n    nodes: [product_design]\n",
	);
	return root;
}

describe("FLY-2121 legacy workflow name guard", () => {
	it("keeps active repository source and assets free of retired identities", () => {
		expect(scanLegacyWorkflowNames(REPO_ROOT)).toEqual([]);
	});

	it("turns red when one old role or one removed shape path is reintroduced", () => {
		const root = fixture();
		writeFileSync(
			join(root, "packages/teamlead/src/rogue.ts"),
			'export const rogue = { role: "designer" };\n',
		);
		expect(scanLegacyWorkflowNames(root)).toEqual([
			expect.objectContaining({
				path: "packages/teamlead/src/rogue.ts",
				kind: "retired_identity",
			}),
		]);

		rmSync(join(root, "packages/teamlead/src/rogue.ts"));
		mkdirSync(join(root, "menus/shapes"), { recursive: true });
		writeFileSync(join(root, "menus/shapes/design.yaml"), "id: design\n");
		expect(scanLegacyWorkflowNames(root)).toEqual([
			expect.objectContaining({
				path: "menus/shapes",
				kind: "retired_path",
			}),
		]);
	});

	it("turns red on a bare retired code-role tuple in an active script", () => {
		const root = fixture();
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(
			join(root, "scripts/readiness.sh"),
			`jq -e '([.nodes[].role] | sort) == ["design","implement","qa"]'\n`,
		);

		expect(scanLegacyWorkflowNames(root)).toEqual([
			expect.objectContaining({
				path: "scripts/readiness.sh",
				kind: "retired_identity",
			}),
		]);
	});

	it("turns red on a retired design node id embedded in SQL", () => {
		const root = fixture();
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(
			join(root, "scripts/query.mjs"),
			`db.prepare("SELECT * FROM workflow_run_node WHERE node_id = 'design'");\n`,
		);

		expect(scanLegacyWorkflowNames(root)).toEqual([
			expect.objectContaining({
				path: "scripts/query.mjs",
				kind: "retired_identity",
			}),
		]);
	});

	it("turns red when shipped Lead rules advertise the retired design category", () => {
		const root = fixture();
		writeFileSync(
			join(root, "packages/teamlead/src/department-lead-rules.md"),
			"| `design` | product/UX design, flows, or design review |\n",
		);

		expect(scanLegacyWorkflowNames(root)).toEqual([
			expect.objectContaining({
				path: "packages/teamlead/src/department-lead-rules.md",
				kind: "retired_identity",
			}),
		]);
	});

	it("turns red when canonical node ids are mapped back to retired role names", () => {
		const root = fixture();
		writeFileSync(
			join(root, "packages/teamlead/src/compatibility.ts"),
			[
				"export const aliases = {",
				'  eng_design: "design", // FLY-2121-legacy: temporary compatibility.',
				'  product_design: "designer",',
				'  general: "generic",',
				"};",
			].join("\n"),
		);

		expect(scanLegacyWorkflowNames(root)).toEqual([
			expect.objectContaining({
				path: "packages/teamlead/src/compatibility.ts",
				kind: "retired_identity",
				text: expect.stringContaining('eng_design: "design"'),
			}),
			expect.objectContaining({
				path: "packages/teamlead/src/compatibility.ts",
				kind: "retired_identity",
				text: expect.stringContaining('product_design: "designer"'),
			}),
			expect.objectContaining({
				path: "packages/teamlead/src/compatibility.ts",
				kind: "retired_identity",
				text: expect.stringContaining('general: "generic"'),
			}),
		]);
	});

	it("turns red when a shipped Lead prompt names a retired executor file", () => {
		const root = fixture();
		mkdirSync(join(root, ".lead/flywheel-product-lead"), { recursive: true });
		writeFileSync(
			join(root, ".lead/flywheel-product-lead/identity.md"),
			"Dispatch the `product-designer-executor` Mode A.\n",
		);

		expect(scanLegacyWorkflowNames(root)).toEqual([
			expect.objectContaining({
				path: ".lead/flywheel-product-lead/identity.md",
				kind: "retired_identity",
			}),
		]);
	});
});
