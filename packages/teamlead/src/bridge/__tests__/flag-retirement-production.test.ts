import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { AUTOMATED_MESSAGE_PREFIX } from "../automated-message.js";
import {
	createProductionFlagScanEffects,
	deliverFlagScanMailboxAlert,
	FLYWHEEL_CORE_CHANNEL_ID,
	findLinearBatch,
	reportFlagScanOwnerResolution,
	resolveFlagScanOwner,
	resolveFlagScanOwnerStatus,
} from "../flag-retirement-production.js";

const CASS_ID = "1516205086890786917";
const TADASHI_ID = "1516207680836866219";

function project(
	leads: ProjectEntry["leads"],
	projectName = "Flywheel",
): ProjectEntry {
	return {
		projectName,
		projectRoot: "/tmp/flywheel",
		generalChannel: FLYWHEEL_CORE_CHANNEL_ID,
		leads,
	};
}

function lead(
	agentId: string,
	department?: string,
	overrides: Partial<ProjectEntry["leads"][number]> = {},
): ProjectEntry["leads"][number] {
	return {
		agentId,
		summaryRole: "producer",
		chatChannel: FLYWHEEL_CORE_CHANNEL_ID,
		match: { labels: [agentId] },
		department,
		...overrides,
	};
}

function cass(): ProjectEntry["leads"][number] {
	return lead("flywheel-cos-lead", undefined, {
		summaryRole: "aggregator",
		botUserId: CASS_ID,
		botTokenEnv: "CASS_BOT_TOKEN",
		botToken: "cass-token",
		canSpawnRunners: false,
	});
}

function tadashi(): ProjectEntry["leads"][number] {
	return lead("flywheel-eng-lead", "engineering", {
		botUserId: TADASHI_ID,
		botTokenEnv: "TADASHI_BOT_TOKEN",
		botToken: "tadashi-token",
		chatChannel: "1516209714097291335",
	});
}

describe("FLY-1781 production owner resolution", () => {
	it("selects the one explicit Flywheel engineering Lead", () => {
		expect(
			resolveFlagScanOwner([
				project([tadashi(), cass(), lead("flywheel-product-lead", "product")]),
			]),
		).toMatchObject({
			leadId: "flywheel-eng-lead",
			senderLeadId: "flywheel-cos-lead",
		});
	});

	it("fails loud when the engineering owner is missing", () => {
		expect(() => resolveFlagScanOwner([project([cass()])])).toThrow(
			/exactly one Flywheel engineering Lead/,
		);
	});
	it("keeps a Bridge that does not host Flywheel quiet", async () => {
		const alert = vi.fn().mockResolvedValue({ sent: true });
		const resolution = resolveFlagScanOwnerStatus([
			project([lead("test-lead", "engineering")], "test-slot-1"),
		]);

		expect(resolution).toEqual({ kind: "not_hosted" });
		await reportFlagScanOwnerResolution(resolution, { alert });
		expect(alert).not.toHaveBeenCalled();
	});

	it.each([
		[
			"core channel drift",
			{
				...project([tadashi(), cass()]),
				generalChannel: "1516209289406971999",
			},
		],
		[
			"engineering Lead bot id missing",
			project([lead("flywheel-eng-lead", "engineering"), cass()]),
		],
		[
			"CoS token missing",
			project([
				tadashi(),
				lead("flywheel-cos-lead", undefined, {
					botUserId: CASS_ID,
					canSpawnRunners: false,
				}),
			]),
		],
		[
			"engineering owner ambiguous",
			project([
				lead("one", "engineering", { botUserId: TADASHI_ID }),
				lead("two", "engineering", {
					botUserId: "1516207680836866220",
				}),
				cass(),
			]),
		],
	] satisfies Array<[string, ProjectEntry]>)(
		"routes %s through the existing flag_scan_failed governance surface",
		async (_caseName, flywheelProject) => {
			const alert = vi.fn().mockResolvedValue({ queued: true });
			const resolution = resolveFlagScanOwnerStatus([flywheelProject]);

			expect(resolution).toMatchObject({
				kind: "invalid",
				project: { projectName: "Flywheel" },
			});
			await reportFlagScanOwnerResolution(resolution, { alert });
			expect(alert).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "flag_scan_failed",
					projectName: "Flywheel",
					severity: "warning",
				}),
			);
		},
	);

	it("fails loud when the engineering owner is ambiguous", () => {
		expect(() =>
			resolveFlagScanOwner([
				project([
					lead("one", "engineering", { botUserId: TADASHI_ID }),
					lead("two", "engineering", {
						botUserId: "1516207680836866220",
					}),
					cass(),
				]),
			]),
		).toThrow(/exactly one Flywheel engineering Lead/);
	});

	it("fails loud instead of falling back to a host bot when the core CoS sender is incomplete", () => {
		expect(() =>
			resolveFlagScanOwner([
				project([
					tadashi(),
					lead("flywheel-cos-lead", undefined, {
						botUserId: CASS_ID,
						canSpawnRunners: false,
					}),
				]),
			]),
		).toThrow(/CoS sender.*token/i);
	});

	it("settles no-clock notices only after the resolved Lead mailbox ACKs", async () => {
		const enqueueLeadInbox = vi.fn(() => ({
			queued: true as const,
			deliveryId: "no-clock-delivery",
		}));
		const effects = createProductionFlagScanEffects({
			projects: [project([tadashi(), cass()], "flywheel")],
			reportBaseUrl: "https://reports.test",
			store: {} as never,
			enqueueLeadInbox,
			inspectLeadInbox: (projectName, deliveryId) => {
				expect(projectName).toBe("flywheel");
				expect(deliveryId).toBe("no-clock-delivery");
				return {
					kind: "live" as const,
					state: "ACKED" as const,
					createdAt: "2026-08-23T15:00:01.000Z",
					deliveredAt: "2026-08-23T15:00:02.000Z",
					notifiedAt: null,
					settledAt: "2026-08-23T15:00:02.000Z",
					deadReason: null,
					lastError: null,
				};
			},
			leadRecipientState: () => "alive",
		});

		expect(
			await effects.notifyLead({
				eventId: "clock-1",
				body: "clock debt",
				partIndex: 1,
				partCount: 1,
			}),
		).toMatchObject({ status: "done" });
		expect(enqueueLeadInbox).toHaveBeenCalledWith(
			"flywheel-eng-lead",
			expect.objectContaining({
				projectName: "flywheel",
				leadId: "flywheel-eng-lead",
				eventType: "flag_scan_no_clock",
			}),
		);
	});
});

