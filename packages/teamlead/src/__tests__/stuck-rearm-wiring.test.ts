/**
 * FLY-253 (Codex R2 #4): production wiring for re_arm — the remanage router
 * mounts inside createBridgeApp BEFORE the StuckRunnerDetector exists, so the
 * router must capture a STABLE callback over a late-bound holder. This test
 * guards the failure mode where route unit tests stay green but the
 * production callback is forever a no-op (holder never read / never filled).
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeApp } from "../bridge/plugin.js";
import type { StuckRunnerDetector } from "../bridge/stuck-runner-detector.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		projectRepo: "x/geo",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "f",
				chatChannel: "c",
				match: { labels: ["Product"] },
			},
		],
	},
] as unknown as ProjectEntry[];

const config = {
	host: "127.0.0.1",
	port: 0,
	dbPath: ":memory:",
	notificationChannel: "test-channel",
	defaultLeadAgentId: "product-lead",
	stuckThresholdMinutes: 15,
	stuckCheckIntervalMs: 300000,
	orphanThresholdMinutes: 60,
	founderConsent: { decisionMode: "off" },
} as unknown as BridgeConfig;

describe("FLY-253 re_arm wiring (late-bound holder)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let holder: { current: StuckRunnerDetector | null };

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1",
			project_name: "geo",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});
		holder = { current: null };
		const app = createBridgeApp(
			store,
			testProjects,
			config,
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
			{ stuckDetectorHolder: holder, stuckLatchTtlMs: 0 },
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		);
		store.close();
	});

	async function postRearm(): Promise<number> {
		const res = await fetch(
			`${baseUrl}/api/sessions/exec-1/stuck-disposition`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leadId: "product-lead", disposition: "re_arm" }),
			},
		);
		return res.status;
	}

	it("a detector assigned AFTER the app mounted still receives rearmExecution (late binding works)", async () => {
		const rearmExecution = vi.fn();
		// Assigned post-mount — exactly the production order (post-listen).
		holder.current = { rearmExecution } as unknown as StuckRunnerDetector;
		expect(await postRearm()).toBe(200);
		expect(rearmExecution).toHaveBeenCalledWith("exec-1");
	});

	it("null holder (detection disabled) ⇒ re_arm still succeeds and deletes the DB latch", async () => {
		store.setStuckDisposition({
			execution_id: "exec-1",
			episode_fingerprint: "*",
			disposition: "legitimate_wait",
		});
		expect(await postRearm()).toBe(200);
		expect(
			store.getStuckDispositionRows("exec-1", "aaaaaaaaaaaaaaaa").sentinel,
		).toBeUndefined();
	});
});
