/**
 * FLY-696 M1/⑥ — reverse-compat sentinel.
 *
 * The ENTIRE feature is gated on FLYWHEEL_ACCOUNT_SELF_HEAL. This asserts the
 * PRODUCTION default (env unset) is byte-identical: the account-switch repair,
 * driven by its real env-flag default (not an injected isEnabled), refuses every
 * usage_limit — so AutoRepairBot's usage_limit path stays needs_human exactly as
 * it did before FLY-696. If this ever goes green with the flag unset, the
 * dormant-by-default guarantee has regressed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeStore } from "../account-heal/account-store.js";
import { makeAccountSwitchRepair } from "../account-heal/account-switch-repair.js";
import type { AlertPayload } from "../LeadAlertNotifier.js";

let dir: string;
let storePath: string;
let pendingPath: string;
let savedFlag: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly696-bytecompat-"));
	storePath = join(dir, "claude-accounts.json");
	pendingPath = join(dir, "account-switch-pending.json");
	// A fully provisioned, switchable pool — the ONLY thing that must keep it
	// dormant is the (unset) env flag.
	writeStore(
		{
			generation: 1,
			activeAccount: "personal",
			accounts: [
				{ name: "personal", quotaExhaustedUntil: null, weeklyResetAt: null },
				{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
			],
		},
		storePath,
	);
	savedFlag = process.env.FLYWHEEL_ACCOUNT_SELF_HEAL;
	process.env.FLYWHEEL_ACCOUNT_SELF_HEAL = undefined as never;
	delete process.env.FLYWHEEL_ACCOUNT_SELF_HEAL;
});
afterEach(() => {
	if (savedFlag === undefined) delete process.env.FLYWHEEL_ACCOUNT_SELF_HEAL;
	else process.env.FLYWHEEL_ACCOUNT_SELF_HEAL = savedFlag;
	rmSync(dir, { recursive: true, force: true });
});

function capPayload(): AlertPayload {
	return {
		leadId: "product-lead",
		projectName: "flywheel",
		eventId: "alert-1",
		eventType: "usage_limit",
		title: "usage cap",
		body: "",
		severity: "warning",
		metadata: {
			accountLimit: {
				provider: "claude",
				scope: "5h",
				resetAt: "2026-07-04T02:30:00.000Z",
				observedAccount: "personal",
				observedGeneration: 1,
			},
		},
	};
}

describe("FLY-696 reverse-compat sentinel (flag unset)", () => {
	it("the env flag is unset in this test environment", () => {
		expect(process.env.FLYWHEEL_ACCOUNT_SELF_HEAL).toBeUndefined();
	});

	it("account-switch repair is dormant by default: canAttempt false, enqueue needs_human", async () => {
		// No injected isEnabled → uses the real env-flag default (unset → off).
		const repair = makeAccountSwitchRepair({
			switchDeps: {} as never,
			storePath,
			pendingPath,
			withLock: async (_l, fn) => fn(),
		});
		expect(repair.canAttempt(capPayload())).toBe(false);
		const r = await repair.enqueue(capPayload());
		expect(r.outcome).toBe("needs_human");
	});

	// FLY-871 R1: the freshness guard / candidate loop / capture-back are all
	// DOWNSTREAM of `switchAccount`, which the automatic path only reaches via this
	// (still-gated) repair adapter. Flag off ⇒ enqueue short-circuits to
	// needs_human BEFORE any switch executor runs, so none of R1's new switch
	// behavior can fire on the automatic path. (The ONE deliberate always-on change
	// is the MANUAL `flywheel-claude-profile use` stale-interception — a bash
	// behavior, covered by packages/claude-runner/test/claude-profile.test.ts, and
	// exempted here per plan §5 because it only turns "switch into a dead token"
	// into "refuse + warn" and must hold at all times.)
	it("R1 switch executor is unreachable on the auto path when the flag is unset (switchImpl never called)", async () => {
		const switchImpl = vi.fn();
		const repair = makeAccountSwitchRepair({
			switchDeps: {} as never,
			storePath,
			pendingPath,
			withLock: async (_l, fn) => fn(),
			switchImpl: switchImpl as never,
		});
		const r = await repair.enqueue(capPayload());
		expect(r.outcome).toBe("needs_human");
		// The candidate loop / freshness verification live inside switchAccount —
		// prove it is NEVER invoked while the feature is dormant.
		expect(switchImpl).not.toHaveBeenCalled();
	});
});
