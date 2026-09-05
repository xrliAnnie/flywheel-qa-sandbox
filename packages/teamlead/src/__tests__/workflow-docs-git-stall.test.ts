import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	mkdtempSync,
	readdirSync,
	readFile,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventLoopAttribution } from "../bridge/event-loop-attribution.js";
import {
	GitWorkflowDocsGit,
	yieldToTimers,
} from "../bridge/workflow-docs-git.js";
import { WorkflowDocsMaterializer } from "../bridge/workflow-docs-materializer.js";

function block(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function git(cwd: string, args: string[]): string {
	return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
}

const DIGEST = "d".repeat(64);
const EFFECT = `mat:${"e".repeat(64)}`;

function scriptedMaterializer(options: {
	timeoutOrdinal?: number;
	networkTimeoutMs?: number;
}) {
	const root = mkdtempSync(join(tmpdir(), "fly2058-eight-step-"));
	const work = join(root, "work");
	execFileSync("/usr/bin/git", ["init", "-q", "-b", "main", work]);
	git(work, ["config", "user.name", "Flywheel Test"]);
	git(work, ["config", "user.email", "test@flywheel.local"]);
	writeFileSync(join(work, "base.md"), "base\n");
	git(work, ["add", "base.md"]);
	git(work, ["commit", "-qm", "base"]);
	const base = git(work, ["rev-parse", "HEAD"]);
	const statePath = join(root, "network-state.json");
	const callsPath = join(root, "network-calls.jsonl");
	const heartbeatPath = join(root, "heartbeat");
	const fakeGit = join(root, "git.cjs");
	writeFileSync(heartbeatPath, "");
	writeFileSync(statePath, JSON.stringify({ ordinal: 0, pushedHead: null }));
	writeFileSync(
		fakeGit,
		`#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
function subcommand(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-c" || arg === "-C" || arg === "--git-dir") { index += 1; continue; }
    if (arg.startsWith("--git-dir=") || arg.startsWith("-")) continue;
    return arg;
  }
  return "git";
}
const sub = subcommand(args);
if (["ls-remote", "fetch", "push"].includes(sub)) {
  const statePath = ${JSON.stringify(statePath)};
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.ordinal += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
	const beat = fs.statSync(${JSON.stringify(heartbeatPath)}).size;
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ ordinal: state.ordinal, sub, beat }) + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.ordinal === ${options.timeoutOrdinal ?? -1} ? 5000 : 25);
  if (state.ordinal === 1) process.exit(2);
  if (state.ordinal === 2) process.stdout.write(${JSON.stringify(`${base}\tHEAD\n`)});
  if (state.ordinal === 4 || state.ordinal === 5) process.stdout.write(${JSON.stringify(`${base}\trefs/heads/flywheel/docs/flywheel/FLY-2058\n`)});
  if (state.ordinal === 6) {
    const refspec = args.find((arg) => /^[0-9a-f]{40}:refs\\//.test(arg));
    state.pushedHead = refspec.split(":", 1)[0];
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  if (state.ordinal === 7 || state.ordinal === 8) {
    const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
    process.stdout.write(current.pushedHead + "\\trefs/heads/flywheel/docs/flywheel/FLY-2058\\n");
  }
  process.exit(0);
}
const result = spawnSync("/usr/bin/git", args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`,
		{ mode: 0o755 },
	);

	let commitReceipt: { tree_head: string; commit_head: string } | undefined;
	let confirmed = false;
	const store = {
		listWorkflowMaterializationCandidates: () => [
			{
				runId: "run-2058",
				producerNodeId: "produce",
				reviewNodeId: "review",
				attempt: 1,
				outputId: 1,
				outputDigest: DIGEST,
				payload: JSON.stringify({
					kind: "docs_v1",
					operations: [
						{
							op: "write",
							path: "engineering/doc/probe.md",
							content: "probe\n",
						},
					],
				}),
				projectName: "flywheel",
				issueId: "FLY-2058",
			},
		],
		getWorkflowMaterializedHead: () =>
			confirmed
				? { head: commitReceipt!.commit_head, outputId: 1, attempt: 1 }
				: undefined,
		allocateWorkflowMaterialization: () => ({ effect_id: EFFECT }),
		getWorkflowMaterializationReceipts: () => [
			{ stage: "intent_pinned", base_head: base },
			...(commitReceipt ? [{ stage: "commit_adopted", ...commitReceipt }] : []),
		],
		adoptWorkflowMaterializationCommit: (input: {
			treeHead: string;
			commitHead: string;
		}) => {
			commitReceipt = {
				tree_head: input.treeHead,
				commit_head: input.commitHead,
			};
		},
		confirmWorkflowMaterializationPush: () => {
			confirmed = true;
		},
	};
	const logs: string[] = [];
	const materializer = new WorkflowDocsMaterializer({
		store: store as never,
		git: new GitWorkflowDocsGit({
			gitPath: fakeGit,
			remoteUrl: () => "https://example.test/repo.git",
			networkTimeoutMs: options.networkTimeoutMs,
		}),
		projects: [
			{
				projectName: "flywheel",
				projectRoot: work,
				projectRepo: "owner/repo",
				leads: [],
			},
		],
		withRepoLock: async (_root, run) => run(),
		log: (message) => logs.push(message),
	});
	return { root, materializer, callsPath, heartbeatPath, logs };
}

function residuePaths(root: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (statSync(path).isDirectory()) found.push(...residuePaths(path));
		else if (/\.lock$|(^|\/)tmp[_-]|temp.*pack/i.test(path)) found.push(path);
	}
	return found;
}

