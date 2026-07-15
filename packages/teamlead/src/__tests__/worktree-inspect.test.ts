/**
 * FLY-1282 M1: read-only unpushed-work inspection (worktree-inspect.ts).
 *
 * Contract under test (plan §1.1, Codex R1 #6):
 *   - NUL-separated `git status --porcelain=v1 -z --untracked-files=all`
 *     parsing (rename double-records, special-char paths, nested new dirs
 *     expanded per-file);
 *   - upstream existence decided by the EXIT CODE of
 *     `git rev-parse --abbrev-ref --symbolic-full-name @{u}` (never locale
 *     stderr text);
 *   - unpushed counts: `git rev-list --count @{u}..HEAD` (vs_upstream) or
 *     `git rev-list --count HEAD --not --remotes` (not_on_any_remote);
 *   - per-subquery independent failure (successful fields retained, bounded
 *     warnings);
 *   - path caps (10) with totals; never throws.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type ExecFileResult,
	inspectWorktreeForUnpushedWork,
} from "../bridge/worktree-inspect.js";

/** Build a fake execFile seam keyed by a matcher over the git argv. */
function fakeGit(
	handlers: Array<{
		match: (args: string[]) => boolean;
		result: () => Promise<ExecFileResult>;
	}>,
) {
	return vi.fn(
		async (
			_cmd: string,
			args: string[],
			_opts?: unknown,
		): Promise<ExecFileResult> => {
			for (const h of handlers) {
				if (h.match(args)) return h.result();
			}
			throw new Error(`unhandled git args: ${args.join(" ")}`);
		},
	);
}

const statusMatch = (a: string[]) => a.includes("status");
const branchMatch = (a: string[]) =>
	a.includes("rev-parse") && a.includes("--abbrev-ref") && !a.includes("@{u}");
const upstreamProbeMatch = (a: string[]) =>
	a.includes("rev-parse") && a.some((x) => x.includes("@{u}"));
const countUpstreamMatch = (a: string[]) =>
	a.includes("rev-list") && a.some((x) => x.includes("@{u}"));
const countNoRemoteMatch = (a: string[]) =>
	a.includes("rev-list") && a.includes("--not") && a.includes("--remotes");

function happyGit(overrides?: {
	statusOut?: string;
	upstreamExists?: boolean;
	upstreamCount?: string;
	noRemoteCount?: string;
}) {
	const upstreamExists = overrides?.upstreamExists ?? true;
	return fakeGit([
		{
			match: statusMatch,
			result: async () => ({
				stdout: overrides?.statusOut ?? "?? a.txt\0 M b.ts\0",
				stderr: "",
			}),
		},
		{
			match: branchMatch,
			result: async () => ({ stdout: "flywheel-FLY-1282\n", stderr: "" }),
		},
		{
			match: upstreamProbeMatch,
			result: async () => {
				if (!upstreamExists) {
					const err = new Error("exit 128") as Error & { code?: number };
					err.code = 128;
					throw err;
				}
				return { stdout: "origin/flywheel-FLY-1282\n", stderr: "" };
			},
		},
		{
			match: countUpstreamMatch,
			result: async () => ({
				stdout: `${overrides?.upstreamCount ?? "1"}\n`,
				stderr: "",
			}),
		},
		{
			match: countNoRemoteMatch,
			result: async () => ({
				stdout: `${overrides?.noRemoteCount ?? "4"}\n`,
				stderr: "",
			}),
		},
	]);
}

