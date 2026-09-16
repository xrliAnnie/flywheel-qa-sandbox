import { expect, it, vi } from "vitest";
import {
	createLazyLeadGithubClient,
	createLeadGithubClient,
	resolveLeadGithubToken,
} from "../github-client.js";

it("loads credentials only on demand and closes the shared actual client", async () => {
	const absent = createLazyLeadGithubClient({ GH_TOKEN: "bad\nvalue" });
	expect(() => absent.get()).toThrow("github_credentials_unavailable");
	await absent.close();
	const fetchImpl = vi.fn<typeof fetch>(async () =>
		Response.json({ number: 7 }),
	);
	const provider = createLazyLeadGithubClient(
		{ GH_TOKEN: "PRIVATE_TOKEN" },
		fetchImpl,
	);
	expect(fetchImpl).not.toHaveBeenCalled();
	const client = provider.get().client;
	expect(provider.get().client).toBe(client);
	await client.rest.pulls.get({ owner: "owner", repo: "repo", pull_number: 7 });
	await provider.close();
	expect(provider.get).toThrow();
	await expect(
		client.rest.pulls.get({ owner: "owner", repo: "repo", pull_number: 7 }),
	).rejects.toThrow();
});
it("keeps credentials on the fixed API origin and never follows authenticated redirects", async () => {
	const fetchImpl = vi.fn<typeof fetch>(async () =>
		Response.json({ number: 7 }),
	);
	const session = createLeadGithubClient({ token: "PRIVATE_TOKEN", fetchImpl });
	try {
		await session.client.rest.pulls.get({
			owner: "owner",
			repo: "repo",
			pull_number: 7,
		});
		expect(String(fetchImpl.mock.calls[0]![0])).toBe(
			"https://api.github.com/repos/owner/repo/pulls/7",
		);
		expect(
			new Headers(fetchImpl.mock.calls[0]![1]!.headers).get("authorization"),
		).toBe("token PRIVATE_TOKEN");
		expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe("manual");
		await expect(
			session.client.request("GET https://foreign.invalid/private"),
		).rejects.toThrow();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		fetchImpl.mockImplementationOnce(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://foreign.invalid/private" },
				}),
		);
		await expect(
			session.client.rest.pulls.get({
				owner: "owner",
				repo: "repo",
				pull_number: 7,
			}),
		).rejects.toThrow();
		fetchImpl.mockImplementationOnce(
			async () =>
				new Response(null, {
					status: 302,
					headers: {
						location:
							"https://productionresultssa0.blob.core.windows.net/log.zip",
					},
				}),
		);
		const logs = await session.client.rest.actions.downloadWorkflowRunLogs({
			owner: "owner",
			repo: "repo",
			run_id: 7,
			request: { redirect: "manual", parseSuccessResponseBody: false },
		});
		expect(logs.status).toBe(302);
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	} finally {
		await session.close();
	}
	await expect(
		session.client.rest.pulls.get({
			owner: "owner",
			repo: "repo",
			pull_number: 7,
		}),
	).rejects.toThrow();
});
it("cancels an in-flight API body on close and bounds decoded response bytes", async () => {
	const cancel = vi.fn();
	let entered!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const session = createLeadGithubClient({
		token: "PRIVATE_TOKEN",
		fetchImpl: async () => {
			entered();
			return new Response(new ReadableStream({ cancel }), {
				headers: { "content-type": "application/json" },
			});
		},
	});
	const pending = session.client.rest.pulls.get({
		owner: "owner",
		repo: "repo",
		pull_number: 7,
	});
	const rejected = expect(pending).rejects.toThrow();
	await started;
	await session.close();
	await rejected;
	expect(cancel).toHaveBeenCalled();
	const oversized = createLeadGithubClient({
		token: "PRIVATE_TOKEN",
		fetchImpl: async () => new Response("x".repeat(4194305)),
	});
	try {
		await expect(
			oversized.client.rest.pulls.get({
				owner: "owner",
				repo: "repo",
				pull_number: 7,
			}),
		).rejects.toThrow();
	} finally {
		await oversized.close();
	}
});
it("uses existing environment token precedence and rejects malformed secrets", () => {
	expect(
		resolveLeadGithubToken({ GH_TOKEN: "first", GITHUB_TOKEN: "second" }),
	).toBe("first");
	expect(resolveLeadGithubToken({ GITHUB_TOKEN: "second" })).toBe("second");
	expect(() => resolveLeadGithubToken({ GH_TOKEN: "bad\nvalue" })).toThrow(
		"github_credentials_unavailable",
	);
});

it("ends an unresponsive request after the fixed 15 second budget", async () => {
	vi.useFakeTimers();
	const fetchImpl = vi.fn<typeof fetch>(() => new Promise(() => {}));
	const provider = createLeadGithubClient({
		token: "PRIVATE_TOKEN",
		fetchImpl,
	});
	try {
		const pending = provider.client.rest.pulls.get({
			owner: "owner",
			repo: "repo",
			pull_number: 7,
		});
		const rejected = expect(pending).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchImpl).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(15000);
		await rejected;
	} finally {
		await provider.close();
		vi.useRealTimers();
	}
});
