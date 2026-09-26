import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordActiveThread } from "../discord-guild-active-threads.js";
import {
	describeIdleThreadSweepDenial,
	IDLE_THREAD_SWEEP_DENIED_ALERT_DEBOUNCE_MS,
	IDLE_THREAD_SWEEP_SCHEDULER_CONFIG,
	makeIdleThreadArchiveSweep,
	resolveIdleThreadSweepChannelIds,
	resolveIdleThreadSweepGroups,
	resolveQaIdleThreadSweepIdentity,
	resolveQaTestingCategoryId,
} from "../idle-thread-archive-sweep.js";

const DISCORD_EPOCH_MS = 1_420_070_400_000;
const NOW = Date.UTC(2026, 8, 2, 20, 0, 0);

function snowflakeAt(ms: number): string {
	return (BigInt(ms - DISCORD_EPOCH_MS) << 22n).toString();
}

function thread(
	id: string,
	parentId: string,
	ageMinutes: number,
	autoArchiveDuration = 60,
): DiscordActiveThread {
	return {
		id,
		parent_id: parentId,
		last_message_id: snowflakeAt(NOW - ageMinutes * 60_000),
		thread_metadata: {
			archived: false,
			auto_archive_duration: autoArchiveDuration,
		},
	};
}

function response(status: number, body: unknown = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("resolveIdleThreadSweepChannelIds", () => {
	it("returns trimmed, deduplicated configured channel ids", () => {
		expect(resolveIdleThreadSweepChannelIds({})).toEqual([]);
		expect(
			resolveIdleThreadSweepChannelIds({
				FLYWHEEL_ROUNDTABLE_CHANNEL_ID: " roundtable ",
				FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "roundtable",
			}),
		).toEqual(["roundtable"]);
	});

	it("exposes a typed constant adapter for the shared scheduler", () => {
		expect(IDLE_THREAD_SWEEP_SCHEDULER_CONFIG).toEqual({
			enabled: true,
			intervalMin: 10,
			dryRun: false,
			maxArchivesPerRun: 25,
			maxCandidatesPerRun: 25,
			runDeadlineMs: 60_000,
		});
	});
});

describe("resolveQaTestingCategoryId", () => {
	it("uses only a valid test-slots category for the infra bot guild and fails closed otherwise", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2916-"));
		const path = join(dir, "test-slots.json");
		const guildId = snowflakeAt(NOW - 100 * 60 * 60_000);
		const categoryId = snowflakeAt(NOW - 90 * 60 * 60_000);
		const log = vi.fn();
		try {
			expect(resolveQaTestingCategoryId(guildId, path, log)).toBeUndefined();
			writeFileSync(path, JSON.stringify({ guildId, categoryId }));
			expect(resolveQaTestingCategoryId(guildId, path, log)).toBe(categoryId);
			expect(
				resolveQaTestingCategoryId("another-guild", path, log),
			).toBeUndefined();
			for (const invalid of [
				"{",
				"null",
				"[]",
				JSON.stringify({ guildId, categoryId: "bad" }),
				JSON.stringify({ categoryId }),
			]) {
				writeFileSync(path, invalid);
				expect(resolveQaTestingCategoryId(guildId, path, log)).toBeUndefined();
			}
			expect(log).toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("makeIdleThreadArchiveSweep", () => {
	it("archives new and legacy QA threads after the last message reaches one hour", async () => {
		const categoryId = snowflakeAt(NOW - 50 * 60 * 60_000);
		const qaChannelId = snowflakeAt(NOW - 40 * 60 * 60_000);
		const qaChannels = Array.from({ length: 7 }, (_, index) =>
			snowflakeAt(NOW - (40 + index) * 60 * 60_000),
		);
		const threads = qaChannels.map((parentId, index) =>
			thread(
				snowflakeAt(NOW - (index + 3) * 60 * 60_000),
				parentId,
				60,
				[60, 1440, 4320][index % 3],
			),
		);
		// Changing the old archive duration must not restart the QA message clock.
		threads[2]!.thread_metadata!.archive_timestamp = new Date(
			NOW,
		).toISOString();
		threads.push(
			thread(snowflakeAt(NOW - 16 * 60 * 60_000), qaChannelId, 59.99, 4320),
		);
		threads.push(
			thread(snowflakeAt(NOW - 17 * 60 * 60_000), "roundtable", 61, 4320),
		);
		threads.push(
			thread(snowflakeAt(NOW - 18 * 60 * 60_000), "outside", 120, 60),
		);
		const patches: Array<{ id: string; body: unknown }> = [];
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/guilds/guild/channels"))
				return response(200, [
					...qaChannels.map((id) => ({ id, parent_id: categoryId, type: 0 })),
					{ id: "outside", parent_id: "another-category", type: 0 },
				]);
			if (url.endsWith("/threads/active")) return response(200, { threads });
			const id = url.split("/").at(-1)!;
			if (qaChannels.includes(id))
				return response(200, { id, parent_id: categoryId, type: 0 });
			const found = threads.find((item) => item.id === id)!;
			if ((init?.method ?? "GET") === "GET") return response(200, found);
			expect(init?.method).toBe("PATCH");
			patches.push({ id, body: JSON.parse(init?.body as string) });
			return response(200, { ...found, thread_metadata: { archived: true } });
		}) as typeof fetch;
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			qaTestingCategoryId: categoryId,
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		});
		// The QA group never scans production channels: those belong to the
		// separately-scheduled production sweep and its own identity.
		expect(await sweep.runOnce()).toMatchObject({
			scanned: 8,
			archived: 7,
			skippedNotIdle: 1,
		});
		expect(patches).toEqual(
			threads.slice(0, 7).map(({ id }) => ({ id, body: { archived: true } })),
		);
	});

	it("rechecks QA messages before archive and discovers category changes on later runs", async () => {
		const categoryId = snowflakeAt(NOW - 50 * 60 * 60_000);
		const qaChannelId = snowflakeAt(NOW - 40 * 60 * 60_000);
		const candidate = thread(
			snowflakeAt(NOW - 3 * 60 * 60_000),
			qaChannelId,
			120,
			4320,
		);
		let inQaCategory = true;
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			expect(init?.method ?? "GET").toBe("GET");
			if (url.endsWith("/guilds/guild/channels"))
				return response(200, [
					{
						id: qaChannelId,
						parent_id: inQaCategory ? categoryId : "production",
						type: 0,
					},
				]);
			if (url.endsWith("/threads/active"))
				return response(200, { threads: [candidate] });
			return response(200, { ...candidate, last_message_id: snowflakeAt(NOW) });
		}) as typeof fetch;
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			qaTestingCategoryId: categoryId,
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		});
		expect(await sweep.runOnce()).toMatchObject({
			scanned: 1,
			archived: 0,
			skippedNotIdle: 1,
		});
		inQaCategory = false;
		expect(await sweep.runOnce()).toMatchObject({ scanned: 0, archived: 0 });
	});

	it.each([401, 403, 429, 500, 200])(
		"ends the QA pass on discovery failure %s without listing threads",
		async (status) => {
			const categoryId = snowflakeAt(NOW - 50 * 60 * 60_000);
			let currentNow = NOW;
			const onDenied = vi.fn();
			const fetchImpl = vi.fn(async (url: string) =>
				url.endsWith("/guilds/guild/channels")
					? response(status, { retry_after: 60 })
					: response(200, { threads: [] }),
			) as typeof fetch;
			const sweep = makeIdleThreadArchiveSweep({
				identity: { botToken: "token", guildId: "guild" },
				qaTestingCategoryId: categoryId,
				onDenied,
				fetchImpl,
				now: () => currentNow,
				sleepImpl: async () => {},
				log: () => {},
			});
			const result = await sweep.runOnce();
			expect(result.archived).toBe(0);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			if (status === 401 || status === 403) {
				currentNow += 10 * 60_000;
				await sweep.runOnce();
				expect(onDenied).toHaveBeenCalledTimes(1);
				expect(onDenied).toHaveBeenCalledWith({
					status,
					context: "QA category discovery",
					...(status === 403 ? { channelId: categoryId } : {}),
				});
			}
			if (status === 429) {
				expect(result.notBeforeSet).toBe(true);
				await sweep.runOnce();
				expect(fetchImpl).toHaveBeenCalledTimes(1);
			}
			if (status === 500) expect(result.transient).toBe(1);
			if (status === 200) expect(result.clientError).toBe(1);
		},
	);

	it("reuses a QA fixture after new activity, survives restart, and rolls back to its original policy", async () => {
		const categoryId = snowflakeAt(NOW - 50 * 60 * 60_000);
		const qaChannelId = snowflakeAt(NOW - 40 * 60 * 60_000);
		const candidate = thread(
			snowflakeAt(NOW - 3 * 60 * 60_000),
			qaChannelId,
			120,
			4320,
		);
		let currentNow = NOW;
		let patches = 0;
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/guilds/guild/channels"))
				return response(200, [
					null,
					{ id: qaChannelId, parent_id: categoryId, type: 0 },
					{ id: "bad", parent_id: categoryId, type: 0 },
				]);
			if (url.endsWith("/threads/active"))
				return response(200, { threads: [candidate] });
			if (init?.method === "PATCH") {
				expect(JSON.parse(init.body as string)).toEqual({ archived: true });
				candidate.thread_metadata!.archived = true;
				patches += 1;
			}
			return response(200, candidate);
		}) as typeof fetch;
		const create = (enabled = true) =>
			makeIdleThreadArchiveSweep({
				identity: { botToken: "token", guildId: "guild" },
				...(enabled ? { qaTestingCategoryId: categoryId } : { channelIds: [] }),
				fetchImpl,
				now: () => currentNow,
				sleepImpl: async () => {},
				log: () => {},
			});
		expect((await create().runOnce()).archived).toBe(1);
		expect((await create().runOnce()).alreadyArchived).toBe(1);
		// Discord delivers the reused fixture as active after the new message.
		candidate.thread_metadata!.archived = false;
		candidate.last_message_id = snowflakeAt(NOW);
		currentNow += 59 * 60_000;
		expect((await create().runOnce()).skippedNotIdle).toBe(1);
		currentNow += 60_000;
		expect((await create(false).runOnce()).scanned).toBe(0);
		expect((await create().runOnce()).archived).toBe(1);
		expect(patches).toBe(2);
		expect(candidate.thread_metadata!.auto_archive_duration).toBe(4320);
	});

	it("archives only configured idle threads and sends the one-field PATCH", async () => {
		const idle = thread(snowflakeAt(NOW - 180 * 60_000), "roundtable", 61);
		const fresh = thread(snowflakeAt(NOW - 20 * 60_000), "roundtable", 20);
		const outside = thread(snowflakeAt(NOW - 190 * 60_000), "elsewhere", 120);
		const requests: Array<{ method: string; url: string; body?: string }> = [];
		const all = [idle, fresh, outside];
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			requests.push({
				method,
				url,
				...(typeof init?.body === "string" ? { body: init.body } : {}),
			});
			if (url.endsWith("/guilds/guild/threads/active")) {
				return response(200, { threads: all });
			}
			const id = url.match(/\/channels\/(.+)$/)?.[1];
			if (method === "GET")
				return response(
					200,
					all.find((item) => item.id === id),
				);
			return response(200, {
				...all.find((item) => item.id === id),
				thread_metadata: { archived: true },
			});
		}) as typeof fetch;
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		});

		const result = await sweep.runOnce();

		expect(result.scanned).toBe(2);
		expect(result.archived).toBe(1);
		expect(result.skippedNotIdle).toBe(1);
		expect(requests.filter((request) => request.method === "PATCH")).toEqual([
			expect.objectContaining({ body: '{"archived":true}' }),
		]);
	});

	it("classifies PATCH outcomes and continues after per-thread client errors", async () => {
		const threads = Array.from({ length: 5 }, (_, index) =>
			thread(snowflakeAt(NOW - (index + 3) * 60 * 60_000), "roundtable", 120),
		);
		const patchResponses = [
			response(404),
			response(400, { code: 50083 }),
			response(200, { ...threads[2], thread_metadata: { archived: false } }),
			response(400, { code: 12345 }),
			response(200, { ...threads[4], thread_metadata: { archived: true } }),
		];
		let patchIndex = 0;
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			if (url.endsWith("/threads/active")) return response(200, { threads });
			const id = url.match(/\/channels\/(.+)$/)?.[1];
			if (method === "GET") {
				return response(
					200,
					threads.find((item) => item.id === id),
				);
			}
			return patchResponses[patchIndex++] ?? response(500);
		}) as typeof fetch;
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		});

		expect(await sweep.runOnce()).toMatchObject({
			archived: 1,
			benignMissing: 1,
			alreadyArchived: 1,
			clientError: 1,
			transient: 1,
		});
		expect(patchIndex).toBe(5);
	});

	it("honors a 429 not-before across runs", async () => {
		let currentNow = NOW;
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "0.01",
					},
				}),
			)
			.mockResolvedValue(response(200, { threads: [] }));
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => currentNow,
			log: () => {},
		});

		expect(await sweep.runOnce()).toMatchObject({ notBeforeSet: true });
		expect(await sweep.runOnce()).toMatchObject({ notBeforeSet: false });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		currentNow += 10;
		await sweep.runOnce();
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("alerts once per list-level permission-denied episode", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(403))
			.mockResolvedValueOnce(response(403))
			.mockResolvedValueOnce(response(403))
			.mockResolvedValueOnce(response(200, { threads: [] }))
			.mockResolvedValueOnce(response(403));
		const onDenied = vi.fn();
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			onDenied,
			log: () => {},
		});

		for (let index = 0; index < 5; index += 1) await sweep.runOnce();

		expect(onDenied).toHaveBeenCalledTimes(2);
		expect(onDenied).toHaveBeenNthCalledWith(1, {
			status: 403,
			context: "active-thread discovery",
		});
	});

	it("keeps a thread-level denial latched until a PATCH succeeds", async () => {
		const candidate = thread(
			snowflakeAt(NOW - 3 * 60 * 60_000),
			"roundtable",
			120,
		);
		const patchStatuses = [403, 403, 403, 200, 403];
		let patchIndex = 0;
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/threads/active")) {
				return response(200, { threads: [candidate] });
			}
			if ((init?.method ?? "GET") === "GET") return response(200, candidate);
			const status = patchStatuses[patchIndex++] ?? 500;
			return response(
				status,
				status === 200
					? { ...candidate, thread_metadata: { archived: true } }
					: {},
			);
		}) as typeof fetch;
		const onDenied = vi.fn();
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			onDenied,
			log: () => {},
		});

		for (let index = 0; index < 5; index += 1) await sweep.runOnce();

		expect(onDenied).toHaveBeenCalledTimes(2);
		expect(onDenied).toHaveBeenNthCalledWith(1, {
			status: 403,
			context: "thread PATCH",
		});
	});

	it.each(["GET", "PATCH"] as const)(
		"continues past a thread-level %s denial",
		async (deniedMethod) => {
			const denied = thread(
				snowflakeAt(NOW - 3 * 60 * 60_000),
				"roundtable",
				120,
			);
			const archivable = thread(
				snowflakeAt(NOW - 4 * 60 * 60_000),
				"roundtable",
				120,
			);
			const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
				if (url.endsWith("/threads/active")) {
					return response(200, { threads: [denied, archivable] });
				}
				const method = init?.method ?? "GET";
				const id = url.match(/\/channels\/(.+)$/)?.[1];
				if (id === denied.id && method === deniedMethod) return response(403);
				const found = id === denied.id ? denied : archivable;
				return method === "GET"
					? response(200, found)
					: response(200, {
							...found,
							thread_metadata: { archived: true },
						});
			}) as typeof fetch;

			const onDenied = vi.fn();
			const sweep = makeIdleThreadArchiveSweep({
				identity: { botToken: "token", guildId: "guild" },
				channelIds: ["roundtable"],
				fetchImpl,
				now: () => NOW,
				sleepImpl: async () => {},
				onDenied,
				log: () => {},
			});

			const result = await sweep.runOnce();
			expect(result).toMatchObject({ denied: 1, archived: 1 });
			await sweep.runOnce();
			expect(onDenied).toHaveBeenCalledTimes(1);
		},
	);

	it("alerts once for each distinct thread denied with 403", async () => {
		const threads = [
			thread(snowflakeAt(NOW - 3 * 60 * 60_000), "roundtable", 120),
			thread(snowflakeAt(NOW - 4 * 60 * 60_000), "roundtable", 120),
		];
		const fetchImpl = vi.fn(async (url: string) =>
			url.endsWith("/threads/active")
				? response(200, { threads })
				: response(403),
		) as typeof fetch;
		const onDenied = vi.fn();
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			onDenied,
			log: () => {},
		});

		await sweep.runOnce();
		await sweep.runOnce();

		expect(onDenied).toHaveBeenCalledTimes(2);
	});

	it("ends the pass and sets not-before when a thread PATCH is rate-limited", async () => {
		const threads = [
			thread(snowflakeAt(NOW - 3 * 60 * 60_000), "roundtable", 120),
			thread(snowflakeAt(NOW - 4 * 60 * 60_000), "roundtable", 120),
		];
		let patchCalls = 0;
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/threads/active")) return response(200, { threads });
			if ((init?.method ?? "GET") === "GET") {
				const id = url.match(/\/channels\/(.+)$/)?.[1];
				return response(
					200,
					threads.find((item) => item.id === id),
				);
			}
			patchCalls += 1;
			return new Response("{}", {
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "10" },
			});
		}) as typeof fetch;
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		});

		expect(await sweep.runOnce()).toMatchObject({
			notBeforeSet: true,
			transient: 1,
		});
		expect(patchCalls).toBe(1);
	});

	it("uses the JSON retry_after when the PATCH has no header", async () => {
		let currentNow = NOW;
		const candidate = thread(
			snowflakeAt(NOW - 3 * 60 * 60_000),
			"roundtable",
			120,
		);
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/threads/active")) {
				return response(200, { threads: [candidate] });
			}
			if ((init?.method ?? "GET") === "GET") return response(200, candidate);
			return response(429, { retry_after: 2 });
		}) as typeof fetch;
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => currentNow,
			sleepImpl: async () => {},
			log: () => {},
		});

		await sweep.runOnce();
		const callsAfterFirstRun = fetchImpl.mock.calls.length;
		currentNow += 1_999;
		await sweep.runOnce();
		expect(fetchImpl).toHaveBeenCalledTimes(callsAfterFirstRun);
		currentNow += 1;
		await sweep.runOnce();
		expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirstRun);
	});

	it("bounds a hung fresh-thread request with an AbortSignal", async () => {
		vi.useFakeTimers();
		const candidate = thread(
			snowflakeAt(NOW - 3 * 60 * 60_000),
			"roundtable",
			120,
		);
		let freshHadSignal = false;
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/threads/active")) {
				return response(200, { threads: [candidate] });
			}
			freshHadSignal = init?.signal instanceof AbortSignal;
			if (!init?.signal) throw new Error("missing AbortSignal");
			return await new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				});
			});
		}) as typeof fetch;
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		});

		const pending = sweep.runOnce();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await pending).toMatchObject({ transient: 1 });
		expect(freshHadSignal).toBe(true);
	});

	it("keeps the request timeout armed while reading the response body", async () => {
		vi.useFakeTimers();
		const candidate = thread(
			snowflakeAt(NOW - 3 * 60 * 60_000),
			"roundtable",
			120,
		);
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/threads/active")) {
				return response(200, { threads: [candidate] });
			}
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				json: () =>
					new Promise<unknown>((resolve, reject) => {
						const timer = setTimeout(
							() =>
								resolve({
									...candidate,
									last_message_id: snowflakeAt(NOW - 5 * 60_000),
								}),
							6_000,
						);
						init?.signal?.addEventListener("abort", () => {
							clearTimeout(timer);
							const error = new Error("aborted");
							error.name = "AbortError";
							reject(error);
						});
					}),
			} as Response;
		}) as typeof fetch;
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		});
		let settled = false;
		const pending = sweep.runOnce().then((result) => {
			settled = true;
			return result;
		});

		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5_000);
		const settledAtDeadline = settled;
		await vi.advanceTimersByTimeAsync(1_000);
		await pending;
		expect(settledAtDeadline).toBe(true);
	});

	it("fails safe on invalid policies, missing clocks, future clocks, and recent unarchives", async () => {
		const threads = [
			thread(snowflakeAt(NOW - 2 * 60 * 60_000), "roundtable", 120, 17),
			{
				...thread(snowflakeAt(NOW - 3 * 60 * 60_000), "roundtable", 120),
				last_message_id: null,
			},
			{
				...thread(snowflakeAt(NOW - 4 * 60 * 60_000), "roundtable", 120),
				last_message_id: snowflakeAt(NOW + 60_000),
			},
			{
				...thread(snowflakeAt(NOW - 5 * 60 * 60_000), "roundtable", 120),
				thread_metadata: {
					archived: false,
					auto_archive_duration: 60,
					archive_timestamp: new Date(NOW - 5 * 60_000).toISOString(),
				},
			},
		];
		const fetchImpl = vi.fn(async () =>
			response(200, { threads }),
		) as typeof fetch;
		const result = await makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			log: () => {},
		}).runOnce();
		expect(result).toMatchObject({
			skippedNoPolicy: 1,
			skippedNoClock: 1,
			skippedNotIdle: 2,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("rechecks fresh state before writing", async () => {
		const snapshot = Array.from({ length: 4 }, (_, index) =>
			thread(snowflakeAt(NOW - (index + 3) * 60 * 60_000), "roundtable", 120),
		);
		const fresh = new Map<string, Response>([
			[
				snapshot[0]!.id,
				response(200, {
					...snapshot[0],
					last_message_id: snowflakeAt(NOW - 5 * 60_000),
				}),
			],
			[
				snapshot[1]!.id,
				response(200, {
					...snapshot[1],
					thread_metadata: { archived: true, auto_archive_duration: 60 },
				}),
			],
			[snapshot[2]!.id, response(404)],
			[snapshot[3]!.id, response(200, { ...snapshot[3], parent_id: "moved" })],
		]);
		const fetchImpl = vi.fn(async (url: string) =>
			url.endsWith("/threads/active")
				? response(200, { threads: snapshot })
				: (fresh.get(url.match(/\/channels\/(.+)$/)?.[1] ?? "") ??
					response(500)),
		) as typeof fetch;
		const result = await makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		}).runOnce();
		expect(result).toMatchObject({
			skippedNotIdle: 1,
			alreadyArchived: 1,
			benignMissing: 2,
			archived: 0,
		});
	});

	it("caps PATCH attempts at 25 and spaces every candidate", async () => {
		const threads = Array.from({ length: 26 }, (_, index) =>
			thread(snowflakeAt(NOW - (index + 3) * 60 * 60_000), "roundtable", 120),
		);
		const sleepImpl = vi.fn(async () => {});
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/threads/active")) return response(200, { threads });
			const id = url.match(/\/channels\/(.+)$/)?.[1];
			const found = threads.find((item) => item.id === id);
			return (init?.method ?? "GET") === "GET"
				? response(200, found)
				: response(200, { ...found, thread_metadata: { archived: true } });
		}) as typeof fetch;
		const result = await makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl,
			log: () => {},
		}).runOnce();
		expect(result).toMatchObject({ archived: 25, capped: true });
		expect(sleepImpl).toHaveBeenCalledTimes(25);
		expect(sleepImpl).toHaveBeenCalledWith(500);
	});

	it("stops before discovery when shutdown was requested", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const result = await makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			log: () => {},
		}).runOnce(() => true);
		expect(result.aborted).toBe(true);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("QA Testing sweep identity", () => {
	const guildId = snowflakeAt(NOW - 100 * 60 * 60_000);
	const categoryId = snowflakeAt(NOW - 90 * 60 * 60_000);

	it("resolves the QA group's bot token through its configured env name", () => {
		const log = vi.fn();
		expect(resolveQaIdleThreadSweepIdentity({}, log)).toBeNull();
		expect(log).not.toHaveBeenCalled();
		expect(
			resolveQaIdleThreadSweepIdentity(
				{
					FLYWHEEL_QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV: " QA_SWEEP_TOKEN ",
					QA_SWEEP_TOKEN: " qa-secret ",
					FLYWHEEL_ROUNDTABLE_GUILD_ID: guildId,
				},
				log,
			),
		).toEqual({
			tokenEnv: "QA_SWEEP_TOKEN",
			identity: { botToken: "qa-secret", guildId },
		});
		for (const env of [
			{
				FLYWHEEL_QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV: "bad name; rm",
				DISCORD_GUILD_ID: guildId,
			},
			{
				FLYWHEEL_QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV: "QA_SWEEP_TOKEN",
				DISCORD_GUILD_ID: guildId,
			},
			{
				FLYWHEEL_QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV: "QA_SWEEP_TOKEN",
				QA_SWEEP_TOKEN: "qa-secret",
			},
		]) {
			expect(resolveQaIdleThreadSweepIdentity(env, log)).toBeNull();
		}
		expect(log).toHaveBeenCalledTimes(3);
		expect(log.mock.calls.flat().join("\n")).not.toContain("qa-secret");
	});

	it("builds one production group on the infra bot and one QA group on the configured bot", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2916-groups-"));
		const slotsPath = join(dir, "test-slots.json");
		writeFileSync(slotsPath, JSON.stringify({ guildId, categoryId }));
		const env = {
			CLAUDE_INFRA_BOT_TOKEN: "infra-secret",
			DISCORD_GUILD_ID: guildId,
			FLYWHEEL_ROUNDTABLE_CHANNEL_ID: "roundtable",
			FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "alerts",
			FLYWHEEL_QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV: "QA_SWEEP_TOKEN",
			QA_SWEEP_TOKEN: "qa-secret",
		};
		const log = vi.fn();
		try {
			expect(resolveIdleThreadSweepGroups(env, { slotsPath, log })).toEqual([
				{
					name: "production",
					tokenEnv: "CLAUDE_INFRA_BOT_TOKEN",
					identity: { botToken: "infra-secret", guildId },
					channelIds: ["roundtable", "alerts"],
				},
				{
					name: "qa-testing",
					tokenEnv: "QA_SWEEP_TOKEN",
					identity: { botToken: "qa-secret", guildId },
					qaTestingCategoryId: categoryId,
				},
			]);
			// Unconfigured QA identity: production is exactly what it was.
			const { FLYWHEEL_QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV: _, ...prodOnly } =
				env;
			expect(
				resolveIdleThreadSweepGroups(prodOnly, { slotsPath, log }).map(
					(group) => group.name,
				),
			).toEqual(["production"]);
			const {
				FLYWHEEL_ROUNDTABLE_CHANNEL_ID: __,
				FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: ___,
				...qaOnly
			} = env;
			expect(
				resolveIdleThreadSweepGroups(qaOnly, { slotsPath, log }).map(
					(group) => group.name,
				),
			).toEqual(["qa-testing"]);
			expect(log).not.toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps the production denial alert text and names the QA identity without its token", () => {
		const production = {
			name: "production" as const,
			tokenEnv: "CLAUDE_INFRA_BOT_TOKEN",
			identity: { botToken: "infra-secret", guildId },
			channelIds: ["roundtable"],
		};
		expect(
			describeIdleThreadSweepDenial(production, {
				status: 403,
				context: "thread PATCH",
			}),
		).toEqual({
			reason: "idle_thread_sweep_denied",
			title: "Discord idle-thread sweep denied",
			body: "Discord HTTP 403 during thread PATCH; check claw-infra-bot VIEW_CHANNEL and MANAGE_THREADS permissions.",
		});
		const qa = describeIdleThreadSweepDenial(
			{
				name: "qa-testing",
				tokenEnv: "QA_SWEEP_TOKEN",
				identity: { botToken: "qa-secret", guildId },
				qaTestingCategoryId: categoryId,
			},
			{ status: 403, context: "QA channel read", channelId: "123" },
		);
		// A separate reason: MetaAlertNotifier debounces per reason, so sharing
		// one would let a QA denial swallow a production denial for 10 minutes.
		expect(qa.reason).toBe("qa_idle_thread_sweep_denied");
		expect(qa.title).toBe("QA Testing idle-thread sweep denied");
		expect(qa.body).toContain("QA_SWEEP_TOKEN");
		expect(qa.body).toContain("channel 123");
		expect(qa.body).toContain("24h");
		expect(JSON.stringify(qa)).not.toContain("qa-secret");
	});
});

