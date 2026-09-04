import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOpMarkerPath } from "flywheel-claude-runner";
import { afterEach, describe, expect, it } from "vitest";
import { scrubManagedTmuxEnvironments } from "../bridge/tmux-environment-scrub.js";
import { GitWorkflowDocsGit } from "../bridge/workflow-docs-git.js";
import { GitWorkflowResumeCheckpointStore } from "../bridge/workflow-resume-checkpoint.js";
import { ensureTuiWindow } from "../lead-backends/codex/tui-window.js";

const roots: string[] = [];

function makeCaptureExecutable(options: { stdout?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "fly2058-marker-"));
	roots.push(root);
	const marker = syncOpMarkerPath(process.pid);
	const capture = join(root, "captured.jsonl");
	const executable = join(root, "capture.cjs");
	writeFileSync(
		executable,
		`#!${process.execPath}
const fs = require("node:fs");
let marker;
try { marker = JSON.parse(fs.readFileSync(${JSON.stringify(marker)}, "utf8")); }
catch { marker = { label: "MISSING" }; }
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(marker) + "\\n");
process.stdout.write(${JSON.stringify(options.stdout ?? "")});
`,
		{ mode: 0o755 },
	);
	return { root, marker, capture, executable };
}

function labels(capture: string): string[] {
	return readFileSync(capture, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line).label);
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("Bridge synchronous operation marker coverage", () => {
	it("records workflow docs async spans without URL/path material", async () => {
		const sha = "a".repeat(40);
		const fake = makeCaptureExecutable({ stdout: `${sha}\trefs/heads/main\n` });
		const spans: Array<{ name: string; startMs: number; endMs: number }> = [];
		const docs = new GitWorkflowDocsGit({
			gitPath: fake.executable,
			remoteUrl: () => "https://token@example.test/private.git",
			recordSpan: (name, startMs, endMs) =>
				spans.push({ name, startMs, endMs }),
		});
		await (
			docs as unknown as {
				run(args: string[], cwd: string): Promise<unknown>;
			}
		).run(["status", "--porcelain", "/private/repo"], fake.root);
		await docs.readRemoteHead({
			projectRoot: fake.root,
			repo: "owner/repo",
			ref: "refs/heads/flywheel/docs/flywheel/FLY-2058",
		});

		expect(spans.map(({ name }) => name)).toEqual([
			"workflow-docs-git:status",
			"workflow-docs-git:ls-remote",
		]);
		expect(spans.every(({ startMs, endMs }) => endMs >= startMs)).toBe(true);
		expect(JSON.stringify(spans)).not.toContain("token@example.test");
		expect(JSON.stringify(spans)).not.toContain("/private");
		expect(existsSync(fake.marker)).toBe(false);
	});

	it("replaces the parent environment for workflow docs git children", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2331-doc-env-"));
		roots.push(root);
		const executable = join(root, "env.cjs");
		writeFileSync(
			executable,
			`#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.env));\n`,
			{ mode: 0o755 },
		);
		const poisoned = [
			"HOME",
			"GIT_DIR",
			"GIT_WORK_TREE",
			"GIT_INDEX_FILE",
			"GIT_SSH_COMMAND",
			"GIT_CREDENTIAL_HELPER",
		] as const;
		const before = Object.fromEntries(
			poisoned.map((name) => [name, process.env[name]]),
		);
		for (const name of poisoned) process.env[name] = `poison-${name}`;
		try {
			const docs = new GitWorkflowDocsGit({
				gitPath: executable,
				token: "test-token",
			});
			const result = await (
				docs as unknown as {
					run(args: string[], cwd: string): Promise<{ stdout: string }>;
				}
			).run(["status", "--porcelain"], root);
			const childEnv = JSON.parse(result.stdout) as Record<string, string>;

			const expectedKeys = [
				"PATH",
				"LC_ALL",
				"GIT_CONFIG_GLOBAL",
				"GIT_CONFIG_SYSTEM",
				"GIT_TERMINAL_PROMPT",
				"GIT_OPTIONAL_LOCKS",
				"GIT_ASKPASS",
				"FLYWHEEL_GIT_TOKEN",
			];
			// macOS injects this locale identity into launched binaries even when
			// spawn receives an explicit replacement environment.
			if (process.platform === "darwin")
				expectedKeys.push("__CF_USER_TEXT_ENCODING");
			expect(Object.keys(childEnv).sort()).toEqual(expectedKeys.sort());
			expect(childEnv.FLYWHEEL_GIT_TOKEN).toBe("test-token");
			expect(childEnv.PATH).toBe(`${root}:/usr/bin:/bin`);
			for (const name of poisoned) expect(childEnv[name]).toBeUndefined();
		} finally {
			for (const name of poisoned) {
				const value = before[name];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("wires the workflow docs span recorder at the production construction", () => {
		const source = readFileSync(
			new URL("../bridge/plugin.ts", import.meta.url),
			"utf8",
		);
		const materializerStart = source.indexOf(
			"const workflowDocsMaterializer = new WorkflowDocsMaterializer",
		);
		const construction = source.slice(
			materializerStart,
			materializerStart + 800,
		);
		expect(materializerStart).toBeGreaterThanOrEqual(0);
		expect(construction).toContain("git: new GitWorkflowDocsGit({");
		expect(construction).toContain("eventLoopAttribution.recordSpan");
	});

	it("marks the resume-checkpoint git funnel with only the subcommand", () => {
		const fake = makeCaptureExecutable();
		const store = new GitWorkflowResumeCheckpointStore({
			storeRoot: fake.root,
			gitPath: fake.executable,
		});
		(
			store as unknown as {
				run(args: string[], cwd: string): unknown;
			}
		).run(
			["--git-dir", "/private/store.git", "rev-parse", "--verify", "secret"],
			fake.root,
		);

		expect(labels(fake.capture)).toEqual([
			"workflow-resume-checkpoint:rev-parse",
		]);
		expect(readFileSync(fake.capture, "utf8")).not.toContain("/private");
		expect(existsSync(fake.marker)).toBe(false);
	});

	it("marks the tmux scrub default executor", () => {
		const fake = makeCaptureExecutable();
		const bin = join(fake.root, ".local", "bin");
		mkdirSync(bin, { recursive: true });
		const tmux = join(bin, "tmux");
		writeFileSync(tmux, readFileSync(fake.executable), { mode: 0o755 });
		const oldStateDir = process.env.FLYWHEEL_STATE_DIR;
		process.env.FLYWHEEL_STATE_DIR = fake.root;
		try {
			scrubManagedTmuxEnvironments([], {
				env: {
					HOME: fake.root,
					USER: "test",
					SHELL: "/bin/sh",
					FLYWHEEL_TMUX_SOCKET_OVERRIDE: "/tmp/fly2058.sock",
				},
				readFile: () => "",
			});
		} finally {
			if (oldStateDir === undefined) delete process.env.FLYWHEEL_STATE_DIR;
			else process.env.FLYWHEEL_STATE_DIR = oldStateDir;
		}

		expect(new Set(labels(fake.capture))).toEqual(new Set(["tmux-scrub"]));
		expect(existsSync(fake.marker)).toBe(false);
	});

	it("marks each codex TUI tmux operation with its bounded subcommand", () => {
		const fake = makeCaptureExecutable();
		const bin = join(fake.root, ".local", "bin");
		const tuiMarker = join(
			fake.root,
			".flywheel",
			`bridge-syncop.${process.pid}.json`,
		);
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "tmux"),
			readFileSync(fake.executable, "utf8").replace(fake.marker, tuiMarker),
			{ mode: 0o755 },
		);
		const before = {
			home: process.env.HOME,
			path: process.env.PATH,
			state: process.env.FLYWHEEL_STATE_DIR,
		};
		process.env.HOME = fake.root;
		process.env.PATH = `${bin}:/usr/bin:/bin`;
		process.env.FLYWHEEL_STATE_DIR = fake.root;
		const logs: string[] = [];
		try {
			const result = ensureTuiWindow(
				{
					projectName: "flywheel",
					leadId: "test-lead",
					codexHome: "/tmp/codex",
					threadId: "thread-id",
					cwd: "/tmp/worktree",
				},
				{ log: (message) => logs.push(message) },
			);
			expect(result, logs.join("\n")).toBe(true);
		} finally {
			for (const [key, value] of [
				["HOME", before.home],
				["PATH", before.path],
				["FLYWHEEL_STATE_DIR", before.state],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}

		expect(labels(fake.capture)).toEqual([
			"codex-tui:tmux",
			"codex-tui:new-session",
			"codex-tui:kill-window",
			"codex-tui:new-window",
		]);
		expect(existsSync(tuiMarker)).toBe(false);
	});
});
