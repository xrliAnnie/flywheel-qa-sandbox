import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import { StateStore } from "../../StateStore.js";
import type { CodexQuotaObservation } from "../candidate-selector.js";
import { createCodexQuotaOutboxDelivery } from "../outbox.js";
import {
	buildPoolExhaustedAlertSnapshot,
	formatPoolExhaustedAlert,
	parsePoolExhaustedAlertDetails,
	parsePoolExhaustedAlertSnapshot,
} from "../pool-exhausted-alert.js";

const NOW = Date.parse("2026-09-25T20:00:00.000Z");
const AT = (iso: string) => Date.parse(iso);
const BUSINESS_RESET = AT("2026-09-30T20:59:00.000Z"); // 9/30 13:59 PT
const P1_WEEK = AT("2026-09-27T04:04:00.000Z"); // 9/26 21:04 PT
const P1_5H = AT("2026-09-26T09:00:00.000Z"); // 9/26 02:00 PT
const NEXT_ATTEMPT = NOW + 60_000;

const observation = (
	profile: string,
	windows: CodexQuotaObservation["windows"],
	extra: Partial<CodexQuotaObservation> = {},
): CodexQuotaObservation => ({
	profile,
	accountKey: `${profile}-key`,
	observedAt: NOW - 1_000,
	identityVerified: true,
	authHealth: "valid",
	scopeKnown: true,
	windows,
	...extra,
});

const knownShape = () => [
	observation("business", [{ usedPercent: 100, resetsAt: BUSINESS_RESET }]),
	observation("personal1", [
		{ usedPercent: 100, resetsAt: P1_WEEK },
		{ usedPercent: 37, resetsAt: P1_5H },
	]),
	observation("school", [
		{ usedPercent: 100, resetsAt: P1_5H },
		{ usedPercent: 100, resetsAt: BUSINESS_RESET },
	]),
];

