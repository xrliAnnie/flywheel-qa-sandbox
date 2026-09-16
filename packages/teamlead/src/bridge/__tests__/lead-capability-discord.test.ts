import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { LeadArtifactStore } from "../../lead-capabilities/artifacts.js";
import { encodeAttachmentUpload } from "../../lead-capabilities/attachment-upload.js";
import { createBridgeAttachmentHandlers } from "../../lead-capabilities/handlers/bridge-attachments.js";
import { StateStore } from "../../StateStore.js";
import { ChatThreadCreator } from "../ChatThreadCreator.js";
import {
	createLeadCapabilityDiscordRouter,
	mountLeadCapabilityDiscordProvider,
} from "../lead-capability-discord.js";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
	);
});
describe("Bridge typed Discord route", () => {
	it("rejects missing master token on the actual operation route", async () => {
		const app = express();
		app.use(express.json());
		app.use(
			"/api/lead-capabilities/discord",
			createLeadCapabilityDiscordRouter({
				apiToken: "test-token",
				store: {} as StateStore,
			}),
		);
		const server = app.listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address() as { port: number };
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/lead-capabilities/discord`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		);
		expect(response.status).toBe(401);
		const invalid = await fetch(
			`http://127.0.0.1:${address.port}/api/lead-capabilities/discord`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test-token",
				},
				body: JSON.stringify({ operationId: "bridge.ship" }),
			},
		);
		expect(invalid.status).toBe(400);
	});
});

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import {
	identityEnvProjection,
	resolveLeadIdentityRow,
} from "flywheel-comm/lead-identity";
import { vi } from "vitest";

