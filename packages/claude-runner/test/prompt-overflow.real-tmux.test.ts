/**
 * FLY-1869 acceptance probe. This uses an isolated tmux socket and a tiny
 * Claude-compatible stub so the production TmuxAdapter launch path is tested
 * without touching the fleet or making a model call.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecFileFn } from "../src/TmuxAdapter.js";
import { TmuxAdapter } from "../src/TmuxAdapter.js";

function tmuxUsable(): boolean {
	if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return false;
	const socket = `fly1869-probe-${randomUUID().slice(0, 8)}`;
	const created = spawnSync(
		"tmux",
		["-L", socket, "new-session", "-d", "-s", "probe", "sleep", "5"],
		{ stdio: "ignore", timeout: 5000 },
	);
	if (created.status !== 0) return false;
	spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
	return true;
}

const describeReal = tmuxUsable() ? describe : describe.skip;

class StubClaudeTmuxAdapter extends TmuxAdapter {
	protected override readonly binaryName: string;

	constructor(sessionName: string, binaryName: string, execFileFn: ExecFileFn) {
		super(sessionName, execFileFn, 10, 5000);
		this.binaryName = binaryName;
	}
}

describeReal("FLY-1869 prompt overflow (real tmux)", () => {
	const sockets: string[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const socket of sockets.splice(0)) {
			spawnSync("tmux", ["-L", socket, "kill-server"], {
				stdio: "ignore",
			});
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createIsolatedSession(): {
		socket: string;
		session: string;
		execFileFn: ExecFileFn;
	} {
		const socket = `fly1869-${randomUUID().slice(0, 8)}`;
		const session = `runner-fly1869-${randomUUID().slice(0, 8)}`;
		sockets.push(socket);
		execFileSync(
			"tmux",
			["-L", socket, "new-session", "-d", "-s", session, "sleep", "120"],
			{ timeout: 5000 },
		);
		const execFileFn: ExecFileFn = (cmd, args, opts) => ({
			stdout: execFileSync(
				cmd,
				cmd === "tmux" ? ["-L", socket, ...args] : args,
				{
					encoding: "utf8",
					timeout: opts?.timeoutMs ?? 5000,
					...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
				},
			),
		});
		return { socket, session, execFileFn };
	}

	it("positive control: this tmux rejects a 20KB inline command", () => {
		const { socket, session } = createIsolatedSession();
		const result = spawnSync(
			"tmux",
			[
				"-L",
				socket,
				"new-window",
				"-t",
				`=${session}`,
				"/usr/bin/true",
				"x".repeat(20_000),
			],
			{ encoding: "utf8", timeout: 5000 },
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("command too long");
	});

	it("spawns the same 110KB execution five consecutive times", async () => {
		const { session, execFileFn } = createIsolatedSession();
		const tempDir = mkdtempSync(join(tmpdir(), "fly1869-real-"));
		tempDirs.push(tempDir);
		const recordFile = join(tempDir, "prompts.jsonl");
		const stubFile = join(tempDir, "claude-stub.mjs");
		writeFileSync(
			stubFile,
			`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
if (process.argv[2] === "--version") {
  process.stdout.write("claude-stub 1.0\\n");
  process.exit(0);
}
const prompt = process.argv.at(-1) ?? "";
appendFileSync(${JSON.stringify(recordFile)}, JSON.stringify({
  bytes: Buffer.byteLength(prompt, "utf8"),
  digest: createHash("sha256").update(prompt).digest("hex")
}) + "\\n");
`,
			{ mode: 0o700 },
		);
		chmodSync(stubFile, 0o700);

		const prompt = `FLY-1869 repeated launch\n${"x".repeat(110 * 1024)}`;
		const expectedDigest = createHash("sha256").update(prompt).digest("hex");
		const adapter = new StubClaudeTmuxAdapter(session, stubFile, execFileFn);

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const result = await adapter.execute({
				executionId: "fly1869-same-execution",
				issueId: "FLY-1869",
				label: "FLY-1869-long-description",
				prompt,
				cwd: tempDir,
				onTmuxWindowOpened: () => {},
			});
			expect(result.success).toBe(true);
			expect(result.timedOut).toBe(false);
		}

		const records = readFileSync(recordFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { bytes: number; digest: string });
		expect(records).toHaveLength(5);
		expect(records).toEqual(
			Array.from({ length: 5 }, () => ({
				bytes: Buffer.byteLength(prompt, "utf8"),
				digest: expectedDigest,
			})),
		);
	});
});
