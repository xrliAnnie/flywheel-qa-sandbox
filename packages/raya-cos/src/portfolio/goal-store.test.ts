import { execFile, execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GitCommandOptions, GitRunner } from "./goal-store.js";

const SOURCE = "https://discord.com/channels/1/2/1414000000000000000";

function git(root: string, ...args: string[]): string {
	return execFileSync("/usr/bin/git", args, {
		cwd: root,
		encoding: "utf8",
	}).trim();
}

function repository(): { root: string; memory: string; goalsFile: string } {
	const root = mkdtempSync(join(tmpdir(), "raya-goal-store-"));
	const memory = join(root, "memory");
	mkdirSync(memory);
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Raya Test");
	git(root, "config", "user.email", "raya@example.test");
	writeFileSync(join(memory, "MEMORY.md"), "initial\n");
	git(root, "add", "memory/MEMORY.md");
	git(root, "commit", "-m", "initial");
	return { root, memory, goalsFile: join(memory, "goals.md") };
}

const runGit: GitRunner = (argv, options) => {
	const [file, ...args] = argv;
	return new Promise((resolve, reject) => {
		if (!file) return reject(new Error("missing binary"));
		const child = execFile(
			file,
			args,
			{
				cwd: options.cwd,
				encoding: "utf8",
				timeout: options.timeoutMs,
				env: options.env ? { ...process.env, ...options.env } : process.env,
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
};

describe("GoalStore", { timeout: 20_000 }, () => {
	it("records and withdraws goals through a path-scoped nested-repository transaction", async () => {
		const module = await import("./goal-store.js").catch(() => ({}));
		const GoalStore = (module as { GoalStore?: unknown }).GoalStore;
		expect(GoalStore).toBeTypeOf("function");
		if (typeof GoalStore !== "function") return;
		const fixture = repository();
		const events: string[] = [];
		writeFileSync(join(fixture.memory, "MEMORY.md"), "founder staged change\n");
		git(fixture.root, "add", "memory/MEMORY.md");
		const store = new (
			GoalStore as new (
				options: Record<string, unknown>,
			) => {
				record: (
					request: Record<string, unknown>,
				) => Promise<Record<string, unknown>>;
				withdraw: (
					request: Record<string, unknown>,
				) => Promise<Record<string, unknown>>;
			}
		)({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			run: runGit,
			commandTimeoutMs: 20_000,
			onEvent: (name: string) => events.push(name),
		});

		const first = await store.record({
			operationId: "1414000000000000000:record:0",
			text: "  留住 Ａ 与🙂  ",
			sourceUrl: SOURCE,
			now: new Date("2026-09-06T20:00:00Z"),
		});

		expect(first).toMatchObject({
			goal: { id: "g-20260906-01", text: "  留住 Ａ 与🙂  ", status: "active" },
			outcome: "recorded",
			push: "local_only",
			externalWrite: false,
			indexSync: "ok",
		});
		expect(readFileSync(fixture.goalsFile, "utf8")).toContain(
			"- 原话: 「  留住 Ａ 与🙂  」",
		);
		expect(
			git(fixture.root, "status", "--porcelain", "--", "memory/goals.md"),
		).toBe("");
		expect(git(fixture.root, "diff", "--cached", "--name-only")).toBe(
			"memory/MEMORY.md",
		);
		expect(git(fixture.root, "show", "HEAD:memory/MEMORY.md")).toBe("initial");

		const second = await store.record({
			operationId: "1414000000000000001:record:0",
			text: "第二个目标",
			sourceUrl: "https://discord.com/channels/1/2/1414000000000000001",
			now: new Date("2026-09-06T21:00:00Z"),
		});
		expect(second).toMatchObject({ goal: { id: "g-20260906-02" } });
		expect(
			git(fixture.root, "status", "--porcelain", "--", "memory/goals.md"),
		).toBe("");

		const beforeReplay = git(fixture.root, "rev-parse", "HEAD");
		const replay = await store.record({
			operationId: "1414000000000000001:record:0",
			text: "第二个目标",
			sourceUrl: "https://discord.com/channels/1/2/1414000000000000001",
			now: new Date("2026-09-06T22:00:00Z"),
		});
		expect(replay).toMatchObject({ outcome: "replayed", push: "unknown" });
		expect(git(fixture.root, "rev-parse", "HEAD")).toBe(beforeReplay);
		await expect(
			store.record({
				operationId: "1414000000000000001:record:0",
				text: "被重排后的不同目标",
				sourceUrl: "https://discord.com/channels/1/2/1414000000000000001",
				now: new Date("2026-09-06T22:00:00Z"),
			}),
		).rejects.toThrow("goal_operation_conflict");

		const withdrawn = await store.withdraw({
			operationId: "1414000000000000002:withdraw:0",
			goalId: "g-20260906-01",
			sourceUrl: "https://discord.com/channels/1/2/1414000000000000002",
			now: new Date("2026-09-06T23:00:00Z"),
		});
		expect(withdrawn).toMatchObject({
			goal: { id: "g-20260906-01", status: "withdrawn" },
			outcome: "withdrawn",
			push: "local_only",
			indexSync: "ok",
		});
		expect(readFileSync(fixture.goalsFile, "utf8")).toContain(
			"- 撤销操作: 1414000000000000002:withdraw:0",
		);
		expect(events).toContain("goal_push_failed");
	});

	it("rejects secret-like text and a dirty goals path before writing", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		const store = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			run: runGit,
			commandTimeoutMs: 20_000,
		});

		await expect(
			store.record({
				operationId: "1414000000000000000:record:0",
				text: "token sk-abcdefghijklmnopqrstuvwxyz123456",
				sourceUrl: SOURCE,
				now: new Date("2026-09-06T20:00:00Z"),
			}),
		).rejects.toThrow("goal_rejected_secret_like");
		expect(() => readFileSync(fixture.goalsFile, "utf8")).toThrow();

		await store.record({
			operationId: "1414000000000000000:record:0",
			text: "安全目标",
			sourceUrl: SOURCE,
			now: new Date("2026-09-06T20:00:00Z"),
		});
		writeFileSync(
			fixture.goalsFile,
			`${readFileSync(fixture.goalsFile, "utf8")}外部改动\n`,
		);
		const before = readFileSync(fixture.goalsFile, "utf8");

		await expect(
			store.record({
				operationId: "1414000000000000001:record:0",
				text: "不能覆盖",
				sourceUrl: "https://discord.com/channels/1/2/1414000000000000001",
				now: new Date("2026-09-06T21:00:00Z"),
			}),
		).rejects.toThrow("goal_dirty_tree");
		expect(readFileSync(fixture.goalsFile, "utf8")).toBe(before);
	});

	it("renames a corrupt goals file instead of overwriting it", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		writeFileSync(fixture.goalsFile, "not goals\n");
		git(fixture.root, "add", "memory/goals.md");
		git(fixture.root, "commit", "-m", "add corrupt goals");
		const onEvent = vi.fn();
		const store = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			run: runGit,
			commandTimeoutMs: 20_000,
			onEvent,
		});

		await expect(
			store.record({
				operationId: "1414000000000000000:record:0",
				text: "不会覆盖",
				sourceUrl: SOURCE,
				now: new Date("2026-09-06T20:00:00Z"),
			}),
		).rejects.toThrow("goals_corrupt");
		expect(() => readFileSync(fixture.goalsFile, "utf8")).toThrow();
		const quarantines = readdirSync(fixture.memory).filter((name) =>
			name.startsWith("goals.md.corrupt-"),
		);
		expect(quarantines).toHaveLength(1);
		const corruptPath = onEvent.mock.calls[0]?.[1]?.corruptPath;
		expect(readFileSync(String(corruptPath), "utf8")).toBe("not goals\n");
		await expect(store.preflight()).rejects.toThrow("goals_corrupt");
		expect(
			readdirSync(fixture.memory).filter((name) =>
				name.startsWith("goals.md.corrupt-"),
			),
		).toEqual(quarantines);
		expect(onEvent).toHaveBeenCalledWith(
			"goals_corrupt",
			expect.objectContaining({
				corruptPath: expect.stringContaining(".corrupt-"),
			}),
		);
	});

	it("restores the worktree preimage when compare-and-swap detects a moved head", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		let advanceHead = true;
		const run: GitRunner = async (argv, options) => {
			if (
				advanceHead &&
				argv.includes("update-ref") &&
				argv.some((argument) => argument.startsWith("refs/heads/"))
			) {
				advanceHead = false;
				git(fixture.root, "commit", "--allow-empty", "-m", "external advance");
			}
			return runGit(argv, options);
		};
		const store = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			commandTimeoutMs: 20_000,
			run,
		});

		await expect(
			store.record({
				operationId: "1414000000000000000:record:0",
				text: "不会污染工作树",
				sourceUrl: SOURCE,
				now: new Date("2026-09-06T20:00:00Z"),
			}),
		).rejects.toThrow("goal_head_moved");
		expect(git(fixture.root, "log", "-1", "--format=%s")).toBe(
			"external advance",
		);
		expect(() => readFileSync(fixture.goalsFile, "utf8")).toThrow();
		expect(
			git(fixture.root, "status", "--porcelain", "--", "memory/goals.md"),
		).toBe("");
		await expect(store.preflight()).resolves.toEqual([]);
	});

	it("keeps a verified commit after index sync failure and reconciles it on the next operation", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		let failRealIndexSync = true;
		const calls: Array<{
			argv: readonly string[];
			options: GitCommandOptions;
		}> = [];
		const run: GitRunner = async (argv, options) => {
			calls.push({ argv, options });
			if (
				failRealIndexSync &&
				argv.includes("update-index") &&
				!options.env?.GIT_INDEX_FILE
			) {
				failRealIndexSync = false;
				throw Object.assign(new Error("index locked"), { code: 128 });
			}
			return runGit(argv, options);
		};
		const onEvent = vi.fn();
		const store = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			commandTimeoutMs: 20_000,
			run,
			onEvent,
		});

		const first = await store.record({
			operationId: "1414000000000000000:record:0",
			text: "第一个目标",
			sourceUrl: SOURCE,
			now: new Date("2026-09-06T20:00:00Z"),
		});
		expect(first).toMatchObject({ indexSync: "failed", push: "unknown" });
		expect(git(fixture.root, "log", "-1", "--format=%s")).toContain(
			"1414000000000000000:record:0",
		);

		const second = await store.record({
			operationId: "1414000000000000001:record:0",
			text: "第二个目标",
			sourceUrl: "https://discord.com/channels/1/2/1414000000000000001",
			now: new Date("2026-09-06T21:00:00Z"),
		});
		expect(second).toMatchObject({
			indexSync: "ok",
			goal: { id: "g-20260906-02" },
		});
		expect(onEvent).toHaveBeenCalledWith(
			"goal_index_reconciled",
			expect.any(Object),
		);
		expect(calls[0]?.argv).toEqual([
			"/usr/bin/git",
			"-C",
			fixture.memory,
			"rev-parse",
			"--show-toplevel",
		]);
		for (const call of calls.filter(({ argv }) => !argv.includes("-C"))) {
			expect(call.options.cwd).toBe(
				git(fixture.root, "rev-parse", "--show-toplevel"),
			);
		}
	});

	it("commits the generated blob while preserving an external post-rename write", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		let injected = false;
		const run: GitRunner = async (argv, options) => {
			const output = await runGit(argv, options);
			if (
				!injected &&
				argv.includes("hash-object") &&
				argv.includes("-w") &&
				argv.includes("--stdin")
			) {
				injected = true;
				writeFileSync(fixture.goalsFile, "external process content\n");
			}
			return output;
		};
		const onEvent = vi.fn();
		const store = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			commandTimeoutMs: 20_000,
			run,
			onEvent,
		});

		const result = await store.record({
			operationId: "1414000000000000000:record:0",
			text: "Brain 生成的目标",
			sourceUrl: SOURCE,
			now: new Date("2026-09-06T20:00:00Z"),
		});

		expect(result).toMatchObject({ externalWrite: true, indexSync: "ok" });
		expect(git(fixture.root, "show", "HEAD:memory/goals.md")).toContain(
			"Brain 生成的目标",
		);
		expect(readFileSync(fixture.goalsFile, "utf8")).toBe(
			"external process content\n",
		);
		expect(onEvent).toHaveBeenCalledWith(
			"goal_external_write",
			expect.objectContaining({ goalId: "g-20260906-01" }),
		);
	});

	it("restores the preimage after plumbing failure so the next operation can succeed", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		const initialHead = git(fixture.root, "rev-parse", "HEAD");
		let failCommitTree = true;
		const run: GitRunner = async (argv, options) => {
			if (failCommitTree && argv.includes("commit-tree")) {
				failCommitTree = false;
				throw Object.assign(new Error("commit-tree failed"), { code: 128 });
			}
			return runGit(argv, options);
		};
		const store = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			commandTimeoutMs: 20_000,
			run,
		});
		const request = {
			operationId: "1414000000000000000:record:0",
			text: "可恢复目标",
			sourceUrl: SOURCE,
			now: new Date("2026-09-06T20:00:00Z"),
		};

		await expect(store.record(request)).rejects.toThrow("goal_commit_failed");
		expect(git(fixture.root, "rev-parse", "HEAD")).toBe(initialHead);
		expect(() => readFileSync(fixture.goalsFile, "utf8")).toThrow();
		await expect(store.record(request)).resolves.toMatchObject({
			outcome: "recorded",
			goal: { id: "g-20260906-01" },
		});
	});

	it("rolls back the ref and worktree when post-commit blob verification fails", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		const initialHead = git(fixture.root, "rev-parse", "HEAD");
		let falsifyVerification = true;
		const run: GitRunner = async (argv, options) => {
			if (
				falsifyVerification &&
				argv.includes("rev-parse") &&
				argv.some((argument) => argument === "HEAD:memory/goals.md")
			) {
				falsifyVerification = false;
				return `${"0".repeat(40)}\n`;
			}
			return runGit(argv, options);
		};
		const store = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			commandTimeoutMs: 20_000,
			run,
		});

		await expect(
			store.record({
				operationId: "1414000000000000000:record:0",
				text: "必须验证",
				sourceUrl: SOURCE,
				now: new Date("2026-09-06T20:00:00Z"),
			}),
		).rejects.toThrow("goal_commit_verify_failed");
		expect(git(fixture.root, "rev-parse", "HEAD")).toBe(initialHead);
		expect(() => readFileSync(fixture.goalsFile, "utf8")).toThrow();
	});

	it("fails loudly for detached or non-repository memory directories", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		git(fixture.root, "checkout", "--detach");
		const detached = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			run: runGit,
			commandTimeoutMs: 20_000,
		});
		const request = {
			operationId: "1414000000000000000:record:0",
			text: "不能写 detached",
			sourceUrl: SOURCE,
			now: new Date("2026-09-06T20:00:00Z"),
		};
		await expect(detached.record(request)).rejects.toThrow(
			"goal_repo_detached",
		);
		expect(() => readFileSync(fixture.goalsFile, "utf8")).toThrow();

		const plain = mkdtempSync(join(tmpdir(), "raya-goal-no-repo-"));
		const missing = new GoalStore({
			goalsFile: join(plain, "goals.md"),
			gitBin: "/usr/bin/git",
			run: runGit,
			commandTimeoutMs: 20_000,
		});
		await expect(missing.record(request)).rejects.toThrow("goal_repo_missing");
	});

	it("fails preflight when the memory repository has no local Git identity", async () => {
		const { GoalStore } = await import("./goal-store.js");
		const fixture = repository();
		git(fixture.root, "config", "user.name", "");
		git(fixture.root, "config", "user.email", "");
		const store = new GoalStore({
			goalsFile: fixture.goalsFile,
			gitBin: "/usr/bin/git",
			run: runGit,
			commandTimeoutMs: 20_000,
		});

		await expect(store.preflight()).rejects.toThrow("goal_repo_identity");
	});
});
