import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexFounderPreflight } from "../../CodexFounderPreflight.js";
import type { DerivedToolContext } from "../GatewayDispatcher.js";
import { AmbiguousTargetError, resolveExactlyOne } from "../resolve-target.js";
import {
	canonicalizeTargetWorktree,
	deriveTargetPrHead,
	type GitRunner,
	makeShipPreflight,
	makeTrustedGitRunner,
	resolveTrustedGitPath,
} from "../ship-preflight.js";

/** The first absolute git on this box, or null (skip the real-git integration). */
function realGit(): string | null {
	try {
		return resolveTrustedGitPath({});
	} catch {
		return null;
	}
}

const SHA = "a".repeat(40);

/** A fake git that returns scripted output per subcommand. */
function fakeGit(
	scripts: Record<
		string,
		{ stdout?: string; stderr?: string; status?: number }
	>,
): GitRunner {
	return (args) => {
		const key = args[0];
		const s = scripts[key] ?? { status: 0, stdout: "" };
		return {
			stdout: s.stdout ?? "",
			stderr: s.stderr ?? "",
			status: s.status ?? 0,
		};
	};
}

describe("resolveExactlyOne (§5.4 target resolution)", () => {
	const describe1 = (c: { execId: string }) => `exec ${c.execId}`;

	it("returns the single candidate", () => {
		expect(
			resolveExactlyOne({
				candidates: [{ execId: "x" }],
				describe: describe1,
				intent: "ship FLY-1",
			}),
		).toEqual({ execId: "x" });
	});

	it("fail-closed on zero candidates", () => {
		expect(() =>
			resolveExactlyOne({
				candidates: [],
				describe: describe1,
				intent: "ship FLY-1",
			}),
		).toThrow(AmbiguousTargetError);
	});

	it("fail-closed on multiple, carrying candidate descriptions", () => {
		try {
			resolveExactlyOne({
				candidates: [{ execId: "a" }, { execId: "b" }],
				describe: describe1,
				intent: "terminate FLY-2",
			});
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(AmbiguousTargetError);
			expect((e as AmbiguousTargetError).candidateDescriptions).toEqual([
				"exec a",
				"exec b",
			]);
		}
	});
});

describe("deriveTargetPrHead (R1#8 — target worktree, not Lead workspace)", () => {
	it("returns the 40-hex HEAD from the target worktree", () => {
		const git = fakeGit({
			"rev-parse": { stdout: `${SHA}\n` },
			status: { stdout: "" },
		});
		expect(deriveTargetPrHead("/work/runner-1", git)).toBe(SHA);
	});

	it("reads HEAD from the GIVEN worktree path (never an implicit cwd)", () => {
		const seen: string[] = [];
		const git: GitRunner = (args, cwd) => {
			seen.push(cwd);
			return args[0] === "rev-parse"
				? { stdout: `${SHA}\n`, stderr: "", status: 0 }
				: { stdout: "", stderr: "", status: 0 };
		};
		deriveTargetPrHead("/work/runner-7", git);
		expect(new Set(seen)).toEqual(new Set(["/work/runner-7"]));
	});

	it("fail-closed on a missing worktree path", () => {
		expect(() => deriveTargetPrHead(undefined, fakeGit({}))).toThrow(
			/no worktree_path/,
		);
		expect(() => deriveTargetPrHead("  ", fakeGit({}))).toThrow(
			/no worktree_path/,
		);
	});

	it("fail-closed on a git rev-parse failure", () => {
		const git = fakeGit({ "rev-parse": { status: 128, stderr: "not a repo" } });
		expect(() => deriveTargetPrHead("/work/x", git)).toThrow(
			/rev-parse HEAD failed/,
		);
	});

	it("fail-closed on a non-40-hex head", () => {
		const git = fakeGit({
			"rev-parse": { stdout: "HEAD\n" },
			status: { stdout: "" },
		});
		expect(() => deriveTargetPrHead("/work/x", git)).toThrow(/non-40-hex/);
	});

	// Codex R3 HIGH: the dirty check (`git status`) was REMOVED — it runs
	// worktree-controlled filter drivers in the privileged gateway. Only the
	// refs-only `rev-parse HEAD` remains; the prHead binding + the Runner's
	// verify-approval are the ship authority.
	it("runs ONLY rev-parse — never `git status` (no filter-driver surface)", () => {
		const subcommands: string[] = [];
		const git: GitRunner = (args) => {
			subcommands.push(args[0] as string);
			return args[0] === "rev-parse"
				? { stdout: `${SHA}\n`, stderr: "", status: 0 }
				: { stdout: "", stderr: "", status: 0 };
		};
		expect(deriveTargetPrHead("/work/x", git)).toBe(SHA);
		expect(subcommands).toEqual(["rev-parse"]);
		expect(subcommands).not.toContain("status");
	});
});

