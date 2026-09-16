import { describe, expect, it, vi } from "vitest";
import {
	classifyRunnerStart,
	requestRunnerBridge,
} from "../runner-action-http.js";

const execId = "12345678-1234-4234-8234-123456789012";
describe("runner Bridge boundary", () => {
	it.each([
		[200, { success: true, executionId: execId }, "started"],
		[202, { code: "LAUNCH_PENDING", executionId: execId }, "pending"],
		[400, { error: "bad" }, "refused"],
		[403, {}, "refused"],
		[429, { success: false, reason: "admission_paused" }, "refused"],
		[429, { reason: "unknown" }, "unknown"],
		[409, { executionId: execId }, "unknown"],
		[500, { executionId: execId }, "unknown"],
		[404, {}, "unknown"],
	])("classifies %s conservatively", (httpStatus, body, outcome) => {
		expect(classifyRunnerStart({ httpStatus, body }, "key").outcome).toBe(
			outcome,
		);
	});
	it("projects only safe identifiers and typed Retry-After, never backend diagnostics", () => {
		expect(
			classifyRunnerStart(
				{
					httpStatus: 429,
					body: {
						reason: "load_pressure",
						success: false,
						message: "SECRET",
						token: "SECRET",
						executionId: execId,
					},
					retryAfter: "15",
				},
				"key",
			),
		).toEqual({
			outcome: "refused",
			httpStatus: 429,
			executionId: execId,
			idempotencyKey: "key",
			retryAfterSeconds: 15,
		});
	});
	it("does not retry an ambiguous POST or return its secret-bearing error", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("SECRET"));
		const result = await requestRunnerBridge(
			{ bridgeUrl: "http://localhost:9876", apiToken: "TOKEN", fetchImpl },
			"/api/runs/start",
			{},
		);
		expect(result).toEqual({});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
	it("bounds streamed response bytes and cancels oversized bodies", async () => {
		const cancel = vi.fn();
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(new Uint8Array(262145));
					},
					cancel,
				}),
				{ status: 200 },
			),
		);
		const result = await requestRunnerBridge(
			{ bridgeUrl: "http://localhost", apiToken: "TOKEN", fetchImpl },
			"/api/runs/start",
			{},
		);
		expect(result.body).toBeUndefined();
		expect(cancel).toHaveBeenCalled();
	});
	it("rejects non-JSON and never follows a credential-bearing redirect", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("not json", { status: 502 }));
		const result = await requestRunnerBridge(
			{ bridgeUrl: "http://localhost", apiToken: "TOKEN", fetchImpl },
			"/api/runs/start",
			{},
		);
		expect(result.body).toBeUndefined();
		expect(fetchImpl.mock.calls[0]![1].redirect).toBe("error");
	});
	it("aborts after 15 seconds without retry", async () => {
		vi.useFakeTimers();
		try {
			const fetchImpl = vi.fn(
				(_url, init) =>
					new Promise<Response>((_resolve, reject) =>
						init.signal.addEventListener("abort", () =>
							reject(new Error("aborted")),
						),
					),
			);
			const pending = requestRunnerBridge(
				{ bridgeUrl: "http://localhost", apiToken: "TOKEN", fetchImpl },
				"/api/runs/start",
				{},
			);
			await vi.advanceTimersByTimeAsync(15000);
			expect(await pending).toEqual({});
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it("treats a malformed refusal body as unknown", () => {
		expect(classifyRunnerStart({ httpStatus: 403 }, "key").outcome).toBe(
			"unknown",
		);
	});
});

it("honors caller cancellation before dispatch and while a provider ignores abort", async () => {
	const controller = new AbortController();
	controller.abort();
	const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
	let settled = false;
	const pending = requestRunnerBridge(
		{
			bridgeUrl: "http://localhost",
			apiToken: "TOKEN",
			fetchImpl,
			signal: controller.signal,
		},
		"/api/runs/start",
		{},
	).then((value) => {
		settled = true;
		return value;
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(fetchImpl).not.toHaveBeenCalled();
	expect(await pending).toEqual({});
	const active = new AbortController();
	const later = requestRunnerBridge(
		{
			bridgeUrl: "http://localhost",
			apiToken: "TOKEN",
			fetchImpl,
			signal: active.signal,
		},
		"/api/runs/start",
		{},
	);
	active.abort();
	expect(await later).toEqual({});
	expect(settled).toBe(true);
	expect(fetchImpl).toHaveBeenCalledOnce();
});
it("times out an uncooperative provider without retaining its late response body", async () => {
	vi.useFakeTimers();
	let finish!: (response: Response) => void;
	const fetchImpl = vi.fn<typeof fetch>(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	let result: unknown;
	try {
		void requestRunnerBridge(
			{ bridgeUrl: "http://localhost", apiToken: "TOKEN", fetchImpl },
			"/api/runs/start",
			{},
		).then((value) => {
			result = value;
		});
		await vi.advanceTimersByTimeAsync(15000);
		expect(result).toEqual({});
		const cancel = vi.fn();
		finish(new Response(new ReadableStream({ cancel })));
		await vi.advanceTimersByTimeAsync(0);
		expect(cancel).toHaveBeenCalledOnce();
	} finally {
		vi.useRealTimers();
	}
});
