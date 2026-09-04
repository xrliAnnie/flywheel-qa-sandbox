/**
 * FLY-203: vercel-deploy unit tests.
 *
 * `deployToVercel` tests are a REVERSE-COMPAT SENTINEL (Codex R1#7, FLY-175
 * precedent): GEO-294's `/api/publish-html` relies on the exact deployment
 * name prefix, deterministic alias URL and poll semantics. If a refactor of
 * the shared `deployFilesToVercel` changes any of those, these tests fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deployFilesToVercel,
	deployToVercel,
} from "../bridge/vercel-deploy.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("deployToVercel (GEO-294 reverse-compat sentinel)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("deploys single index.html with triage- prefixed lowercased name, returns deterministic alias", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ url: "x.vercel.app", id: "dpl_1", readyState: "READY" }),
		);

		const result = await deployToVercel("tok", "MyProj", "<html></html>");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.vercel.com/v13/deployments");
		const body = JSON.parse(init.body as string);
		expect(body.name).toBe("triage-myproj");
		expect(body.target).toBe("production");
		expect(body.projectSettings).toEqual({ framework: null });
		expect(body.files).toEqual([
			{ file: "index.html", data: "<html></html>", encoding: "utf-8" },
		]);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);

		expect(result.url).toBe("https://triage-myproj.vercel.app");
		expect(result.deploymentId).toBe("dpl_1");
	});

	it("polls until READY when not immediately ready", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({ url: "x", id: "dpl_2", readyState: "QUEUED" }),
			)
			.mockResolvedValueOnce(jsonResponse({ readyState: "BUILDING" }))
			.mockResolvedValueOnce(jsonResponse({ readyState: "READY" }));

		const promise = deployToVercel("tok", "p", "<html></html>");
		await vi.advanceTimersByTimeAsync(2000);
		await vi.advanceTimersByTimeAsync(2000);
		const result = await promise;

		expect(result.deploymentId).toBe("dpl_2");
		// 1 create + 2 status polls
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://api.vercel.com/v13/deployments/dpl_2",
		);
	});

	it("throws on deployment ERROR state", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({ url: "x", id: "dpl_3", readyState: "QUEUED" }),
			)
			.mockResolvedValueOnce(jsonResponse({ readyState: "ERROR" }));

		const promise = deployToVercel("tok", "p", "<html></html>");
		const assertion = expect(promise).rejects.toThrow(
			"Vercel deployment ERROR",
		);
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;
	});

	it("keeps polling a function deployment beyond 30 seconds until READY", async () => {
		vi.useFakeTimers();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ url: "x", id: "dpl_slow", readyState: "QUEUED" }),
		);
		for (let attempt = 0; attempt < 15; attempt += 1) {
			fetchMock.mockResolvedValueOnce(jsonResponse({ readyState: "BUILDING" }));
		}
		fetchMock.mockResolvedValueOnce(jsonResponse({ readyState: "READY" }));

		const promise = deployFilesToVercel(
			"tok",
			"fw-reports-abc123",
			[{ file: "api/report.js", data: "export default () => {}" }],
			40_000,
		);
		const assertion = expect(promise).resolves.toEqual({
			deploymentId: "dpl_slow",
		});
		await vi.advanceTimersByTimeAsync(32_000);
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(17);
	});

	it("fails loudly at the deployment timeout when Vercel never reaches a terminal state", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({ url: "x", id: "dpl_stuck", readyState: "QUEUED" }),
			)
			.mockImplementation(() =>
				Promise.resolve(jsonResponse({ readyState: "BUILDING" })),
			);

		const promise = deployFilesToVercel(
			"tok",
			"fw-reports-abc123",
			[{ file: "api/report.js", data: "export default () => {}" }],
			5_000,
		);
		const assertion = expect(promise).rejects.toThrow(
			"Vercel deployment not ready before 5s timeout",
		);
		await vi.advanceTimersByTimeAsync(6_000);
		await assertion;
	});

	it("normalizes an in-flight fetch abort to the loud deployment timeout", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({ url: "x", id: "dpl_hung", readyState: "QUEUED" }),
			)
			.mockImplementation((_url: string, init: RequestInit) => {
				return new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						reject(
							new DOMException("This operation was aborted", "AbortError"),
						);
					});
				});
			});

		const promise = deployFilesToVercel(
			"tok",
			"fw-reports-abc123",
			[{ file: "api/report.js", data: "export default () => {}" }],
			5_000,
		);
		const assertion = expect(promise).rejects.toThrow(
			"Vercel deployment not ready before 5s timeout",
		);
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
	});

	it("throws with status on non-ok create response", async () => {
		fetchMock.mockResolvedValueOnce(new Response("nope", { status: 403 }));
		await expect(deployToVercel("tok", "p", "<html></html>")).rejects.toThrow(
			"Vercel deploy failed (403)",
		);
	});
});

describe("deployFilesToVercel (FLY-203)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses deploymentName AS-IS (no prefix) and sends all files", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ url: "x", id: "dpl_9", readyState: "READY" }),
		);

		const result = await deployFilesToVercel("tok", "fw-reports-abc123", [
			{ file: "robots.txt", data: "User-agent: *\nDisallow: /\n" },
			{ file: "r/deadbeef/index.html", data: "<html><head></head></html>" },
		]);

		const body = JSON.parse(
			(fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
		);
		expect(body.name).toBe("fw-reports-abc123");
		expect(body.target).toBe("production");
		expect(body.projectSettings).toEqual({ framework: null });
		expect(body.files).toHaveLength(2);
		expect(body.files[1]).toEqual({
			file: "r/deadbeef/index.html",
			data: "<html><head></head></html>",
			encoding: "utf-8",
		});
		expect(result.deploymentId).toBe("dpl_9");
		expect(
			(fetchMock.mock.calls[0] as [string, RequestInit])[1].redirect,
		).toBeUndefined();
	});

	it("uses a QA API base for create and polling without following redirects", async () => {
		vi.useFakeTimers();
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({ url: "x", id: "dpl_qa", readyState: "QUEUED" }),
			)
			.mockResolvedValueOnce(jsonResponse({ readyState: "READY" }));

		const promise = deployFilesToVercel(
			"tok",
			"fw-reports-qa",
			[{ file: "r/token/index.html", data: "<html></html>" }],
			undefined,
			"http://127.0.0.1:4321/",
		);
		await vi.advanceTimersByTimeAsync(2000);
		await promise;

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://127.0.0.1:4321/v13/deployments",
		);
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"http://127.0.0.1:4321/v13/deployments/dpl_qa",
		);
		expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].redirect).toBe(
			"error",
		);
		expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].redirect).toBe(
			"error",
		);
	});

	it("rejects empty file list", async () => {
		await expect(deployFilesToVercel("tok", "n", [])).rejects.toThrow(
			"files must be non-empty",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		["/abs/index.html"],
		["r/../escape.html"],
		[".."],
		["windows\\path.html"],
		[""],
	])("rejects invalid file path %j", async (bad) => {
		await expect(
			deployFilesToVercel("tok", "n", [{ file: bad, data: "x" }]),
		).rejects.toThrow("invalid file path");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
