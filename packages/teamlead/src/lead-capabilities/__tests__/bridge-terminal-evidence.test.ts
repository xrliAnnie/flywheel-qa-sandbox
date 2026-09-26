import { afterEach, expect, it, vi } from "vitest";
import type { LeadOperationContext } from "../broker.js";
import { createBridgeDiscordHandlers } from "../handlers/bridge-discord.js";
import {
	createGithubBridgeHandlers,
	createRunnerBridgeHandlers,
} from "../handlers/bridge-read.js";

const ID = "a0000000-0000-4000-8000-000000000001";
const env = {
	FLYWHEEL_PROJECT_NAME: "flywheel",
	FLYWHEEL_LEAD_ID: "eng",
	FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
	FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CLAIM_CANARY",
	FLYWHEEL_API_TOKEN: "TOKEN_CANARY",
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:3199",
};
afterEach(() => vi.useRealTimers());
const cases = [
	{
		operationId: "discord.thread.reply",
		factory: createBridgeDiscordHandlers,
		input: { threadId: "123", text: "hello" },
		ref: "discord-message:456",
		data: { threadId: "123", messageId: "456" },
	},
	{
		operationId: "github.pr.ready",
		factory: createGithubBridgeHandlers,
		input: { number: 7 },
		ref: "pr:7",
		data: { number: 7, ready: true },
	},
	{
		operationId: "send_runner",
		factory: createRunnerBridgeHandlers,
		input: { executionId: ID, text: "instruction", idempotencyKey: "same" },
		ref: `runner-instruction:${ID}`,
		data: { result: { outcome: "queued", executionId: ID, instructionId: ID } },
	},
];
it.each(cases)(
	"retains a correlated late $operationId receipt without delivering output after cancellation",
	async (test) => {
		let reply!: (response: Response) => void;
		const fetchImpl = vi.fn<typeof fetch>(
			() =>
				new Promise((resolve) => {
					reply = resolve;
				}),
		);
		const controller = new AbortController();
		const proof = vi.fn(async () => {});
		const ctx: LeadOperationContext = {
			requestId: ID,
			projectName: "flywheel",
			leadId: "eng",
			activationId: "activation",
			signal: controller.signal,
			assertCurrent: async () => {
				controller.signal.throwIfAborted();
			},
			recordTerminalEvidence: proof,
		};
		const handler = test
			.factory({
				env,
				activationId: "activation",
				fetchImpl,
				assertActivationCurrent: () =>
					({
						project: { projectRepo: "owner/repo" },
						lead: { agentId: "eng" },
					}) as never,
			})
			.get(test.operationId)!;
		const pending = handler.execute(test.input, ctx);
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
		controller.abort();
		expect(await pending).toMatchObject({ status: "unknown" });
		reply(
			Response.json({
				requestId: ID,
				status: "succeeded",
				resourceRefs: [test.ref],
				data: {
					...test.data,
					receiptId: ID,
					observedAt: "2026-09-26T00:00:00.000Z",
				},
			}),
		);
		await vi.waitFor(() =>
			expect(proof).toHaveBeenCalledWith({
				status: "succeeded",
				providerRef: test.ref,
			}),
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	},
);

it.each([
	{ requestId: "b0000000-0000-4000-8000-000000000002" },
	{ status: "unknown" },
	{ status: "rejected" },
	{ resourceRefs: ["pr:8"] },
	{
		data: {
			number: 8,
			ready: true,
			receiptId: ID,
			observedAt: "2026-09-26T00:00:00.000Z",
		},
	},
	{
		data: {
			number: 7,
			ready: true,
			receiptId: "b0000000-0000-4000-8000-000000000002",
			observedAt: "2026-09-26T00:00:00.000Z",
		},
	},
])(
	"does not settle invalid or nonterminal Bridge evidence %j",
	async (override) => {
		const { observeBridgeTerminalEvidence } = await import(
			"../handlers/bridge-terminal-evidence.js"
		);
		const proof = vi.fn(async () => {});
		const input = {
			requestId: ID,
			status: "succeeded",
			resourceRefs: ["pr:7"],
			data: {
				number: 7,
				ready: true,
				receiptId: ID,
				observedAt: "2026-09-26T00:00:00.000Z",
			},
			...override,
		};
		const response = await observeBridgeTerminalEvidence(Response.json(input), {
			operationId: "github.pr.ready",
			raw: { number: 7 },
			context: {
				requestId: ID,
				recordTerminalEvidence: proof,
			} as unknown as LeadOperationContext,
			secrets: [],
			receiptOnly: false,
		});
		expect(proof).not.toHaveBeenCalled();
		expect(await response.json()).toEqual(input);
	},
);
it("bounds late receipt parsing and cancels a response body that stalls", async () => {
	const { observeBridgeTerminalEvidence } = await import(
		"../handlers/bridge-terminal-evidence.js"
	);
	vi.useFakeTimers();
	const cancel = vi.fn(),
		proof = vi.fn(async () => {});
	const stream = new ReadableStream<Uint8Array>({ cancel });
	const pending = observeBridgeTerminalEvidence(new Response(stream), {
		operationId: "github.pr.ready",
		raw: { number: 7 },
		context: {
			requestId: ID,
			recordTerminalEvidence: proof,
		} as unknown as LeadOperationContext,
		secrets: [],
		receiptOnly: false,
	}).catch((error) => error);
	await vi.advanceTimersByTimeAsync(2001);
	expect(await pending).toMatchObject({
		message: "bridge_terminal_body_timeout",
	});
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(proof).not.toHaveBeenCalled();
});
