import { expect, it, vi } from "vitest";
import { bindingFixture } from "../../ship-judgment/__tests__/binding-fixture.js";
import { handleShipJudgmentReference } from "../ship-judgment-reference-route.js";

const request = {
	threadId: "123456789012345679",
	messageId: "123456789012345691",
	replyToMessageId: "123456789012345692",
	leadAuth: {
		leadId: "lead",
		projectName: "flywheel",
		identityDigest: "a".repeat(64),
	},
};
it("rejects untrusted body fields and unauthorized Lead identity before reading references", async () => {
	const { store } = await bindingFixture();
	try {
		const authorizeLeadRequest = vi.fn(() => false),
			fetchImpl = vi.fn();
		const deps = {
			store,
			projects: [],
			mode: () => "dry_run",
			canonicalFounderId: () => "123456789012345690",
			authorizeLeadRequest,
			fetchImpl,
		};
		for (const invalid of [
			{ ...request, authorId: "founder" },
			{ ...request, text: "通过" },
			{ ...request, threadId: "../messages" },
			{ ...request, leadAuth: { ...request.leadAuth, projectName: "raya" } },
		]) {
			expect((await handleShipJudgmentReference(deps, invalid)).code).toBe(400);
		}
		expect(authorizeLeadRequest).not.toHaveBeenCalled();
		expect((await handleShipJudgmentReference(deps, request)).code).toBe(403);
		expect(fetchImpl).not.toHaveBeenCalled();
		authorizeLeadRequest.mockReturnValue(true);
		expect((await handleShipJudgmentReference(deps, request)).code).toBe(422);
		expect(fetchImpl).not.toHaveBeenCalled();
	} finally {
		store.close();
	}
});

it(
	"mounts the manual reference endpoint behind the Bridge API token",
	{ timeout: 30000 },
	async () => {
		const { createBridgeApp } = await import("../plugin.js");
		const { createServer } = await import("node:http");
		const { store } = await bindingFixture();
		const app = createBridgeApp(
			store,
			[{ projectName: "flywheel", projectRoot: "/tmp/fixture", leads: [] }],
			{
				host: "127.0.0.1",
				port: 0,
				dbPath: ":memory:",
				notificationChannel: "fixture",
				defaultLeadAgentId: "lead",
				stuckThresholdMinutes: 15,
				stuckCheckIntervalMs: 300000,
				orphanThresholdMinutes: 60,
				apiToken: "fixture-api-token",
			} as import("../types.js").BridgeConfig,
		);
		const server = createServer(app);
		try {
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/ship-judgment/reference`;
			const options = {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
			};
			expect((await fetch(url, options)).status).toBe(401);
			const invalid = await fetch(url, {
				...options,
				headers: {
					...options.headers,
					Authorization: "Bearer fixture-api-token",
				},
				body: JSON.stringify({ ...request, text: "untrusted" }),
			});
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toEqual({
				error: "invalid_learning_reference",
			});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		}
	},
);
