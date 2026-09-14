import { describe, expect, it, vi } from "vitest";
import { GithubProjectApi } from "../github-api.js";

describe("bounded GitHub project reader", () => {
	it("normalizes PR and rename pages, keeps requests on the allowlisted repository and uses one HTTP call per method", async () => {
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			expect(init?.redirect).toBe("error");
			if (url.includes("/files?"))
				return new Response(
					JSON.stringify([{ filename: "new.ts", previous_filename: "old.ts" }]),
					{
						headers: {
							Link: '<https://api.github.com/repos/owner/repo/pulls/1/files?per_page=20&page=2>; rel="next"',
						},
					},
				);
			return new Response(
				JSON.stringify([
					{
						number: 1,
						head: { sha: "a".repeat(40) },
						base: { ref: "main", sha: "b".repeat(40) },
						state: "open",
						draft: false,
					},
				]),
			);
		});
		const api = new GithubProjectApi(
			["owner/repo"],
			() => "test-token",
			fetcher,
		);
		const signal = new AbortController().signal;
		expect(await api.prs("owner/repo", 1, signal)).toMatchObject({
			items: [
				{ pr_number: 1, head_sha: "a".repeat(40), base_sha: "b".repeat(40) },
			],
			nextPage: null,
		});
		expect(await api.files("owner/repo", 1, 1, signal)).toEqual({
			items: [{ path: "new.ts", previous_path: "old.ts" }],
			nextPage: 2,
		});
		await expect(api.main("other/private", signal)).rejects.toThrow(
			"repository_not_allowed",
		);
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(
			() => new GithubProjectApi(["../repo"], () => "test-token", fetcher),
		).toThrow();
	});
	it("rejects redirected pagination, oversized bodies, and preserves rate-limit retry time without error-body leakage", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response("[]", {
					headers: { Link: '<https://evil.invalid/leak?page=2>; rel="next"' },
				}),
		);
		const api = new GithubProjectApi(
			["owner/repo"],
			() => "private-token",
			fetcher,
			() => 1000,
		);
		const signal = new AbortController().signal;
		await expect(api.files("owner/repo", 1, 1, signal)).rejects.toThrow(
			"invalid_pagination",
		);
		fetcher.mockImplementationOnce(
			async () =>
				new Response("private diagnostic", {
					status: 429,
					headers: { "Retry-After": "30" },
				}),
		);
		await expect(api.main("owner/repo", signal)).rejects.toMatchObject({
			code: "github_rate_limit",
			retryAfter: 31000,
		});
		fetcher.mockImplementationOnce(
			async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
		);
		await expect(api.main("owner/repo", signal)).rejects.toThrow(
			"github_body_budget",
		);
	});
});

it("passes cancellation to credentials and starts no HTTP after credential cancellation", async () => {
	const controller = new AbortController();
	let received: AbortSignal | undefined;
	const fetcher = vi.fn();
	const token = async (signal?: AbortSignal) => {
		received = signal;
		controller.abort();
		return "fixture";
	};
	const api = new GithubProjectApi(["owner/repo"], token, fetcher);
	await expect(api.main("owner/repo", controller.signal)).rejects.toThrow();
	expect(received).toBe(controller.signal);
	expect(fetcher).not.toHaveBeenCalled();
});

it.each(["repos/owner/repo", "repositories/1164340454"])(
	"accepts GitHub pagination via %s and fetches the next page from the configured repository",
	async (prefix) => {
		const signal = new AbortController().signal;
		for (const suffix of ["/pulls", "/pulls/1163/files"]) {
			const fetcher = vi.fn(
				async (url: string) =>
					new Response("[]", {
						headers: url.endsWith("page=1")
							? {
									Link: `<https://api.github.com/${prefix}${suffix}?per_page=20&page=2>; rel="next"`,
								}
							: {},
					}),
			);
			const api = new GithubProjectApi(
				["owner/repo"],
				() => "fixture",
				fetcher,
			);
			const read = (page: number) =>
				suffix === "/pulls"
					? api.prs("owner/repo", page, signal)
					: api.files("owner/repo", 1163, page, signal);
			const first = await read(1);
			expect(first.nextPage).toBe(2);
			expect((await read(first.nextPage!)).nextPage).toBeNull();
			expect(fetcher).toHaveBeenCalledTimes(2);
			expect(fetcher.mock.calls[1]![0]).toBe(
				`https://api.github.com/repos/owner/repo${suffix}?${suffix === "/pulls" ? "state=open&" : ""}per_page=20&page=2`,
			);
		}
	},
);

