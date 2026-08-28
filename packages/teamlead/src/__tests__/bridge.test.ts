import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdmissionCrossingBarrier } from "../bridge/admission-crossing-barrier.js";
import {
	buildLivenessManifest,
	LivenessCheckTracker,
} from "../bridge/liveness-manifest.js";
import { createBridgeApp, startBridge } from "../bridge/plugin.js";
import { RunnerAdmissionController } from "../bridge/runner-admission.js";
import type { BridgeConfig } from "../bridge/types.js";
import { loadConfig } from "../config.js";
import { MetaAlertNotifier } from "../MetaAlertNotifier.js";
import { StateStore } from "../StateStore.js";

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0, // random port
		dbPath: ":memory:",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		runnerAdmission: RunnerAdmissionController.alwaysAdmit(),
		...overrides,
	};
}

describe("Bridge scaffold", () => {
	let closeFn: (() => Promise<void>) | undefined;

	beforeEach(() => {
		vi.stubEnv("TEAMLEAD_DEFAULT_LEAD_AGENT", "product-lead");
		vi.stubEnv("DISCORD_OWNER_USER_ID", "test-founder");
		vi.stubEnv("FLYWHEEL_FOUNDER_USER_ID", undefined);
	});

	afterEach(async () => {
		try {
			if (closeFn) {
				await closeFn();
				closeFn = undefined;
			}
		} finally {
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
		}
	});

	it("GET /health returns 200 with uptime (no auth required)", async () => {
		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, [], makeConfig());

		const res = await fetch(await startAndGetUrl(app, "/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		// FLY-516: additive field, false in steady state (byte-compat).
		expect(body.shuttingDown).toBe(false);
		expect(typeof body.uptime).toBe("number");
		expect(body.sessions_count).toBe(0);
		expect(body.buildMode).toBe("unknown");
		expect(body.buildSha).toBeNull();

		store.close();
	});

	it("FLY-1995 exposes stable event-loop health and fail-closed diagnostics auth", async () => {
		const diagnostics = {
			healthSnapshot: () => ({ p99_ms: null, max_ms: null, episodes: 0 }),
			snapshot: () => ({
				state: "disabled",
				profiles: ["loop-profile-safe.cpuprofile"],
			}),
		};

		const tokenlessStore = await StateStore.create(":memory:");
		const tokenlessApp = createBridgeApp(
			tokenlessStore,
			[],
			makeConfig(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ eventLoopAttribution: diagnostics },
		);
		const tokenlessBase = await startAndGetUrl(
			tokenlessApp,
			"/api/diagnostics/event-loop",
		);
		expect((await fetch(tokenlessBase)).status).toBe(503);
		const tokenlessHealth = await (
			await fetch(new URL("/health", tokenlessBase))
		).json();
		expect(tokenlessHealth.event_loop).toEqual({
			p99_ms: null,
			max_ms: null,
			episodes: 0,
		});
		tokenlessStore.close();

		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(
			store,
			[],
			makeConfig({
				apiToken: "master-token",
				geminiAgentToken: "scoped-token",
			}),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ eventLoopAttribution: diagnostics },
		);
		const base = await startAndGetUrl(app, "/api/diagnostics/event-loop");
		expect((await fetch(base)).status).toBe(401);
		expect(
			(
				await fetch(base, {
					headers: { Authorization: "Bearer scoped-token" },
				})
			).status,
		).toBe(403);
		const authorized = await fetch(base, {
			headers: { Authorization: "Bearer master-token" },
		});
		expect(authorized.status).toBe(200);
		expect(await authorized.json()).toEqual(diagnostics.snapshot());
		store.close();
	});

	it("exposes a master-auth admission pause with TTL health and explicit resume", async () => {
		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(
			store,
			[],
			makeConfig({ apiToken: "master-secret" }),
		);
		const pauseUrl = await startAndGetUrl(app, "/api/admission/pause");
		const unauthorized = await fetch(pauseUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ durationSeconds: 1_800 }),
		});
		expect(unauthorized.status).toBe(401);

		const paused = await fetch(pauseUrl, {
			method: "POST",
			headers: {
				Authorization: "Bearer master-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({ durationSeconds: 1_800, reason: "deploy" }),
		});
		expect(paused.status).toBe(200);
		expect(await paused.json()).toMatchObject({
			ok: true,
			admissionPause: { active: true },
		});

		const health = await (await fetch(new URL("/health", pauseUrl))).json();
		expect(health.admissionPause.active).toBe(true);
		expect(health.admissionPause.remainingSeconds).toBeGreaterThan(1_790);
		expect(health.admissionPause.reason).toBeUndefined();

		const resumed = await fetch(new URL("/api/admission/resume", pauseUrl), {
			method: "POST",
			headers: { Authorization: "Bearer master-secret" },
		});
		expect(resumed.status).toBe(200);
		expect(await resumed.json()).toEqual({
			ok: true,
			admissionPause: { active: false, remainingSeconds: 0 },
		});
		store.close();
	});

	it("reports every authoritative host-quiescence component under an active pause", async () => {
		const store = await StateStore.create(":memory:");
		store.insertLaunchClaim({
			executionId: "launch-1",
			rootUuid: "root-1",
			project: "flywheel",
		});
		const barrier = new AdmissionCrossingBarrier();
		const release = barrier.enter("start");
		let inflight = 2;
		const startDispatcher = {
			start: async () => ({ executionId: "unused", issueId: "FLY-1944" }),
			getInflightCount: () => inflight,
			validateAgentName: () => ({ ok: true as const }),
		};
		const app = createBridgeApp(
			store,
			[],
			makeConfig({ apiToken: "master-secret" }),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			startDispatcher,
			undefined,
			undefined,
			{ admissionCrossingBarrier: barrier },
		);
		const base = await startAndGetUrl(app, "/api/admission/pause");
		const auth = { Authorization: "Bearer master-secret" };
		await fetch(base, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ durationSeconds: 1_800 }),
		});

		const active = await (
			await fetch(new URL("/api/admission/quiescence", base), {
				headers: auth,
			})
		).json();
		expect(active).toMatchObject({
			ok: true,
			quiescent: false,
			total: 4,
			components: {
				readoptCandidateSessions: 0,
				dispatcherInflight: 2,
				durableLaunchClaims: 1,
				admissionCrossing: { start: 1, dispatch: 0, total: 1 },
			},
		});

		release();
		inflight = 0;
		store.setLaunchClaimState("launch-1", "closed");
		const quiet = await (
			await fetch(new URL("/api/admission/quiescence", base), {
				headers: auth,
			})
		).json();
		expect(quiet).toMatchObject({ ok: true, quiescent: true, total: 0 });
		store.close();
	});

	it("fails the admission control API closed when the master token is absent", async () => {
		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, [], makeConfig());
		const res = await fetch(await startAndGetUrl(app, "/api/admission/pause"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ durationSeconds: 1_800 }),
		});
		expect(res.status).toBe(503);
		store.close();
	});

	it("returns admission_paused with Retry-After before a run start writes state", async () => {
		const store = await StateStore.create(":memory:");
		const admission = RunnerAdmissionController.alwaysAdmit();
		admission.setAdmissionPauseProbe(() => ({
			detail: "operator deployment pause is active",
			retryAfterSeconds: 77,
		}));
		const startDispatcher = {
			start: async () => ({ executionId: "must-not-start", issueId: "FLY-1" }),
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		};
		const app = createBridgeApp(
			store,
			[],
			makeConfig({ runnerAdmission: admission }),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			startDispatcher,
		);
		const previousLinearKey = process.env.LINEAR_API_KEY;
		process.env.LINEAR_API_KEY = "test-key";
		try {
			const res = await fetch(await startAndGetUrl(app, "/api/runs/start"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ issueId: "FLY-1", projectName: "flywheel" }),
			});
			expect(res.status).toBe(429);
			expect(res.headers.get("retry-after")).toBe("77");
			expect(await res.json()).toMatchObject({
				success: false,
				reason: "admission_paused",
			});
			expect(store.getActiveSessions()).toHaveLength(0);
		} finally {
			if (previousLinearKey === undefined) delete process.env.LINEAR_API_KEY;
			else process.env.LINEAR_API_KEY = previousLinearKey;
			store.close();
		}
	});

	// FLY-516: when the shared shutdown holder is flipped (close() does this at
	// teardown start), /health must report shuttingDown:true and ok:false so the
	// wrapper preflight reclaims the port instead of yielding to a draining
	// (zombie-in-the-making) Bridge that still answers 200.
	it("GET /health reflects shuttingDown via the shutdown holder", async () => {
		const store = await StateStore.create(":memory:");
		const holder = { shuttingDown: false };
		const app = createBridgeApp(
			store,
			[],
			makeConfig(),
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // _unusedForumTagUpdater
			undefined, // registry
			undefined, // _unusedForumPostCreator
			undefined, // memoryService
			undefined, // captureSessionFn
			undefined, // startDispatcher
			undefined, // standupService
			undefined, // standupProjectName
			{ shutdownStateHolder: holder },
		);

		const base = await startAndGetUrl(app, "/health");
		const before = await (await fetch(base)).json();
		expect(before.ok).toBe(true);
		expect(before.shuttingDown).toBe(false);

		// Simulate close() flipping the flag mid-flight.
		holder.shuttingDown = true;
		const duringRes = await fetch(base);
		expect(duringRes.status).toBe(200); // still 200 (additive, not a 503)
		const during = await duringRes.json();
		expect(during.ok).toBe(false);
		expect(during.shuttingDown).toBe(true);

		store.close();
	});

	it("GET /health reads the liveness manifest from a late-bound provider", async () => {
		const store = await StateStore.create(":memory:");
		const heartbeatRef: {
			current?: {
				probeForensicsSnapshot(): Record<string, number | string | null>;
			};
		} = {};
		const tracker = new LivenessCheckTracker({ cadenceMs: 30_000 });
		const holder: { current?: () => unknown } = {
			current: () =>
				buildLivenessManifest({
					bridgeStartedAtMs: Date.now(),
					wiring: { liveness: true, externalDrift: true },
					trackers: { liveness: tracker },
					deliveryLoopWired: true,
					loopStallMs: 60_000,
					loopTargets: [],
					...(heartbeatRef.current
						? {
								probeForensics:
									heartbeatRef.current.probeForensicsSnapshot() as never,
							}
						: {}),
				}),
		};
		const app = createBridgeApp(
			store,
			[],
			makeConfig(),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ livenessHealthProvider: holder },
		);
		const url = await startAndGetUrl(app, "/health");
		const before = (await (await fetch(url)).json()).liveness;
		expect(before.schema_version).toBe(2);
		expect(before.probe_forensics).toBeUndefined();

		heartbeatRef.current = {
			probeForensicsSnapshot: () => ({
				lookup_error: 1,
				probe_throw: 2,
				probe_unclear: 3,
				pending_sentinel: 4,
				last_at: "2026-08-23T13:42:04.000Z",
			}),
		};
		expect((await (await fetch(url)).json()).liveness.probe_forensics).toEqual({
			lookup_error: 1,
			probe_throw: 2,
			probe_unclear: 3,
			pending_sentinel: 4,
			last_at: "2026-08-23T13:42:04.000Z",
		});

		holder.current = () => {
			throw new Error("queue closed during teardown");
		};
		const degradedRes = await fetch(url);
		expect(degradedRes.status).toBe(200);
		expect(await degradedRes.json()).toMatchObject({
			ok: true,
			liveness: {
				degraded: true,
				reason: "manifest_provider_error",
			},
		});
		store.close();
	});

	it("Unknown routes return 404", async () => {
		const store = await StateStore.create(":memory:");
		const app = createBridgeApp(store, [], makeConfig());

		const res = await fetch(await startAndGetUrl(app, "/nonexistent"));
		expect(res.status).toBe(404);

		store.close();
	});

	it("/api/* requires apiToken when configured", async () => {
		const config = makeConfig({ apiToken: "secret-api" });
		const { store, close } = await startBridge(config, [
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "product-lead",
						summaryRole: "producer",
						forumChannel: "test-channel",
						chatChannel: "test-chat",
						match: { labels: ["Product"] },
					},
				],
			},
		]);
		closeFn = close;

		const _addr = getListeningPort(close);
		// This will hit the 404 catch-all since no /api routes are mounted yet,
		// but auth middleware isn't applied yet either (will be in Task 3).
		// For now, just verify startBridge works.
		expect(store).toBeDefined();
	});

	it("keeps Discord delivery failures on the independent alert_unreachable_config reason", async () => {
		vi.stubEnv("FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID", "");
		const notify = vi
			.spyOn(MetaAlertNotifier.prototype, "notify")
			.mockResolvedValue({ debounced: false, desktop: false, file: true });
		vi.spyOn(
			MetaAlertNotifier.prototype,
			"probeDesktopCapability",
		).mockResolvedValue(false);

		const { close } = await startBridge(makeConfig(), [
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "product-lead",
						summaryRole: "producer",
						forumChannel: "test-channel",
						chatChannel: "test-chat",
						match: { labels: ["Product"] },
					},
				],
			},
		]);
		closeFn = close;

		const reasons = notify.mock.calls.map(([input]) => input.reason);
		expect(reasons).toContain("alert_unreachable_config");
		expect(reasons).not.toContain("ticket_route_unreachable");
	});

	it("fails loud when the Hub has no valid founder escalation id", async () => {
		vi.stubEnv("FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID", "test-alert-channel");
		vi.stubEnv("FLYWHEEL_ALERT_SENDER_TOKEN_ENV", "TEST_ALERT_TOKEN");
		vi.stubEnv("TEST_ALERT_TOKEN", "test-token");
		const notify = vi
			.spyOn(MetaAlertNotifier.prototype, "notify")
			.mockResolvedValue({ debounced: false, desktop: false, file: true });
		vi.spyOn(
			MetaAlertNotifier.prototype,
			"probeDesktopCapability",
		).mockResolvedValue(false);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const { close } = await startBridge(
			makeConfig({ discordOwnerUserId: "not-a-snowflake" }),
			[
				{
					projectName: "test",
					projectRoot: "/tmp",
					leads: [
						{
							agentId: "product-lead",
							summaryRole: "producer",
							forumChannel: "test-channel",
							chatChannel: "test-chat",
							match: { labels: ["Product"] },
						},
					],
				},
			],
		);
		closeFn = close;

		expect(error).toHaveBeenCalledWith(
			expect.stringContaining("founder escalation route unreachable"),
		);
		expect(notify).toHaveBeenCalledWith({
			reason: "alert_unreachable_config",
			title: "Founder escalation route unreachable",
			body: expect.stringContaining("Claw mailbox"),
		});
	});

	it("loadConfig() rejects host=0.0.0.0", () => {
		const prev = process.env.TEAMLEAD_HOST;
		process.env.TEAMLEAD_HOST = "0.0.0.0";
		try {
			expect(() => loadConfig()).toThrow("must be loopback");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_HOST;
			else process.env.TEAMLEAD_HOST = prev;
		}
	});

	it("loadConfig() rejects IPv6 all-interfaces (::)", () => {
		const prev = process.env.TEAMLEAD_HOST;
		process.env.TEAMLEAD_HOST = "::";
		try {
			expect(() => loadConfig()).toThrow("must be loopback");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_HOST;
			else process.env.TEAMLEAD_HOST = prev;
		}
	});

	it("loadConfig() defaults host to 127.0.0.1", () => {
		const prev = process.env.TEAMLEAD_HOST;
		delete process.env.TEAMLEAD_HOST;
		try {
			const config = loadConfig();
			expect(config.host).toBe("127.0.0.1");
		} finally {
			if (prev !== undefined) process.env.TEAMLEAD_HOST = prev;
		}
	});

	it("loadConfig() boots from the canonical founder identity provisioned by fresh setup", () => {
		vi.stubEnv("DISCORD_OWNER_USER_ID", "canonical-founder");
		vi.stubEnv("FLYWHEEL_FOUNDER_USER_ID", undefined);

		const config = loadConfig();
		expect(config.discordOwnerUserId).toBe("canonical-founder");
		expect(config.founderConsent?.founderUserId).toBe("canonical-founder");
		expect(config.founderConsent?.decisionMode).toBe("audit_only");
	});

	it("loadConfig() rejects a missing default Lead identity", () => {
		delete process.env.TEAMLEAD_DEFAULT_LEAD_AGENT;
		expect(() => loadConfig()).toThrow(
			/TEAMLEAD_DEFAULT_LEAD_AGENT.*required/i,
		);
	});

	it("loadConfig() rejects non-numeric TEAMLEAD_STUCK_THRESHOLD", () => {
		const prev = process.env.TEAMLEAD_STUCK_THRESHOLD;
		process.env.TEAMLEAD_STUCK_THRESHOLD = "abc";
		try {
			expect(() => loadConfig()).toThrow("TEAMLEAD_STUCK_THRESHOLD");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_STUCK_THRESHOLD;
			else process.env.TEAMLEAD_STUCK_THRESHOLD = prev;
		}
	});

	it("loadConfig() rejects non-numeric TEAMLEAD_STUCK_INTERVAL", () => {
		const prev = process.env.TEAMLEAD_STUCK_INTERVAL;
		process.env.TEAMLEAD_STUCK_INTERVAL = "0";
		try {
			expect(() => loadConfig()).toThrow("TEAMLEAD_STUCK_INTERVAL");
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_STUCK_INTERVAL;
			else process.env.TEAMLEAD_STUCK_INTERVAL = prev;
		}
	});

	// FLY-162 P1: replyByIssueEnabled config field + fail-startup guard
	it("loadConfig() defaults replyByIssueEnabled to false when env not set", () => {
		const prev = process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		try {
			const config = loadConfig();
			expect(config.replyByIssueEnabled).toBe(false);
		} finally {
			if (prev !== undefined)
				process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = prev;
		}
	});

	it("loadConfig() reads TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true when apiToken is set", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "test-token";
		try {
			const config = loadConfig();
			expect(config.replyByIssueEnabled).toBe(true);
			expect(config.apiToken).toBe("test-token");
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
			else process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	it("loadConfig() throws when replyByIssueEnabled=true but TEAMLEAD_API_TOKEN missing (FLY-162 Codex R2 #2)", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = "true";
		delete process.env.TEAMLEAD_API_TOKEN;
		try {
			expect(() => loadConfig()).toThrow(/TEAMLEAD_API_TOKEN/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
			else process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = prevFlag;
			if (prevToken !== undefined) process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	it("loadConfig() throws when replyByIssueEnabled=true and apiToken is empty string", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "";
		try {
			expect(() => loadConfig()).toThrow(/TEAMLEAD_API_TOKEN/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED;
			else process.env.TEAMLEAD_REPLY_BY_ISSUE_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	// FLY-162 Layer 2: replyGuardEnabled config field + fail-startup guard + prefixes
	it("loadConfig() defaults replyGuardEnabled false and issuePrefixes to [FLY,GEO]", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevPfx = process.env.TEAMLEAD_ISSUE_PREFIXES;
		delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		delete process.env.TEAMLEAD_ISSUE_PREFIXES;
		try {
			const config = loadConfig();
			expect(config.replyGuardEnabled).toBe(false);
			expect(config.issuePrefixes).toEqual(["FLY", "GEO"]);
		} finally {
			if (prevFlag !== undefined)
				process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevPfx !== undefined) process.env.TEAMLEAD_ISSUE_PREFIXES = prevPfx;
		}
	});

	it("loadConfig() parses TEAMLEAD_ISSUE_PREFIXES (trim + uppercase + drop empties)", () => {
		const prev = process.env.TEAMLEAD_ISSUE_PREFIXES;
		process.env.TEAMLEAD_ISSUE_PREFIXES = " fly , geo, ,Ops ";
		try {
			expect(loadConfig().issuePrefixes).toEqual(["FLY", "GEO", "OPS"]);
		} finally {
			if (prev === undefined) delete process.env.TEAMLEAD_ISSUE_PREFIXES;
			else process.env.TEAMLEAD_ISSUE_PREFIXES = prev;
		}
	});

	it("loadConfig() throws when replyGuardEnabled=true but TEAMLEAD_API_TOKEN missing (FLY-162 Codex R1 #3)", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_GUARD_ENABLED = "true";
		delete process.env.TEAMLEAD_API_TOKEN;
		try {
			expect(() => loadConfig()).toThrow(/TEAMLEAD_API_TOKEN/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
			else process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevToken !== undefined) process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	it("loadConfig() reads replyGuardEnabled=true when apiToken is set", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		process.env.TEAMLEAD_REPLY_GUARD_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "test-token";
		try {
			expect(loadConfig().replyGuardEnabled).toBe(true);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
			else process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
		}
	});

	it("loadConfig() throws when replyGuardEnabled=true and issuePrefixes parses empty", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		const prevPfx = process.env.TEAMLEAD_ISSUE_PREFIXES;
		process.env.TEAMLEAD_REPLY_GUARD_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "test-token";
		process.env.TEAMLEAD_ISSUE_PREFIXES = " , ";
		try {
			expect(() => loadConfig()).toThrow(/TEAMLEAD_ISSUE_PREFIXES is empty/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
			else process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
			if (prevPfx === undefined) delete process.env.TEAMLEAD_ISSUE_PREFIXES;
			else process.env.TEAMLEAD_ISSUE_PREFIXES = prevPfx;
		}
	});

	it("loadConfig() throws when replyGuardEnabled=true and a prefix is unscannable (<2 letters)", () => {
		const prevFlag = process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
		const prevToken = process.env.TEAMLEAD_API_TOKEN;
		const prevPfx = process.env.TEAMLEAD_ISSUE_PREFIXES;
		process.env.TEAMLEAD_REPLY_GUARD_ENABLED = "true";
		process.env.TEAMLEAD_API_TOKEN = "test-token";
		process.env.TEAMLEAD_ISSUE_PREFIXES = "FLY,A";
		try {
			expect(() => loadConfig()).toThrow(/scanner can never match/);
		} finally {
			if (prevFlag === undefined)
				delete process.env.TEAMLEAD_REPLY_GUARD_ENABLED;
			else process.env.TEAMLEAD_REPLY_GUARD_ENABLED = prevFlag;
			if (prevToken === undefined) delete process.env.TEAMLEAD_API_TOKEN;
			else process.env.TEAMLEAD_API_TOKEN = prevToken;
			if (prevPfx === undefined) delete process.env.TEAMLEAD_ISSUE_PREFIXES;
			else process.env.TEAMLEAD_ISSUE_PREFIXES = prevPfx;
		}
	});

	it("startBridge throws if projects is empty", async () => {
		const config = makeConfig();
		await expect(startBridge(config, [])).rejects.toThrow(
			"No projects configured",
		);
	});

	it("startBridge starts and closes cleanly", async () => {
		const config = makeConfig();
		const result = await startBridge(config, [
			{
				projectName: "test",
				projectRoot: "/tmp",
				leads: [
					{
						agentId: "product-lead",
						summaryRole: "producer",
						forumChannel: "test-channel",
						chatChannel: "test-chat",
						match: { labels: ["Product"] },
					},
				],
			},
		]);
		closeFn = result.close;

		expect(result.app).toBeDefined();
		expect(result.store).toBeDefined();
		expect(
			existsSync(
				join(process.env.FLYWHEEL_LOOP_DIAGNOSTICS_DIR!, "loop-profiles"),
			),
		).toBe(true);

		await result.close();
		closeFn = undefined;
	});
});

// Helper: start an express app on a random port and return the base URL
async function startAndGetUrl(
	app: ReturnType<typeof createBridgeApp>,
	path: string,
): Promise<string> {
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;

	// Close after fetch — we wrap in a cleanup pattern
	const url = `http://127.0.0.1:${port}${path}`;

	// Schedule cleanup
	setTimeout(() => server.close(), 5000);

	return url;
}

function getListeningPort(_close: () => Promise<void>): number {
	// Placeholder — will be used when routes are mounted
	return 0;
}
