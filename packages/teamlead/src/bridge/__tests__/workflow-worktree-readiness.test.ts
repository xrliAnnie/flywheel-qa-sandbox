import { describe, expect, it, vi } from "vitest";
import { assertWorkflowWorktreeReady } from "../workflow-worktree-readiness.js";

describe("FLY-1940 workflow worktree baseline", () => {
	it("accepts the exact delivered head without an ancestry probe", async () => {
		const execGit = vi.fn(async () => ({ stdout: `${"a".repeat(40)}\n` }));
		await expect(
			assertWorkflowWorktreeReady("/work", "a".repeat(40), {
				exists: () => true,
				clean: async () => true,
				execGit,
			}),
		).resolves.toEqual({ ok: true });
		expect(execGit).toHaveBeenCalledTimes(1);
	});

	it("accepts a clean fast-forward descendant such as a QA report commit", async () => {
		const actual = "b".repeat(40);
		const base = "a".repeat(40);
		const execGit = vi
			.fn()
			.mockResolvedValueOnce({ stdout: `${actual}\n` })
			.mockResolvedValueOnce({ stdout: "" });
		await expect(
			assertWorkflowWorktreeReady("/work", base, {
				exists: () => true,
				clean: async () => true,
				execGit,
			}),
		).resolves.toEqual({ ok: true });
		expect(execGit).toHaveBeenLastCalledWith([
			"-C",
			"/work",
			"merge-base",
			"--is-ancestor",
			base,
			actual,
		]);
	});

	it("rejects a non-fast-forward rewrite", async () => {
		const actual = "b".repeat(40);
		const base = "a".repeat(40);
		const nonAncestor = Object.assign(new Error("not ancestor"), { code: 1 });
		const execGit = vi
			.fn()
			.mockResolvedValueOnce({ stdout: `${actual}\n` })
			.mockRejectedValueOnce(nonAncestor);
		await expect(
			assertWorkflowWorktreeReady("/work", base, {
				exists: () => true,
				clean: async () => true,
				execGit,
			}),
		).resolves.toEqual({
			ok: false,
			reason: `head_not_fast_forward:${actual}:${base}`,
		});
	});
});
