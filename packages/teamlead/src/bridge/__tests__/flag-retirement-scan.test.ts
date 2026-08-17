import type { FeatureFlagSpec, FlagView } from "flywheel-config";
import { FLAG_SCAN_INTERVAL_MS } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FlagProvenanceInput, StateStore } from "../../StateStore.js";
import {
	createFlagRetirementScanner,
	FLAG_SCAN_VISIBILITY_FENCE_MS,
	type FlagRetirementScanEffects,
	flagRetirementScanEnabled,
	renderLeadAlertChunks,
} from "../flag-retirement-scan.js";

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
	const linearBodies: string[] = [];
	const reports: string[] = [];
	const discordBodies: string[] = [];
	const leadBodies: string[] = [];
	const value: FlagRetirementScanEffects = {
		createLinearBatch: vi.fn(async ({ body }) => {
			linearBodies.push(body);
			return {
				status: "done" as const,
				evidence: "https://linear.app/flywheel/issue/FLY-999/batch",
			};
		}),
		reconcileLinearBatch: vi.fn(async () => ({ status: "missing" as const })),
		publishReport: vi.fn(async ({ html }) => {
			reports.push(html);
			return {
				status: "done" as const,
				evidence: "https://reports.invalid/weekly",
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
	return { value, linearBodies, reports, discordBodies, leadBodies };
}

describe("flagRetirementScanEnabled", () => {
	it("is default-on and observes every call-time env change", () => {
		const env: Record<string, string | undefined> = {};
		expect(flagRetirementScanEnabled(env)).toBe(true);
		env.FLYWHEEL_FLAG_RETIREMENT_SCAN = "0";
		expect(flagRetirementScanEnabled(env)).toBe(false);
		env.FLYWHEEL_FLAG_RETIREMENT_SCAN = "1";
		expect(flagRetirementScanEnabled(env)).toBe(true);
	});
});

describe("FlagRetirementScanner", () => {
	let store: StateStore;
	let now: number;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		now = 1_000;
	});

	afterEach(() => store.close());

	function scanner(
		input: {
			flag?: FeatureFlagSpec;
			flagView?: FlagView;
			effectSet?: ReturnType<typeof effects>;
			loadProvenance?: () => Promise<FlagProvenanceInput[]>;
			alertFailure?: (message: string) => Promise<void>;
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
				loadSources: async () => ({
					rows: [{ spec: flag, view: input.flagView ?? view(flag) }],
					expectedProjectNames: [],
				}),
				loadProvenance:
					input.loadProvenance ?? (async () => [provenance(flag.name)]),
				effects: effectSet.value,
				alertFailure: input.alertFailure ?? (async () => undefined),
				now: () => now,
				newRunToken: () => `${input.tokenPrefix ?? "run"}-${++token}`,
				leaseOwner: `${input.tokenPrefix ?? "worker"}-owner`,
				enabled: input.enabled,
			}),
		};
	}

	it("runs immediately on an empty DB, then waits a fixed seven days", async () => {
		const run = scanner();
		expect(await run.value.scanIfDue()).toMatchObject({ status: "published" });
		expect(store.listFlagScanRuns()).toHaveLength(1);
		expect(store.getFlagScanState()[0]).toMatchObject({ streakSamples: 1 });
		expect(run.effectSet.linearBodies).toEqual([]);

		now += FLAG_SCAN_INTERVAL_MS - 1;
		expect(await run.value.scanIfDue()).toEqual({ status: "not_due" });
		expect(store.listFlagScanRuns()).toHaveLength(1);
	});

	it("makes one weekly batch under two overlapping scanner instances", async () => {
		const sharedEffects = effects();
		const first = scanner({ effectSet: sharedEffects, tokenPrefix: "first" });
		await first.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		const second = scanner({ effectSet: sharedEffects, tokenPrefix: "second" });
		await Promise.all([first.value.scanIfDue(), second.value.scanIfDue()]);
		expect(store.listFlagScanRuns()).toHaveLength(2);
		expect(sharedEffects.value.createLinearBatch).toHaveBeenCalledTimes(1);
		expect(sharedEffects.value.publishReport).toHaveBeenCalledTimes(1);
		expect(sharedEffects.value.postDiscord).toHaveBeenCalledTimes(1);
		expect(sharedEffects.linearBodies[0]).toContain(
			"<!-- flywheel:flag-governance run=",
		);
		expect(sharedEffects.linearBodies[0]).toContain("不进派工");
		expect(sharedEffects.linearBodies[0]).toContain(
			"删除动作由人点头后另行执行",
		);
		expect(sharedEffects.reports[0]).toContain("复制全部");
		expect(sharedEffects.reports[0]).toContain("贴回 Discord");
		expect(sharedEffects.reports[0]).toContain(
			'<script nonce="__CSP_NONCE__">',
		);
		expect(sharedEffects.discordBodies[0]).not.toContain("<!--");
		expect(sharedEffects.discordBodies[0]).toContain(
			"`flywheel:flag-governance run=",
		);
	});

	it("shows the description, current enum winner, and stable duration on both founder surfaces", async () => {
		const flag = spec({
			name: "issue_gate_supersede_mode",
			valueKind: "enum",
			enumValues: ["legacy", "superpowers"],
			default: "superpowers",
			description: "Chooses which issue-gate implementation wins.",
		});
		const run = scanner({ flag });
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		await run.value.scanIfDue();

		expect(run.effectSet.linearBodies[0]).toContain(
			"人话说明: Chooses which issue-gate implementation wins.",
		);
		expect(run.effectSet.linearBodies[0]).toContain('当前值: `"superpowers"`');
		expect(run.effectSet.linearBodies[0]).toContain("稳定时长: 7 天");
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

	it.each(["scanIfDue", "recoverPending"] as const)(
		"settles a crash-left failure alert intent at the %s tick entry",
		async (entrypoint) => {
			store.ensureFlagScanFailureAlertIntent({
				baselineRunId: 0,
				failureClass: "provenance",
				milestone: "initial",
				eventId: "flag-scan-failed:0:provenance:initial",
				now: 500,
			});
			const run = scanner();

			await run.value[entrypoint]();

			expect(store.listFlagScanFailureAlertIntents()).toMatchObject([
				{
					state: "done",
					lastError: expect.stringContaining("voided_at_tick_entry"),
				},
			]);
		},
	);

	it("keeps the full verdict payload selectable when both copy mechanisms fail", async () => {
		const run = scanner();
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		await run.value.scanIfDue();

		const report = run.effectSet.reports[0];
		expect(report).toContain('<textarea id="copy-fallback"');
		expect(report).toContain(
			"浏览器不允许自动复制;下方文本已选中,请按 ⌘C 贴回",
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
		expect(run.effectSet.linearBodies).toEqual([]);
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
		expect(run.effectSet.value.createLinearBatch).not.toHaveBeenCalled();
		expect(run.effectSet.value.publishReport).not.toHaveBeenCalled();
		expect(run.effectSet.value.postDiscord).not.toHaveBeenCalled();
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

	it("the kill switch disables scheduled, dry-run, and pending recovery entrypoints", async () => {
		const run = scanner({ enabled: () => false });
		expect(await run.value.scanIfDue()).toEqual({ status: "disabled" });
		expect(await run.value.dryRun()).toEqual({ status: "disabled" });
		expect(await run.value.recoverPending()).toEqual({ status: "disabled" });
		expect(store.listFlagScanRuns()).toEqual([]);
	});

	it("routes no-clock debt only to the engineering Lead, never founder governance output", async () => {
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
		expect(run.effectSet.linearBodies).toEqual([]);
		expect(run.effectSet.reports).toEqual([]);
		expect(run.effectSet.discordBodies).toEqual([]);
	});

	it("lets the report leg degrade without losing the Linear link or lying in Discord", async () => {
		const effectSet = effects();
		effectSet.value.publishReport = vi.fn(async () => ({
			status: "degraded" as const,
			evidence: "报告发布失败，见 Linear 单",
		}));
		const run = scanner({ effectSet });
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		await run.value.scanIfDue();
		expect(effectSet.discordBodies).toHaveLength(1);
		expect(effectSet.discordBodies[0]).toContain(
			"https://linear.app/flywheel/issue/FLY-999/batch",
		);
		expect(effectSet.discordBodies[0]).toContain("报告发布失败");
	});

	it("recovers a pending run before considering a new due scan", async () => {
		const effectSet = effects();
		let release: (() => void) | undefined;
		effectSet.value.createLinearBatch = vi.fn(
			async () =>
				new Promise((resolve) => {
					release = () =>
						resolve({
							status: "done" as const,
							evidence: "https://linear.app/pending",
						});
				}),
		);
		const run = scanner({ effectSet });
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
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
		effectSet.value.createLinearBatch = vi.fn(async () => ({
			status: "ambiguous" as const,
		}));
		effectSet.value.reconcileLinearBatch = vi.fn(async () => {
			throw new Error("Linear lookup unavailable");
		});
		const alertFailure = vi.fn(async () => undefined);
		const run = scanner({ effectSet, alertFailure });
		await run.value.scanIfDue();
		now += FLAG_SCAN_INTERVAL_MS;
		expect(await run.value.scanIfDue()).toMatchObject({ status: "pending" });

		now += FLAG_SCAN_VISIBILITY_FENCE_MS;
		expect(await run.value.recoverPending()).toMatchObject({
			status: "pending",
		});
		expect(alertFailure).toHaveBeenCalledWith(
			expect.stringMatching(
				/pending recovery.*linear.*Linear lookup unavailable/i,
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
