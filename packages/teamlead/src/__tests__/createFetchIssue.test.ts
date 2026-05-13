import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchIssue } from "../bridge/run-infra.js";
import type { StateStore } from "../StateStore.js";

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
	labels: () => Promise<{ nodes: Array<{ name: string }> }>;
	project: Promise<{ id: string } | null>;
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
			labels: async () => ({ nodes: [{ name: "designer" }] }),
			project: Promise.resolve({ id: "proj-1" }),
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
	});

	it("returns multiple labels in original case (no lowercase mutation here — done at runs-route boundary)", async () => {
		process.env.LINEAR_API_KEY = "lin_api_test_key_12345";
		issueResolver = (id) => ({
			title: `Issue ${id}`,
			description: "",
			identifier: id,
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