// Codex code-review R1 HIGH-5: the gateway is UNSANDBOXED and holds secrets in
// memory — git must be an ABSOLUTE trusted binary (never PATH-resolved), and the
// worktree must be canonicalized + ownership-validated before it becomes a cwd.
describe("resolveTrustedGitPath (HIGH-5: no PATH lookup)", () => {
	it("uses FLYWHEEL_GIT_PATH when it is absolute + exists", () => {
		const path = resolveTrustedGitPath(
			{ FLYWHEEL_GIT_PATH: "/custom/git" },
			{ existsSync: (p) => p === "/custom/git" },
		);
		expect(path).toBe("/custom/git");
	});

	it("falls back to the first existing system location (never $PATH)", () => {
		const path = resolveTrustedGitPath(
			{},
			{ existsSync: (p) => p === "/opt/homebrew/bin/git" },
		);
		expect(path).toBe("/opt/homebrew/bin/git");
	});

	it("rejects a non-absolute FLYWHEEL_GIT_PATH (no PATH-relative binary)", () => {
		expect(() =>
			resolveTrustedGitPath(
				{ FLYWHEEL_GIT_PATH: "git" },
				{ existsSync: () => true },
			),
		).toThrow(/absolute/i);
	});

	it("fail-closed when no trusted git binary is found", () => {
		expect(() =>
			resolveTrustedGitPath({}, { existsSync: () => false }),
		).toThrow(/no trusted git/i);
	});
});

// Codex R2 new HIGH + R3: repo-LOCAL git config/attributes must NOT execute code
// in the unsandboxed secret-bearing gateway. The `-c` overrides cover named keys
// like `core.fsmonitor`, but a worktree-controlled `.gitattributes` can name an
// ARBITRARY `filter.<x>.clean/process` that `git status` runs — which no fixed
// `-c` list can enumerate. The R3 fix removes the status/dirty check entirely:
// `deriveTargetPrHead` runs ONLY `git rev-parse HEAD`, which loads no attributes
// and runs no working-tree filter. These integration tests prove BOTH the named
// vector (fsmonitor) AND the unbounded vector (filter driver via .gitattributes)
// never execute through the real preflight path.
describe("deriveTargetPrHead — no repo-controlled code execution (real git)", () => {
	const git = realGit();
	const maybe = git ? it : it.skip;

	function initRepoWithCommit(repo: string): void {
		execFileSync(git as string, ["init", "-q", repo]);
		execFileSync(git as string, ["-C", repo, "config", "user.email", "t@t"]);
		execFileSync(git as string, ["-C", repo, "config", "user.name", "t"]);
		writeFileSync(join(repo, "f.txt"), "hi\n");
		execFileSync(git as string, ["-C", repo, "add", "."]);
		execFileSync(git as string, ["-C", repo, "commit", "-q", "-m", "init"]);
	}

	maybe(
		"a planted core.fsmonitor does NOT execute through deriveTargetPrHead (rev-parse only)",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "fly245-git-fsmon-"));
			try {
				const sentinel = join(dir, "PWNED");
				const hook = join(dir, "fsmonitor-hook.sh");
				writeFileSync(hook, `#!/bin/sh\ntouch "${sentinel}"\nexit 0\n`);
				chmodSync(hook, 0o755);
				const repo = join(dir, "repo");
				initRepoWithCommit(repo);
				execFileSync(git as string, [
					"-C",
					repo,
					"config",
					"core.fsmonitor",
					hook,
				]);
				const runner = makeTrustedGitRunner(git as string);
				const sha = deriveTargetPrHead(repo, runner);
				expect(sha).toMatch(/^[0-9a-f]{40}$/);
				expect(existsSync(sentinel)).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	maybe(
		"a worktree .gitattributes + arbitrary filter.<x>.clean does NOT execute (the unbounded R3 vector)",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "fly245-git-filter-"));
			try {
				const sentinel = join(dir, "PWNED");
				const repo = join(dir, "repo");
				initRepoWithCommit(repo);
				// attacker names an arbitrary filter on a tracked path + defines it
				writeFileSync(join(repo, ".gitattributes"), "f.txt filter=pwn\n");
				execFileSync(git as string, [
					"-C",
					repo,
					"config",
					"filter.pwn.clean",
					`sh -c 'touch ${JSON.stringify(sentinel)}; cat'`,
				]);
				// make the working file differ so a checkin filter would run on it
				writeFileSync(join(repo, "f.txt"), "changed\n");

				// Control: a real working-tree git op (`git add`, the canonical
				// checkin-filter trigger) DOES execute the `clean` filter — ASSERT it
				// fired (R4 LOW: the regression is meaningless if the control silently
				// never fires). `git status`'s stat-cache can skip re-hashing on some
				// builds, so we use `git add` for a deterministic trigger; the point
				// is identical — a worktree-controlled filter runs arbitrary code when
				// git processes working-tree content, which `rev-parse` never does.
				try {
					execFileSync(git as string, ["-C", repo, "add", "f.txt"]);
				} catch {
					/* filter may exit non-zero; we only care whether it ran */
				}
				expect(existsSync(sentinel)).toBe(true);
				rmSync(sentinel, { force: true });

				// deriveTargetPrHead (rev-parse only) must NOT execute the filter.
				const runner = makeTrustedGitRunner(git as string);
				const sha = deriveTargetPrHead(repo, runner);
				expect(sha).toMatch(/^[0-9a-f]{40}$/);
				expect(existsSync(sentinel)).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	maybe(
		"rev-parse HEAD still returns the committed head (safety -c doesn't break it)",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "fly245-git-ok-"));
			try {
				const repo = join(dir, "repo");
				initRepoWithCommit(repo);
				const runner = makeTrustedGitRunner(git as string);
				expect(deriveTargetPrHead(repo, runner)).toMatch(/^[0-9a-f]{40}$/);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});

