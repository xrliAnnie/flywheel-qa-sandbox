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
	windowLivenessMap,
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

	// Codex R1 P1: omitting sessionName made EVERY window read dead (false PASS).
	// It must fail loud, never silently report absence.
	it.each([undefined, ""])("throws when sessionName is %p", (bad) => {
		expect(() => windowLive("@303", panes, bad)).toThrow(
			/sessionName is required/,
		);
	});
});

// Codex R1 P1 regression: the unit tests above all passed sessionName correctly,
// so they proved windowLive right while the OBSERVER's call site was passing only
// two args — every window read dead. These cover the mapping the observer calls.
describe("target7 pane identity — windowLivenessMap (the observer's call shape)", () => {
	const panes = parsePaneSnapshot(
		`${SESSION}\t@303\tdesign\t%11\n${SESSION}\t@304\timplement\t%12\n`,
	);

	it("maps live and dead windows in one snapshot", () => {
		expect(windowLivenessMap(["@303", "@304", "@999"], panes, SESSION)).toEqual(
			{
				"@303": true,
				"@304": true,
				"@999": false,
			},
		);
	});

	it("reports every window live on an UNKNOWN snapshot (fail-closed)", () => {
		expect(windowLivenessMap(["@303", "@999"], null, SESSION)).toEqual({
			"@303": true,
			"@999": true,
		});
	});

	it("reports every window dead on a provably empty server", () => {
		expect(windowLivenessMap(["@303"], [], SESSION)).toEqual({ "@303": false });
	});

	it("throws rather than silently reporting all-dead without a session", () => {
		expect(() => windowLivenessMap(["@303"], panes, undefined)).toThrow(
			/sessionName is required/,
		);
	});
});

describe("target7 pane identity — paneSnapshotFromResult", () => {
	it("parses a successful probe", () => {
		expect(paneSnapshotFromResult(ok(`${SESSION}\t@303\td\t%11\n`))).toEqual([
			{
				sessionName: SESSION,
				windowId: "@303",
				windowName: "d",
				paneId: "%11",
			},
		]);
	});

	// A dead server provably holds zero panes — proof of absence, not unknown.
	// Without this the observer could never reach its terminal verdict after a
	// full teardown tore the server down with it.
	it("treats 'no server running' as a provably empty server", () => {
		expect(
			paneSnapshotFromResult({
				status: 1,
				stdout: "",
				stderr: "no server running on /tmp/tmux-501/default",
			}),
		).toEqual([]);
	});

	// Codex R1 P2: 'error connecting to' was ALSO mapped to [] — but tmux emits it
	// for every non-ECONNREFUSED failure (e.g. Permission denied), where the server
	// and its panes may be alive. Claiming absence there = every window reads dead
	// = false PASS. Only 'no server running' proves an empty server.
	it.each([
		"error connecting to /tmp/tmux-501/default (Permission denied)",
		"error connecting to /tmp/x",
		"permission denied",
		"",
	])("returns UNKNOWN (not empty) for %p", (stderr) => {
		expect(
			paneSnapshotFromResult({ status: 1, stdout: "", stderr }),
		).toBeNull();
	});
});
