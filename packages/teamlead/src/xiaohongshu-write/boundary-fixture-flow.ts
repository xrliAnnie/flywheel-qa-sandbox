import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { XhsFrozenArtifactStore } from "./artifacts.js";
import { createAuthorityHandlers } from "./authority-handlers.js";
import { contentDigest } from "./canonical.js";
import type { ReviewMessage, ReviewTransport } from "./cards.js";
import type { FrozenWrite } from "./contracts.js";
import { XhsFounderObserver } from "./observer.js";
import { dispatchPermitSchema } from "./permit.js";
import { XhsWriteStore } from "./store.js";

const NOW = Date.parse("2026-09-14T20:00:00Z");
function syntheticLedger(root: string) {
	const account = {
		providerInstanceId: "provider-a",
		accountUserId: "account-a",
		accountEpoch: 1,
		providerGeneration: "generation-a",
	};
	const upstream = {
		binarySha256: "a".repeat(64),
		toolSchemaDigest: "b".repeat(64),
		guardProtocol: 1 as const,
	};
	const identity = {
		requesterUid: process.getuid!(),
		projectId: "project-a",
		leadId: "lead-a",
		authorityPolicyVersion: 1,
		founderConfigVersion: 1,
		...account,
	};
	const path = join(root, "ledger.db");
	let store = new XhsWriteStore(path, {
		initialize: true,
		providerGeneration: account.providerGeneration,
	});
	store.setDispatchEnabled(true, NOW);
	return {
		identity,
		frozen: { account, upstream },
		get store() {
			return store;
		},
		restart() {
			store.close();
			store = new XhsWriteStore(path, {
				providerGeneration: account.providerGeneration,
			});
		},
		close() {
			store.close();
		},
	};
}

const cases = [
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
] as const;
/** Fixed offline scenarios: no real credentials, endpoints or caller-authored
 * proposals. Only the root-validated independent entry may use these as probe
 * evidence. Direct calls in tests do not establish host authorization. */
export async function runSyntheticAuthorityCase(
	root: string,
	peerHelper: { path: string; sha256: string },
	caseIndex: number,
	socketPath = join(root, "ingress.sock"),
) {
	assert(
		Number.isInteger(caseIndex) && caseIndex >= 0 && caseIndex < cases.length,
	);
	assert.deepEqual(readdirSync(root), []);
	assert(Buffer.byteLength(socketPath) <= 103);
	const { operation, payload } = cases[caseIndex]!;
	const f = syntheticLedger(root);
	try {
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
				assert.deepEqual(mentions, { parse: [] });
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
					assert.equal(action, "get_feed_detail");
					assert.equal(
						(input as Record<string, unknown>).xsec_token,
						"synthetic-parent-token",
					);
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
					assert.equal(frozen.operationId, operation);
					for (const media of frozen.media) {
						const chunks: Buffer[] = [];
						for await (const chunk of readMedia(
							media,
							new AbortController().signal,
						))
							chunks.push(Buffer.from(chunk));
						assert.deepEqual(Buffer.concat(chunks), mediaBytes);
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
					assert.equal(permit.leaseId, leaseId);
					assert.equal(
						signed.signature,
						createHmac("sha256", key)
							.update("flywheel:xhs-permit:v1\n")
							.update(signed.permitJson)
							.digest("hex"),
					);
					const frozen = leases.get(permit.leaseId)!;
					assert.equal(permit.contentDigest, contentDigest(frozen));
					assert.equal(
						f.store.status(frozen.proposalId, f.identity)?.state,
						"consumed",
					);
					assert.equal(consumed.has(permit.receiptId), false);
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
					peerHelper,
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
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const read = await post("/v1/read/list_feeds", {});
			assert.equal(read.status, 200);
			assert(!JSON.stringify(read.body).includes("synthetic-parent-token"));
			let targetHandle = JSON.parse(read.body.text).feeds[0].resourceHandle;
			assert(targetHandle);
			if (operation === "xiaohongshu.reply_comment_in_feed") {
				const detail = await post("/v1/read/get_feed_detail", {
					feed_id: "feed-a",
					resourceHandle: targetHandle,
				});
				assert.equal(detail.status, 200);
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
			assert.equal(prepared.status, 200);
			assert.equal(prepared.body.state, "awaiting_approval");
			const { proposalId, contentDigest: digest } = prepared.body;
			const execution = {
				proposalId,
				contentDigest: digest,
				receiptId: randomUUID(),
				operationId: operation,
				executeRequestId: "before",
			};
			assert.equal(
				(await post("/v1/write/execute", execution)).body.kind,
				"denied",
			);
			assert.equal(commits, 0);
			const missingReceiptCommits = commits;
			assert.equal(
				(
					await post("/v1/write/execute", {
						...execution,
						approved: true,
						actor: policy.founderId,
						time: NOW,
						shipReceipt: { approved: true },
					})
				).body.kind,
				"denied",
			);
			assert.equal(commits, 0);
			assert.equal(
				f.store.status(proposalId, f.identity)?.state,
				"awaiting_approval",
			);
			const forgedIngressCommits = commits;
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
			await assert.rejects(
				observer.observe(proposalId, reply("100000000000000099")),
			);
			assert.equal(commits, 0);
			const wrongFounderCommits = commits;
			const replyId = reply(policy.founderId);
			await observer.observe(proposalId, replyId);
			now += 1000;
			const receiptId = f.store.receiptForFounderMessage(replyId)!;
			assert(receiptId);
			const approved = {
				...execution,
				receiptId,
				executeRequestId: "approved",
			};
			assert.equal(
				(
					await post("/v1/write/execute", {
						...approved,
						contentDigest: "f".repeat(64),
					})
				).body.kind,
				"denied",
			);
			assert.equal(commits, 0);
			const digestMismatchCommits = commits;
			const results = await Promise.all([
				post("/v1/write/execute", approved),
				post("/v1/write/execute", {
					...approved,
					executeRequestId: "concurrent",
				}),
			]);
			assert(
				results.some((r) => r.status === 200 && r.body.state === "succeeded"),
			);
			assert.equal(commits, 1);
			handlers.close();
			f.restart();
			handlers = make();
			assert.equal(
				(
					await post("/v1/write/execute", {
						...approved,
						executeRequestId: "after-reopen",
					})
				).body.state,
				"succeeded",
			);
			assert.equal(commits, 1);
			return {
				probeKind: "fixture_harness" as const,
				caseIndex,
				operation,
				commits,
				replayedCommits: commits,
				negativeCommits: {
					missingReceipt: missingReceiptCommits,
					forgedIngress: forgedIngressCommits,
					wrongFounder: wrongFounderCommits,
					digestMismatch: digestMismatchCommits,
				},
				uid: process.getuid!(),
			};
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			handlers.close();
		}
	} finally {
		f.close();
	}
}
