import { describe, expect, it, vi } from "vitest";
import {
	kickstartVoiceOnDemand,
	VoiceLaunchdWaker,
	verifyVoiceOnDemandContract,
} from "../voice-launchd-waker.js";

function pending() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("voice launchd waker", () => {
	it("uses bounded non-destructive kickstart for the fixed voice label", async () => {
		const run = vi.fn(async () => ({ stdout: "", stderr: "" }));

		await kickstartVoiceOnDemand({ uid: 501, run });

		expect(run).toHaveBeenCalledWith(
			"/bin/launchctl",
			["kickstart", "gui/501/com.flywheel.voice"],
			{ timeout: 2_000, maxBuffer: 16 * 1024 },
		);
		expect(run.mock.calls[0]?.[1]).not.toContain("-k");
	});

	it("runs the fixed shared contract checker before launchctl", async () => {
		const calls: string[] = [];
		const run = vi.fn(async (file: string) => {
			calls.push(file);
			return { stdout: "", stderr: "" };
		});
		await verifyVoiceOnDemandContract({
			repoRoot: "/repo",
			homeDir: "/home/tester",
			uid: 501,
			run,
		});
		const waker = new VoiceLaunchdWaker({
			verify: async () => {
				calls.push("verify");
			},
			wake: async () => {
				calls.push("wake");
			},
		});
		await expect(waker.requestWake()).resolves.toBe("accepted");
		await vi.waitFor(() => expect(calls).toContain("wake"));

		expect(run).toHaveBeenCalledWith(
			"/bin/bash",
			[
				"/repo/scripts/lib/voice-on-demand.sh",
				"/repo",
				"/home/tester",
				"gui/501",
			],
			{ timeout: 2_000, maxBuffer: 16 * 1024 },
		);
		expect(calls.slice(-2)).toEqual(["verify", "wake"]);
	});

	it("coalesces an in-flight wake and enforces one accepted attempt per 3 seconds", async () => {
		let now = 0;
		const first = pending();
		const wake = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue(undefined);
		const waker = new VoiceLaunchdWaker({ wake, now: () => now });

		const inFlight = waker.requestWake();
		await expect(waker.requestWake()).resolves.toBe("coalesced");
		expect(wake).toHaveBeenCalledTimes(1);
		first.resolve();
		await expect(inFlight).resolves.toBe("accepted");

		now = 2_999;
		await expect(waker.requestWake()).resolves.toBe("coalesced");
		now = 3_000;
		await expect(waker.requestWake()).resolves.toBe("accepted");
		expect(wake).toHaveBeenCalledTimes(2);
	});

	it("keeps a failed command out of the caller and allows the next bounded retry", async () => {
		let now = 0;
		const wake = vi
			.fn()
			.mockRejectedValue(new Error("private launchctl output"));
		const log = vi.fn();
		const waker = new VoiceLaunchdWaker({ wake, now: () => now, log });

		// The reason text never reaches the caller, but the outcome does — the
		// launch budget cannot count a failed command as an accepted one.
		await expect(waker.requestWake()).resolves.toBe("failed");
		expect(log).toHaveBeenCalledWith("voice launchd wake failed");
		now = 3_000;
		await expect(waker.requestWake()).resolves.toBe("failed");
	});

	it("does not call a probe timeout a configuration fault", async () => {
		const wake = vi.fn(async () => {});
		const timeout = Object.assign(new Error("timeout"), {
			killed: true,
			signal: "SIGTERM",
		});
		const waker = new VoiceLaunchdWaker({
			wake,
			verify: async () => {
				throw timeout;
			},
			now: () => 0,
		});

		// A slow host proves nothing about the installed contract; calling it a
		// permanent fault would end the demand on a single slow probe.
		await expect(waker.requestWake()).resolves.toBe("unknown");
		expect(wake).not.toHaveBeenCalled();
	});

	it("does not spend the launch budget on a kickstart killed by its own timeout", async () => {
		// `kickstartVoiceOnDemand` runs launchctl under a 2s execFile timeout. A
		// host slow enough to hit it says nothing about whether the unit started,
		// so it must not be a proven failure — three of them would otherwise
		// exhaust a demand's budget on a busy machine alone.
		const timeout = Object.assign(new Error("timeout"), {
			killed: true,
			signal: "SIGTERM",
		});
		const log = vi.fn();
		const waker = new VoiceLaunchdWaker({
			wake: async () => {
				throw timeout;
			},
			now: () => 0,
			log,
		});

		await expect(waker.requestWake()).resolves.toBe("unknown");
		expect(log).toHaveBeenCalledWith("voice launchd wake timed out");
	});

	it("separates a configuration fault from a flaky command", async () => {
		const wake = vi.fn(async () => {});
		const log = vi.fn();
		const waker = new VoiceLaunchdWaker({
			wake,
			verify: async () => {
				throw new Error("unit disabled");
			},
			now: () => 0,
			log,
		});

		await expect(waker.requestWake()).resolves.toBe("unavailable");
		expect(wake).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith("voice launchd contract unavailable");
	});
});