const claim = vi.hoisted(() => ({
	valid: true,
	processIndeterminate: false,
	calls: 0,
}));
vi.mock("flywheel-comm/lead-lease", async (importOriginal) => ({
	...(await importOriginal<object>()),
	validateLeadCarrierAuthorization: () => {
		claim.calls++;
		return {
			valid: claim.valid,
			processIndeterminate: claim.processIndeterminate,
			disposition: "carrier_passthrough",
			leadKey: "fixture",
			carrier: { generation: 1 },
		};
	},
}));
async function exerciseDiscordRoute(scenario: string) {
	claim.calls = 0;
	const home = mkdtempSync(join(tmpdir(), "bridge-capability-"));
	const outboundDedupStore = new SqliteOutboundDedupStore(
		join(home, "dedup.db"),
	);
	try {
		mkdirSync(join(home, ".flywheel"));
		const carrierEvidencePath = join(
			home,
			".flywheel/lead-carrier-evidence.json",
		);
		writeFileSync(
			carrierEvidencePath,
			'{"leads":{"fixture":{"generation":1}}}',
		);
		writeFileSync(
			join(home, ".flywheel/summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
		const projectsPath = join(home, "projects.json");
		writeFileSync(
			projectsPath,
			JSON.stringify([
				{
					projectName: "flywheel",
					projectRoot: home,
					linear: { team: "FLY", project: "Flywheel" },
					leads: [
						{
							agentId: "eng",
							summaryRole: "producer",
							backend: "codex-app-server",
							codexProfile: "full-access",
							codexRunnerActions: false,
							canSpawnRunners: false,
							codexCapabilityBundleVersion: 2,
							botTokenEnv: "ENG_BOT_TOKEN",
							botUserId: "12345678901234567",
							chatChannel: "22345678901234567",
							match: { labels: ["Engineering"] },
						},
					],
				},
			]),
		);
		const row = resolveLeadIdentityRow({
			projectsPath,
			homeDir: home,
			projectName: "flywheel",
			leadId: "eng",
		});
		let sessionBinding: { issue_id: string; project_name: string } | undefined;
		const store = {
			getSessionByIdentifier: () => sessionBinding,
			getChatThreadByIssue: vi.fn(() => ({
				thread_id: "32345678901234567",
				channel_id: "22345678901234567",
				lead_id: "eng",
				archived_at: null,
			})),
			getChatThreadByThreadId: () => ({
				thread_id: "32345678901234567",
				channel_id: "22345678901234567",
				lead_id: "eng",
				issue_id: "FLY-1",
				session_role: "main",
			}),
		} as unknown as StateStore;
		let issueLabels = ["Engineering"];
		let onLabels = () => {};
		const client = {
			issue: vi.fn(async () => ({
				identifier: "FLY-1",
				team: Promise.resolve({ key: "FLY" }),
				project: Promise.resolve({ name: "Flywheel" }),
				labels: async () => {
					onLabels();
					return {
						nodes: issueLabels.map((name) => ({ name })),
						pageInfo: { hasNextPage: false },
					};
				},
			})),
		} as unknown as LinearClient;
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						id: "32345678901234567",
						parent_id: "22345678901234567",
						type: 11,
					}),
					{ status: 200 },
				),
		);
		const providerEnv: NodeJS.ProcessEnv = { ENG_BOT_TOKEN: "bot-token" };
		const app = express();
		app.use(express.json());
		const routerOptions = {
			apiToken: "test-token",
			store,
			projectsPath,
			homeDir: home,
			env: providerEnv,
			linearClient: client,
			outboundDedupStore,
			operationReceipts:
				scenario === "missing-receipts"
					? undefined
					: outboundDedupStore.operationReceipts,
			outboundDbPath: join(home, "outbox.db"),
		};
		let router = createLeadCapabilityDiscordRouter(routerOptions);
		app.use("/api/lead-capabilities/discord", router);
		const server = app.listen(0, "127.0.0.1");
		servers.push(server);
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address() as { port: number };
		fetchSpy.mockRestore();
		// Restrict provider interception to Discord while exercising actual local HTTP.
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation((url, init) =>
			String(url).startsWith("https://discord.com/")
				? Promise.resolve(
						new Response(
							JSON.stringify({
								id: "32345678901234567",
								parent_id: "22345678901234567",
								type: 11,
							}),
							{ status: 200 },
						),
					)
				: realFetch(url, init),
		);
		const envelope = {
			schemaVersion: 1,
			operationId: "discord.thread.resolve",
			requestId: "11111111-1111-4111-8111-111111111111",
			projectName: "flywheel",
			leadId: "eng",
			identityDigest: row.identity.identityDigest,
			carrierClaim: "private-claim",
			activationId: "activation-1",
			input: { issueId: "FLY-1" },
		};
		const response = await fetch(
			`http://127.0.0.1:${address.port}/api/lead-capabilities/discord`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test-token",
				},
				body: JSON.stringify(envelope),
			},
		);
		expect(response.status).toBe(200);
		const first = await response.json();
		expect(first.status).toBe("succeeded");
		expect(claim.calls).toBe(1);
		const post = async (body: unknown) => {
			const r = await fetch(
				`http://127.0.0.1:${address.port}/api/lead-capabilities/discord`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer test-token",
					},
					body: JSON.stringify(body),
				},
			);
			return { code: r.status, body: await r.json() };
		};

		if (scenario !== "routing") {
			// Exercise the actual router without TCP scheduling/keep-alive noise.
			const post = (body: unknown) =>
				new Promise<{ code: number; body: Record<string, unknown> }>(
					(resolve, reject) => {
						const req = Object.assign(new EventEmitter(), {
							method: "POST",
							url: "/",
							path: "/",
							headers: { authorization: "Bearer test-token" },
							body,
						});
						const res = Object.assign(new EventEmitter(), {
							writableEnded: false,
							statusCode: 200,
							status(code: number) {
								this.statusCode = code;
								return this;
							},
							json(value: Record<string, unknown>) {
								this.writableEnded = true;
								resolve({ code: this.statusCode, body: value });
								return this;
							},
						});
						router(
							req as unknown as Request,
							res as unknown as Response,
							reject,
						);
					},
				);
			let writes = 0;
			let failWrites = true;
			vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
				if (!String(url).startsWith("https://discord.com/"))
					return realFetch(url, init);
				if (init?.method === "PUT") {
					writes++;
					return Promise.resolve(
						new Response(null, { status: failWrites ? 503 : 204 }),
					);
				}
				return Promise.resolve(
					new Response(
						JSON.stringify(
							String(url).includes("/messages/")
								? {
										id: "32345678901234567",
										channel_id: "32345678901234567",
										author: { id: "12345678901234567", bot: true },
										content: "message",
										timestamp: "2026-09-13T00:00:00.000Z",
									}
								: {
										id: "32345678901234567",
										parent_id: "22345678901234567",
										type: 11,
									},
						),
						{ status: 200 },
					),
				);
			});
			const unknownWrite = {
				...envelope,
				operationId: "discord.message.react",
				input: {
					threadId: "32345678901234567",
					messageId: "32345678901234567",
					emoji: "✅",
				},
			};
			if (scenario === "missing-receipts") {
				expect((await post(unknownWrite)).body.status).toBe("rejected");
				expect(writes).toBe(0);
				return;
			}
			for (let first = 0; first < 65; first += 8) {
				const results = await Promise.all(
					Array.from({ length: Math.min(8, 65 - first) }, (_, offset) =>
						post({
							...unknownWrite,
							requestId: `bbbbbbbb-1111-4111-8111-${String(first + offset).padStart(12, "0")}`,
						}),
					),
				);
				for (const result of results)
					expect(result).toMatchObject({
						code: 200,
						body: { status: "unknown" },
					});
			}
			expect(
				(
					await post({
						...envelope,
						requestId: "aaaaaaaa-1111-4111-8111-111111111111",
					})
				).body.status,
			).toBe("succeeded");
			const replay = {
				...unknownWrite,
				requestId: "bbbbbbbb-1111-4111-8111-000000000000",
			};
			expect((await post(replay)).body.status).toBe("unknown");
			expect(writes).toBe(65);
			expect(
				(await post({ ...replay, input: { ...replay.input, emoji: "👍" } }))
					.code,
			).toBe(409);
			failWrites = false;
			const successfulWrite = {
				...unknownWrite,
				requestId: "ffffffff-1111-4111-8111-111111111111",
			};
			expect((await post(successfulWrite)).body.status).toBe("succeeded");
			// A fresh router has no in-memory request map; SQLite remains authoritative.
			router = createLeadCapabilityDiscordRouter(routerOptions);
			expect((await post(replay)).body.status).toBe("unknown");
			expect(
				(await post({ ...replay, input: { ...replay.input, emoji: "👍" } }))
					.code,
			).toBe(409);
			expect((await post(successfulWrite)).body).toMatchObject({
				status: "succeeded",
				resourceRefs: ["discord-message:32345678901234567"],
				data: {
					messageId: "32345678901234567",
					receiptId: successfulWrite.requestId,
				},
			});
			expect(writes).toBe(66);
			return;
		}

		const attachmentId = "52345678901234567";
		const attachmentFetch = vi.mocked(globalThis.fetch);
		const beforeAttachment = attachmentFetch.getMockImplementation()!;
		attachmentFetch.mockImplementation((url, init) => {
			if (String(url).endsWith("/messages/42345678901234567"))
				return Promise.resolve(
					Response.json({
						id: "42345678901234567",
						channel_id: "32345678901234567",
						attachments: [
							{
								id: attachmentId,
								size: 5,
								content_type: "text/plain",
								url: `https://cdn.discordapp.com/attachments/32345678901234567/${attachmentId}/note.txt`,
							},
						],
					}),
				);
			if (String(url).startsWith("https://cdn.discordapp.com/attachments/"))
				return Promise.resolve(
					new Response("hello", {
						headers: { "content-type": "text/plain" },
					}),
				);
			return beforeAttachment(url, init);
		});
		const attachmentEnvelope = {
			...envelope,
			operationId: "discord.message.attachments.get",
			requestId: "12345678-1234-4234-8234-123456789012",
			input: {
				threadId: "32345678901234567",
				messageId: "42345678901234567",
				attachmentId,
			},
		};
		const attachmentResponse = await realFetch(
			`http://127.0.0.1:${address.port}/api/lead-capabilities/discord`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test-token",
				},
				body: JSON.stringify(attachmentEnvelope),
			},
		);
		expect(attachmentResponse.status).toBe(200);
		expect(attachmentResponse.headers.get("x-flywheel-request-id")).toBe(
			attachmentEnvelope.requestId,
		);
		expect(attachmentResponse.headers.get("x-flywheel-artifact-mime")).toBe(
			"text/plain",
		);
		expect(await attachmentResponse.text()).toBe("hello");
		attachmentFetch.mockImplementation(beforeAttachment);
		let attachmentSends = 0;
		attachmentFetch.mockImplementation((url, init) => {
			if (
				String(url) ===
					"https://discord.com/api/v10/channels/32345678901234567/messages" &&
				init?.method === "POST"
			) {
				attachmentSends++;
				return Promise.resolve(
					Response.json({
						id: "62345678901234567",
						channel_id: "32345678901234567",
					}),
				);
			}
			return beforeAttachment(url, init);
		});
		const sendEnvelope = {
			...envelope,
			operationId: "discord.message.attachments.send",
			requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			input: {
				threadId: "32345678901234567",
				artifactHandles: ["file-1"],
				text: "report",
			},
		};
		const upload = async (value: string, token = "test-token") =>
			realFetch(
				`http://127.0.0.1:${address.port}/api/lead-capabilities/discord/attachments`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/octet-stream",
					},
					body: new Uint8Array(
						encodeAttachmentUpload(sendEnvelope, [
							{
								handle: "file-1",
								mimeType: "text/plain",
								data: Buffer.from(value),
							},
						]),
					),
				},
			);
		expect((await upload("hello", "wrong")).status).toBe(401);
		expect(await (await upload("hello")).json()).toMatchObject({
			status: "succeeded",
			data: { messageId: "62345678901234567" },
		});
		expect(await (await upload("hello")).json()).toMatchObject({
			status: "succeeded",
		});
		expect(await (await upload("changed")).json()).toMatchObject({
			status: "rejected",
			errorCode: "input_digest_conflict",
		});
		expect(attachmentSends).toBe(1);
		const artifactRoot = join(realpathSync(home), "attachment-artifacts");
		mkdirSync(artifactRoot, { mode: 0o700 });
		const artifacts = new LeadArtifactStore({
			projectRoot: realpathSync(home),
			artifactRoot,
			assertCurrent: () => {},
		});
		try {
			const artifact = await artifacts.put(
				Buffer.from("parent upload"),
				"text/plain",
			);
			const parentEnv = {
				...Object.fromEntries(
					identityEnvProjection(row.identity).map((line) => {
						const at = line.indexOf("=");
						return [line.slice(0, at), line.slice(at + 1)];
					}),
				),
				HOME: home,
				FLYWHEEL_PROJECTS_FILE: projectsPath,
				FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
				FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
				FLYWHEEL_API_TOKEN: "test-token",
				FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "private-claim",
				FLYWHEEL_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
			};
			const parent = createBridgeAttachmentHandlers({
				env: parentEnv,
				activationId: "activation-1",
				store: artifacts,
				secrets: [],
				fetchImpl: realFetch,
			}).get("discord.message.attachments.send")!;
			const parentContext = {
				projectName: "flywheel",
				leadId: "eng",
				activationId: "activation-1",
				requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				signal: new AbortController().signal,
				assertCurrent: async () => {},
			};
			const parentInput = {
				threadId: "32345678901234567",
				artifactHandles: [artifact.handle],
				text: "parent report",
			};
			expect(await parent.execute(parentInput, parentContext)).toMatchObject({
				status: "succeeded",
				providerRef: "discord-message:62345678901234567",
			});
			const receipt = outboundDedupStore.operationReceipts.get({
				projectName: "flywheel",
				leadId: "eng",
				operationId: "discord.message.attachments.send",
				requestId: parentContext.requestId,
			})!;
			expect(
				await parent.reconcile!(receipt, parentInput, parentContext),
			).toMatchObject({ status: "succeeded" });
			expect(attachmentSends).toBe(2);
			issueLabels = ["Product"];
			expect(
				(await parent.reconcile!(receipt, parentInput, parentContext)).status,
			).not.toBe("succeeded");
			expect(attachmentSends).toBe(2);
			issueLabels = ["Engineering"];
		} finally {
			artifacts.close();
		}

		attachmentFetch.mockImplementation(beforeAttachment);
		attachmentFetch.mockClear();

		const reply = {
			...envelope,
			operationId: "discord.thread.reply",
			requestId: "aaaaaaaa-2222-4222-8222-111111111111",
			input: {
				threadId: "32345678901234567",
				text: "typed reply",
				eventId: "business-event",
			},
		};
		const replied = await post(reply);
		expect(replied.code).toBe(200);
		expect(replied.body.status).toBe("succeeded");
		expect(replied.body.data.messageId).toBe("32345678901234567");
		expect((await post(reply)).body).toEqual(replied.body);
		expect(
			(
				await post({
					...reply,
					requestId: "aaaaaaaa-2222-4222-8222-222222222222",
				})
			).body.status,
		).toBe("succeeded");
		expect(
			vi
				.mocked(globalThis.fetch)
				.mock.calls.filter(
					([url, init]) =>
						String(url).startsWith("https://discord.com/") &&
						init?.method === "POST",
				),
		).toHaveLength(1);
		issueLabels = ["Product"];
		expect(
			(
				await post({
					...reply,
					requestId: "aaaaaaaa-2222-4222-8222-333333333333",
				})
			).code,
		).toBe(403);
		issueLabels = ["Engineering"];
		const writes: string[] = [];
		let failReads = false;
		let revokeOnMessage = false,
			messageReads = 0;
		let cancelOnMessage = false,
			cancelReads = 0,
			lookupReached = () => {},
			releaseLookup = () => {};
		vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
			if (!String(url).startsWith("https://discord.com/"))
				return realFetch(url, init);
			const method = init?.method ?? "GET";
			if (failReads && String(url).includes("/messages?"))
				return Promise.resolve(new Response(null, { status: 503 }));
			if (
				revokeOnMessage &&
				method === "GET" &&
				String(url).includes("/messages/") &&
				++messageReads === 2
			)
				issueLabels = ["Operations"];
			if (method !== "GET") writes.push(method);
			const message = {
				id: "32345678901234567",
				channel_id: "32345678901234567",
				author: { id: "12345678901234567", bot: true },
				content: "message",
				timestamp: "2026-09-13T00:00:00.000Z",
			};
			if (
				cancelOnMessage &&
				method === "GET" &&
				String(url).includes("/messages/") &&
				++cancelReads === 2
			)
				return new Promise<Response>((resolve) => {
					releaseLookup = () =>
						resolve(new Response(JSON.stringify(message), { status: 200 }));
					lookupReached();
				});
			if (method === "PUT")
				return Promise.resolve(new Response(null, { status: 204 }));
			return Promise.resolve(
				new Response(
					JSON.stringify(
						String(url).includes("/messages?")
							? [message]
							: String(url).includes("/messages/")
								? message
								: {
										id: "32345678901234567",
										parent_id: "22345678901234567",
										type: 11,
									},
					),
					{ status: 200 },
				),
			);
		});
		const gateEdit = await post({
			...envelope,
			requestId: "dddddddd-2222-4222-8222-111111111111",
			operationId: "discord.message.edit",
			input: {
				threadId: "32345678901234567",
				messageId: "42345678901234567",
				text: "rewrite gate",
			},
		});
		expect(gateEdit.body.status).toBe("rejected");
		expect(writes).toEqual([]);
		const ops = [
			["discord.thread.read", { threadId: "32345678901234567", limit: 10 }],
			[
				"discord.message.edit",
				{
					threadId: "32345678901234567",
					messageId: "32345678901234567",
					text: "edited",
				},
			],
			[
				"discord.message.react",
				{
					threadId: "32345678901234567",
					messageId: "32345678901234567",
					emoji: "✅",
				},
			],
		];
		for (const [operationId, input] of ops) {
			const result = await post({ ...envelope, operationId, input });
			expect(result.body.status).toBe("succeeded");
		}
		expect(writes).toEqual(["PATCH", "PUT"]);
		revokeOnMessage = true;
		await post({
			...envelope,
			requestId: "bbbbbbbb-1111-4111-8111-111111111111",
			operationId: "discord.message.edit",
			input: {
				threadId: "32345678901234567",
				messageId: "32345678901234567",
				text: "must not write",
			},
		});
		expect(writes).toEqual(["PATCH", "PUT"]);
		revokeOnMessage = false;
		issueLabels = ["Engineering"];
		cancelOnMessage = true;
		const reached = new Promise<void>((resolve) => {
			lookupReached = resolve;
		});
		const cancel = new AbortController();
		const canceled = fetch(
			`http://127.0.0.1:${address.port}/api/lead-capabilities/discord`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer test-token",
				},
				signal: cancel.signal,
				body: JSON.stringify({
					...envelope,
					requestId: "cccccccc-1111-4111-8111-111111111111",
					operationId: "discord.message.edit",
					input: {
						threadId: "32345678901234567",
						messageId: "32345678901234567",
						text: "canceled",
					},
				}),
			},
		).catch(() => null);
		await reached;
		cancel.abort();
		await canceled;
		await new Promise((resolve) => setTimeout(resolve, 25));
		releaseLookup();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(writes).toEqual(["PATCH", "PUT"]);
		cancelOnMessage = false;

		expect((await post(envelope)).body).toEqual(first);
		expect(
			(await post({ ...envelope, input: { issueId: "FLY-2" } })).body.errorCode,
		).toBe("request_id_conflict");
		const alias = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		await post({
			...envelope,
			requestId: "33333333-3333-4333-8333-333333333333",
			input: { issueId: alias },
		});
		expect(store.getChatThreadByIssue).not.toHaveBeenCalledWith(
			alias,
			expect.anything(),
		);
		providerEnv.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID = "22345678901234567";
		expect(
			(
				await post({
					...envelope,
					requestId: "99999999-9999-4999-8999-999999999999",
				})
			).code,
		).toBe(403);
		delete providerEnv.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID;
		issueLabels = ["Operations"];
		expect(
			(
				await post({
					...envelope,
					requestId: "44444444-4444-4444-8444-444444444444",
				})
			).code,
		).toBe(403);
		issueLabels = ["Engineering"];
		claim.processIndeterminate = true;
		expect(
			(
				await post({
					...envelope,
					requestId: "aaaaaaaa-1111-4111-8111-111111111111",
				})
			).code,
		).toBe(403);
		claim.processIndeterminate = false;
		onLabels = () => {
			writeFileSync(
				carrierEvidencePath,
				'{"leads":{"fixture":{"generation":2}}}',
			);
		};
		expect(
			(
				await post({
					...envelope,
					requestId: "55555555-5555-4555-8555-555555555555",
				})
			).code,
		).toBe(403);
		onLabels = () => {};
		writeFileSync(
			carrierEvidencePath,
			'{"leads":{"fixture":{"generation":1}}}',
		);
		onLabels = () => {
			sessionBinding = {
				issue_id: "foreign-alias",
				project_name: "flywheel",
			};
		};
		expect(
			(
				await post({
					...envelope,
					requestId: "88888888-8888-4888-8888-888888888888",
				})
			).code,
		).toBe(403);
		sessionBinding = undefined;
		onLabels = () => {};
		const savedRegistry = readFileSync(projectsPath, "utf8");
		onLabels = () => {
			const changed = JSON.parse(savedRegistry);
			changed[0].leads[0].match.labels = ["Other"];
			writeFileSync(projectsPath, JSON.stringify(changed));
		};
		expect(
			(
				await post({
					...envelope,
					requestId: "66666666-6666-4666-8666-666666666666",
				})
			).code,
		).toBe(403);
		onLabels = () => {};
		writeFileSync(projectsPath, savedRegistry);
		claim.valid = false;
		expect(
			(
				await post({
					...envelope,
					requestId: "22222222-2222-4222-8222-222222222222",
				})
			).code,
		).toBe(403);
		claim.valid = true;
		for (let i = 0; i < 65; i++) {
			const result = await post({
				...envelope,
				requestId: `77777777-7777-4777-8777-${String(i).padStart(12, "0")}`,
			});
			expect(result.body.status).toBe("succeeded");
		}
		failReads = true;
		for (let i = 0; i < 65; i++) {
			const result = await post({
				...envelope,
				operationId: "discord.thread.read",
				input: { threadId: "32345678901234567", limit: 10 },
				requestId: `dddddddd-1111-4111-8111-${String(i).padStart(12, "0")}`,
			});
			expect(result.body.status).toBe("unknown");
		}
		failReads = false;
		const recovered = await post({
			...envelope,
			operationId: "discord.thread.read",
			input: { threadId: "32345678901234567", limit: 10 },
			requestId: "eeeeeeee-1111-4111-8111-111111111111",
		});
		expect(recovered.body.status).toBe("succeeded");
		const uncertainWrite = await post({
			...envelope,
			requestId: "cccccccc-1111-4111-8111-111111111111",
			operationId: "discord.message.edit",
			input: {
				threadId: "32345678901234567",
				messageId: "32345678901234567",
				text: "canceled",
			},
		});
		expect(uncertainWrite.body.status).toBe("unknown");
		expect(writes).toEqual(["PATCH", "PUT"]);
	} finally {
		outboundDedupStore.close();
		claim.valid = true;
		claim.processIndeterminate = false;
		claim.calls = 0;
		vi.restoreAllMocks();
		rmSync(home, { recursive: true, force: true });
	}
	// Includes two 65-request capacity/recovery sweeps over real HTTP and registry I/O.
}

