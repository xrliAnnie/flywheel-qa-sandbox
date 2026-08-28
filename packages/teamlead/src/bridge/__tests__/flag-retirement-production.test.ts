import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { AUTOMATED_MESSAGE_PREFIX } from "../automated-message.js";
import {
	createProductionFlagScanEffects,
	deliverFlagScanMailboxAlert,
	reportFlagScanOwnerResolution,
	resolveFlagScanOwner,
	resolveFlagScanOwnerStatus,
} from "../flag-retirement-production.js";

const CASS_ID = "1516205086890786917";
const TADASHI_ID = "1516207680836866219";
const INFRA_ID = "1516205086890786999";
const NOTIFY_ID = "1516209289406971999";
const GENERAL_CHANNEL_ID = "1516209289406971965";

function lead(
	agentId: string,
	department?: string,
	overrides: Partial<ProjectEntry["leads"][number]> = {},
): ProjectEntry["leads"][number] {
	return {
		agentId,
		summaryRole: "producer",
		chatChannel: GENERAL_CHANNEL_ID,
		match: { labels: [agentId] },
		department,
		...overrides,
	};
}

function cass() {
	return lead("flywheel-cos-lead", undefined, {
		summaryRole: "aggregator",
		botUserId: CASS_ID,
		canSpawnRunners: false,
	});
}

function tadashi() {
	return lead("flywheel-eng-lead", "engineering", {
		botUserId: TADASHI_ID,
		chatChannel: "1516209714097291335",
	});
}

function project(
	leads: ProjectEntry["leads"],
	projectName = "Flywheel",
): ProjectEntry {
	return {
		projectName,
		projectRoot: "/tmp/flywheel",
		generalChannel: GENERAL_CHANNEL_ID,
		leads,
	};
}

function ackedSettlement() {
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
}

function accessJson() {
	return JSON.stringify({
		allowBots: [INFRA_ID],
		groups: { [NOTIFY_ID]: { requireMention: true, mentionPatterns: [] } },
	});
}

function baseOptions(overrides: Record<string, unknown> = {}) {
	return {
		projects: [project([tadashi(), cass()], "flywheel")],
		reportBaseUrl: "https://reports.test",
		reportToken: "report-token",
		store: {
			listFlagScanRuns: () => [],
			getFlagScanRunLegs: () => [],
		} as never,
		env: {
			CLAUDE_INFRA_BOT_TOKEN: "infra-token",
			FLYWHEEL_NOTIFY_CHANNEL: NOTIFY_ID,
		} as NodeJS.ProcessEnv,
		identityHomeDir: "/identity-home",
		accessFileReader: () => accessJson(),
		now: () => Date.parse("2026-08-23T15:00:00.000Z"),
		enqueueLeadInbox: () => ({
			queued: true as const,
			deliveryId: "mailbox-1",
		}),
		inspectLeadInbox: () => ackedSettlement(),
		leadRecipientState: () => "alive" as const,
		...overrides,
	};
}

function fetchSequence(responses: Response[]) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
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
	return { fetchImpl: fetchImpl as typeof fetch, calls };
}

describe("FLY-2104 production owner resolution", () => {
	it("selects one Engineering Lead without coupling notification delivery to a Lead bot token", () => {
		expect(resolveFlagScanOwner([project([tadashi(), cass()])])).toMatchObject({
			leadId: "flywheel-eng-lead",
			senderLeadId: "flywheel-cos-lead",
		});
	});

	it("fails loud when the engineering owner is missing or ambiguous", () => {
		expect(() => resolveFlagScanOwner([project([cass()])])).toThrow(
			/exactly one Flywheel engineering Lead/,
		);
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

	it("keeps a Bridge that does not host Flywheel quiet", async () => {
		const alert = vi.fn().mockResolvedValue({ sent: true });
		const resolution = resolveFlagScanOwnerStatus([
			project([lead("test-lead", "engineering")], "test-slot-1"),
		]);
		expect(resolution).toEqual({ kind: "not_hosted" });
		await reportFlagScanOwnerResolution(resolution, { alert });
		expect(alert).not.toHaveBeenCalled();
	});

	it("reports invalid owner configuration through flag_scan_failed", async () => {
		const alert = vi.fn().mockResolvedValue({ queued: true });
		const resolution = resolveFlagScanOwnerStatus([project([cass()])]);
		await reportFlagScanOwnerResolution(resolution, { alert });
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "flag_scan_failed",
				projectName: "Flywheel",
				severity: "warning",
			}),
		);
	});

	it("settles no-clock notices only after the resolved Lead mailbox ACKs", async () => {
		const enqueueLeadInbox = vi.fn(() => ({
			queued: true as const,
			deliveryId: "no-clock-delivery",
		}));
		const effects = createProductionFlagScanEffects(
			baseOptions({ enqueueLeadInbox }) as never,
		);
		expect(
			await effects.notifyLead({
				runToken: "weekly-1",
				eventId: "clock-1",
				body: "clock debt",
				partIndex: 1,
				partCount: 1,
			}),
		).toMatchObject({ status: "done" });
		expect(enqueueLeadInbox).toHaveBeenCalledWith(
			"flywheel-eng-lead",
			expect.objectContaining({ eventType: "flag_scan_no_clock" }),
		);
	});
});

