import { createServer } from "node:http";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { ConfirmTokenStore } from "../fleet-admin.js";
import {
	createWorkflowCarrierRedriveRouter,
	handleWorkflowCarrierRedriveApply,
	handleWorkflowCarrierRedriveStage,
	type WorkflowCarrierRedriveCanonical,
} from "../workflow-carrier-redrive-routes.js";

const HEAD = "a".repeat(40);

function harness() {
	const canonical: WorkflowCarrierRedriveCanonical = {
		requestId: `carrier-redrive:${"b".repeat(64)}`,
		runId: "run-1",
		questionId: "approve-1",
		gateNodeId: "founder_gate",
		gateAttempt: 1,
		approvedHead: HEAD,
		sourceExecutionId: "implement-1",
		reason: "Lead confirmed the carrier is parked",
	};
	let receipt:
		| {
				requestId: string;
				canonicalDigest: string;
				questionId: string;
				appliedAt: string;
		  }
		| undefined;
	const store = {
		resolveWorkflowCarrierRedriveCanonical: vi.fn(() => canonical),
		getWorkflowCarrierRedriveReceipt: vi.fn(() => receipt),
		redriveWorkflowCarrierDelivery: vi.fn((input) => {
			receipt = {
				requestId: input.requestId,
				canonicalDigest: input.canonicalDigest,
				questionId: input.questionId,
				appliedAt: input.now,
			};
			return { ok: true as const, idempotentReplay: false };
		}),
	};
	return { canonical, store, tokens: new ConfirmTokenStore() };
}

describe("workflow carrier redrive handlers", () => {
	it("stages an exact approved tuple and applies once with the authenticated principal", () => {
		const h = harness();
		const staged = handleWorkflowCarrierRedriveStage(
			{ store: h.store, tokens: h.tokens },
			{
				runId: "run-1",
				questionId: "approve-1",
				approvedHead: HEAD,
				reason: "Lead confirmed the carrier is parked",
			},
		);
		expect(staged).toMatchObject({
			code: 200,
			body: { canonical: h.canonical },
		});
		const token = (staged.body as { confirmToken: string }).confirmToken;
		const applied = handleWorkflowCarrierRedriveApply(
			{ store: h.store, tokens: h.tokens },
			{ canonical: h.canonical, confirmToken: token },
			"master",
			"2026-08-11T01:00:00.000Z",
		);
		expect(applied).toMatchObject({ code: 200, body: { ok: true } });
		expect(h.store.redriveWorkflowCarrierDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				principal: "master",
				reason: h.canonical.reason,
			}),
		);
		expect(
			handleWorkflowCarrierRedriveApply(
				{ store: h.store, tokens: h.tokens },
				{ canonical: h.canonical, confirmToken: token },
				"master",
				"2026-08-11T01:01:00.000Z",
			),
		).toMatchObject({
			code: 200,
			body: { ok: true, idempotentReplay: true },
		});
		expect(h.store.redriveWorkflowCarrierDelivery).toHaveBeenCalledTimes(1);
	});

	it("rejects tuple drift before consuming the one-shot token", () => {
		const h = harness();
		const staged = handleWorkflowCarrierRedriveStage(
			{ store: h.store, tokens: h.tokens },
			{
				runId: "run-1",
				questionId: "approve-1",
				approvedHead: HEAD,
				reason: h.canonical.reason,
			},
		);
		const token = (staged.body as { confirmToken: string }).confirmToken;
		h.store.resolveWorkflowCarrierRedriveCanonical.mockReturnValueOnce(
			undefined,
		);
		expect(
			handleWorkflowCarrierRedriveApply(
				{ store: h.store, tokens: h.tokens },
				{ canonical: h.canonical, confirmToken: token },
				"master",
				"2026-08-11T01:00:00.000Z",
			),
		).toEqual({
			code: 409,
			body: { ok: false, reason: "carrier_state_changed" },
		});
	});

	it("rejects unknown stage fields and malformed canonicals", () => {
		const h = harness();
		expect(
			handleWorkflowCarrierRedriveStage(
				{ store: h.store, tokens: h.tokens },
				{
					runId: "run-1",
					questionId: "approve-1",
					approvedHead: HEAD,
					reason: h.canonical.reason,
					principal: "founder",
				},
			),
		).toMatchObject({ code: 400 });
		expect(
			handleWorkflowCarrierRedriveApply(
				{ store: h.store, tokens: h.tokens },
				{ canonical: { ...h.canonical, gateAttempt: 0 }, confirmToken: "bad" },
				"master",
				"2026-08-11T01:00:00.000Z",
			),
		).toMatchObject({ code: 400 });
	});

	it("rejects an invalid one-shot confirmation token", () => {
		const h = harness();
		expect(
			handleWorkflowCarrierRedriveApply(
				{ store: h.store, tokens: h.tokens },
				{ canonical: h.canonical, confirmToken: "not-a-token" },
				"master",
				"2026-08-11T01:00:00.000Z",
			),
		).toMatchObject({ code: 403 });
		expect(h.store.redriveWorkflowCarrierDelivery).not.toHaveBeenCalled();
	});

	it("fails closed without the master token and authenticates both route stages", async () => {
		const run = async (apiToken?: string, authorization?: string) => {
			const h = harness();
			const app = express();
			app.use(express.json());
			app.use(
				createWorkflowCarrierRedriveRouter({
					store: h.store,
					tokens: h.tokens,
					apiToken,
				}),
			);
			const server = createServer(app);
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("no address");
			const origin = `http://127.0.0.1:${address.port}`;
			try {
				return await fetch(`${origin}/carrier-redrive/stage`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin,
						...(authorization ? { authorization } : {}),
					},
					body: JSON.stringify({
						runId: "run-1",
						questionId: "approve-1",
						approvedHead: HEAD,
						reason: h.canonical.reason,
					}),
				});
			} finally {
				await new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				);
			}
		};
		await expect(run()).resolves.toMatchObject({ status: 503 });
		await expect(run("master-secret")).resolves.toMatchObject({ status: 401 });
		await expect(
			run("master-secret", "Bearer master-secret"),
		).resolves.toMatchObject({ status: 200 });
	});

	it("does not intercept sibling workflow routes", async () => {
		const h = harness();
		const app = express();
		app.use(express.json());
		app.use(
			createWorkflowCarrierRedriveRouter({
				store: h.store,
				tokens: h.tokens,
				apiToken: "master-secret",
			}),
		);
		app.post("/cutovers/FLY-1436/stage", (_req, res) => {
			res.status(204).end();
		});
		const server = createServer(app);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");
		try {
			const response = await fetch(
				`http://127.0.0.1:${address.port}/cutovers/FLY-1436/stage`,
				{ method: "POST" },
			);
			expect(response.status).toBe(204);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});
});
