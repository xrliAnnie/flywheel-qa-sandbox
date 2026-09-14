import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FrozenGitReader } from "../git-input.js";

describe("frozen Git input reader", () => {
	it("reads the pinned blob and rename diff, rejecting symlinks and unsafe paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "ship-input-"));
		const work = join(root, "work"),
			bare = join(root, "objects.git");
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		try {
			git("init", "-q", "-b", "main", work);
			git("-C", work, "config", "user.name", "Fixture");
			git("-C", work, "config", "user.email", "test@example.invalid");
			writeFileSync(join(work, "plan.md"), "approved requirement\n");
			writeFileSync(join(work, "old.ts"), "export const value = 1;\n");
			writeFileSync(join(work, "large.md"), "x".repeat(262145));
			symlinkSync("/etc/passwd", join(work, "link.md"));
			git("-C", work, "add", ".");
			git("-C", work, "commit", "-qm", "base");
			const base = git("-C", work, "rev-parse", "HEAD");
			git("-C", work, "mv", "old.ts", "new.ts");
			git("-C", work, "commit", "-qm", "rename");
			const head = git("-C", work, "rev-parse", "HEAD");
			git("clone", "--bare", "-q", work, bare);
			writeFileSync(join(work, "plan.md"), "unapproved local edit\n");
			const reader = new FrozenGitReader(bare);
			expect(await reader.listTextFiles(head, "")).toEqual([
				"large.md",
				"link.md",
				"plan.md",
			]);
			expect(await reader.readText(head, "plan.md")).toMatchObject({
				text: "approved requirement\n",
			});
			expect(await reader.mergeBase(base, head)).toBe(base);
			const diff = await reader.diff(base, head);
			expect(diff.files).toEqual([
				{ path: "new.ts", previous_path: "old.ts", status: "R100" },
			]);
			expect(diff.text).toContain("rename from old.ts");
			await expect(reader.readText(head, "link.md")).rejects.toThrow(
				"git_blob_not_regular",
			);
			await expect(reader.readText(head, "../plan.md")).rejects.toThrow();
			await expect(reader.readText("bad-head", "plan.md")).rejects.toThrow();
			await expect(reader.readText(head, "large.md")).rejects.toThrow(
				"git_blob_budget_exceeded",
			);
			expect(git("-C", work, "status", "--porcelain")).toContain("plan.md");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
