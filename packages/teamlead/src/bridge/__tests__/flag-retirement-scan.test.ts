import type { FeatureFlagSpec, FlagView } from "flywheel-config";
import { FLAG_SCAN_INTERVAL_MS } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FlagProvenanceInput, StateStore } from "../../StateStore.js";
import {
	createFlagRetirementScanner,
	FLAG_SCAN_LEASE_MS,
	FLAG_SCAN_MAX_PENDING_AGE_MS,
	FLAG_SCAN_VISIBILITY_FENCE_MS,
	type FlagRetirementScanEffects,
	flagScanIsDue,
	latestFlagScanSlotAtOrBefore,
	renderLeadAlertChunks,
} from "../flag-retirement-scan.js";

const SUNDAY_0800_PDT = Date.parse("2026-08-16T15:00:00.000Z");

function spec(overrides: Partial<FeatureFlagSpec> = {}): FeatureFlagSpec {
	return {
		name: "weekly_candidate",
		category: "feature",
		source: "env",
		scope: "bridge_global",
		envVar: "TEST_WEEKLY_CANDIDATE",
		polarity: "opt_in",
		valueKind: "bool",
		default: false,
		description: "candidate description",
		readSites: [
			{
				file: "test.ts",
				symbol: "test",
				pattern: "process.env",
				timing: "call_time",
			},
		],
		toggleable: "readonly",
		...overrides,
	};
}

function view(
	flag: FeatureFlagSpec,
	overrides: Partial<FlagView> = {},
): FlagView {
	return {
		name: flag.name,
		category: flag.category,
		description: flag.description,
		toggleable: flag.toggleable,
		valueKind: flag.valueKind,
		scope: flag.scope,
		source: flag.source,
		envVar: flag.envVar,
		readTimings: ["call_time"],
		default: flag.default,
		effective: flag.default,
		displayEffective: flag.default,
		...overrides,
	};
}

function provenance(flagName: string): FlagProvenanceInput {
	return {
		flagName,
		incarnationCommit: "abc123",
		status: "resolved",
		sourceIssue: "FLY-1",
		author: "Tadashi",
		committedAt: 1,
		prNumber: 10,
	};
}

function effects() {
	const reports: string[] = [];
	const discordBodies: string[] = [];
	const leadBodies: string[] = [];
	const value: FlagRetirementScanEffects = {
		publishReport: vi.fn(async ({ html }) => {
			reports.push(html);
			return {
				status: "done" as const,
				evidence: JSON.stringify({
					reportUrl: "https://reports.invalid/weekly",
					rootMessageId: "discord-message-1",
					threadId: "discord-message-1",
					handoffMessageId: "handoff-1",
					inboxDeliveryId: "inbox-1",
				}),
			};
		}),
		postDiscord: vi.fn(async ({ body }) => {
			discordBodies.push(body);
			return { status: "done" as const, evidence: "discord-message-1" };
		}),
		reconcileDiscord: vi.fn(async () => ({ status: "missing" as const })),
		notifyLead: vi.fn(async ({ body }) => {
			leadBodies.push(body);
			return { status: "done" as const, evidence: "receipt-1" };
		}),
	};
	return { value, reports, discordBodies, leadBodies };
}

