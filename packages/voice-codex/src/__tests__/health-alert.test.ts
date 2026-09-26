import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { VoiceHealthAlertDispatcher } from "../health-alert.js";

const INTENT_A = "a".repeat(64);
const INTENT_B = "b".repeat(64);

describe("VoiceHealthAlertDispatcher", () => {
	it("runs the trusted voice intent sender without shell interpolation", async () => {
		const calls: Array<{
			file: string;
			args: string[];
			options: Record<string, unknown>;
		}> = [];
		const execFile = vi.fn((file, args, options, callback) => {
			calls.push({ file, args, options });
			queueMicrotask(() =>
				callback(
					null,
					`sent channel_id=100000000000000001 binding_digest=${"c".repeat(64)} message_id=300000000000000001\n`,
					"",
				),
			);
			return {} as ChildProcess;
		});
		const unavailable = vi.fn();
		const dispatcher = new VoiceHealthAlertDispatcher({
			leadAlertPath: "/trusted/flywheel/scripts/lead-alert.sh",
			execFile,
			onUnavailable: unavailable,
		});

		dispatcher.notify(INTENT_A);
		await dispatcher.whenSettled();

		expect(calls).toEqual([
			{
				file: "/bin/bash",
				args: [
					"/trusted/flywheel/scripts/lead-alert.sh",
					"--project",
					"flywheel",
					"--lead",
					"voice-health",
					"--kind",
					"voice_daemon_unhealthy",
					"--severity",
					"warning",
					"--voice-intent",
					INTENT_A,
					"--strict-delivery",
				],
				options: {
					detached: true,
					encoding: "utf8",
					maxBuffer: 4096,
					shell: false,
					timeout: 30_000,
					windowsHide: true,
				},
			},
		]);
		expect(unavailable).not.toHaveBeenCalled();
	});

	it("serializes distinct intents, coalesces duplicates, and sanitizes failures", async () => {
		const callbacks: Array<
			(error: Error | null, stdout: string, stderr: string) => void
		> = [];
		const execFile = vi.fn((_file, _args, _options, callback) => {
			callbacks.push(callback);
			return {} as ChildProcess;
		});
		const unavailable = vi.fn();
		const dispatcher = new VoiceHealthAlertDispatcher({
			leadAlertPath: "/trusted/flywheel/scripts/lead-alert.sh",
			execFile,
			onUnavailable: unavailable,
		});

		dispatcher.notify(INTENT_A);
		dispatcher.notify(INTENT_A);
		dispatcher.notify(INTENT_B);
		dispatcher.notify("token=/private/secret");
		expect(execFile).toHaveBeenCalledTimes(1);
		callbacks.shift()?.(
			new Error("token=/private/secret"),
			"",
			"token=/private/secret",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(execFile).toHaveBeenCalledTimes(2);
		callbacks.shift()?.(
			null,
			`duplicate channel_id=100000000000000001 binding_digest=${"d".repeat(64)}\n`,
			"",
		);
		await dispatcher.whenSettled();

		expect(unavailable).toHaveBeenCalledTimes(2);
		expect(unavailable).toHaveBeenCalledWith({
			reasonClass: "health_observation_unavailable",
			operation: "health_store",
		});
		expect(JSON.stringify(unavailable.mock.calls)).not.toContain(
			"token=/private/secret",
		);
	});

	it("retries a source-owned transient receipt without using the generic queue", async () => {
		let attempt = 0;
		const execFile = vi.fn((_file, _args, _options, callback) => {
			attempt += 1;
			const status = attempt === 1 ? "queued_transient" : "sent";
			const message = status === "sent" ? " message_id=300000000000000001" : "";
			queueMicrotask(() =>
				callback(
					attempt === 1 ? new Error("exit 2") : null,
					`${status} channel_id=100000000000000001 binding_digest=${"e".repeat(64)}${message}\n`,
					"",
				),
			);
			return {} as ChildProcess;
		});
		const dispatcher = new VoiceHealthAlertDispatcher({
			leadAlertPath: "/trusted/flywheel/scripts/lead-alert.sh",
			execFile,
			retryDelayMs: 0,
		});

		dispatcher.notify(INTENT_A);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await dispatcher.whenSettled();

		expect(execFile).toHaveBeenCalledTimes(2);
	});
});

describe("VoiceHealthAlertDispatcher shutdown (FLY-2885 QA@1 review)", () => {
	const sent = `sent channel_id=100000000000000001 binding_digest=${"c".repeat(64)} message_id=300000000000000001\n`;

	it("lets an in-flight alert finish before the daemon exits", async () => {
		vi.useFakeTimers();
		try {
			let deliver: (() => void) | undefined;
			const execFile = vi.fn((_file, _args, _options, callback) => {
				deliver = () => callback(null, sent, "");
				return { kill: vi.fn() } as unknown as ChildProcess;
			});
			const dispatcher = new VoiceHealthAlertDispatcher({
				leadAlertPath: "/trusted/lead-alert.sh",
				execFile,
			});
			dispatcher.notify(INTENT_A);
			const done = dispatcher.shutdown(8_000);
			await vi.advanceTimersByTimeAsync(3_000);
			deliver!();
			await expect(done).resolves.toBe(true);
			expect(execFile).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops a sender still running at the bound, as a whole process group", async () => {
		vi.useFakeTimers();
		try {
			const sender = Object.assign(new EventEmitter(), { pid: 4242 });
			const execFile = vi.fn(() => sender as unknown as ChildProcess);
			const killGroup = vi.fn((_pid: number, signal: NodeJS.Signals) => {
				// bash ignores the TERM (it is waiting on curl); KILL ends it.
				if (signal === "SIGKILL") queueMicrotask(() => sender.emit("close"));
			});
			const dispatcher = new VoiceHealthAlertDispatcher({
				leadAlertPath: "/trusted/lead-alert.sh",
				execFile,
				killGroup,
			});
			dispatcher.notify(INTENT_A);
			dispatcher.notify(INTENT_B);
			const done = dispatcher.shutdown(8_000);
			await vi.advanceTimersByTimeAsync(8_000);
			expect(killGroup).toHaveBeenCalledWith(4242, "SIGTERM");
			await vi.advanceTimersByTimeAsync(2_000);
			expect(killGroup).toHaveBeenLastCalledWith(4242, "SIGKILL");
			await expect(done).resolves.toBe(false);
			// The queued alert is not started after shutdown.
			expect(execFile).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("kills the sender group at once on a forced exit", () => {
		const sender = Object.assign(new EventEmitter(), { pid: 5151 });
		const killGroup = vi.fn();
		const dispatcher = new VoiceHealthAlertDispatcher({
			leadAlertPath: "/trusted/lead-alert.sh",
			execFile: () => sender as unknown as ChildProcess,
			killGroup,
		});
		dispatcher.notify(INTENT_A);
		dispatcher.killNow();
		expect(killGroup).toHaveBeenCalledWith(5151, "SIGKILL");
	});

	it("starts no retry and takes no new alert once shut down", async () => {
		vi.useFakeTimers();
		try {
			const execFile = vi.fn((_file, _args, _options, callback) => {
				queueMicrotask(() =>
					callback(
						null,
						`queued_transient channel_id=100000000000000001 binding_digest=${"c".repeat(64)}\n`,
						"",
					),
				);
				return { kill: vi.fn() } as unknown as ChildProcess;
			});
			const dispatcher = new VoiceHealthAlertDispatcher({
				leadAlertPath: "/trusted/lead-alert.sh",
				execFile,
				retryDelayMs: 1_000,
			});
			dispatcher.notify(INTENT_A);
			await expect(dispatcher.shutdown(8_000)).resolves.toBe(true);
			dispatcher.notify(INTENT_B);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(execFile).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
