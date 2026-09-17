import { afterEach, expect, it, vi } from "vitest";
import { XhsReadResources } from "../read-resources.js";
import { fixture } from "./store-fixture.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
function setup() {
	const f = fixture();
	cleanup.push(() => f.close());
	let current = true,
		calls = 0;
	const resources = new XhsReadResources({
		identity: f.identity,
		activationId: "activation-a",
		upstream: f.frozen.upstream,
		assertCurrent: () => {
			if (!current) throw Error("private-policy-detail");
		},
		provider: {
			read: async () => {
				throw Error("unexpected read");
			},
			readFeeds: async () => {
				calls++;
				return {
					account: f.frozen.account,
					upstream: f.frozen.upstream,
					data: {
						count: 1,
						feeds: [
							{
								id: "feed-a",
								xsec_token: "synthetic-private-token",
								share:
									"https://www.xiaohongshu.com/explore/feed-a?xsec_token=synthetic-private-token",
							},
						],
					},
				};
			},
		},
	});
	return {
		f,
		resources,
		calls: () => calls,
		stale: () => {
			current = false;
		},
	};
}
it("projects real private read results into scoped handles reused by preparation and token resolution", async () => {
	const s = setup();
	const text = await s.resources.readFeeds();
	expect(text).not.toContain("synthetic-private-token");
	const handle = JSON.parse(text).feeds[0].resourceHandle;
	expect(handle).toEqual(expect.any(String));
	expect(s.resources.target(s.f.identity, handle, "activation-a")).toEqual(
		s.f.frozen.target,
	);
	expect(
		s.resources.token({ frozen: s.f.frozen, activationId: "activation-a" }),
	).toBe("synthetic-private-token");
	expect(s.calls()).toBe(1);
	for (const identity of [
		{ ...s.f.identity, projectId: "other" },
		{ ...s.f.identity, accountEpoch: 2 },
	])
		expect(() => s.resources.target(identity, handle, "activation-a")).toThrow(
			"target_unbound",
		);
	expect(() =>
		s.resources.target(s.f.identity, handle, "activation-b"),
	).toThrow("target_unbound");
	expect(() =>
		s.resources.token({ frozen: s.f.frozen, activationId: "activation-b" }),
	).toThrow("target_unbound");
	expect(s.calls()).toBe(1);
});
it("never invents target proof, fetches during a write lease, or restores tokens from frozen content", async () => {
	const s = setup();
	expect(() =>
		s.resources.token({ frozen: s.f.frozen, activationId: "activation-a" }),
	).toThrow("target_unbound");
	expect(s.calls()).toBe(0);
	await s.resources.readFeeds();
	expect(() =>
		s.resources.token({
			frozen: {
				...s.f.frozen,
				target: { feedId: "feed-a", commentId: "unseen", userId: null },
			},
			activationId: "activation-a",
		}),
	).toThrow("target_unbound");
	s.stale();
	await expect(s.resources.readFeeds()).rejects.toThrow("target_unbound");
	expect(() =>
		s.resources.token({ frozen: s.f.frozen, activationId: "activation-a" }),
	).toThrow("target_unbound");
	expect(s.calls()).toBe(1);
});

it("honors cancellation before reading and discards every grant on close", async () => {
	const s = setup();
	const controller = new AbortController();
	controller.abort();
	await expect(s.resources.readFeeds(controller.signal)).rejects.toThrow(
		"target_unbound",
	);
	expect(s.calls()).toBe(0);
	const handle = JSON.parse(await s.resources.readFeeds()).feeds[0]
		.resourceHandle;
	s.resources.close();
	expect(() =>
		s.resources.target(s.f.identity, handle, "activation-a"),
	).toThrow("target_unbound");
	expect(() =>
		s.resources.token({ frozen: s.f.frozen, activationId: "activation-a" }),
	).toThrow("target_unbound");
	await expect(s.resources.readFeeds()).rejects.toThrow("target_unbound");
	expect(s.calls()).toBe(1);
});

