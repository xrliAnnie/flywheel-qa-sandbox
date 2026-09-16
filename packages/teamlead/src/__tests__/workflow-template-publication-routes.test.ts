import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { getModelConfigSnapshot } from "flywheel-config";
import { afterEach, expect, it } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { createWorkflowTemplateRouter } from "../bridge/workflow-template-routes.js";
import { StateStore } from "../StateStore.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";
import { WorkflowTemplatePublicationService } from "../workflow-template-publication.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.reverse()) await close();
	cleanup.length = 0;
});
async function fixture() {
	const store = await StateStore.create(":memory:");
	cleanup.push(() => store.close());
	store.importWorkflowTemplateSeed(
		loadWorkflowMenuSeeds().find((s) => s.templateId === "tpl_simple_code")!,
	);
	const service = new WorkflowTemplatePublicationService({
		store,
		tokens: new ConfirmTokenStore(),
		modelSnapshot: getModelConfigSnapshot,
		runtimeBuildSha: "test",
		assertMigrationReady: () => {},
	});
	const app = express();
	app.use("/api/workflow", createWorkflowTemplateRouter(store, service));
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = (path: string, body: unknown, origin = base) =>
		fetch(`${base}/api/workflow/templates/tpl_simple_code/publish/${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify(body),
		});
	return { base, post };
}
it("requires same origin before stage or receipt lookup and exposes immediate publication", async () => {
	const { base, post } = await fixture();
	const request = { from: "seed", reason: "publish reviewed seed" };
	expect((await post("stage", request, "https://evil.example")).status).toBe(
		403,
	);
	const stagedResponse = await post("stage", request);
	expect(stagedResponse.status).toBe(200);
	const staged = await stagedResponse.json();
	const applied = await post("apply", staged);
	expect(applied.status).toBe(200);
	const receipt = await applied.json();
	expect(receipt.published_revision).toBe(2);
	const url = `${base}/api/workflow/publications/${receipt.operation_id}`;
	expect((await fetch(url)).status).toBe(403);
	expect(
		await (await fetch(url, { headers: { origin: base } })).json(),
	).toEqual(receipt);
	const detail = await (
		await fetch(`${base}/api/workflow/templates/tpl_simple_code`)
	).json();
	expect(detail.current_revision.revision).toBe(2);
});
it("rejects forged actors and mismatching apply path", async () => {
	const { post, base } = await fixture();
	expect(
		(await post("stage", { from: "seed", reason: "test", actor: "founder" }))
			.status,
	).toBe(400);
	const stage = await (
		await post("stage", { from: "seed", reason: "test" })
	).json();
	const wrong = await fetch(
		`${base}/api/workflow/templates/tpl_code/publish/apply`,
		{
			method: "POST",
			headers: { origin: base, "content-type": "application/json" },
			body: JSON.stringify(stage),
		},
	);
	expect(wrong.status).toBe(400);
});
