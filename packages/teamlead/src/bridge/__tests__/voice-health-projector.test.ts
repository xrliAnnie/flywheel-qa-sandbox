import { type ChildProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	createVoiceHealthBridgeGuard,
	createVoiceHealthProjector,
	type VoiceHealthExport,
} from "../voice-health-projector.js";

let store: StateStore;
let root: string;

const SOURCE = "10000000-0000-4000-8000-000000000001";
const projection = {
	serviceId: "a".repeat(64),
	serviceLabel: "com.flywheel.voice",
	generation: 1,
	bootId: "20000000-0000-4000-8000-000000000002",
	observationSeq: 2,
	phase: "idle",
	demandSourceId: "30000000-0000-4000-8000-000000000003",
	demandRevision: 1,
	demandState: "required",
	demandDigest: "b".repeat(64),
	demandObservedAt: "2026-09-18T20:00:00.000Z",
	demandIdentities: [],
	demandEventCursor: 1,
	demandEventHighWater: 1,
	demandHasMore: false,
	bootAt: "2026-09-18T19:59:00.000Z",
	lastIterationSuccessAt: "2026-09-18T20:00:01.000Z",
	lastProgressAt: "2026-09-18T20:00:01.000Z",
	successCount: 1,
	progressCount: 0,
	failureCount: 0,
	failureStreak: 0,
	firstFailureAt: null,
	lastFailureAt: null,
	reasonClass: null,
	operation: null,
	durationMs: null,
	pollEpisodeId: null,
	sessionEpisodeId: null,
	sourceStatus: "available",
	openEpisodes: [],
	activeNotifications: [],
};

function exported(input: Partial<VoiceHealthExport> = {}): VoiceHealthExport {
	return {
		schemaVersion: 1,
		sourceId: SOURCE,
		serviceId: "a".repeat(64),
		serviceLabel: "com.flywheel.voice",
		eventHighWater: 2,
		changes: [
			{
				changeSeq: 1,
				observationSeq: 1,
				changedAt: "2026-09-18T20:00:00.000Z",
				projection,
			},
			{
				changeSeq: 2,
				observationSeq: 2,
				changedAt: "2026-09-18T20:00:01.000Z",
				projection,
			},
		],
		hasMore: false,
		nextCursor: 2,
		currentProjection: projection,
		openEpisodes: [],
		openEpisodesTruncated: false,
		notifications: [],
		notificationsTruncated: false,
		...input,
	};
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "voice-health-projector-"));
	store = await StateStore.create(join(root, "teamlead.db"));
});

afterEach(() => {
	store.close();
	rmSync(root, { recursive: true, force: true });
});

