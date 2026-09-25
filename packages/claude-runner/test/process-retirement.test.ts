import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PROCESS_RETIREMENT_GRACE_MS,
	processRetirementGraceMs,
	tmuxWindowPresence,
} from "../src/process-retirement.js";

describe("process retirement bounds", () => {
	const originalGrace = process.env.FLYWHEEL_NODE_STANDBY_RETIREMENT_GRACE_MS;

	afterEach(() => {
		if (originalGrace === undefined) {
			delete process.env.FLYWHEEL_NODE_STANDBY_RETIREMENT_GRACE_MS;
		} else {
			process.env.FLYWHEEL_NODE_STANDBY_RETIREMENT_GRACE_MS = originalGrace;
		}
	});

	it("keeps the run-frozen default when ambient retirement grace changes", () => {
		process.env.FLYWHEEL_NODE_STANDBY_RETIREMENT_GRACE_MS = "";
		expect(processRetirementGraceMs({ mode: "initial", generation: 1 })).toBe(
			DEFAULT_PROCESS_RETIREMENT_GRACE_MS,
		);
	});

	it("checks exact tmux window identity from the session inventory", () => {
		const calls: string[][] = [];
		const exec = (_command: string, args: string[]) => {
			calls.push(args);
			return { stdout: "@1|other\n@7|FLY-2808\n" };
		};

		expect(
			tmuxWindowPresence(exec, "flywheel", {
				windowId: "@42",
				windowName: "FLY-2808",
			}),
		).toBe("absent");
		expect(
			tmuxWindowPresence(exec, "flywheel", {
				windowId: "@7",
				windowName: "wrong-name-does-not-override-id",
			}),
		).toBe("present");
		expect(calls[0]).toEqual([
			"list-windows",
			"-t",
			"=flywheel",
			"-F",
			"#{window_id}|#{window_name}",
		]);
	});

	it("keeps malformed or unreadable tmux inventory indeterminate", () => {
		expect(
			tmuxWindowPresence(() => ({ stdout: "malformed" }), "flywheel", {
				windowId: "@7",
			}),
		).toBe("unknown");
		expect(
			tmuxWindowPresence(
				() => {
					throw new Error("tmux unavailable");
				},
				"flywheel",
				{ windowName: "FLY-2808" },
			),
		).toBe("unknown");
	});

	it("treats a session tmux reports missing as the window being gone", () => {
		// FLY-2808 QA: killing the session's last window destroys the session;
		// the owned window cannot outlive it, so retirement must not stay unknown.
		expect(
			tmuxWindowPresence(
				() => {
					throw new Error(
						"Command failed: tmux list-windows -t =flywheel\ncan't find session: flywheel\n",
					);
				},
				"flywheel",
				{ windowId: "@7" },
			),
		).toBe("absent");
		expect(
			tmuxWindowPresence(
				() => {
					throw new Error(
						"Command failed: tmux list-windows\nerror connecting to /tmp/tmux-501/default (Permission denied)\n",
					);
				},
				"flywheel",
				{ windowId: "@7" },
			),
		).toBe("unknown");
	});
});
