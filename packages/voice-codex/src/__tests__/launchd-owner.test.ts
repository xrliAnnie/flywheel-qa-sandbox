import { describe, expect, it, vi } from "vitest";
import { probeVoiceLaunchdOwner } from "../launchd-owner.js";

const RUNNING = `com.flywheel.voice = {
	active count = 1
	path = /Users/tester/Library/LaunchAgents/com.flywheel.voice.plist
	state = running
	pid = 4242
	program = /bin/bash
}`;

const DORMANT = `com.flywheel.voice = {
	active count = 0
	path = /Users/tester/Library/LaunchAgents/com.flywheel.voice.plist
	state = not running
	program = /bin/bash
}`;

describe("probeVoiceLaunchdOwner", () => {
	it("reads the exact fixed label under the caller's own domain", async () => {
		const run = vi.fn(async () => ({ stdout: DORMANT }));
		await probeVoiceLaunchdOwner({ uid: 501, selfPid: 10, run });
		expect(run).toHaveBeenCalledWith(
			"/bin/launchctl",
			["print", "gui/501/com.flywheel.voice"],
			{ timeout: 2_000, maxBuffer: 256 * 1024 },
		);
	});

	it("names the host's running instance as the lock owner", async () => {
		const run = vi.fn(async () => ({ stdout: RUNNING }));
		expect(
			await probeVoiceLaunchdOwner({ uid: 501, selfPid: 10, run }),
		).toEqual({
			kind: "launchd_running",
			label: "com.flywheel.voice",
			pid: 4242,
			source: "launchctl_print",
		});
	});

	it("reports a dormant registration rather than inventing an owner", async () => {
		const run = vi.fn(async () => ({ stdout: DORMANT }));
		expect(
			await probeVoiceLaunchdOwner({ uid: 501, selfPid: 10, run }),
		).toMatchObject({ kind: "not_running" });
	});

	it("proves nothing when launchd is reporting this very process", async () => {
		const run = vi.fn(async () => ({ stdout: RUNNING }));
		expect(
			await probeVoiceLaunchdOwner({ uid: 501, selfPid: 4242, run }),
		).toEqual({ kind: "unknown", reason: "launchctl_reports_self" });
	});

	it("proves nothing when the probe fails or the record is ambiguous", async () => {
		expect(
			await probeVoiceLaunchdOwner({
				uid: 501,
				selfPid: 10,
				run: vi.fn(async () => {
					throw new Error("Could not find service");
				}),
			}),
		).toEqual({ kind: "unknown", reason: "launchctl_print_failed" });
		expect(
			await probeVoiceLaunchdOwner({
				uid: 501,
				selfPid: 10,
				run: vi.fn(async () => ({
					stdout: `${RUNNING}\n\tpid = 99\n`,
				})),
			}),
		).toEqual({ kind: "unknown", reason: "launchctl_print_ambiguous" });
	});
});
