import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildRunnerMemoryPromptSection,
	DEFAULT_MANAGED_SETTINGS,
	decodeMemoryPathComponent,
	encodeMemoryPathComponent,
	formatRunnerMemoryLogLine,
	measureIndexPrefix,
	prepareRunnerMemoryMount,
	probeAutoMemoryPolicy,
	RUNNER_MEMORY_DEFAULT_BUDGET,
	RUNNER_MEMORY_HARD_LIMIT,
	RUNNER_MEMORY_ID_MAX_LENGTH,
	RUNNER_MEMORY_SCAN_CEILING_BYTES,
	resolveLegacyProjectMemoryDir,
	resolveRunnerMemoryIdentity,
	resolveRunnerMemoryRoot,
	toRunnerMemoryDisposition,
} from "../runner-memory.js";

describe("FLY-2147 runner memory", () => {
	it("keeps the visible budget below Claude Code's load limits", () => {
		expect(RUNNER_MEMORY_DEFAULT_BUDGET.lines).toBeLessThan(
			RUNNER_MEMORY_HARD_LIMIT.lines,
		);
		expect(RUNNER_MEMORY_DEFAULT_BUDGET.bytes).toBeLessThan(
			RUNNER_MEMORY_HARD_LIMIT.bytes,
		);
	});

	it("resolves only stable project and role identities for supported backends", () => {
		expect(
			resolveRunnerMemoryIdentity({
				backend: "antigravity-tmux",
				projectName: "flywheel",
				nodeId: "qa",
			}),
		).toEqual({ ok: false, reason: "unsupported_backend" });
		expect(
			resolveRunnerMemoryIdentity({
				backend: "claude-tmux",
				projectName: "flywheel",
				nodeId: "eng_design",
				agentName: "generic",
			}),
		).toEqual({
			ok: true,
			backend: "claude-tmux",
			identity: { project: "flywheel", role: "eng_design" },
		});
		expect(
			resolveRunnerMemoryIdentity({
				backend: "codex-tmux",
				projectName: "GeoForge3D",
				agentName: "generic",
			}),
		).toEqual({
			ok: true,
			backend: "codex-tmux",
			identity: { project: "GeoForge3D", role: "generic" },
		});
	});

	it.each([
		"eng_design",
		"qa",
		"generic",
		"flywheel",
		"GeoForge3D",
		"my.project",
		"A",
		"x".repeat(RUNNER_MEMORY_ID_MAX_LENGTH),
	])(
		"preserves valid project and role identifier case for %s",
		(identifier) => {
			expect(
				resolveRunnerMemoryIdentity({
					backend: "claude-tmux",
					projectName: identifier,
					nodeId: identifier,
				}),
			).toEqual({
				ok: true,
				backend: "claude-tmux",
				identity: { project: identifier, role: identifier },
			});
		},
	);

	it.each([
		[{ backend: "claude-tmux", nodeId: "qa" }, "no_project"],
		[{ backend: "claude-tmux", projectName: "flywheel" }, "no_role"],
		[
			{ backend: "claude-tmux", projectName: "", nodeId: "qa" },
			"invalid_project",
		],
		[
			{ backend: "claude-tmux", projectName: "../x", nodeId: "qa" },
			"invalid_project",
		],
		[
			{ backend: "claude-tmux", projectName: "flywheel", nodeId: "a/b" },
			"invalid_role",
		],
		[
			{ backend: "claude-tmux", projectName: "flywheel", nodeId: "" },
			"invalid_role",
		],
		[
			{ backend: "claude-tmux", projectName: "flywheel", nodeId: ".." },
			"invalid_role",
		],
		[
			{
				backend: "claude-tmux",
				projectName: "x".repeat(RUNNER_MEMORY_ID_MAX_LENGTH + 1),
				nodeId: "qa",
			},
			"invalid_project",
		],
		[
			{
				backend: "claude-tmux",
				projectName: "flywheel",
				nodeId: "x".repeat(RUNNER_MEMORY_ID_MAX_LENGTH + 1),
			},
			"invalid_role",
		],
	] as const)("rejects an invalid identity as %s", (input, reason) => {
		expect(resolveRunnerMemoryIdentity(input)).toMatchObject({
			ok: false,
			reason,
		});
	});

	it("preserves a known role when the project identity is absent", () => {
		expect(
			resolveRunnerMemoryIdentity({ backend: "claude-tmux", nodeId: "qa" }),
		).toEqual({ ok: false, reason: "no_project", role: "qa" });
	});

	it("resolves an absolute root without silently falling back", () => {
		expect(
			resolveRunnerMemoryRoot({
				FLYWHEEL_RUNNER_MEMORY_ROOT: "/tmp/runner-memory",
				HOME: "/ignored",
			}),
		).toEqual({ ok: true, root: "/tmp/runner-memory" });
		expect(resolveRunnerMemoryRoot({ HOME: " /Users/example " })).toEqual({
			ok: true,
			root: join("/Users/example", ".flywheel", "runner-memory"),
		});
		for (const env of [
			{ FLYWHEEL_RUNNER_MEMORY_ROOT: "", HOME: "/fallback" },
			{ FLYWHEEL_RUNNER_MEMORY_ROOT: "   ", HOME: "/fallback" },
			{ FLYWHEEL_RUNNER_MEMORY_ROOT: "relative", HOME: "/fallback" },
		]) {
			expect(resolveRunnerMemoryRoot(env)).toEqual({
				ok: false,
				reason: "invalid_root_override",
			});
		}
		for (const env of [{}, { HOME: "" }, { HOME: "   " }]) {
			expect(resolveRunnerMemoryRoot(env)).toEqual({
				ok: false,
				reason: "no_home",
			});
		}
		expect(resolveRunnerMemoryRoot({ HOME: "relative/home" })).toEqual({
			ok: false,
			reason: "invalid_home",
		});
	});

	it.each([
		["flywheel", "flywheel"],
		["qa", "qa"],
		["Sub", "sub--1"],
		["QA", "qa--3"],
		["GeoForge3D", "geoforge3d--209"],
		["a--b", "a--b--0"],
	])("encodes %s reversibly as %s", (input, encoded) => {
		expect(encodeMemoryPathComponent(input)).toBe(encoded);
		expect(decodeMemoryPathComponent(encoded)).toBe(input);
	});

	it("keeps encoded names distinct from valid names that shadow them", () => {
		const shadow = encodeMemoryPathComponent("Sub");
		expect(encodeMemoryPathComponent(shadow)).not.toBe(shadow);
	});

	it("measures line and byte limits from a bounded index prefix", () => {
		expect(measureIndexPrefix({ prefix: Buffer.alloc(0), size: 0 })).toEqual({
			lines: 0,
			linesExact: true,
			bytes: 0,
			overBudget: false,
			overHard: false,
			firstDroppedLine: undefined,
		});
		const multibyte = Buffer.from("é\n二\nok");
		expect(
			measureIndexPrefix({ prefix: multibyte, size: multibyte.length }),
		).toMatchObject({ lines: 3, linesExact: true, bytes: 9 });

		const lineLimited = Buffer.from("x\n".repeat(218));
		expect(
			measureIndexPrefix({ prefix: lineLimited, size: lineLimited.length }),
		).toMatchObject({
			lines: 218,
			linesExact: true,
			overBudget: true,
			overHard: true,
			firstDroppedLine: 201,
		});

		const byteLimited = Buffer.from(`${"x".repeat(208)}\n`.repeat(153));
		expect(
			measureIndexPrefix({ prefix: byteLimited, size: byteLimited.length }),
		).toMatchObject({
			lines: 153,
			overBudget: true,
			overHard: true,
			firstDroppedLine: 120,
		});

		const bounded = Buffer.from("x\n".repeat(300));
		expect(
			measureIndexPrefix({
				prefix: bounded,
				size: RUNNER_MEMORY_SCAN_CEILING_BYTES + 1,
			}),
		).toMatchObject({
			lines: 300,
			linesExact: false,
			bytes: RUNNER_MEMORY_SCAN_CEILING_BYTES + 1,
			firstDroppedLine: 201,
		});
		const belowHardLimit = Buffer.from("x\n".repeat(100));
		expect(
			measureIndexPrefix({
				prefix: belowHardLimit,
				size: belowHardLimit.length,
			}),
		).toMatchObject({ overHard: false, firstDroppedLine: undefined });
	});

	it("detects auto-memory policy keys in the fixed source order", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-policy-"));
		try {
			const managedFile = join(root, "managed settings.json");
			const managedDropinDir = join(root, "managed settings.d");
			const home = join(root, "home");
			const cwd = join(root, "cwd");
			const projectRoot = join(root, "project");
			fs.mkdirSync(managedDropinDir, { recursive: true });
			fs.mkdirSync(join(home, ".claude"), { recursive: true });
			fs.mkdirSync(join(cwd, ".claude"), { recursive: true });
			fs.mkdirSync(join(projectRoot, ".claude"), { recursive: true });
			fs.writeFileSync(managedFile, '{"autoMemoryEnabled":true}');
			fs.writeFileSync(join(managedDropinDir, "aa.json"), '{"theme":"dark"}');
			fs.writeFileSync(
				join(managedDropinDir, "zz.json"),
				'{"autoMemoryDirectory":"/managed"}',
			);
			fs.writeFileSync(
				join(home, ".claude", "settings.json"),
				'{"autoMemoryFutureKey":"present"}',
			);
			fs.writeFileSync(
				join(cwd, ".claude", "settings.json"),
				'{"env":{"CLAUDE_CODE_DISABLE_AUTO_MEMORY":"0"}}',
			);
			fs.writeFileSync(
				join(cwd, ".claude", "settings.local.json"),
				'{"autoMemoryEnabled":false}',
			);
			fs.writeFileSync(
				join(projectRoot, ".claude", "settings.json"),
				'{"autoMemoryProjectSetting":"present"}',
			);
			fs.writeFileSync(
				join(projectRoot, ".claude", "settings.local.json"),
				'{"autoMemoryProjectLocal":"present"}',
			);

			expect(
				probeAutoMemoryPolicy({
					home,
					cwd,
					projectRoot,
					managedSettings: { managedFile, managedDropinDir },
				}),
			).toEqual({
				conflicts: [
					`${managedFile}:autoMemoryEnabled`,
					`${join(managedDropinDir, "zz.json")}:autoMemoryDirectory`,
					`${join(home, ".claude", "settings.json")}:autoMemoryFutureKey`,
					`${join(cwd, ".claude", "settings.json")}:env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
					`${join(cwd, ".claude", "settings.local.json")}:autoMemoryEnabled`,
					`${join(projectRoot, ".claude", "settings.json")}:autoMemoryProjectSetting`,
					`${join(projectRoot, ".claude", "settings.local.json")}:autoMemoryProjectLocal`,
				],
				unreadable: [],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the runner cwd for project-local policy and refuses memory writes", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-project-policy-"));
		try {
			const memoryRoot = join(root, "memory");
			const cwd = join(root, "worktree");
			const projectRoot = join(root, "main-repo");
			const localSettings = join(cwd, ".claude", "settings.local.json");
			fs.mkdirSync(join(cwd, ".claude"), { recursive: true });
			fs.mkdirSync(projectRoot, { recursive: true });
			fs.writeFileSync(localSettings, '{"autoMemoryEnabled":false}');

			expect(
				prepareRunnerMemoryMount({
					env: { FLYWHEEL_RUNNER_MEMORY_ROOT: memoryRoot },
					backend: "claude-tmux",
					projectName: "flywheel",
					nodeId: "qa",
					cwd,
					projectRoot,
					managedSettings: {
						managedFile: join(root, "absent-managed.json"),
						managedDropinDir: join(root, "absent-managed.d"),
					},
				}),
			).toMatchObject({
				status: "failed",
				reason: `policy_conflict:${JSON.stringify([
					`${localSettings}:autoMemoryEnabled`,
				])}`,
			});
			expect(fs.existsSync(join(memoryRoot, "flywheel", "qa"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the main project root for project-local policy and refuses memory writes", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-project-root-policy-"));
		try {
			const memoryRoot = join(root, "memory");
			const cwd = join(root, "worktree");
			const projectRoot = join(root, "main-repo");
			const localSettings = join(projectRoot, ".claude", "settings.local.json");
			fs.mkdirSync(cwd, { recursive: true });
			fs.mkdirSync(join(projectRoot, ".claude"), { recursive: true });
			fs.writeFileSync(localSettings, '{"autoMemoryEnabled":false}');

			expect(
				prepareRunnerMemoryMount({
					env: { FLYWHEEL_RUNNER_MEMORY_ROOT: memoryRoot },
					backend: "claude-tmux",
					projectName: "flywheel",
					nodeId: "qa",
					cwd,
					projectRoot,
					managedSettings: {
						managedFile: join(root, "absent-managed.json"),
						managedDropinDir: join(root, "absent-managed.d"),
					},
				}),
			).toMatchObject({
				status: "failed",
				reason: `policy_conflict:${JSON.stringify([
					`${localSettings}:autoMemoryEnabled`,
				])}`,
			});
			expect(fs.existsSync(join(memoryRoot, "flywheel", "qa"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed on unreadable managed policy and exposes unreadable user policy", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-policy-bad-"));
		try {
			const managedFile = join(root, "managed.json");
			const managedDropinDir = join(root, "managed.d");
			const home = join(root, "home");
			const cwd = join(root, "cwd with spaces");
			const projectRoot = join(root, "project");
			fs.mkdirSync(managedDropinDir, { recursive: true });
			fs.mkdirSync(join(cwd, ".claude"), { recursive: true });
			fs.writeFileSync(managedFile, "x".repeat(1_048_577));
			const badUserFile = join(cwd, ".claude", "settings.json");
			fs.writeFileSync(badUserFile, "not-json");

			expect(
				probeAutoMemoryPolicy({
					home,
					cwd,
					projectRoot,
					managedSettings: { managedFile, managedDropinDir },
				}),
			).toEqual({
				conflicts: [`${managedFile}:unreadable`],
				unreadable: [badUserFile],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when the managed drop-in directory is a readable JSON file", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-policy-dropin-"));
		try {
			const managedDropinDir = join(root, "managed-settings.d");
			fs.writeFileSync(managedDropinDir, '{"theme":"dark"}');
			expect(
				probeAutoMemoryPolicy({
					cwd: join(root, "cwd"),
					projectRoot: join(root, "project"),
					managedSettings: {
						managedFile: join(root, "absent-managed.json"),
						managedDropinDir,
					},
				}),
			).toEqual({
				conflicts: [`${managedDropinDir}:unreadable`],
				unreadable: [],
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses the production managed paths by default from the real preparer", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-default-policy-"));
		const seen: string[] = [];
		const spy = vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
			seen.push(String(candidate));
			return false;
		});
		try {
			expect(
				prepareRunnerMemoryMount({
					env: { FLYWHEEL_RUNNER_MEMORY_ROOT: root },
					backend: "claude-tmux",
					projectName: "flywheel",
					nodeId: "qa",
					cwd: "/worktree",
					projectRoot: "/project",
				}),
			).toMatchObject({ status: "mounted" });
			expect(seen).toContain(DEFAULT_MANAGED_SETTINGS.managedFile);
			expect(seen).toContain(DEFAULT_MANAGED_SETTINGS.managedDropinDir);
		} finally {
			spy.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates a private first-run index and preserves it on the next run", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-mount-"));
		try {
			const input = {
				env: { FLYWHEEL_RUNNER_MEMORY_ROOT: root },
				backend: "claude-tmux",
				projectName: "flywheel",
				nodeId: "qa",
				cwd: join(root, "cwd"),
				projectRoot: join(root, "project"),
				managedSettings: {
					managedFile: join(root, "absent-managed.json"),
					managedDropinDir: join(root, "absent-managed.d"),
				},
			};
			const first = prepareRunnerMemoryMount(input);
			expect(first).toMatchObject({
				status: "mounted",
				backend: "claude-tmux",
				project: "flywheel",
				role: "qa",
				dir: join(root, "flywheel", "qa"),
				index: { firstRun: true, lines: 3, overBudget: false },
				snapshot: {
					lines: 3,
					linesExact: true,
					bytes: expect.any(Number),
					sha16: expect.stringMatching(/^[0-9a-f]{16}$/),
					topicFiles: 0,
				},
				policy: { conflicts: [], unreadable: [] },
			});
			if (first.status !== "mounted") throw new Error("expected mounted");
			expect(first.snapshot.lines).toBe(first.index.lines);
			expect(first.snapshot.linesExact).toBe(first.index.linesExact);
			expect(first.snapshot.bytes).toBe(first.index.bytes);
			const indexPath = join(first.dir, "MEMORY.md");
			expect(fs.statSync(first.dir).mode & 0o777).toBe(0o700);
			expect(fs.statSync(indexPath).mode & 0o777).toBe(0o600);
			const custom = "# custom\n\n- [fact](fact.md)\n";
			fs.writeFileSync(indexPath, custom);

			const second = prepareRunnerMemoryMount(input);
			expect(second).toMatchObject({
				status: "mounted",
				index: { firstRun: false, lines: 3 },
			});
			expect(fs.readFileSync(indexPath, "utf8")).toBe(custom);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports soft and hard index limits without refusing the mount", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-over-"));
		const base = {
			env: { FLYWHEEL_RUNNER_MEMORY_ROOT: root },
			backend: "codex-tmux",
			projectName: "flywheel",
			nodeId: "qa",
			cwd: root,
			projectRoot: root,
		};
		try {
			const first = prepareRunnerMemoryMount(base);
			if (first.status !== "mounted") throw new Error("expected mounted");
			fs.writeFileSync(join(first.dir, "MEMORY.md"), "x\n".repeat(170));
			expect(prepareRunnerMemoryMount(base)).toMatchObject({
				status: "mounted",
				index: {
					lines: 170,
					overBudget: true,
					overHard: false,
					firstDroppedLine: undefined,
				},
			});
			fs.writeFileSync(join(first.dir, "MEMORY.md"), "x\n".repeat(218));
			expect(prepareRunnerMemoryMount(base)).toMatchObject({
				status: "mounted",
				index: {
					lines: 218,
					overHard: true,
					firstDroppedLine: 201,
				},
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("carries unreadable user settings through mounted and over-budget logs", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-unreadable-log-"));
		try {
			const cwd = join(root, "cwd with spaces");
			fs.mkdirSync(join(cwd, ".claude"), { recursive: true });
			const unreadablePath = join(cwd, ".claude", "settings.json");
			fs.writeFileSync(unreadablePath, "not-json");
			const input = {
				env: { FLYWHEEL_RUNNER_MEMORY_ROOT: join(root, "memory") },
				backend: "claude-tmux",
				projectName: "flywheel",
				nodeId: "qa",
				cwd,
				projectRoot: join(root, "project"),
				managedSettings: {
					managedFile: join(root, "absent-managed.json"),
					managedDropinDir: join(root, "absent-managed.d"),
				},
			};
			const mounted = prepareRunnerMemoryMount(input);
			expect(mounted).toMatchObject({
				status: "mounted",
				policy: { unreadable: [unreadablePath] },
			});
			if (mounted.status !== "mounted") throw new Error("expected mounted");
			expect(formatRunnerMemoryLogLine(mounted).line).toContain(
				`settings_unreadable=${JSON.stringify([unreadablePath])}`,
			);
			fs.writeFileSync(join(mounted.dir, "MEMORY.md"), "x\n".repeat(170));
			const overBudget = prepareRunnerMemoryMount(input);
			expect(overBudget).toMatchObject({
				status: "mounted",
				index: { overBudget: true },
			});
			expect(formatRunnerMemoryLogLine(overBudget).line).toMatch(
				new RegExp(
					`OVER BUDGET.*settings_unreadable=${JSON.stringify([
						unreadablePath,
					]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
				),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails visibly for invalid roots and filesystem objects", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-fs-"));
		try {
			const common = {
				backend: "codex-tmux",
				projectName: "flywheel",
				nodeId: "qa",
				cwd: root,
				projectRoot: root,
			};
			expect(
				prepareRunnerMemoryMount({
					...common,
					env: { FLYWHEEL_RUNNER_MEMORY_ROOT: "" },
				}),
			).toMatchObject({
				status: "failed",
				reason: "invalid_root_override",
			});
			expect(
				prepareRunnerMemoryMount({ ...common, env: { HOME: "relative" } }),
			).toMatchObject({ status: "failed", reason: "invalid_home" });

			const rootFile = join(root, "root-file");
			fs.writeFileSync(rootFile, "not a directory");
			expect(
				prepareRunnerMemoryMount({
					...common,
					env: { FLYWHEEL_RUNNER_MEMORY_ROOT: rootFile },
				}),
			).toMatchObject({
				status: "failed",
				reason: expect.stringMatching(/^fs:/),
			});

			const goodRoot = join(root, "good-root");
			const indexDir = join(goodRoot, "flywheel", "qa", "MEMORY.md");
			fs.mkdirSync(indexDir, { recursive: true });
			expect(
				prepareRunnerMemoryMount({
					...common,
					env: { FLYWHEEL_RUNNER_MEMORY_ROOT: goodRoot },
				}),
			).toMatchObject({
				status: "failed",
				reason: expect.stringMatching(/^fs:/),
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("detects policy conflict before creating the role directory", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-conflict-"));
		try {
			const managedFile = join(root, "managed.json");
			const managedDropinDir = join(root, "managed.d");
			fs.writeFileSync(managedFile, '{"autoMemoryEnabled":true}');
			const result = prepareRunnerMemoryMount({
				env: { FLYWHEEL_RUNNER_MEMORY_ROOT: join(root, "memory") },
				backend: "claude-tmux",
				projectName: "flywheel",
				nodeId: "qa",
				cwd: root,
				projectRoot: root,
				managedSettings: { managedFile, managedDropinDir },
			});
			expect(result).toMatchObject({
				status: "failed",
				reason: `policy_conflict:${JSON.stringify([
					`${managedFile}:autoMemoryEnabled`,
				])}`,
			});
			expect(fs.existsSync(join(root, "memory", "flywheel", "qa"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds sparse-index reads and always closes the descriptor", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-sparse-"));
		try {
			const dir = join(root, "flywheel", "qa");
			fs.mkdirSync(dir, { recursive: true });
			const indexPath = join(dir, "MEMORY.md");
			const fd = fs.openSync(indexPath, "w");
			fs.writeSync(fd, "x\n".repeat(300));
			fs.ftruncateSync(fd, 8 * 1024 * 1024);
			fs.closeSync(fd);
			const openSpy = vi.spyOn(fs, "openSync");
			const readSpy = vi.spyOn(fs, "readSync");
			const closeSpy = vi.spyOn(fs, "closeSync");
			const result = prepareRunnerMemoryMount({
				env: { FLYWHEEL_RUNNER_MEMORY_ROOT: root },
				backend: "codex-tmux",
				projectName: "flywheel",
				nodeId: "qa",
				cwd: root,
				projectRoot: root,
			});
			expect(result).toMatchObject({
				status: "mounted",
				index: {
					bytes: 8 * 1024 * 1024,
					linesExact: false,
					firstDroppedLine: 201,
				},
				snapshot: {
					bytes: 8 * 1024 * 1024,
					linesExact: false,
					sha16: expect.stringMatching(/^[0-9a-f]{16}$/),
					topicFiles: 0,
				},
			});
			if (result.status !== "mounted") throw new Error("expected mounted");
			expect(result.snapshot.lines).toBe(result.index.lines);
			expect(result.snapshot.bytes).toBe(result.index.bytes);
			const requested = readSpy.mock.calls.reduce(
				(sum, call) => sum + Number(call[3]),
				0,
			);
			expect(requested).toBeLessThanOrEqual(RUNNER_MEMORY_SCAN_CEILING_BYTES);
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(closeSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.restoreAllMocks();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("marks a short read inexact and closes after fstat failure", () => {
		const root = fs.mkdtempSync(join(tmpdir(), "fly2147-short-read-"));
		const input = {
			env: { FLYWHEEL_RUNNER_MEMORY_ROOT: root },
			backend: "codex-tmux",
			projectName: "flywheel",
			nodeId: "qa",
			cwd: root,
			projectRoot: root,
		};
		try {
			const initial = prepareRunnerMemoryMount(input);
			if (initial.status !== "mounted") throw new Error("expected mounted");
			fs.writeFileSync(join(initial.dir, "MEMORY.md"), "x\n".repeat(100));

			const readSpy = vi
				.spyOn(fs, "readSync")
				.mockImplementationOnce(() => 100)
				.mockImplementationOnce(() => 0);
			const short = prepareRunnerMemoryMount(input);
			expect(readSpy).toHaveBeenCalledTimes(2);
			expect(short).toMatchObject({
				status: "mounted",
				index: { linesExact: false, bytes: 200 },
			});
			vi.restoreAllMocks();

			const fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementationOnce(() => {
				throw new Error("fstat probe");
			});
			const closeSpy = vi.spyOn(fs, "closeSync");
			const failed = prepareRunnerMemoryMount(input);
			expect(fstatSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(failed).toMatchObject({
				status: "failed",
				reason: "fs:fstat probe",
			});
		} finally {
			vi.restoreAllMocks();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders bounded Claude memory instructions for each index state", () => {
		const base = {
			status: "mounted" as const,
			backend: "claude-tmux" as const,
			project: "flywheel",
			role: "qa",
			dir: "/memory/flywheel/qa",
			policy: { conflicts: [], unreadable: [] },
		};
		const within = buildRunnerMemoryPromptSection(
			{
				...base,
				index: {
					lines: 3,
					linesExact: true,
					bytes: 90,
					firstRun: false,
					overBudget: false,
					overHard: false,
					firstDroppedLine: undefined,
				},
			},
			{ legacyProjectMemoryDir: "/legacy memory" },
		);
		expect(within).toMatch(/^## Runner Memory\n/);
		expect(within.endsWith("\n")).toBe(true);
		expect(within.endsWith("\n\n")).toBe(false);
		expect(within).toContain("within budget (160 lines / 20,000 bytes");
		expect(within).toContain("flywheel/qa");
		expect(within).toContain("/memory/flywheel/qa");
		expect(within).toContain("/legacy memory");

		const hard = buildRunnerMemoryPromptSection(
			{
				...base,
				index: {
					lines: 218,
					linesExact: true,
					bytes: 436,
					firstRun: false,
					overBudget: true,
					overHard: true,
					firstDroppedLine: 201,
				},
			},
			{},
		);
		expect(hard).toContain("OVER BUDGET");
		expect(hard).toContain("from about line 201 onward were NOT loaded");
		expect(hard).toContain("FIRST TASK");
		expect(hard).toContain("replace or drop superseded index pointers");
		expect(hard).not.toContain("Project-wide shared memory");

		const soft = buildRunnerMemoryPromptSection(
			{
				...base,
				index: {
					lines: 170,
					linesExact: true,
					bytes: 340,
					firstRun: false,
					overBudget: true,
					overHard: false,
					firstDroppedLine: undefined,
				},
			},
			{},
		);
		expect(soft).toContain("Nothing was dropped yet");
		expect(soft).not.toContain("NOT loaded");

		const firstRun = buildRunnerMemoryPromptSection(
			{
				...base,
				index: {
					lines: 3,
					linesExact: true,
					bytes: 90,
					firstRun: true,
					overBudget: false,
					overHard: false,
					firstDroppedLine: undefined,
				},
			},
			{},
		);
		expect(firstRun).toContain("first run — the index is empty");
	});

	it("renders fail-closed Claude wording and capability-honest Codex wording", () => {
		const skippedClaude = {
			status: "skipped" as const,
			reason: "no_project" as const,
			backend: "claude-tmux",
			role: "qa",
			policy: { conflicts: [], unreadable: [] },
		};
		const disabled = buildRunnerMemoryPromptSection(skippedClaude, {});
		expect(disabled).toContain("NOT mounted (-/qa): no_project");
		expect(disabled).toContain("auto memory is DISABLED");

		const conflictReason =
			'policy_conflict:["/managed settings.json:autoMemoryEnabled"]';
		const unknown = buildRunnerMemoryPromptSection(
			{
				status: "failed",
				backend: "claude-tmux",
				project: "flywheel",
				role: "qa",
				reason: conflictReason,
				policy: { conflicts: [], unreadable: [] },
			},
			{},
		);
		expect(unknown).toContain(conflictReason);
		expect(unknown).toContain(
			"effective memory state of this session is UNKNOWN",
		);
		expect(unknown).not.toContain("auto memory is DISABLED");
		expect(unknown).not.toContain("will not load");

		const codex = buildRunnerMemoryPromptSection(
			{
				status: "mounted",
				backend: "codex-tmux",
				project: "flywheel",
				role: "qa",
				dir: "/memory/flywheel/qa",
				index: {
					lines: 218,
					linesExact: true,
					bytes: 436,
					firstRun: false,
					overBudget: true,
					overHard: true,
					firstDroppedLine: 201,
				},
			},
			{},
		);
		expect(codex).toContain("Native loading for Codex is deferred");
		expect(codex).toContain("FLYWHEEL_RUNNER_MEMORY_DIR");
		for (const forbidden of [
			"Claude Code loads",
			"NOT loaded",
			"within budget",
			"auto memory is DISABLED",
		]) {
			expect(codex).not.toContain(forbidden);
		}
		expect(
			buildRunnerMemoryPromptSection(
				{
					status: "skipped",
					reason: "unsupported_backend",
					backend: "kimi-tmux",
				},
				{},
			),
		).toBe("");
	});

	it("formats the four structured log shapes and adapter disposition", () => {
		const mounted = {
			status: "mounted" as const,
			backend: "claude-tmux" as const,
			project: "flywheel",
			role: "qa",
			dir: "/memory/flywheel/qa",
			index: {
				lines: 3,
				linesExact: true,
				bytes: 90,
				firstRun: false,
				overBudget: false,
				overHard: false,
				firstDroppedLine: undefined,
			},
			policy: { conflicts: [], unreadable: [] },
		};
		expect(formatRunnerMemoryLogLine(mounted)).toEqual({
			level: "info",
			line: "[Blueprint] runner-memory mounted backend=claude-tmux project=flywheel role=qa dir=/memory/flywheel/qa index=3L/90B budget=160L/20000B hard=200L/25000B first_run=false over_budget=false",
		});
		const over = {
			...mounted,
			index: {
				...mounted.index,
				lines: 300,
				linesExact: false,
				bytes: 70_000,
				overBudget: true,
				overHard: true,
				firstDroppedLine: 201,
			},
			policy: {
				conflicts: [],
				unreadable: ["/path with spaces/settings.json"],
			},
		};
		const overLog = formatRunnerMemoryLogLine(over);
		expect(overLog.level).toBe("warn");
		expect(overLog.line).toMatch(
			/^\[Blueprint\] runner-memory OVER BUDGET backend=claude-tmux project=flywheel role=qa dir=\/memory\/flywheel\/qa index=>=300L\/70000B budget=160L\/20000B hard=200L\/25000B first_dropped_line=201 settings_unreadable=(\[.*\])$/,
		);
		const unreadable = overLog.line.match(/settings_unreadable=(\[.*\])$/);
		expect(JSON.parse(unreadable?.[1] ?? "null")).toEqual(
			over.policy.unreadable,
		);

		expect(
			formatRunnerMemoryLogLine({
				status: "skipped",
				reason: "no_project",
				backend: "claude-tmux",
				role: "qa",
				policy: { conflicts: [], unreadable: [] },
			}),
		).toEqual({
			level: "info",
			line: "[Blueprint] runner-memory skipped reason=no_project backend=claude-tmux project=- role=qa",
		});
		expect(
			formatRunnerMemoryLogLine({
				status: "failed",
				backend: "claude-tmux",
				project: "flywheel",
				role: "qa",
				reason: "invalid_root_override",
				policy: { conflicts: [], unreadable: [] },
			}),
		).toEqual({
			level: "warn",
			line: "[Blueprint] runner-memory failed backend=claude-tmux project=flywheel role=qa dir=- reason=invalid_root_override (no role memory this session)",
		});

		expect(toRunnerMemoryDisposition(mounted)).toEqual({
			status: "mounted",
			dir: mounted.dir,
		});
		expect(
			toRunnerMemoryDisposition({
				status: "skipped",
				reason: "no_project",
				backend: "claude-tmux",
				role: "qa",
				policy: { conflicts: [], unreadable: [] },
			}),
		).toEqual({
			status: "disabled",
			reason: "no_project",
		});
		expect(
			toRunnerMemoryDisposition({
				status: "skipped",
				reason: "unsupported_backend",
				backend: "kimi-tmux",
			}),
		).toBeUndefined();
	});

	it("resolves the legacy project memory pointer only when it exists", () => {
		const expected = "/home/.claude/projects/-Users-x-Dev-flywheel/memory";
		expect(
			resolveLegacyProjectMemoryDir({
				repoRoot: "/Users/x/Dev/flywheel",
				home: "/home",
				exists: (candidate) => candidate === expected,
			}),
		).toBe(expected);
		expect(
			resolveLegacyProjectMemoryDir({
				repoRoot: "/Users/x/Dev/flywheel",
				home: "",
				exists: () => true,
			}),
		).toBeUndefined();
		expect(
			resolveLegacyProjectMemoryDir({
				repoRoot: "/Users/x/Dev/flywheel",
				home: "/home",
				exists: () => false,
			}),
		).toBeUndefined();
	});
});
