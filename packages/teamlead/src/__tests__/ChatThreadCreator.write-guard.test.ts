import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChatThreadContext,
	ChatThreadCreator,
} from "../bridge/ChatThreadCreator.js";
import { StateStore } from "../StateStore.js";

let store: StateStore, creator: ChatThreadCreator;
const fetchMock = vi.fn();
beforeEach(async () => {
	store = await StateStore.create(":memory:");
	creator = new ChatThreadCreator(store);
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function context() {
	let revoked = false;
	const controller = new AbortController();
	return {
		revoke: () => {
			revoked = true;
			controller.abort();
		},
		ctx: {
			chatChannelId: "channel",
			issueId: "FLY-1",
			issueIdentifier: "FLY-1",
			botToken: "token",
			signal: controller.signal,
			beforeSideEffect: async () => {
				if (revoked) throw new Error("private_authority_error");
			},
		} satisfies ChatThreadContext,
	};
}
const response = (id = "root") => ({
	ok: true,
	status: 200,
	json: async () => ({ id, type: 11, parent_id: "channel" }),
});
describe("opt-in ensureChatThread write guards", () => {
	it("revocation after root POST prevents canonical registration, start and cleanup", async () => {
		const f = context();
		const claim = vi.spyOn(store, "registerChatThreadConditional");
		fetchMock.mockImplementation(async () => {
			f.revoke();
			return response();
		});
		await expect(creator.ensureChatThread(f.ctx)).rejects.toThrow(
			"chat_thread_side_effect_denied",
		);
		expect(claim).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("guards cleanup DELETE following a canonical conflict", async () => {
		const f = context();
		fetchMock.mockResolvedValue(response());
		vi.spyOn(store, "registerChatThreadConditional").mockImplementation(() => {
			f.revoke();
			return { status: "canonical_exists", threadId: "other" };
		});
		await expect(creator.ensureChatThread(f.ctx)).rejects.toThrow(
			"chat_thread_side_effect_denied",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
	it("rechecks before the recovery start retry after its asynchronous probes", async () => {
		const f = context();
		store.upsertChatThread("root", "channel", "FLY-1");
		fetchMock
			.mockResolvedValueOnce({ ok: false, status: 404 })
			.mockResolvedValueOnce(response())
			.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "" })
			.mockResolvedValueOnce({ ok: false, status: 404 })
			.mockImplementationOnce(async () => {
				f.revoke();
				return response();
			});
		await expect(creator.ensureChatThread(f.ctx)).rejects.toThrow(
			"chat_thread_side_effect_denied",
		);
		expect(
			fetchMock.mock.calls.filter((call) => call[1]?.method === "POST"),
		).toHaveLength(1);
	});
	it("guards backfill PATCH and notification POST after reuse reads", async () => {
		for (const backfill of [true, false]) {
			const f = context();
			store.upsertChatThread("root", "channel", "FLY-1");
			fetchMock.mockReset();
			fetchMock.mockImplementationOnce(async () => {
				if (!backfill) f.revoke();
				return response();
			});
			if (backfill)
				fetchMock.mockImplementationOnce(async () => ({
					ok: true,
					status: 200,
					json: async () => {
						f.revoke();
						return { name: "[FLY-1] FLY-1" };
					},
				}));
			await expect(
				creator.ensureChatThread({
					...f.ctx,
					...(backfill ? { issueTitle: "Real title" } : {}),
				}),
			).rejects.toThrow("chat_thread_side_effect_denied");
			expect(
				fetchMock.mock.calls.every(
					(call) => (call[1]?.method ?? "GET") === "GET",
				),
			).toBe(true);
		}
	});
	it("guards owner membership after thread start and checks abort after guard resolves", async () => {
		const f = context();
		fetchMock
			.mockResolvedValueOnce(response())
			.mockImplementationOnce(async () => {
				f.revoke();
				return response();
			});
		await expect(
			creator.ensureChatThread({ ...f.ctx, ownerUserId: "owner" }),
		).rejects.toThrow("chat_thread_side_effect_denied");
		expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(
			false,
		);
		const next = context();
		fetchMock.mockReset();
		next.ctx.beforeSideEffect = async () => {
			queueMicrotask(() => next.revoke());
		};
		await expect(
			creator.ensureChatThread({ ...next.ctx, issueId: "FLY-2" }),
		).rejects.toThrow("chat_thread_side_effect_denied");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

it("checks the opt-in guard for each successful root, canonical claim, start and member write", async () => {
	const beforeSideEffect = vi.fn(async () => {});
	fetchMock.mockResolvedValue(response());
	expect(
		await creator.ensureChatThread({
			chatChannelId: "channel",
			issueId: "FLY-1",
			botToken: "token",
			ownerUserId: "owner",
			beforeSideEffect,
		}),
	).toMatchObject({ created: true, threadId: "root" });
	expect(beforeSideEffect).toHaveBeenCalledTimes(4);
	expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
		"POST",
		"POST",
		"PUT",
	]);
});
it("checks abort synchronously at the canonical claim after the asynchronous hook resolves", async () => {
	const f = context();
	let calls = 0;
	f.ctx.beforeSideEffect = async () => {
		if (++calls === 2) queueMicrotask(() => f.revoke());
	};
	fetchMock.mockResolvedValue(response());
	const claim = vi.spyOn(store, "registerChatThreadConditional");
	await expect(creator.ensureChatThread(f.ctx)).rejects.toThrow(
		"chat_thread_side_effect_denied",
	);
	expect(claim).not.toHaveBeenCalled();
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([1, 2])(
	"checks synchronous policy revocation without abort before write %s",
	async (revokeAt) => {
		let revoked = false,
			calls = 0;
		const ctx: ChatThreadContext = {
			chatChannelId: "channel",
			issueId: "FLY-1",
			botToken: "token",
			beforeSideEffect: async () => {
				if (++calls === revokeAt)
					queueMicrotask(() => {
						revoked = true;
					});
			},
			assertSideEffectCurrent: () => {
				if (revoked) throw new Error("private_policy_detail");
			},
		};
		fetchMock.mockResolvedValue(response());
		const claim = vi.spyOn(store, "registerChatThreadConditional");
		await expect(creator.ensureChatThread(ctx)).rejects.toThrow(
			"chat_thread_side_effect_denied",
		);
		expect(claim).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(revokeAt - 1);
	},
);
it("honors a synchronous-only guard without requiring an asynchronous hook or abort signal", async () => {
	fetchMock.mockResolvedValue(response());
	await expect(
		creator.ensureChatThread({
			chatChannelId: "channel",
			issueId: "FLY-1",
			botToken: "token",
			assertSideEffectCurrent: () => {
				throw new Error("revoked");
			},
		}),
	).rejects.toThrow("chat_thread_side_effect_denied");
	expect(fetchMock).not.toHaveBeenCalled();
});

it("publishes exact successful canonical root synchronously before starting the thread", async () => {
	const observe = vi.fn((threadId: string) => {
		expect(threadId).toBe("root");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(store.getChatThreadByIssue("FLY-1", "channel")?.thread_id).toBe(
			"root",
		);
	});
	fetchMock.mockResolvedValue(response());
	await creator.ensureChatThread({
		chatChannelId: "channel",
		issueId: "FLY-1",
		botToken: "token",
		onCanonicalThreadRegistered: observe,
	});
	expect(observe).toHaveBeenCalledExactlyOnceWith("root");
});
it("does not publish canonical provenance for competing or existing claims", async () => {
	const observe = vi.fn();
	fetchMock.mockResolvedValue(response());
	vi.spyOn(store, "registerChatThreadConditional").mockReturnValue({
		status: "canonical_exists",
		threadId: "other",
	});
	await creator.ensureChatThread({
		chatChannelId: "channel",
		issueId: "FLY-1",
		botToken: "token",
		onCanonicalThreadRegistered: observe,
	});
	expect(observe).not.toHaveBeenCalled();
	store.upsertChatThread("root", "channel", "FLY-1");
	await creator.ensureChatThread({
		chatChannelId: "channel",
		issueId: "FLY-1",
		botToken: "token",
		onCanonicalThreadRegistered: observe,
	});
	expect(observe).not.toHaveBeenCalled();
});
it("fails closed without cleanup or recovery when the canonical observer rejects publication", async () => {
	fetchMock.mockResolvedValue(response());
	await expect(
		creator.ensureChatThread({
			chatChannelId: "channel",
			issueId: "FLY-1",
			botToken: "token",
			onCanonicalThreadRegistered: () => {
				throw new Error("private_binding_detail");
			},
		}),
	).rejects.toThrow("chat_thread_side_effect_denied");
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(store.getChatThreadByIssue("FLY-1", "channel")?.thread_id).toBe(
		"root",
	);
});