describe("inspectWorktreeForUnpushedWork", () => {
	it("missing/unknown path → ok:false without touching git", async () => {
		const git = fakeGit([]);
		const r = await inspectWorktreeForUnpushedWork(undefined, git as never);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/unknown or missing/);
		expect(git).not.toHaveBeenCalled();

		const r2 = await inspectWorktreeForUnpushedWork(
			"/nonexistent/path/definitely-not-here-1282",
			git as never,
		);
		expect(r2.ok).toBe(false);
		expect(git).not.toHaveBeenCalled();
	});

	it("happy path: NUL parsing splits untracked vs modified; branch + vs_upstream count", async () => {
		const git = happyGit({
			statusOut:
				"?? new-file.md\0?? nested/dir/deep.txt\0 M changed.ts\0A  staged.ts\0",
		});
		const r = await inspectWorktreeForUnpushedWork(process.cwd(), git as never);
		expect(r.ok).toBe(true);
		expect(r.branch).toBe("flywheel-FLY-1282");
		expect(r.untracked).toEqual(["new-file.md", "nested/dir/deep.txt"]);
		expect(r.modified).toEqual(["changed.ts", "staged.ts"]);
		expect(r.untrackedTotal).toBe(2);
		expect(r.modifiedTotal).toBe(2);
		expect(r.unpushedCommits).toBe(1);
		expect(r.unpushedSemantics).toBe("vs_upstream");
	});

	it("rename double-record (R -> two NUL fields) and space/special-char paths parse correctly", async () => {
		// porcelain v1 -z rename: "R  new\0old\0" — the OLD path is a bare
		// second field that must be consumed with the rename record.
		const git = happyGit({
			statusOut:
				"R  renamed to file.ts\0old name.ts\0?? weird\nname.txt\0 M spaced file.md\0",
		});
		const r = await inspectWorktreeForUnpushedWork(process.cwd(), git as never);
		expect(r.ok).toBe(true);
		expect(r.modified).toContain("renamed to file.ts");
		// old-path field must NOT appear as its own entry
		expect(r.modified).not.toContain("old name.ts");
		expect(r.untracked).toEqual(["weird\nname.txt"]);
		expect(r.modified).toContain("spaced file.md");
	});

	it("no upstream (probe exit != 0) → not_on_any_remote count, no locale-text sniffing", async () => {
		const git = happyGit({ upstreamExists: false, noRemoteCount: "4" });
		const r = await inspectWorktreeForUnpushedWork(process.cwd(), git as never);
		expect(r.ok).toBe(true);
		expect(r.unpushedCommits).toBe(4);
		expect(r.unpushedSemantics).toBe("not_on_any_remote");
	});

	it("big remote history, few local commits: counts come from rev-list, not log length", async () => {
		const git = happyGit({ upstreamExists: false, noRemoteCount: "2" });
		const r = await inspectWorktreeForUnpushedWork(process.cwd(), git as never);
		expect(r.unpushedCommits).toBe(2);
	});

	it("path caps at 10 with totals preserved", async () => {
		const files = Array.from({ length: 14 }, (_, i) => `?? f${i}.txt\0`).join(
			"",
		);
		const git = happyGit({ statusOut: files });
		const r = await inspectWorktreeForUnpushedWork(process.cwd(), git as never);
		expect(r.untracked).toHaveLength(10);
		expect(r.untrackedTotal).toBe(14);
	});

	it("one subquery failing keeps the successful fields (partial retention + bounded warnings)", async () => {
		const git = fakeGit([
			{
				match: statusMatch,
				result: async () => ({ stdout: "?? keep.txt\0", stderr: "" }),
			},
			{
				match: branchMatch,
				result: async () => {
					throw new Error("branch query exploded");
				},
			},
			{
				match: upstreamProbeMatch,
				result: async () => {
					throw new Error("upstream probe exploded hard");
				},
			},
		]);
		const r = await inspectWorktreeForUnpushedWork(process.cwd(), git as never);
		expect(r.ok).toBe(true); // at least one subquery succeeded
		expect(r.untracked).toEqual(["keep.txt"]);
		expect(r.branch).toBeUndefined();
		expect(r.unpushedCommits).toBeUndefined();
		expect(r.warnings?.length).toBeGreaterThan(0);
		expect(r.warnings!.length).toBeLessThanOrEqual(5);
		for (const w of r.warnings ?? []) expect(w.length).toBeLessThanOrEqual(200);
	});

	it("all subqueries failing → ok:false with bounded error, never throws", async () => {
		const git = fakeGit([
			{
				match: () => true,
				result: async () => {
					throw new Error("x".repeat(500));
				},
			},
		]);
		const r = await inspectWorktreeForUnpushedWork(process.cwd(), git as never);
		expect(r.ok).toBe(false);
		expect((r.error ?? "").length).toBeLessThanOrEqual(200);
	});

	it("clean worktree: empty lists, zero unpushed", async () => {
		const git = happyGit({ statusOut: "", upstreamCount: "0" });
		const r = await inspectWorktreeForUnpushedWork(process.cwd(), git as never);
		expect(r.ok).toBe(true);
		expect(r.untracked).toEqual([]);
		expect(r.modified).toEqual([]);
		expect(r.unpushedCommits).toBe(0);
	});
});

describe("code R1 #6 — entry validation + real total budget", () => {
	it("a regular file path is rejected before any git call", async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "fly1282-wtinspect-"));
		try {
			const file = join(dir, "not-a-dir");
			writeFileSync(file, "x");
			const exec = vi.fn();
			const out = await inspectWorktreeForUnpushedWork(file, exec as never);
			expect(out.ok).toBe(false);
			expect(out.error).toContain("not a directory");
			expect(exec).not.toHaveBeenCalled();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("per-call timeout shrinks to the remaining budget and late queries are refused (total ~10s is REAL)", async () => {
		vi.useFakeTimers();
		try {
			const timeouts: number[] = [];
			const exec = vi.fn(
				async (
					_cmd: string,
					_args: string[],
					opts?: { timeout?: number },
				): Promise<ExecFileResult> => {
					timeouts.push(opts?.timeout ?? -1);
					// each call burns 4s of wall clock (slow but under per-call cap)
					vi.setSystemTime(Date.now() + 4_000);
					return { stdout: "", stderr: "" };
				},
			);
			const out = await inspectWorktreeForUnpushedWork(
				process.cwd(),
				exec as never,
			);
			// status(4s) + branch(4s) land at 8s; the upstream probe still fits
			// with a SHRUNK 2s timeout (min(5s, 10s-8s)); the count query is then
			// refused by the budget check — never a 4th 5s call.
			expect(exec).toHaveBeenCalledTimes(3);
			expect(timeouts[0]).toBe(5_000);
			expect(timeouts[1]).toBe(5_000);
			expect(timeouts[2]).toBeLessThanOrEqual(2_000);
			expect(out.unpushedCommits).toBeUndefined();
			expect(JSON.stringify(out.warnings ?? [])).toContain("budget");
		} finally {
			vi.useRealTimers();
		}
	});
});
