/**
 * FLY-2896 — reset-card flow through the real pollOnce, a real account store
 * file and the real hand-off files. Anthropic, the profile switch and the
 * Bridge are fakes; nothing here can reach a network, Keychain or Discord.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AccountStore,
	commitResetCardRecoveryInStore,
	readStoreStrict,
	writeStore,
} from "../account-heal/account-store.js";
import {
	pollOnce,
	type QuotaMonitorAlert,
	type QuotaMonitorDeps,
} from "../account-heal/quota-monitor.js";
import { computeNextDelay } from "../account-heal/quota-monitor-cli.js";
import {
	DEFAULT_QUOTA_MONITOR_CONFIG,
	type LoadedQuotaMonitorConfig,
} from "../account-heal/quota-monitor-config.js";
import {
	emptyQuotaMonitorState,
	type QuotaMonitorState,
} from "../account-heal/quota-monitor-state.js";
import type { AccountUsageResult } from "../account-heal/quota-usage-api.js";
import type {
	CedarGrant,
	CedarStatus,
	RedeemOutcome,
} from "../account-heal/reset-card-contract.js";
import {
	type AuditRow,
	makeResetCardFiles,
	type ResetCardFiles,
	type ResetCardProposal,
} from "../account-heal/reset-card-files.js";
import type {
	PoolCredentialSnapshot,
	ResetCardRuntime,
} from "../account-heal/reset-card-flow.js";
import type {
	SwitchInput,
	SwitchResult,
} from "../account-heal/switch-executor.js";
import { usageResult } from "./quota-monitor-test-helpers.js";
import { sampleConsent } from "./reset-card-test-fixtures.js";

const NOW = Date.parse("2026-09-25T23:05:00.000Z");
const GRANT_ID = "opus55-launch-promax-20260921";
const ORG = "12345678-1234-4abc-8def-1234567890ab";
const ACTIVE_5H_RESET = "2026-09-26T02:00:00.000Z";
const ACTIVE_7D_RESET = "2026-09-29T02:00:00.000Z";
const RECOVERY = {
	business: "2026-10-01T02:00:00.000Z",
	shopping: "2026-09-30T02:00:00.000Z",
	school: "2026-09-29T02:00:00.000Z",
} as const;

type Usage = Extract<AccountUsageResult, { ok: unknown }>;

function grant(patch: Partial<CedarGrant> = {}): CedarGrant {
	return {
		id: GRANT_ID,
		resetsLeft: 1,
		resetsTotal: 1,
		startsAt: "2026-09-22T16:00:00.000Z",
		endsAt: "2026-10-22T16:00:00.000Z",
		clears: ["five_hour", "seven_day", "seven_day_overage_included"],
		blocking: [],
		blockingUnknown: false,
		paused: false,
		usableNow: true,
		useRequiresLimit: true,
		...patch,
	};
}

function cedar(patch: Partial<CedarStatus> = {}): CedarStatus {
	return {
		eligible: true,
		ineligibleReason: null,
		atLimit: true,
		exhausted: ["seven_day"],
		exhaustedUnknown: false,
		grants: [grant()],
		nextGrantId: GRANT_ID,
		cooldownUntil: null,
		...patch,
	};
}

function weeklyFull(name: keyof typeof RECOVERY): Usage {
	return usageResult(12, 100, {
		five: "2026-09-26T03:00:00.000Z",
		seven: RECOVERY[name],
	});
}

let root: string;
let storePath: string;
let files: ResetCardFiles;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fly2896-flow-"));
	storePath = join(root, "claude-accounts.json");
	files = makeResetCardFiles(join(root, "claude-quota"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function uuidSequence(): () => string {
	let n = 0;
	return () => {
		n += 1;
		return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	};
}

function harness() {
	let now = NOW;
	let lockDepth = 0;
	const initial: AccountStore = {
		generation: 7,
		activeAccount: "personal",
		accounts: [
			{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
			{
				name: "business",
				quotaExhaustedUntil: RECOVERY.business,
				switchCooldownUntil: RECOVERY.business,
				weeklyResetAt: RECOVERY.business,
			},
			{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			{ name: "shopping", quotaExhaustedUntil: null, weeklyResetAt: null },
		],
	};
	writeStore(initial, storePath);
	const usages = new Map<string, AccountUsageResult>([
		[
			"tok-personal",
			usageResult(88, 41, { five: ACTIVE_5H_RESET, seven: ACTIVE_7D_RESET }),
		],
		["tok-business", weeklyFull("business")],
		["tok-school", weeklyFull("school")],
		["tok-shopping", weeklyFull("shopping")],
	]);
	const cedars = new Map<string, CedarStatus>([
		["tok-business", cedar()],
		["tok-school", cedar()],
		["tok-shopping", cedar()],
	]);
	const digests: Record<string, string> = {
		personal: "1".repeat(64),
		business: "2".repeat(64),
		school: "3".repeat(64),
		shopping: "4".repeat(64),
	};
	const alerts: QuotaMonitorAlert[] = [];
	const logs: string[] = [];
	const redeemOutcomes: RedeemOutcome[] = [];
	const readStore = () => readStoreStrict(storePath) as AccountStore;
	const credential = (name: string) => ({
		accessToken: `tok-${name}`,
		expiresAt: now + 3_600_000,
		rawDigest: digests[name] as string,
	});

	const redeem = vi.fn<ResetCardRuntime["redeem"]>(async () => {
		const outcome = redeemOutcomes.shift() ?? {
			kind: "reset",
			resetsLeft: 0,
			cleared: ["five_hour", "seven_day"],
		};
		if (outcome.kind === "reset") refill("business");
		return outcome;
	});
	function refill(name: string) {
		usages.set(
			`tok-${name}`,
			usageResult(0, 0, {
				five: null,
				seven: RECOVERY[name as keyof typeof RECOVERY],
			}),
		);
		cedars.set(
			`tok-${name}`,
			cedar({
				atLimit: false,
				exhausted: [],
				grants: [grant({ resetsLeft: 0 })],
			}),
		);
	}

	const rc: ResetCardRuntime = {
		files,
		fetchCardStatus: vi.fn(async (token: string) => {
			expect(lockDepth).toBe(0);
			const usage = usages.get(token);
			const card = cedars.get(token);
			if (usage === undefined || !("ok" in usage) || card === undefined) {
				return { error: "network" };
			}
			return { ok: { usage: usage.ok, cedar: card } };
		}),
		fetchProfile: vi.fn(async () => ({
			ok: { organizationUuid: ORG, subscription: "active" as const },
		})),
		readCliVersion: async () => "2.1.283",
		redeem,
		readPoolCredentialSnapshot: async (name) => {
			expect(lockDepth).toBe(1);
			return credential(name) as PoolCredentialSnapshot;
		},
		readStoreStrict: async () => {
			expect(lockDepth).toBe(1);
			return readStoreStrict(storePath);
		},
		commitRecovery: async (input) => {
			expect(lockDepth).toBe(1);
			return commitResetCardRecoveryInStore(storePath, input);
		},
		randomUUID: uuidSequence(),
	};

	const switchAccount = vi.fn(
		async (input: SwitchInput): Promise<SwitchResult> => {
			expect(lockDepth).toBe(0);
			const store = readStore();
			const target = input.preferredOrder?.[0] as string;
			if (
				store.activeAccount !== input.observedAccount ||
				store.generation !== input.observedGeneration
			) {
				return {
					outcome: "noop_already_switched",
					activeAccount: store.activeAccount ?? "",
				};
			}
			const generation = store.generation + 1;
			writeStore(
				{
					...store,
					generation,
					activeAccount: target,
					lastSwitch: {
						generation,
						triggerKind: "quota",
						from: input.observedAccount,
						to: target,
						at: new Date(now).toISOString(),
					},
				},
				storePath,
			);
			return {
				outcome: "switched",
				from: input.observedAccount,
				to: target,
				generation,
			};
		},
	);

	let state: QuotaMonitorState = emptyQuotaMonitorState(7);
	const configOverrides: Partial<typeof DEFAULT_QUOTA_MONITOR_CONFIG> = {};
	const loaded = (): LoadedQuotaMonitorConfig => {
		const config = {
			...DEFAULT_QUOTA_MONITOR_CONFIG,
			order: ["business", "school", "shopping"],
			...configOverrides,
		};
		return { config, monitorOnly: config.order.length === 0 };
	};

	const deps = (): QuotaMonitorDeps => ({
		now: () => now,
		founderTimezone: () => "America/Los_Angeles",
		config: loaded(),
		state,
		reconcileActive: async () => ({
			result: "noop",
			generation: readStore().generation,
		}),
		reconcileMachine: async () => ({
			ok: true,
			outcome: "already_consistent",
			exitCode: 0,
			detail: "",
		}),
		withAccountsLock: async (fn) => {
			expect(lockDepth).toBe(0);
			lockDepth++;
			try {
				return await fn();
			} finally {
				lockDepth--;
			}
		},
		readSnapshot: async () => {
			const store = readStore();
			const active = store.activeAccount as string;
			return {
				activeName: active,
				store,
				activeCredential: credential(active),
				poolAccounts: ["personal", "business", "school", "shopping"],
			};
		},
		readIdentity: async () => {
			const store = readStore();
			return {
				activeName: store.activeAccount,
				storeGeneration: store.generation,
			};
		},
		readPoolCredential: async (name) => {
			expect(lockDepth).toBe(1);
			return { accessToken: `tok-${name}`, expiresAt: now + 3_600_000 };
		},
		verifyCandidate: async () => ({
			fresh: "refreshed" as const,
			expiresAt: now + 3_600_000,
		}),
		fetchUsage: async (token) => {
			expect(lockDepth).toBe(0);
			return usages.get(token) ?? { error: "network" };
		},
		fetchIdentity: async (token) => {
			const label = token.replace("tok-", "");
			return { email: `${label}@example.test`, uuid: `uuid-${label}` };
		},
		resolveIdentityName: async (identity) =>
			identity.email.split("@")[0] ?? null,
		recordObservation: async () => "updated",
		writeStatuslineCache: async () => undefined,
		persistState: async () => undefined,
		switchAccount,
		alert: async (alert) => {
			alerts.push(alert);
			return { primary: "sent" };
		},
		log: (message) => logs.push(message),
		resetCard: rc,
	});

	return {
		rc,
		redeem,
		switchAccount,
		usages,
		cedars,
		digests,
		alerts,
		logs,
		redeemOutcomes,
		configOverrides,
		readStore,
		refill,
		async poll() {
			const result = await pollOnce(deps());
			state = result.state;
			return result;
		},
		advance(ms: number) {
			now += ms;
			state = { ...state, nextUsageDueAt: 0 };
		},
		setActiveUsage(five: number, seven = 41) {
			usages.set(
				"tok-personal",
				usageResult(five, seven, {
					five: ACTIVE_5H_RESET,
					seven: ACTIVE_7D_RESET,
				}),
			);
		},
		get state() {
			return state;
		},
		set state(next: QuotaMonitorState) {
			state = next;
		},
	};
}

function proposal(): ResetCardProposal {
	const read = files.readProposal();
	if (read.status !== "ok") throw new Error(`proposal ${read.status}`);
	return read.value;
}

function audit(): AuditRow[] {
	const read = files.readAudit();
	if (read.status !== "ok") throw new Error("audit unreadable");
	return read.value;
}

function approve(patch: Parameters<typeof sampleConsent>[1] = {}) {
	files.writeConsent(
		sampleConsent(proposal(), {
			decidedAt: "2026-09-25T23:10:00.000Z",
			...patch,
		}),
	);
}

describe("evaluate (H1)", () => {
	it.each(["5h", "7d"] as const)(
		"keeps one %s proposal and executes consent across reset-time jitter",
		async (window) => {
			const h = harness();
			const times =
				window === "5h"
					? [
							"2026-09-26T02:00:00.123456+00:00",
							"2026-09-26T01:59:59.876543+00:00",
							"2026-09-26T02:00:00.401234+00:00",
						]
					: [
							"2026-09-29T02:00:00.123456+00:00",
							"2026-09-29T01:59:59.876543+00:00",
							"2026-09-29T02:00:00.401234+00:00",
						];
			const reading = (pct: number, resetAt: string) =>
				h.usages.set(
					"tok-personal",
					usageResult(window === "5h" ? pct : 20, window === "7d" ? pct : 41, {
						five: window === "5h" ? resetAt : ACTIVE_5H_RESET,
						seven: window === "7d" ? resetAt : ACTIVE_7D_RESET,
					}),
				);
			reading(88, times[0]!);
			await h.poll();
			const original = proposal();
			h.advance(10 * 60_000);
			reading(88, times[1]!);
			await h.poll();
			expect(proposal().proposalId).toBe(original.proposalId);
			expect(proposal().digest).toBe(original.digest);
			expect(h.redeem).not.toHaveBeenCalled();
			approve();
			h.advance(10 * 60_000);
			reading(window === "5h" ? 92 : 100, times[2]!);
			await h.poll();
			expect(proposal()).toMatchObject({
				proposalId: original.proposalId,
				status: "switched",
			});
			expect(h.redeem).toHaveBeenCalledTimes(1);
			expect(
				audit().some(
					(row) => row.kind === "terminal" && row.outcome === "cancelled",
				),
			).toBe(false);
		},
	);

	it("normalizes API offset timestamps before persisting the full proposal", async () => {
		const h = harness();
		for (const usage of h.usages.values()) {
			if (!("ok" in usage)) continue;
			for (const window of [usage.ok.fiveH, usage.ok.sevenD]) {
				window.resetsAt = window.resetsAt?.replace(".000Z", "+00:00") ?? null;
			}
		}
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "awaiting_consent",
			target: { name: "business" },
			accountRows: expect.arrayContaining([
				expect.objectContaining({
					name: "business",
					recoveryAt: RECOVERY.business,
				}),
				expect.objectContaining({
					name: "personal",
					recoveryAt: ACTIVE_5H_RESET,
				}),
			]),
		});
		approve();
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(proposal().status).toBe("switched");
		expect(h.redeem).toHaveBeenCalledTimes(1);
	});

	it("acceptance 1: 88%, every other account capped, cards on hand → one ask for the latest natural recovery", async () => {
		const h = harness();
		await h.poll();
		const p = proposal();
		expect(p).toMatchObject({
			status: "awaiting_consent",
			active: {
				name: "personal",
				generation: 7,
				drivingWindow: "5h",
				switchAtPct: 90,
				fiveHPct: 88,
			},
			target: {
				name: "business",
				recoveryAt: RECOVERY.business,
				exhausted: ["seven_day"],
				sevenDPct: 100,
			},
			grant: { id: GRANT_ID, resetsLeftBefore: 1, cardsLeftTotal: 1 },
			expiresAt: new Date(NOW + 120 * 60_000).toISOString(),
		});
		// business was in switch cooldown (no usage in the panorama) and still won.
		expect(h.redeem).not.toHaveBeenCalled();
		expect(h.switchAccount).not.toHaveBeenCalled();
	});

	it("does not ask when a healthy direct target exists", async () => {
		const h = harness();
		h.usages.set("tok-school", usageResult(30, 20));
		await h.poll();
		expect(files.readProposal()).toEqual({ status: "absent" });
	});

	it("still asks when the only direct target is low-headroom (97%)", async () => {
		const h = harness();
		h.usages.set("tok-school", usageResult(97, 20));
		await h.poll();
		expect(proposal().target.name).toBe("business");
	});

	it("does not ask when the driving window resets naturally within 30 minutes", async () => {
		const h = harness();
		h.usages.set(
			"tok-personal",
			usageResult(88, 41, { five: "2026-09-25T23:25:00.000Z" }),
		);
		await h.poll();
		expect(files.readProposal()).toEqual({ status: "absent" });
		expect(h.logs).toContain("reset_card skip:natural_reset_soon");
	});

	it("does not ask below askPct, nor when askPct >= trigger", async () => {
		const low = harness();
		low.setActiveUsage(70);
		await low.poll();
		expect(files.readProposal()).toEqual({ status: "absent" });
		const high = harness();
		high.configOverrides.resetCardAskPct = 95;
		await high.poll();
		expect(files.readProposal()).toEqual({ status: "absent" });
	});

	it("is off in monitor-only mode (empty order), even at the switch line", async () => {
		const h = harness();
		h.configOverrides.order = [];
		h.setActiveUsage(95);
		await h.poll();
		expect(files.readProposal()).toEqual({ status: "absent" });
		expect(h.rc.fetchCardStatus).not.toHaveBeenCalled();
	});

	it("is off with resetCardEnabled=false", async () => {
		const h = harness();
		h.configOverrides.resetCardEnabled = false;
		await h.poll();
		expect(files.readProposal()).toEqual({ status: "absent" });
	});

	it("never re-asks the same episode after a rejection", async () => {
		const h = harness();
		await h.poll();
		approve({ state: "rejected" });
		h.advance(20 * 60_000);
		await h.poll();
		expect(proposal().status).toBe("rejected");
		const first = proposal().proposalId;
		h.advance(90 * 60_000);
		await h.poll();
		expect(proposal().proposalId).toBe(first);
		expect(h.redeem).not.toHaveBeenCalled();
	});

	it("does not propose a (target, grant) that already has a live intent row", async () => {
		const h = harness();
		files.appendAudit({
			at: "2026-09-25T20:00:00.000Z",
			kind: "intent",
			proposalId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
			target: "business",
			grantId: GRANT_ID,
			requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
		});
		await h.poll();
		expect(files.readProposal()).toEqual({ status: "absent" });
		expect(h.alerts.some((alert) => alert.title.includes("领卡记录"))).toBe(
			true,
		);
	});

	it("fails closed on an invalid proposal file and leaves polling intact", async () => {
		const h = harness();
		const { writeFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(files.dir, { recursive: true });
		writeFileSync(files.proposalPath, "{not json");
		const result = await h.poll();
		expect(result.outcome).toBe("observed");
		expect(h.alerts.some((alert) => alert.title.includes("提议文件损坏"))).toBe(
			true,
		);
		expect(readFileSync(files.proposalPath, "utf8")).toBe("{not json");
	});
});

describe("no target (H2)", () => {
	it("writes the ask status as the first detail line of quota_no_target", async () => {
		const h = harness();
		h.setActiveUsage(95);
		await h.poll();
		const noTarget = h.alerts.find((alert) => alert.kind === "quota_no_target");
		expect(noTarget?.body).toMatch(/\nreset_card: proposed business\n/);
		expect(proposal().target.name).toBe("business");
	});
});

describe("founder message snapshot", () => {
	it("keeps every account with live candidate facts and the active usage", async () => {
		const h = harness();
		await h.poll();
		expect(proposal().accountRows?.map((row) => row.name)).toEqual([
			"personal",
			"business",
			"school",
			"shopping",
		]);
		expect(proposal().accountRows?.[0]).toMatchObject({
			fiveHPct: 88,
			sevenDPct: 41,
		});
		expect(proposal().accountRows?.[1]).toMatchObject({
			fiveHPct: 12,
			sevenDPct: 100,
			recoveryAt: RECOVERY.business,
			cards: [{ count: 1, endsAt: "2026-10-22T16:00:00.000Z" }],
		});
	});
});

describe("execute (X)", () => {
	it("acceptance 2: approved → at the switch line: one POST, refill verified, switch, settle, full audit", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		const result = await h.poll();

		expect(result.outcome).toBe("switched");
		expect(h.redeem).toHaveBeenCalledTimes(1);
		const [, request] = h.redeem.mock.calls[0] as Parameters<
			ResetCardRuntime["redeem"]
		>;
		expect(request).toMatchObject({
			accessToken: "tok-business",
			orgUuid: ORG,
			cliVersion: "2.1.283",
		});
		expect(h.switchAccount).toHaveBeenCalledTimes(1);
		expect(h.switchAccount.mock.calls[0]?.[0]).toMatchObject({
			trigger: { kind: "quota", scope: "5h" },
			preferredOrder: ["business"],
			quotaPreverified: true,
			resetCardTarget: { name: "business" },
		});
		const store = h.readStore();
		expect(store).toMatchObject({
			generation: 8,
			activeAccount: "business",
			lastSwitch: { generation: 8, triggerKind: "quota", to: "business" },
		});
		const business = store.accounts.find((a) => a.name === "business");
		expect(business?.switchCooldownUntil).toBeUndefined();
		expect(business?.quotaExhaustedUntil).toBeNull();
		expect(proposal().status).toBe("switched");
		expect(h.state.reviveEpoch).toMatchObject({
			sourceAccount: "personal",
			generation: 8,
		});
		const rows = audit();
		expect(rows.map((row) => row.kind)).toEqual(["intent", "terminal"]);
		const intent = rows[0] as Extract<AuditRow, { kind: "intent" }>;
		expect(intent.requestId).toBe(request.requestId);
		expect(rows[1]).toMatchObject({
			outcome: "switched",
			requestId: request.requestId,
			redeemProven: true,
			consent: { state: "approved", founderId: "111111111111111111" },
			target: { name: "business", after: { fiveHPct: 0, sevenDPct: 0 } },
			switch: { outcome: "switched", generation: 8 },
		});
	});

	it("approved but still under the switch line → waits, no POST", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.advance(10 * 60_000);
		await h.poll();
		expect(proposal().status).toBe("awaiting_consent");
		expect(h.redeem).not.toHaveBeenCalled();
	});

	it("a bound approval forces the usage read even when the next read is not due (B3)", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.setActiveUsage(92);
		// nextUsageDueAt is still in the future from the first poll.
		expect(h.state.nextUsageDueAt).toBeGreaterThan(NOW);
		const result = await h.poll();
		expect(result.outcome).toBe("switched");
		expect(h.redeem).toHaveBeenCalledTimes(1);
	});

	it.each(["rejected", "expired"] as const)(
		"%s consent → no POST, proposal records it",
		async (state) => {
			const h = harness();
			await h.poll();
			approve({ state });
			h.advance(10 * 60_000);
			h.setActiveUsage(92);
			await h.poll();
			expect(proposal().status).toBe(state);
			expect(h.redeem).not.toHaveBeenCalled();
			expect(audit().at(-1)).toMatchObject({
				kind: "terminal",
				outcome: state,
			});
		},
	);

	it("a consent for another proposal is ignored (B1)", async () => {
		const h = harness();
		await h.poll();
		approve({ proposalId: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d" });
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(proposal().status).toBe("awaiting_consent");
		expect(h.redeem).not.toHaveBeenCalled();
	});

	it("resetCardEnabled=false stops an already-approved execution", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.configOverrides.resetCardEnabled = false;
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(h.redeem).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a healthy direct target appeared",
			(h: ReturnType<typeof harness>) =>
				h.usages.set("tok-school", usageResult(20, 20)),
			"direct_candidate_appeared",
		],
		[
			"the card count changed",
			(h: ReturnType<typeof harness>) =>
				h.cedars.set(
					"tok-business",
					cedar({
						grants: [grant(), grant({ id: "second-card", resetsLeft: 1 })],
					}),
				),
			"facts_changed:cards_left",
		],
		[
			"the clears set changed",
			(h: ReturnType<typeof harness>) =>
				h.cedars.set(
					"tok-business",
					cedar({ grants: [grant({ clears: ["five_hour", "seven_day"] })] }),
				),
			"facts_changed:clears",
		],
		[
			"a later-recovering account appeared",
			(h: ReturnType<typeof harness>) => {
				h.usages.set(
					"tok-school",
					usageResult(12, 100, { seven: "2026-10-02T02:00:00.000Z" }),
				);
			},
			"facts_changed:target",
		],
		[
			"the target is no longer capped",
			(h: ReturnType<typeof harness>) =>
				h.cedars.set("tok-business", cedar({ atLimit: false })),
			"facts_changed:target",
		],
	])(
		"%s → cancelled, zero POST, re-asked next poll",
		async (_label, mutate, reason) => {
			const h = harness();
			await h.poll();
			const first = proposal().proposalId;
			approve();
			mutate(h);
			h.advance(10 * 60_000);
			h.setActiveUsage(92);
			await h.poll();
			const rows = audit();
			expect(rows.at(-1)).toMatchObject({
				kind: "terminal",
				outcome: "cancelled",
				reason,
			});
			expect(h.redeem).not.toHaveBeenCalled();
			if (reason === "facts_changed:cards_left") {
				// Facts changed but still valid → a new ask for the same episode.
				h.advance(10 * 60_000);
				h.setActiveUsage(88);
				await h.poll();
				expect(proposal().proposalId).not.toBe(first);
				expect(proposal().status).toBe("awaiting_consent");
			}
		},
	);

	it("a switch line changed after approval → cancelled, zero POST (R1 HIGH)", async () => {
		const h = harness();
		await h.poll();
		approve();
		expect(proposal().active.switchAtPct).toBe(90);
		// The operator lowers the switch line after she approved "at 90%".
		h.configOverrides.trigger5hPct = 80;
		h.configOverrides.acceleratePct = 70;
		h.advance(10 * 60_000);
		h.setActiveUsage(88);
		await h.poll();
		expect(h.redeem).not.toHaveBeenCalled();
		expect(audit().at(-1)).toMatchObject({
			kind: "terminal",
			outcome: "cancelled",
			reason: "facts_changed:switch_line",
		});
	});

	it("not_spent → failed, no switch, cooldown untouched", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.redeemOutcomes.push({ kind: "not_spent", cause: "not_limited" });
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "failed",
			statusReason: "not_spent:not_limited",
		});
		expect(h.switchAccount).not.toHaveBeenCalled();
		expect(
			h.readStore().accounts.find((a) => a.name === "business")
				?.switchCooldownUntil,
		).toBe(RECOVERY.business);
		expect(audit().at(-1)).toMatchObject({ redeemProven: false });
		expect(h.alerts.some((alert) => alert.title.includes("用卡失败"))).toBe(
			true,
		);
	});

	it.each(["unconfirmed", "delayed_refill"] as const)(
		"holds ordinary switching during an in-flight redeem (%s), then uses the refilled target",
		async (response) => {
			const h = harness();
			h.usages.set("tok-school", usageResult(95, 20));
			await h.poll();
			approve();
			h.redeem.mockImplementationOnce(async () =>
				response === "unconfirmed"
					? { kind: "unconfirmed", cause: "timeout" }
					: { kind: "reset", resetsLeft: 0, cleared: ["seven_day"] },
			);
			h.advance(10 * 60_000);
			h.setActiveUsage(92);
			await h.poll();
			expect(h.switchAccount).not.toHaveBeenCalled();
			expect(h.readStore()).toMatchObject({
				activeAccount: "personal",
				generation: 7,
			});
			// A subsequent recovery poll must also wait while the read still lags.
			h.advance(2 * 60_000);
			await h.poll();
			expect(h.switchAccount).not.toHaveBeenCalled();
			h.refill("business");
			h.advance(2 * 60_000);
			await h.poll();
			expect(h.redeem).toHaveBeenCalledTimes(1);
			expect(h.switchAccount).toHaveBeenCalledTimes(1);
			expect(h.switchAccount.mock.calls[0]?.[0].preferredOrder).toEqual([
				"business",
			]);
			expect(h.readStore()).toMatchObject({
				activeAccount: "business",
				generation: 8,
			});
			expect(
				h.readStore().accounts.find((account) => account.name === "business"),
			).toMatchObject({ quotaExhaustedUntil: null });
			expect(
				h.readStore().accounts.find((account) => account.name === "business")
					?.switchCooldownUntil,
			).toBeUndefined();
			expect(proposal().status).toBe("switched");
			expect(audit().at(-1)).toMatchObject({
				outcome: "switched",
				redeemProven: true,
			});
		},
	);

	it.each([
		["unconfirmed", "network"],
		["confirmed", "network"],
		["already_used", "network"],
		["unconfirmed", "credential"],
		["confirmed", "credential"],
		["already_used", "credential"],
		["unconfirmed", "cli"],
		["unconfirmed", "throw"],
	] as const)(
		"paces pending recovery and terminates persistent read failures (%s/%s)",
		async (response, failure) => {
			const h = harness();
			await h.poll();
			approve();
			h.redeem.mockImplementationOnce(async () => {
				h.usages.set("tok-business", { error: "network" });
				return response === "unconfirmed"
					? { kind: "unconfirmed", cause: "timeout" }
					: response === "already_used"
						? { kind: "already_used" }
						: { kind: "reset", resetsLeft: 0, cleared: ["seven_day"] };
			});
			h.advance(10 * 60_000);
			h.setActiveUsage(92);
			await h.poll();
			if (failure === "credential")
				h.rc.readPoolCredentialSnapshot = async () => null;
			if (failure === "cli") h.rc.readCliVersion = async () => null;
			if (failure === "throw")
				h.rc.fetchCardStatus = vi.fn(async () => {
					throw new Error("unavailable");
				});
			// Simulate a restart with all persisted deadlines overdue.
			h.state = {
				...h.state,
				nextUsageDueAt: 0,
				nextPaneScanDueAt: 0,
				confirmDueAt: NOW,
			};
			await h.poll();
			expect(
				computeNextDelay(
					h.state,
					DEFAULT_QUOTA_MONITOR_CONFIG,
					NOW + 10 * 60_000,
				),
			).toBeGreaterThan(0);
			const reads = vi.mocked(h.rc.fetchCardStatus).mock.calls.length;
			for (let tick = 0; tick < 8; tick++) await h.poll();
			expect(vi.mocked(h.rc.fetchCardStatus).mock.calls).toHaveLength(reads);
			expect(h.switchAccount).not.toHaveBeenCalled();
			h.advance(11 * 60_000);
			await h.poll();
			expect(proposal()).toMatchObject({
				status:
					response === "confirmed"
						? "redeemed_switch_failed"
						: "redeem_ambiguous",
				statusReason: "recovery_deadline_exceeded",
			});
			expect(audit().at(-1)).toMatchObject({
				reason: "recovery_deadline_exceeded",
			});
			expect(
				h.alerts.some((alert) =>
					alert.body.includes("recovery_deadline_exceeded"),
				),
			).toBe(true);
			expect(h.redeem).toHaveBeenCalledTimes(1);
		},
	);

	it("unconfirmed POST is never resent; a lower card count later proves it and the switch proceeds", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.redeemOutcomes.push({ kind: "unconfirmed", cause: "timeout" });
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		// The server did spend it; our read of the response timed out.
		h.redeem.mockImplementationOnce(async () => {
			h.refill("business");
			return { kind: "unconfirmed", cause: "timeout" };
		});
		await h.poll();
		expect(proposal().status).toBe("redeem_unconfirmed");
		expect(h.switchAccount).not.toHaveBeenCalled();
		h.advance(2 * 60_000);
		await h.poll();
		expect(h.redeem).toHaveBeenCalledTimes(1);
		expect(proposal().status).toBe("switched");
		expect(audit().at(-1)).toMatchObject({
			outcome: "switched",
			redeemResult: "reset_inferred",
			redeemProven: true,
		});
	});

	it("three read-only checks with no evidence → redeem_ambiguous, still one POST", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.redeemOutcomes.push({ kind: "unconfirmed", cause: "http_5xx" });
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		for (let i = 0; i < 4; i++) {
			h.advance(2 * 60_000);
			await h.poll();
		}
		expect(h.redeem).toHaveBeenCalledTimes(1);
		expect(proposal().status).toBe("redeem_ambiguous");
		expect(h.switchAccount).not.toHaveBeenCalled();
	});

	it("already_used is never attributed to us; recovered windows still switch", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.redeem.mockImplementationOnce(async () => {
			h.refill("business");
			return { kind: "already_used" };
		});
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(proposal().status).toBe("switched");
		expect(audit().at(-1)).toMatchObject({
			redeemResult: "already_used",
			redeemProven: null,
		});
	});

	it("a switch by someone else between POST and the cooldown lift → redeemed_switch_failed, store untouched", async () => {
		const h = harness();
		await h.poll();
		approve();
		let bytesAfterManualSwitch = "";
		h.redeem.mockImplementationOnce(async () => {
			h.refill("business");
			// A manual switch lands while our POST is in flight.
			const store = h.readStore();
			writeStore(
				{ ...store, generation: 8, activeAccount: "school" },
				storePath,
			);
			bytesAfterManualSwitch = readFileSync(storePath, "utf8");
			return { kind: "reset", resetsLeft: 0, cleared: ["seven_day"] };
		});
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "redeemed_switch_failed",
			statusReason: "active_changed_after_redeem",
		});
		expect(h.switchAccount).not.toHaveBeenCalled();
		expect(h.alerts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: "Claude 充值卡：已用卡但切号没成",
					body: expect.stringContaining("active_changed_after_redeem"),
				}),
			]),
		);
		expect(audit().at(-1)).toMatchObject({
			outcome: "redeemed_switch_failed",
			redeemProven: true,
		});
		// Nothing of ours touched the store after the other writer acted.
		expect(readFileSync(storePath, "utf8")).toBe(bytesAfterManualSwitch);
	});

	it("a generation bump with the same active account (e.g. an identity freshen) still fails the CAS", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.redeem.mockImplementationOnce(async () => {
			h.refill("business");
			const store = h.readStore();
			writeStore({ ...store, generation: 8 }, storePath);
			return { kind: "reset", resetsLeft: 0, cleared: ["seven_day"] };
		});
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		const storeAfterPoll = readFileSync(storePath, "utf8");
		expect(proposal()).toMatchObject({
			status: "redeemed_switch_failed",
			statusReason: "active_changed_after_redeem",
		});
		expect(h.switchAccount).not.toHaveBeenCalled();
		expect(JSON.parse(storeAfterPoll).generation).toBe(8);
		expect(
			h.readStore().accounts.find((a) => a.name === "business")
				?.switchCooldownUntil,
		).toBe(RECOVERY.business);
	});

	it("a target credential that changes after the intent → redeemed_switch_failed without writing the store", async () => {
		const h = harness();
		await h.poll();
		approve();
		h.redeem.mockImplementationOnce(async () => {
			h.refill("business");
			h.digests.business = "9".repeat(64);
			return { kind: "reset", resetsLeft: 0, cleared: ["seven_day"] };
		});
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		const storeBefore = readFileSync(storePath, "utf8");
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "redeemed_switch_failed",
			statusReason: "credential_changed",
		});
		expect(readFileSync(storePath, "utf8")).toBe(storeBefore);
	});
});

describe("crash recovery", () => {
	async function reachExecuting(h: ReturnType<typeof harness>) {
		await h.poll();
		approve();
		// Crash right after the POST left: the result is never written.
		h.redeem.mockImplementationOnce(async () => {
			h.refill("business");
			throw new Error("process died mid-request");
		});
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
	}

	it("executing on disk → reconciled read-only after restart, never re-POSTed", async () => {
		const h = harness();
		await h.poll();
		approve();
		// Simulate the durable executing record of a process that died in the POST.
		const p = proposal();
		files.appendAudit({
			at: "2026-09-25T23:20:00.000Z",
			kind: "intent",
			proposalId: p.proposalId,
			target: "business",
			grantId: GRANT_ID,
			requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
		});
		files.writeProposal({
			...p,
			status: "executing",
			statusAt: "2026-09-25T23:20:00.000Z",
			redeem: {
				requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
				startedAt: "2026-09-25T23:20:00.000Z",
				result: null,
				cause: null,
				resetsLeftAfter: null,
				unconfirmedChecks: 0,
			},
			switchIntent: {
				from: "personal",
				to: "business",
				generationBefore: 7,
				expectedGeneration: 8,
				trigger: { scope: "5h", resetAt: ACTIVE_5H_RESET },
				targetDigest: h.digests.business as string,
				verifiedAt: null,
			},
		});
		h.refill("business");
		h.advance(20 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(proposal().status).toBe("redeem_unconfirmed");
		h.advance(2 * 60_000);
		await h.poll();
		expect(h.redeem).not.toHaveBeenCalled();
		expect(proposal().status).toBe("switched");
	});

	it("a recorded not_spent survives a crash before the terminal write (R1 MEDIUM)", async () => {
		const h = harness();
		await h.poll();
		approve();
		const p = proposal();
		files.writeProposal({
			...p,
			status: "executing",
			redeem: {
				requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
				startedAt: "2026-09-25T23:20:00.000Z",
				result: "not_spent",
				cause: "not_limited",
				resetsLeftAfter: null,
				unconfirmedChecks: 0,
			},
			switchIntent: {
				from: "personal",
				to: "business",
				generationBefore: 7,
				expectedGeneration: 8,
				trigger: { scope: "5h", resetAt: ACTIVE_5H_RESET },
				targetDigest: h.digests.business as string,
				verifiedAt: null,
			},
		});
		h.advance(10 * 60_000);
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "failed",
			statusReason: "not_spent:not_limited",
		});
		expect(audit().at(-1)).toMatchObject({ redeemProven: false });
	});

	it("a terminal audit row wins over a stale non-terminal proposal after a crash", async () => {
		const h = harness();
		await h.poll();
		approve();
		const p = proposal();
		files.appendAudit({
			at: "2026-09-25T23:21:00.000Z",
			kind: "terminal",
			proposalId: p.proposalId,
			episodeKey: p.episodeKey,
			outcome: "failed",
			reason: "not_spent:cooldown",
			active: { name: "personal", fiveHPct: 88, sevenDPct: 41 },
			target: {
				name: "business",
				before: { fiveHPct: 12, sevenDPct: 100 },
				after: null,
			},
			grant: { id: GRANT_ID, resetsLeftBefore: 1, resetsLeftAfter: null },
			requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
			redeemResult: "not_spent",
			redeemProven: false,
			consent: null,
			switch: null,
		});
		files.writeProposal({
			...p,
			status: "executing",
			redeem: {
				requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
				startedAt: "2026-09-25T23:20:00.000Z",
				result: null,
				cause: null,
				resetsLeftAfter: null,
				unconfirmedChecks: 0,
			},
			switchIntent: {
				from: "personal",
				to: "business",
				generationBefore: 7,
				expectedGeneration: 8,
				trigger: { scope: "5h", resetAt: ACTIVE_5H_RESET },
				targetDigest: h.digests.business as string,
				verifiedAt: null,
			},
		});
		h.advance(10 * 60_000);
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "failed",
			statusReason: "not_spent:cooldown",
		});
		expect(audit().filter((row) => row.kind === "terminal")).toHaveLength(1);
		expect(h.redeem).not.toHaveBeenCalled();
		// The adopted outcome still pages and logs like any terminal (R2).
		expect(h.alerts.some((alert) => alert.title.includes("用卡失败"))).toBe(
			true,
		);
		expect(
			h.logs.some((line) => line.includes('"event":"reset_card_terminal"')),
		).toBe(true);
	});

	it("an unreadable audit stops recovery fail-closed (R2)", async () => {
		const h = harness();
		await h.poll();
		approve();
		const p = proposal();
		files.writeProposal({
			...p,
			status: "redeem_confirmed",
			redeem: {
				requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
				startedAt: "2026-09-25T23:20:00.000Z",
				result: "reset",
				cause: null,
				resetsLeftAfter: 0,
				unconfirmedChecks: 0,
			},
			switchIntent: {
				from: "personal",
				to: "business",
				generationBefore: 7,
				expectedGeneration: 8,
				trigger: { scope: "5h", resetAt: ACTIVE_5H_RESET },
				targetDigest: h.digests.business as string,
				verifiedAt: null,
			},
		});
		h.refill("business");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(files.auditPath, '{"torn":');
		const storeBefore = readFileSync(storePath, "utf8");
		h.advance(10 * 60_000);
		await h.poll();
		expect(proposal().status).toBe("redeem_confirmed");
		const readAudit = vi.spyOn(files, "readAudit");
		for (let tick = 0; tick < 8; tick++) await h.poll();
		expect(readAudit).not.toHaveBeenCalled();
		h.advance(11 * 60_000);
		await h.poll();
		expect(
			computeNextDelay(
				h.state,
				DEFAULT_QUOTA_MONITOR_CONFIG,
				NOW + 21 * 60_000,
			),
		).toBeGreaterThan(0);
		expect(proposal().status).toBe("redeem_confirmed");
		expect(readFileSync(files.auditPath, "utf8")).toBe('{"torn":');
		expect(
			h.alerts.filter((alert) => alert.title.includes("审计文件不可读")),
		).toHaveLength(1);
		expect(
			h.alerts.find((alert) => alert.title.includes("审计文件不可读"))?.body,
		).toContain("修复审计后自动恢复");
		expect(readFileSync(storePath, "utf8")).toBe(storeBefore);
		expect(h.switchAccount).not.toHaveBeenCalled();
		expect(
			h.alerts.some((alert) => alert.title.includes("审计文件不可读")),
		).toBe(true);
		// After manual repair, recovery resumes within this request's grace.
		writeFileSync(files.auditPath, "");
		h.advance(60_000);
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "switched",
			statusReason: null,
		});
		expect(audit().at(-1)).toMatchObject({
			outcome: "switched",
		});
		expect(h.redeem).not.toHaveBeenCalled();
	});

	it("a thrown redeem is treated as unconfirmed, not failed", async () => {
		const h = harness();
		await reachExecuting(h);
		await h.poll();
		expect(proposal().status).toBe("redeem_unconfirmed");
		expect(h.redeem).toHaveBeenCalledTimes(1);
	});

	it("switching on disk + the store proves the switch → settles once, no second switch", async () => {
		const h = harness();
		await h.poll();
		approve();
		const p = proposal();
		const requestId = "0f1e2d3c-4b5a-4968-8776-655443322110";
		files.appendAudit({
			at: "2026-09-25T23:20:00.000Z",
			kind: "intent",
			proposalId: p.proposalId,
			target: "business",
			grantId: GRANT_ID,
			requestId,
		});
		// We died right after the executor committed the switch.
		const store = h.readStore();
		writeStore(
			{
				...store,
				generation: 8,
				activeAccount: "business",
				lastSwitch: {
					generation: 8,
					triggerKind: "quota",
					from: "personal",
					to: "business",
					at: "2026-09-25T23:22:00.000Z",
				},
			},
			storePath,
		);
		h.refill("business");
		files.writeProposal({
			...p,
			status: "switching",
			redeem: {
				requestId,
				startedAt: "2026-09-25T23:20:00.000Z",
				result: "reset",
				cause: null,
				resetsLeftAfter: 0,
				unconfirmedChecks: 0,
			},
			switchIntent: {
				from: "personal",
				to: "business",
				generationBefore: 7,
				expectedGeneration: 8,
				trigger: { scope: "5h", resetAt: ACTIVE_5H_RESET },
				targetDigest: h.digests.business as string,
				verifiedAt: "2026-09-25T23:21:00.000Z",
			},
		});
		h.state = { ...h.state, reviveEpoch: null };
		h.advance(20 * 60_000);
		await h.poll();
		expect(h.switchAccount).not.toHaveBeenCalled();
		expect(h.redeem).not.toHaveBeenCalled();
		expect(proposal().status).toBe("switched");
		expect(h.state.reviveEpoch?.generation).toBe(8);
		expect(audit().map((row) => row.kind)).toEqual(["intent", "terminal"]);
	});

	it("switching on disk without a matching store → redeemed_switch_failed:interrupted, no switch", async () => {
		const h = harness();
		await h.poll();
		approve();
		const p = proposal();
		files.writeProposal({
			...p,
			status: "switching",
			redeem: {
				requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
				startedAt: "2026-09-25T23:20:00.000Z",
				result: "reset",
				cause: null,
				resetsLeftAfter: 0,
				unconfirmedChecks: 0,
			},
			switchIntent: {
				from: "personal",
				to: "business",
				generationBefore: 7,
				expectedGeneration: 8,
				trigger: { scope: "5h", resetAt: ACTIVE_5H_RESET },
				targetDigest: h.digests.business as string,
				verifiedAt: "2026-09-25T23:21:00.000Z",
			},
		});
		h.advance(10 * 60_000);
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "redeemed_switch_failed",
			statusReason: "interrupted",
		});
		expect(h.switchAccount).not.toHaveBeenCalled();
	});

	it("F1: intent written, executing not — facts then change → cancelled with the intent voided; the card can be asked again", async () => {
		const h = harness();
		await h.poll();
		approve();
		const p = proposal();
		files.appendAudit({
			at: "2026-09-25T23:20:00.000Z",
			kind: "intent",
			proposalId: p.proposalId,
			target: "business",
			grantId: GRANT_ID,
			requestId: "0f1e2d3c-4b5a-4968-8776-655443322110",
		});
		h.cedars.set(
			"tok-business",
			cedar({ grants: [grant(), grant({ id: "second-card" })] }),
		);
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(h.redeem).not.toHaveBeenCalled();
		expect(audit().map((row) => row.kind)).toEqual([
			"intent",
			"voided",
			"terminal",
		]);
		h.advance(10 * 60_000);
		h.setActiveUsage(88);
		await h.poll();
		expect(proposal()).toMatchObject({
			status: "awaiting_consent",
			target: { name: "business" },
			grant: { id: GRANT_ID },
		});
	});

	it("intent written, executing not — facts unchanged → the retry reuses the intent's request id", async () => {
		const h = harness();
		await h.poll();
		approve();
		const p = proposal();
		const requestId = "0f1e2d3c-4b5a-4968-8776-655443322110";
		files.appendAudit({
			at: "2026-09-25T23:20:00.000Z",
			kind: "intent",
			proposalId: p.proposalId,
			target: "business",
			grantId: GRANT_ID,
			requestId,
		});
		h.advance(10 * 60_000);
		h.setActiveUsage(92);
		await h.poll();
		expect(h.redeem).toHaveBeenCalledTimes(1);
		expect(h.redeem.mock.calls[0]?.[1].requestId).toBe(requestId);
		expect(audit().filter((row) => row.kind === "intent")).toHaveLength(1);
		expect(proposal().redeem?.requestId).toBe(requestId);
	});
});

describe("isolation", () => {
	it("a throwing reset-card runtime never breaks the ordinary no-target path", async () => {
		const h = harness();
		h.setActiveUsage(95);
		h.rc.fetchCardStatus = async () => {
			throw new Error("boom");
		};
		const result = await h.poll();
		expect(result.outcome).toBe("no_target");
		expect(h.alerts.some((alert) => alert.kind === "quota_no_target")).toBe(
			true,
		);
		expect(h.logs.some((line) => line.startsWith("reset_card_error"))).toBe(
			true,
		);
	});
});