describe("FLY-1831 Discord founder delivery", () => {
	it("keeps a queued primary handoff pending when Lead liveness is unknown", () => {
		for (const leadRecipientState of [undefined, () => "unknown" as const]) {
			const enqueueLeadInbox = vi
				.fn()
				.mockReturnValueOnce({ queued: true, deliveryId: "primary-delivery" })
				.mockReturnValueOnce({ queued: true, deliveryId: "fallback-delivery" });
			const result = deliverFlagScanMailboxAlert({
				primaryLeadId: "flywheel-eng-lead",
				fallbackLeadId: "flywheel-cos-lead",
				projectName: "Flywheel",
				payloadFor: (leadId) => ({ leadId }) as never,
				enqueueLeadInbox,
				inspectLeadInbox: () => ({
					kind: "live",
					state: "QUEUED",
					createdAt: "2026-08-23T15:00:01.000Z",
					deliveredAt: null,
					notifiedAt: null,
					settledAt: null,
					deadReason: null,
					lastError: null,
				}),
				leadRecipientState,
			});

			expect(result).toEqual({
				done: false,
				deliveryId: "primary-delivery",
				recipient: "flywheel-eng-lead",
			});
			expect(enqueueLeadInbox).toHaveBeenCalledTimes(1);
		}
	});

	it("falls back when canonical Lead liveness is terminal or missing", () => {
		const enqueueLeadInbox = vi
			.fn()
			.mockReturnValueOnce({ queued: true, deliveryId: "primary-delivery" })
			.mockReturnValueOnce({ queued: true, deliveryId: "fallback-delivery" });
		const inspectLeadInbox = vi
			.fn()
			.mockReturnValueOnce({ kind: "live", state: "QUEUED" })
			.mockReturnValueOnce({ kind: "live", state: "ACKED" });

		expect(
			deliverFlagScanMailboxAlert({
				primaryLeadId: "flywheel-eng-lead",
				fallbackLeadId: "flywheel-cos-lead",
				projectName: "Flywheel",
				payloadFor: (leadId) => ({ leadId }) as never,
				enqueueLeadInbox,
				inspectLeadInbox: inspectLeadInbox as never,
				leadRecipientState: () => "terminal_or_missing",
			}),
		).toEqual({
			done: true,
			deliveryId: "fallback-delivery",
			recipient: "flywheel-cos-lead",
		});
		expect(enqueueLeadInbox).toHaveBeenNthCalledWith(
			2,
			"flywheel-cos-lead",
			expect.any(Object),
		);
	});

	it("uses the Cass identity, probes permissions, posts one root/thread/handoff, and settles only on mailbox ACK", async () => {
		const calls: Array<{ url: string; method: string; body: unknown }> = [];
		const responses = [
			new Response(JSON.stringify({ id: CASS_ID }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-message" }), { status: 200 }),
			new Response(JSON.stringify({ archived: true }), { status: 200 }),
			new Response(null, { status: 204 }),
			new Response(JSON.stringify({ id: "root-1" }), { status: 200 }),
			new Response(JSON.stringify({ id: "root-1" }), { status: 200 }),
			new Response(JSON.stringify({ id: "handoff-1" }), { status: 200 }),
		];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init) => {
			calls.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			});
			const response = responses.shift();
			if (!response) throw new Error("unexpected Discord request");
			return response;
		});
		const accessFileReader = vi.fn(() =>
			JSON.stringify({
				allowBots: [CASS_ID],
				groups: {
					[FLYWHEEL_CORE_CHANNEL_ID]: {
						requireMention: true,
						mentionPatterns: [],
					},
				},
			}),
		);
		const enqueueLeadInbox = vi.fn(() => ({
			queued: true as const,
			deliveryId: "infra_alert:flywheel-eng-lead:flag_scan_handoff:weekly-1",
		}));
		const effects = createProductionFlagScanEffects({
			projects: [project([tadashi(), cass()], "flywheel")],
			reportBaseUrl: "https://reports.test",
			store: {
				listFlagScanRuns: () => [],
				getFlagScanRunLegs: () => [],
			} as never,
			fetchImpl: fetchImpl as typeof fetch,
			identityHomeDir: "/identity-home",
			accessFileReader,
			now: () => Date.parse("2026-08-23T15:00:00.000Z"),
			enqueueLeadInbox,
			inspectLeadInbox: () => ({
				kind: "live" as const,
				state: "ACKED" as const,
				settledAt: "2026-08-23T15:00:02.000Z",
				deadReason: null,
				lastError: null,
				createdAt: "2026-08-23T15:00:01.000Z",
				deliveredAt: "2026-08-23T15:00:02.000Z",
				notifiedAt: null,
			}),
			leadRecipientState: () => "alive",
		});

		const result = await effects.postDiscord({
			runToken: "weekly-1",
			body: "本周 0 个候选\nhttps://reports.test/weekly\n`flywheel:flag-governance run=weekly-1`",
		});

		expect(result.status).toBe("done");
		expect(
			JSON.parse("evidence" in result ? result.evidence : "{}"),
		).toMatchObject({
			rootMessageId: "root-1",
			threadId: "root-1",
			handoffMessageId: "handoff-1",
			inboxRecipient: "flywheel-eng-lead",
		});
		expect(accessFileReader).toHaveBeenCalledWith(
			"/identity-home/.claude/channels/discord-flywheel-eng-lead/access.json",
		);
		expect(enqueueLeadInbox).toHaveBeenCalledWith(
			"flywheel-eng-lead",
			expect.objectContaining({
				eventType: "flag_scan_handoff",
				body: expect.stringContaining("root-1"),
			}),
		);
		const root = calls[6]!.body as {
			content: string;
			allowed_mentions: { parse: string[] };
		};
		expect(root.content.startsWith(AUTOMATED_MESSAGE_PREFIX)).toBe(true);
		expect(root.content).toContain("flywheel:flag-governance run=weekly-1");
		expect(root.allowed_mentions).toEqual({ parse: [] });
		const handoff = calls[8]!.body as {
			content: string;
			allowed_mentions: { parse: string[]; users: string[] };
		};
		expect(handoff.content.startsWith(AUTOMATED_MESSAGE_PREFIX)).toBe(true);
		expect(handoff.content).toContain(`<@${TADASHI_ID}>`);
		expect(handoff.content).not.toContain(`<@${CASS_ID}>`);
		expect(handoff.allowed_mentions).toEqual({
			parse: [],
			users: [TADASHI_ID],
		});
	});

	it("fails closed before Discord I/O when canonical Lead access lacks the core group", async () => {
		const fetchImpl = vi.fn();
		const effects = createProductionFlagScanEffects({
			projects: [project([tadashi(), cass()], "flywheel")],
			reportBaseUrl: "https://reports.test",
			store: {} as never,
			fetchImpl: fetchImpl as never,
			identityHomeDir: "/identity-home",
			accessFileReader: () =>
				JSON.stringify({ allowBots: [CASS_ID], groups: {} }),
		});

		await expect(
			effects.postDiscord({ runToken: "weekly-1", body: "本周 0 个候选" }),
		).rejects.toThrow(/lacks the Flywheel core group/);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("reuses a matching successful permission probe for 21 days while still checking the sender token", async () => {
		const now = Date.parse("2026-08-23T15:00:00.000Z");
		const accessPath =
			"/identity-home/.claude/channels/discord-flywheel-eng-lead/access.json";
		const fingerprint = createHash("sha256")
			.update(
				[FLYWHEEL_CORE_CHANNEL_ID, CASS_ID, TADASHI_ID, accessPath].join(
					"\u001f",
				),
			)
			.digest("hex");
		const calls: Array<{ url: string; body?: string }> = [];
		const responses = [
			new Response(JSON.stringify({ id: CASS_ID }), { status: 200 }),
			new Response(JSON.stringify({ id: "root-2" }), { status: 200 }),
			new Response(JSON.stringify({ id: "root-2" }), { status: 200 }),
			new Response(JSON.stringify({ id: "handoff-2" }), { status: 200 }),
		];
		const fetchImpl = vi.fn(async (input: string | URL | Request, init) => {
			calls.push({ url: String(input), body: init?.body?.toString() });
			const response = responses.shift();
			if (!response) throw new Error("unexpected Discord request");
			return response;
		});
		const effects = createProductionFlagScanEffects({
			projects: [project([tadashi(), cass()], "flywheel")],
			reportBaseUrl: "https://reports.test",
			store: {
				listFlagScanRuns: () => [{ runId: 1 }],
				getFlagScanRunLegs: () => [
					{
						leg: "discord",
						evidence: JSON.stringify({
							preflightAt: now - 20 * 24 * 60 * 60_000,
							preflightFingerprint: fingerprint,
							preflightSucceeded: true,
						}),
					},
				],
			} as never,
			fetchImpl: fetchImpl as typeof fetch,
			identityHomeDir: "/identity-home",
			accessFileReader: () =>
				JSON.stringify({
					allowBots: [CASS_ID],
					groups: { [FLYWHEEL_CORE_CHANNEL_ID]: {} },
				}),
			now: () => now,
			enqueueLeadInbox: () => ({ queued: true, deliveryId: "mailbox-2" }),
			inspectLeadInbox: () => ({
				kind: "live" as const,
				state: "ACKED" as const,
				createdAt: "2026-08-23T15:00:01.000Z",
				deliveredAt: "2026-08-23T15:00:02.000Z",
				notifiedAt: null,
				settledAt: "2026-08-23T15:00:02.000Z",
				deadReason: null,
				lastError: null,
			}),
			leadRecipientState: () => "alive",
		});

		expect(
			await effects.postDiscord({
				runToken: "weekly-2",
				body: "本周 0 个候选",
			}),
		).toMatchObject({ status: "done" });
		expect(calls).toHaveLength(4);
		expect(calls[0]!.url).toContain("/users/@me");
		expect(calls.some(({ body }) => body?.includes("permission probe"))).toBe(
			false,
		);
	});
});

