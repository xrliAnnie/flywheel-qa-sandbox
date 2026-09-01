import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	classifyResidentCodexLead,
	createHostResidentCodexLeadPatrol,
	DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS,
	parseResidentCodexLeadProbe,
	ResidentCodexLeadPatrol,
	type ResidentCodexLeadSnapshot,
} from "../resident-codex-lead-patrol.js";

const NOW = Date.parse("2026-09-01T06:00:00.000Z");
const rayaTarget = {
	projectName: "raya",
	projectRoot: "/raya",
	leadId: "raya",
	leadKey: "raya-raya",
};
const exactIdentity = {
	state: "exact" as const,
	pid: 4242,
	lstart: "Tue Sep  1 05:00:00 2026",
	startedAtMs: NOW - 3_600_000,
	argv: [
		"node",
		"/repo/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js",
	],
	codexHome: "/home/.flywheel/raya/codex-home",
	label: "com.flywheel.lead.raya-raya",
	wrapper: "flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh",
};
const heartbeat = {
	v: 1 as const,
	generationId: "generation-a",
	threadId: "thread-a",
	processPid: 4242,
	carrierInstanceId: "carrier-a",
	state: "online" as const,
	lastGatewayPollAttemptAt: new Date(NOW - 10_000).toISOString(),
	lastGatewayPollResultAt: new Date(NOW - 9_000).toISOString(),
	lastGatewayPollStatus: "ok" as const,
	activeTurn: null,
	updatedAt: new Date(NOW - 9_000).toISOString(),
};
const observed = {
	pid: 4242,
	lstart: exactIdentity.lstart,
	generationId: "generation-a",
	carrierInstanceId: "carrier-a",
	observedAt: new Date(NOW - 30_000).toISOString(),
};

function snapshot(
	overrides: Partial<ResidentCodexLeadSnapshot> = {},
): ResidentCodexLeadSnapshot {
	return {
		nowMs: NOW,
		identity: exactIdentity,
		heartbeat: { state: "valid", value: heartbeat },
		observed,
		controlledWave: null,
		...overrides,
	};
}

describe("FLY-2216 resident Codex Lead pure safety matrix", () => {
	it("ignores legacy offline-declaration data for healthy and stalled decisions", () => {
		const legacyHeartbeat = {
			...heartbeat,
			lastOfflineDeclarationAt: new Date(NOW - 20_000).toISOString(),
		};
		expect(
			classifyResidentCodexLead(
				snapshot({
					heartbeat: { state: "valid", value: legacyHeartbeat },
				}),
			).branch,
		).toBe("healthy");

		expect(
			classifyResidentCodexLead(
				snapshot({
					heartbeat: {
						state: "valid",
						value: {
							...legacyHeartbeat,
							lastGatewayPollAttemptAt: new Date(
								NOW -
									DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.pollAttemptStaleMs -
									1,
							).toISOString(),
						},
					},
				}),
			).branch,
		).toBe("poll_loop_stalled");
	});

	it("keeps normal idle and a bounded active turn healthy", () => {
		expect(classifyResidentCodexLead(snapshot()).branch).toBe("healthy");
		expect(
			classifyResidentCodexLead(
				snapshot({
					heartbeat: {
						state: "valid",
						value: {
							...heartbeat,
							activeTurn: {
								turnId: "turn-a",
								startedAt: new Date(NOW - 60_000).toISOString(),
							},
						},
					},
				}),
			),
		).toMatchObject({ branch: "healthy", candidate: false, recover: false });
	});

	it.each([
		[
			"uncertain_identity",
			snapshot({ identity: { state: "uncertain", reason: "plist drift" } }),
		],
		[
			"observer_missing",
			snapshot({ heartbeat: { state: "missing" }, observed: null }),
		],
		[
			"upstream_unavailable",
			snapshot({
				heartbeat: {
					state: "valid",
					value: {
						...heartbeat,
						lastGatewayPollStatus: "failed",
						lastGatewayPollFailureClass: "unknown",
					},
				},
			}),
		],
	] as const)(
		"keeps %s alert-only with zero recovery authority",
		(branch, input) => {
			expect(classifyResidentCodexLead(input)).toMatchObject({
				branch,
				alert: true,
				candidate: false,
				recover: false,
			});
		},
	);

	it("uses startup grace before reporting a missing observer", () => {
		const result = classifyResidentCodexLead(
			snapshot({
				identity: { ...exactIdentity, startedAtMs: NOW - 119_000 },
				heartbeat: { state: "missing" },
				observed: null,
			}),
		);
		expect(result).toMatchObject({
			branch: "starting",
			alert: false,
			candidate: false,
		});
	});

	it.each([
		[
			"turn_stalled",
			snapshot({
				heartbeat: {
					state: "valid",
					value: {
						...heartbeat,
						activeTurn: {
							turnId: "turn-stale",
							startedAt: new Date(
								NOW - DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.turnStaleMs - 1,
							).toISOString(),
						},
					},
				},
			}),
		],
		[
			"poll_loop_stalled",
			snapshot({
				heartbeat: {
					state: "valid",
					value: {
						...heartbeat,
						lastGatewayPollAttemptAt: new Date(
							NOW -
								DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.pollAttemptStaleMs -
								1,
						).toISOString(),
					},
				},
			}),
		],
		["heartbeat_stalled", snapshot({ heartbeat: { state: "malformed" } })],
	] as const)(
		"makes %s a recovery candidate but not immediate authority",
		(branch, input) => {
			expect(classifyResidentCodexLead(input)).toMatchObject({
				branch,
				alert: true,
				candidate: true,
				recover: false,
			});
		},
	);

	it("suppresses only an exact controlled-wave tuple", () => {
		const stale = snapshot({ heartbeat: { state: "malformed" } });
		expect(
			classifyResidentCodexLead({
				...stale,
				controlledWave: {
					pid: exactIdentity.pid,
					lstart: exactIdentity.lstart,
					phase: "bootstrap",
				},
			}).branch,
		).toBe("suppressed_controlled_wave");
		expect(
			classifyResidentCodexLead({
				...stale,
				controlledWave: {
					pid: 9999,
					lstart: exactIdentity.lstart,
					phase: "bootstrap",
				},
			}).branch,
		).toBe("heartbeat_stalled");
	});
});

