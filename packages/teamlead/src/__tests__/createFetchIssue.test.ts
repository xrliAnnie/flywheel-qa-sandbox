import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatThreadCreator } from "../bridge/ChatThreadCreator.js";
import { createFetchIssue } from "../bridge/run-infra.js";
import { DirectEventSink } from "../DirectEventSink.js";
import { StateStore } from "../StateStore.js";

/**
 * FLY-137 wire-up fix — Bug 2: createFetchIssue must pass `LINEAR_API_KEY`
 * to LinearClient as `apiKey` (personal API key path), not `accessToken`
 * (OAuth Bearer path). The previous `accessToken` form caused Linear to
 * reject every request ("It looks like you're trying to use an API key as
 * a Bearer token"), and a silent catch swallowed the error so PreHydrator
 * returned no labels → session.issue_labels stored as "[]" → AgentDispatcher,
 * dept-scope, and event-route stage routing all degraded silently.
 *
 * These tests guard against accessToken regression and the silent-catch
 * regression that hid it for months.
 */

interface MockedLinearIssue {
	title: string;
	description: string | null;
	identifier: string;
	updatedAt: Date;
	labels: () => Promise<{ nodes: Array<{ name: string }> }>;
	project: Promise<{ id: string } | null>;
	projectId?: string;
}

interface CapturedClient {
	ctor: Record<string, unknown>;
}

const captured: CapturedClient = { ctor: {} };

let issueResolver: (id: string) => MockedLinearIssue | null = () => null;
let issueShouldThrow: Error | undefined;

vi.mock("@linear/sdk", () => ({
	LinearClient: class {
		constructor(opts: Record<string, unknown>) {
			captured.ctor = opts;
		}
		async issue(id: string) {
			if (issueShouldThrow) throw issueShouldThrow;
			return issueResolver(id);
		}
	},
}));

const stubStore = {
	getSessionByIssue: () => undefined,
} as unknown as StateStore;