describe("QA Testing sweep budget and denial handling", () => {
	const categoryId = snowflakeAt(NOW - 50 * 60 * 60_000);

	it("skips a denied QA channel after one probe, counts it toward the cap, and alerts per channel at most once per 24h", async () => {
		const deniedChannel = snowflakeAt(NOW - 41 * 60 * 60_000);
		const openChannel = snowflakeAt(NOW - 42 * 60 * 60_000);
		const deniedThreads = Array.from({ length: 30 }, (_, index) =>
			thread(snowflakeAt(NOW - (1000 + index) * 60_000), deniedChannel, 120),
		);
		const openThreads = Array.from({ length: 30 }, (_, index) =>
			thread(snowflakeAt(NOW - (2000 + index) * 60_000), openChannel, 120),
		);
		const all = [...deniedThreads, ...openThreads];
		const deniedThreadReads: string[] = [];
		let deniedProbes = 0;
		let currentNow = NOW;
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/guilds/guild/channels"))
				return response(200, [
					{ id: deniedChannel, parent_id: categoryId, type: 0 },
					{ id: openChannel, parent_id: categoryId, type: 0 },
				]);
			if (url.endsWith("/threads/active"))
				return response(200, { threads: all });
			const id = url.split("/").at(-1)!;
			if (id === deniedChannel) {
				deniedProbes += 1;
				return response(403, { code: 50001 });
			}
			if (id === openChannel)
				return response(200, { id, parent_id: categoryId, type: 0 });
			const found = all.find((item) => item.id === id)!;
			if (found.parent_id === deniedChannel) {
				deniedThreadReads.push(id);
				return response(403, { code: 50001 });
			}
			if ((init?.method ?? "GET") === "GET") return response(200, found);
			found.thread_metadata!.archived = true;
			return response(200, found);
		}) as typeof fetch;
		const onDenied = vi.fn();
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "qa-token", guildId: "guild" },
			qaTestingCategoryId: categoryId,
			fetchImpl,
			onDenied,
			now: () => currentNow,
			sleepImpl: async () => {},
			log: () => {},
		});

		expect(await sweep.runOnce()).toMatchObject({
			denied: 1,
			skippedDeniedParent: 30,
			archived: 24,
			capped: true,
		});
		expect(deniedProbes).toBe(1);
		expect(deniedThreadReads).toEqual([]);
		expect(onDenied).toHaveBeenCalledTimes(1);
		expect(onDenied).toHaveBeenCalledWith({
			status: 403,
			context: "QA channel read",
			channelId: deniedChannel,
		});

		currentNow += 10 * 60_000;
		expect(await sweep.runOnce()).toMatchObject({ archived: 6 });
		expect(onDenied).toHaveBeenCalledTimes(1);

		currentNow = NOW + IDLE_THREAD_SWEEP_DENIED_ALERT_DEBOUNCE_MS - 1;
		await sweep.runOnce();
		expect(onDenied).toHaveBeenCalledTimes(1);
		currentNow = NOW + IDLE_THREAD_SWEEP_DENIED_ALERT_DEBOUNCE_MS;
		await sweep.runOnce();
		expect(onDenied).toHaveBeenCalledTimes(2);
		expect(deniedProbes).toBe(4);
		expect(deniedThreadReads).toEqual([]);
	});

	it("aggregates QA thread-level denials into one alert per channel", async () => {
		const channel = snowflakeAt(NOW - 41 * 60 * 60_000);
		const threads = Array.from({ length: 3 }, (_, index) =>
			thread(snowflakeAt(NOW - (1000 + index) * 60_000), channel, 120),
		);
		let currentNow = NOW;
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.endsWith("/guilds/guild/channels"))
				return response(200, [{ id: channel, parent_id: categoryId, type: 0 }]);
			if (url.endsWith("/threads/active")) return response(200, { threads });
			const id = url.split("/").at(-1)!;
			return id === channel
				? response(200, { id, parent_id: categoryId, type: 0 })
				: response(403, { code: 50001 });
		}) as typeof fetch;
		const onDenied = vi.fn();
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "qa-token", guildId: "guild" },
			qaTestingCategoryId: categoryId,
			fetchImpl,
			onDenied,
			now: () => currentNow,
			sleepImpl: async () => {},
			log: () => {},
		});

		expect(await sweep.runOnce()).toMatchObject({ denied: 3, archived: 0 });
		currentNow += 10 * 60_000;
		await sweep.runOnce();
		expect(onDenied).toHaveBeenCalledTimes(1);
		expect(onDenied).toHaveBeenCalledWith({
			status: 403,
			context: "fresh thread read",
			channelId: channel,
		});
		currentNow = NOW + IDLE_THREAD_SWEEP_DENIED_ALERT_DEBOUNCE_MS;
		await sweep.runOnce();
		expect(onDenied).toHaveBeenCalledTimes(2);
	});

	it("debounces QA credential and active-thread discovery denials for 24h", async () => {
		const statuses = [401, 401, 200, 401];
		let listStatus = 403;
		let currentNow = NOW;
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.endsWith("/guilds/guild/channels")) {
				const status = statuses.shift() ?? 200;
				return status === 200
					? response(200, [
							{
								id: snowflakeAt(NOW - 41 * 60 * 60_000),
								parent_id: categoryId,
								type: 0,
							},
						])
					: response(status);
			}
			return response(listStatus);
		}) as typeof fetch;
		const onDenied = vi.fn();
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "qa-token", guildId: "guild" },
			qaTestingCategoryId: categoryId,
			fetchImpl,
			onDenied,
			now: () => currentNow,
			sleepImpl: async () => {},
			log: () => {},
		});
		for (let index = 0; index < 4; index += 1) {
			await sweep.runOnce();
			currentNow += 10 * 60_000;
		}
		expect(onDenied.mock.calls.map(([detail]) => detail)).toEqual([
			{ status: 401, context: "QA category discovery" },
			{ status: 403, context: "active-thread discovery" },
		]);
		listStatus = 403;
		currentNow = NOW + IDLE_THREAD_SWEEP_DENIED_ALERT_DEBOUNCE_MS + 60 * 60_000;
		statuses.push(401);
		await sweep.runOnce();
		expect(onDenied).toHaveBeenCalledTimes(3);
	});

	it("retries a QA channel alert the notifier did not deliver, then debounces it for 24h", async () => {
		const channels = [41, 42].map((hours) =>
			snowflakeAt(NOW - hours * 60 * 60_000),
		);
		const threads = channels.map((parentId, index) =>
			thread(snowflakeAt(NOW - (1000 + index) * 60_000), parentId, 120),
		);
		let currentNow = NOW;
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.endsWith("/guilds/guild/channels"))
				return response(
					200,
					channels.map((id) => ({ id, parent_id: categoryId, type: 0 })),
				);
			if (url.endsWith("/threads/active")) return response(200, { threads });
			return response(403, { code: 50001 });
		}) as typeof fetch;
		// The notifier delivers one alert per 10 minutes and debounces the rest.
		let lastDeliveredAt: number | undefined;
		const delivered: string[] = [];
		const onDenied = vi.fn(async (detail: { channelId?: string }) => {
			if (
				lastDeliveredAt !== undefined &&
				currentNow - lastDeliveredAt < 10 * 60_000
			)
				return false;
			lastDeliveredAt = currentNow;
			delivered.push(detail.channelId ?? "");
			return true;
		});
		const sweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "qa-token", guildId: "guild" },
			qaTestingCategoryId: categoryId,
			fetchImpl,
			onDenied,
			now: () => currentNow,
			sleepImpl: async () => {},
			log: () => {},
		});

		await sweep.runOnce();
		await vi.waitFor(() => expect(onDenied).toHaveBeenCalledTimes(2));
		expect(delivered).toEqual([channels[0]]);
		currentNow += 10 * 60_000;
		await sweep.runOnce();
		await vi.waitFor(() => expect(onDenied).toHaveBeenCalledTimes(3));
		expect(delivered).toEqual(channels);
		currentNow += 10 * 60_000;
		await sweep.runOnce();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onDenied).toHaveBeenCalledTimes(3);
	});

	it("counts denied fresh reads toward the per-pass cap", async () => {
		const threads = Array.from({ length: 30 }, (_, index) =>
			thread(snowflakeAt(NOW - (index + 3) * 60 * 60_000), "roundtable", 120),
		);
		const fetchImpl = vi.fn(async (url: string) =>
			url.endsWith("/threads/active")
				? response(200, { threads })
				: response(403, { code: 50001 }),
		) as typeof fetch;
		const result = await makeIdleThreadArchiveSweep({
			identity: { botToken: "token", guildId: "guild" },
			channelIds: ["roundtable"],
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		}).runOnce();
		expect(result).toMatchObject({ denied: 25, capped: true, archived: 0 });
		expect(fetchImpl).toHaveBeenCalledTimes(26);
	});

	it("keeps the production pass on its own identity and budget while the QA pass is stalled", async () => {
		const qaChannel = snowflakeAt(NOW - 41 * 60 * 60_000);
		const production = thread(
			snowflakeAt(NOW - 3 * 60 * 60_000),
			"roundtable",
			120,
		);
		const qaThreads = Array.from({ length: 100 }, (_, index) =>
			thread(snowflakeAt(NOW - (1000 + index) * 60_000), qaChannel, 120),
		);
		const authByUrl: Array<{ url: string; auth: string }> = [];
		let releaseQa: (value: Response) => void = () => {};
		const qaStalled = new Promise<Response>((resolve) => {
			releaseQa = resolve;
		});
		// One shared fetch, as in the Bridge: the QA identity's requests hang.
		const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
			const auth = (init?.headers as Record<string, string>).Authorization;
			authByUrl.push({ url, auth });
			if (auth === "Bot qa-token") return await qaStalled;
			if (url.endsWith("/threads/active"))
				return response(200, { threads: [production, ...qaThreads] });
			return (init?.method ?? "GET") === "GET"
				? response(200, production)
				: response(200, { ...production, thread_metadata: { archived: true } });
		}) as typeof fetch;
		const common = {
			fetchImpl,
			now: () => NOW,
			sleepImpl: async () => {},
			log: () => {},
		};
		const qaSweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "qa-token", guildId: "guild" },
			qaTestingCategoryId: categoryId,
			...common,
		});
		const productionSweep = makeIdleThreadArchiveSweep({
			identity: { botToken: "infra-token", guildId: "guild" },
			channelIds: ["roundtable"],
			...common,
		});
		const qaPass = qaSweep.runOnce();
		expect(await productionSweep.runOnce()).toMatchObject({
			scanned: 1,
			archived: 1,
		});
		expect(
			authByUrl
				.filter(({ auth }) => auth === "Bot infra-token")
				.map(({ url }) => url.split("/").at(-1)),
		).toEqual(["active", production.id, production.id]);
		releaseQa(response(500));
		expect(await qaPass).toMatchObject({ transient: 1, archived: 0 });
	});
});
