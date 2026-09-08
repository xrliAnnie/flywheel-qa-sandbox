import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateStore, WorkflowGateHolderRow } from "../../StateStore.js";
import { createRunsRouter } from "../runs-route.js";

const fakeDispatcher = {
	getInflightCount: () => 0,
} as Parameters<typeof createRunsRouter>[0];
const fakeAdmission = {
	tryAdmit: () => ({ admit: false, reason: "load", detail: "unused" }),
} as Parameters<typeof createRunsRouter>[3];
const HOLDER = {
	question_id: "question-ref",
	run_id: "run-ref",
	gate_node_id: "founder_gate",
	attempt: 1,
	head_sha: "a".repeat(40),
	source_execution_id: "qa-ref",
	card_message_id: "32345678901234567",
	created_at: "2026-09-06T18:00:00.000Z",
} as WorkflowGateHolderRow;
const REF = {
	channelId: "12345678901234567",
	messageId: "22345678901234567",
};
const PROJECTS = [
	{
		projectName: "flywheel",
		leads: [{ agentId: "flywheel-eng-lead" }],
	},
] as unknown as Parameters<typeof createRunsRouter>[2];

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
});

function routeStore(
	open = vi.fn(),
	current:
		| { status: "one"; holder: WorkflowGateHolderRow }
		| { status: "missing" }
		| { status: "ambiguous"; holders: WorkflowGateHolderRow[] } = {
		status: "one",
		holder: HOLDER,
	},
) {
	return {
		getWorkflowRun: (runId: string) =>
			runId === "run-ref"
				? {
						run_id: runId,
						project_name: "flywheel",
						status: "active",
						selected_by: "flywheel-eng-lead",
					}
				: undefined,
		currentFounderGateHolder: () => current,
		listRunAttributedExecutions: () => [],
		openOperatorRework: open,
	} as unknown as StateStore;
}