it("projects search and collection reads with grants only for actual feed rows", async () => {
	const f = fixture();
	cleanup.push(() => f.close());
	let data: unknown;
	const read = vi.fn(async (..._args: unknown[]) => ({
		account: f.frozen.account,
		upstream: f.frozen.upstream,
		data,
	}));
	const resources = new XhsReadResources({
		identity: f.identity,
		activationId: "activation-a",
		upstream: f.frozen.upstream,
		assertCurrent: () => {},
		provider: {
			read,
			readFeeds: async () => {
				throw Error("unexpected fallback");
			},
		},
	});
	for (const operation of [
		"search_feeds",
		"list_saved_content",
		"get_collection_content",
	] as const) {
		const collection = operation === "get_collection_content";
		data = {
			[collection ? "notes" : "feeds"]: [
				{
					[collection ? "noteId" : "id"]: "feed-a",
					xsecToken: "synthetic-private-token",
					user: { userId: "nested-user", xsecToken: "nested-user-token" },
				},
				{ [collection ? "noteId" : "id"]: "empty", xsecToken: "" },
			],
			count: 2,
			...(collection ? { total: 2 } : {}),
		};
		const input =
			operation === "search_feeds"
				? { keyword: "query" }
				: collection
					? { collection_id: "collection-a" }
					: {};
		const output = await resources.readList(operation, input);
		expect(output).not.toContain("synthetic-private-token");
		expect(output).not.toContain("nested-user-token");
		const rows = JSON.parse(output)[collection ? "notes" : "feeds"];
		expect(
			resources.target(f.identity, rows[0].resourceHandle, "activation-a"),
		).toEqual(f.frozen.target);
		expect(rows[1]).not.toHaveProperty("resourceHandle");
		expect(() =>
			resources.target(f.identity, rows[0].user.resourceHandle, "activation-a"),
		).toThrow("target_unbound");
		expect(read.mock.lastCall?.[1]).toMatchObject({ limit: 20 });
	}
	data = [{ id: "collection-a", name: "saved", total: 1 }];
	expect(JSON.parse(await resources.readList("list_collections", {}))).toEqual(
		data,
	);
	const count = read.mock.calls.length;
	await expect(
		resources.readList("search_feeds", {
			keyword: "q",
			xsec_token: "model-token",
		}),
	).rejects.toThrow("target_unbound");
	await expect(
		resources.readList("get_collection_content", { collection_id: "../other" }),
	).rejects.toThrow("target_unbound");
	expect(read).toHaveBeenCalledTimes(count);
	resources.close();
	await expect(resources.readList("list_saved_content", {})).rejects.toThrow(
		"target_unbound",
	);
	expect(read).toHaveBeenCalledTimes(count);
});

it.each(["account", "provider", "count", "cancel", "stale"])(
	"rejects %s changes after private list reads without registering targets",
	async (failure) => {
		const f = fixture();
		cleanup.push(() => f.close());
		const controller = new AbortController();
		let current = true;
		const resources = new XhsReadResources({
			identity: f.identity,
			activationId: "activation-a",
			upstream: f.frozen.upstream,
			assertCurrent: () => {
				if (!current) throw Error("stale");
			},
			provider: {
				readFeeds: async () => {
					throw Error("unexpected fallback");
				},
				read: async () => {
					if (failure === "cancel") controller.abort();
					if (failure === "stale") current = false;
					return {
						account: {
							...f.frozen.account,
							...(failure === "account" ? { accountEpoch: 999 } : {}),
						},
						upstream: {
							...f.frozen.upstream,
							...(failure === "provider" ? { version: "unexpected" } : {}),
						},
						data: {
							feeds: [{ id: "feed-a", xsecToken: "synthetic-private-token" }],
							count: failure === "count" ? 0 : 1,
						},
					};
				},
			},
		});
		await expect(
			resources.readList("list_saved_content", {}, controller.signal),
		).rejects.toThrow("target_unbound");
		current = true;
		expect(() =>
			resources.token({ frozen: f.frozen, activationId: "activation-a" }),
		).toThrow("target_unbound");
	},
);