describe("createFetchIssue (FLY-137 wire-up fix)", () => {
	const ORIG = process.env.LINEAR_API_KEY;
	beforeEach(() => {
		captured.ctor = {};
		issueResolver = () => null;
		issueShouldThrow = undefined;
	});
	afterEach(() => {
		if (ORIG === undefined) delete process.env.LINEAR_API_KEY;
		else process.env.LINEAR_API_KEY = ORIG;
		vi.restoreAllMocks();
	});

	it("constructs LinearClient with { apiKey } — NOT { accessToken } (Bug 2 root cause)", async () => {
		process.env.LINEAR_API_KEY = "lin_api_test_key_12345";
		issueResolver = (id) => ({
			title: `Issue ${id}`,
			description: "Body",
			identifier: id,
			updatedAt: new Date("2026-08-15T01:02:03.000Z"),
			labels: async () => ({ nodes: [{ name: "designer" }] }),
			project: Promise.resolve({ id: "proj-1" }),
			projectId: "proj-1",
		});

		const fetchIssue = createFetchIssue(stubStore);
		const result = await fetchIssue("GEO-372");

		// The whole point of this fix: LINEAR_API_KEY is a personal API key,
		// not an OAuth access token. Linear SDK distinguishes these via the
		// constructor option name. `apiKey` MUST be the carrier.
		expect(captured.ctor).toHaveProperty("apiKey", "lin_api_test_key_12345");
		expect(captured.ctor).not.toHaveProperty("accessToken");

		// Labels MUST flow through — pre-fix this was always [].
		expect(result.labels).toEqual(["designer"]);
		expect(result.identifier).toBe("GEO-372");
		expect(result.descriptionSource).toBe("authoritative");
		expect(result.updatedAt).toBe("2026-08-15T01:02:03.000Z");
		expect(result.projectId).toBe("proj-1");
	});

	it("reads the synchronous project id without creating an orphan SDK request", async () => {
		process.env.LINEAR_API_KEY = "fixture-key";
		const project = vi.fn(() => Promise.reject(new Error("Fetch failed")));
		issueResolver = (id) => ({
			title: "Authoritative title",
			description: "Authoritative body",
			identifier: id,
			updatedAt: new Date("2026-09-25T00:00:00Z"),
			labels: async () => ({ nodes: [{ name: "Product" }] }),
			projectId: "project-1",
			get project() {
				return project();
			},
		});

		const result = await createFetchIssue(stubStore)("FLY-2917");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(project).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			projectId: "project-1",
			title: "Authoritative title",
			description: "Authoritative body",
			descriptionSource: "authoritative",
			labels: ["Product"],
		});
	});

	it.each(["issue", "labels"])(
		"creates the real chat thread from StateStore when the SDK %s fetch fails",
		async (failure) => {
			process.env.LINEAR_API_KEY = "fixture-key";
			vi.spyOn(console, "warn").mockImplementation(() => {});
			if (failure === "issue") issueShouldThrow = new Error("Fetch failed");
			issueResolver = (id) => ({
				title: "Live title",
				description: "Live body",
				identifier: id,
				updatedAt: new Date(),
				labels: async () => {
					throw new Error("Fetch failed");
				},
				project: Promise.resolve(null),
			});
			const store = await StateStore.create(":memory:");
			try {
				store.upsertSession({
					execution_id: "previous",
					issue_id: "FLY-2917",
					project_name: "fixture",
					issue_identifier: "FLY-2917",
					issue_title: "Cached title",
					summary: "Cached body",
					status: "running",
				});
				const fetch = vi.fn(async () => ({
					ok: true,
					json: async () => ({ id: "root-2917" }),
				}));
				vi.stubGlobal("fetch", fetch);
				const hydrated = await createFetchIssue(store)("FLY-2917");
				expect(hydrated.descriptionSource).toBe("fallback");
				const creator = new ChatThreadCreator(store);
				const sink = new DirectEventSink(
					store,
					{
						host: "127.0.0.1",
						port: 0,
						dbPath: ":memory:",
						ingestToken: "fixture",
						notificationChannel: "fixture",
						defaultLeadAgentId: "fixture-lead",
						stuckThresholdMinutes: 15,
						stuckCheckIntervalMs: 300000,
						orphanThresholdMinutes: 60,
						chatThreadsEnabled: true,
						discordBotToken: "fixture",
					},
					[
						{
							projectName: "fixture",
							projectRoot: "/tmp/fly2917-fixture",
							projectRepo: "fixture/repo",
							leads: [
								{
									agentId: "fixture-lead",
									chatChannel: "chat-2917",
									match: { labels: ["Product"] },
								},
							],
						},
					],
					undefined,
					undefined,
					creator,
				);
				await expect(
					sink.emitStarted({
						executionId: "current",
						issueId: "FLY-2917",
						projectName: "fixture",
						issueIdentifier: hydrated.identifier,
						issueTitle: hydrated.title,
						labels: ["Product"],
					}),
				).resolves.toBeUndefined();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(
					store.getChatThreadByIssue("FLY-2917", "chat-2917")?.thread_id,
				).toBe("root-2917");
				// Real creator completed both Discord operations with the cached title.
				expect(fetch).toHaveBeenCalledWith(
					expect.stringContaining("/messages/root-2917/threads"),
					expect.objectContaining({
						body: expect.stringContaining("Cached title"),
					}),
				);
			} finally {
				store.close();
			}
		},
	);

	it("returns multiple labels in original case (no lowercase mutation here — done at runs-route boundary)", async () => {
		process.env.LINEAR_API_KEY = "lin_api_test_key_12345";
		issueResolver = (id) => ({
			title: `Issue ${id}`,
			description: "",
			identifier: id,
			updatedAt: new Date("2026-08-15T01:02:03.000Z"),
			labels: async () => ({
				nodes: [
					{ name: "designer" },
					{ name: "Product" },
					{ name: "current-sprint" },
				],
			}),
			project: Promise.resolve(null),
		});

		const result = await createFetchIssue(stubStore)("uuid-abc");
		expect(result.labels).toEqual(["designer", "Product", "current-sprint"]);
	});

	it("falls back to StateStore when LINEAR_API_KEY is unset (no labels)", async () => {
		delete process.env.LINEAR_API_KEY;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fakeStore = {
			getSessionByIssue: () => ({
				issue_title: "Stub Title",
				issue_identifier: "GEO-001",
				summary: "Stub summary",
			}),
		} as unknown as StateStore;

		const result = await createFetchIssue(fakeStore)("uuid-x");

		expect(result.title).toBe("Stub Title");
		expect(result.identifier).toBe("GEO-001");
		expect(result.descriptionSource).toBe("fallback");
		// The previous silent code path returned no labels field; the fallback
		// must keep that contract (labels remain absent, NOT empty array, so
		// PreHydrator's `?? []` semantics still kick in).
		expect(result.labels).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("LINEAR_API_KEY not set"),
		);
	});

	it("logs a warning when Linear throws (previously silent — concealed accessToken bug for months)", async () => {
		process.env.LINEAR_API_KEY = "lin_api_test_key_12345";
		issueShouldThrow = new Error(
			"It looks like you're trying to use an API key as a Bearer token",
		);
		const fakeStore = {
			getSessionByIssue: () => undefined,
		} as unknown as StateStore;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await createFetchIssue(fakeStore)("uuid-y");

		// Falls back to StateStore stub
		expect(result.title).toContain("Issue uuid-y");
		// Critical: error MUST be logged so future regressions are visible.
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Linear fetchIssue(uuid-y) failed"),
		);
	});
});
