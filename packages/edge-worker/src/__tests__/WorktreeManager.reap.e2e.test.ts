import type { ChildProcess } from "node:child_process";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../WorktreeManager.js";
import {
	parseLsofCwdOutput,
	reapWorktreeProcesses,
} from "../worktree-process-reaper.js";

const execFileAsync = promisify(execFile);

const realProcessCensusAvailable = (() => {
	try {
		execFileSync("ps", ["-axo", "pid="], { stdio: "ignore" });
		return true;
	} catch {
		// The Codex workspace sandbox denies global process census. CI does not;
		// these cases remain mandatory and unskipped on the ubuntu runner.
		return false;
	}
})();
const realCensusIt = realProcessCensusAvailable ? it : it.skip;

interface ProcessFixture {
	children: ChildProcess[];
	pids: number[];
	pgids: number[];
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout.trim();
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	description: string,
	timeoutMs = 8_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	do {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	throw new Error(`timed out waiting for ${description}`);
}

async function pgidMembers(pgids: number[]): Promise<number[]> {
	const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid="]);
	const wanted = new Set(pgids);
	return stdout
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)$/))
		.filter((match): match is RegExpMatchArray => match !== null)
		.filter((match) => wanted.has(Number.parseInt(match[2]!, 10)))
		.map((match) => Number.parseInt(match[1]!, 10));
}

async function cwdMatches(root: string): Promise<number[]> {
	const { stdout } = await execFileAsync("lsof", [
		"-a",
		"-d",
		"cwd",
		"-F",
		"pfn",
	]);
	const canonical = path.resolve(root);
	return parseLsofCwdOutput(stdout)
		.filter(
			(row) =>
				row.logicalCwd === canonical ||
				row.logicalCwd?.startsWith(`${canonical}${path.sep}`),
		)
		.map((row) => row.pid);
}

async function spawnProcessFamily(
	worktree: string,
	handshake: string,
): Promise<ProcessFixture> {
	const independentHandshake = `${handshake}.independent`;
	const shell = spawn(
		"/bin/sh",
		[
			"-c",
			[
				'pgid="$$"',
				'printf "%s %s\\n" "$$" "$pgid" > "$HANDSHAKE"',
				"/bin/sleep 300 &",
				'printf "%s %s\\n" "$!" "$pgid" >> "$HANDSHAKE"',
				"wait",
			].join("\n"),
		],
		{
			cwd: worktree,
			detached: true,
			env: { ...process.env, HANDSHAKE: handshake },
			stdio: "ignore",
		},
	);
	const independent = spawn(
		"/bin/sh",
		["-c", 'printf "%s %s\\n" "$$" "$$" > "$HANDSHAKE"\nexec /bin/sleep 300'],
		{
			cwd: worktree,
			detached: true,
			env: { ...process.env, HANDSHAKE: independentHandshake },
			stdio: "ignore",
		},
	);
	if (shell.pid === undefined || independent.pid === undefined) {
		throw new Error("failed to spawn process fixture");
	}
	shell.unref();
	independent.unref();
	await waitFor(
		() =>
			fs.existsSync(handshake) &&
			fs.readFileSync(handshake, "utf8").trim().split("\n").length === 2 &&
			fs.existsSync(independentHandshake),
		"child/sun process handshake",
	);
	const lines = fs.readFileSync(handshake, "utf8").trim().split("\n");
	const [shellText, pgidText] = lines[0]!.split(/\s+/);
	const [descendantText, descendantPgidText] = lines[1]!.split(/\s+/);
	const [independentText, independentPgidText] = fs
		.readFileSync(independentHandshake, "utf8")
		.trim()
		.split(/\s+/);
	const shellPid = Number.parseInt(shellText!, 10);
	const shellPgid = Number.parseInt(pgidText!, 10);
	const descendantPid = Number.parseInt(descendantText!, 10);
	const descendantPgid = Number.parseInt(descendantPgidText!, 10);
	const independentPid = Number.parseInt(independentText!, 10);
	const independentPgid = Number.parseInt(independentPgidText!, 10);
	if (!Number.isSafeInteger(shellPgid)) {
		throw new Error(`invalid process handshake: ${JSON.stringify(lines)}`);
	}
	expect(shellPid).toBe(shell.pid);
	expect(shellPgid).toBe(shell.pid);
	expect(descendantPgid).toBe(shellPgid);
	expect(independentPid).toBe(independent.pid);
	expect(independentPgid).toBe(independent.pid);
	expect([shellPid, descendantPid, independentPid].every(alive)).toBe(true);
	return {
		children: [shell, independent],
		pids: [shellPid, descendantPid, independentPid],
		pgids: [shellPgid, independentPgid],
	};
}

