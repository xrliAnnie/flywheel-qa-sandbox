import { expect, it, vi } from "vitest";
import { createLeadLinearClient } from "../linear-client.js";

it("bounds a request to fifteen seconds even when fetch ignores abort", async () => {
	vi.useFakeTimers();
	const session = createLeadLinearClient({
		token: "PRIVATE_TOKEN",
		fetchImpl: () => new Promise(() => {}),
	});
	try {
		const request = session.withSignal(new AbortController().signal, () =>
			session.client.issue("issue-1"),
		);
		const rejected = expect(request).rejects.toThrow(
			"linear_provider_unavailable",
		);
		await vi.advanceTimersByTimeAsync(15000);
		await rejected;
	} finally {
		await session.close();
		vi.useRealTimers();
	}
});

it("uses the actual SDK on the fixed authenticated endpoint and requires operation lifetime", async () => {
	const fetchImpl = vi.fn<typeof fetch>(async () =>
		Response.json({
			data: { issue: { id: "issue-1", title: "Example", reactions: [] } },
		}),
	);
	const session = createLeadLinearClient({ token: "PRIVATE_TOKEN", fetchImpl });
	try {
		await expect(session.client.issue("issue-1")).rejects.toThrow(
			"linear_provider_unavailable",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
		const issue = await session.withSignal(new AbortController().signal, () =>
			session.client.issue("issue-1"),
		);
		expect(issue.title).toBe("Example");
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("https://api.linear.app/graphql");
		expect(new Headers(init!.headers).get("authorization")).toBe(
			"PRIVATE_TOKEN",
		);
		expect(init!.redirect).toBe("manual");
		expect(JSON.parse(init!.body as string).variables).toEqual({
			id: "issue-1",
		});
	} finally {
		await session.close();
	}
});

it("does not retry mutation redirects or expose provider error text", async () => {
	const fetchImpl = vi.fn<typeof fetch>(
		async () =>
			new Response("PRIVATE_TOKEN", {
				status: 302,
				headers: { location: "https://foreign.invalid" },
			}),
	);
	const session = createLeadLinearClient({ token: "PRIVATE_TOKEN", fetchImpl });
	try {
		await expect(
			session.withSignal(new AbortController().signal, () =>
				session.client.createComment({ issueId: "issue-1", body: "hello" }),
			),
		).rejects.toThrow(/^linear_provider_unavailable$/);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		fetchImpl.mockImplementationOnce(async () =>
			Response.json({ errors: [{ message: "PRIVATE_TOKEN" }] }),
		);
		await expect(
			session.withSignal(new AbortController().signal, () =>
				session.client.issue("issue-1"),
			),
		).rejects.toThrow(/^linear_provider_unavailable$/);
	} finally {
		await session.close();
	}
});

it("aborts uncooperative fetches, cancels late bodies and rejects new work after close", async () => {
	let resolveFetch!: (response: Response) => void;
	const fetchImpl = vi.fn<typeof fetch>(
		() =>
			new Promise((resolve) => {
				resolveFetch = resolve;
			}),
	);
	const session = createLeadLinearClient({ token: "PRIVATE_TOKEN", fetchImpl });
	const controller = new AbortController();
	const request = session.withSignal(controller.signal, () =>
		session.client.issue("issue-1"),
	);
	const rejected = expect(request).rejects.toThrow(
		"linear_provider_unavailable",
	);
	controller.abort();
	await rejected;
	const cancel = vi.fn();
	resolveFetch(new Response(new ReadableStream({ cancel })));
	await new Promise((resolve) => setImmediate(resolve));
	expect(cancel).toHaveBeenCalledOnce();
	await session.close();
	await expect(
		session.withSignal(new AbortController().signal, () =>
			session.client.issue("issue-1"),
		),
	).rejects.toThrow();
	expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("bounds streamed bytes and cancels an active response body on shutdown", async () => {
	const cancel = vi.fn();
	const fetchImpl = vi.fn<typeof fetch>(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
					},
					cancel,
				}),
			),
	);
	const session = createLeadLinearClient({ token: "PRIVATE_TOKEN", fetchImpl });
	await expect(
		session.withSignal(new AbortController().signal, () =>
			session.client.issue("issue-1"),
		),
	).rejects.toThrow();
	expect(cancel).toHaveBeenCalled();
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const pendingCancel = vi.fn();
	fetchImpl.mockImplementationOnce(async () => {
		started();
		return new Response(new ReadableStream({ cancel: pendingCancel }));
	});
	const pending = session.withSignal(new AbortController().signal, () =>
		session.client.issue("issue-1"),
	);
	const rejected = expect(pending).rejects.toThrow();
	await ready;
	await session.close();
	await rejected;
	expect(pendingCancel).toHaveBeenCalled();
});