async function expectHeartbeatBeforeContinuation(
	enter: (run: () => Promise<void>) => void,
): Promise<void> {
	let beats = 0;
	const heartbeat = setInterval(() => {
		beats += 1;
	}, 2);
	try {
		await new Promise<void>((resolve, reject) => {
			enter(async () => {
				try {
					const before = beats;
					block(25);
					await yieldToTimers();
					expect(beats).toBeGreaterThan(before);
					resolve();
				} catch (error) {
					reject(error);
				}
			});
		});
	} finally {
		clearInterval(heartbeat);
	}
}

describe("workflow docs Git event-loop bounds", () => {
	it("yieldToTimers advances heartbeat from timer and poll phases", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2058-yield-"));
		const file = join(dir, "probe");
		writeFileSync(file, "probe");
		try {
			await expectHeartbeatBeforeContinuation((run) => {
				setTimeout(() => void run(), 0);
			});
			await expectHeartbeatBeforeContinuation((run) => {
				readFile(file, () => void run());
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("setImmediate is a negative control: it can resume before the next timer phase", async () => {
		await new Promise<void>((resolve, reject) => {
			setTimeout(() => {
				void (async () => {
					try {
						let timerRan = false;
						setTimeout(() => {
							timerRan = true;
						}, 0);
						block(25);
						await new Promise<void>((resume) => setImmediate(resume));
						expect(timerRan).toBe(false);
						await yieldToTimers();
						expect(timerRan).toBe(true);
						resolve();
					} catch (error) {
						reject(error);
					}
				})();
			}, 0);
		});
	});

	it("network timeout is hard-bounded without blocking the event loop", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2058-network-kill-"));
		try {
			const fakeGit = join(dir, "git.cjs");
			writeFileSync(
				fakeGit,
				`#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
				{ mode: 0o755 },
			);
			const recordSpan = vi.fn();
			const docs = new GitWorkflowDocsGit({
				gitPath: fakeGit,
				networkTimeoutMs: 100,
				recordSpan,
			});
			const startedAt = Date.now();
			let intervalTicks = 0;
			const interval = setInterval(() => intervalTicks++, 5);
			const result = await (
				docs as unknown as {
					runNetwork(
						args: string[],
						cwd: string,
					): Promise<{
						status: number;
						timedOut?: boolean;
					}>;
				}
			).runNetwork(["ls-remote", "https://example.test/repo"], dir);
			clearInterval(interval);
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			expect(result.status).not.toBe(0);
			expect(result.timedOut).toBe(true);
			expect(intervalTicks).toBeGreaterThan(0);
			expect(recordSpan).toHaveBeenCalledOnce();
			expect(recordSpan).toHaveBeenCalledWith(
				"workflow-docs-git:ls-remote",
				expect.any(Number),
				expect.any(Number),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("local git children also leave timers live", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2331-doc-local-"));
		try {
			const fakeGit = join(dir, "git.cjs");
			writeFileSync(
				fakeGit,
				`#!${process.execPath}\nsetTimeout(() => process.stdout.write("done"), 100);\n`,
				{ mode: 0o755 },
			);
			const docs = new GitWorkflowDocsGit({ gitPath: fakeGit });
			let intervalTicks = 0;
			const interval = setInterval(() => intervalTicks++, 5);
			const result = await (
				docs as unknown as {
					run(
						args: string[],
						cwd: string,
					): Promise<{ status: number; stdout: string }>;
				}
			).run(["status", "--porcelain"], dir);
			clearInterval(interval);

			expect(result).toMatchObject({ status: 0, stdout: "done" });
			expect(intervalTicks).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retains a production attribution span for a genuinely long async git child", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2331-doc-span-"));
		try {
			const fakeGit = join(dir, "git.cjs");
			const sha = "a".repeat(40);
			writeFileSync(
				fakeGit,
				`#!${process.execPath}\nsetTimeout(() => process.stdout.write(${JSON.stringify(`${sha}\trefs/heads/main\n`)}), 550);\n`,
				{ mode: 0o755 },
			);
			const attribution = new EventLoopAttribution({
				diagnosticsDir: join(dir, "diagnostics"),
				profilerEnabled: false,
			});
			const docs = new GitWorkflowDocsGit({
				gitPath: fakeGit,
				remoteUrl: () => "https://example.test/repo.git",
				recordSpan: (name, startMs, endMs) =>
					attribution.recordSpan(name, startMs, endMs),
			});

			await expect(
				docs.readRemoteHead({
					projectRoot: dir,
					repo: "owner/repo",
					ref: "refs/heads/flywheel/docs/flywheel/FLY-2331",
				}),
			).resolves.toBe(sha);
			expect(attribution.snapshot().long_wall_spans).toEqual([
				expect.objectContaining({ name: "workflow-docs-git:ls-remote" }),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the full eight-network-step materialization advances heartbeat between every pair", async () => {
		const fixture = scriptedMaterializer({});
		const heartbeat = setInterval(() => {
			appendFileSync(fixture.heartbeatPath, "x");
		}, 2);
		try {
			await expect(fixture.materializer.reconcile()).resolves.toEqual({
				materialized: 1,
				held: 0,
			});
			const calls = readFileSync(fixture.callsPath, "utf8")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as { ordinal: number; sub: string; beat: number },
				);
			expect(calls.map(({ ordinal, sub }) => [ordinal, sub])).toEqual([
				[1, "ls-remote"],
				[2, "ls-remote"],
				[3, "fetch"],
				[4, "ls-remote"],
				[5, "ls-remote"],
				[6, "push"],
				[7, "ls-remote"],
				[8, "ls-remote"],
			]);
			for (let index = 1; index < calls.length; index += 1) {
				expect(calls[index]!.beat).toBeGreaterThan(calls[index - 1]!.beat);
			}
		} finally {
			clearInterval(heartbeat);
			rmSync(fixture.root, { recursive: true, force: true });
		}
	}, 30_000);

	it("each of the eight network ordinals propagates a bounded timeout", async () => {
		for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
			const fixture = scriptedMaterializer({
				timeoutOrdinal: ordinal,
				networkTimeoutMs: 2_000,
			});
			try {
				await expect(fixture.materializer.reconcile()).resolves.toEqual({
					materialized: 0,
					held: 1,
				});
				const calls = readFileSync(fixture.callsPath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { ordinal: number });
				expect(calls.at(-1)?.ordinal).toBe(ordinal);
				expect(fixture.logs.at(-1)).toMatch(/held.*(ETIMEDOUT|timed out)/i);
			} finally {
				rmSync(fixture.root, { recursive: true, force: true });
			}
		}
	}, 120_000);

	it("a real Git fetch converges without lock/temp residue after SIGKILL timeout", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2058-real-fetch-"));
		try {
			const source = join(root, "source");
			const remote = join(root, "remote.git");
			const client = join(root, "client");
			execFileSync("/usr/bin/git", ["init", "-q", "--bare", remote]);
			execFileSync("/usr/bin/git", ["init", "-q", "-b", "main", source]);
			git(source, ["config", "user.name", "Flywheel Test"]);
			git(source, ["config", "user.email", "test@flywheel.local"]);
			writeFileSync(join(source, "base"), "base\n");
			git(source, ["add", "base"]);
			git(source, ["commit", "-qm", "base"]);
			git(source, ["push", remote, "main"]);
			execFileSync("/usr/bin/git", ["init", "-q", client]);
			git(client, ["fetch", remote, "main"]);
			writeFileSync(join(source, "payload.bin"), randomBytes(8 * 1024 * 1024));
			git(source, ["add", "payload.bin"]);
			git(source, ["commit", "-qm", "large"]);
			const head = git(source, ["rev-parse", "HEAD"]);
			git(source, ["push", remote, "main"]);

			const docs = new GitWorkflowDocsGit({
				gitPath: "/usr/bin/git",
				networkTimeoutMs: 1,
			});
			const killed = await (
				docs as unknown as {
					runNetwork(
						args: string[],
						cwd: string,
					): Promise<{
						status: number;
						timedOut?: boolean;
					}>;
				}
			).runNetwork(["fetch", "--quiet", "--no-tags", remote, head], client);
			expect(killed.status).not.toBe(0);
			expect(killed.timedOut).toBe(true);

			git(client, ["fetch", "--quiet", "--no-tags", remote, head]);
			expect(() =>
				git(client, ["cat-file", "-e", `${head}^{commit}`]),
			).not.toThrow();
			expect(residuePaths(join(client, ".git"))).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