it.each(["", "refreshed-detail-token"])(
	"uses observed feed handles and binds returned comments with token %s",
	async (detailToken) => {
		const f = fixture();
		cleanup.push(() => f.close());
		let wrongNote = false;
		const read = vi.fn(async (..._args: unknown[]) => ({
			account: f.frozen.account,
			upstream: f.frozen.upstream,
			data: {
				feed_id: "feed-a",
				data: {
					note: {
						noteId: wrongNote ? "other" : "feed-a",
						xsecToken: detailToken,
					},
					comments: {
						list: [
							{
								id: "comment-a",
								noteId: "feed-a",
								userInfo: { userId: "author-a" },
								subComments: [
									{
										id: "reply-a",
										noteId: "feed-a",
										userInfo: { userId: "author-b" },
										subComments: null,
									},
								],
							},
						],
					},
				},
			},
		}));
		const resources = new XhsReadResources({
			identity: f.identity,
			activationId: "activation-a",
			upstream: f.frozen.upstream,
			assertCurrent: () => {},
			provider: {
				read,
				readFeeds: async () => ({
					account: f.frozen.account,
					upstream: f.frozen.upstream,
					data: {
						feeds: [{ id: "feed-a", xsecToken: "private-detail-token" }],
						count: 1,
					},
				}),
			},
		});
		const handle = JSON.parse(await resources.readFeeds()).feeds[0]
			.resourceHandle;
		for (const input of [
			{ feed_id: "other", resourceHandle: handle },
			{ feed_id: "feed-a", resourceHandle: "unseen" },
			{ feed_id: "feed-a", resourceHandle: handle, xsec_token: "forged" },
		])
			await expect(resources.readDetail(input)).rejects.toThrow(
				"target_unbound",
			);
		expect(read).not.toHaveBeenCalled();
		const text = await resources.readDetail({
			feed_id: "feed-a",
			resourceHandle: handle,
		});
		expect(text).not.toContain("private-detail-token");
		expect(read.mock.lastCall?.[1]).toMatchObject({
			feed_id: "feed-a",
			xsec_token: "private-detail-token",
			limit: 20,
		});
		expect(read.mock.lastCall?.[1]).not.toHaveProperty("resourceHandle");
		expect(
			resources.target(
				f.identity,
				JSON.parse(text).data.note.resourceHandle,
				"activation-a",
			),
		).toEqual(f.frozen.target);
		if (!detailToken)
			expect(JSON.parse(text).data.note.resourceHandle).toBe(handle);
		const comment = JSON.parse(text).data.comments.list[0];
		const target = resources.target(
			f.identity,
			comment.resourceHandle,
			"activation-a",
		);
		expect(target).toEqual({
			feedId: "feed-a",
			commentId: "comment-a",
			userId: "author-a",
		});
		expect(
			resources.target(
				f.identity,
				comment.subComments[0].resourceHandle,
				"activation-a",
			),
		).toEqual({ feedId: "feed-a", commentId: "reply-a", userId: "author-b" });
		expect(
			resources.token({
				frozen: { ...f.frozen, target },
				activationId: "activation-a",
			}),
		).toBe(detailToken || "private-detail-token");
		expect(() =>
			resources.token({
				frozen: { ...f.frozen, target: { ...target!, userId: "other" } },
				activationId: "activation-a",
			}),
		).toThrow("target_unbound");
		wrongNote = true;
		await expect(
			resources.readDetail({ feed_id: "feed-a", resourceHandle: handle }),
		).rejects.toThrow("target_unbound");
		resources.close();
		expect(() =>
			resources.target(f.identity, comment.resourceHandle, "activation-a"),
		).toThrow("target_unbound");
	},
);

it.each(["foreign-comment", "malformed", "account", "cancel"])(
	"never registers detail comment grants after %s failure",
	async (failure) => {
		const f = fixture();
		cleanup.push(() => f.close());
		const controller = new AbortController();
		const resources = new XhsReadResources({
			identity: f.identity,
			activationId: "activation-a",
			upstream: f.frozen.upstream,
			assertCurrent: () => {},
			provider: {
				readFeeds: async () => ({
					account: f.frozen.account,
					upstream: f.frozen.upstream,
					data: {
						feeds: [{ id: "feed-a", xsecToken: "private-detail-token" }],
						count: 1,
					},
				}),
				read: async () => {
					if (failure === "cancel") controller.abort();
					const comment = {
						id: "comment-a",
						noteId: "feed-a",
						userInfo: { userId: "author-a" },
						subComments: null,
					};
					return {
						account: {
							...f.frozen.account,
							...(failure === "account" ? { accountEpoch: 999 } : {}),
						},
						upstream: f.frozen.upstream,
						data: {
							feed_id: "feed-a",
							data: {
								note: { noteId: "feed-a", xsecToken: "" },
								comments: {
									list: [
										comment,
										{
											...comment,
											id: failure === "malformed" ? "" : "second",
											noteId:
												failure === "foreign-comment" ? "foreign" : "feed-a",
										},
									],
								},
							},
						},
					};
				},
			},
		});
		const handle = JSON.parse(await resources.readFeeds()).feeds[0]
			.resourceHandle;
		await expect(
			resources.readDetail(
				{ feed_id: "feed-a", resourceHandle: handle },
				controller.signal,
			),
		).rejects.toThrow("target_unbound");
		expect(() =>
			resources.token({
				frozen: {
					...f.frozen,
					target: {
						feedId: "feed-a",
						commentId: "comment-a",
						userId: "author-a",
					},
				},
				activationId: "activation-a",
			}),
		).toThrow("target_unbound");
		expect(
			resources.token({ frozen: f.frozen, activationId: "activation-a" }),
		).toBe("private-detail-token");
	},
);
