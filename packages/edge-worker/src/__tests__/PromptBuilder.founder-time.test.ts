import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Comment } from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptBuilder } from "../PromptBuilder.js";

function comment(overrides: Partial<Comment>): Comment {
	return {
		id: "root",
		body: "root body",
		createdAt: new Date("2026-07-17T02:23:05.000Z"),
		parent: Promise.resolve(undefined),
		user: Promise.resolve({ displayName: "Annie" }),
		...overrides,
	} as Comment;
}

function builder(): PromptBuilder {
	return new PromptBuilder({
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		} as never,
		repositories: new Map(),
		issueTrackers: new Map(),
		gitService: {} as never,
		config: {} as never,
	});
}

afterEach(() => {
	delete process.env.FLYWHEEL_FOUNDER_TZ;
	vi.useRealTimers();
});

describe("FLY-1319 PromptBuilder founder-local timestamps", () => {
	it("labels root and reply instants with founder local time and timezone", async () => {
		process.env.FLYWHEEL_FOUNDER_TZ = "America/Los_Angeles";
		const root = comment({});
		const reply = comment({
			id: "reply",
			body: "reply body",
			createdAt: new Date("2026-07-17T02:24:05.000Z"),
			parent: Promise.resolve({ id: "root" } as never),
		});

		const output = await builder().formatCommentThreads([root, reply]);

		expect(output).toContain("<timestamp>2026-07-16 19:23 PDT</timestamp>");
		expect(output).toContain("<timestamp>2026-07-16 19:24 PDT</timestamp>");
	});

	it("uses a changed founder timezone on the next formatting request", async () => {
		process.env.FLYWHEEL_FOUNDER_TZ = "Asia/Tokyo";

		const output = await builder().formatCommentThreads([comment({})]);

		expect(output).toContain("<timestamp>2026-07-17 11:23 GMT+9</timestamp>");
	});

	it("labels the new-comment request timestamp with the same founder timezone", async () => {
		process.env.FLYWHEEL_FOUNDER_TZ = "Asia/Tokyo";
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-17T02:23:05.000Z"));
		const dir = await mkdtemp(join(tmpdir(), "fly1319-prompt-"));
		const template = join(dir, "prompt.md");
		await writeFile(
			template,
			"{{#if new_comment}}old{{/if}}\n{{comment_threads}}",
			"utf8",
		);
		const promptBuilder = new PromptBuilder({
			logger: {
				debug: () => {},
				info: () => {},
				warn: () => {},
				error: () => {},
			} as never,
			repositories: new Map(),
			issueTrackers: new Map(),
			gitService: {
				sanitizeBranchName: (value: string) => value,
				branchExists: async () => false,
			} as never,
			config: {} as never,
		});

		try {
			const result = await promptBuilder.buildIssueContextPrompt(
				{
					id: "issue-1",
					identifier: "FLY-1319",
					title: "Founder timezone",
					branchName: "fly-1319",
					state: Promise.resolve({ name: "Todo" }),
					parent: Promise.resolve(undefined),
					labels: async () => ({ nodes: [] }),
				} as never,
				{
					id: "repo",
					name: "flywheel",
					repositoryPath: "/tmp/flywheel",
					baseBranch: "main",
					promptTemplatePath: template,
				} as never,
				{ id: "comment-1", body: "new request" } as never,
			);

			expect(result.prompt).toContain(
				"<timestamp>2026-07-17 11:23 GMT+9</timestamp>",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
