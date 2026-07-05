import { describe, expect, it, vi } from "vitest";
import { type ProgressDeps, runProgress } from "../progress.js";

/**
 * FLY-795 c2: `flywheel-comm progress` — the single-writer, path-limited,
 * atomic progress.md writer. Codex R1 #3 (StateStore fail-closed single-writer),
 * #4 (atomic path-limited commit, no code sweep), #5 (path validation).
 */
function makeDeps(over: Partial<ProgressDeps> = {}): ProgressDeps {
	const files = new Map<string, string>();
	return {
		env: { FLYWHEEL_STATE_DB_PATH: "/fake/teamlead.db" },
		cwd: () => "/repo",
		readSession: vi.fn(() => ({
			status: "running",
			session_role: "implement",
			issue_identifier: "FLY-795",
		})),
		existsSync: (p: string) => files.has(p),
		readFileSync: (p: string) => {
			const v = files.get(p);
			if (v == null) throw new Error(`ENOENT ${p}`);
			return v;
		},
		writeTempAndRename: vi.fn((p: string, content: string) => {
			files.set(p, content);
		}),
		restoreFile: vi.fn((p: string, content: string | null) => {
			if (content === null) files.delete(p);
			else files.set(p, content);
		}),
		git: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
		...over,
		_files: files,
	} as ProgressDeps & { _files: Map<string, string> };
}

const okArgs = {
	execId: "e1",
	file: "engineering/doc/FLY-795-x/progress.md",
	phase: "implement",
	cursor: "2/5",
	next: "wire the resume mode",
};

describe("runProgress (FLY-795)", () => {
	it("writes + path-limited commits progress.md when exec is the active writer", () => {
		const deps = makeDeps();
		const r = runProgress(okArgs, deps);
		expect(r.ok).toBe(true);
		// wrote the ledger (temp+rename)
		expect(deps.writeTempAndRename).toHaveBeenCalledOnce();
		const written = (deps as any)._files.get(
			"/repo/engineering/doc/FLY-795-x/progress.md",
		);
		expect(written).toContain("phase: implement");
		// path-limited commit — MUST use `commit --only -- <file>` (never sweep code)
		const gitCalls = (deps.git as any).mock.calls.map((c: any[]) => c[0]);
		const commitCall = gitCalls.find((a: string[]) => a.includes("commit"));
		expect(commitCall).toBeTruthy();
		expect(commitCall).toContain("--only");
		expect(commitCall).toContain("--");
		expect(commitCall.at(-1)).toContain("progress.md");
	});

	it("fail-closed: rejects when the session is not running (dead/terminated writer)", () => {
		const deps = makeDeps({
			readSession: vi.fn(() => ({
				status: "terminated",
				session_role: "implement",
				issue_identifier: "FLY-795",
			})),
		});
		const r = runProgress(okArgs, deps);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/writer|running|active/i);
		expect(deps.writeTempAndRename).not.toHaveBeenCalled();
	});

	it("fail-closed: rejects when the session row is absent", () => {
		const deps = makeDeps({ readSession: vi.fn(() => undefined) });
		const r = runProgress(okArgs, deps);
		expect(r.ok).toBe(false);
		expect(deps.git).not.toHaveBeenCalled();
	});

	it("rejects an escaping --file (absolute / .. / wrong issue prefix)", () => {
		for (const file of [
			"/etc/passwd",
			"engineering/doc/../../../etc/x/progress.md",
			"engineering/doc/FLY-999-x/progress.md", // wrong issue prefix
		]) {
			const deps = makeDeps();
			const r = runProgress({ ...okArgs, file }, deps);
			expect(r.ok, `file=${file}`).toBe(false);
			expect(deps.writeTempAndRename).not.toHaveBeenCalled();
		}
	});

	it("merges into an existing progress.md (preserves prior chunks)", () => {
		const deps = makeDeps();
		(deps as any)._files.set(
			"/repo/engineering/doc/FLY-795-x/progress.md",
			[
				"---",
				"issue: FLY-795",
				"phase: design",
				"chunks:",
				"  - { id: c1, order: 1, deps: [], done: prior, status: done }",
				"pointers: {}",
				"---",
				"",
				"# body",
			].join("\n"),
		);
		const r = runProgress({ ...okArgs, next: "next thing" }, deps);
		expect(r.ok).toBe(true);
		const written = (deps as any)._files.get(
			"/repo/engineering/doc/FLY-795-x/progress.md",
		);
		expect(written).toContain("phase: implement"); // updated
		expect(written).toContain("c1"); // prior chunk preserved
	});

	it("fail-closed: a git commit failure does not report success", () => {
		const deps = makeDeps({
			git: vi.fn((a: string[]) =>
				a.includes("commit")
					? { stdout: "", stderr: "hook failed", status: 1 }
					: { stdout: "", stderr: "", status: 0 },
			),
		});
		const r = runProgress(okArgs, deps);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/commit/i);
	});

	it("MED-5: restores the prior progress.md when the commit fails (no half-write)", () => {
		const path = "/repo/engineering/doc/FLY-795-x/progress.md";
		const deps = makeDeps({
			git: vi.fn((a: string[]) =>
				a.includes("commit")
					? { stdout: "", stderr: "hook failed", status: 1 }
					: { stdout: "", stderr: "", status: 0 },
			),
		});
		// no prior file existed → after a failed commit it must be removed (restore null)
		const r = runProgress(okArgs, deps);
		expect(r.ok).toBe(false);
		expect(deps.restoreFile).toHaveBeenCalledWith(path, null);
		expect((deps as any)._files.has(path)).toBe(false);
	});

	it("MED-5: rejects a stale predecessor that is not the current active writer", () => {
		const deps = makeDeps({
			latestActiveExecId: vi.fn(() => "e2-newer"),
		});
		const r = runProgress(okArgs, deps); // okArgs.execId = "e1"
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/active writer/i);
		expect(deps.writeTempAndRename).not.toHaveBeenCalled();
	});

	it("MED-5: allows the write when exec-id IS the current active writer", () => {
		const deps = makeDeps({
			latestActiveExecId: vi.fn(() => "e1"),
		});
		const r = runProgress(okArgs, deps);
		expect(r.ok).toBe(true);
	});

	it("MED-5: rejects a --phase that contradicts the authoritative StateStore stage", () => {
		const deps = makeDeps({
			readSession: vi.fn(() => ({
				status: "running",
				session_role: "implement",
				issue_identifier: "FLY-795",
				session_stage: "brainstorm", // → design phase
			})),
		});
		const r = runProgress({ ...okArgs, phase: "implement" }, deps);
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/contradicts|stage/i);
		expect(deps.writeTempAndRename).not.toHaveBeenCalled();
	});

	it("MED-5: runs the critical section under the per-worktree lock when provided", () => {
		const calls: string[] = [];
		const deps = makeDeps({
			withLock: vi.fn((_p: string, fn: () => unknown) => {
				calls.push("lock");
				const out = fn();
				calls.push("unlock");
				return out;
			}),
		});
		const r = runProgress(okArgs, deps);
		expect(r.ok).toBe(true);
		expect(calls).toEqual(["lock", "unlock"]);
	});
});