describe("FLY-2830 pool-exhausted alert snapshot", () => {
	it("① takes each account's latest full-window reset and the fleet minimum", () => {
		const snapshot = buildPoolExhaustedAlertSnapshot(knownShape(), NOW)!;
		expect(
			snapshot.accounts.map((account) => [account.profile, account.recoveryAt]),
		).toEqual([
			["business", BUSINESS_RESET],
			["personal1", P1_WEEK],
			["school", BUSINESS_RESET],
		]);
		expect(snapshot.earliestRecovery).toEqual({
			profile: "personal1",
			at: P1_WEEK,
		});
		expect(JSON.stringify(snapshot)).not.toContain(String(NEXT_ATTEMPT));
	});

	it("② a full window without a reset makes that account and the fleet unknown", () => {
		const snapshot = buildPoolExhaustedAlertSnapshot(
			[
				...knownShape().slice(0, 2),
				observation("school", [{ usedPercent: 100, resetsAt: null }]),
			],
			NOW,
		)!;
		expect(snapshot.accounts.at(-1)?.recoveryAt).toBeNull();
		expect(snapshot.earliestRecovery).toBeNull();
	});

	it("③ reached without any 100% window is unknown too", () => {
		const snapshot = buildPoolExhaustedAlertSnapshot(
			[
				...knownShape().slice(0, 2),
				observation("school", [{ usedPercent: 80, resetsAt: P1_5H }], {
					reached: true,
				}),
			],
			NOW,
		)!;
		expect(snapshot.accounts.at(-1)).toMatchObject({
			reached: true,
			recoveryAt: null,
		});
		expect(snapshot.earliestRecovery).toBeNull();
	});

	it("refuses more than 16 accounts or 4 windows", () => {
		const many = Array.from({ length: 17 }, (_, i) =>
			observation(`acct${i}`, [{ usedPercent: 100, resetsAt: P1_5H }]),
		);
		expect(buildPoolExhaustedAlertSnapshot(many, NOW)).toBeNull();
		const wide = observation(
			"business",
			Array.from({ length: 5 }, () => ({ usedPercent: 100, resetsAt: P1_5H })),
		);
		expect(buildPoolExhaustedAlertSnapshot([wide], NOW)).toBeNull();
	});

	it("freezes the run details with the fact and rejects bad details", () => {
		expect(
			parsePoolExhaustedAlertDetails({
				source: "business",
				resetAt: "2026-09-30T20:59:00.000Z",
				target: "none",
				affectedRuns: 2,
				restartedRuns: 0,
			}),
		).not.toBeNull();
		for (const bad of [
			{
				source: "../x",
				resetAt: null,
				target: "none",
				affectedRuns: 0,
				restartedRuns: 0,
			},
			{
				source: "unknown",
				resetAt: "yesterday",
				target: "none",
				affectedRuns: 0,
				restartedRuns: 0,
			},
			{
				source: "unknown",
				resetAt: null,
				target: "none",
				affectedRuns: 1,
				restartedRuns: 2,
			},
			{
				source: "unknown",
				resetAt: null,
				target: "none",
				affectedRuns: -1,
				restartedRuns: 0,
			},
			{
				source: "unknown",
				resetAt: null,
				target: "none",
				affectedRuns: 0,
				restartedRuns: 0,
				x: 1,
			},
		])
			expect(parsePoolExhaustedAlertDetails(bad)).toBeNull();
	});

	it.each([
		[
			"duplicate profiles",
			{
				observedAt: NOW,
				accounts: [
					{
						profile: "a",
						windows: [{ usedPercent: 100, resetsAt: 5 }],
						reached: true,
						recoveryAt: 5,
					},
					{
						profile: "a",
						windows: [{ usedPercent: 100, resetsAt: 5 }],
						reached: true,
						recoveryAt: 5,
					},
				],
				earliestRecovery: { profile: "a", at: 5 },
			},
		],
		[
			"unsorted profiles",
			{
				observedAt: NOW,
				accounts: [
					{
						profile: "b",
						windows: [{ usedPercent: 100, resetsAt: 5 }],
						reached: false,
						recoveryAt: 5,
					},
					{
						profile: "a",
						windows: [{ usedPercent: 100, resetsAt: 5 }],
						reached: false,
						recoveryAt: 5,
					},
				],
				earliestRecovery: { profile: "a", at: 5 },
			},
		],
		[
			"an account that is not full",
			{
				observedAt: NOW,
				accounts: [
					{ profile: "a", windows: [], reached: false, recoveryAt: null },
				],
				earliestRecovery: null,
			},
		],
		[
			"a negative observation time",
			{
				observedAt: -1,
				accounts: [
					{
						profile: "a",
						windows: [{ usedPercent: 100, resetsAt: 5 }],
						reached: false,
						recoveryAt: 5,
					},
				],
				earliestRecovery: { profile: "a", at: 5 },
			},
		],
		[
			"a negative reset",
			{
				observedAt: NOW,
				accounts: [
					{
						profile: "a",
						windows: [{ usedPercent: 100, resetsAt: -5 }],
						reached: false,
						recoveryAt: -5,
					},
				],
				earliestRecovery: { profile: "a", at: -5 },
			},
		],
	])("R1: rejects a semantically impossible snapshot (%s)", (_name, value) => {
		expect(parsePoolExhaustedAlertSnapshot(value)).toBeNull();
	});

	it.each([
		["a non-object", 42],
		[
			"an unknown key",
			{ observedAt: NOW, accounts: [], earliestRecovery: null, x: 1 },
		],
		[
			"a bad profile",
			{
				observedAt: NOW,
				accounts: [
					{ profile: "../x", windows: [], reached: false, recoveryAt: null },
				],
				earliestRecovery: null,
			},
		],
		[
			"a percentage over 100",
			{
				observedAt: NOW,
				accounts: [
					{
						profile: "a",
						windows: [{ usedPercent: 101, resetsAt: null }],
						reached: false,
						recoveryAt: null,
					},
				],
				earliestRecovery: null,
			},
		],
		[
			"a recovery that does not follow from the windows",
			{
				observedAt: NOW,
				accounts: [
					{
						profile: "a",
						windows: [{ usedPercent: 100, resetsAt: 5 }],
						reached: false,
						recoveryAt: 9,
					},
				],
				earliestRecovery: { profile: "a", at: 9 },
			},
		],
		[
			"an invented earliest recovery",
			{
				observedAt: NOW,
				accounts: [
					{
						profile: "a",
						windows: [{ usedPercent: 100, resetsAt: null }],
						reached: false,
						recoveryAt: null,
					},
				],
				earliestRecovery: { profile: "a", at: 5 },
			},
		],
		[
			"an oversized payload",
			{
				observedAt: NOW,
				accounts: [
					{
						profile: "a".repeat(9000),
						windows: [],
						reached: false,
						recoveryAt: null,
					},
				],
				earliestRecovery: null,
			},
		],
	])("rejects %s when parsing a persisted snapshot", (_name, value) => {
		expect(parsePoolExhaustedAlertSnapshot(value)).toBeNull();
	});

	it("round-trips a built snapshot", () => {
		const snapshot = buildPoolExhaustedAlertSnapshot(knownShape(), NOW);
		expect(
			parsePoolExhaustedAlertSnapshot(JSON.parse(JSON.stringify(snapshot))),
		).toEqual(snapshot);
	});

	it("writes one Chinese line per account with recovery or the reason it is unknown", () => {
		expect(
			formatPoolExhaustedAlert(
				buildPoolExhaustedAlertSnapshot(knownShape(), NOW)!,
				"America/Los_Angeles",
			).split("\n"),
		).toEqual([
			"Codex 全部账号都已打满，暂停自动切号，不做盲目替换。",
			"各号用量与重置（PT）：",
			"- business：100% · 9/30 13:59 重置 → 恢复 9/30 13:59",
			"- personal1：100% · 9/26 21:04 重置；37% · 9/26 02:00 重置 → 恢复 9/26 21:04",
			"- school：100% · 9/26 02:00 重置；100% · 9/30 13:59 重置 → 恢复 9/30 13:59",
			"最早可恢复：9/26 21:04（personal1）。也可以兑一张重置卡。",
		]);
		const unknown = formatPoolExhaustedAlert(
			buildPoolExhaustedAlertSnapshot(
				[
					observation("business", [{ usedPercent: 100, resetsAt: null }]),
					observation("school", [{ usedPercent: 90, resetsAt: P1_5H }], {
						reached: true,
					}),
				],
				NOW,
			)!,
			"America/Los_Angeles",
		);
		// Discord renders no tables (founder rule): one plain line per account.
		expect(unknown).not.toContain("|");
		expect(unknown).toContain(
			"- business：100% · 重置未知 → 恢复无法确定（接口未给重置时间）",
		);
		expect(unknown).toContain("无法确定（被判打满但没有 100% 窗口）");
		expect(unknown).toContain("最早可恢复：无法确定（有账号没给重置时间）");
	});

	it("says 读不到 for a defensive empty window list instead of throwing", () => {
		expect(
			formatPoolExhaustedAlert(
				{
					observedAt: NOW,
					accounts: [
						{ profile: "a", windows: [], reached: true, recoveryAt: null },
					],
					earliestRecovery: null,
				},
				"America/Los_Angeles",
			),
		).toContain("- a：读不到 → 恢复无法确定（被判打满但没有 100% 窗口）");
	});
});