describe("FLY-2216 resident Codex Lead host adapter", () => {
	it("uses one target-parameterized adapter to detect and alert for two different Leads", async () => {
		const cases = [
			{
				target: {
					projectName: "raya",
					projectRoot: "/raya",
					leadId: "raya",
					leadKey: "raya-raya",
				},
				pid: 4242,
				wrapper: "flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh",
				codexHome: ".flywheel/raya/codex-home",
			},
			{
				target: {
					projectName: "growth",
					projectRoot: "/growth",
					leadId: "mufasa-lead",
					leadKey: "growth-mufasa-lead",
				},
				pid: 5252,
				wrapper: "flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh",
				codexHome: ".codex-mufasa",
			},
		] as const;

		for (const item of cases) {
			const homeDir = mkdtempSync(join(tmpdir(), "fly2216-generic-patrol-"));
			const brainDir = join(
				homeDir,
				".flywheel/state/codex-lead",
				item.target.leadId,
				"brain",
			);
			mkdirSync(brainDir, { recursive: true });
			writeFileSync(
				join(brainDir, "heartbeat.json"),
				JSON.stringify({
					...heartbeat,
					processPid: item.pid,
					lastGatewayPollAttemptAt: new Date(
						NOW - DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS.pollAttemptStaleMs - 1,
					).toISOString(),
				}),
			);
			const identity = {
				...exactIdentity,
				pid: item.pid,
				label: `com.flywheel.lead.${item.target.leadKey}`,
				wrapper: item.wrapper,
				codexHome: join(homeDir, item.codexHome),
			};
			const execFile = vi.fn(async () => ({
				stdout: JSON.stringify(identity),
			}));
			const alert = vi.fn().mockResolvedValue(undefined);
			const patrol = createHostResidentCodexLeadPatrol({
				homeDir,
				flywheelRoot: "/repo",
				target: item.target,
				now: () => NOW,
				execFile,
				alert,
			});

			await patrol.tick();
			expect(execFile).toHaveBeenCalledWith(
				"/repo/scripts/resident-codex-lead-recover.sh",
				[
					"--project",
					item.target.projectName,
					"--lead",
					item.target.leadId,
					"--probe",
				],
				expect.any(Object),
			);
			expect(alert).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: "detected",
					decision: expect.objectContaining({ branch: "poll_loop_stalled" }),
				}),
			);
		}
	});

	it("accepts only a bounded exact probe result", () => {
		expect(
			parseResidentCodexLeadProbe(
				JSON.stringify(exactIdentity),
				rayaTarget,
				"/home",
			),
		).toEqual(exactIdentity);
		for (const drift of [
			{ ...exactIdentity, label: "com.xrli.raya.brain" },
			{ ...exactIdentity, wrapper: "nearby-wrapper.sh" },
			{ ...exactIdentity, codexHome: "/tmp/not-raya" },
			{ ...exactIdentity, argv: ["node", "/tmp/other-runtime.js"] },
		]) {
			expect(
				parseResidentCodexLeadProbe(JSON.stringify(drift), rayaTarget, "/home")
					.state,
			).toBe("uncertain");
		}
	});

	it("reads bounded heartbeat evidence and atomically records the observed generation", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2216-host-patrol-"));
		const brainDir = join(homeDir, ".flywheel/state/codex-lead/raya/brain");
		mkdirSync(brainDir, { recursive: true });
		writeFileSync(join(brainDir, "heartbeat.json"), JSON.stringify(heartbeat));
		const hostIdentity = {
			...exactIdentity,
			codexHome: join(homeDir, ".flywheel/raya/codex-home"),
		};
		const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
			if (args.at(-1) === "--probe") {
				return { stdout: JSON.stringify(hostIdentity) };
			}
			return { stdout: JSON.stringify({ ok: true, detail: "converged" }) };
		});
		const patrol = createHostResidentCodexLeadPatrol({
			homeDir,
			flywheelRoot: "/repo",
			target: rayaTarget,
			now: () => NOW,
			execFile,
			alert: vi.fn().mockResolvedValue(undefined),
		});
		await patrol.tick();
		expect(execFile).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(
				readFileSync(join(brainDir, "patrol-observed-generation.json"), "utf8"),
			),
		).toMatchObject({
			pid: exactIdentity.pid,
			lstart: exactIdentity.lstart,
			generationId: heartbeat.generationId,
			carrierInstanceId: heartbeat.carrierInstanceId,
		});
	});

	it("never records a foreign-process heartbeat as recovery authority", async () => {
		let current = snapshot({
			heartbeat: {
				state: "valid",
				value: { ...heartbeat, processPid: 3131 },
			},
			observed: null,
		});
		const recordObserved = vi.fn().mockResolvedValue(undefined);
		const recover = vi.fn().mockResolvedValue({
			ok: true,
			detail: "must remain unreachable",
		});
		const patrol = new ResidentCodexLeadPatrol({
			readSnapshot: async () => current,
			recordObserved,
			recover,
			alert: vi.fn().mockResolvedValue(undefined),
			thresholds: {
				...DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS,
				consecutiveFailures: 2,
			},
		});

		await patrol.tick();
		expect(recordObserved).not.toHaveBeenCalled();

		current = snapshot({ heartbeat: { state: "missing" }, observed: null });
		await patrol.tick();
		await patrol.tick();
		await patrol.tick();
		expect(recover).not.toHaveBeenCalled();
	});

	it("never records a same-pid heartbeat that predates the current process", async () => {
		const recordObserved = vi.fn().mockResolvedValue(undefined);
		const patrol = new ResidentCodexLeadPatrol({
			readSnapshot: async () =>
				snapshot({
					heartbeat: {
						state: "valid",
						value: {
							...heartbeat,
							updatedAt: new Date(
								exactIdentity.startedAtMs - 1_000,
							).toISOString(),
						},
					},
					observed: null,
				}),
			recordObserved,
			recover: vi.fn(),
			alert: vi.fn().mockResolvedValue(undefined),
		});

		await patrol.tick();
		expect(recordObserved).not.toHaveBeenCalled();
	});

	it("treats a symlink heartbeat as untrusted alert-only evidence", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2216-host-symlink-"));
		const brainDir = join(homeDir, ".flywheel/state/codex-lead/raya/brain");
		mkdirSync(brainDir, { recursive: true });
		const target = join(homeDir, "outside-heartbeat.json");
		writeFileSync(target, JSON.stringify(heartbeat));
		symlinkSync(target, join(brainDir, "heartbeat.json"));
		const recover = vi.fn();
		const alert = vi.fn().mockResolvedValue(undefined);
		const hostIdentity = {
			...exactIdentity,
			codexHome: join(homeDir, ".flywheel/raya/codex-home"),
		};
		const patrol = createHostResidentCodexLeadPatrol({
			homeDir,
			flywheelRoot: "/repo",
			target: rayaTarget,
			now: () => NOW,
			execFile: vi.fn(async () => ({ stdout: JSON.stringify(hostIdentity) })),
			recover,
			alert,
		});
		await patrol.tick();
		expect(recover).not.toHaveBeenCalled();
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "detected",
				decision: expect.objectContaining({ branch: "observer_missing" }),
			}),
		);
	});

	it("rejects a symlink in the state directory ancestry", async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2216-host-parent-link-"));
		const outside = join(homeDir, "outside");
		const outsideBrain = join(outside, "raya/brain");
		mkdirSync(join(homeDir, ".flywheel/state"), { recursive: true });
		mkdirSync(outsideBrain, { recursive: true });
		symlinkSync(outside, join(homeDir, ".flywheel/state/codex-lead"));
		writeFileSync(
			join(outsideBrain, "heartbeat.json"),
			JSON.stringify(heartbeat),
		);
		const hostIdentity = {
			...exactIdentity,
			codexHome: join(homeDir, ".flywheel/raya/codex-home"),
		};
		const alert = vi.fn().mockResolvedValue(undefined);
		const patrol = createHostResidentCodexLeadPatrol({
			homeDir,
			flywheelRoot: "/repo",
			target: rayaTarget,
			now: () => NOW,
			execFile: vi.fn(async () => ({ stdout: JSON.stringify(hostIdentity) })),
			recover: vi.fn(),
			alert,
		});
		await patrol.tick();
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				decision: expect.objectContaining({ branch: "observer_missing" }),
			}),
		);
		expect(
			existsSync(join(outsideBrain, "patrol-observed-generation.json")),
		).toBe(false);
	});
});

