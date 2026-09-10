import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createCodexQuotaRouter } from "../codex-quota-route.js";

const stores: StateStore[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0))
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	for (const store of stores.splice(0)) store.close();
});

describe("Codex review quota routes", () => {
	it.each(["direct", "bridge"])(
		"%s binds actual digest under a Claude parent and observes only typed Codex review quota",
		async (mount) => {
			const store = await StateStore.create(":memory:");
			stores.push(store);
			store.upsertSession({
				execution_id: "claude-parent",
				project_name: "fixture",
				issue_id: "FLY-1",
				status: "running",
				adapter_type: "claude",
			});
			store.codexQuota.initializeRoot({
				rootKey: "root",
				profile: "business",
				accountKey: "business-key",
				generation: 1,
			});
			const credential = async () => ({
				rootKey: "root",
				profile: "business",
				accountKey: "business-key",
				generation: 1,
				authDigest: "a".repeat(64),
			});
			let app = express();
			if (mount === "direct") {
				app.use(express.json());
				app.use(
					"/api/codex/quota",
					createCodexQuotaRouter({
						store,
						ingestToken: "fixture-token",
						credential,
					}),
				);
			} else {
				const { createBridgeApp } = await import("../plugin.js");
				app = createBridgeApp(
					store,
					[{ projectName: "fixture", projectRoot: "/fixture", leads: [] }],
					{
						host: "127.0.0.1",
						port: 0,
						ingestToken: "fixture-token",
						dbPath: ":memory:",
						notificationChannel: "fixture",
						defaultLeadAgentId: "fixture-lead",
						stuckThresholdMinutes: 15,
						stuckCheckIntervalMs: 300000,
						orphanThresholdMinutes: 60,
					} as import("../types.js").BridgeConfig,
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
						codexQuota: {
							rootKey: "root",
							runtime: {
								credential,
							} as import("../../codex-quota/runtime.js").CodexQuotaRuntime,
							canRecover: async () => false,
						},
					},
				);
			}
			const server = await new Promise<Server>((resolve) => {
				const s = app.listen(0, "127.0.0.1", () => resolve(s));
			});
			servers.push(server);
			const port = (server.address() as { port: number }).port;
			const post = (path: string, body: unknown, token = "fixture-token") =>
				fetch(`http://127.0.0.1:${port}/api/codex/quota/${path}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				});
			const request = {
				executionId: "claude-parent",
				projectName: "fixture",
				invocationId: "review-1",
				model: "gpt-6-astra",
				purpose: "review",
				authDigest: "a".repeat(64),
			};
			expect((await post("bind", request, "bad-token")).status).toBe(401);
			expect(
				(await post("bind", { ...request, model: undefined })).status,
			).toBe(400);
			expect(
				(await post("bind", { ...request, authDigest: "b".repeat(64) })).status,
			).toBe(409);
			const bound = (await (await post("bind", request)).json()) as {
				binding: { bindingId: string };
				state: string;
			};
			expect(bound.state).toBe("ready");
			expect(store.codexQuota.getReviewModel(bound.binding.bindingId)).toBe(
				"gpt-6-astra",
			);
			const signal = {
				version: 1,
				vendor: "codex",
				source: "review_exec",
				sourceEventId: "review-limit-1",
				bindingId: bound.binding.bindingId,
				evidence: "usageLimitExceeded",
				observedAt: "2026-09-09T00:00:00.000Z",
			};
			expect(
				(
					await post("observe", {
						executionId: "claude-parent",
						projectName: "fixture",
						signal,
					})
				).status,
			).toBe(200);
			expect(store.codexQuota.listIncidents()).toHaveLength(1);
			expect(store.codexQuota.listTargets("codex:root:1")[0]?.target_kind).toBe(
				"review",
			);
			expect(store.codexQuota.isExecutionPaused("claude-parent")).toBe(false);
			const resumed = {
				executionId: "claude-parent",
				projectName: "fixture",
				bindingId: bound.binding.bindingId,
				state: "resumed",
				successorBindingId: "review-successor",
			};
			expect((await post("status", resumed)).status).toBe(409);
			store.codexQuota.recordInstalling({
				incidentId: "codex:root:1",
				profile: "school",
				accountKey: "school-key",
				priorAuthDigest: "a".repeat(64),
				installedAuthDigest: "b".repeat(64),
				recoveryMaterialPath: "/tmp/fixture-retained-auth",
			});
			store.codexQuota.commitGeneration({
				incidentId: "codex:root:1",
				expectedGeneration: 1,
				profile: "school",
				accountKey: "school-key",
				authDigest: "b".repeat(64),
				probeResult: "ok",
			});
			store.codexQuota.registerBinding({
				bindingId: "review-successor",
				executionId: "claude-parent",
				runId: null,
				purpose: "review",
				accountKey: "school-key",
				profile: "school",
				generation: 2,
				credentialRootKey: "root",
			});
			expect((await post("status", resumed)).status).toBe(200);
			expect(store.codexQuota.listTargets("codex:root:1")[0]?.state).toBe(
				"recovered",
			);

			store.upsertSession({
				execution_id: "claude-parent",
				project_name: "fixture",
				issue_id: "FLY-1",
				status: "completed",
				adapter_type: "claude",
			});
			const terminalStatus = await fetch(
				`http://127.0.0.1:${port}/api/codex/quota/status?executionId=claude-parent&projectName=fixture&bindingId=${bound.binding.bindingId}`,
				{ headers: { authorization: "Bearer fixture-token" } },
			);
			expect((await terminalStatus.json()).state).toBe("abandoned");
			expect(store.codexQuota.listTargets("codex:root:1")[0]?.state).toBe(
				"abandoned",
			);

			expect(
				(
					await post("observe", {
						executionId: "claude-parent",
						projectName: "fixture",
						signal: { ...signal, evidence: "rateLimitExceeded" },
					})
				).status,
			).toBe(400);
		},
		20000,
	);
});
it("manual generation advance grants neither an old review retry nor a resumed acknowledgement", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.upsertSession({
		execution_id: "author",
		project_name: "fixture",
		issue_id: "FLY-2",
		status: "running",
		adapter_type: "claude",
	});
	store.codexQuota.initializeRoot({
		rootKey: "root",
		accountKey: "old",
		profile: "business",
		generation: 1,
	});
	const binding = {
		bindingId: "review-old",
		executionId: "author",
		runId: null,
		purpose: "review" as const,
		accountKey: "old",
		profile: "business",
		generation: 1,
		credentialRootKey: "root",
	};
	store.codexQuota.registerBinding(binding);
	store.codexQuota.recordSignal({
		executionId: "author",
		bindingId: binding.bindingId,
	});
	store.codexQuota.reconcileExternalRoot({
		rootKey: "root",
		expectedGeneration: 1,
		accountKey: "manual",
		profile: "school",
		authDigest: "b".repeat(64),
	});
	store.codexQuota.registerBinding({
		...binding,
		bindingId: "review-new",
		generation: 2,
		accountKey: "manual",
		profile: "school",
	});
	const app = express();
	app.use(express.json());
	app.use(
		"/api/codex/quota",
		createCodexQuotaRouter({
			store,
			ingestToken: "token",
			credential: async () => ({
				rootKey: "root",
				accountKey: "manual",
				profile: "school",
				generation: 2,
				authDigest: "b".repeat(64),
			}),
		}),
	);
	const server = await new Promise<Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	servers.push(server);
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/codex/quota`;
	const getStatus = async () => {
		const response = await fetch(
			`${base}/status?executionId=author&projectName=fixture&bindingId=review-old`,
			{ headers: { authorization: "Bearer token" } },
		);
		return response.json();
	};
	expect(await getStatus()).toEqual({ state: "paused", generation: 2 });
	const resumed = await fetch(`${base}/status`, {
		method: "POST",
		headers: {
			authorization: "Bearer token",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			executionId: "author",
			projectName: "fixture",
			bindingId: "review-old",
			state: "resumed",
			successorBindingId: "review-new",
		}),
	});
	expect(resumed.status).toBe(409);
	const { runReview } = await import(
		"../../../../../scripts/lib/codex-quota-client.mjs"
	);
	let time = 0,
		calls = 0;
	const result = await runReview({
		bind: async () => ({ binding, state: "ready", generation: 1 }),
		status: getStatus,
		execute: async () => {
			calls++;
			return {
				code: 1,
				tail: '{"type":"error","error":{"code":"usageLimitExceeded"}}',
			};
		},
		now: () => time,
		sleep: async () => {
			time += 1800000;
		},
		spool: async () => {},
		observe: async () => {},
		ack: async () => {},
		abandon: async () => {},
	});
	expect(result).toBe(75);
	expect(calls).toBe(1);
	expect(store.codexQuota.listTargets("codex:root:1")[0]?.state).toBe(
		"waiting",
	);
});

it("accepts real client cap-text evidence and acknowledges replay without duplicating the incident", async () => {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	store.upsertSession({
		execution_id: "text-parent",
		project_name: "fixture",
		issue_id: "FLY-TEXT",
		status: "running",
		adapter_type: "claude",
	});
	const credential = async () => ({
		rootKey: "text-root",
		profile: "business",
		accountKey: "business-key",
		generation: 1,
		authDigest: "a".repeat(64),
	});
	store.codexQuota.initializeRoot(await credential());
	const app = express();
	app.use(express.json());
	app.use(
		"/api/codex/quota",
		createCodexQuotaRouter({
			store,
			ingestToken: "fixture-token",
			credential,
		}),
	);
	const server = await new Promise<Server>((resolve) => {
		const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
	});
	servers.push(server);
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/codex/quota`;
	const post = (path: string, body: Record<string, unknown>) =>
		fetch(`${base}/${path}`, {
			method: "POST",
			headers: {
				authorization: "Bearer fixture-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				executionId: "text-parent",
				projectName: "fixture",
				...body,
			}),
		});
	const { runReview } = await import(
		"../../../../../scripts/lib/codex-quota-client.mjs"
	);
	const pending = new Map<string, unknown>();
	const evidence: string[] = [];
	const receipts: number[] = [];
	let clock = 0;
	let executions = 0;
	const result = await runReview({
		bind: async () =>
			(
				await post("bind", {
					invocationId: "text-review",
					model: "gpt-6-astra",
					purpose: "review",
					authDigest: "a".repeat(64),
				})
			).json(),
		execute: async () => {
			executions++;
			return { code: 1, tail: "You've hit your usage limit. Try again later." };
		},
		spool: async (signal: { sourceEventId: string; evidence: string }) => {
			pending.set(signal.sourceEventId, signal);
			evidence.push(signal.evidence);
		},
		observe: async (signal: Record<string, unknown>) => {
			// Re-delivery after a lost acknowledgement must remain acceptable and idempotent.
			for (let replay = 0; replay < 2; replay++) {
				const response = await post("observe", { signal });
				receipts.push(response.status);
				await response.json();
				if (!response.ok)
					throw new Error(`observe rejected ${response.status}`);
			}
		},
		ack: async (signal: { sourceEventId: string }) => {
			pending.delete(signal.sourceEventId);
		},
		status: async (bindingId: string) =>
			(
				await fetch(
					`${base}/status?executionId=text-parent&projectName=fixture&bindingId=${bindingId}`,
					{
						headers: { authorization: "Bearer fixture-token" },
					},
				)
			).json(),
		now: () => clock,
		sleep: async () => {
			clock += 1_800_000;
		},
	});
	expect(result).toBe(75); // Acknowledged quota wait expires without another execution.
	expect(evidence).toEqual(["usageLimited"]);
	expect(receipts).toEqual([200, 200]);
	expect(pending.size).toBe(0);
	expect(store.codexQuota.listIncidents()).toHaveLength(1);
	expect(store.codexQuota.listTargets("codex:text-root:1")).toHaveLength(1);
	expect(store.codexQuota.isExecutionPaused("text-parent")).toBe(false);
	expect(executions).toBe(1);
});
