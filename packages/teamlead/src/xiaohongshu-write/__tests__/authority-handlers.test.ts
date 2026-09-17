import { afterEach, expect, it, vi } from "vitest";
import { createAuthorityHandlers } from "../authority-handlers.js";
import { fixture, NOW } from "./store-fixture.js";

type IngressOptions = Parameters<
	typeof import("../ingress.js").createWriteIngressHandler
>[0];
type ArtifactOptions = Parameters<
	typeof import("../artifact-ingress.js").createArtifactIngressHandler
>[0];
type ProviderOptions = Parameters<
	typeof import("../provider-authority.js").createProviderAuthorityHandler
>[0];
const captured = vi.hoisted(() => ({
	ingress: undefined as unknown as IngressOptions,
	artifact: undefined as unknown as ArtifactOptions,
	provider: undefined as unknown as ProviderOptions,
}));
vi.mock("../artifact-ingress.js", () => ({
	createArtifactIngressHandler: (options: ArtifactOptions) => {
		captured.artifact = options;
		return () => {};
	},
}));
vi.mock("../ingress.js", () => ({
	createWriteIngressHandler: (options: IngressOptions) => {
		captured.ingress = options;
		return () => {};
	},
}));
vi.mock("../provider-authority.js", () => ({
	createProviderAuthorityHandler: (options: ProviderOptions) => {
		captured.provider = options;
		return () => {};
	},
}));
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
it.each([true, false])(
	"assembles read transport independently of write enabled=%s",
	async (enabled) => {
		const f = fixture();
		cleanup.push(() => f.close());
		f.approve();
		let current = true,
			leased = false,
			loggedIn = true,
			accountEpoch = f.identity.accountEpoch,
			accounts = 0,
			commits = 0;
		const config = {
			enabled,
			modelUid: f.identity.requesterUid,
			serviceUid: 450,
			policyVersion: 1,
			founderConfigVersion: 1,
			keyId: "key-a",
			peerHelper: { path: "/fixture/peer", sha256: "a".repeat(64) },
			registry: [
				{
					projectId: f.identity.projectId,
					leadId: f.identity.leadId,
					account: f.frozen.account,
					founderId: "founder",
					canonicalFounderId: "founder",
					botId: "bot",
					guildId: "guild",
					channelId: "thread",
					initialCursor: "12345678901234567",
				},
			],
			provider: {
				providerBinary: {
					path: "/fixture/provider",
					sha256: f.frozen.upstream.binarySha256,
				},
				toolSchemaDigest: f.frozen.upstream.toolSchemaDigest,
			},
		};
		const handlers = createAuthorityHandlers({
			config,
			store: f.store,
			key: Buffer.alloc(32),
			assertCurrent: () => {
				if (!current) throw Error("changed");
			},
			provider: {
				loginQR: async () => {
					accountEpoch++;
					return {
						account: { ...f.frozen.account, accountEpoch },
						upstream: f.frozen.upstream,
						loggedIn: false as const,
						image:
							"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==",
						expiresAt: NOW + 120000,
					};
				},
				read: async (action, input) => {
					expect(leased).toBe(false);
					if (action === "get_feed_detail") {
						expect(input).toMatchObject({
							feed_id: "feed-a",
							xsec_token: "private-token",
						});
						expect(input).not.toHaveProperty("resourceHandle");
						return {
							account: f.frozen.account,
							upstream: f.frozen.upstream,
							data: {
								feed_id: "feed-a",
								data: {
									note: { noteId: "feed-a", xsecToken: "" },
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
					}
					return {
						account: f.frozen.account,
						upstream: f.frozen.upstream,
						data:
							action === "list_collections"
								? []
								: action === "get_collection_content"
									? {
											notes: [{ noteId: "feed-a", xsecToken: "private-token" }],
											count: 1,
											total: 1,
										}
									: {
											feeds: [{ id: "feed-a", xsecToken: "private-token" }],
											count: 1,
										},
					};
				},
				readFeeds: async () => {
					expect(leased).toBe(false);
					return {
						account: f.frozen.account,
						upstream: f.frozen.upstream,
						data: {
							feeds: [{ id: "feed-a", xsec_token: "private-token" }],
							count: 1,
						},
					};
				},
				account: async () => {
					expect(leased).toBe(false);
					accounts++;
					return {
						account: { ...f.frozen.account, accountEpoch },
						upstream: f.frozen.upstream,
						loggedIn,
					};
				},
				prepare: async () => {
					leased = true;
					return {
						leaseId: f.request.leaseId,
						accountUserId: f.identity.accountUserId,
						accountEpoch: f.identity.accountEpoch,
						providerGeneration: f.identity.providerGeneration,
						contentDigest: f.digest,
						leaseExpiresAt: NOW + 60000,
					};
				},
				commit: async () => {
					commits++;
					expect(
						await captured.provider.token(
							{ frozen: f.frozen, activationId: "activation-a" },
							new AbortController().signal,
						),
					).toBe("private-token");
					expect(
						await captured.provider.scope(
							f.frozen.proposalId,
							new AbortController().signal,
						),
					).toMatchObject({
						activationId: "activation-a",
						identity: f.identity,
					});
					return "succeeded" as const;
				},
			},
			artifacts: {
				import: async (projectId, mime, stream) => {
					expect(projectId).toBe(f.identity.projectId);
					for await (const _ of stream) {
					}
					return {
						artifactId: "12345678-1234-4123-8123-123456789012",
						mimeType: mime,
						sizeBytes: 1,
						sha256: "a".repeat(64),
					};
				},
				read: async () => {
					throw Error("no media");
				},
			},
			transport: () => {
				throw Error("not preparing");
			},
			attachmentLimit: 1024,
			now: () => NOW + 3000,
		});
		const context = await captured.ingress.scope(
			f.identity.requesterUid,
			{
				projectId: f.identity.projectId,
				leadId: f.identity.leadId,
				activationId: "activation-a",
			},
			new AbortController().signal,
		);
		expect(context).toEqual({
			identity: f.identity,
			activationId: "activation-a",
		});
		if (!context) throw Error("scope missing");
		const upload = captured.artifact.import(
			context,
			"image/png",
			(async function* () {
				yield Buffer.from("a");
			})(),
			new AbortController().signal,
		);
		if (enabled)
			expect(await upload).toMatchObject({
				sizeBytes: 1,
				mimeType: "image/png",
			});
		else await expect(upload).rejects.toThrow("write_gate_closed");

		if (enabled) {
			await expect(
				captured.artifact.import(
					context,
					"image/png",
					(async function* () {
						yield Buffer.alloc(1025);
					})(),
					new AbortController().signal,
				),
			).rejects.toThrow("preview_media_too_large");
		}
		loggedIn = false;
		const selection = {
			projectId: f.identity.projectId,
			leadId: f.identity.leadId,
			activationId: "activation-a",
		};
		expect(
			await captured.ingress.scope(
				f.identity.requesterUid,
				selection,
				new AbortController().signal,
				"read",
			),
		).toEqual(context);
		await expect(
			captured.ingress.scope(
				f.identity.requesterUid,
				selection,
				new AbortController().signal,
				"write",
			),
		).rejects.toThrow("write_scope_unavailable");
		loggedIn = true;
		const projected = await captured.ingress.readFeeds!(
			context,
			new AbortController().signal,
		);
		expect(projected).not.toContain("private-token");
		expect(JSON.parse(projected).feeds[0].resourceHandle).toEqual(
			expect.any(String),
		);
		for (const [action, input] of [
			["search_feeds", { keyword: "query" }],
			["list_saved_content", {}],
			["list_collections", {}],
			["get_collection_content", { collection_id: "collection-a" }],
		] as const) {
			const text = await captured.ingress.readList!(
				context,
				action,
				input,
				new AbortController().signal,
			);
			expect(text).not.toContain("private-token");
			const data = JSON.parse(text);
			if (action !== "list_collections")
				expect((data.feeds ?? data.notes)[0].resourceHandle).toEqual(
					expect.any(String),
				);
		}
		const detailInput = {
			feed_id: "feed-a",
			resourceHandle: JSON.parse(projected).feeds[0].resourceHandle,
		};
		const detail = await captured.ingress.readDetail!(
			context,
			detailInput,
			new AbortController().signal,
		);
		expect(detail).not.toContain("private-token");
		expect(JSON.parse(detail).data.comments.list[0].resourceHandle).toEqual(
			expect.any(String),
		);
		await expect(
			captured.ingress.readDetail!(
				{ ...context, activationId: "unseen" },
				detailInput,
				new AbortController().signal,
			),
		).rejects.toThrow();
		const executor = captured.ingress.executor(context);
		const result = await executor.execute({
			proposalId: f.frozen.proposalId,
			receiptId: f.receiptId,
			contentDigest: f.digest,
			operationId: f.frozen.operationId,
			executeRequestId: "exec-a",
		});
		if (!enabled) {
			expect(result).toMatchObject({ kind: "denied" });
			expect(leased).toBe(false);
			expect(commits).toBe(0);
			await expect(
				captured.ingress.preparation.prepare(
					f.identity.requesterUid,
					{},
					new AbortController().signal,
				),
			).rejects.toThrow("write_gate_closed");
			loggedIn = false;
			const loginContext = await captured.ingress.scope(
				f.identity.requesterUid,
				selection,
				new AbortController().signal,
				"read",
			);
			if (!loginContext) throw Error("missing login scope");
			expect(
				await captured.ingress.readLogin!(
					loginContext,
					"check_login_status",
					new AbortController().signal,
				),
			).toEqual({ loggedIn: false });
			const qr = await captured.ingress.readLogin!(
				loginContext,
				"get_login_qrcode",
				new AbortController().signal,
			);
			expect(qr).toMatchObject({
				loggedIn: false,
				image: expect.stringContaining("data:image/png;base64,"),
			});
			expect(qr).not.toHaveProperty("account");
			expect(qr).not.toHaveProperty("upstream");
			await expect(
				captured.ingress.readFeeds!(context, new AbortController().signal),
			).rejects.toThrow("target_unbound");
			handlers.close();
			return;
		}
		expect(result).toMatchObject({ kind: "attempt", state: "succeeded" });
		expect(accounts).toBe(3);
		expect(commits).toBe(1);
		// The fake provider has completed commit and its cleanup before a new login.
		leased = false;
		accountEpoch++;
		await captured.ingress.scope(
			f.identity.requesterUid,
			selection,
			new AbortController().signal,
			"read",
		);
		await expect(
			captured.ingress.readFeeds!(context, new AbortController().signal),
		).rejects.toThrow("target_unbound");
		await expect(
			captured.provider.token(
				{ frozen: f.frozen, activationId: "activation-a" },
				new AbortController().signal,
			),
		).rejects.toThrow("target_unbound");
		expect(accounts).toBe(4);
		current = false;
		await expect(
			captured.ingress.readFeeds!(context, new AbortController().signal),
		).rejects.toThrow();
		expect(
			await captured.provider.scope(
				f.frozen.proposalId,
				new AbortController().signal,
			),
		).toBeNull();
		current = true;
		handlers.close();
		await expect(
			captured.ingress.readFeeds!(context, new AbortController().signal),
		).rejects.toThrow();
	},
);