describe("FLY-1781 production reconcile", () => {
	it("adopts a Linear batch when the exact run marker appears anywhere in the body", async () => {
		const client = {
			issues: async () => ({
				nodes: [
					{
						description:
							"\n<!-- flywheel:flag-governance run=weekly-1 -->\nledger",
						url: "https://linear.test/FLY-1",
					},
				],
				pageInfo: { hasNextPage: false },
			}),
		};
		expect(
			await findLinearBatch({
				client: client as never,
				teamId: "team-1",
				runToken: "weekly-1",
				createdAfter: 0,
			}),
		).toEqual({ status: "found", evidence: "https://linear.test/FLY-1" });
	});

	it("keeps a visible Discord root pending while the live Tadashi mailbox is queued", async () => {
		const marker = "`flywheel:flag-governance run=weekly-1`";
		const handoffMarker = "`flywheel:flag-governance handoff run=weekly-1`";
		const responses = [
			new Response(
				JSON.stringify([
					{
						id: "root-1",
						content: marker,
						timestamp: "2026-08-23T15:00:00.000Z",
					},
				]),
				{ status: 200 },
			),
			new Response(JSON.stringify({ code: 160004 }), { status: 400 }),
			new Response(
				JSON.stringify({ id: "root-1", parent_id: FLYWHEEL_CORE_CHANNEL_ID }),
				{ status: 200 },
			),
			new Response(
				JSON.stringify([{ id: "handoff-1", content: handoffMarker }]),
				{ status: 200 },
			),
		];
		const fetchImpl = vi.fn(async () => {
			const response = responses.shift();
			if (!response) throw new Error("unexpected Discord request");
			return response;
		});
		const enqueueLeadInbox = vi.fn(() => ({
			queued: true as const,
			deliveryId: "primary-delivery",
		}));
		const effects = createProductionFlagScanEffects({
			projects: [project([tadashi(), cass()], "flywheel")],
			reportBaseUrl: "https://reports.test",
			store: {
				listFlagScanRuns: () => [],
				getFlagScanRunLegs: () => [],
			} as never,
			fetchImpl: fetchImpl as typeof fetch,
			identityHomeDir: "/identity-home",
			accessFileReader: () =>
				JSON.stringify({
					allowBots: [CASS_ID],
					groups: { [FLYWHEEL_CORE_CHANNEL_ID]: {} },
				}),
			enqueueLeadInbox,
			inspectLeadInbox: () => ({
				kind: "live" as const,
				state: "QUEUED" as const,
				createdAt: "2026-08-23T15:00:01.000Z",
				deliveredAt: null,
				notifiedAt: null,
				settledAt: null,
				deadReason: null,
				lastError: null,
			}),
			leadRecipientState: () => "alive",
		});

		const result = await effects.reconcileDiscord({
			runToken: "weekly-1",
			createdAfter: Date.parse("2026-08-23T14:59:00.000Z"),
		});

		expect(result).toMatchObject({ status: "pending" });
		expect(enqueueLeadInbox).toHaveBeenCalledTimes(1);
		expect(enqueueLeadInbox).toHaveBeenCalledWith(
			"flywheel-eng-lead",
			expect.any(Object),
		);
	});

	it("falls back to Cass only after the Tadashi mailbox is dead", async () => {
		const responses = [
			new Response(
				JSON.stringify([
					{
						id: "root-1",
						content: "`flywheel:flag-governance run=weekly-1`",
						timestamp: "2026-08-23T15:00:00.000Z",
					},
				]),
				{ status: 200 },
			),
			new Response(JSON.stringify({ code: 160004 }), { status: 400 }),
			new Response(
				JSON.stringify({ id: "root-1", parent_id: FLYWHEEL_CORE_CHANNEL_ID }),
				{ status: 200 },
			),
			new Response(
				JSON.stringify([
					{
						id: "handoff-1",
						content: "`flywheel:flag-governance handoff run=weekly-1`",
					},
				]),
				{ status: 200 },
			),
		];
		const fetchImpl = vi.fn(async () => {
			const response = responses.shift();
			if (!response) throw new Error("unexpected Discord request");
			return response;
		});
		const enqueueLeadInbox = vi
			.fn()
			.mockReturnValueOnce({ queued: true, deliveryId: "primary-delivery" })
			.mockReturnValueOnce({ queued: true, deliveryId: "fallback-delivery" });
		const inspectLeadInbox = vi
			.fn()
			.mockReturnValueOnce({
				kind: "live",
				state: "DEAD",
				createdAt: "2026-08-23T15:00:01.000Z",
				deliveredAt: null,
				notifiedAt: null,
				settledAt: "2026-08-23T15:00:02.000Z",
				deadReason: "recipient unavailable",
				lastError: null,
			})
			.mockReturnValueOnce({
				kind: "live",
				state: "ACKED",
				createdAt: "2026-08-23T15:00:02.000Z",
				deliveredAt: "2026-08-23T15:00:03.000Z",
				notifiedAt: null,
				settledAt: "2026-08-23T15:00:03.000Z",
				deadReason: null,
				lastError: null,
			});
		const effects = createProductionFlagScanEffects({
			projects: [project([tadashi(), cass()], "flywheel")],
			reportBaseUrl: "https://reports.test",
			store: {
				listFlagScanRuns: () => [],
				getFlagScanRunLegs: () => [],
			} as never,
			fetchImpl: fetchImpl as typeof fetch,
			identityHomeDir: "/identity-home",
			accessFileReader: () =>
				JSON.stringify({
					allowBots: [CASS_ID],
					groups: { [FLYWHEEL_CORE_CHANNEL_ID]: {} },
				}),
			enqueueLeadInbox,
			inspectLeadInbox: inspectLeadInbox as never,
			leadRecipientState: () => "alive",
		});

		const result = await effects.reconcileDiscord({
			runToken: "weekly-1",
			createdAfter: Date.parse("2026-08-23T14:59:00.000Z"),
		});

		expect(result).toMatchObject({ status: "found" });
		expect(enqueueLeadInbox).toHaveBeenNthCalledWith(
			1,
			"flywheel-eng-lead",
			expect.any(Object),
		);
		expect(enqueueLeadInbox).toHaveBeenNthCalledWith(
			2,
			"flywheel-cos-lead",
			expect.any(Object),
		);
	});
});