describe("voice health projector", () => {
	it("projects a rejected paged demand digest mismatch as unknown instead of dormant", async () => {
		const helperPath = fileURLToPath(
			new URL("../../../../../scripts/lib/voice-health.py", import.meta.url),
		);
		const digest = (identities: unknown[]) =>
			createHash("sha256").update(JSON.stringify(identities)).digest("hex");
		const helper = (command: string, payload: unknown) =>
			spawnSync(
				"python3",
				[helperPath, "--state-root", join(root, "health"), command],
				{ input: JSON.stringify(payload), encoding: "utf8" },
			);
		const payload = {
			demandSourceId: SOURCE,
			revision: 0,
			digest: digest([]),
			state: "none",
			observedAt: "2026-09-18T20:00:00.000Z",
			identities: [],
			refreshObservedAt: true,
			pageAfterCursor: 0,
			pageNextCursor: 0,
			eventHighWater: 0,
			hasMore: false,
			gap: false,
			events: [],
		};
		expect(helper("record-demand", payload).status).toBe(0);
		const projector = createVoiceHealthProjector({
			store,
			readExport: async (afterCursor) =>
				JSON.parse(helper("export", { afterCursor }).stdout),
			requestRefresh: vi.fn(),
		});
		await projector.tick();
		expect(store.getVoiceHealthProjection("flywheel").status).toBe("dormant");
		const identities = [{ demandId: "meeting-1" }];
		const rejected = helper("record-demand", {
			...payload,
			identities,
			digest: digest(identities),
			state: "required",
		});
		expect(rejected.status).toBe(2);
		expect(rejected.stderr).toContain("demand_source_mismatch");
		await projector.tick();
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			status: "unknown",
			demandState: "unknown",
		});
		expect(helper("record-demand", payload).status).toBe(0);
		await projector.tick();
		expect(store.getVoiceHealthProjection("flywheel").status).toBe("dormant");
	}, 20_000);

	it("evaluates elapsed failures and records a stable startup-not-ready attempt", async () => {
		store.reserveVoiceSession({
			sessionId: "40000000-0000-4000-8000-000000000004",
			mode: "meeting",
			projectName: "flywheel",
			leadId: "lead-a",
			guildId: "100000000000000001",
			voiceBotUserId: "100000000000000005",
			voiceChannelId: "100000000000000002",
			meetingId: "meeting-1",
			requestedBy: "master",
			credentialTier: "master",
			createdAt: "2026-09-18T19:58:00.000Z",
		});
		const invocations: Array<{ command: string; payload: unknown }> = [];
		const execFile = vi.fn(
			(
				_file: string,
				args: string[],
				_options: unknown,
				callback: (error: Error | null, stdout: string, stderr: string) => void,
			) => {
				const child = new EventEmitter() as ChildProcess;
				child.stdin = new EventEmitter() as ChildProcess["stdin"];
				Object.assign(child.stdin!, {
					once: child.stdin!.once.bind(child.stdin),
					end: (encoded: string) => {
						const command = args.at(-1)!;
						invocations.push({ command, payload: JSON.parse(encoded) });
						callback(
							null,
							command === "evaluate"
								? '{"status":"no_action"}'
								: `{"status":"recorded","notification":{"intentId":"${"d".repeat(64)}"}}`,
							"",
						);
					},
				});
				return child;
			},
		);
		const guard = createVoiceHealthBridgeGuard({
			store,
			helperPath: "/trusted/voice-health.py",
			stateRoot: root,
			execFile,
			now: () => new Date("2026-09-18T20:00:00.000Z"),
		});

		await expect(guard(exported())).resolves.toEqual(["d".repeat(64)]);
		expect(invocations).toEqual([
			{
				command: "evaluate",
				payload: { observedAt: "2026-09-18T20:00:00.000Z" },
			},
			{
				command: "record-startup",
				payload: {
					startupAttemptId: "40000000-0000-4000-8000-000000000004",
					demandId: "meeting-1",
					observedAt: "2026-09-18T19:59:00.000Z",
					reasonClass: "startup_not_ready",
					operation: "startup",
				},
			},
		]);
	});

	// FLY-2693 review R5 (warming-lease-suppresses-startup-guard), per plan
	// section 3: a claim or lease renewal cannot extend the startup boundary.
	// A leased claimed/warming session is excused only inside
	// createdAt + 60s + 60s presence grace; past that it is still not live and
	// opens startup_not_ready at the plan's createdAt + 60s threshold.
	it.each([
		["claimed", "2026-09-18T19:59:30.000Z", []],
		["warming", "2026-09-18T19:59:30.000Z", []],
		["claimed", "2026-09-18T20:00:00.000Z", ["record-startup"]],
		["warming", "2026-09-18T20:00:00.000Z", ["record-startup"]],
	] as const)(
		"reports a leased %s session as startup_not_ready only past the grace cap (now=%s)",
		async (state, nowIso, expectedStartupCalls) => {
			const sessionId = "41000000-0000-4000-8000-000000000004";
			store.reserveVoiceSession({
				sessionId,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceBotUserId: "100000000000000005",
				voiceChannelId: "100000000000000002",
				meetingId: "meeting-1",
				requestedBy: "master",
				credentialTier: "master",
				createdAt: "2026-09-18T19:58:00.000Z",
			});
			store.updateVoiceProvisioning({
				sessionId,
				expectedStep: "reserved",
				nextStep: "done",
				nextState: "desired",
				updatedAt: "2026-09-18T19:59:45.000Z",
			});
			const claim = store.claimVoiceSession({
				sessionId,
				daemonBootId: "daemon-a",
				now: "2026-09-18T19:59:50.000Z",
				leaseTtlMs: 60_000,
			});
			expect(claim).toBeDefined();
			if (state === "warming") {
				expect(
					store.setVoiceSessionState({
						sessionId,
						leaseToken: claim!.leaseToken,
						state,
						now: "2026-09-18T19:59:51.000Z",
					}),
				).toBe(true);
			}
			const invocations: string[] = [];
			const execFile = vi.fn(
				(
					_file: string,
					args: string[],
					_options: unknown,
					callback: (
						error: Error | null,
						stdout: string,
						stderr: string,
					) => void,
				) => {
					const child = new EventEmitter() as ChildProcess;
					child.stdin = new EventEmitter() as ChildProcess["stdin"];
					Object.assign(child.stdin!, {
						once: child.stdin!.once.bind(child.stdin),
						end: () => {
							invocations.push(args.at(-1)!);
							callback(null, '{"status":"no_action"}', "");
						},
					});
					return child;
				},
			);
			const payloads: Array<Record<string, unknown>> = [];
			const guard = createVoiceHealthBridgeGuard({
				store,
				helperPath: "/trusted/voice-health.py",
				stateRoot: root,
				execFile: vi.fn(
					(
						file: string,
						args: string[],
						options: unknown,
						callback: (
							error: Error | null,
							stdout: string,
							stderr: string,
						) => void,
					) => {
						const child = execFile(file, args, options, callback);
						const end = child.stdin!.end as unknown as (input: string) => void;
						Object.assign(child.stdin!, {
							end: (input: string) => {
								if (args.at(-1) === "record-startup")
									payloads.push(JSON.parse(input));
								end(input);
							},
						});
						return child;
					},
				),
				now: () => new Date(nowIso),
			});

			await expect(guard(exported())).resolves.toEqual([]);
			expect(invocations).toEqual(["evaluate", ...expectedStartupCalls]);
			expect(payloads).toEqual(
				expectedStartupCalls.map(() => ({
					startupAttemptId: sessionId,
					demandId: "meeting-1",
					observedAt: "2026-09-18T19:59:00.000Z",
					reasonClass: "startup_not_ready",
					operation: "startup",
				})),
			);
		},
	);

	// FLY-2701 review R3: a booked meeting is reserved two minutes early and
	// stays warming, ready and mute until its own time. Judging it by the
	// instant-session 60s+60s rule fires startup_not_ready at exactly T for
	// every scheduled meeting — a false alarm on the working path.
	it.each([
		["2026-09-18T20:05:00.000Z", [] as string[]],
		["2026-09-18T20:10:00.001Z", ["record-startup"]],
	] as const)(
		"excuses a ready prewarmed meeting until its presence deadline (now=%s)",
		async (nowIso, expectedStartupCalls) => {
			const scheduleId = "50000000-0000-4000-8000-000000000005";
			const sessionId = "41000000-0000-4000-8000-000000000009";
			store.createVoiceSchedule({
				scheduleId,
				requestKey: "master:req-1",
				requestDigest: "digest-1",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceChannelId: "100000000000000002",
				voiceBotUserId: "100000000000000005",
				evidenceDir: "/tmp/evidence",
				scheduledAt: "2026-09-18T20:00:00.000Z",
				prewarmAt: "2026-09-18T19:58:00.000Z",
				readyDeadlineAt: "2026-09-18T20:00:00.000Z",
				presenceDeadlineAt: "2026-09-18T20:10:00.000Z",
				requestedBy: "master",
				credentialTier: "master",
				createdAt: "2026-09-18T19:58:00.000Z",
			});
			store.reserveVoiceSession({
				sessionId,
				mode: "meeting",
				projectName: "flywheel",
				leadId: "lead-a",
				guildId: "100000000000000001",
				voiceBotUserId: "100000000000000005",
				voiceChannelId: "100000000000000002",
				meetingId: "meeting-9",
				requestedBy: "master",
				credentialTier: "master",
				createdAt: "2026-09-18T19:58:00.000Z",
				scheduleId,
				scheduleRevision: 1,
				notBeforeLiveAt: "2026-09-18T20:00:00.000Z",
				presenceDeadlineAt: "2026-09-18T20:10:00.000Z",
			});
			store.attachVoiceScheduleSession({
				scheduleId,
				expectedRevision: 1,
				sessionId,
				updatedAt: "2026-09-18T19:58:00.000Z",
			});
			store.updateVoiceProvisioning({
				sessionId,
				expectedStep: "reserved",
				nextStep: "done",
				nextState: "desired",
				updatedAt: "2026-09-18T19:58:10.000Z",
			});
			const claim = store.claimVoiceSession({
				sessionId,
				daemonBootId: "daemon-b",
				now: "2026-09-18T19:58:20.000Z",
				leaseTtlMs: 30 * 60_000,
			});
			expect(claim).toBeDefined();
			expect(
				store.setVoiceSessionState({
					sessionId,
					leaseToken: claim!.leaseToken,
					state: "warming",
					now: "2026-09-18T19:58:21.000Z",
				}),
			).toBe(true);
			expect(
				store.markVoiceSessionReady({
					sessionId,
					scheduleRevision: 1,
					readyAt: "2026-09-18T19:59:00.000Z",
				}),
			).toBe("ready");

			const invocations: string[] = [];
			const guard = createVoiceHealthBridgeGuard({
				store,
				helperPath: "/trusted/voice-health.py",
				stateRoot: root,
				execFile: vi.fn(
					(
						_file: string,
						args: string[],
						_options: unknown,
						callback: (
							error: Error | null,
							stdout: string,
							stderr: string,
						) => void,
					) => {
						const child = new EventEmitter() as ChildProcess;
						child.stdin = new EventEmitter() as ChildProcess["stdin"];
						Object.assign(child.stdin!, {
							once: child.stdin!.once.bind(child.stdin),
							end: () => {
								invocations.push(args.at(-1)!);
								callback(null, '{"status":"no_action"}', "");
							},
						});
						return child;
					},
				),
				now: () => new Date(nowIso),
			});

			await expect(guard(exported())).resolves.toEqual([]);
			expect(invocations).toEqual(["evaluate", ...expectedStartupCalls]);
		},
	);

	it("imports bootstrap evidence only for one authoritative demand and ignores lock contention", async () => {
		store.reserveVoiceSession({
			sessionId: "70000000-0000-4000-8000-000000000007",
			mode: "meeting",
			projectName: "flywheel",
			leadId: "lead-a",
			guildId: "100000000000000001",
			voiceBotUserId: "100000000000000005",
			voiceChannelId: "100000000000000002",
			meetingId: "meeting-1",
			requestedBy: "master",
			credentialTier: "master",
			createdAt: "2026-09-18T19:59:30.000Z",
		});
		const invocations: Array<{ command: string; payload: unknown }> = [];
		const execFile = vi.fn(
			(
				_file: string,
				args: string[],
				_options: unknown,
				callback: (error: Error | null, stdout: string, stderr: string) => void,
			) => {
				const child = new EventEmitter() as ChildProcess;
				child.stdin = new EventEmitter() as ChildProcess["stdin"];
				Object.assign(child.stdin!, {
					once: child.stdin!.once.bind(child.stdin),
					end: (encoded: string) => {
						const command = args.at(-1)!;
						invocations.push({ command, payload: JSON.parse(encoded) });
						callback(null, '{"status":"recorded"}', "");
					},
				});
				return child;
			},
		);
		const guard = createVoiceHealthBridgeGuard({
			store,
			helperPath: "/trusted/voice-health.py",
			stateRoot: root,
			execFile,
			now: () => new Date("2026-09-18T20:00:00.000Z"),
			readStartupEvents: async () => [
				{
					startupAttemptId: "50000000-0000-4000-8000-000000000005",
					observedAt: "2026-09-18T19:59:40.000Z",
					reasonClass: "startup_config_invalid",
					operation: "startup",
				},
				{
					startupAttemptId: "60000000-0000-4000-8000-000000000006",
					observedAt: "2026-09-18T19:59:41.000Z",
					reasonClass: "startup_lock_unavailable",
					operation: "startup",
				},
			],
		});
		const currentProjection = {
			...projection,
			demandIdentities: [
				{
					demandId: "meeting-1",
					attemptId: "70000000-0000-4000-8000-000000000007",
					projectId: "flywheel",
				},
			],
		};

		await guard(exported({ currentProjection }));
		expect(invocations).toEqual([
			{
				command: "evaluate",
				payload: { observedAt: "2026-09-18T20:00:00.000Z" },
			},
			{
				command: "record-startup",
				payload: {
					startupAttemptId: "50000000-0000-4000-8000-000000000005",
					observedAt: "2026-09-18T19:59:40.000Z",
					reasonClass: "startup_config_invalid",
					operation: "startup",
					demandId: "meeting-1",
				},
			},
		]);
	});

	it("drains every page and applies only the final authoritative projection", async () => {
		const first = exported({
			changes: [exported().changes[0]!],
			hasMore: true,
			nextCursor: 1,
			currentProjection: undefined,
			openEpisodes: undefined,
			openEpisodesTruncated: undefined,
			notifications: undefined,
			notificationsTruncated: undefined,
		});
		const readExport = vi
			.fn<(cursor: number) => Promise<VoiceHealthExport>>()
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(exported({ changes: [exported().changes[1]!] }));
		const refresh = vi.fn();
		const projector = createVoiceHealthProjector({
			store,
			readExport,
			requestRefresh: refresh,
		});

		await projector.tick();
		expect(readExport.mock.calls.map(([cursor]) => cursor)).toEqual([0, 1]);
		expect(store.getVoiceHealthProjectionCursor()).toMatchObject({
			sourceId: SOURCE,
			cursor: 2,
			status: "complete",
		});
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			status: "healthy",
			demandState: "required",
			lastIterationSuccessAt: "2026-09-18T20:00:01.000Z",
		});
		expect(refresh).toHaveBeenCalledWith("flywheel", "voice_health_changed");
	});

	it("checkpoints an incomplete drain so a backlog beyond the page cap makes progress", async () => {
		const readExport = vi.fn(
			async (cursor: number): Promise<VoiceHealthExport> => {
				const nextCursor = cursor + 1;
				const hasMore = nextCursor < 33;
				return exported({
					eventHighWater: 33,
					changes: [
						{
							changeSeq: nextCursor,
							observationSeq: nextCursor,
							changedAt: "2026-09-18T20:00:01.000Z",
							projection,
						},
					],
					hasMore,
					nextCursor,
					currentProjection: hasMore ? undefined : projection,
					openEpisodes: hasMore ? undefined : [],
					openEpisodesTruncated: hasMore ? undefined : false,
					notifications: hasMore ? undefined : [],
					notificationsTruncated: hasMore ? undefined : false,
				});
			},
		);
		const log = vi.fn();
		const projector = createVoiceHealthProjector({
			store,
			readExport,
			requestRefresh: vi.fn(),
			log,
		});

		await projector.tick();
		expect(readExport).toHaveBeenCalledTimes(32);
		expect(store.getVoiceHealthProjectionCursor()).toMatchObject({
			sourceId: SOURCE,
			cursor: 32,
			status: "unavailable",
		});
		expect(log).toHaveBeenCalledWith(
			"[voice-health-projector] source unavailable: voice_health_export_page_limit",
		);

		await projector.tick();
		expect(readExport).toHaveBeenLastCalledWith(32, SOURCE);
		expect(store.getVoiceHealthProjectionCursor()).toMatchObject({
			sourceId: SOURCE,
			cursor: 33,
			status: "complete",
		});
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			status: "healthy",
			lastIterationSuccessAt: "2026-09-18T20:00:01.000Z",
		});
	});

	it("projects a fault, dispatches only a retryable intent, and preserves it on read failure", async () => {
		const episode = {
			episodeId: "c".repeat(64),
			scope: "poll_dependency",
			demandSourceId: null,
			sourceStatus: "verified",
			demandId: null,
			attemptId: null,
			openedAt: "2026-09-18T20:00:00.000Z",
			reasonClass: "bridge_timeout_headers",
			threshold: "three_consecutive_failures",
			closedAt: null,
			closeReason: null,
		};
		const notifications = [
			{
				intentId: "d".repeat(64),
				episodeId: episode.episodeId,
				routeKey: "primary",
				bindingDigest: null,
				bindingState: "unresolved",
				state: "queued_transient",
				attemptCount: 1,
				channelId: null,
				messageId: null,
			},
			{
				intentId: "e".repeat(64),
				episodeId: "f".repeat(64),
				routeKey: "primary",
				bindingDigest: "a".repeat(64),
				bindingState: "resolved",
				state: "delivery_unknown",
				attemptCount: 1,
				channelId: "123456789012345678",
				messageId: null,
			},
		];
		const notify = vi.fn();
		const readExport = vi
			.fn<(cursor: number) => Promise<VoiceHealthExport>>()
			.mockResolvedValueOnce(
				exported({
					currentProjection: {
						...projection,
						phase: "failed_retrying",
						failureStreak: 3,
						openEpisodes: [episode],
						activeNotifications: notifications,
					},
					openEpisodes: [episode],
					notifications,
				}),
			)
			.mockRejectedValueOnce(new Error("health_store_unavailable"));
		const projector = createVoiceHealthProjector({
			store,
			readExport,
			requestRefresh: vi.fn(),
			notifyIntent: notify,
		});
		await projector.tick();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("d".repeat(64));
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			status: "unhealthy",
			failureStreak: 3,
		});

		await projector.tick();
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			sourceStatus: "unavailable",
			status: "unhealthy",
			activeIncidents: [
				expect.objectContaining({ reasonClass: "bridge_timeout_headers" }),
			],
		});
	});

	it("bounds active incidents to the epic page schema and marks the view truncated", async () => {
		const openEpisodes = Array.from({ length: 33 }, (_, index) => ({
			episodeId: String(index + 1).padStart(64, "0"),
			scope: "session_unavailable",
			demandSourceId: SOURCE,
			sourceStatus: "verified",
			demandId: `manual-${index + 1}`,
			attemptId: null,
			openedAt: "2026-09-18T20:00:00.000Z",
			reasonClass: "session_runtime_failed",
			threshold: "terminal_session_failure",
			closedAt: null,
			closeReason: null,
		}));
		const projector = createVoiceHealthProjector({
			store,
			readExport: async () => exported({ openEpisodes }),
			requestRefresh: vi.fn(),
		});

		await projector.tick();
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			sourceStatus: "truncated",
			status: "unhealthy",
		});
		expect(
			store.getVoiceHealthProjection("flywheel").activeIncidents,
		).toHaveLength(32);
	});

	it("rebases a replacement source at zero without erasing an old unresolved fault", async () => {
		const incident = {
			scope: "poll_dependency" as const,
			openedAt: "2026-09-18T19:59:00.000Z",
			reasonClass: "bridge_connect_failed" as const,
			threshold: "three_consecutive_failures" as const,
			deliveryState: "sent" as const,
		};
		store.applyVoiceHealthProjection({
			sourceId: SOURCE,
			cursor: 2,
			status: "complete",
			view: {
				schemaVersion: 1,
				sourceStatus: "complete",
				observedAt: "2026-09-18T20:00:00.000Z",
				status: "unhealthy",
				demandState: "required",
				phase: "failed_retrying",
				lastIterationSuccessAt: null,
				lastProgressAt: null,
				failureStreak: 3,
				activeIncidents: [incident],
			},
			now: "2026-09-18T20:00:00.000Z",
		});
		const nextSource = "80000000-0000-4000-8000-000000000008";
		const readExport = vi
			.fn<(cursor: number, sourceId?: string) => Promise<VoiceHealthExport>>()
			.mockRejectedValueOnce(new Error("source_mismatch"))
			.mockResolvedValueOnce(
				exported({
					sourceId: nextSource,
					eventHighWater: 0,
					changes: [],
					nextCursor: 0,
				}),
			);
		const projector = createVoiceHealthProjector({
			store,
			readExport,
			requestRefresh: vi.fn(),
		});

		await projector.tick();
		expect(readExport.mock.calls).toEqual([
			[2, SOURCE],
			[0, undefined],
		]);
		expect(store.getVoiceHealthProjection("flywheel")).toMatchObject({
			sourceStatus: "unavailable",
			status: "unhealthy",
			activeIncidents: [incident],
		});
	});

	it("never paints unknown demand green", async () => {
		const projector = createVoiceHealthProjector({
			store,
			readExport: async () =>
				exported({
					currentProjection: {
						...projection,
						demandState: "unknown",
						sourceStatus: "unverified",
					},
				}),
			requestRefresh: vi.fn(),
		});
		await projector.tick();
		expect(store.getVoiceHealthProjection("flywheel").status).toBe("unknown");
	});
});