it.each([
	"https://api.github.com/repositories/1164340454/pulls/999/files?per_page=20&page=2",
	"https://api.github.com/repositories/not-an-id/pulls/1163/files?per_page=20&page=2",
	"https://api.github.com/repos/other/repo/pulls/1163/files?per_page=20&page=2",
	"https://evil.invalid/repositories/1164340454/pulls/1163/files?per_page=20&page=2",
	"https://api.github.com/repositories/1164340454/pulls/1163/files?per_page=20&page=3",
	"https://api.github.com/repositories/1164340454/pulls/1163/files?per_page=50&page=2",
])(
	"rejects pagination outside the requested resource or next page: %s",
	async (url) => {
		const fetcher = vi.fn(
			async () =>
				new Response("[]", {
					headers: { Link: `<${url}>; rel="next"` },
				}),
		);
		const api = new GithubProjectApi(["owner/repo"], () => "fixture", fetcher);
		await expect(
			api.files("owner/repo", 1163, 1, new AbortController().signal),
		).rejects.toThrow("invalid_pagination");
		expect(fetcher).toHaveBeenCalledTimes(1);
	},
);

it.each(["prs", "files"] as const)(
	"reads realistic >800KiB %s pages through numeric GitHub Links and retains only required fields",
	async (kind) => {
		const item = (i: number) =>
			kind === "prs"
				? {
						number: i + 1,
						head: { sha: "a".repeat(40) },
						base: { ref: "main", sha: "b".repeat(40) },
						state: "open",
						draft: false,
						body: "x".repeat(60_000),
						user: { ignored: "metadata" },
					}
				: {
						filename: `src/file${i}.ts`,
						patch: "x".repeat(60_000),
						raw_url: "https://ignored.invalid",
					};
		const large = JSON.stringify(Array.from({ length: 20 }, (_, i) => item(i)));
		expect(Buffer.byteLength(large)).toBeGreaterThan(800 * 1024);
		const suffix = kind === "prs" ? "/pulls" : "/pulls/1163/files";
		const fetcher = vi.fn(async (url: string) => {
			const first = new URL(url).searchParams.get("page") === "1";
			const bytes = Buffer.from(first ? large : JSON.stringify([item(20)]));
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (let i = 0; i < bytes.length; i += 65536)
						controller.enqueue(bytes.subarray(i, i + 65536));
					controller.close();
				},
			});
			return new Response(body, {
				headers: first
					? {
							Link: `<https://api.github.com/repositories/1164340454${suffix}?per_page=20&page=2>; rel="next"`,
						}
					: {},
			});
		});
		const api = new GithubProjectApi(["owner/repo"], () => "fixture", fetcher);
		const read = (page: number) =>
			kind === "prs"
				? api.prs("owner/repo", page, new AbortController().signal)
				: api.files("owner/repo", 1163, page, new AbortController().signal);
		const first = await read(1);
		expect(first.items).toHaveLength(20);
		expect(first.nextPage).toBe(2);
		const second = await read(first.nextPage!);
		expect(second.items).toHaveLength(1);
		expect(second.nextPage).toBeNull();
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(8192);
		expect(fetcher).toHaveBeenCalledTimes(2);
		for (const [url] of fetcher.mock.calls) {
			expect(new URL(url).pathname).toBe(`/repos/owner/repo${suffix}`);
			expect(new URL(url).searchParams.get("per_page")).toBe("20");
		}
	},
);
