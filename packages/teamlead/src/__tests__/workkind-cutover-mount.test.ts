import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { importWorkflowMenuSeeds } from "../workflow-menu.js";
import { importLegacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const servers: http.Server[] = [];
const stores: StateStore[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
	for (const store of stores.splice(0)) store.close();
});

function config(apiToken?: string): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		apiToken,
		notificationChannel: "test-channel",
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
	} as BridgeConfig;
}

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/canonical/flywheel",
		leads: [],
	},
];

async function boot(apiToken?: string): Promise<string> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	importLegacyWorkflowSeeds(store);
	importWorkflowMenuSeeds(store);
	store.bindWorkflowCategory({
		project: "flywheel",
		templateId: "tpl_eng_heavy",
		updatedBy: "system:bundled-default",
	});
	const app = createBridgeApp(
		store,
		projects,
		config(apiToken),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			workKindCutoverTokens: new ConfirmTokenStore(),
			workKindCutoverEvidence: () => ({
				templateDispatch: true,
				generalizedTemplates: true,
				workKind: true,
				prBAssetsReady: true,
				deployedSha: "a".repeat(40),
				assetsDigest: "b".repeat(64),
			}),
		},
	);
	const server = app.listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("listen failed");
	return `http://127.0.0.1:${address.port}`;
}

async function stage(baseUrl: string, bearer?: string) {
	return fetch(`${baseUrl}/api/workflow/cutovers/FLY-1436/stage`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
		},
		body: JSON.stringify({ kind: "activate" }),
	});
}

describe("FLY-1436 Bridge route mount", () => {
	it("is present and fails closed without the master token", async () => {
		expect((await stage(await boot())).status).toBe(503);
	});

	it("uses the master token and injected production evidence seam", async () => {
		const baseUrl = await boot("master-token");
		expect((await stage(baseUrl, "wrong")).status).toBe(401);
		const response = await stage(baseUrl, "master-token");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			canonical: {
				activationId: "FLY-1436",
				project: "flywheel",
			},
		});
	});
});
