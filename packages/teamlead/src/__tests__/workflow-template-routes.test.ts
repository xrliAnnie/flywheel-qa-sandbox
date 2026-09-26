import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowTemplateRouter } from "../bridge/workflow-template-routes.js";
import { StateStore } from "../StateStore.js";
import { importBundledWorkflowSeeds } from "../workflow-template.js";

const close: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of close.splice(0).reverse()) await fn();
});

async function serve(store: StateStore): Promise<string> {
	const app = express();
	app.use(express.json());
	app.use("/api/workflow", createWorkflowTemplateRouter(store));
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	close.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("workflow template read model", () => {
	it("serves templates, revisions, and category bindings but no mutation endpoints", async () => {
		const store = await StateStore.create(":memory:");
		close.push(() => store.close());
		importBundledWorkflowSeeds(store);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "*",
			templateId: "tpl_eng_heavy",
			updatedBy: "lead",
		});
		const base = await serve(store);

		const list = await fetch(`${base}/api/workflow/templates`).then((res) =>
			res.json(),
		);
		expect(list.templates).toHaveLength(3);
		const detail = await fetch(
			`${base}/api/workflow/templates/tpl_eng_heavy`,
		).then((res) => res.json());
		expect(detail.current_revision.manifest.nodes).toHaveLength(4);
		const revisions = await fetch(
			`${base}/api/workflow/templates/tpl_eng_heavy/revisions`,
		).then((res) => res.json());
		expect(revisions.revisions).toHaveLength(1);
		const binding = await fetch(
			`${base}/api/workflow/template-binding?project=flywheel&category=bug`,
		).then((res) => res.json());
		expect(binding.binding).toMatchObject({
			task_category: "*",
			template_id: "tpl_eng_heavy",
		});

		for (const path of [
			"templates",
			"templates/tpl_eng_heavy/publish",
			"template-binding",
		]) {
			const response = await fetch(`${base}/api/workflow/${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(response.status).toBe(404);
		}
	});
});
