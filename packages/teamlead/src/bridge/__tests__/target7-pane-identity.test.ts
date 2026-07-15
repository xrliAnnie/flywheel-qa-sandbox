/**
 * FLY-1269 regression: the 529 terminal observer's tmux identity probe.
 *
 * The observer previously proved a window "live" with
 *   `tmux display-message -p -t "<session>:=<window_id>" "#{window_id}"`.
 * tmux resolves an unknown/deleted `-t` target against the CURRENT window and
 * exits 0, so a DELETED window printed a live window's id and read as ALIVE.
 * `terminal()` therefore never held and the A7 teardown check timed out (FAIL).
 *
 * These lock the identity rule that replaced it. Imported from the QA harness
 * dir because that is where the observer lives; the pure rules were split out of
 * the observer script (whose top-level poll loop makes it unimportable).
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs QA harness module, no type declarations
import {
	paneSnapshotFromResult,
	parsePaneSnapshot,
	windowLive,
} from "../../../../../engineering/doc/FLY-1269-codex-phase-keepalive/qa/target7-pane-identity.mjs";

const SESSION = "runner-test-slot-2";
const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });

describe("target7 pane identity — parsePaneSnapshot", () => {
	it("parses session/window_id/window_name/pane_id tuples", () => {
		expect(
			parsePaneSnapshot(
				`${SESSION}\t@303\tFLY-1269-design\t%11\n${SESSION}\t@304\tFLY-1269-implement\t%12\n`,
			),
		).toEqual([
			{
				sessionName: SESSION,
				windowId: "@303",
				windowName: "FLY-1269-design",
				paneId: "%11",
			},
			{
				sessionName: SESSION,
				windowId: "@304",
				windowName: "FLY-1269-implement",
				paneId: "%12",
			},
		]);
	});

	it("ignores blank lines", () => {
		expect(parsePaneSnapshot(`\n${SESSION}\t@1\tw\t%1\n\n`)).toHaveLength(1);
	});
});

describe("target7 pane identity — windowLive", () => {
	const panes = parsePaneSnapshot(
		`${SESSION}\t@303\tdesign\t%11\nother-session\t@304\timplement\t%12\n`,
	);

	it("reports a window present in its own session as live", () => {
		expect(windowLive("@303", panes, SESSION)).toBe(true);
	});

	// THE regression: the deleted window. Under display-message this returned
	// true (tmux fell back to the current window and exited 0).
	it("reports a window absent from the snapshot as DEAD", () => {
		expect(windowLive("@999", panes, SESSION)).toBe(false);
	});

	// Identity means the whole tuple: a matching window id in a DIFFERENT session
	// is a different window and must not count as ours.
	it("does not match a same-id window in another session", () => {
		expect(windowLive("@304", panes, SESSION)).toBe(false);
	});

	it("reports every window dead when the server holds no panes", () => {
		expect(windowLive("@303", [], SESSION)).toBe(false);
	});

	// Fail closed: unknown must never read as "gone", which would let the observer
	// declare a false PASS while a phase is still live.
	it("treats an UNKNOWN snapshot as live (fail-closed)", () => {
		expect(windowLive("@303", null, SESSION)).toBe(true);
	});
});

describe("target7 pane identity — paneSnapshotFromResult", () => {
	it("parses a successful probe", () => {
		expect(paneSnapshotFromResult(ok(`${SESSION}\t@303\td\t%11\n`))).toEqual([
			{ sessionName: SESSION, windowId: "@303", windowName: "d", paneId: "%11" },
		]);
	});

	// A dead server provably holds zero panes — proof of absence, not unknown.
	// Without this the observer could never reach its terminal verdict after a
	// full teardown tore the server down with it.
	it.each(["no server running on /tmp/tmux-501/default", "error connecting to /tmp/x"])(
		"treats %s as a provably empty server",
		(stderr) => {
			expect(paneSnapshotFromResult({ status: 1, stdout: "", stderr })).toEqual(
				[],
			);
		},
	);

	it("returns UNKNOWN for any other failure", () => {
		expect(
			paneSnapshotFromResult({ status: 1, stdout: "", stderr: "permission denied" }),
		).toBeNull();
	});
});
