import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	listProcessCwds,
	parseLsofCwds,
	sweepStaleCodexContainers,
} from "../codex/stale-roots.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function scratch() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2885-sweep-")));
	roots.push(root);
	const containers = join(root, "codex-containers");
	mkdirSync(containers, { mode: 0o700 });
	return { root, containers };
}

describe("stale Codex container sweep (FLY-2885 T7)", () => {
	it("parses lsof -d cwd -Fn records", () => {
		expect(
			parseLsofCwds("p212\nfcwd\nn/Users/a/work\np298\nfcwd\nn/tmp/x y\n"),
		).toEqual(["/Users/a/work", "/tmp/x y"]);
	});

	it("removes an idle leftover root, keeps a busy one, and never follows a symlink", async () => {
		const { root, containers } = scratch();
		const idle = join(containers, "container-idle");
		const busy = join(containers, "container-busy");
		mkdirSync(join(idle, "home"), { recursive: true });
		mkdirSync(join(busy, "work"), { recursive: true });
		// A credential link inside the idle root must go without its target.
		const credential = join(root, "fleet-auth.json");
		writeFileSync(credential, "secret", { mode: 0o600 });
		symlinkSync(credential, join(idle, "home", "auth.json"));
		// A symlinked "container" pointing outside must not be followed.
		const outside = join(root, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "keep"), "keep");
		symlinkSync(outside, join(containers, "container-link"));
		const evidence: Record<string, unknown>[] = [];
		await sweepStaleCodexContainers(containers, {
			listCwds: async () => [join(busy, "work"), "/elsewhere"],
			evidence: (record) => evidence.push(record),
		});
		expect(existsSync(idle)).toBe(false);
		expect(readFileSync(credential, "utf8")).toBe("secret");
		expect(existsSync(busy)).toBe(true);
		expect(existsSync(join(outside, "keep"))).toBe(true);
		expect(evidence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "codex_voice_stale_root_removed",
					root: idle,
				}),
				expect.objectContaining({
					kind: "codex_voice_stale_root_busy",
					root: busy,
				}),
			]),
		);
	});

	it("keeps every leftover root when lsof cannot answer", async () => {
		const { containers } = scratch();
		const leftover = join(containers, "container-unknown");
		mkdirSync(leftover);
		const evidence: Record<string, unknown>[] = [];
		await sweepStaleCodexContainers(containers, {
			listCwds: async () => undefined,
			evidence: (record) => evidence.push(record),
		});
		expect(existsSync(leftover)).toBe(true);
		expect(evidence).toEqual([
			expect.objectContaining({
				kind: "codex_voice_stale_root_unverified",
				root: leftover,
			}),
		]);
	});

	it("does nothing when the containers directory does not exist", async () => {
		const evidence: Record<string, unknown>[] = [];
		await sweepStaleCodexContainers(join(tmpdir(), "fly2885-missing-dir"), {
			listCwds: async () => [],
			evidence: (record) => evidence.push(record),
		});
		expect(evidence).toEqual([]);
	});

	it("leaves no root and no child after launchd kills a daemon mid-session and it starts again (Lead bfcaeb10)", async () => {
		const { containers } = scratch();
		const root = join(containers, "container-truncated");
		const work = join(root, "work");
		mkdirSync(work, { recursive: true });
		// A daemon stand-in running an app-server stand-in in the root's
		// workdir with stdin piped, as the container spawns codex app-server
		// (which exits on stdin EOF).
		const appServer =
			"process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);";
		const daemon = spawn(
			process.execPath,
			[
				"-e",
				`const app = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(appServer)}], { cwd: ${JSON.stringify(work)}, stdio: ["pipe", "ignore", "ignore"] }); console.log(app.pid); setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		let appPid = 0;
		try {
			appPid = await new Promise<number>((resolve, reject) => {
				daemon.stdout.once("data", (chunk) => resolve(Number(String(chunk))));
				daemon.once("exit", () => reject(new Error("stand-in exited")));
			});
			const alive = (pid: number) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			expect(alive(appPid)).toBe(true);
			// While the session runs, a start keeps its root: someone works there.
			const listCwds = listProcessCwds;
			await sweepStaleCodexContainers(containers, {
				listCwds,
				evidence: () => undefined,
			});
			expect(existsSync(root)).toBe(true);
			// launchd's SIGKILL at the exit timeout: no cleanup runs in the daemon.
			daemon.kill("SIGKILL");
			// The app-server loses its stdin and exits on its own.
			await vi.waitFor(() => expect(alive(appPid)).toBe(false), {
				timeout: 5_000,
			});
			// The next start sweeps what the cut shutdown left behind.
			const evidence: Record<string, unknown>[] = [];
			await sweepStaleCodexContainers(containers, {
				listCwds,
				evidence: (record) => evidence.push(record),
			});
			expect(readdirSync(containers)).toEqual([]);
			expect(evidence).toContainEqual(
				expect.objectContaining({
					kind: "codex_voice_stale_root_removed",
					root,
				}),
			);
		} finally {
			if (daemon.exitCode === null && daemon.signalCode === null)
				daemon.kill("SIGKILL");
		}
	}, 30_000);
});