describe("FLY-2830 pool-exhausted founder alert (store + outbox)", () => {
	const stores: StateStore[] = [];
	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
	});
	async function exhaustedStore(
		observations: CodexQuotaObservation[],
		poolProfiles?: string[],
	) {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.codexQuota.initializeRoot({
			rootKey: "root",
			accountKey: "business-key",
			profile: "business",
			generation: 1,
		});
		store.codexQuota.registerBinding({
			bindingId: "b0",
			executionId: "e0",
			runId: "r0",
			purpose: "runner",
			accountKey: "account",
			profile: "business",
			generation: 1,
			credentialRootKey: "root",
		});
		store.codexQuota.recordSignal({ executionId: "e0", bindingId: "b0" });
		const pool = (
			poolProfiles ?? [...new Set(observations.map((o) => o.profile))]
		).map((profile) => ({ profile, accountKey: `${profile}-key` }));
		store.currentCodexPoolMembers = () => pool;
		store.codexQuota.recordPoolExhausted({
			incidentId: "codex:root:1",
			pool,
			observations,
			observedAt: NOW - 1_000,
			nextAttemptAt: NEXT_ATTEMPT,
		});
		return { store, pool };
	}
	const founderPayload = (store: StateStore) =>
		JSON.parse(
			String(
				store.codexQuota
					.listOutbox()
					.find((row) => row.kind === "founder_alert")?.payload_json,
			),
		);

	it.each([
		["① known resets", knownShape()],
		[
			"② a missing reset",
			[
				...knownShape().slice(0, 2),
				observation("school", [{ usedPercent: 100, resetsAt: null }]),
			],
		],
		[
			"③ reached without a full window",
			[
				...knownShape().slice(0, 2),
				observation("school", [{ usedPercent: 80, resetsAt: P1_5H }], {
					reached: true,
				}),
			],
		],
	])("freezes the snapshot with the fact (%s)", async (_name, observations) => {
		const { store } = await exhaustedStore(observations);
		const payload = founderPayload(store);
		expect(payload.alertSnapshot).toEqual(
			buildPoolExhaustedAlertSnapshot(observations, NOW - 1_000),
		);
		expect(payload.nextAttemptAt).toBe(NEXT_ATTEMPT);
		expect(JSON.stringify(payload.alertSnapshot)).not.toContain(
			String(NEXT_ATTEMPT),
		);
	});

	it("R2: freezes the snapshot from the selector's own per-profile proof (history + stranger)", async () => {
		const observations = [
			...knownShape(),
			// An older reading of the same profile (history) …
			observation("school", [{ usedPercent: 100, resetsAt: P1_WEEK }], {
				observedAt: NOW - 30_000,
			}),
			// … and a profile outside the pool.
			observation("stranger", [{ usedPercent: 100, resetsAt: P1_5H }]),
		];
		const { store } = await exhaustedStore(observations, [
			"business",
			"personal1",
			"school",
		]);
		const payload = founderPayload(store);
		expect(payload.alertSnapshot).toEqual(
			buildPoolExhaustedAlertSnapshot(knownShape(), NOW - 1_000),
		);
		expect(payload.alertDetails).toMatchObject({ affectedRuns: 1 });
	});

	it("renders the Chinese body from the payload and replays it word for word after a newer fact", async () => {
		const { store, pool } = await exhaustedStore(knownShape());
		let now = NOW;
		const send = vi.fn(async (_payload: AlertPayload) => ({ sent: true }));
		const options = {
			store,
			send,
			now: () => now,
			founderUserId: "123456789012345678",
		};
		const founderCalls = () =>
			send.mock.calls
				.map((call) => call[0])
				.filter((payload) => payload.eventId === "codex:root:1:founder_alert");
		await createCodexQuotaOutboxDelivery(options)();
		expect(founderCalls()).toHaveLength(1);
		const first = founderCalls()[0]!;
		expect(first.body).toContain("Codex 全部账号都已打满");
		expect(first.body).toContain("最早可恢复：9/26 21:04（personal1）");
		expect(first).toMatchObject({
			eventId: "codex:root:1:founder_alert",
			eventType: "quota_no_target",
			severity: "severe",
			mentionUserId: "123456789012345678",
		});
		// A newer fact for the same generation, then the ambiguous replay.
		store.codexQuota.recordPoolExhausted({
			incidentId: "codex:root:1",
			pool,
			observations: knownShape().map((o) => ({
				...o,
				observedAt: NOW + 5_000,
				windows: o.windows.map((w) => ({ ...w, resetsAt: P1_5H })),
			})),
			observedAt: NOW + 5_000,
			nextAttemptAt: NEXT_ATTEMPT + 5_000,
		});
		// ...and the runner recovered in between (live targets moved on).
		const runner = store.codexQuota
			.listTargets("codex:root:1")
			.find((target) => target.target_kind === "runner")!;
		store.codexQuota.updateTarget(
			"codex:root:1",
			"runner",
			String(runner.target_id),
			{ state: "recovered" },
		);
		now += 30 * 60_000 + 1;
		await createCodexQuotaOutboxDelivery(options)();
		expect(founderCalls()).toHaveLength(2);
		expect(founderCalls()[1]!.body).toBe(first.body);
		expect(first.body).toContain("affected_runs=1 restarted_runs=0");
	});

	it("keeps the legacy English body for a payload without a snapshot or with a bad one", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.codexQuota.enqueueOutbox({
			incidentId: "legacy",
			kind: "founder_alert",
			destination: "founder",
			payload: { reason: "pool_exhausted" },
		});
		store.codexQuota.enqueueOutbox({
			incidentId: "tampered",
			kind: "founder_alert",
			destination: "founder",
			payload: {
				reason: "pool_exhausted",
				alertSnapshot: { observedAt: "yesterday" },
			},
		});
		const send = vi.fn(async (_payload: AlertPayload) => ({ sent: true }));
		const lines: string[] = [];
		await createCodexQuotaOutboxDelivery({
			store,
			send,
			founderUserId: "123456789012345678",
			log: (line) => lines.push(line),
		})();
		expect(send).toHaveBeenCalledTimes(2);
		for (const call of send.mock.calls)
			expect(call[0].body).toMatch(
				/^Codex fleet remains paused \(pool_exhausted\)/,
			);
		expect(lines).toEqual([
			"[codex-quota] pool_exhausted_snapshot_invalid incident=tampered",
		]);
	});
});
