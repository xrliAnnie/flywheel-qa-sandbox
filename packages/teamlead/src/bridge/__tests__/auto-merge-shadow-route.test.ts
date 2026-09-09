import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type {
	AutoMergeShadowDeclarationRow,
	StateStore,
	WorkflowGateHolderRow,
} from "../../StateStore.js";
import { createAutoMergeShadowRouter } from "../auto-merge-shadow-route.js";
import type { FetchDiscordMessageResult } from "../discord-utils.js";

const QUESTION = "question-shadow-1";
const CHANNEL = "12345678901234567";
const MESSAGE = "22345678901234567";
const LEAD_USER = "32345678901234567";
const DECLARATION = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-09-08T12:00:00.000Z";
const NOW = "2026-09-08T12:02:00.000Z";

const holder = {
	run_id: "run-shadow-1",
	gate_node_id: "founder_gate",
	source_execution_id: "qa-shadow-1",
	question_id: QUESTION,
	authority_mode: "land",
	subject_kind: "git_head",
	created_at: CREATED_AT,
} as WorkflowGateHolderRow;

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/repo",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: CHANNEL,
				botToken: "lead-token",
				botUserId: LEAD_USER,
				match: { labels: ["Engineering"] },
			},
		],
	},
] as ProjectEntry[];

function declarationRow(
	overrides: Partial<AutoMergeShadowDeclarationRow> = {},
): AutoMergeShadowDeclarationRow {
	return {
		declaration_id: DECLARATION,
		question_id: QUESTION,
		run_id: "run-shadow-1",
		declared_class: "pure_docs",
		declared_by: "flywheel-eng-lead",
		discord_channel_id: CHANNEL,
		discord_message_id: MESSAGE,
		discord_author_user_id: LEAD_USER,
		message_ts: "2026-09-08T12:01:00.000Z",
		declaration_seq: 1,
		declared_at: NOW,
		...overrides,
	};
}

interface FixtureOptions {
	holder?: WorkflowGateHolderRow | undefined;
	labels?: string[];
	existing?: AutoMergeShadowDeclarationRow[];
	fetchResult?: FetchDiscordMessageResult;
	recordResult?: ReturnType<StateStore["recordAutoMergeShadowDeclaration"]>;
}

const servers: Server[] = [];