describe("canonicalizeTargetWorktree (HIGH-5: realpath + ownership)", () => {
	const okFs = {
		realpathSync: (p: string) => p.replace(/\/$/, ""),
		existsSync: (p: string) => p.endsWith("/.git"),
		statSync: () => ({ isDirectory: () => true }),
	};

	it("returns the canonical path for a real git worktree", () => {
		expect(canonicalizeTargetWorktree("/work/runner-1", { fs: okFs })).toBe(
			"/work/runner-1",
		);
	});

	it("fail-closed on a missing worktree path", () => {
		expect(() => canonicalizeTargetWorktree("  ", { fs: okFs })).toThrow(
			/no worktree_path/,
		);
	});

	it("fail-closed when realpath throws (dangling / symlink-to-nowhere)", () => {
		expect(() =>
			canonicalizeTargetWorktree("/work/x", {
				fs: {
					...okFs,
					realpathSync: () => {
						throw new Error("ENOENT");
					},
				},
			}),
		).toThrow(/not resolvable/i);
	});

	it("fail-closed when the path is not a directory", () => {
		expect(() =>
			canonicalizeTargetWorktree("/work/x", {
				fs: { ...okFs, statSync: () => ({ isDirectory: () => false }) },
			}),
		).toThrow(/not a directory/i);
	});

	it("fail-closed when the path is not a git worktree (no .git)", () => {
		expect(() =>
			canonicalizeTargetWorktree("/work/x", {
				fs: { ...okFs, existsSync: () => false },
			}),
		).toThrow(/no \.git/i);
	});

	it("fail-closed when the worktree OVERLAPS a model-writable root (forged-clean risk)", () => {
		expect(() =>
			canonicalizeTargetWorktree("/scratch/lead/wt", {
				untrustedRoots: ["/scratch/lead"],
				fs: {
					realpathSync: (p) => p,
					existsSync: (p) => p.endsWith("/.git"),
					statSync: () => ({ isDirectory: () => true }),
				},
			}),
		).toThrow(/model-writable|overlaps/i);
	});
});

describe("makeShipPreflight (Phase C2 adapter → CodexFounderPreflight)", () => {
	const derived = (authority: Record<string, unknown>): DerivedToolContext => ({
		tool: "relay_ship_decision",
		kind: "reserved_ship",
		authority,
	});

	it("forwards derived execId+prHead with action=ship and maps an allow", () => {
		const check = vi.fn(() => ({
			allowed: true,
			reason: "approved" as const,
			action: "ship" as const,
		}));
		const pf = makeShipPreflight({
			preflight: { check } as unknown as CodexFounderPreflight,
			dbPath: "/comm.db",
			stateDbPath: "/state.db",
		});
		const v = pf(derived({ execId: "exec-1", prHead: SHA }));
		expect(v).toEqual({ allowed: true, reason: "approved" });
		expect(check).toHaveBeenCalledWith({
			action: "ship",
			execId: "exec-1",
			prHead: SHA,
			dbPath: "/comm.db",
			stateDbPath: "/state.db",
		});
	});

	it("maps a CodexFounderPreflight rejection through (fail-closed)", () => {
		const check = vi.fn(() => ({
			allowed: false,
			reason: "pr_head_sha_mismatch" as const,
			action: "ship" as const,
		}));
		const pf = makeShipPreflight({
			preflight: { check } as unknown as CodexFounderPreflight,
			dbPath: "/comm.db",
		});
		expect(pf(derived({ execId: "e", prHead: SHA }))).toEqual({
			allowed: false,
			reason: "pr_head_sha_mismatch",
		});
	});

	it("fail-closed on a malformed derived authority (no preflight call)", () => {
		const check = vi.fn();
		const pf = makeShipPreflight({
			preflight: { check } as unknown as CodexFounderPreflight,
			dbPath: "/comm.db",
		});
		expect(pf(derived({ execId: 123, prHead: SHA }))).toEqual({
			allowed: false,
			reason: "missing_derived_authority",
		});
		expect(check).not.toHaveBeenCalled();
	});
});
