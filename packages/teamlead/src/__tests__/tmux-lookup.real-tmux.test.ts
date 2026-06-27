/**
 * FLY-172 real-tmux probe (MEMORY / FLY-169 lesson): the orphan-reconcile design
 * hinges on `isTmuxWindowAlive` correctly distinguishing a live tmux window from
 * a dead/closed one. Mocks can encode WRONG assumptions about tmux behavior
 * (FLY-169's real-cmux spike caught a silent no-op the 132 unit tests missed), so
 * this test exercises the real `list-panes` path against a real tmux server.
 *
 * Skipped automatically when `tmux` is unavailable so CI without tmux stays green.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildAttachCommand,
	isTmuxWindowAlive,
	resolveCmuxAttachTarget,
} from "../bridge/tmux-lookup.js";

function tmuxAvailable(): boolean {
	const r = spawnSync("tmux", ["-V"], { stdio: "ignore" });
	return r.status === 0;
}

const hasTmux = tmuxAvailable();
const describeReal = hasTmux ? describe : describe.skip;

describeReal("isTmuxWindowAlive (real tmux)", () => {
	const session = `fly172-test-${randomUUID().slice(0, 8)}`;
	let windowTarget = "";

	afterAll(() => {
		// Best-effort cleanup; ignore if already gone.
		spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
	});

	it("returns true for a live window and false after it is killed", async () => {
		// Create a real detached session running a long-lived shell.
		execFileSync("tmux", ["new-session", "-d", "-s", session, "sleep 600"], {
			timeout: 5000,
		});
		const windowId = execFileSync(
			"tmux",
			["list-windows", "-t", session, "-F", "#{window_id}"],
			{ encoding: "utf8", timeout: 5000 },
		)
			.trim()
			.split("\n")[0];
		windowTarget = `${session}:${windowId}`; // e.g. "fly172-test-ab12:@0"

		// Live → alive.
		expect(await isTmuxWindowAlive(windowTarget)).toBe(true);

		// Kill the whole session → window gone.
		execFileSync("tmux", ["kill-session", "-t", session], { timeout: 5000 });
		expect(await isTmuxWindowAlive(windowTarget)).toBe(false);
	});

	it("returns false for a never-existed window (no false positive)", async () => {
		expect(await isTmuxWindowAlive(`nope-${randomUUID().slice(0, 8)}:@0`)).toBe(
			false,
		);
	});
});

// ── FLY-560 Feature C: real-tmux attach-target resolution ──
describeReal("resolveCmuxAttachTarget + buildAttachCommand (real tmux)", () => {
	const uid = randomUUID().slice(0, 8);
	const base = `fly560base-${uid}`;
	const winName = `FLY-560-claude-realtest-${uid}`;
	const cmuxName = `cmux-${winName}`;
	let tmuxWindow = "";

	afterAll(() => {
		spawnSync("tmux", ["kill-session", "-t", cmuxName], { stdio: "ignore" });
		spawnSync("tmux", ["kill-session", "-t", base], { stdio: "ignore" });
	});

	it("falls back to base before the cmux linked session exists; resolves cmux after", async () => {
		execFileSync(
			"tmux",
			["new-session", "-d", "-s", base, "-n", winName, "sleep 600"],
			{ timeout: 5000 },
		);
		const windowId = execFileSync(
			"tmux",
			["list-windows", "-t", base, "-F", "#{window_id}"],
			{ encoding: "utf8", timeout: 5000 },
		)
			.trim()
			.split("\n")[0];
		tmuxWindow = `${base}:${windowId}`;

		// No cmux linked session yet → base fallback.
		const before = await resolveCmuxAttachTarget(tmuxWindow);
		expect(before).toEqual({ kind: "base", session: base, tmuxWindow });

		// Create the cmux linked session (mirrors flywheel-cmux-sync.sh).
		execFileSync("tmux", ["new-session", "-d", "-s", cmuxName, "-t", base], {
			timeout: 5000,
		});
		const after = await resolveCmuxAttachTarget(tmuxWindow);
		expect(after).toEqual({ kind: "cmux", session: cmuxName });
	});

	it("renders shell-valid attach commands for both cmux and base fallback", () => {
		const cmuxCmd = buildAttachCommand({ kind: "cmux", session: cmuxName });
		expect(cmuxCmd).toBe(`tmux attach -t '=${cmuxName}'`);
		const baseCmd = buildAttachCommand({
			kind: "base",
			session: base,
			tmuxWindow: `${base}:@0`,
		});
		// Both must be syntactically valid shell (bash -n reads script from stdin).
		for (const cmd of [cmuxCmd, baseCmd]) {
			const r = spawnSync("bash", ["-n"], { input: cmd });
			expect(r.status).toBe(0);
		}
		// The fallback escapes the tmux command separator so the shell passes it
		// through to tmux (single tmux invocation, `;` is a literal arg).
		expect(baseCmd).toContain("; select-window -t '=");
	});
});