async function fixture(options: FixtureOptions = {}) {
	const currentHolder = Object.hasOwn(options, "holder")
		? options.holder
		: holder;
	const record = vi.fn().mockReturnValue(
		options.recordResult ?? {
			ok: true,
			status: "created",
			row: declarationRow(),
		},
	);
	const store = {
		getWorkflowGateHolderByQuestionId: () => currentHolder,
		listAutoMergeShadowDeclarations: () => options.existing ?? [],
		getWorkflowRun: () => ({ project_name: "flywheel" }),
		getSession: () => ({ execution_id: "qa-shadow-1" }),
		getSessionLabels: () => options.labels ?? ["Engineering"],
		recordAutoMergeShadowDeclaration: record,
	} as unknown as StateStore;
	const fetchMessage = vi.fn().mockResolvedValue(
		options.fetchResult ?? {
			ok: true,
			message: {
				id: MESSAGE,
				channelId: CHANNEL,
				authorId: LEAD_USER,
				authorIsBot: true,
				timestampMs: Date.parse("2026-09-08T12:01:00.000Z"),
				editedTimestampMs: null,
				content: `shadow-declare ${QUESTION} pure_docs`,
			},
		},
	);
	const app = express();
	app.use(express.json());
	app.use(
		"/api/workflow",
		createAutoMergeShadowRouter({
			store,
			projects,
			fetchDiscordMessage: fetchMessage,
			now: () => NOW,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address() as AddressInfo;
	return {
		port: address.port,
		fetchMessage,
		record,
		post: (body: unknown, headers: Record<string, string> = {}) =>
			fetch(
				`http://127.0.0.1:${address.port}/api/workflow/shadow-declaration`,
				{
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify(body),
				},
			),
	};
}

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
});

function validBody(
	messageRef: unknown = { channelId: CHANNEL, messageId: MESSAGE },
) {
	return {
		declaration_id: DECLARATION,
		question_id: QUESTION,
		declared_class: "pure_docs",
		message_ref: messageRef,
	};
}

describe("auto-merge shadow declaration route", () => {
	it.each([
		[{ channelId: CHANNEL, messageId: MESSAGE }],
		[
			{
				url: `https://discord.com/channels/42345678901234567/${CHANNEL}/${MESSAGE}`,
			},
		],
	])(
		"creates a declaration from a verified Lead message ref",
		async (messageRef) => {
			const fx = await fixture();
			const response = await fx.post(validBody(messageRef));
			expect(response.status).toBe(201);
			await expect(response.json()).resolves.toMatchObject({
				ok: true,
				status: "created",
				declaration: { declared_by: "flywheel-eng-lead" },
			});
			expect(fx.fetchMessage).toHaveBeenCalledWith(
				CHANNEL,
				MESSAGE,
				"lead-token",
			);
			expect(fx.record).toHaveBeenCalledWith(
				expect.objectContaining({
					questionId: QUESTION,
					runId: "run-shadow-1",
					declaredBy: "flywheel-eng-lead",
					discordAuthorUserId: LEAD_USER,
				}),
			);
		},
	);

	it.each([
		[{}, "body_shape"],
		[{ ...validBody(), declared_by: "runner" }, "unexpected_key"],
		[{ ...validBody(), message_ref: undefined }, "body_shape"],
		[
			{
				...validBody(),
				message_ref: { channel_id: CHANNEL, message_id: MESSAGE },
			},
			"message_ref_invalid",
		],
		[
			{
				...validBody(),
				message_ref: { channelId: CHANNEL, messageId: MESSAGE, extra: true },
			},
			"message_ref_invalid",
		],
		[
			{ ...validBody(), message_ref: { channelId: "123", messageId: MESSAGE } },
			"message_ref_invalid",
		],
		[
			{ ...validBody(), declaration_id: "not-a-uuid" },
			"declaration_id_invalid",
		],
		[{ ...validBody(), question_id: "x".repeat(129) }, "question_id_invalid"],
		[{ ...validBody(), declared_class: "maybe" }, "declared_class_invalid"],
	] as const)("rejects an invalid body with %s", async (body, reason) => {
		const fx = await fixture();
		const response = await fx.post(body);
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({ ok: false, reason });
		expect(fx.fetchMessage).not.toHaveBeenCalled();
		expect(fx.record).not.toHaveBeenCalled();
	});

	it("replays or rejects an existing declaration before identity and Discord probes", async () => {
		const replay = await fixture({ existing: [declarationRow()], labels: [] });
		const replayResponse = await replay.post(validBody());
		expect(replayResponse.status).toBe(200);
		await expect(replayResponse.json()).resolves.toMatchObject({
			ok: true,
			status: "replayed",
		});
		expect(replay.fetchMessage).not.toHaveBeenCalled();

		const conflict = await fixture({
			existing: [declarationRow({ declared_class: "other_code" })],
			labels: [],
		});
		const conflictResponse = await conflict.post(validBody());
		expect(conflictResponse.status).toBe(409);
		await expect(conflictResponse.json()).resolves.toEqual({
			ok: false,
			reason: "declaration_conflict",
		});
		expect(conflict.fetchMessage).not.toHaveBeenCalled();
	});

	it.each([
		[{}, 404, "question_unknown"],
		[
			{
				holder: { ...holder, gate_node_id: "review" } as WorkflowGateHolderRow,
			},
			422,
			"not_a_ship_gate",
		],
		[{ labels: [] }, 503, "lead_identity_unavailable"],
	])(
		"fails closed before Discord when holder or Lead identity is invalid",
		async (options, status, reason) => {
			const normalized =
				Object.keys(options).length === 0 ? { holder: undefined } : options;
			const fx = await fixture(normalized);
			const response = await fx.post(validBody());
			expect(response.status).toBe(status);
			await expect(response.json()).resolves.toEqual({ ok: false, reason });
			expect(fx.fetchMessage).not.toHaveBeenCalled();
		},
	);

	it("rejects a non-Lead channel and a non-loopback host before Discord", async () => {
		const fx = await fixture();
		const channelResponse = await fx.post(
			validBody({ channelId: "92345678901234567", messageId: MESSAGE }),
		);
		expect(channelResponse.status).toBe(403);
		await expect(channelResponse.json()).resolves.toMatchObject({
			reason: "channel_not_lead_channel",
		});
		expect(fx.fetchMessage).not.toHaveBeenCalled();

		const hostResponse = await new Promise<{ status: number; body: unknown }>(
			(resolve, reject) => {
				const request = httpRequest(
					{
						hostname: "127.0.0.1",
						port: fx.port,
						path: "/api/workflow/shadow-declaration",
						method: "POST",
						headers: {
							host: "example.com",
							"content-type": "application/json",
						},
					},
					(response) => {
						let body = "";
						response.setEncoding("utf8");
						response.on("data", (chunk) => {
							body += chunk;
						});
						response.on("end", () =>
							resolve({
								status: response.statusCode ?? 0,
								body: JSON.parse(body),
							}),
						);
					},
				);
				request.on("error", reject);
				request.end(JSON.stringify(validBody()));
			},
		);
		expect(hostResponse.status).toBe(403);
		expect(hostResponse.body).toMatchObject({
			reason: "non_loopback_host",
		});
	});

	it.each([
		[{ ok: false, kind: "network" }, 503, "discord_unavailable"],
		[
			{ ok: false, kind: "rate_limited", status: 429 },
			503,
			"discord_unavailable",
		],
		[{ ok: false, kind: "not_found", status: 404 }, 404, "message_not_found"],
		[{ ok: false, kind: "forbidden", status: 403 }, 404, "message_not_found"],
	] as const)(
		"maps Discord read failure %s without writing",
		async (fetchResult, status, reason) => {
			const fx = await fixture({ fetchResult });
			const response = await fx.post(validBody());
			expect(response.status).toBe(status);
			await expect(response.json()).resolves.toEqual({ ok: false, reason });
			expect(fx.record).not.toHaveBeenCalled();
		},
	);

	it.each([
		[{ authorId: "42345678901234567" }, 403, "author_not_lead"],
		[{ authorIsBot: false }, 403, "author_not_bot"],
		[
			{ content: `shadow-declare ${QUESTION} other_code` },
			422,
			"message_body_mismatch",
		],
		[
			{ content: `shadow-declare ${QUESTION} pure_docs extra` },
			422,
			"message_body_mismatch",
		],
		[{ editedTimestampMs: Date.parse(NOW) }, 422, "message_edited"],
		[{ timestampMs: Date.parse(CREATED_AT) - 1 }, 422, "message_predates_card"],
	] as const)(
		"rejects unverifiable Discord evidence %s",
		async (messageOverrides, status, reason) => {
			const fx = await fixture({
				fetchResult: {
					ok: true,
					message: {
						id: MESSAGE,
						channelId: CHANNEL,
						authorId: LEAD_USER,
						authorIsBot: true,
						timestampMs: Date.parse("2026-09-08T12:01:00.000Z"),
						editedTimestampMs: null,
						content: `shadow-declare ${QUESTION} pure_docs`,
						...messageOverrides,
					},
				},
			});
			const response = await fx.post(validBody());
			expect(response.status).toBe(status);
			await expect(response.json()).resolves.toEqual({ ok: false, reason });
			expect(fx.record).not.toHaveBeenCalled();
		},
	);

	it.each([
		[{ ok: false, reason: "message_already_used" }, 409],
		[{ ok: false, reason: "declaration_conflict" }, 409],
		[{ ok: false, reason: "question_unknown" }, 404],
	] as const)(
		"maps transactional rejection %s",
		async (recordResult, status) => {
			const fx = await fixture({ recordResult });
			const response = await fx.post(validBody());
			expect(response.status).toBe(status);
			await expect(response.json()).resolves.toEqual(recordResult);
		},
	);
});
