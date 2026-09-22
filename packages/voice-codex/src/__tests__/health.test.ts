import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	logVoiceHealthSuccess,
	type VoiceHealthCommandClient,
	VoiceHealthHelperClient,
	VoiceHealthReporter,
	VoiceHealthUnavailableError,
} from "../health.js";

const BOOT_ID = "11111111-1111-4111-8111-111111111111";

function resultReceipt(
	payload: Record<string, unknown>,
	status: "recorded" | "duplicate" | "no_action" = "recorded",
) {
	return {
		status,
		generation: payload.generation,
		producerEventSeq: payload.producerEventSeq,
	};
}

function spoolFilename(bootId: string): string {
	return `${createHash("sha256").update(bootId).digest("hex")}.json`;
}

function failedPollEvent(producerEventSeq = 1) {
	return {
		producerEventSeq,
		observation: {
			kind: "poll_failed",
			observedAt: "2026-09-18T10:00:01.000Z",
			reasonClass: "bridge_connect_failed",
			operation: "desired",
		},
	};
}

async function writeSpool(
	stateRoot: string,
	document: Record<string, unknown>,
	mode = 0o600,
): Promise<string> {
	const pending = join(stateRoot, "state", "voice-health", "pending");
	await mkdir(pending, { recursive: true, mode: 0o700 });
	await chmod(join(stateRoot, "state", "voice-health"), 0o700);
	await chmod(pending, 0o700);
	const path = join(pending, spoolFilename(String(document.bootId)));
	await writeFile(path, JSON.stringify(document), { mode });
	return path;
}

async function realReporterHarness() {
	const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-order-"));
	const helper = new VoiceHealthHelperClient({
		helperPath: resolve(process.cwd(), "../../scripts/lib/voice-health.py"),
		stateRoot,
	});
	const calls: Array<Record<string, unknown>> = [];
	const client: VoiceHealthCommandClient = {
		invoke: async (command, payload) => {
			const receipt = await helper.invoke(command, payload);
			if (command === "record-result") calls.push(structuredClone(payload));
			return receipt;
		},
	};
	let wallMs = Date.parse("2026-09-18T10:00:00.000Z");
	const reporter = new VoiceHealthReporter({
		client,
		bootId: BOOT_ID,
		stateRoot,
		now: () => new Date(wallMs),
		monotonicNow: () => wallMs,
	});
	await reporter.registerBoot();
	return {
		calls,
		helper,
		reporter,
		stateRoot,
		advance(ms: number) {
			wallMs += ms;
		},
	};
}

describe("VoiceHealthHelperClient", () => {
	it("uses async execFile with trusted argv, bounded stdin, and a 500ms deadline", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const execFile = vi.fn((file, args, options, callback) => {
			const child = {
				stdin: {
					once: vi.fn(),
					end(input: string) {
						calls.push({ file, args, options, input });
						queueMicrotask(() =>
							callback(null, '{"generation":7,"status":"registered"}', ""),
						);
					},
				},
			} as unknown as ChildProcess;
			return child;
		});
		const client = new VoiceHealthHelperClient({
			helperPath: "/trusted/flywheel/scripts/lib/voice-health.py",
			stateRoot: "/trusted/state",
			execFile,
		});

		await expect(
			client.invoke("register-boot", {
				bootId: BOOT_ID,
				bootAt: "2026-09-18T10:00:00.000Z",
			}),
		).resolves.toMatchObject({ generation: 7 });
		expect(calls).toEqual([
			{
				file: "python3",
				args: [
					"/trusted/flywheel/scripts/lib/voice-health.py",
					"--state-root",
					"/trusted/state",
					"register-boot",
				],
				options: expect.objectContaining({
					encoding: "utf8",
					maxBuffer: 65_536,
					shell: false,
					timeout: 500,
					windowsHide: true,
				}),
				input: JSON.stringify({
					bootId: BOOT_ID,
					bootAt: "2026-09-18T10:00:00.000Z",
				}),
			},
		]);
	});

	it("rejects oversized input and helper failures without exposing payload or stderr", async () => {
		const execFile = vi.fn();
		const client = new VoiceHealthHelperClient({
			helperPath: "/trusted/helper.py",
			stateRoot: "/trusted/state",
			execFile,
		});
		const secret = "super-secret-token";

		await expect(
			client.invoke("record-result", { text: "x".repeat(32 * 1024) }),
		).rejects.toEqual(
			expect.objectContaining({
				name: "VoiceHealthUnavailableError",
				message: "health_observation_unavailable",
			}),
		);
		expect(execFile).not.toHaveBeenCalled();

		const failingExec = vi.fn((_file, _args, _options, callback) => {
			queueMicrotask(() =>
				callback(new Error(`helper failed ${secret}`), "", `stderr ${secret}`),
			);
			return {
				stdin: { once: vi.fn(), end: vi.fn() },
			} as unknown as ChildProcess;
		});
		const failing = new VoiceHealthHelperClient({
			helperPath: "/trusted/helper.py",
			stateRoot: "/trusted/state",
			execFile: failingExec,
		});
		const error = await failing
			.invoke("evaluate", { observedAt: "2026-09-18T10:00:00.000Z" })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(VoiceHealthUnavailableError);
		expect(String(error)).not.toContain(secret);
	});
});

