/**
 * FLY-1366 QA: end-to-end idle-standby probe — raw API payload → REAL validator →
 * panorama → switch decision.
 *
 * Why this file exists, given quota-monitor.test.ts already has idle-candidate cases:
 * that suite injects `fetchUsage` and hands `pollOnce` an ALREADY-PARSED
 * `AccountUsageResult`, so `isQuotaWindow` never runs. Reverting the core
 * `resets_at: null` acceptance leaves all 65 of its cases green — the parse fix is
 * only guarded by `quota-usage-api.test.ts` in isolation, and nothing proves the two
 * halves compose into "an idle standby actually becomes a switch target".
 *
 * These tests wire the real `fetchAccountUsage` (real validator) into `pollOnce`
 * behind a stub `fetchFn` serving the raw JSON shape recorded from the live API on
 * 2026-07-18, so the outage path is reproduced end-to-end:
 *   idle standby -> resets_at: null -> usage_malformed -> no candidate -> no_target.
 */
import { describe, expect, it, vi } from "vitest";
import type { AccountStore } from "../account-heal/account-store.js";
import {
	pollOnce,
	type QuotaMonitorDeps,
} from "../account-heal/quota-monitor.js";
import { DEFAULT_QUOTA_MONITOR_CONFIG } from "../account-heal/quota-monitor-config.js";
import { emptyQuotaMonitorState } from "../account-heal/quota-monitor-state.js";
import { fetchAccountUsage } from "../account-heal/quota-usage-api.js";
import type { SwitchResult } from "../account-heal/switch-executor.js";

const NOW = Date.parse("2026-07-18T17:19:00Z");

/**
 * Raw `GET /api/oauth/usage` bodies, keyed by access token.
 *
 * `idleFiveHour` mirrors the shape exploration.md recorded from school/business on
 * 2026-07-18: an account with no active 5h window reports `utilization: 0` with
 * `resets_at: null`. The extra null-valued sibling keys mirror the live payload
 * (`extra_usage`, `seven_day_opus`, ...) confirmed present in the production
 * statusline cache during QA — they must not perturb validation.
 */
function idleFiveHour(sevenPct: number, sevenReset: string | null) {
	return {
		five_hour: {
			utilization: 0,
			resets_at: null,
			limit_dollars: null,
			used_dollars: null,
		},
		seven_day: { utilization: sevenPct, resets_at: sevenReset },
		extra_usage: { utilization: null, resets_at: null },
		seven_day_opus: null,
	};
}

function activeWindows(fivePct: number, sevenPct: number) {
	return {
		five_hour: { utilization: fivePct, resets_at: "2026-07-18T18:00:00.000Z" },
		seven_day: { utilization: sevenPct, resets_at: "2026-07-22T06:59:59Z" },
	};
}

