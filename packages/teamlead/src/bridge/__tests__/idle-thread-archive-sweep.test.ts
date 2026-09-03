import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordActiveThread } from "../discord-guild-active-threads.js";
import {
	IDLE_THREAD_SWEEP_SCHEDULER_CONFIG,
	makeIdleThreadArchiveSweep,
	resolveIdleThreadSweepChannelIds,
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

describe("makeIdleThreadArchiveSweep", () => {
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
