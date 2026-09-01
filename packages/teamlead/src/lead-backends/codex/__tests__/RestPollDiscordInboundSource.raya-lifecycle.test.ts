import { describe, expect, it, vi } from "vitest";
import { InMemoryInboundCursorStore } from "../InboundCursorStore.js";
import { RestPollDiscordInboundSource } from "../RestPollDiscordInboundSource.js";

function response(status: number, body: unknown = []): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

function observer() {
	return {
		pollAttempt: vi.fn(),
		pollResult: vi.fn(),
		messageConsumed: vi.fn(),
	};
}

describe("FLY-2216 RestPoll Raya lifecycle observer", () => {
	it("records attempts separately from results and records consumed cursor durability", async () => {
		const rows = [
			{
				id: "1",
				channel_id: "c1",
				content: "baseline",
				author: { id: "founder", bot: false },
			},
		];
		const fetchImpl = vi.fn(async (url: string) => {
			const after = new URL(url).searchParams.get("after");
			return response(
				200,
				after ? rows.filter((row) => row.id !== after) : [...rows],
			);
		}) as unknown as typeof fetch;
		const lifecycle = observer();
		const cursorStore = new InMemoryInboundCursorStore();
		const source = new RestPollDiscordInboundSource({
			botToken: "token",
			channelIds: ["c1"],
			fetchImpl,
			cursorStore,
			lifecycle,
			setTimer: () => ({ cancel: () => {} }),
		});
		source.onMessage(() => true);

		await source.start();
		rows.push({
			id: "2",
			channel_id: "c1",
			content: "new",
			author: { id: "founder", bot: false },
		});
		await source.pollOnce();

		expect(lifecycle.pollAttempt).toHaveBeenNthCalledWith(1, "c1");
		expect(lifecycle.pollAttempt).toHaveBeenNthCalledWith(2, "c1");
		expect(lifecycle.pollResult).toHaveBeenNthCalledWith(1, {
			ok: true,
			channelId: "c1",
		});
		expect(lifecycle.pollResult).toHaveBeenNthCalledWith(2, {
			ok: true,
			channelId: "c1",
		});
		expect(lifecycle.messageConsumed).toHaveBeenCalledWith({
			channelId: "c1",
			messageId: "2",
			cursorPersisted: true,
		});
	});

	it.each([
		[401, "auth"],
		[403, "auth"],
		[429, "rate_limit"],
		[503, "server"],
		[418, "unknown"],
	] as const)(
		"classifies HTTP %s as %s without parsing error text",
		async (status, failureClass) => {
			const lifecycle = observer();
			const source = new RestPollDiscordInboundSource({
				botToken: "token",
				channelIds: ["c1"],
				fetchImpl: vi.fn(async () =>
					response(status),
				) as unknown as typeof fetch,
				lifecycle,
				setTimer: () => ({ cancel: () => {} }),
			});

			await expect(source.start()).resolves.toBeUndefined();
			expect(lifecycle.pollAttempt).toHaveBeenCalledWith("c1");
			expect(lifecycle.pollResult).toHaveBeenCalledWith({
				ok: false,
				channelId: "c1",
				failureClass,
				status,
			});
		},
	);

	it.each([
		[new TypeError("fetch failed"), "network"],
		[new Error("unexpected adapter failure"), "unknown"],
	] as const)("classifies thrown %s as %s", async (failure, failureClass) => {
		const lifecycle = observer();
		const source = new RestPollDiscordInboundSource({
			botToken: "token",
			channelIds: ["c1"],
			fetchImpl: vi.fn(async () => {
				throw failure;
			}) as unknown as typeof fetch,
			lifecycle,
			setTimer: () => ({ cancel: () => {} }),
		});

		await source.start();
		expect(lifecycle.pollResult).toHaveBeenCalledWith({
			ok: false,
			channelId: "c1",
			failureClass,
		});
	});

	it("observer exceptions and cursor persistence failures remain fail-soft", async () => {
		const rows = [
			{
				id: "1",
				channel_id: "c1",
				content: "new",
				author: { id: "founder", bot: false },
			},
		];
		const lifecycle = {
			pollAttempt: vi.fn(() => {
				throw new Error("observer unavailable");
			}),
			pollResult: vi.fn(),
			messageConsumed: vi.fn(),
		};
		const cursorStore = {
			load: () => "0",
			save: () => {
				throw new Error("disk full");
			},
		};
		const source = new RestPollDiscordInboundSource({
			botToken: "token",
			channelIds: ["c1"],
			fetchImpl: vi.fn(async () =>
				response(200, rows),
			) as unknown as typeof fetch,
			cursorStore,
			lifecycle,
			setTimer: () => ({ cancel: () => {} }),
		});
		source.onMessage(() => true);

		await expect(source.start()).resolves.toBeUndefined();
		expect(lifecycle.messageConsumed).toHaveBeenCalledWith({
			channelId: "c1",
			messageId: "1",
			cursorPersisted: false,
		});
	});
});