describe("VoiceHealthReporter", () => {
	it("logs committed initial, recovered, and 60-second heartbeat idle successes", async () => {
		const stateRoot = await mkdtemp(
			join(tmpdir(), "voice-health-success-log-"),
		);
		let wallMs = Date.parse("2026-09-21T00:00:00.000Z");
		const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const reporter = new VoiceHealthReporter({
			client: new VoiceHealthHelperClient({
				helperPath: resolve(process.cwd(), "../../scripts/lib/voice-health.py"),
				stateRoot,
			}),
			bootId: BOOT_ID,
			stateRoot,
			now: () => new Date(wallMs),
			monotonicNow: () => wallMs,
			onSuccessLog: logVoiceHealthSuccess,
		});
		const observe = async (
			observation:
				| {
						kind: "idle_success";
						observedAt: string;
						durationMs: number;
				  }
				| {
						kind: "poll_failed";
						observedAt: string;
						durationMs: number;
						reasonClass: "bridge_timeout_headers";
						operation: "desired";
				  },
		) => {
			reporter.observe(observation);
			await reporter.whenSettled();
		};

		try {
			await reporter.registerBoot();
			await observe({
				kind: "idle_success",
				observedAt: new Date(wallMs).toISOString(),
				durationMs: 7,
			});

			wallMs += 5_000;
			await observe({
				kind: "poll_failed",
				observedAt: new Date(wallMs).toISOString(),
				durationMs: 2_001,
				reasonClass: "bridge_timeout_headers",
				operation: "desired",
			});

			wallMs += 5_000;
			await observe({
				kind: "idle_success",
				observedAt: new Date(wallMs).toISOString(),
				durationMs: 8,
			});

			wallMs += 20_000;
			await observe({
				kind: "idle_success",
				observedAt: new Date(wallMs).toISOString(),
				durationMs: 9,
			});

			wallMs += 40_000;
			await observe({
				kind: "idle_success",
				observedAt: new Date(wallMs).toISOString(),
				durationMs: 10,
			});

			const lines = output.mock.calls.map(([line]) => String(line));
			expect(lines).toHaveLength(3);
			expect(lines[0]).toMatch(
				/^\[voice\] daemon iteration succeeded event=initial_idle_success /,
			);
			expect(lines[1]).toMatch(
				/^\[voice\] daemon iteration succeeded event=recovered /,
			);
			expect(lines[2]).toMatch(
				/^\[voice\] daemon iteration succeeded event=heartbeat /,
			);
			expect(lines[0]).toContain(`bootId=${BOOT_ID}`);
			expect(lines[0]).toContain(
				"lastIterationSuccessAt=2026-09-21T00:00:00.000Z",
			);
			expect(lines[0]).toContain("successCount=1");
			expect(lines[1]).toContain(
				"lastIterationSuccessAt=2026-09-21T00:00:10.000Z",
			);
			expect(lines[1]).toContain("successCount=2");
			expect(lines[1]).toContain("failureCount=1");
			expect(lines[2]).toContain(
				"lastIterationSuccessAt=2026-09-21T00:01:10.000Z",
			);
			expect(lines[2]).toContain("successCount=4");
			for (const line of lines) {
				expect(line).toMatch(/ observationSeq=\d+ /);
				expect(line).toContain(" mode=idle ");
				expect(line).toContain(" failureStreak=0 ");
				expect(line.length).toBeLessThan(512);
			}
		} finally {
			reporter.stop();
			output.mockRestore();
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it("hands a newly opened notification intent to the nonblocking alert seam", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-notify-"));
		try {
			const notification = vi.fn();
			const reporter = new VoiceHealthReporter({
				client: {
					invoke: vi.fn(async (command, payload) => {
						if (command === "register-boot") return { generation: 1 };
						if (command === "record-result")
							return {
								status: "recorded",
								generation: 1,
								producerEventSeq: payload.producerEventSeq,
								notification: {
									intentId: "a".repeat(64),
									state: "pending",
								},
							};
						return {};
					}),
				},
				bootId: BOOT_ID,
				stateRoot,
				onNotification: notification,
			});
			await reporter.registerBoot();
			reporter.observe({
				kind: "poll_failed",
				observedAt: "2026-09-18T10:00:01.000Z",
				reasonClass: "bridge_connect_failed",
				operation: "desired",
			});
			await reporter.whenSettled();
			expect(notification).toHaveBeenCalledWith("a".repeat(64));
			reporter.stop();
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it("retains and retries a failed event with the same producerEventSeq", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-retry-"));
		const calls: Array<{ command: string; payload: Record<string, unknown> }> =
			[];
		let active = 0;
		let maxActive = 0;
		let failFirstResult = true;
		const client: VoiceHealthCommandClient = {
			invoke: vi.fn(async (command, payload) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				calls.push({ command, payload: structuredClone(payload) });
				await Promise.resolve();
				active -= 1;
				if (command === "register-boot")
					return { status: "registered", generation: 4 };
				if (command === "record-result" && failFirstResult) {
					failFirstResult = false;
					throw new VoiceHealthUnavailableError();
				}
				return resultReceipt(payload);
			}),
		};
		const unavailable = vi.fn();
		const reporter = new VoiceHealthReporter({
			client,
			bootId: BOOT_ID,
			stateRoot,
			now: () => new Date("2026-09-18T10:00:00.000Z"),
			monotonicNow: () => 0,
			onUnavailable: unavailable,
		});

		await reporter.registerBoot();
		reporter.observe({
			kind: "poll_failed",
			observedAt: "2026-09-18T10:00:01.000Z",
			durationMs: 2_000,
			reasonClass: "bridge_timeout_headers",
			operation: "desired",
		});
		await reporter.whenSettled();
		reporter.observe({
			kind: "poll_failed",
			observedAt: "2026-09-18T10:00:02.000Z",
			durationMs: 2_000,
			reasonClass: "bridge_timeout_headers",
			operation: "desired",
		});
		await reporter.whenSettled();

		const results = calls.filter(({ command }) => command === "record-result");
		expect(results).toHaveLength(3);
		expect(results[0]?.payload).toEqual(results[1]?.payload);
		expect(results.map(({ payload }) => payload.producerEventSeq)).toEqual([
			1, 1, 2,
		]);
		expect(maxActive).toBe(1);
		expect(unavailable).toHaveBeenCalledWith({
			reasonClass: "health_observation_unavailable",
			operation: "health_store",
		});
		reporter.stop();
		await reporter.whenSettled();
		await rm(stateRoot, { recursive: true, force: true });
	});

	it("aggregates normal observations, evaluates every minute, and checkpoints every five minutes", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-09-18T10:00:00.000Z"));
			const calls: Array<{
				command: string;
				payload: Record<string, unknown>;
			}> = [];
			const client: VoiceHealthCommandClient = {
				invoke: vi.fn(async (command, payload) => {
					calls.push({ command, payload: structuredClone(payload) });
					return command === "register-boot"
						? { generation: 1 }
						: resultReceipt(payload);
				}),
			};
			const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-timers-"));
			const reporter = new VoiceHealthReporter({
				client,
				bootId: BOOT_ID,
				stateRoot,
				now: () => new Date(),
				monotonicNow: () => Date.now(),
			});
			await reporter.registerBoot();

			reporter.observe({
				kind: "progress",
				observedAt: new Date().toISOString(),
			});
			await reporter.whenSettled();
			await vi.advanceTimersByTimeAsync(5_000);
			reporter.observe({
				kind: "progress",
				observedAt: new Date().toISOString(),
			});
			await vi.advanceTimersByTimeAsync(5_000);
			reporter.observe({
				kind: "progress",
				observedAt: new Date().toISOString(),
			});

			await vi.advanceTimersByTimeAsync(10_000);
			await reporter.whenSettled();
			const progress = calls.filter(
				({ command, payload }) =>
					command === "record-result" && payload.resultKind === "progress",
			);
			expect(progress.map(({ payload }) => payload.countDelta)).toEqual([1, 2]);

			await vi.advanceTimersByTimeAsync(40_000);
			await reporter.whenSettled();
			expect(
				calls.filter(({ command }) => command === "evaluate"),
			).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(240_000);
			await reporter.whenSettled();
			expect(
				calls.filter(({ command }) => command === "evaluate"),
			).toHaveLength(5);
			expect(
				calls.filter(({ command }) => command === "maintenance"),
			).toHaveLength(1);
			reporter.stop();
			await rm(stateRoot, { recursive: true, force: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it("flushes pending progress before a later poll failure", async () => {
		const harness = await realReporterHarness();
		try {
			harness.reporter.observe({
				kind: "progress",
				observedAt: "2026-09-18T10:00:00.000Z",
			});
			await harness.reporter.whenSettled();
			harness.advance(5_000);
			harness.reporter.observe({
				kind: "progress",
				observedAt: "2026-09-18T10:00:05.000Z",
			});
			harness.advance(5_000);
			harness.reporter.observe({
				kind: "progress",
				observedAt: "2026-09-18T10:00:10.000Z",
			});
			harness.advance(1_000);
			harness.reporter.observe({
				kind: "poll_failed",
				observedAt: "2026-09-18T10:00:11.000Z",
				reasonClass: "bridge_http_error",
				operation: "desired",
			});
			harness.reporter.stop();
			await harness.reporter.whenSettled();

			expect(
				harness.calls.map(({ resultKind, countDelta }) => ({
					resultKind,
					...(countDelta === undefined ? {} : { countDelta }),
				})),
			).toEqual([
				{ resultKind: "progress", countDelta: 1 },
				{ resultKind: "progress", countDelta: 2 },
				{ resultKind: "poll_failed" },
			]);
			const exported = await harness.helper.invoke("export", {});
			expect(exported.currentProjection).toEqual(
				expect.objectContaining({ phase: "failed_retrying" }),
			);
		} finally {
			await rm(harness.stateRoot, { recursive: true, force: true });
		}
	});

	it("flushes pending progress before a later idle success", async () => {
		const harness = await realReporterHarness();
		try {
			harness.reporter.observe({
				kind: "progress",
				observedAt: "2026-09-18T10:00:00.000Z",
			});
			await harness.reporter.whenSettled();
			harness.advance(5_000);
			harness.reporter.observe({
				kind: "progress",
				observedAt: "2026-09-18T10:00:05.000Z",
			});
			harness.advance(1_000);
			harness.reporter.observe({
				kind: "idle_success",
				observedAt: "2026-09-18T10:00:06.000Z",
			});
			harness.reporter.stop();
			await harness.reporter.whenSettled();

			expect(harness.calls.map(({ resultKind }) => resultKind)).toEqual([
				"progress",
				"progress",
				"idle_success",
			]);
			const exported = await harness.helper.invoke("export", {});
			expect(exported.currentProjection).toEqual(
				expect.objectContaining({ phase: "idle" }),
			);
		} finally {
			await rm(harness.stateRoot, { recursive: true, force: true });
		}
	});

	it("replays a failed-helper shutdown spool before registering the next boot", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-restart-"));
		const nextBoot = "22222222-2222-4222-8222-222222222222";
		try {
			const firstClient: VoiceHealthCommandClient = {
				invoke: vi.fn(async (command) => {
					if (command === "register-boot") return { generation: 4 };
					throw new VoiceHealthUnavailableError();
				}),
			};
			const first = new VoiceHealthReporter({
				client: firstClient,
				bootId: BOOT_ID,
				stateRoot,
				now: () => new Date("2026-09-18T10:00:00.000Z"),
			});
			await first.registerBoot();
			first.observe({
				kind: "session_failed",
				observedAt: "2026-09-18T10:00:01.000Z",
				reasonClass: "session_create_failed",
				operation: "session_create",
				demandId: "meeting-1",
				attemptId: "attempt-1",
			});
			await first.whenSettled();
			first.stop();
			await first.whenSettled();

			const pendingDir = join(stateRoot, "state", "voice-health", "pending");
			expect(await readdir(pendingDir)).toHaveLength(1);
			const calls: Array<{
				command: string;
				payload: Record<string, unknown>;
			}> = [];
			const secondClient: VoiceHealthCommandClient = {
				invoke: vi.fn(async (command, payload) => {
					calls.push({ command, payload: structuredClone(payload) });
					if (command === "register-boot") return { generation: 5 };
					return resultReceipt(payload);
				}),
			};
			const second = new VoiceHealthReporter({
				client: secondClient,
				bootId: nextBoot,
				stateRoot,
				now: () => new Date("2026-09-18T10:05:00.000Z"),
			});
			await expect(second.registerBoot()).resolves.toBe(true);
			expect(calls.map(({ command }) => command)).toEqual([
				"record-result",
				"register-boot",
			]);
			expect(calls[0]?.payload).toMatchObject({
				generation: 4,
				producerEventSeq: 1,
				resultKind: "session_failed",
			});
			expect(await readdir(pendingDir)).toEqual([]);
			second.stop();
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it("registers an interrupted old boot before replay when its generation was not persisted", async () => {
		const stateRoot = await mkdtemp(
			join(tmpdir(), "voice-health-no-generation-"),
		);
		const nextBoot = "33333333-3333-4333-8333-333333333333";
		try {
			const first = new VoiceHealthReporter({
				client: {
					invoke: vi.fn(async () => {
						throw new VoiceHealthUnavailableError();
					}),
				},
				bootId: BOOT_ID,
				stateRoot,
				now: () => new Date("2026-09-18T10:00:00.000Z"),
			});
			await expect(first.registerBoot()).resolves.toBe(false);
			first.observe({
				kind: "poll_failed",
				observedAt: "2026-09-18T10:00:01.000Z",
				reasonClass: "bridge_connect_failed",
				operation: "desired",
			});
			await first.whenSettled();
			first.stop();

			const calls: Array<{ command: string; bootId?: unknown }> = [];
			let generation = 7;
			const second = new VoiceHealthReporter({
				client: {
					invoke: vi.fn(async (command, payload) => {
						calls.push({ command, bootId: payload.bootId });
						if (command === "register-boot")
							return { generation: generation++ };
						return resultReceipt(payload);
					}),
				},
				bootId: nextBoot,
				stateRoot,
				now: () => new Date("2026-09-18T10:05:00.000Z"),
			});
			await expect(second.registerBoot()).resolves.toBe(true);
			expect(calls).toEqual([
				{ command: "register-boot", bootId: BOOT_ID },
				{ command: "record-result", bootId: undefined },
				{ command: "register-boot", bootId: nextBoot },
			]);
			second.stop();
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it("durably isolates exceptional overflow for two boots when the bounded queue saturates", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-isolation-"));
		const bootIds = [BOOT_ID, "44444444-4444-4444-8444-444444444444"];
		try {
			const unavailable = vi.fn();
			for (const [index, bootId] of bootIds.entries()) {
				const reporter = new VoiceHealthReporter({
					client: {
						invoke: vi.fn(async (command) => {
							if (command === "register-boot") return { generation: index + 1 };
							throw new VoiceHealthUnavailableError();
						}),
					},
					bootId,
					stateRoot,
					maxQueue: 1,
					onUnavailable: unavailable,
					now: () => new Date("2026-09-18T10:00:00.000Z"),
				});
				await reporter.registerBoot();
				for (let event = 1; event <= 2; event += 1)
					reporter.observe({
						kind: "poll_failed",
						observedAt: `2026-09-18T10:00:0${event}.000Z`,
						reasonClass: "bridge_connect_failed",
						operation: "desired",
					});
				await reporter.whenSettled();
				reporter.stop();
				await reporter.whenSettled();
			}

			const pendingDir = join(stateRoot, "state", "voice-health", "pending");
			const files = await readdir(pendingDir);
			expect(files).toHaveLength(2);
			const documents = await Promise.all(
				files.map(async (file) =>
					JSON.parse(await readFile(join(pendingDir, file), "utf8")),
				),
			);
			expect(documents.map(({ bootId }) => bootId).sort()).toEqual(
				[...bootIds].sort(),
			);
			expect(documents.map(({ events }) => events.length)).toEqual([2, 2]);
			expect(unavailable).toHaveBeenCalled();
			const evidenceDir = join(
				stateRoot,
				"state",
				"voice-health",
				"unavailable",
			);
			const evidenceFiles = await readdir(evidenceDir);
			expect(evidenceFiles).toHaveLength(2);
			for (const file of evidenceFiles)
				expect(
					JSON.parse(await readFile(join(evidenceDir, file), "utf8")),
				).toMatchObject({
					reasonClass: "health_observation_unavailable",
					operation: "health_store",
				});
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it.each([
		["pending symlink", "symlink"],
		["pending unsafe mode", "mode"],
	] as const)(
		"fails closed on an unsafe %s without following it",
		async (_label, unsafeKind) => {
			const stateRoot = await mkdtemp(
				join(tmpdir(), "voice-health-unsafe-dir-"),
			);
			const outside = await mkdtemp(join(tmpdir(), "voice-health-outside-"));
			try {
				const healthRoot = join(stateRoot, "state", "voice-health");
				await mkdir(healthRoot, { recursive: true, mode: 0o700 });
				await chmod(join(stateRoot, "state"), 0o700);
				await chmod(healthRoot, 0o700);
				const pending = join(healthRoot, "pending");
				if (unsafeKind === "symlink") await symlink(outside, pending);
				else await mkdir(pending, { mode: 0o755 });

				const client = { invoke: vi.fn(async () => ({ generation: 1 })) };
				const unavailable = vi.fn();
				const reporter = new VoiceHealthReporter({
					client,
					bootId: BOOT_ID,
					stateRoot,
					onUnavailable: unavailable,
				});
				await expect(reporter.registerBoot()).resolves.toBe(false);
				reporter.observe({
					kind: "poll_failed",
					observedAt: "2026-09-18T10:00:01.000Z",
					reasonClass: "bridge_connect_failed",
					operation: "desired",
				});
				await reporter.whenSettled();

				expect(client.invoke).not.toHaveBeenCalled();
				expect(await readdir(outside)).toEqual([]);
				expect(unavailable).toHaveBeenCalled();
				const evidence = await readdir(join(healthRoot, "unavailable"));
				expect(evidence).toHaveLength(1);
				reporter.stop();
			} finally {
				await rm(stateRoot, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			}
		},
	);

	it("fails closed without repairing an unsafe voice-health directory", async () => {
		const stateRoot = await mkdtemp(
			join(tmpdir(), "voice-health-unsafe-root-"),
		);
		try {
			const healthRoot = join(stateRoot, "state", "voice-health");
			await mkdir(healthRoot, { recursive: true, mode: 0o700 });
			await chmod(join(stateRoot, "state"), 0o700);
			await chmod(healthRoot, 0o755);
			const client = { invoke: vi.fn(async () => ({ generation: 1 })) };
			const unavailable = vi.fn();
			const reporter = new VoiceHealthReporter({
				client,
				bootId: BOOT_ID,
				stateRoot,
				onUnavailable: unavailable,
			});

			await expect(reporter.registerBoot()).resolves.toBe(false);
			expect(client.invoke).not.toHaveBeenCalled();
			expect(unavailable).toHaveBeenCalled();
			expect((await stat(healthRoot)).mode & 0o777).toBe(0o755);
			reporter.stop();
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it.each([
		["0644 regular file", "mode"],
		["symlink file", "symlink"],
	] as const)(
		"retains and rejects an unsafe %s",
		async (_label, unsafeKind) => {
			const stateRoot = await mkdtemp(
				join(tmpdir(), "voice-health-unsafe-file-"),
			);
			const outside = await mkdtemp(
				join(tmpdir(), "voice-health-file-outside-"),
			);
			try {
				const oldBoot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
				const document = {
					schemaVersion: 1,
					bootId: oldBoot,
					bootAt: "2026-09-18T09:00:00.000Z",
					generation: 4,
					events: [failedPollEvent()],
				};
				const pending = join(stateRoot, "state", "voice-health", "pending");
				await mkdir(pending, { recursive: true, mode: 0o700 });
				await chmod(join(stateRoot, "state", "voice-health"), 0o700);
				await chmod(pending, 0o700);
				const path = join(pending, spoolFilename(oldBoot));
				if (unsafeKind === "mode")
					await writeFile(path, JSON.stringify(document), { mode: 0o644 });
				else {
					const outsideFile = join(outside, "spool.json");
					await writeFile(outsideFile, JSON.stringify(document), {
						mode: 0o600,
					});
					await symlink(outsideFile, path);
				}

				const client = { invoke: vi.fn(async () => ({ generation: 1 })) };
				const unavailable = vi.fn();
				const reporter = new VoiceHealthReporter({
					client,
					bootId: BOOT_ID,
					stateRoot,
					onUnavailable: unavailable,
				});
				await expect(reporter.registerBoot()).resolves.toBe(false);
				expect(client.invoke).not.toHaveBeenCalled();
				expect(await readdir(pending)).toEqual([spoolFilename(oldBoot)]);
				expect(unavailable).toHaveBeenCalled();
				expect(
					await readdir(
						join(stateRoot, "state", "voice-health", "unavailable"),
					),
				).toHaveLength(1);
				reporter.stop();
			} finally {
				await rm(stateRoot, { recursive: true, force: true });
				await rm(outside, { recursive: true, force: true });
			}
		},
	);

	it("replays old boots sequentially by bootAt before registering the current boot", async () => {
		const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-sequential-"));
		const bootA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const bootB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const currentBoot = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		try {
			expect(spoolFilename(bootA) > spoolFilename(bootB)).toBe(true);
			await writeSpool(stateRoot, {
				schemaVersion: 1,
				bootId: bootA,
				bootAt: "2026-09-18T09:00:00.000Z",
				events: [failedPollEvent()],
			});
			await writeSpool(stateRoot, {
				schemaVersion: 1,
				bootId: bootB,
				bootAt: "2026-09-18T09:01:00.000Z",
				events: [failedPollEvent()],
			});

			const calls: string[] = [];
			let nextGeneration = 10;
			const reporter = new VoiceHealthReporter({
				client: {
					invoke: vi.fn(async (command, payload) => {
						if (command === "register-boot") {
							calls.push(`register:${String(payload.bootId)}`);
							return { generation: nextGeneration++ };
						}
						if (command === "record-result") {
							calls.push(`event:${String(payload.generation)}`);
							return resultReceipt(payload);
						}
						return {};
					}),
				},
				bootId: currentBoot,
				stateRoot,
				now: () => new Date("2026-09-18T10:00:00.000Z"),
			});
			await expect(reporter.registerBoot()).resolves.toBe(true);
			expect(calls).toEqual([
				`register:${bootA}`,
				"event:10",
				`register:${bootB}`,
				"event:11",
				`register:${currentBoot}`,
			]);
			expect(
				await readdir(join(stateRoot, "state", "voice-health", "pending")),
			).toEqual([]);
			reporter.stop();
		} finally {
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it.each([
		["stale", { status: "stale", generation: 5 }],
		["malformed", { status: "recorded", generation: 4 }],
	] as const)(
		"retains an old event on a %s helper receipt",
		async (_label, receipt) => {
			const stateRoot = await mkdtemp(join(tmpdir(), "voice-health-receipt-"));
			const oldBoot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
			try {
				await writeSpool(stateRoot, {
					schemaVersion: 1,
					bootId: oldBoot,
					bootAt: "2026-09-18T09:00:00.000Z",
					generation: 4,
					events: [failedPollEvent()],
				});
				const calls: string[] = [];
				const unavailable = vi.fn();
				const reporter = new VoiceHealthReporter({
					client: {
						invoke: vi.fn(async (command, payload) => {
							calls.push(command);
							if (command === "record-result") return receipt;
							return { generation: 9, bootId: payload.bootId };
						}),
					},
					bootId: BOOT_ID,
					stateRoot,
					onUnavailable: unavailable,
				});
				await expect(reporter.registerBoot()).resolves.toBe(false);
				expect(calls).toEqual(["record-result"]);
				expect(
					await readdir(join(stateRoot, "state", "voice-health", "pending")),
				).toEqual([spoolFilename(oldBoot)]);
				expect(unavailable).toHaveBeenCalled();
				reporter.stop();
			} finally {
				await rm(stateRoot, { recursive: true, force: true });
			}
		},
	);
});
