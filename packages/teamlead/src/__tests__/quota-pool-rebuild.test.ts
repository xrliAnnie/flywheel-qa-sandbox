import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyQuotaMonitorState } from "../account-heal/quota-monitor-state.js";
import {
	CANONICAL_POOL_IDENTITIES,
	ClaudePoolRebuild,
	type PoolRebuildPaths,
	type PoolRebuildRuntime,
	RebuildCrashError,
} from "../account-heal/quota-pool-rebuild.js";

const SLOTS = Object.keys(CANONICAL_POOL_IDENTITIES);
const REBUILD_ORDER = [
	...SLOTS.filter((name) => name !== "personal"),
	"personal",
];
const REVIEWED_RUNTIME_SHA256 = "b".repeat(64);

function json(path: string): any {
	return JSON.parse(readFileSync(path, "utf8"));
}

describe("ClaudePoolRebuild", () => {
	let root: string;
	let paths: PoolRebuildPaths;
	let events: string[];
	let runningMode: "stopped" | "monitor" | "enabled";
	let healthOutcomes: Record<
		"monitor" | "enabled",
		"healthy" | "identity_conflict"
	>;
	let keychain: string;
	let verified: Set<string>;
	let crashAt: string | null;
	let failAt: string | null;
	let runtime: PoolRebuildRuntime;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly1182-rebuild-"));
		const stateDir = join(root, ".flywheel");
		const poolDir = join(stateDir, "claude-profiles");
		mkdirSync(poolDir, { recursive: true, mode: 0o700 });
		paths = {
			journal: join(stateDir, "claude-pool-rebuild.journal.json"),
			journalLock: join(stateDir, "claude-pool-rebuild.lock"),
			config: join(stateDir, "quota-monitor.json"),
			configPreimage: join(
				stateDir,
				"claude-pool-rebuild.config-preimage.json",
			),
			identityMap: join(poolDir, "identity-map.json"),
			poolDir,
			active: join(poolDir, ".active"),
			claudeJson: join(root, ".claude.json"),
			claudeJsonLock: join(root, ".claude.json.lock"),
			store: join(stateDir, "claude-accounts.json"),
			state: join(stateDir, "quota-monitor-state.json"),
			accountsLock: join(stateDir, "claude-accounts.lock"),
		};
		for (const [name, email] of Object.entries(CANONICAL_POOL_IDENTITIES)) {
			const dir = join(poolDir, name);
			mkdirSync(dir, { mode: 0o700 });
			writeFileSync(
				join(dir, "oauthAccount.json"),
				JSON.stringify({
					accountUuid: `uuid-${name}`,
					emailAddress: email,
					organizationUuid: `org-${name}`,
					organizationName: `${name} org`,
				}),
				{ mode: 0o600 },
			);
			writeFileSync(
				join(dir, "identity-anchor.json"),
				JSON.stringify({
					accountUuid: `uuid-${name}`,
					email,
					anchoredAt: "2026-07-16T20:00:00.000Z",
					anchoredBy: "test",
					confirmedBy: "annie-confirmed-20260716",
				}),
				{ mode: 0o600 },
			);
		}
		const enabled = {
			trigger5hPct: 100,
			basePollMinutes: 20,
			acceleratePct: 70,
			acceleratedPollMinutes: 10,
			candidateSweepMinutes: 60,
			minSwitchIntervalMinutes: 15,
			order: [...SLOTS],
			writeStatuslineCache: true,
			paneScanSeconds: 60,
			confirmDelayMinutes: 7,
		};
		writeFileSync(paths.config, `${JSON.stringify(enabled)}\n`, {
			mode: 0o600,
		});
		writeFileSync(
			paths.store,
			`${JSON.stringify({
				generation: 7,
				activeAccount: "personal",
				identityStale: true,
				accounts: SLOTS.map((name, index) => ({
					name,
					quotaExhaustedUntil:
						index === 0
							? "2020-01-01T00:00:00.000Z"
							: "2099-01-01T00:00:00.000Z",
					weeklyResetAt: "2099-02-01T00:00:00.000Z",
					authExpired: true,
					refreshTokenInvalid: true,
					profileVerifyFailed: true,
					modelCaps: {
						opus: { until: "2099-03-01T00:00:00.000Z", backoffMs: 60_000 },
					},
				})),
			})}\n`,
			{ mode: 0o600 },
		);
		const state = emptyQuotaMonitorState(7);
		state.pendingDetection = {
			eventId: "pending",
			observedGeneration: 7,
			observedAt: 1,
			sourceAccount: "personal",
			models: ["opus"],
			affectedPanes: [],
		};
		state.alertOutbox = [
			{
				eventId: "keep-alert",
				generation: 7,
				createdAt: 1,
				alert: {
					kind: "quota",
					severity: "warning",
					title: "keep",
					body: "keep",
					signature: "keep",
				},
			},
		];
		writeFileSync(paths.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		writeFileSync(
			paths.claudeJson,
			JSON.stringify({ keep: true, oauthAccount: { stale: true } }),
			{ mode: 0o600 },
		);
		const evidence = {
			version: 1,
			artifactId: "annie-confirmed-20260716",
			confirmedAt: "2026-07-16T20:00:00.000Z",
			labels: CANONICAL_POOL_IDENTITIES,
		};
		writeFileSync(
			join(root, "identity-map-evidence.json"),
			JSON.stringify(evidence),
			{
				mode: 0o600,
			},
		);

		events = [];
		runningMode = "enabled";
		healthOutcomes = { monitor: "healthy", enabled: "healthy" };
		keychain = "personal";
		verified = new Set();
		crashAt = null;
		failAt = null;
		runtime = {
			now: () => Date.parse("2026-07-16T21:00:00.000Z"),
			processIdentity: () => ({ pid: 1234, startTime: "start-1234" }),
			isProcessIdentityAlive: () => false,
			canRecoverTornClaim: () => true,
			gracefulFreeze: async (expectedHash) => {
				events.push(`freeze:${expectedHash}`);
				runningMode = "monitor";
			},
			bootout: async () => {
				events.push("bootout");
				if (failAt === "bootout") throw new Error("bootout failed");
				runningMode = "stopped";
			},
			emergencyStop: async () => {
				events.push("emergency-stop");
				if (failAt === "emergency-stop") {
					throw new Error("emergency stop failed");
				}
				runningMode = "stopped";
			},
			bootstrap: async (mode) => {
				events.push(`bootstrap:${mode}`);
				if (failAt === `bootstrap:${mode}`) throw new Error("bootstrap failed");
				runningMode = mode;
			},
			assertHealthy: async (
				mode,
				expectedHash,
				expectedRuntimeHash,
				policy?: { allowIdentityConflict?: boolean },
			) => {
				events.push(
					`healthy:${mode}:${expectedHash}:${expectedRuntimeHash ?? "none"}:${policy?.allowIdentityConflict === true ? "allow-identity-conflict" : "strict"}`,
				);
				if (runningMode !== mode) throw new Error("wrong daemon mode");
				if (
					healthOutcomes[mode] === "identity_conflict" &&
					policy?.allowIdentityConflict !== true
				) {
					throw new Error("identity conflict is unhealthy");
				}
				if (
					mode === "enabled" &&
					expectedRuntimeHash !== REVIEWED_RUNTIME_SHA256
				) {
					throw new Error("wrong enabled runtime hash");
				}
			},
			isDaemonRunning: async () => runningMode !== "stopped",
			inspectDaemonMode: () => runningMode,
			verifyProfile: async (name, source) => {
				events.push(`verify:${name}:${source}`);
				if (source === "keychain") {
					if (keychain !== name) throw new Error("keychain mismatch");
					return;
				}
				if (!verified.has(name)) throw new Error(`slot ${name} not verified`);
			},
			verifyFly1252: async (sha, evidencePath) => {
				events.push(`verify1252:${sha}:${evidencePath}`);
				if (sha !== "reviewed-1252" || evidencePath !== "evidence-1252") {
					throw new Error("1252 evidence invalid");
				}
				return REVIEWED_RUNTIME_SHA256;
			},
			checkpoint: (name) => {
				events.push(`checkpoint:${name}`);
				if (crashAt === name) throw new RebuildCrashError(name);
				if (failAt === name) throw new Error(`${name} failed`);
			},
		};
	});

	afterEach(() => {
		// The test temp is intentionally left to the OS; removing it while a
		// crash simulation is unwinding can hide leaked-handle bugs on macOS.
	});

	function subject(): ClaudePoolRebuild {
		return new ClaudePoolRebuild(paths, runtime);
	}

	async function prepareAndRebuildSlots(): Promise<void> {
		const rebuild = subject();
		await rebuild.prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
		});
		expect(json(paths.config)).toMatchObject({ order: [], trigger5hPct: 100 });
		await rebuild.installIdentityMap();
		await rebuild.beginSlots();
		for (const name of REBUILD_ORDER) {
			verified.add(name);
			await rebuild.markSlotVerified(name);
		}
	}

	it("freezes safely, installs the canonical map, and latches before slot work", async () => {
		const rebuild = subject();
		await rebuild.prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
		});
		expect(rebuild.status().stage).toBe("frozen");
		expect(json(paths.config)).toMatchObject({ order: [], trigger5hPct: 100 });
		expect(runningMode).toBe("monitor");
		await rebuild.abortRestore();
		expect(rebuild.status().stage).toBe("aborted_monitor_only");
		expect(json(paths.config).order).toEqual([]);

		// A fresh run demonstrates the forward-only latch.
		writeFileSync(paths.journal, "", { mode: 0o600 });
		// Empty/corrupt journals are never silently reused.
		expect(() => rebuild.status()).toThrow();
	});

	it("recovers from a claim torn before its payload was published", async () => {
		mkdirSync(paths.journalLock, { mode: 0o700 });
		writeFileSync(join(paths.journalLock, "claim-1.json"), "", {
			mode: 0o600,
		});
		runtime.canRecoverTornClaim = () => false;
		await expect(
			subject().prepare({
				finalActive: "personal",
				identityMapEvidence: join(root, "identity-map-evidence.json"),
			}),
		).rejects.toThrow(/legacy claim publisher/);
		runtime.canRecoverTornClaim = () => true;
		await subject().prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
		});
		expect(subject().status().stage).toBe("frozen");
	});

	it("keeps one exclusive journal owner while another command races", async () => {
		let releaseFreeze: (() => void) | undefined;
		runtime.gracefulFreeze = async () =>
			new Promise<void>((resolve) => {
				releaseFreeze = resolve;
			});
		const first = subject().prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
		});
		await Promise.resolve();
		const contenderRuntime: PoolRebuildRuntime = {
			...runtime,
			processIdentity: () => ({ pid: 5678, startTime: "start-5678" }),
			isProcessIdentityAlive: (pid, startTime) =>
				pid === 1234 && startTime === "start-1234",
		};
		const contender = new ClaudePoolRebuild(paths, contenderRuntime);
		await expect(
			contender.prepare({
				finalActive: "personal",
				identityMapEvidence: join(root, "identity-map-evidence.json"),
			}),
		).rejects.toThrow(/already owned/);
		releaseFreeze?.();
		await first;
	});

	it("accepts an already-frozen semantic target when given the enabled preimage", async () => {
		const enabledPreimage = join(root, "enabled-preimage.json");
		writeFileSync(enabledPreimage, readFileSync(paths.config), { mode: 0o600 });
		const live = json(paths.config);
		live.order = [];
		live.trigger5hPct = 100;
		// Different formatting/hash, same monitor-only semantics.
		writeFileSync(paths.config, JSON.stringify(live), { mode: 0o600 });
		chmodSync(paths.config, 0o644);
		await subject().prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
			enabledPreimage,
		});
		expect(subject().status()).toMatchObject({
			stage: "frozen",
			consistent: true,
		});
		expect(json(paths.config)).toMatchObject({ order: [], trigger5hPct: 100 });
	});

	it("accepts the deployed legacy config shape using the runtime defaults", async () => {
		const enabledPreimage = join(root, "enabled-preimage.json");
		const legacyEnabled = json(paths.config);
		delete legacyEnabled.paneScanSeconds;
		delete legacyEnabled.confirmDelayMinutes;
		writeFileSync(enabledPreimage, JSON.stringify(legacyEnabled), {
			mode: 0o600,
		});

		const legacyMonitorOnly = {
			...legacyEnabled,
			trigger5hPct: 100,
			order: [],
		};
		writeFileSync(paths.config, JSON.stringify(legacyMonitorOnly), {
			mode: 0o600,
		});

		await subject().prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
			enabledPreimage,
		});

		expect(json(paths.config)).toMatchObject({
			trigger5hPct: 100,
			order: [],
			paneScanSeconds: 60,
			confirmDelayMinutes: 7,
		});
		const journal = json(paths.journal);
		const enabled = JSON.parse(
			Buffer.from(journal.config.enabledBytesBase64, "base64").toString("utf8"),
		);
		expect(enabled).toMatchObject({
			trigger5hPct: 90,
			order: SLOTS,
			paneScanSeconds: 60,
			confirmDelayMinutes: 7,
		});
	});

	it("resume completes the positive quiescence ACK after a freeze-write crash", async () => {
		crashAt = "config-frozen";
		await expect(
			subject().prepare({
				finalActive: "personal",
				identityMapEvidence: join(root, "identity-map-evidence.json"),
			}),
		).rejects.toBeInstanceOf(RebuildCrashError);
		crashAt = null;
		expect(subject().status()).toMatchObject({
			stage: "frozen",
			consistent: false,
		});
		await expect(subject().installIdentityMap()).rejects.toThrow(
			/freeze acknowledgement/,
		);
		await subject().resume();
		expect(subject().status()).toMatchObject({
			stage: "frozen",
			consistent: true,
		});
		expect(runningMode).toBe("monitor");
	});

	it("revalidates monitor config and daemon health at the irreversible slot latch", async () => {
		const rebuild = subject();
		await rebuild.prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
		});
		await rebuild.installIdentityMap();
		const drift = { ...json(paths.config), order: ["school"] };
		writeFileSync(paths.config, JSON.stringify(drift), { mode: 0o600 });
		await expect(rebuild.beginSlots()).rejects.toThrow(/CAS drift/);
		expect(json(paths.journal).stage).toBe("mapped");
	});

	it("allows identity conflict only at the pre-login latch so the rebuild can repair it", async () => {
		const rebuild = subject();
		await rebuild.prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
		});
		await rebuild.installIdentityMap();
		healthOutcomes.monitor = "identity_conflict";

		await rebuild.beginSlots();

		expect(rebuild.status()).toMatchObject({
			stage: "slots_rebuilding",
			verifiedSlots: 0,
			nextSlot: REBUILD_ORDER[0],
		});
		expect(events).toContainEqual(
			expect.stringMatching(
				/^healthy:monitor:.*:none:allow-identity-conflict$/,
			),
		);
	});

	it("keeps identity conflict fail-closed at commit and resume health checks", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		healthOutcomes.monitor = "identity_conflict";
		await expect(subject().commit()).rejects.toThrow(/identity conflict/);

		healthOutcomes.monitor = "healthy";
		await subject().resume();
		expect(subject().status().stage).toBe("awaiting_1252");
		healthOutcomes.monitor = "identity_conflict";
		await expect(subject().resume()).rejects.toThrow(/identity conflict/);
		expect(
			events.filter((event) => event.includes("allow-identity-conflict")),
		).toHaveLength(1);
	});

	it("keeps identity conflict fail-closed for enabled promotion", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		healthOutcomes.enabled = "identity_conflict";

		await expect(
			subject().promoteEnabled({
				fly1252ReviewedSha: "reviewed-1252",
				fly1252Evidence: "evidence-1252",
			}),
		).rejects.toThrow(/identity conflict/);
		expect(subject().status().stage).toBe("awaiting_1252");
		expect(
			events.filter((event) => event.includes("allow-identity-conflict")),
		).toHaveLength(1);
	});

	it("commit reconciles a fixed generation and preserves future benches/outbox", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		writeFileSync(paths.active, "school", { mode: 0o644 });
		await subject().commit();
		const status = subject().status();
		expect(status.stage).toBe("awaiting_1252");
		expect(runningMode).toBe("monitor");
		const store = json(paths.store);
		expect(store.generation).toBe(8);
		expect(store.activeAccount).toBe("personal");
		expect(store.identityStale).toBe(false);
		expect(store.accounts[0].quotaExhaustedUntil).toBeNull();
		expect(store.accounts[1].quotaExhaustedUntil).toBe(
			"2099-01-01T00:00:00.000Z",
		);
		expect(store.accounts[0].modelCaps.opus.until).toBe(
			"2099-03-01T00:00:00.000Z",
		);
		for (const account of store.accounts) {
			expect(account.authExpired).toBe(false);
			expect(account.refreshTokenInvalid).toBe(false);
			expect(account.profileVerifyFailed).toBe(false);
		}
		const state = json(paths.state);
		expect(state.observedGeneration).toBe(8);
		expect(state.pendingDetection).toBeNull();
		expect(state.reviveEpoch).toBeNull();
		expect(state.confirmation).toBeNull();
		expect(state.alertOutbox[0].eventId).toBe("keep-alert");
		expect(readFileSync(paths.active, "utf8")).toBe("personal");
		expect(json(paths.claudeJson)).toMatchObject({
			keep: true,
			oauthAccount: { emailAddress: CANONICAL_POOL_IDENTITIES.personal },
		});
	});

	it("commit rereads state after daemon shutdown and preserves its final delayed outbox write", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		const originalBootout = runtime.bootout;
		runtime.bootout = async () => {
			const state = json(paths.state);
			state.alertOutbox.push({
				eventId: "daemon-final-write",
				generation: 7,
				createdAt: 2,
				alert: {
					kind: "quota",
					severity: "warning",
					title: "delayed",
					body: "delayed",
					signature: "delayed",
				},
			});
			writeFileSync(paths.state, JSON.stringify(state), { mode: 0o600 });
			await originalBootout();
		};
		await subject().commit();
		expect(
			json(paths.state).alertOutbox.map((item: any) => item.eventId),
		).toEqual(["keep-alert", "daemon-final-write"]);
	});

	it("the pre-login latch and each verified slot survive a process crash", async () => {
		const rebuild = subject();
		await rebuild.prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
		});
		await rebuild.installIdentityMap();
		crashAt = "latch-written";
		await expect(rebuild.beginSlots()).rejects.toBeInstanceOf(
			RebuildCrashError,
		);
		crashAt = null;
		await subject().resume();
		expect(subject().status()).toMatchObject({
			stage: "slots_rebuilding",
			verifiedSlots: 0,
			nextSlot: REBUILD_ORDER[0],
		});

		verified.add(REBUILD_ORDER[0] as string);
		crashAt = "slot-captured";
		await expect(
			subject().markSlotVerified(REBUILD_ORDER[0] as string),
		).rejects.toBeInstanceOf(RebuildCrashError);
		crashAt = null;
		await subject().resume();
		expect(subject().status()).toMatchObject({
			stage: "slots_rebuilding",
			verifiedSlots: 1,
			nextSlot: REBUILD_ORDER[1],
		});
		await expect(subject().markSlotVerified("personal")).rejects.toThrow(
			/next rebuild slot/,
		);
		await expect(subject().abortRestore()).rejects.toThrow(/forbidden/);
		expect(subject().status().stage).toBe("recovery_required");
		await subject().resume();
		expect(subject().status()).toMatchObject({
			stage: "slots_rebuilding",
			verifiedSlots: 1,
			nextSlot: REBUILD_ORDER[1],
		});
		expect(runningMode).toBe("monitor");
	});

	it("a token match cannot mark a slot verified when its display identity is mislabeled", async () => {
		const rebuild = subject();
		await rebuild.prepare({
			finalActive: "personal",
			identityMapEvidence: join(root, "identity-map-evidence.json"),
		});
		await rebuild.installIdentityMap();
		await rebuild.beginSlots();
		const first = REBUILD_ORDER[0] as string;
		verified.add(first);
		const displayPath = join(paths.poolDir, first, "oauthAccount.json");
		const display = json(displayPath);
		display.emailAddress = "wrong@example.com";
		writeFileSync(displayPath, JSON.stringify(display), { mode: 0o600 });
		await expect(rebuild.markSlotVerified(first)).rejects.toThrow(
			/display identity differs/,
		);
		expect(rebuild.status()).toMatchObject({
			verifiedSlots: 0,
			nextSlot: first,
		});
	});

	it.each([
		"active-written",
		"display-written",
		"store-written",
		"state-written",
		"monitor-config-restored",
	])("resume converges after crash point %s", async (point) => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		crashAt = point;
		await expect(subject().commit()).rejects.toBeInstanceOf(RebuildCrashError);
		crashAt = null;
		await subject().resume();
		expect(subject().status().stage).toBe("awaiting_1252");
		expect(json(paths.store).generation).toBe(8);
		expect(json(paths.state).observedGeneration).toBe(8);
	});

	it("commit refuses a final-active mismatch without cutting in", async () => {
		await prepareAndRebuildSlots();
		keychain = "school";
		await expect(subject().commit()).rejects.toThrow(/keychain mismatch/);
		expect(subject().status().stage).toBe("recovery_required");
		expect(() => readFileSync(paths.active, "utf8")).toThrow();
	});

	it("final verification and status require exact four-field display identity equality", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		const claude = json(paths.claudeJson);
		claude.oauthAccount.accountUuid = "same-email-wrong-uuid";
		writeFileSync(paths.claudeJson, JSON.stringify(claude), { mode: 0o600 });
		expect(subject().status()).toMatchObject({ consistent: false });
		await expect(
			subject().promoteEnabled({
				fly1252ReviewedSha: "reviewed-1252",
				fly1252Evidence: "evidence-1252",
			}),
		).rejects.toThrow(/display identity field accountUuid/);
		expect(runningMode).toBe("monitor");
	});

	it("promotes through WAL and restores the normal threshold only after health", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		await subject().promoteEnabled({
			fly1252ReviewedSha: "reviewed-1252",
			fly1252Evidence: "evidence-1252",
		});
		expect(subject().status().stage).toBe("restored_enabled");
		expect(json(paths.config)).toMatchObject({
			order: SLOTS,
			trigger5hPct: 90,
		});
		expect(runningMode).toBe("enabled");
		const promoting = events.indexOf("checkpoint:enabled-config-written");
		const healthy = events.findIndex((event) =>
			event.startsWith("healthy:enabled:"),
		);
		expect(promoting).toBeGreaterThan(-1);
		expect(healthy).toBeGreaterThan(promoting);
	});

	it.each(["enabled-config-written", "enabled-bootstrapped"])(
		"resume after promotion crash at %s first stops enabled daemon and returns monitor-only",
		async (point) => {
			await prepareAndRebuildSlots();
			keychain = "personal";
			await subject().commit();
			crashAt = point;
			await expect(
				subject().promoteEnabled({
					fly1252ReviewedSha: "reviewed-1252",
					fly1252Evidence: "evidence-1252",
				}),
			).rejects.toBeInstanceOf(RebuildCrashError);
			crashAt = null;
			events = [];
			await subject().resume();
			expect(events[0]).toBe("bootout");
			expect(subject().status().stage).toBe("awaiting_1252");
			expect(json(paths.config)).toMatchObject({
				order: [],
				trigger5hPct: 100,
			});
			expect(runningMode).toBe("monitor");
		},
	);

	it("ordinary enabled bootstrap failure rolls back to a healthy monitor-only daemon", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		failAt = "bootstrap:enabled";
		await expect(
			subject().promoteEnabled({
				fly1252ReviewedSha: "reviewed-1252",
				fly1252Evidence: "evidence-1252",
			}),
		).rejects.toThrow(/bootstrap failed/);
		expect(subject().status().stage).toBe("awaiting_1252");
		expect(json(paths.config)).toMatchObject({ order: [], trigger5hPct: 100 });
		expect(runningMode).toBe("monitor");
	});

	it("promotion recovery uses the independent emergency stop before rolling back enabled bytes", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		let promotionBootouts = 0;
		runtime.bootout = async () => {
			events.push("bootout");
			promotionBootouts++;
			if (promotionBootouts > 1) throw new Error("bootout failed");
			runningMode = "stopped";
		};
		failAt = "bootstrap:enabled";
		await expect(
			subject().promoteEnabled({
				fly1252ReviewedSha: "reviewed-1252",
				fly1252Evidence: "evidence-1252",
			}),
		).rejects.toThrow(/bootstrap failed/);
		expect(events).toContain("emergency-stop");
		expect(subject().status().stage).toBe("awaiting_1252");
		expect(json(paths.config)).toMatchObject({ order: [], trigger5hPct: 100 });
		expect(runningMode).toBe("monitor");
	});

	it("status detects stage-specific store, state, and daemon corruption", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		runningMode = "enabled";
		const store = json(paths.store);
		store.generation = 999;
		writeFileSync(paths.store, JSON.stringify(store), { mode: 0o600 });
		const state = json(paths.state);
		state.observedGeneration = 998;
		writeFileSync(paths.state, JSON.stringify(state), { mode: 0o600 });
		const status = subject().status();
		expect(status.consistent).toBe(false);
		expect(status.errors.join("\n")).toMatch(
			/store generation|state generation|daemon mode/,
		);
	});

	it("an unknown post-crash config is never overwritten and leaves the daemon stopped", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		crashAt = "enabled-config-written";
		await expect(
			subject().promoteEnabled({
				fly1252ReviewedSha: "reviewed-1252",
				fly1252Evidence: "evidence-1252",
			}),
		).rejects.toBeInstanceOf(RebuildCrashError);
		crashAt = null;
		const external = {
			...json(paths.config),
			externalOwner: "do-not-overwrite",
		};
		writeFileSync(paths.config, JSON.stringify(external), { mode: 0o600 });
		await expect(subject().resume()).rejects.toThrow(/unknown config hash/);
		expect(subject().status().stage).toBe("recovery_required");
		expect(json(paths.config).externalOwner).toBe("do-not-overwrite");
		expect(runningMode).toBe("stopped");
	});

	it("FLY-1252 verifier failure rejects promotion before bootout", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		events = [];
		await expect(
			subject().promoteEnabled({
				fly1252ReviewedSha: "wrong",
				fly1252Evidence: "evidence-1252",
			}),
		).rejects.toThrow(/1252 evidence invalid/);
		expect(events).not.toContain("bootout");
		expect(subject().status().stage).toBe("awaiting_1252");
		expect(runningMode).toBe("monitor");
	});

	it("refuses CAS drift and makes rollback failure an explicit stopped recovery", async () => {
		await prepareAndRebuildSlots();
		keychain = "personal";
		await subject().commit();
		const drift = { ...json(paths.config), external: true };
		writeFileSync(paths.config, JSON.stringify(drift), { mode: 0o600 });
		await expect(
			subject().promoteEnabled({
				fly1252ReviewedSha: "reviewed-1252",
				fly1252Evidence: "evidence-1252",
			}),
		).rejects.toThrow(/CAS|drift/i);
		expect(subject().status().stage).toBe("awaiting_1252");

		// The command refuses to overwrite drift. Restore the journaled target as
		// the explicit operator recovery, then exercise a rollback failure.
		const journal = json(paths.journal);
		writeFileSync(
			paths.config,
			Buffer.from(journal.config.targetBytesBase64, "base64"),
			{ mode: 0o600 },
		);
		await subject().resume();
		crashAt = "enabled-config-written";
		await expect(
			subject().promoteEnabled({
				fly1252ReviewedSha: "reviewed-1252",
				fly1252Evidence: "evidence-1252",
			}),
		).rejects.toBeInstanceOf(RebuildCrashError);
		crashAt = null;
		failAt = "bootstrap:monitor";
		await expect(subject().resume()).rejects.toThrow(/bootstrap failed/);
		expect(subject().status().stage).toBe("recovery_required");
		expect(runningMode).toBe("stopped");
		expect(subject().status().actualConfigSha256).toMatch(/^[a-f0-9]{64}$/);
	});
});