function store(): AccountStore {
	return {
		generation: 4,
		activeAccount: "shopping",
		accounts: [
			{ name: "shopping", quotaExhaustedUntil: null, weeklyResetAt: null },
			{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			{ name: "business", quotaExhaustedUntil: null, weeklyResetAt: null },
		],
	};
}

/**
 * Builds deps whose `fetchUsage` is the REAL `fetchAccountUsage`, fed by a stub
 * `fetchFn`. Everything downstream of the parser is exercised for real.
 */
function harness(bodies: Record<string, unknown>) {
	const credentials: Record<
		string,
		{ accessToken: string; expiresAt: number }
	> = {
		shopping: { accessToken: "secret-shopping", expiresAt: NOW + 3_600_000 },
		school: { accessToken: "secret-school", expiresAt: NOW + 3_600_000 },
		business: { accessToken: "secret-business", expiresAt: NOW + 3_600_000 },
	};
	const panorama: string[] = [];
	const logs: string[] = [];
	const switchImpl = vi.fn<
		(
			input: Parameters<QuotaMonitorDeps["switchAccount"]>[0],
		) => Promise<SwitchResult>
	>(async (input) => ({
		outcome: "switched",
		from: "shopping",
		to: input.preferredOrder?.[0] ?? "school",
		generation: 5,
	}));

	// The real parser + a stub transport. Authorization header carries the token,
	// which is how we route to the right canned body.
	const fetchUsage = async (accessToken: string) =>
		fetchAccountUsage(accessToken, {
			fetchFn: (async (
				_url: string,
				init: { headers: Record<string, string> },
			) => {
				const token = init.headers.Authorization.replace("Bearer ", "");
				const body = bodies[token];
				// `ok` is load-bearing: requestUsage short-circuits to error:"network"
				// on a falsy `ok` before it ever parses the body.
				if (body === undefined) {
					return { ok: false, status: 500, headers: new Headers() };
				}
				return {
					ok: true,
					status: 200,
					headers: new Headers({ "content-type": "application/json" }),
					json: async () => body,
				};
			}) as unknown as typeof fetch,
		});

	const deps: QuotaMonitorDeps = {
		now: () => NOW,
		config: {
			config: {
				...DEFAULT_QUOTA_MONITOR_CONFIG,
				order: ["shopping", "school", "business"],
			},
			monitorOnly: false,
		},
		state: emptyQuotaMonitorState(4),
		reconcileActive: async () => ({ result: "noop", generation: 4 }),
		reconcileMachine: async () => ({
			ok: true,
			outcome: "already_consistent",
			exitCode: 0,
			detail: "",
		}),
		withAccountsLock: async (fn) => fn(),
		readSnapshot: async () => ({
			activeName: "shopping",
			store: structuredClone(store()),
			activeCredential: credentials.shopping ?? null,
			poolAccounts: Object.keys(credentials),
		}),
		readIdentity: async () => ({ activeName: "shopping", storeGeneration: 4 }),
		readPoolCredential: async (name) => credentials[name] ?? null,
		verifyCandidate: async () => ({
			fresh: "refreshed" as const,
			expiresAt: NOW + 3_600_000,
		}),
		fetchUsage,
		fetchIdentity: async (token: string) => {
			const label = token.replace("secret-", "");
			return { email: `${label}@example.com`, uuid: `uuid-${label}` };
		},
		recordObservation: async () => "updated",
		writeStatuslineCache: async () => {},
		persistState: async () => {},
		switchAccount: switchImpl,
		// Empty-but-well-formed snapshot: no model-cap panes, so the account-level
		// (quota) path is the one under test.
		scanPanes: async () => ({
			socket: "flywheel",
			capturedAt: NOW,
			listedCount: 0,
			complete: true,
			omittedPanes: [],
			observations: [],
		}),
		reviveSnapshot: async (state) => ({
			state,
			summary: { revived: 0, pending: 0, loginExpired: 0 },
		}),
		confirmSnapshot: async (state) => state,
		alert: async () => ({ primary: "sent" }),
		log: vi.fn((entry: string) => {
			logs.push(entry);
			try {
				const parsed = JSON.parse(entry);
				if (parsed.event === "quota_poll" && Array.isArray(parsed.panorama)) {
					panorama.push(...parsed.panorama);
				}
			} catch {
				/* non-JSON log line */
			}
		}),
	};
	return { deps, switchImpl, panorama, logs };
}

describe("FLY-1366 e2e: idle standby through the real usage validator", () => {
	it("selects an idle standby as a switch target when the active account is capped", async () => {
		// shopping (active) at 100% 5h -> must switch. Both standbys are idle: the
		// exact production configuration that produced no_target on 2026-07-18.
		const h = harness({
			"secret-shopping": activeWindows(100, 61),
			"secret-school": idleFiveHour(88, "2026-07-20T15:59:59Z"),
			"secret-business": idleFiveHour(4, "2026-07-23T02:00:00Z"),
		});

		const result = await pollOnce(h.deps);

		// The outage symptom was outcome=no_target with every standby unverifiable.
		expect(result.outcome).toBe("switched");
		expect(h.switchImpl).toHaveBeenCalledTimes(1);
		// business has the later weekly reset but far more headroom; both must at
		// least be ranked — the bug removed them from the pool entirely.
		const order = h.switchImpl.mock.calls[0]?.[0]?.preferredOrder ?? [];
		expect(order).toContain("school");
		expect(order).toContain("business");
		// Positive control on the panorama: idle standbys read as qualified, and the
		// string that defined the outage must be absent for them.
		expect(h.panorama).toContain("school:qualified");
		expect(h.panorama).toContain("business:qualified");
		expect(h.panorama).not.toContain("school:usage_malformed");
		expect(h.panorama).not.toContain("business:usage_malformed");
	});

	it("still rejects a genuinely malformed payload end-to-end", async () => {
		// Guards the direction that a permissive "accept anything" fix would break:
		// a non-null, non-parseable reset is a contract violation, not an idle window.
		const h = harness({
			"secret-shopping": activeWindows(100, 61),
			"secret-school": {
				five_hour: { utilization: 0, resets_at: 12345 },
				seven_day: { utilization: 4, resets_at: "2026-07-23T02:00:00Z" },
			},
			"secret-business": {
				five_hour: { utilization: 0, resets_at: null },
				seven_day: { utilization: -1, resets_at: null },
			},
		});

		const result = await pollOnce(h.deps);

		expect(result.outcome).toBe("no_target");
		expect(h.switchImpl).not.toHaveBeenCalled();
		expect(h.panorama).toContain("school:usage_malformed");
		expect(h.panorama).toContain("business:usage_malformed");
	});
});
