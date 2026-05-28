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
import { isTmuxWindowAlive } from "../bridge/tmux-lookup.js";

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