async function spawnLateForkFamily(
	worktree: string,
	handshake: string,
	lateHandshake: string,
): Promise<ProcessFixture> {
	const shell = spawn(
		"/bin/sh",
		[
			"-c",
			[
				'trap \'trap - TERM; /bin/sleep 300 & printf "%s %s\\\\n" "$!" "$$" > "$LATE_HANDSHAKE"; wait\' TERM',
				"/bin/sleep 300 &",
				'printf "%s %s\\n%s %s\\n" "$$" "$$" "$!" "$$" > "$HANDSHAKE"',
				"wait",
				"while :; do /bin/sleep 300; done",
			].join("\n"),
		],
		{
			cwd: worktree,
			detached: true,
			env: {
				...process.env,
				HANDSHAKE: handshake,
				LATE_HANDSHAKE: lateHandshake,
			},
			stdio: "ignore",
		},
	);
	if (shell.pid === undefined)
		throw new Error("failed to spawn late-fork fixture");
	shell.unref();
	await waitFor(
		() =>
			fs.existsSync(handshake) &&
			fs.readFileSync(handshake, "utf8").trim().split("\n").length === 2,
		"late-fork initial handshake",
	);
	const rows = fs
		.readFileSync(handshake, "utf8")
		.trim()
		.split("\n")
		.map((line) =>
			line.split(/\s+/).map((value) => Number.parseInt(value, 10)),
		);
	const initialChild = rows[1]![0]!;
	expect(rows[0]).toEqual([shell.pid, shell.pid]);
	expect(rows[1]![1]).toBe(shell.pid);
	return {
		children: [shell],
		pids: [shell.pid, initialChild],
		pgids: [shell.pid],
	};
}

async function spawnSharedGroup(
	worktree: string,
	outside: string,
	handshake: string,
): Promise<{
	fixture: ProcessFixture;
	targetPid: number;
	outsidePids: number[];
}> {
	const leader = spawn(
		"/bin/sh",
		[
			"-c",
			[
				'(cd "$WORKTREE" && exec /bin/sleep 300) & target=$!',
				'(cd "$OUTSIDE" && exec /bin/sleep 300) & sibling=$!',
				'printf "%s %s\\n%s %s\\n%s %s\\n" "$$" "$$" "$target" "$$" "$sibling" "$$" > "$HANDSHAKE"',
				"wait",
			].join("\n"),
		],
		{
			cwd: outside,
			detached: true,
			env: {
				...process.env,
				WORKTREE: worktree,
				OUTSIDE: outside,
				HANDSHAKE: handshake,
			},
			stdio: "ignore",
		},
	);
	if (leader.pid === undefined) throw new Error("failed to spawn shared group");
	leader.unref();
	await waitFor(
		() =>
			fs.existsSync(handshake) &&
			fs.readFileSync(handshake, "utf8").trim().split("\n").length === 3,
		"shared-group handshake",
	);
	const rows = fs
		.readFileSync(handshake, "utf8")
		.trim()
		.split("\n")
		.map((line) =>
			line.split(/\s+/).map((value) => Number.parseInt(value, 10)),
		);
	const targetPid = rows[1]![0]!;
	const siblingPid = rows[2]![0]!;
	expect(rows.every((row) => row[1] === leader.pid)).toBe(true);
	return {
		fixture: {
			children: [leader],
			pids: [leader.pid, targetPid, siblingPid],
			pgids: [leader.pid],
		},
		targetPid,
		outsidePids: [leader.pid, siblingPid],
	};
}

