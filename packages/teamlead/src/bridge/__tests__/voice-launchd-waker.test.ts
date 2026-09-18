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
		expect(waker.requestWake()).toBe("accepted");
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

		expect(waker.requestWake()).toBe("accepted");
		expect(waker.requestWake()).toBe("coalesced");
		expect(wake).toHaveBeenCalledTimes(1);
		first.resolve();
		await first.promise;
		await Promise.resolve();

		now = 2_999;
		expect(waker.requestWake()).toBe("coalesced");
		now = 3_000;
		expect(waker.requestWake()).toBe("accepted");
		expect(wake).toHaveBeenCalledTimes(2);
	});

	it("keeps a failed command out of the caller and allows the next bounded retry", async () => {
		let now = 0;
		const wake = vi
			.fn()
			.mockRejectedValue(new Error("private launchctl output"));
		const log = vi.fn();
		const waker = new VoiceLaunchdWaker({ wake, now: () => now, log });

		expect(waker.requestWake()).toBe("accepted");
		await vi.waitFor(() => expect(log).toHaveBeenCalledOnce());
		expect(log).toHaveBeenCalledWith("voice launchd wake failed");
		now = 3_000;
		expect(waker.requestWake()).toBe("accepted");
	});
});
