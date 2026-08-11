import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	RETIRED_BUNDLED_TEMPLATE_IDS,
	retireLegacyWorkflowTemplates,
} from "../workflow-template.js";
import { legacyEngineeringSeed } from "./fixtures/legacy-workflow-manifests.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function storeWithRetiredSeeds(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	for (const templateId of RETIRED_BUNDLED_TEMPLATE_IDS) {
		store.importWorkflowTemplateSeed(legacyEngineeringSeed(templateId));
	}
	return store;
}

describe("FLY-1693 legacy workflow template retirement", () => {
	it("removes retired seed artifacts from incremental package builds", () => {
		const packageJson = JSON.parse(
			readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
		) as { scripts: { build: string } };

		expect(packageJson.scripts.build).toContain(
			"rm -rf dist/static dist/workflow-seeds",
		);
		expect(packageJson.scripts.build).not.toContain(
			"cp -r src/workflow-seeds dist/workflow-seeds",
		);
	});

	it("unbinds system-owned legacy bindings before retiring all twelve templates", async () => {
		const store = await storeWithRetiredSeeds();
		const projects = [
			"geoforge3d",
			"growth",
			"joycon-typeless",
			"personal-assistant",
			"tidal-echo",
		];
		for (const project of projects) {
			store.bindWorkflowCategory({
				project,
				templateId: "tpl_eng_heavy_land_v1",
				updatedBy: "system:FLY-1434-land-migration",
			});
		}

		const result = retireLegacyWorkflowTemplates(store);

		expect(result).toEqual({
			unbound: 5,
			retired: 12,
			blocked: [],
			errors: [],
		});
		expect(store.listWorkflowCategoryBindings()).toEqual([]);
		for (const templateId of RETIRED_BUNDLED_TEMPLATE_IDS) {
			expect(store.getWorkflowTemplate(templateId)?.retired_at).toEqual(
				expect.any(String),
			);
		}
		const retirementAudit = store
			.listWorkflowTemplateAudit()
			.filter((row) => row.actor === "system:FLY-1693-retirement");
		expect(
			retirementAudit.filter((row) => row.action === "unbind"),
		).toHaveLength(5);
		expect(
			retirementAudit.filter((row) => row.action === "template_retire"),
		).toHaveLength(12);
		store.close();
	});

	it("preserves founder-owned bindings and reports the blocked template", async () => {
		const store = await storeWithRetiredSeeds();
		store.bindWorkflowCategory({
			project: "founder-project",
			templateId: "tpl_eng_heavy",
			updatedBy: "founder:annie",
		});
		const logs: string[] = [];

		const result = retireLegacyWorkflowTemplates(store, (message) =>
			logs.push(message),
		);

		expect(result.unbound).toBe(0);
		expect(result.retired).toBe(11);
		expect(result.blocked).toEqual(["tpl_eng_heavy:founder-project/*"]);
		expect(result.errors).toEqual([]);
		expect(store.listWorkflowCategoryBindings()).toMatchObject([
			{
				project: "founder-project",
				task_category: "*",
				template_id: "tpl_eng_heavy",
				updated_by: "founder:annie",
			},
		]);
		expect(logs.join("\n")).toMatch(/preserved custom binding/i);
		expect(logs.join("\n")).toMatch(/retirement blocked/i);
		store.close();
	});

	it("is idempotent and treats a database containing only retained templates as a no-op", async () => {
		const store = await storeWithRetiredSeeds();
		expect(retireLegacyWorkflowTemplates(store).retired).toBe(12);
		const auditCount = store.listWorkflowTemplateAudit().length;
		expect(retireLegacyWorkflowTemplates(store)).toEqual({
			unbound: 0,
			retired: 0,
			blocked: [],
			errors: [],
		});
		expect(store.listWorkflowTemplateAudit()).toHaveLength(auditCount);
		store.close();

		const fresh = await StateStore.create(":memory:");
		expect(retireLegacyWorkflowTemplates(fresh)).toEqual({
			unbound: 0,
			retired: 0,
			blocked: [],
			errors: [],
		});
		expect(fresh.listWorkflowTemplateAudit()).toEqual([]);
		fresh.close();
	});

	it("reports unbind CAS drift without deleting the changed row", () => {
		const fakeStore = {
			listWorkflowCategoryBindings: () => [
				{
					project: "growth",
					task_category: "*",
					template_id: "tpl_eng_heavy_land_v1",
					updated_by: "system:FLY-1434-land-migration",
				},
			],
			unbindWorkflowCategory: () => ({ status: "drifted" as const }),
			retireWorkflowTemplate: () => ({ status: "not_found" as const }),
		};

		expect(retireLegacyWorkflowTemplates(fakeStore)).toEqual({
			unbound: 0,
			retired: 0,
			blocked: [],
			errors: ["growth/*:drifted"],
		});
	});

	it("lets unknown storage errors fail boot", () => {
		const fakeStore = {
			listWorkflowCategoryBindings: () => {
				throw new Error("database is corrupt");
			},
			unbindWorkflowCategory: () => ({ status: "not_found" as const }),
			retireWorkflowTemplate: () => ({ status: "not_found" as const }),
		};

		expect(() => retireLegacyWorkflowTemplates(fakeStore)).toThrow(
			/database is corrupt/,
		);
	});
});