it.each(["routing", "unknown-write-capacity", "missing-receipts"])(
	"exercises the registry-owned typed route: %s",
	exerciseDiscordRoute,
	// A routing scenario includes 130 sequential recovery probes. A 30s test
	// timeout abandons its async cleanup while the next scenario owns the mocks.
	// Keep every request/assertion and allow the full fixture to finish; this
	// does not change the provider request budget.
	120_000,
);

it("mounts the provider at its literal Bridge route", async () => {
	const app = express();
	app.use(express.json());
	mountLeadCapabilityDiscordProvider(app, {
		apiToken: "test-token",
		store: {} as StateStore,
	});
	const server = app.listen(0, "127.0.0.1");
	servers.push(server);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address() as { port: number };
	expect(
		(
			await fetch(
				`http://127.0.0.1:${address.port}/api/lead-capabilities/discord`,
				{ method: "POST" },
			)
		).status,
	).toBe(401);
});

it.each(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "FLY-1"])(
	"HTTP new-create preserves canonical UUID storage and verified identifier title for %s",
	async (issueInput) => {
		const home = mkdtempSync(join(tmpdir(), "bridge-create-"));
		const store = await StateStore.create(":memory:");
		const dedup = new SqliteOutboundDedupStore(join(home, "dedup.db"));
		try {
			mkdirSync(join(home, ".flywheel"));
			writeFileSync(
				join(home, ".flywheel/lead-carrier-evidence.json"),
				'{"leads":{"fixture":{"generation":1}}}',
			);
			writeFileSync(
				join(home, ".flywheel/summary-config.json"),
				JSON.stringify({
					granularity: "per-lead",
					setBy: "founder",
					setAt: "2026-08-28T00:00:00.000Z",
				}),
			);
			const projectsPath = join(home, "projects.json");
			writeFileSync(
				projectsPath,
				JSON.stringify([
					{
						projectName: "flywheel",
						projectRoot: home,
						linear: { team: "FLY", project: "Flywheel" },
						leads: [
							{
								agentId: "eng",
								summaryRole: "producer",
								backend: "codex-app-server",
								codexProfile: "full-access",
								codexRunnerActions: false,
								canSpawnRunners: false,
								codexCapabilityBundleVersion: 2,
								botTokenEnv: "ENG_BOT_TOKEN",
								botUserId: "12345678901234567",
								chatChannel: "22345678901234567",
								match: { labels: ["Engineering"] },
							},
						],
					},
				]),
			);
			const row = resolveLeadIdentityRow({
				projectsPath,
				homeDir: home,
				projectName: "flywheel",
				leadId: "eng",
			});

			const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				threadId = "32345678901234567",
				parentId = "22345678901234567";
			store.upsertSession({
				execution_id: "create-execution",
				issue_id: uuid,
				issue_identifier: "FLY-1",
				project_name: "flywheel",
				status: "completed",
			});
			const client = {
				issue: vi.fn(async () => ({
					id: uuid,
					identifier: "FLY-1",
					team: Promise.resolve({ key: "FLY" }),
					project: Promise.resolve({ name: "Flywheel" }),
					labels: async () => ({
						nodes: [{ name: "Engineering" }],
						pageInfo: { hasNextPage: false },
					}),
				})),
			} as unknown as LinearClient;
			const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
			const realFetch = globalThis.fetch;
			vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
				if (!String(url).startsWith("https://discord.com/"))
					return realFetch(url, init);
				if (init?.method === "POST")
					posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
				return Promise.resolve(
					new Response(
						JSON.stringify({ id: threadId, parent_id: parentId, type: 11 }),
						{ status: 200 },
					),
				);
			});
			const app = express();
			app.use(express.json());
			mountLeadCapabilityDiscordProvider(app, {
				apiToken: "test-token",
				store,
				projectsPath,
				homeDir: home,
				env: { ENG_BOT_TOKEN: "bot-token" },
				linearClient: client,
				chatThreadCreator: new ChatThreadCreator(store),
				operationReceipts: dedup.operationReceipts,
			});
			const server = app.listen(0, "127.0.0.1");
			servers.push(server);
			await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address() as { port: number };
			const result = await fetch(
				`http://127.0.0.1:${address.port}/api/lead-capabilities/discord`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer test-token",
					},
					body: JSON.stringify({
						schemaVersion: 1,
						operationId: "discord.thread.create",
						requestId: "11111111-1111-4111-8111-111111111111",
						projectName: "flywheel",
						leadId: "eng",
						identityDigest: row.identity.identityDigest,
						carrierClaim: "private-claim",
						activationId: "activation-1",
						input: { issueId: issueInput, parentId, name: "Review report" },
					}),
				},
			);
			expect(result.status).toBe(200);
			expect((await result.json()).status).toBe("succeeded");
			expect(posts).toHaveLength(2);
			expect(posts[0]!.body.content).toContain("FLY-1");
			expect(posts[0]!.body.content).not.toContain(uuid);
			expect(posts[1]!.body.name).toContain("FLY-1");
			expect(posts[1]!.body.name).not.toContain(uuid);
			expect(store.getChatThreadByIssue(uuid, parentId)?.thread_id).toBe(
				threadId,
			);
			expect(store.getChatThreadByIssue("FLY-1", parentId)).toBeUndefined();
		} finally {
			vi.restoreAllMocks();
			store.close();
			dedup.close();
			rmSync(home, { recursive: true, force: true });
		}
	},
);
