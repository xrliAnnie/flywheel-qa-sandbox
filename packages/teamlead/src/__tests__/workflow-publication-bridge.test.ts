import type http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import { StateStore } from "../StateStore.js";
import { loadWorkflowMenuSeeds } from "../workflow-menu.js";

const servers: http.Server[] = [];
const stores: StateStore[] = [];
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const store of stores.splice(0)) store.close();
	vi.unstubAllEnvs();
});
async function start(knownBuild = true) {
	vi.stubEnv("FLYWHEEL_BRIDGE_SOURCE_MODE", "1");
	vi.stubEnv("FLYWHEEL_BRIDGE_SOURCE_SHA", knownBuild ? "a".repeat(40) : "");
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.importWorkflowTemplateSeed(
		loadWorkflowMenuSeeds().find((s) => s.templateId === "tpl_simple_code")!,
	);
	const app = createBridgeApp(store, [], {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		notificationChannel: "test",
		defaultLeadAgentId: "test",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
	});
	const server = app.listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("address missing");
	return { store, base: `http://127.0.0.1:${address.port}` };
}
async function post(base: string, suffix: string, body: unknown) {
	return fetch(
		`${base}/api/workflow/templates/tpl_simple_code/publish/${suffix}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: base },
			body: JSON.stringify(body),
		},
	);
}
it("mounts managed publication and immediately exposes its new revision through the read alias", async () => {
	const { store, base } = await start();
	const stage = await post(base, "stage", {
		from: "seed",
		reason: "isolated integration verification",
	});
	expect(stage.status).toBe(200);
	const staged = await stage.json();
	const apply = await post(base, "apply", staged);
	expect(apply.status).toBe(200);
	const receipt = await apply.json();
	expect(receipt.published_revision).toBe(2);
	const read = await fetch(`${base}/api/workflow-templates/tpl_simple_code`);
	expect(read.status).toBe(200);
	const body = await read.json();
	expect(body.template.current_published_revision).toBe(2);
	expect(
		store.getWorkflowTemplatePublishReceipt(staged.canonical.operationId),
	).toMatchObject({ published_revision: 2, runtime_build_sha: "a".repeat(40) });
}, 20000);
it("fails closed for an unknown Bridge build without changing the catalog", async () => {
	const { store, base } = await start(false);
	const stage = await post(base, "stage", {
		from: "seed",
		reason: "unknown build",
	});
	expect(stage.status).toBe(503);
	expect(await stage.json()).toMatchObject({ reason: "runtime_build_unknown" });
	expect(
		store.getWorkflowTemplate("tpl_simple_code")?.current_published_revision,
	).toBe(1);
}, 20000);
it("mounts lead configuration with same-origin and the smaller body limit behind the global parser", async () => {
	const { base, store } = await start();
	const request = (body: unknown) =>
		fetch(`${base}/api/lead-config/stage`, {
			method: "POST",
			headers: { origin: base, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	expect((await request({})).status).toBe(400);
	expect((await fetch(`${base}/api/lead-config/operations/op`)).status).toBe(
		403,
	);
	expect((await request({ payload: "x".repeat(17000) })).status).toBe(413);
	expect(store.listPendingLeadConfigOperations()).toHaveLength(0);
}, 20000);