describe("FLY-2104 notification delivery", () => {
	it("keeps a queued primary handoff pending and falls back only when it is dead", () => {
		const enqueueLeadInbox = vi
			.fn()
			.mockReturnValueOnce({ queued: true, deliveryId: "primary" })
			.mockReturnValueOnce({ queued: true, deliveryId: "fallback" });
		const inspectLeadInbox = vi
			.fn()
			.mockReturnValueOnce({ kind: "live", state: "DEAD" })
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
			deliveryId: "fallback",
			recipient: "flywheel-cos-lead",
		});
	});

	it("posts exactly one zero-candidate line to #flywheel-notification with no result thread", async () => {
		const { fetchImpl, calls } = fetchSequence([
			new Response(JSON.stringify({ id: INFRA_ID }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-message" }), { status: 200 }),
			new Response(JSON.stringify({ archived: true }), { status: 200 }),
			new Response(null, { status: 204 }),
			new Response(JSON.stringify({ id: "zero-root" }), { status: 200 }),
		]);
		const effects = createProductionFlagScanEffects(
			baseOptions({ fetchImpl }) as never,
		);
		const result = await effects.postDiscord({
			runToken: "weekly-zero",
			body: "本周 0 候选",
		});
		expect(result).toMatchObject({ status: "done" });
		const root = calls.at(-1)!;
		expect(root.url).toContain(`/channels/${NOTIFY_ID}/messages`);
		expect(root.body).toMatchObject({
			content: expect.stringContaining("本周 0 候选"),
			allowed_mentions: { parse: [] },
		});
		expect(String((root.body as { content: string }).content)).toContain(
			"flywheel:flag-governance run=weekly-zero",
		);
		// The only thread request belongs to the disposable permission probe.
		expect(calls.filter(({ url }) => url.endsWith("/threads"))).toHaveLength(1);
	});

	it("runs canonical flywheel-comm publish-report --no-screenshot for candidates, then creates the handoff thread", async () => {
		const { fetchImpl, calls } = fetchSequence([
			new Response(JSON.stringify({ id: INFRA_ID }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-message" }), { status: 200 }),
			new Response(JSON.stringify({ archived: true }), { status: 200 }),
			new Response(null, { status: 204 }),
			new Response(JSON.stringify({ id: "candidate-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "handoff-1" }), { status: 200 }),
		]);
		const runCommand = vi.fn(async () => ({
			stdout: JSON.stringify({
				url: "https://reports.test/weekly",
				reportId: "report-1",
				messageId: "candidate-root",
				screenshot: null,
				delivered: true,
			}),
			stderr: "",
		}));
		const effects = createProductionFlagScanEffects(
			baseOptions({
				fetchImpl,
				runCommand,
				commCliPath: "/repo/packages/flywheel-comm/dist/index.js",
			}) as never,
		);
		const result = await effects.publishReport({
			runToken: "weekly-one",
			title: "flag 周扫描 · 1 个候选",
			html: "<!doctype html><title>scan</title>",
		});
		expect(result).toMatchObject({ status: "done" });
		const [, args, options] = runCommand.mock.calls[0]!;
		expect(args).toEqual(
			expect.arrayContaining([
				"/repo/packages/flywheel-comm/dist/index.js",
				"publish-report",
				"--project",
				"flywheel",
				"--channel",
				NOTIFY_ID,
				"--no-screenshot",
			]),
		);
		expect(args).not.toContain("--issue");
		expect(args.join(" ")).toContain("flywheel:flag-governance run=weekly-one");
		expect(options.env).toMatchObject({
			FLYWHEEL_BRIDGE_URL: "https://reports.test",
			TEAMLEAD_API_TOKEN: "report-token",
		});
		expect(calls[6]!.url).toContain(
			`/channels/${NOTIFY_ID}/messages/candidate-root/threads`,
		);
		const handoff = calls[7]!.body as {
			content: string;
			allowed_mentions: { users: string[] };
		};
		expect(handoff.content.startsWith(AUTOMATED_MESSAGE_PREFIX)).toBe(true);
		expect(handoff.content).toContain(`<@${TADASHI_ID}>`);
		expect(handoff.allowed_mentions.users).toEqual([TADASHI_ID]);
	});

	it("fails before Discord writes when call-time access lacks the notification group", async () => {
		const { fetchImpl, calls } = fetchSequence([
			new Response(JSON.stringify({ id: INFRA_ID }), { status: 200 }),
		]);
		const effects = createProductionFlagScanEffects(
			baseOptions({
				fetchImpl,
				accessFileReader: () =>
					JSON.stringify({ allowBots: [INFRA_ID], groups: {} }),
			}) as never,
		);
		await expect(
			effects.postDiscord({ runToken: "weekly-1", body: "本周 0 候选" }),
		).rejects.toThrow(/notification group/);
		expect(calls).toHaveLength(1);
	});

	it("re-reads call-time access and sender identity while reusing a 21-day permission probe", async () => {
		const now = Date.parse("2026-08-23T15:00:00.000Z");
		const accessPath =
			"/identity-home/.claude/channels/discord-flywheel-eng-lead/access.json";
		const fingerprint = createHash("sha256")
			.update([NOTIFY_ID, INFRA_ID, TADASHI_ID, accessPath].join("\u001f"))
			.digest("hex");
		const { fetchImpl, calls } = fetchSequence([
			new Response(JSON.stringify({ id: INFRA_ID }), { status: 200 }),
			new Response(JSON.stringify({ id: "zero-root" }), { status: 200 }),
		]);
		const accessFileReader = vi.fn(() => accessJson());
		const effects = createProductionFlagScanEffects(
			baseOptions({
				fetchImpl,
				accessFileReader,
				now: () => now,
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
			}) as never,
		);
		expect(
			await effects.postDiscord({
				runToken: "weekly-two",
				body: "本周 0 候选",
			}),
		).toMatchObject({ status: "done" });
		expect(calls).toHaveLength(2);
		expect(calls[0]!.url).toContain("/users/@me");
		expect(accessFileReader).toHaveBeenCalledTimes(1);
	});

	it("never degrades a failed candidate delivery into a settled visible leg", async () => {
		const { fetchImpl } = fetchSequence([
			new Response(JSON.stringify({ id: INFRA_ID }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-root" }), { status: 200 }),
			new Response(JSON.stringify({ id: "probe-message" }), { status: 200 }),
			new Response(JSON.stringify({ archived: true }), { status: 200 }),
			new Response(null, { status: 204 }),
		]);
		const effects = createProductionFlagScanEffects(
			baseOptions({
				fetchImpl,
				runCommand: async () => ({
					stdout: JSON.stringify({
						url: "https://reports.test/weekly",
						messageId: null,
						delivered: false,
						error: "deliver failed",
					}),
					stderr: "",
				}),
			}) as never,
		);
		expect(
			await effects.publishReport({
				runToken: "weekly-failed",
				title: "scan",
				html: "<p>scan</p>",
			}),
		).toMatchObject({ status: "ambiguous" });
	});
});

describe("FLY-2104 production reconcile", () => {
	it("adopts a zero-candidate root without creating a thread or mailbox handoff", async () => {
		const { fetchImpl, calls } = fetchSequence([
			new Response(JSON.stringify({ id: INFRA_ID }), { status: 200 }),
			new Response(
				JSON.stringify([
					{
						id: "zero-root",
						content: "`flywheel:flag-governance run=weekly-zero`",
						timestamp: "2026-08-23T15:00:00.000Z",
					},
				]),
				{ status: 200 },
			),
		]);
		const enqueueLeadInbox = vi.fn();
		const effects = createProductionFlagScanEffects(
			baseOptions({
				fetchImpl,
				enqueueLeadInbox,
				store: {
					getFlagScanRunByToken: () => ({ runId: 1, candidateCount: 0 }),
					getFlagScanRunLegs: () => [],
					listFlagScanRuns: () => [],
				} as never,
			}) as never,
		);
		expect(
			await effects.reconcileDiscord({
				runToken: "weekly-zero",
				createdAfter: 0,
			}),
		).toMatchObject({ status: "found" });
		expect(calls).toHaveLength(2);
		expect(enqueueLeadInbox).not.toHaveBeenCalled();
	});

	it("keeps a candidate root pending while the Engineering Lead mailbox is queued", async () => {
		const { fetchImpl } = fetchSequence([
			new Response(JSON.stringify({ id: INFRA_ID }), { status: 200 }),
			new Response(
				JSON.stringify([
					{
						id: "candidate-root",
						content: "`flywheel:flag-governance run=weekly-one`",
						timestamp: "2026-08-23T15:00:00.000Z",
					},
				]),
				{ status: 200 },
			),
			new Response(JSON.stringify({ id: "candidate-root" }), { status: 200 }),
			new Response(JSON.stringify([]), { status: 200 }),
			new Response(JSON.stringify({ id: "handoff-1" }), { status: 200 }),
		]);
		const enqueueLeadInbox = vi.fn(() => ({
			queued: true as const,
			deliveryId: "primary-delivery",
		}));
		const effects = createProductionFlagScanEffects(
			baseOptions({
				fetchImpl,
				enqueueLeadInbox,
				inspectLeadInbox: () => ({ kind: "live", state: "QUEUED" }),
				store: {
					getFlagScanRunByToken: () => ({ runId: 1, candidateCount: 1 }),
					getFlagScanRunLegs: () => [],
					listFlagScanRuns: () => [],
				} as never,
			}) as never,
		);
		expect(
			await effects.reconcileDiscord({
				runToken: "weekly-one",
				createdAfter: 0,
			}),
		).toMatchObject({ status: "pending" });
		expect(enqueueLeadInbox).toHaveBeenCalledWith(
			"flywheel-eng-lead",
			expect.any(Object),
		);
	});
});