describe("FLY-2216 resident Codex Lead patrol episodes", () => {
	it("shares consecutive failures across category changes and recovers once", async () => {
		let current = snapshot({ heartbeat: { state: "malformed" } });
		const recover = vi
			.fn()
			.mockResolvedValue({ ok: true, detail: "converged" });
		const alert = vi.fn().mockResolvedValue(undefined);
		const patrol = new ResidentCodexLeadPatrol({
			readSnapshot: async () => current,
			recordObserved: vi.fn().mockResolvedValue(undefined),
			recover,
			alert,
			thresholds: {
				...DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS,
				consecutiveFailures: 3,
			},
		});

		await patrol.tick();
		current = snapshot({
			heartbeat: {
				state: "valid",
				value: {
					...heartbeat,
					lastGatewayPollAttemptAt: new Date(NOW - 200_000).toISOString(),
				},
			},
		});
		await patrol.tick();
		await patrol.tick();
		await patrol.tick();
		expect(recover).toHaveBeenCalledTimes(1);
		expect(alert.mock.calls.map((call) => call[0].phase)).toEqual([
			"detected",
			"recovery",
		]);
	});

	it("healthy evidence clears failures and a generation change starts a new episode", async () => {
		let current = snapshot({ heartbeat: { state: "malformed" } });
		const recover = vi.fn().mockResolvedValue({ ok: false, detail: "failed" });
		const patrol = new ResidentCodexLeadPatrol({
			readSnapshot: async () => current,
			recordObserved: vi.fn().mockResolvedValue(undefined),
			recover,
			alert: vi.fn().mockResolvedValue(undefined),
			thresholds: {
				...DEFAULT_RESIDENT_CODEX_LEAD_THRESHOLDS,
				consecutiveFailures: 2,
			},
		});
		await patrol.tick();
		current = snapshot();
		await patrol.tick();
		current = snapshot({ heartbeat: { state: "malformed" } });
		await patrol.tick();
		expect(recover).not.toHaveBeenCalled();
		await patrol.tick();
		expect(recover).toHaveBeenCalledTimes(1);

		current = snapshot({
			identity: {
				...exactIdentity,
				pid: 5252,
				lstart: "Tue Sep  1 06:01:00 2026",
			},
			heartbeat: { state: "malformed" },
			observed: {
				...observed,
				pid: 5252,
				lstart: "Tue Sep  1 06:01:00 2026",
				generationId: "generation-b",
				carrierInstanceId: "carrier-b",
			},
		});
		await patrol.tick();
		await patrol.tick();
		expect(recover).toHaveBeenCalledTimes(2);
	});

	it("never calls recovery for alert-only evidence and contains overlapping ticks", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const readSnapshot = vi.fn(async () => {
			await blocked;
			return snapshot({
				heartbeat: {
					state: "valid",
					value: { ...heartbeat, lastGatewayPollStatus: "failed" },
				},
			});
		});
		const recover = vi.fn();
		const patrol = new ResidentCodexLeadPatrol({
			readSnapshot,
			recordObserved: vi.fn().mockResolvedValue(undefined),
			recover,
			alert: vi.fn().mockResolvedValue(undefined),
		});
		const a = patrol.tick();
		const b = patrol.tick();
		release();
		await Promise.all([a, b]);
		expect(readSnapshot).toHaveBeenCalledTimes(1);
		expect(recover).not.toHaveBeenCalled();
	});
});
