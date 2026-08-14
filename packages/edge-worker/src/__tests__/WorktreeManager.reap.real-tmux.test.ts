import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager } from "../WorktreeManager.js";

// FLY-1759: macOS caps AF_UNIX socket paths at 104 bytes, and TMPDIR is
// per-session on this fleet (a 142-byte socket path measured in a runner
// sandbox), so `os.tmpdir()` silently breaks the fixture with "File name too
// long". Anchor the fixture at a short root instead. This also matches the
// production leak shape: the FLY-1672 orphan held its socket outside the
// worktree while its cwd stayed inside it, and cwd is what the reaper matches.
const SHORT_TMP_ROOT = "/tmp";

function unsupportedReason(): string | null {
	try {
		execFileSync("tmux", ["-V"], { stdio: "ignore" });
	} catch {
		return "tmux is not installed";
	}
	try {
		execFileSync("ps", ["-axo", "pid="], { stdio: "ignore" });
	} catch {
		return "global `ps` is unavailable (sandboxed host)";
	}
	return null;
}

const skipReason = unsupportedReason();

// FLY-1759: this file is the only real-tmux coverage of the reaper, and a tmux
// server is exactly the process type that outlived teardown for 5 days in the
// 8-13 OOM incident. The CI workflow installs tmux for this job, so a missing
// tool on CI is a real regression — fail loudly rather than skip and report a
// green run that proved nothing.
if (process.env.CI && skipReason) {
	throw new Error(
		`FLY-1759 real-tmux reap coverage must not be skipped on CI: ${skipReason}`,
	);
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(skipReason !== null)(
	"FLY-1759 host-only real tmux reap",
	() => {
		let root = "";
		let socketPath = "";
		let serverPid = 0;

		afterEach(() => {
			// The socket is recorded before tmux starts, because there is a real
			// window where a server exists but its pid has not been read yet (the
			// start succeeded, the pid poll then failed or timed out). Killing by
			// socket first covers that window; pid/group kill is the fallback once
			// the pid is known. Leaking a tmux server out of *this* suite would
			// reproduce the very leak the suite exists to prevent.
			if (socketPath) {
				try {
					execFileSync("tmux", ["-S", socketPath, "kill-server"], {
						stdio: "ignore",
						timeout: 5_000,
					});
				} catch {}
			}
			if (serverPid > 1) {
				try {
					process.kill(-serverPid, "SIGKILL");
				} catch {}
				try {
					process.kill(serverPid, "SIGKILL");
				} catch {}
			}
			socketPath = "";
			serverPid = 0;
			if (root) fs.rmSync(root, { recursive: true, force: true });
			root = "";
		});

		it("reaps a real tmux server whose cwd is the removed worktree", async () => {
			root = fs.realpathSync(
				fs.mkdtempSync(path.join(SHORT_TMP_ROOT, "fly1759-real-tmux-")),
			);
			const repo = path.join(root, "flywheel");
			const worktree = path.join(root, "flywheel-FLY-1759");
			fs.mkdirSync(repo);
			git(repo, "init", "-q");
			git(repo, "config", "user.email", "fly1759@example.invalid");
			git(repo, "config", "user.name", "FLY-1759 Test");
			fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
			git(repo, "add", "README.md");
			git(repo, "commit", "-qm", "fixture");
			git(repo, "worktree", "add", "-q", "-b", "fly1759-tmux", worktree);

			const socket = path.join(worktree, "tmux.sock");
			// Guard the AF_UNIX limit explicitly: without this, relocating the
			// fixture root reintroduces an opaque "File name too long" failure.
			expect(Buffer.byteLength(socket)).toBeLessThan(104);
			// Recorded before the server exists so afterEach can always reach it.
			socketPath = socket;

			// `-D` and a command are mutually exclusive on tmux 3.5a — the earlier
			// fixture passed both, so tmux printed usage and exited 1, no server was
			// ever created, and the assertions below could never pass. Running the
			// client synchronously keeps that failure mode loud: a malformed
			// invocation throws here with tmux's own stderr instead of silently
			// timing out on a socket that never appears.
			try {
				execFileSync(
					"tmux",
					[
						"-S",
						socket,
						"new-session",
						"-d",
						"-s",
						"fly1759",
						"/bin/sleep",
						"300",
					],
					{
						cwd: worktree,
						stdio: ["ignore", "ignore", "pipe"],
						timeout: 10_000,
					},
				);
			} catch (error) {
				const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
				throw new Error(
					`tmux fixture did not start a server: ${stderr || String(error)}`,
				);
			}

			// The client exits as soon as it has daemonized the server, so its pid is
			// dead within ~1s no matter what teardown does. Asserting on it would be
			// vacuously green — bind to the real server pid instead.
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				try {
					const out = execFileSync(
						"tmux",
						["-S", socket, "display-message", "-p", "#{pid}"],
						{
							encoding: "utf8",
							stdio: ["ignore", "pipe", "ignore"],
							timeout: 5_000,
						},
					);
					const parsed = Number.parseInt(out.trim(), 10);
					if (Number.isInteger(parsed) && parsed > 1) {
						serverPid = parsed;
						break;
					}
				} catch {}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(serverPid).toBeGreaterThan(1);
			expect(alive(serverPid)).toBe(true);

			const result = await new WorktreeManager().remove(repo, worktree);

			const summary = result.reaps?.[0]?.summary;
			expect(summary?.verified).toBe(true);
			// `reaped` is the target set minus survivors, so this asserts the
			// reaper *matched this server as a cwd-rooted target and confirmed it
			// gone* — not, strictly, that a signal from the reaper is what killed
			// it. That is the property the old fixture never established: it
			// created no server at all. The server holds a 300s sleep, so it
			// cannot plausibly have exited on its own inside the test window.
			expect(summary?.reaped).toContain(serverPid);
			expect(summary?.survivors).toEqual([]);
			expect(alive(serverPid)).toBe(false);
			// Budget: 10s start + 10s pid poll + the reaper's own 25s deadline
			// (REAP_TOTAL_DEADLINE_MS) = 45s worst case. A 30s ceiling would abort
			// mid-`remove()` under CI load and race afterEach against a live reap.
		}, 60_000);
	},
);
