import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../ProjectConfig.js";

interface ResolverModule {
	resolveProjectIssueThread(
		store: {
			getSessionByIdentifier: ReturnType<typeof vi.fn>;
			getChatThreadByIssue: ReturnType<typeof vi.fn>;
		},
		projects: ProjectEntry[],
		issueIdentifier: string,
		projectName: string,
	): string | undefined;
}

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{ agentId: "eng", chatChannel: "chan-eng", match: { labels: ["eng"] } },
			{
				agentId: "product",
				chatChannel: "chan-product",
				match: { labels: ["product"] },
			},
		],
	},
] as ProjectEntry[];

async function loadResolver(): Promise<ResolverModule | null> {
	const modulePath = "../bridge/report-issue-thread-resolver.js";
	return import(/* @vite-ignore */ modulePath).catch(
		() => null,
	) as Promise<ResolverModule | null>;
}

describe("resolveProjectIssueThread", () => {
	it("uses the session canonical issue key and returns the sole matching Lead thread", async () => {
		const module = await loadResolver();
		expect(module).not.toBeNull();
		if (!module) return;

		const store = {
			getSessionByIdentifier: vi
				.fn()
				.mockReturnValue({ issue_id: "canonical-fly-1463" }),
			getChatThreadByIssue: vi
				.fn()
				.mockReturnValueOnce({
					thread_id: "thread-eng",
					channel_id: "chan-eng",
				})
				.mockReturnValueOnce(undefined),
		};

		expect(
			module.resolveProjectIssueThread(store, projects, "FLY-1463", "flywheel"),
		).toBe("thread-eng");
		expect(store.getChatThreadByIssue).toHaveBeenNthCalledWith(
			1,
			"canonical-fly-1463",
			"chan-eng",
		);
	});

	it("returns undefined instead of guessing when multiple Lead channels match", async () => {
		const module = await loadResolver();
		expect(module).not.toBeNull();
		if (!module) return;

		const store = {
			getSessionByIdentifier: vi.fn().mockReturnValue(undefined),
			getChatThreadByIssue: vi
				.fn()
				.mockReturnValueOnce({
					thread_id: "thread-eng",
					channel_id: "chan-eng",
				})
				.mockReturnValueOnce({
					thread_id: "thread-product",
					channel_id: "chan-product",
				}),
		};

		expect(
			module.resolveProjectIssueThread(store, projects, "FLY-1463", "flywheel"),
		).toBeUndefined();
	});

	it("returns undefined for an unknown project or no matching thread", async () => {
		const module = await loadResolver();
		expect(module).not.toBeNull();
		if (!module) return;

		const store = {
			getSessionByIdentifier: vi.fn().mockReturnValue(undefined),
			getChatThreadByIssue: vi.fn().mockReturnValue(undefined),
		};

		expect(
			module.resolveProjectIssueThread(store, projects, "FLY-1463", "unknown"),
		).toBeUndefined();
		expect(
			module.resolveProjectIssueThread(store, projects, "FLY-1463", "flywheel"),
		).toBeUndefined();
	});
});