describe("FlagRetirementScanner", () => {
	let store: StateStore;
	let now: number;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		now = SUNDAY_0800_PDT;
	});

	afterEach(() => store.close());

	function scanner(
		input: {
			flag?: FeatureFlagSpec;
			flagView?: FlagView;
			effectSet?: ReturnType<typeof effects>;
			loadProvenance?: () => Promise<FlagProvenanceInput[]>;
			projectNames?: string[];
			loadSources?: () => Promise<{
				rows: Array<{ spec: FeatureFlagSpec; view: FlagView }>;
				expectedProjectNames: string[];
			}>;
			alertFailure?: (message: string) => Promise<void>;
			recoverFailureAlerts?: () => void;
			tokenPrefix?: string;
			enabled?: () => boolean;
		} = {},
	) {
		const flag = input.flag ?? spec();
		const effectSet = input.effectSet ?? effects();
		let token = 0;
		return {
			effectSet,
			value: createFlagRetirementScanner({
				store,
				loadSources:
					input.loadSources ??
					(async () => ({
						rows: [{ spec: flag, view: input.flagView ?? view(flag) }],
						expectedProjectNames: input.projectNames ?? [],
					})),
				loadProvenance:
					input.loadProvenance ?? (async () => [provenance(flag.name)]),
				effects: effectSet.value,
				alertFailure: input.alertFailure ?? (async () => undefined),
				recoverFailureAlerts: input.recoverFailureAlerts,
				now: () => now,
				newRunToken: () => `${input.tokenPrefix ?? "run"}-${++token}`,
				leaseOwner: `${input.tokenPrefix ?? "worker"}-owner`,
				enabled: input.enabled ?? (() => true),
			}),
		};
	}

	it("anchors the schedule to Sunday 08:00 America/Los_Angeles across PST and PDT", () => {
		expect(
			latestFlagScanSlotAtOrBefore(Date.parse("2026-01-11T15:59:59.999Z")),
		).toBe(Date.parse("2026-01-04T16:00:00.000Z"));
		expect(
			latestFlagScanSlotAtOrBefore(Date.parse("2026-01-11T16:00:00.000Z")),
		).toBe(Date.parse("2026-01-11T16:00:00.000Z"));
		expect(
			latestFlagScanSlotAtOrBefore(Date.parse("2026-08-16T14:59:59.999Z")),
		).toBe(Date.parse("2026-08-09T15:00:00.000Z"));
		expect(latestFlagScanSlotAtOrBefore(SUNDAY_0800_PDT)).toBe(SUNDAY_0800_PDT);
		expect(flagScanIsDue(SUNDAY_0800_PDT, SUNDAY_0800_PDT - 1)).toBe(true);
		expect(flagScanIsDue(SUNDAY_0800_PDT, SUNDAY_0800_PDT)).toBe(false);
	});

	it("runs immediately on an empty DB, posts one zero-candidate Discord line, then waits for the next Sunday slot", async () => {
		const run = scanner();
		expect(await run.value.scanIfDue()).toMatchObject({ status: "published" });
		expect(store.listFlagScanRuns()).toHaveLength(1);
		expect(store.getFlagScanState()[0]).toMatchObject({ streakSamples: 1 });
		expect(run.effectSet.reports).toEqual([]);
		expect(run.effectSet.discordBodies).toEqual(["本周 0 候选"]);
		expect(store.getFlagScanRunLegs(1)).toMatchObject([
			{ leg: "discord", status: "done" },
		]);

		now += FLAG_SCAN_INTERVAL_MS - 1;
		expect(await run.value.scanIfDue()).toEqual({ status: "not_due" });
		expect(store.listFlagScanRuns()).toHaveLength(1);
	});

	it("forces a real enabled run outside the weekly due slot", async () => {
		const run = scanner();
		expect(await run.value.scanIfDue()).toMatchObject({ status: "published" });
		now += 1;

		expect(await run.value.runNow()).toMatchObject({ status: "published" });
		expect(store.listFlagScanRuns()).toHaveLength(2);
		expect(run.effectSet.value.publishReport).not.toHaveBeenCalled();
		expect(run.effectSet.value.postDiscord).toHaveBeenCalledTimes(2);
		expect(await run.value.scanIfDue()).toEqual({ status: "not_due" });
	});

	it("single-flights manual and scheduled entrypoints on one scanner instance", async () => {
		const run = scanner();
		const outcomes = await Promise.all([
			run.value.runNow(),
			run.value.scanIfDue(),
		]);

		expect(outcomes).toEqual([
			expect.objectContaining({ status: "published", runId: 1 }),
			expect.objectContaining({ status: "published", runId: 1 }),
		]);
		expect(outcomes).not.toContainEqual({ status: "lost_race" });
		expect(store.listFlagScanRuns()).toHaveLength(1);
	});

	it("queues a manual force behind an in-flight scheduled scan instead of returning the scheduled outcome", async () => {
		const flag = spec();
		let sourceCalls = 0;
		let releaseFirst!: () => void;
		const firstSource = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const run = scanner({
			flag,
			loadSources: async () => {
				sourceCalls += 1;
				if (sourceCalls === 1) await firstSource;
				return {
					rows: [{ spec: flag, view: view(flag) }],
					expectedProjectNames: [],
				};
			},
		});

		const scheduled = run.value.scanIfDue();
		await vi.waitFor(() => expect(sourceCalls).toBe(1));
		const forced = run.value.runNow();
		releaseFirst();

		expect(await scheduled).toMatchObject({ status: "published", runId: 1 });
		expect(await forced).toMatchObject({ status: "published", runId: 2 });
		expect(sourceCalls).toBe(2);
		expect(store.listFlagScanRuns()).toHaveLength(2);
	});

	it("budgets the visible-leg lease above the publish child and bounded Discord calls", () => {
		expect(FLAG_SCAN_LEASE_MS).toBeGreaterThanOrEqual(5 * 60_000);
	});

	it("makes one weekly batch under two overlapping scanner instances", async () => {
		const sharedEffects = effects();
		const first = scanner({ effectSet: sharedEffects, tokenPrefix: "first" });
		await first.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		const second = scanner({ effectSet: sharedEffects, tokenPrefix: "second" });
		await Promise.all([first.value.scanIfDue(), second.value.scanIfDue()]);
		expect(store.listFlagScanRuns()).toHaveLength(2);
		expect(sharedEffects.value.publishReport).toHaveBeenCalledTimes(1);
		expect(sharedEffects.value.postDiscord).toHaveBeenCalledTimes(1);
		expect(sharedEffects.discordBodies).toEqual(["本周 0 候选"]);
		expect(sharedEffects.reports[0]).toContain("复制全部");
		expect(sharedEffects.reports[0]).toContain("本报告的 Discord 结果 thread");
		expect(sharedEffects.reports[0]).not.toContain("连续两次采样相同");
		expect(sharedEffects.reports[0]).toContain(
			'<script nonce="__CSP_NONCE__">',
		);
		expect(store.getFlagScanRunLegs(2).map(({ leg }) => leg)).toEqual([
			"discord",
		]);
	});

	it("shows the description, current enum winner, and stable duration on the Discord report", async () => {
		const flag = spec({
			name: "enum_fixture",
			valueKind: "enum",
			enumValues: ["legacy", "superpowers"],
			default: "superpowers",
			description: "Chooses which issue-gate implementation wins.",
		});
		const run = scanner({ flag });
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		await run.value.scanIfDue();

		expect(run.effectSet.reports[0]).toContain(
			"<dt>人话说明</dt><dd>Chooses which issue-gate implementation wins.</dd>",
		);
		expect(run.effectSet.reports[0]).toContain(
			"<dt>当前值</dt><dd><code>&quot;superpowers&quot;</code></dd>",
		);
		expect(run.effectSet.reports[0]).toContain(
			"<dt>稳定时长</dt><dd>7 天</dd>",
		);
		expect(run.effectSet.reports[0]).toContain(
			'data-digest="d06521a37b86b643b498019b11be0b5eb275b94eb339afb475937c93d9f3b6c7"',
		);
		expect(run.effectSet.reports[0]).toContain('" | canonicalDigest: "+digest');
	});

	it("reconciles a crash-left failure mailbox intent at the scheduled tick entry", async () => {
		const intent = store.ensureFlagScanFailureAlertIntent({
			baselineRunId: 0,
			failureClass: "provenance",
			milestone: "initial",
			eventId: "flag-scan-failed:0:provenance:initial",
			now: 500,
		});
		const recoverFailureAlerts = vi.fn(() => {
			expect(
				store.claimFlagScanFailureAlertIntent({
					intentId: intent.intentId,
					leaseOwner: "mailbox-recovery",
					now,
					leaseMs: 1,
				}),
			).toBe(true);
			expect(
				store.settleFlagScanFailureMailboxIntent({
					intentId: intent.intentId,
					leaseOwner: "mailbox-recovery",
				}),
			).toBe(true);
		});
		const run = scanner({ recoverFailureAlerts });

		await run.value.scanIfDue();

		expect(recoverFailureAlerts).toHaveBeenCalledTimes(1);
		expect(store.getAlertDeliveryReceipt(intent.eventId)).toBeUndefined();
		expect(store.listFlagScanFailureAlertIntents()).toMatchObject([
			{
				state: "done",
				lastError: null,
			},
		]);
	});

	it("keeps the full verdict payload selectable when both copy mechanisms fail", async () => {
		const run = scanner();
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		await run.value.scanIfDue();

		const report = run.effectSet.reports[0];
		expect(report).toContain('<textarea id="copy-fallback"');
		expect(report).toContain(
			"浏览器不允许自动复制;下方文本已选中,请按 ⌘C 后贴到本报告的 Discord 结果 thread",
		);
		expect(report).toContain("fallback.value=text");
		expect(report).toContain("fallback.focus();fallback.select()");
		expect(report).toContain('document.execCommand("copy")');
	});

	it("fails closed before every scan/governance write when provenance cannot be proven", async () => {
		const alertFailure = vi.fn(async () => undefined);
		const run = scanner({
			loadProvenance: async () => {
				throw new Error("git timeout");
			},
			alertFailure,
		});
		expect(await run.value.scanIfDue()).toMatchObject({ status: "failed" });
		expect(store.listFlagScanRuns()).toEqual([]);
		expect(store.getFlagScanState()).toEqual([]);
		expect(store.getFlagKeepAnchors()).toEqual([]);
		expect(store.listFlagProvenance()).toEqual([]);
		expect(store.listFlagDepartures()).toEqual([]);
		expect(run.effectSet.reports).toEqual([]);
		expect(run.effectSet.discordBodies).toEqual([]);
		expect(alertFailure).toHaveBeenCalledWith(
			expect.stringContaining("git timeout"),
		);
	});

	it("dry-run renders a preview but performs zero DB or external writes", async () => {
		const run = scanner();
		const result = await run.value.dryRun();
		expect(result).toMatchObject({ status: "dry_run" });
		expect(store.listFlagScanRuns()).toEqual([]);
		expect(store.getFlagScanState()).toEqual([]);
		expect(run.effectSet.value.publishReport).not.toHaveBeenCalled();
		expect(run.effectSet.value.postDiscord).not.toHaveBeenCalled();
	});

	it("previews and publishes independent per-project stability without advancing it during dry-run", async () => {
		const flag = spec({
			name: "doc_flow",
			source: "project_config",
			scope: "project",
			configKey: "doc_flow.enabled",
		});
		const projectNames = ["alpha", "beta"];
		const run = scanner({
			flag,
			projectNames,
			flagView: view(flag, {
				effectiveByProject: [
					{ projectName: "alpha", value: true, via: "project_store" },
					{ projectName: "beta", value: false, via: "star_store" },
				],
			}),
		});
		await run.value.scanIfDue();
		expect(store.getFlagScanScopeState()).toMatchObject([
			{ flagName: "doc_flow", scope: "alpha", streakSamples: 1 },
			{ flagName: "doc_flow", scope: "beta", streakSamples: 1 },
		]);

		now += FLAG_SCAN_INTERVAL_MS;
		const preview = await run.value.dryRun();
		if (preview.status !== "dry_run")
			throw new Error("expected dry-run preview");
		expect(preview.html).toContain(
			"<dt>逐项目稳定</dt><dd>alpha: 7 天 · beta: 7 天</dd>",
		);
		expect(store.getFlagScanScopeState()).toMatchObject([
			{ scope: "alpha", streakSamples: 1 },
			{ scope: "beta", streakSamples: 1 },
		]);

		await run.value.scanIfDue();
		expect(run.effectSet.reports[0]).toContain(
			"<dt>逐项目稳定</dt><dd>alpha: 7 天 · beta: 7 天</dd>",
		);
		expect(store.getFlagScanScopeState()).toMatchObject([
			{ scope: "alpha", streakSamples: 2 },
			{ scope: "beta", streakSamples: 2 },
		]);
	});

	it("dry-run failure remains zero-write and does not emit an external alert", async () => {
		const alertFailure = vi.fn(async () => undefined);
		const run = scanner({
			loadProvenance: async () => {
				throw new Error("dry-run git timeout");
			},
			alertFailure,
		});
		expect(await run.value.dryRun()).toMatchObject({ status: "failed" });
		expect(alertFailure).not.toHaveBeenCalled();
		expect(store.listFlagScanRuns()).toEqual([]);
	});

	it("the kill switch disables manual, scheduled, dry-run, and pending recovery entrypoints", async () => {
		const run = scanner({ enabled: () => false });
		expect(await run.value.runNow()).toEqual({ status: "disabled" });
		expect(await run.value.scanIfDue()).toEqual({ status: "disabled" });
		expect(await run.value.dryRun()).toEqual({ status: "disabled" });
		expect(store.listFlagScanRuns()).toEqual([]);
	});

	it("routes no-clock debt to the engineering Lead while posting the zero-candidate Discord line", async () => {
		const flag = spec();
		const run = scanner({
			flag,
			flagView: view(flag, {
				displayEffective: undefined,
				divergence: "source_unavailable",
			}),
		});
		await run.value.scanIfDue();
		expect(run.effectSet.leadBodies).toHaveLength(1);
		expect(run.effectSet.leadBodies[0]).toContain("判据不可用");
		expect(run.effectSet.reports).toEqual([]);
		expect(run.effectSet.discordBodies).toEqual(["本周 0 候选"]);
	});

	it("settles a permanently ambiguous run after 24h, rolls back an undelivered ask, and releases the next slot", async () => {
		const alertFailure = vi.fn(async () => undefined);
		const effectSet = effects();
		const run = scanner({ effectSet, alertFailure });
		await run.value.scanIfDue();

		now += FLAG_SCAN_INTERVAL_MS;
		effectSet.value.publishReport = vi.fn(async () => ({
			status: "ambiguous" as const,
		}));
		expect(await run.value.scanIfDue()).toMatchObject({ status: "pending" });
		expect(store.getFlagScanState()[0]).toMatchObject({ askCount: 1 });

		now += FLAG_SCAN_MAX_PENDING_AGE_MS;
		expect(await run.value.scanIfDue()).toMatchObject({ status: "published" });
		expect(store.getFlagScanState()[0]).toMatchObject({ askCount: 0 });
		expect(store.getFlagScanRunLegs(2)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ leg: "discord", status: "degraded" }),
			]),
		);
		expect(alertFailure).toHaveBeenCalledWith(
			expect.stringMatching(/stalled.*24h.*settled degraded/i),
		);

		now = Date.parse("2026-08-30T15:00:00.000Z");
		effectSet.value.publishReport = vi.fn(async ({ html }) => {
			effectSet.reports.push(html);
			return {
				status: "done" as const,
				evidence: JSON.stringify({
					rootMessageId: "root-3",
					threadId: "root-3",
				}),
			};
		});
		expect(await run.value.scanIfDue()).toMatchObject({ status: "published" });
		expect(store.listFlagScanRuns()).toHaveLength(3);
	});

	it("keeps askCount when root and thread reached the founder even if Lead inbox ACK is still pending", async () => {
		const effectSet = effects();
		const run = scanner({ effectSet });
		await run.value.scanIfDue();

		now += FLAG_SCAN_INTERVAL_MS;
		effectSet.value.publishReport = vi.fn(async () => ({
			status: "ambiguous" as const,
			evidence: JSON.stringify({
				rootMessageId: "root-2",
				threadId: "root-2",
				handoffMessageId: "handoff-2",
				inboxDeliveryId:
					"infra_alert:flywheel-eng-lead:flag_scan_handoff:run-2",
			}),
		}));
		expect(await run.value.scanIfDue()).toMatchObject({ status: "pending" });
		expect(store.getFlagScanState()[0]).toMatchObject({ askCount: 1 });

		now += FLAG_SCAN_MAX_PENDING_AGE_MS;
		expect(await run.value.scanIfDue()).toMatchObject({ status: "published" });
		expect(store.getFlagScanState()[0]).toMatchObject({ askCount: 1 });
		expect(store.getFlagScanRunLegs(2)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					leg: "discord",
					status: "degraded",
					evidence: expect.stringContaining("root-2"),
				}),
			]),
		);
	});

	it("keeps reconciling a visible Discord delivery without posting a duplicate root while mailbox ACK is pending", async () => {
		const effectSet = effects();
		const run = scanner({ effectSet });
		await run.value.scanIfDue();

		now += FLAG_SCAN_INTERVAL_MS;
		effectSet.value.publishReport = vi.fn(async () => ({
			status: "ambiguous" as const,
			evidence: JSON.stringify({
				rootMessageId: "root-2",
				threadId: "root-2",
				inboxDeliveryId: "primary-1",
			}),
		}));
		effectSet.value.reconcileDiscord = vi.fn(async () => ({
			status: "pending" as const,
			evidence: JSON.stringify({
				rootMessageId: "root-2",
				threadId: "root-2",
				handoffMessageId: "handoff-2",
				inboxDeliveryId: "primary-1",
			}),
		}));
		expect(await run.value.scanIfDue()).toMatchObject({ status: "pending" });

		now += FLAG_SCAN_VISIBILITY_FENCE_MS;
		expect(await run.value.scanIfDue()).toMatchObject({
			status: "pending",
		});
		expect(effectSet.value.reconcileDiscord).toHaveBeenCalledTimes(1);
		expect(effectSet.value.publishReport).toHaveBeenCalledTimes(1);
		expect(store.getFlagScanRunLegs(2)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					leg: "discord",
					status: "ambiguous",
					evidence: expect.stringContaining("handoff-2"),
					reconcileNotBefore: expect.any(Number),
				}),
			]),
		);
	});

	it("keeps a candidate run pending when its only founder-visible delivery degrades", async () => {
		const effectSet = effects();
		effectSet.value.publishReport = vi.fn(async () => ({
			status: "degraded" as const,
			evidence: "publish-report failed",
		}));
		const alertFailure = vi.fn(async () => undefined);
		const run = scanner({ effectSet, alertFailure });
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		expect(await run.value.scanIfDue()).toMatchObject({ status: "pending" });
		expect(store.getFlagScanRunLegs(2)).toMatchObject([
			expect.objectContaining({ leg: "discord", status: "ambiguous" }),
		]);
		expect(alertFailure).toHaveBeenCalledWith(
			expect.stringMatching(/visible delivery.*degraded/i),
		);
	});

	it("recovers a pending run before considering a new due scan", async () => {
		const effectSet = effects();
		let release: (() => void) | undefined;
		const run = scanner({ effectSet });
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		effectSet.value.publishReport = vi.fn(
			async () =>
				new Promise((resolve) => {
					release = () =>
						resolve({
							status: "done" as const,
							evidence: JSON.stringify({
								rootMessageId: "root-pending",
								threadId: "root-pending",
							}),
						});
				}),
		);
		const publishing = run.value.scanIfDue();
		await vi.waitFor(() => expect(store.getPendingFlagScanRun()).toBeDefined());
		const recovery = await run.value.scanIfDue();
		expect(recovery).toMatchObject({ status: "pending" });
		expect(store.listFlagScanRuns()).toHaveLength(2);
		release?.();
		await publishing;
	});

	it("alerts a reconcile failure without throwing away the pending run", async () => {
		const effectSet = effects();
		effectSet.value.publishReport = vi.fn(async () => ({
			status: "ambiguous" as const,
		}));
		effectSet.value.reconcileDiscord = vi.fn(async () => {
			throw new Error("Discord lookup unavailable");
		});
		const alertFailure = vi.fn(async () => undefined);
		const run = scanner({ effectSet, alertFailure });
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		expect(await run.value.scanIfDue()).toMatchObject({ status: "pending" });

		now += FLAG_SCAN_VISIBILITY_FENCE_MS;
		expect(await run.value.scanIfDue()).toMatchObject({
			status: "pending",
		});
		expect(alertFailure).toHaveBeenCalledWith(
			expect.stringMatching(
				/pending recovery.*discord.*Discord lookup unavailable/i,
			),
		);
		expect(store.getPendingFlagScanRun()).toBeDefined();
	});

	it("chunks oversized no-clock lines within the finished body budget", () => {
		const chunks = renderLeadAlertChunks(
			{ runToken: "weekly-1" } as never,
			[
				{
					bucket: "no_clock",
					flagName: "oversized_flag",
					reason: "x".repeat(700),
				},
			] as never,
			200,
		);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(200);
			expect(chunk).toContain("[flag-scan:weekly-1]");
		}
		expect(chunks.join("").match(/x/g)).toHaveLength(700);
	});
});
