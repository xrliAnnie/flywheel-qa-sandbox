/**
 * FLY-758 real-tmux probe (QA lesson): the unit-test mock fed `list-windows`
 * `@0|zsh` directly and hid a timing race — a FRESH `tmux new-session` names its
 * default scaffold window `tmux` (not `zsh`) for several seconds, because tmux's
 * automatic-rename only fires after the shell prints a prompt (~8s on prod tmux
 * 3.5a). The runner spawn path (ensureSession → new-window → prune) runs in
 * milliseconds, so a name-only {zsh,bash} prune would MISS the scaffold on the
 * first spawn into a fresh base session — the GEO-436 scenario.
 *
 * These exercise the REAL fix (`ensureRunnerSession` renames the scaffold to
 * `zsh` at create time) + `pruneScaffoldWindow` against a real tmux server.
 *
 * Skipped automatically when `tmux` is unavailable so CI without tmux stays green.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultExecFile,
	ensureRunnerSession,
	pruneScaffoldWindow,
} from "../src/TmuxAdapter.js";

// FUNCTIONAL probe (Codex code review R2 LOW): a `tmux -V` check is not enough —
// some sandboxes (e.g. restricted CI, Codex's harness) ship the tmux binary but
// deny server/socket ops (EPERM on `new-session`). Actually create + kill a
// throwaway session so this suite SKIPS (not fails) wherever tmux can't run.
function tmuxUsable(): boolean {
	if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return false;
	const probe = `runner-fly758probe-${randomUUID().slice(0, 8)}`;
	const created = spawnSync("tmux", ["new-session", "-d", "-s", probe], {
		stdio: "ignore",
		timeout: 5000,
	});
	if (created.status !== 0) return false;
	spawnSync("tmux", ["kill-session", "-t", `=${probe}`], { stdio: "ignore" });
	return true;
}
const describeReal = tmuxUsable() ? describe : describe.skip;

interface Win {
	id: string;
	name: string;
}
function listWindows(session: string): Win[] {
	const out = execFileSync(
		"tmux",
		["list-windows", "-t", `=${session}`, "-F", "#{window_id}|#{window_name}"],
		{ encoding: "utf8", timeout: 5000 },
	).trim();
	if (!out) return [];
	return out.split("\n").map((l) => {
		const i = l.indexOf("|");
		return { id: l.slice(0, i), name: l.slice(i + 1) };
	});
}

describeReal("FLY-758 scaffold prune (real tmux)", () => {
	const sessions: string[] = [];
	function newSessionName(): string {
		const s = `runner-fly758it-${randomUUID().slice(0, 8)}`;
		sessions.push(s);
		return s;
	}
	afterEach(() => {
		for (const s of sessions.splice(0)) {
			spawnSync("tmux", ["kill-session", "-t", `=${s}`], { stdio: "ignore" });
		}
	});

	it("the race this fix removes: a name-only prune MISSES a scaffold still named 'tmux'", () => {
		// On a fresh session tmux names the scaffold "tmux" until automatic-rename
		// fires (async, ~8s on prod). Reproduce that transient deterministically by
		// renaming, then show the name-only {zsh,bash} predicate does not match it —
		// which is exactly why ensureRunnerSession normalizes the name at create time.
		const s = newSessionName();
		execFileSync("tmux", ["new-session", "-d", "-s", s], { timeout: 5000 });
		const win0 = listWindows(s)[0].id;
		execFileSync("tmux", ["rename-window", "-t", win0, "tmux"], {
			timeout: 5000,
		});
		execFileSync(
			"tmux",
			["new-window", "-t", `=${s}`, "-n", "GEO-1-claude-a"],
			{
				timeout: 5000,
			},
		);
		pruneScaffoldWindow(defaultExecFile, s, "@nonexistent");
		// Scaffold named "tmux" is NOT in {zsh,bash} → survives (the bug the fix removes).
		expect(listWindows(s).map((w) => w.name)).toContain("tmux");
	});

	it("ensureRunnerSession names the scaffold zsh immediately, and prune removes it after new-window", () => {
		const s = newSessionName();
		// Fix path: create + normalize the scaffold name at millisecond time.
		ensureRunnerSession(defaultExecFile, s);
		const before = listWindows(s);
		expect(before).toHaveLength(1);
		expect(before[0].name).toBe("zsh"); // race defeated — named zsh right away

		// Add a real runner-like window (mirrors TmuxAdapter.execute's new-window).
		const runnerWid = execFileSync(
			"tmux",
			[
				"new-window",
				"-t",
				`=${s}`,
				"-P",
				"-F",
				"#{window_id}",
				"-n",
				"GEO-436-claude-fix",
			],
			{ encoding: "utf8", timeout: 5000 },
		).trim();
		expect(listWindows(s)).toHaveLength(2);

		// Prune — the exact call TmuxAdapter.execute makes.
		pruneScaffoldWindow(defaultExecFile, s, runnerWid);

		const after = listWindows(s);
		expect(after).toHaveLength(1);
		expect(after[0].id).toBe(runnerWid); // only the runner window remains
		expect(after.map((w) => w.name)).not.toContain("zsh"); // scaffold gone
	});

	it("never kills the keepWindowId even when it is the zsh-named window (defense in depth)", () => {
		const s = newSessionName();
		ensureRunnerSession(defaultExecFile, s); // scaffold named zsh
		const scaffoldId = listWindows(s)[0].id;
		execFileSync(
			"tmux",
			["new-window", "-t", `=${s}`, "-n", "GEO-1-claude-a"],
			{ timeout: 5000 },
		);
		// Pass the zsh scaffold's own id as keepWindowId → it must be skipped.
		pruneScaffoldWindow(defaultExecFile, s, scaffoldId);
		expect(listWindows(s).map((w) => w.name)).toContain("zsh"); // survived
	});

	it("never prunes when only the runner window exists (>=2 guard, never kills the session)", () => {
		const s = newSessionName();
		// Sole window is a runner-like window (not a shell name).
		execFileSync(
			"tmux",
			["new-session", "-d", "-s", s, "-n", "GEO-2-claude-b"],
			{
				timeout: 5000,
			},
		);
		pruneScaffoldWindow(defaultExecFile, s, "@nonexistent");
		expect(listWindows(s)).toHaveLength(1); // still alive
	});
});
