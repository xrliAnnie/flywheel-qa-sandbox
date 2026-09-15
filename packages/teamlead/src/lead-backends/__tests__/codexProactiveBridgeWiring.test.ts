import { expect, it, vi } from "vitest";
import { buildPrepareProactiveEngagement } from "../codexLeadBridgeWiring.js";

const projects = [
	{
		projectName: "p",
		leads: [
			{ agentId: "l", roundtableChannel: "11111111111111111" },
			{
				agentId: "external",
				external: true,
				roundtableChannel: "11111111111111111",
			},
		],
	},
] as never;
it("rejects unknown identity, external leads and non-parent channels before probing", async () => {
	const probe = vi.fn();
	const prepare = buildPrepareProactiveEngagement(projects, {
		resolveBotToken: () => "tok",
		resolveStateDir: () => "/state",
		probe,
	});
	for (const change of [
		{ leadId: "external" },
		{ projectName: "other" },
		{ channelId: "22222222222222222" },
	])
		await expect(
			prepare({
				projectName: "p",
				leadId: "l",
				channelId: "11111111111111111",
				...change,
			}),
		).rejects.toThrow();
	expect(probe).not.toHaveBeenCalled();
});
it("uses authenticated current owner capability and rechecks the same owner before engaging", async () => {
	let owner = "one";
	const probe = vi.fn(async () => ({
		socketOwnerId: owner,
		features: ["roundtable_proactive_engage_v1"],
		protocolVersions: [1, 2],
	}));
	const engage = vi.fn(async () => ({
		engagement: "ready",
		threadId: "22222222222222222",
	}));
	const prepare = buildPrepareProactiveEngagement(projects, {
		resolveBotToken: () => "tok",
		resolveStateDir: () => "/state",
		probe: probe as never,
		engage: engage as never,
	});
	const action = await prepare({
		projectName: "p",
		leadId: "l",
		channelId: "11111111111111111",
	});
	owner = "two";
	await expect(
		action({
			eventId: "key",
			messageId: "22222222222222222",
			payloadHash: "a".repeat(64),
		}),
	).rejects.toThrow(/owner/);
	expect(engage).not.toHaveBeenCalled();
	const current = await prepare({
		projectName: "p",
		leadId: "l",
		channelId: "11111111111111111",
	});
	await expect(
		current({
			eventId: "key",
			messageId: "22222222222222222",
			payloadHash: "a".repeat(64),
		}),
	).resolves.toBe("ready");
	expect(engage.mock.calls[0][0]).toMatchObject({
		socketOwnerId: "two",
		authSecret: "tok",
		socketPath: "/state/lead-inbox.sock",
	});
});

import { buildLeadOutboundExpressHandler } from "../codexLeadBridgeWiring.js";

it("returns separate send and engagement receipts through the mounted HTTP adapter", async () => {
	const handler = {
		handle: async () => ({
			httpStatus: 202,
			status: "pending",
			sendStatus: "sent",
			messageId: "22222222222222222",
			engagement: "pending",
		}),
	};
	const json = vi.fn();
	const res = { status: vi.fn(() => res), json };
	await buildLeadOutboundExpressHandler(handler as never)(
		{ headers: {}, body: {} },
		res,
	);
	expect(json).toHaveBeenCalledWith(
		expect.objectContaining({
			sendStatus: "sent",
			engagement: "pending",
			messageId: "22222222222222222",
		}),
	);
});