describe("FLY-1759 real worktree teardown process reap", () => {
	const roots: string[] = [];
	const fixtures: ProcessFixture[] = [];

	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			for (const pgid of fixture.pgids) {
				try {
					process.kill(-pgid, "SIGKILL");
				} catch {}
			}
			for (const pid of fixture.pids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	async function repoFixture() {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "fly1759-e2e-")),
		);
		roots.push(root);
		const mainRepo = path.join(root, "flywheel");
		const worktree = path.join(root, "flywheel-FLY-1759");
		fs.mkdirSync(mainRepo);
		await git(mainRepo, "init", "-q");
		await git(mainRepo, "config", "user.email", "fly1759@example.invalid");
		await git(mainRepo, "config", "user.name", "FLY-1759 Test");
		fs.writeFileSync(path.join(mainRepo, "README.md"), "fixture\n");
		await git(mainRepo, "add", "README.md");
		await git(mainRepo, "commit", "-qm", "fixture");
		await git(
			mainRepo,
			"worktree",
			"add",
			"-q",
			"-b",
			"fly1759-case",
			worktree,
		);
		return { root, mainRepo, worktree };
	}

	async function expectFullyReaped(
		fixture: ProcessFixture,
		worktree: string,
	): Promise<void> {
		await waitFor(
			() => fixture.pids.every((pid) => !alive(pid)),
			"every recorded child/sun PID to exit",
		);
		expect(await pgidMembers(fixture.pgids)).toEqual([]);
		expect(await cwdMatches(worktree)).toEqual([]);
	}

	realCensusIt(
		"E1: rename+.removing path leaves zero child/sun or mixed-type process",
		async () => {
			const { root, mainRepo, worktree } = await repoFixture();
			const fixture = await spawnProcessFamily(
				worktree,
				path.join(root, "rename-handshake"),
			);
			fixtures.push(fixture);
			const outsider = spawn("/bin/sleep", ["300"], {
				cwd: mainRepo,
				detached: true,
				stdio: "ignore",
			});
			if (outsider.pid === undefined)
				throw new Error("failed to spawn outsider");
			outsider.unref();
			fixtures.push({
				children: [outsider],
				pids: [outsider.pid],
				pgids: [outsider.pid],
			});

			const result = await new WorktreeManager().remove(mainRepo, worktree);

			expect(result.reaps?.[0]?.summary).toMatchObject({
				matched: expect.any(Number),
				survivors: [],
				verified: true,
			});
			expect(result.reaps![0]!.summary.matched).toBeGreaterThanOrEqual(3);
			await expectFullyReaped(fixture, worktree);
			expect(alive(outsider.pid)).toBe(true);
			expect(fs.existsSync(worktree)).toBe(false);
		},
		20_000,
	);

	realCensusIt(
		"E2: git worktree remove leaves zero child/sun or mixed-type process",
		async () => {
			const { root, mainRepo, worktree } = await repoFixture();
			const fixture = await spawnProcessFamily(
				worktree,
				path.join(root, "git-remove-handshake"),
			);
			fixtures.push(fixture);

			const result = await new WorktreeManager().removeCleanWorktreeByPath(
				mainRepo,
				worktree,
			);

			expect(result.removed).toBe(true);
			expect(result.reaps?.[0]?.summary).toMatchObject({
				matched: expect.any(Number),
				survivors: [],
				verified: true,
			});
			expect(result.reaps![0]!.summary.matched).toBeGreaterThanOrEqual(3);
			await expectFullyReaped(fixture, worktree);
			expect(fs.existsSync(worktree)).toBe(false);
		},
		20_000,
	);

	for (const removal of ["rename", "git-remove"] as const) {
		realCensusIt(
			`E1b/E2b: ${removal} converges a child forked by the first TERM`,
			async () => {
				const { root, mainRepo, worktree } = await repoFixture();
				const lateHandshake = path.join(root, `${removal}-late-handshake`);
				const fixture = await spawnLateForkFamily(
					worktree,
					path.join(root, `${removal}-initial-handshake`),
					lateHandshake,
				);
				fixtures.push(fixture);

				const result =
					removal === "rename"
						? await new WorktreeManager().remove(mainRepo, worktree)
						: await new WorktreeManager().removeCleanWorktreeByPath(
								mainRepo,
								worktree,
							);
				await waitFor(
					() => fs.existsSync(lateHandshake),
					"TERM-triggered fork handshake",
				);
				const latePid = Number.parseInt(
					fs.readFileSync(lateHandshake, "utf8").trim().split(/\s+/)[0]!,
					10,
				);
				fixture.pids.push(latePid);
				expect(result.reaps?.[0]?.summary).toMatchObject({
					survivors: [],
					verified: true,
				});
				await expectFullyReaped(fixture, worktree);
			},
			30_000,
		);
	}

	realCensusIt(
		"E4: a cwd target is point-killed when its process group has outside members",
		async () => {
			const { root, mainRepo, worktree } = await repoFixture();
			const group = await spawnSharedGroup(
				worktree,
				mainRepo,
				path.join(root, "shared-group-handshake"),
			);
			fixtures.push(group.fixture);

			const result = await new WorktreeManager().removeCleanWorktreeByPath(
				mainRepo,
				worktree,
			);

			expect(result.removed).toBe(true);
			await waitFor(
				() => !alive(group.targetPid),
				"same-group cwd target exit",
			);
			expect(group.outsidePids.every(alive)).toBe(true);
			expect(result.reaps?.[0]?.summary.verified).toBe(true);
		},
		20_000,
	);

	realCensusIt(
		"E6: pruneOrphans reaps a stale .removing-* process tree before deleting it",
		async () => {
			const { root, mainRepo } = await repoFixture();
			const residue = path.join(root, "flywheel-FLY-1700.removing-123456");
			fs.mkdirSync(residue);
			const fixture = await spawnProcessFamily(
				residue,
				path.join(root, "residue-handshake"),
			);
			fixtures.push(fixture);

			const pruned = await new WorktreeManager().pruneOrphans(mainRepo, "proj");

			expect(pruned).toContain(residue);
			await expectFullyReaped(fixture, residue);
			expect(fs.existsSync(residue)).toBe(false);
		},
		20_000,
	);

	realCensusIt(
		"E7: pruneOrphans reaps a real Linux-style deleted cwd",
		async () => {
			const { root, mainRepo } = await repoFixture();
			const gone = path.join(root, "flywheel-FLY-1701");
			fs.mkdirSync(gone);
			const child = spawn("/bin/sleep", ["300"], {
				cwd: gone,
				detached: true,
				stdio: "ignore",
			});
			if (child.pid === undefined)
				throw new Error("failed to spawn deleted-cwd fixture");
			child.unref();
			const fixture = {
				children: [child],
				pids: [child.pid],
				pgids: [child.pid],
			};
			fixtures.push(fixture);
			await waitFor(
				async () => (await cwdMatches(gone)).includes(child.pid!),
				"deleted-cwd fixture attribution",
			);
			fs.rmdirSync(gone);

			const pruned = await new WorktreeManager().pruneOrphans(mainRepo, "proj");

			expect(pruned).toContain(gone);
			await expectFullyReaped(fixture, gone);
		},
		20_000,
	);

	realCensusIt(
		"E7 negative: a same-path recreation prevents signaling the old deleted cwd",
		async () => {
			const { root, mainRepo } = await repoFixture();
			const gone = path.join(root, "flywheel-FLY-1702");
			fs.mkdirSync(gone);
			const child = spawn("/bin/sleep", ["300"], {
				cwd: gone,
				detached: true,
				stdio: "ignore",
			});
			if (child.pid === undefined)
				throw new Error("failed to spawn recreation fixture");
			child.unref();
			fixtures.push({
				children: [child],
				pids: [child.pid],
				pgids: [child.pid],
			});
			await waitFor(
				async () => (await cwdMatches(gone)).includes(child.pid!),
				"recreation fixture attribution",
			);
			fs.rmdirSync(gone);
			fs.mkdirSync(gone);

			const pruned = await new WorktreeManager().pruneOrphans(mainRepo, "proj");

			expect(pruned).not.toContain(gone);
			expect(alive(child.pid)).toBe(true);
		},
		20_000,
	);

	it("E8: a real lexical symlink root is refused without killing its target", async () => {
		const { root } = await repoFixture();
		const realRoot = path.join(root, "flywheel-X");
		const symlinkRoot = path.join(root, "flywheel-Y");
		fs.mkdirSync(realRoot);
		fs.symlinkSync(realRoot, symlinkRoot);
		const child = spawn("/bin/sleep", ["300"], {
			cwd: realRoot,
			detached: true,
			stdio: "ignore",
		});
		if (child.pid === undefined)
			throw new Error("failed to spawn symlink fixture");
		child.unref();
		fixtures.push({ children: [child], pids: [child.pid], pgids: [child.pid] });

		const summary = await reapWorktreeProcesses({
			lexicalPath: symlinkRoot,
			canonicalPath: fs.realpathSync(realRoot),
			expectedParentDir: root,
			repoSlugPrefix: "flywheel-",
			rootProof: "live-dir",
		});

		expect(summary.refusedReason).toContain("symlink");
		expect(summary.verified).toBe(false);
		expect(alive(child.pid)).toBe(true);
	}, 20_000);
});
