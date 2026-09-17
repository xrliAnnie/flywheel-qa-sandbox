import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { XhsFrozenArtifactStore } from "../artifacts.js";
import { createAuthorityHandlers } from "../authority-handlers.js";
import { contentDigest } from "../canonical.js";
import type { ReviewMessage, ReviewTransport } from "../cards.js";
import type { FrozenWrite } from "../contracts.js";
import { XhsFounderObserver } from "../observer.js";
import { dispatchPermitSchema } from "../permit.js";
import { fixture, NOW } from "./store-fixture.js";

// Real Unix HTTP ingress/native peer reader, preparation/cards, registry,
// founder observer, SQLite CAS and executor. Only platform and Discord are fake.
// This is a same-UID source integration test, not host isolation evidence.
it.each([
	{ operation: "xiaohongshu.like_feed", payload: {} },
	{ operation: "xiaohongshu.like_feed", payload: { unlike: true } },
	{ operation: "xiaohongshu.favorite_feed", payload: {} },
	{ operation: "xiaohongshu.favorite_feed", payload: { unfavorite: true } },
	{
		operation: "xiaohongshu.post_comment_to_feed",
		payload: { content: "fixture comment" },
	},
	{
		operation: "xiaohongshu.reply_comment_in_feed",
		payload: { content: "fixture reply" },
	},
	{
		operation: "xiaohongshu.publish_content",
		payload: { title: "fixture", content: "fixture image" },
	},
	{
		operation: "xiaohongshu.publish_with_video",
		payload: { title: "fixture", content: "fixture video" },
	},
] as const)(
	"carries $operation $payload through HTTP, founder reply, one-use dispatch and reopen",
	async ({ operation, payload }) => {
		const f = fixture(process.getuid!());
		const root = mkdtempSync("/tmp/xhs-whole-flow-");
		const helper = join(root, "peer");
		const mediaRoot = join(root, "media");
		mkdirSync(mediaRoot, { mode: 0o700 });
		const video = operation === "xiaohongshu.publish_with_video";
		const publish = operation.startsWith("xiaohongshu.publish_");
		const mediaBytes = video
			? Buffer.from("000000186674797069736f6d0000000069736f6d6d703432", "hex")
			: Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex");
		const artifacts = () =>
			new XhsFrozenArtifactStore(mediaRoot, f.store, {
				attachmentLimit: 1024 * 1024,
				// Decoder is a fixed synthetic adapter in this integration suite.
				validate: async (_path) => {},
			});
		const artifactIds = publish
			? [
					(
						await artifacts().import(
							f.identity.projectId,
							video ? "video/mp4" : "image/png",
							(async function* () {
								yield mediaBytes;
							})(),
							NOW,
						)
					).artifactId,
				]
			: [];
		execFileSync("cc", [
			"-O2",
			fileURLToPath(
				new URL(
					"../../../../../scripts/xhs/xhs-peer-credentials.c",
					import.meta.url,
				),
			),
			"-o",
			helper,
		]);
		const policy = {
			...f.identity,
			founderId: "100000000000000001",
			canonicalFounderId: "100000000000000001",
			botId: "100000000000000002",
			guildId: "100000000000000003",
			channelId: "100000000000000004",
		};
		let now = NOW,
			sequence = 0,
			commits = 0;
		const snowflake = (time: number) =>
			(
				((BigInt(time) - 1420070400000n) << 22n) +
				BigInt(sequence++)
			).toString();
		const messages = new Map<string, ReviewMessage>();
		const attachments = new Map<string, Buffer>();
		const transport: ReviewTransport = {
			async send(content, files, mentions) {
				expect(mentions).toEqual({ parse: [] });
				const id = snowflake(now);
				const items = files.map((file, n) => {
					const aid = `${id}-${n}`;
					attachments.set(aid, Buffer.from(file.bytes));
					return { id: aid, name: file.name, size: file.bytes.length };
				});
				messages.set(id, {
					id,
					authorId: policy.botId,
					channelId: policy.channelId,
					content,
					attachments: items,
				});
				return id;
			},
			async fetch(id) {
				return structuredClone(messages.get(id)!);
			},
			async readAttachment(id) {
				return Buffer.from(attachments.get(id)!);
			},
			async remove(id) {
				messages.delete(id);
			},
		};
		const rawReplies = new Map<string, unknown>();
		const source = {
			async fetchMessage(_channel: string, id: string) {
				if (rawReplies.has(id)) return structuredClone(rawReplies.get(id));
				const m = messages.get(id)!;
				return {
					id: m.id,
					channel_id: m.channelId,
					guild_id: policy.guildId,
					author: { id: m.authorId, bot: true },
					edited_timestamp: null,
					timestamp: new Date(NOW).toISOString(),
					content: m.content,
					attachments: m.attachments.map((a) => ({
						id: a.id,
						filename: a.name,
						size: a.size,
					})),
				};
			},
			async channelGuild() {
				return policy.guildId;
			},
			readAttachment: transport.readAttachment,
		};
		const key = Buffer.alloc(32, 7);
		const leases = new Map<string, FrozenWrite>();
		const consumed = new Set<string>();
		const provider: Parameters<typeof createAuthorityHandlers>[0]["provider"] =
			{
				async account() {
					return {
						account: f.frozen.account,
						upstream: f.frozen.upstream,
						loggedIn: true,
					};
				},
				async readFeeds() {
					return {
						account: f.frozen.account,
						upstream: f.frozen.upstream,
						data: {
							feeds: [{ id: "feed-a", xsecToken: "synthetic-parent-token" }],
							count: 1,
						},
					};
				},
				async read(action, input) {
					expect(action).toBe("get_feed_detail");
					expect(input).toMatchObject({ xsec_token: "synthetic-parent-token" });
					return {
						account: f.frozen.account,
						upstream: f.frozen.upstream,
						data: {
							feed_id: "feed-a",
							data: {
								note: { noteId: "feed-a", xsecToken: "synthetic-parent-token" },
								comments: {
									list: [
										{
											id: "comment-a",
											noteId: "feed-a",
											userInfo: { userId: "author-a" },
											subComments: null,
										},
									],
								},
							},
						},
					};
				},
				async loginQR() {
					throw Error("fixture_login_not_used");
				},
				async prepare(frozen, readMedia) {
					expect(frozen.operationId).toBe(operation);
					for (const media of frozen.media) {
						const chunks: Buffer[] = [];
						for await (const chunk of readMedia(
							media,
							new AbortController().signal,
						))
							chunks.push(Buffer.from(chunk));
						expect(Buffer.concat(chunks)).toEqual(mediaBytes);
					}
					const leaseId = randomUUID();
					leases.set(leaseId, structuredClone(frozen));
					return {
						leaseId,
						accountUserId: frozen.account.accountUserId,
						accountEpoch: frozen.account.accountEpoch,
						providerGeneration: frozen.account.providerGeneration,
						contentDigest: contentDigest(frozen),
						leaseExpiresAt: now + 60000,
					};
				},
				async commit(leaseId, signed) {
					const permit = dispatchPermitSchema.parse(
						JSON.parse(signed.permitJson),
					);
					expect(permit.leaseId).toBe(leaseId);
					expect(signed.signature).toBe(
						createHmac("sha256", key)
							.update("flywheel:xhs-permit:v1\n")
							.update(signed.permitJson)
							.digest("hex"),
					);
					const frozen = leases.get(permit.leaseId)!;
					expect(permit.contentDigest).toBe(contentDigest(frozen));
					expect(f.store.status(frozen.proposalId, f.identity)?.state).toBe(
						"consumed",
					);
					expect(consumed.has(permit.receiptId)).toBe(false);
					consumed.add(permit.receiptId);
					commits++;
					return "succeeded";
				},
			};
		const make = () =>
			createAuthorityHandlers({
				config: {
					enabled: true,
					modelUid: process.getuid!(),
					serviceUid: 450,
					policyVersion: 1,
					founderConfigVersion: 1,
					keyId: "fixture-key",
					peerHelper: {
						path: helper,
						sha256: createHash("sha256")
							.update(readFileSync(helper))
							.digest("hex"),
					},
					registry: [
						{
							projectId: f.identity.projectId,
							leadId: f.identity.leadId,
							account: f.frozen.account,
							founderId: policy.founderId,
							canonicalFounderId: policy.founderId,
							botId: policy.botId,
							guildId: policy.guildId,
							channelId: policy.channelId,
							initialCursor: snowflake(NOW - 1000),
						},
					],
					provider: {
						providerBinary: {
							path: "/synthetic/provider",
							sha256: f.frozen.upstream.binarySha256,
						},
						toolSchemaDigest: f.frozen.upstream.toolSchemaDigest,
					},
				},
				store: f.store,
				key,
				provider,
				transport: () => transport,
				artifacts: artifacts(),
				attachmentLimit: 1024 * 1024,
				assertCurrent: () => {},
				now: () => now,
			});
		let handlers = make();
		const server = createServer((req, res) => void handlers.ingress(req, res));
		const socketPath = join(root, "ingress.sock");
		const post = (path: string, input: unknown) =>
			new Promise<{ status: number; body: any }>((resolve, reject) => {
				const req = request(
					{
						socketPath,
						path,
						method: "POST",
						headers: { "content-type": "application/json" },
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (chunk) => chunks.push(chunk));
						res.on("end", () => {
							try {
								resolve({
									status: res.statusCode!,
									body: JSON.parse(Buffer.concat(chunks).toString()),
								});
							} catch (e) {
								reject(e);
							}
						});
					},
				);
				req.on("error", reject);
				req.setTimeout(5000, () => req.destroy(Error("fixture_timeout")));
				req.end(
					JSON.stringify({
						projectId: f.identity.projectId,
						leadId: f.identity.leadId,
						activationId: "activation-a",
						input,
					}),
				);
			});
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			const read = await post("/v1/read/list_feeds", {});
			expect(read.status).toBe(200);
			expect(JSON.stringify(read.body)).not.toContain("synthetic-parent-token");
			let targetHandle = JSON.parse(read.body.text).feeds[0].resourceHandle;
			expect(targetHandle).toBeTruthy();
			if (operation === "xiaohongshu.reply_comment_in_feed") {
				const detail = await post("/v1/read/get_feed_detail", {
					feed_id: "feed-a",
					resourceHandle: targetHandle,
				});
				expect(detail.status).toBe(200);
				targetHandle = JSON.parse(detail.body.text).data.comments.list[0]
					.resourceHandle;
			}
			const prepared = await post("/v1/write/prepare", {
				accountSelector: f.identity.accountUserId,
				prepareRequestId: "whole-flow",
				operationId: operation,
				payload,
				artifactIds,
				targetHandle: publish ? null : targetHandle,
			});
			expect(prepared.status).toBe(200);
			expect(prepared.body.state).toBe("awaiting_approval");
			const { proposalId, contentDigest: digest } = prepared.body;
			const execution = {
				proposalId,
				contentDigest: digest,
				receiptId: randomUUID(),
				operationId: operation,
				executeRequestId: "before",
			};
			expect((await post("/v1/write/execute", execution)).body.kind).toBe(
				"denied",
			);
			expect(commits).toBe(0);
			const record = f.store.approvalRecord(proposalId)!;
			now = NOW + 2000;
			const reply = (author: string) => {
				const id = snowflake(now);
				rawReplies.set(id, {
					id,
					channel_id: policy.channelId,
					guild_id: policy.guildId,
					author: { id: author, bot: false },
					type: 19,
					message_reference: {
						type: 0,
						message_id: record.cardId,
						channel_id: policy.channelId,
						guild_id: policy.guildId,
					},
					timestamp: new Date(now).toISOString(),
					edited_timestamp: null,
					content: `批准小红书 ${record.challenge}`,
				});
				return id;
			};
			const observer = new XhsFounderObserver(
				f.store,
				source,
				() => policy,
				() => now + 1000,
			);
			await expect(
				observer.observe(proposalId, reply("100000000000000099")),
			).rejects.toThrow();
			expect(commits).toBe(0);
			const replyId = reply(policy.founderId);
			await observer.observe(proposalId, replyId);
			now += 1000;
			const receiptId = f.store.receiptForFounderMessage(replyId)!;
			expect(receiptId).toBeTruthy();
			const approved = {
				...execution,
				receiptId,
				executeRequestId: "approved",
			};
			expect(
				(
					await post("/v1/write/execute", {
						...approved,
						contentDigest: "f".repeat(64),
					})
				).body.kind,
			).toBe("denied");
			expect(commits).toBe(0);
			const results = await Promise.all([
				post("/v1/write/execute", approved),
				post("/v1/write/execute", {
					...approved,
					executeRequestId: "concurrent",
				}),
			]);
			expect(
				results,
				JSON.stringify(f.store.status(proposalId, f.identity)),
			).toContainEqual({
				status: 200,
				body: expect.objectContaining({ state: "succeeded" }),
			});
			expect(commits).toBe(1);
			handlers.close();
			f.restart();
			handlers = make();
			expect(
				(
					await post("/v1/write/execute", {
						...approved,
						executeRequestId: "after-reopen",
					})
				).body.state,
			).toBe("succeeded");
			expect(commits).toBe(1);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			handlers.close();
			f.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	20000,
);
