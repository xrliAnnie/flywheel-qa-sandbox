import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { CustomerReleaseAccounting } from "../customer-release/accounting.js";
import {
	GitHubReleaseAccounting,
	LinearReleaseAccounting,
	readReleaseAccountingBody,
	releaseAccountingBody,
} from "../customer-release/accounting-transport.js";

const event = {
	eventId: "cycle:e1",
	projectId: "flywheel" as const,
	cycleId: "c1",
	kind: "cancelled",
	when: 100,
	origin: "automatic" as const,
	facts: { reason: "<script>```@everyone" },
};
const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
it("checks actual serialized content and escapes embedded fence or HTML syntax", () => {
	const body = releaseAccountingBody("release-event:cycle:e1", event, digest);
	expect(body).not.toContain("<script>");
	expect(body).not.toContain("```@everyone");
	expect(readReleaseAccountingBody(body)).toEqual({
		marker: "release-event:cycle:e1",
		digest,
	});
	expect(
		readReleaseAccountingBody(body.replace('"cancelled"', '"published"'))
			.digest,
	).not.toBe(digest);
});
it("GitHub refuses a PR destination before making a write", async () => {
	const fetcher = vi.fn(
		async (url: string | URL | Request, _init?: RequestInit) =>
			Response.json(
				String(url).endsWith("/repos/owner/repo")
					? { id: 1 }
					: { number: 3, pull_request: { url: "x" } },
			),
	);
	const transport = new GitHubReleaseAccounting({
		repository: "owner/repo",
		repositoryId: 1,
		issueNumber: 3,
		writerId: 2,
		token: "test",
		fetch: fetcher,
	});
	await expect(
		transport.create("release-event:cycle:e1", event, digest),
	).rejects.toThrow();
	expect(
		fetcher.mock.calls.every(([, init]) => !init || init.method === "GET"),
	).toBe(true);
});

it("Linear rejects partial GraphQL data with errors and performs no mutation", async () => {
	const fetcher = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			Response.json({
				data: { issue: { id: "11111111-1111-4111-8111-111111111111" } },
				errors: [{ message: "partial failure" }],
			}),
	);
	const transport = new LinearReleaseAccounting({
		issueId: "11111111-1111-4111-8111-111111111111",
		writerId: "22222222-2222-4222-8222-222222222222",
		token: "test",
		fetch: fetcher,
	});
	await expect(
		transport.create("release-event:cycle:e1", event, digest),
	).rejects.toThrow();
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(
		JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).query,
	).not.toContain("mutation");
});

it("recovers a lost real-adapter create response by marker and verifies the original comment without reposting", async () => {
	const db = new Database(":memory:");
	try {
		const ledger = new CustomerReleaseAccounting(db);
		ledger.migrate();
		ledger.enqueue(event);
		let body: string | null = null;
		let posts = 0;
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				const u = String(url);
				if (u.endsWith("/repos/owner/repo")) return Response.json({ id: 1 });
				if (u.endsWith("/issues/3")) return Response.json({ number: 3 });
				if (u.endsWith("/user")) return Response.json({ id: 2 });
				if (u.includes("comments?"))
					return Response.json(body ? [{ id: 9, body }] : []);
				if (u.endsWith("/issues/3/comments") && init?.method === "POST") {
					posts++;
					body = JSON.parse(String(init.body)).body;
					throw new Error("lost create response");
				}
				if (u.endsWith("/issues/comments/9"))
					return Response.json({
						id: 9,
						body,
						user: { id: 2 },
						issue_url: "https://api.github.com/repos/owner/repo/issues/3",
					});
				throw new Error("unexpected request");
			},
		);
		const transport = new GitHubReleaseAccounting({
			repository: "owner/repo",
			repositoryId: 1,
			issueNumber: 3,
			writerId: 2,
			token: "test",
			fetch: fetcher,
		});
		await ledger.project("github", transport, 1000);
		expect(ledger.status(event.eventId, "github")?.state).toBe("pending");
		await ledger.project("github", transport, 31000);
		expect(posts).toBe(1);
		expect(ledger.status(event.eventId, "github")?.state).toBe("delivered");
	} finally {
		db.close();
	}
});
it("Linear refuses an incomplete scan even when its first page contains the marker", async () => {
	const fetcher = vi.fn(async () =>
		Response.json({
			data: {
				issue: {
					id: "11111111-1111-4111-8111-111111111111",
					comments: {
						nodes: [
							{
								id: "33333333-3333-4333-8333-333333333333",
								body: releaseAccountingBody(
									"release-event:cycle:e1",
									event,
									digest,
								),
							},
						],
						pageInfo: { hasNextPage: true, endCursor: "same" },
					},
				},
			},
		}),
	);
	const transport = new LinearReleaseAccounting({
		issueId: "11111111-1111-4111-8111-111111111111",
		writerId: "22222222-2222-4222-8222-222222222222",
		token: "test",
		fetch: fetcher,
	});
	await expect(transport.find("release-event:cycle:e1")).rejects.toThrow();
	expect(fetcher).toHaveBeenCalledTimes(2);
});