function discordMessage(
	id: string,
	options: { authorId?: string; timestamp?: string; content?: string } = {},
) {
	return new Response(
		JSON.stringify({
			id,
			author: { id: options.authorId ?? "42345678901234567" },
			timestamp: options.timestamp ?? "2026-09-06T18:02:00.000Z",
			content: options.content ?? "founder correction verbatim",
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

async function startApp(options: {
	store: StateStore;
	canonicalFounderId?: () => string | null;
	gateBotToken?: (holder: WorkflowGateHolderRow) => string | undefined;
	fetchImpl?: typeof fetch;
}): Promise<string> {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/runs",
		createRunsRouter(
			fakeDispatcher,
			options.store,
			PROJECTS,
			fakeAdmission,
			undefined,
			false,
			undefined,
			{
				masterToken: "master-secret",
				scopedToken: "scoped-secret",
				canonicalFounderId: options.canonicalFounderId,
				gateBotToken: options.gateBotToken,
				fetchImpl: options.fetchImpl,
			},
		),
	);
	server = createServer(app);
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

async function request(baseUrl: string, founderMessageRef?: unknown) {
	return fetch(`${baseUrl}/api/runs/run-ref/rework`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer master-secret",
		},
		body: JSON.stringify({
			targetNodeId: "implement",
			feedback: "apply founder correction",
			clientRequestId: "request-ref",
			...(founderMessageRef === undefined ? {} : { founderMessageRef }),
		}),
	});
}

function successResult() {
	return {
		ok: true as const,
		requestId: "rework:ref",
		targetNodeId: "implement",
		targetAttempt: 2,
		preferredActorExecutionId: "implement-ref",
		idempotentReplay: false,
	};
}

describe("runs-route founder message reference", () => {
	it("records an omitted reference explicitly as operator-authored", async () => {
		const open = vi.fn(() => successResult());
		const baseUrl = await startApp({ store: routeStore(open) });
		const response = await request(baseUrl);
		expect(response.status).toBe(200);
		expect(open).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: "flywheel-eng-lead",
				leadFeedback: "apply founder correction",
				founderQuote: null,
				founderAuthorEvidence: { kind: "operator", principal: "master" },
			}),
		);
	});

	it("verifies a founder-authored message in the exact gate thread", async () => {
		const open = vi.fn(() => successResult());
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const value = String(url);
			const id = value.split("/").at(-1);
			return new Response(
				JSON.stringify({
					id,
					author: { id: "42345678901234567" },
					content:
						id === HOLDER.card_message_id
							? "ship gate card"
							: "founder correction verbatim",
					timestamp:
						id === HOLDER.card_message_id
							? "2026-09-06T18:01:00.000Z"
							: "2026-09-06T18:02:00.000Z",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;
		const baseUrl = await startApp({
			store: routeStore(open),
			canonicalFounderId: () => "42345678901234567",
			gateBotToken: () => "gate-token",
			fetchImpl,
		});
		const response = await request(baseUrl, {
			url: "https://discord.com/channels/52345678901234567/12345678901234567/22345678901234567",
		});
		expect(response.status).toBe(200);
		expect(open).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: "flywheel-eng-lead",
				leadFeedback: "apply founder correction",
				founderQuote: {
					message_id: "22345678901234567",
					text: "founder correction verbatim",
				},
				founderAuthorEvidence: {
					kind: "founder_message",
					channel_id: "12345678901234567",
					message_id: "22345678901234567",
					card_message_id: HOLDER.card_message_id,
					author_user_id: "42345678901234567",
					founder_id_at_capture: "42345678901234567",
					message_ts: "2026-09-06T18:02:00.000Z",
					card_message_ts: "2026-09-06T18:01:00.000Z",
					verified_at: expect.stringMatching(/Z$/),
					question_id: HOLDER.question_id,
					head_sha: HOLDER.head_sha,
				},
			}),
		);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("preserves an explicitly empty founder quote instead of dropping it", async () => {
		const open = vi.fn(() => successResult());
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(discordMessage(REF.messageId, { content: "" }))
			.mockResolvedValueOnce(
				discordMessage(HOLDER.card_message_id!, { content: "ship gate card" }),
			);
		const baseUrl = await startApp({
			store: routeStore(open),
			canonicalFounderId: () => "42345678901234567",
			gateBotToken: () => "gate-token",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		const response = await request(baseUrl, REF);

		expect(response.status).toBe(200);
		expect(open).toHaveBeenCalledWith(
			expect.objectContaining({
				founderQuote: { message_id: REF.messageId, text: "" },
			}),
		);
	});

	it.each([
		[
			"bad shape",
			{ url: "https://example.com/no" },
			400,
			"FOUNDER_MESSAGE_REF_INVALID",
		],
		[
			"unresolved founder",
			{ channelId: "12345678901234567", messageId: "22345678901234567" },
			503,
			"FOUNDER_IDENTITY_UNRESOLVED",
		],
	] as const)(
		"rejects %s without recording",
		async (_case, ref, status, code) => {
			const open = vi.fn();
			const baseUrl = await startApp({
				store: routeStore(open),
				canonicalFounderId: () => null,
			});
			const response = await request(baseUrl, ref);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({
				success: false,
				code,
				recorded: false,
			});
			expect(open).not.toHaveBeenCalled();
		},
	);

	it("rejects a non-founder author with a typed 422 and no write", async () => {
		const open = vi.fn();
		const baseUrl = await startApp({
			store: routeStore(open),
			canonicalFounderId: () => "42345678901234567",
			gateBotToken: () => "gate-token",
			fetchImpl: vi.fn().mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						id: "22345678901234567",
						author: { id: "99999999999999999" },
						timestamp: "2026-09-06T18:02:00.000Z",
						content: "not founder",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			) as unknown as typeof fetch,
		});
		const response = await request(baseUrl, {
			channelId: "12345678901234567",
			messageId: "22345678901234567",
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "FOUNDER_MESSAGE_REF_NOT_FOUNDER",
			recorded: false,
		});
		expect(open).not.toHaveBeenCalled();
	});

	it.each([
		[
			"missing holder",
			{ status: "missing" } as const,
			() => "gate-token",
			409,
			"GATE_HOLDER_MISSING",
		],
		[
			"ambiguous holder",
			{ status: "ambiguous", holders: [HOLDER, HOLDER] } as const,
			() => "gate-token",
			409,
			"GATE_HOLDER_AMBIGUOUS",
		],
		[
			"unbound card",
			{
				status: "one",
				holder: { ...HOLDER, card_message_id: null },
			} as const,
			() => "gate-token",
			409,
			"GATE_CARD_NOT_BOUND",
		],
		[
			"missing token",
			{ status: "one", holder: HOLDER } as const,
			() => undefined,
			503,
			"DISCORD_TOKEN_UNAVAILABLE",
		],
	] as const)(
		"rejects %s before Discord lookup and records nothing",
		async (_case, current, gateBotToken, status, code) => {
			const open = vi.fn();
			const fetchImpl = vi.fn();
			const baseUrl = await startApp({
				store: routeStore(open, current as never),
				canonicalFounderId: () => "42345678901234567",
				gateBotToken,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});
			const response = await request(baseUrl, REF);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({
				success: false,
				code,
				recorded: false,
			});
			expect(open).not.toHaveBeenCalled();
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			"not found",
			new Response(null, { status: 404 }),
			404,
			"FOUNDER_MESSAGE_REF_NOT_FOUND",
		],
		[
			"forbidden",
			new Response(null, { status: 403 }),
			503,
			"DISCORD_TOKEN_UNAVAILABLE",
		],
		[
			"rate limited",
			new Response(null, { status: 429 }),
			503,
			"DISCORD_UNAVAILABLE",
		],
		[
			"server failure",
			new Response(null, { status: 500 }),
			503,
			"DISCORD_UNAVAILABLE",
		],
		[
			"invalid Discord payload",
			new Response(
				JSON.stringify({
					id: REF.messageId,
					author: { id: "42345678901234567" },
					timestamp: "not-a-time",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
			503,
			"DISCORD_UNAVAILABLE",
		],
	] as const)(
		"maps referenced-message %s without recording",
		async (_case, discordResponse, status, code) => {
			const open = vi.fn();
			const baseUrl = await startApp({
				store: routeStore(open),
				canonicalFounderId: () => "42345678901234567",
				gateBotToken: () => "gate-token",
				fetchImpl: vi
					.fn()
					.mockResolvedValue(discordResponse) as unknown as typeof fetch,
			});
			const response = await request(baseUrl, REF);
			expect(response.status).toBe(status);
			expect(await response.json()).toMatchObject({ code, recorded: false });
			expect(open).not.toHaveBeenCalled();
		},
	);

	it("maps a Discord network failure to an explicit unrecorded 503", async () => {
		const open = vi.fn();
		const baseUrl = await startApp({
			store: routeStore(open),
			canonicalFounderId: () => "42345678901234567",
			gateBotToken: () => "gate-token",
			fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
		});
		const response = await request(baseUrl, REF);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "DISCORD_UNAVAILABLE",
			recorded: false,
		});
		expect(open).not.toHaveBeenCalled();
	});

	it("rejects a founder message whose current gate card is absent from the channel", async () => {
		const open = vi.fn();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(discordMessage(REF.messageId))
			.mockResolvedValueOnce(new Response(null, { status: 404 }));
		const baseUrl = await startApp({
			store: routeStore(open),
			canonicalFounderId: () => "42345678901234567",
			gateBotToken: () => "gate-token",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const response = await request(baseUrl, REF);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "FOUNDER_MESSAGE_REF_OUTSIDE_GATE_THREAD",
			recorded: false,
		});
		expect(open).not.toHaveBeenCalled();
	});

	it("rejects a founder message sent before the current gate card", async () => {
		const open = vi.fn();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				discordMessage(REF.messageId, {
					timestamp: "2026-09-06T18:00:30.000Z",
				}),
			)
			.mockResolvedValueOnce(
				discordMessage(HOLDER.card_message_id!, {
					timestamp: "2026-09-06T18:01:00.000Z",
				}),
			);
		const baseUrl = await startApp({
			store: routeStore(open),
			canonicalFounderId: () => "42345678901234567",
			gateBotToken: () => "gate-token",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const response = await request(baseUrl, REF);
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			code: "FOUNDER_MESSAGE_REF_BEFORE_CARD",
			recorded: false,
		});
		expect(open).not.toHaveBeenCalled();
	});

	it.each([
		["founder_gate_holder_changed", "GATE_HOLDER_CHANGED"],
		["founder_gate_holder_missing", "GATE_HOLDER_MISSING"],
		["founder_gate_holder_ambiguous", "GATE_HOLDER_AMBIGUOUS"],
		["founder_gate_verdict_unbound", "FOUNDER_GATE_VERDICT_UNBOUND"],
	] as const)("maps StateStore rejection %s", async (reason, code) => {
		const open = vi.fn(() => ({ ok: false as const, reason }));
		const baseUrl = await startApp({ store: routeStore(open) });
		const response = await request(baseUrl);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code,
			reason,
			recorded: false,
		});
	});
});
