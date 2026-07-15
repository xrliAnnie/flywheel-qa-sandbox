/**
 * FLY-696 M1/⑥ — reverse-compat sentinel.
 *
 * FLY-1243: FLYWHEEL_ACCOUNT_SELF_HEAL is retired — makeAccountSwitchRepair's
 * `isEnabled` now defaults to `() => true` (construction is gated upstream by
 * account-pool presence in plugin.ts instead). Dormancy is still reachable
 * via the `isEnabled` deps seam that the adapter kept for exactly this
 * purpose. This asserts that FORCING isEnabled → false still refuses every
 * usage_limit — so AutoRepairBot's usage_limit path stays needs_human exactly
 * as it did before FLY-696. If this ever goes green with isEnabled forced to
 * false, the dormancy seam itself has regressed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	accountPoolConfigured,
	writeStore,
} from "../account-heal/account-store.js";
import { makeAccountSwitchRepair } from "../account-heal/account-switch-repair.js";
import type { AlertPayload } from "../LeadAlertNotifier.js";

let dir: string;
let storePath: string;
let pendingPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly696-bytecompat-"));
	storePath = join(dir, "claude-accounts.json");
	pendingPath = join(dir, "account-switch-pending.json");
	// A fully provisioned, switchable pool — the ONLY thing that must keep it
	// dormant is the forced isEnabled: () => false.
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
});
afterEach(() => {
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

describe("FLY-696 reverse-compat sentinel (isEnabled false)", () => {
	// FLY-1243: FLYWHEEL_ACCOUNT_SELF_HEAL is no longer read by production code
	// at all (isEnabled defaults to () => true), so a "the env flag is unset"
	// sanity check is meaningless now — and would be flaky against a real
	// deployment machine's ambient shell env (this repo's dev machine runs a
	// live Flywheel Bridge and legitimately exports this var). Deleted.

	it("account-switch repair is dormant when isEnabled forced false: canAttempt false, enqueue needs_human", async () => {
		// FLY-1243: the isEnabled default is now () => true; force it false via
		// the deps seam to exercise the dormancy path.
		const repair = makeAccountSwitchRepair({
			switchDeps: {} as never,
			storePath,
			pendingPath,
			withLock: async (_l, fn) => fn(),
			isEnabled: () => false,
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
	it("R1 switch executor is unreachable on the auto path when isEnabled is forced false (switchImpl never called)", async () => {
		const switchImpl = vi.fn();
		const repair = makeAccountSwitchRepair({
			switchDeps: {} as never,
			storePath,
			pendingPath,
			withLock: async (_l, fn) => fn(),
			switchImpl: switchImpl as never,
			isEnabled: () => false,
		});
		const r = await repair.enqueue(capPayload());
		expect(r.outcome).toBe("needs_human");
		// The candidate loop / freshness verification live inside switchAccount —
		// prove it is NEVER invoked while the feature is dormant.
		expect(switchImpl).not.toHaveBeenCalled();
	});
});

describe("FLY-1243: accountPoolConfigured() — the production self-heal gate signal", () => {
	// plugin.ts gates `accountSwitchRepair` construction on accountPoolConfigured()
	// (pool-file presence), not on any env-flag boolean. This proves that gate
	// signal directly — the account-selfheal-bytecompat suite above only covered
	// the (still-reachable) isEnabled deps seam, so a regression in the real
	// production gate (e.g. always/never returning true) would have stayed green.
	const ORIGINAL_PATH = process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH;
	afterEach(() => {
		if (ORIGINAL_PATH === undefined) {
			delete process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH;
		} else {
			process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH = ORIGINAL_PATH;
		}
	});

	it("false when the pool file is absent", () => {
		process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH = join(
			dir,
			"does-not-exist.json",
		);
		expect(accountPoolConfigured()).toBe(false);
	});

	it("true when the pool file is present", () => {
		// `storePath` was written by the outer beforeEach (a fully provisioned pool).
		process.env.FLYWHEEL_CLAUDE_ACCOUNTS_PATH = storePath;
		expect(accountPoolConfigured()).toBe(true);
	});
});
