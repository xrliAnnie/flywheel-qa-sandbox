/**
 * FLY-1182 QA phase — red-line regression guards for the ignited quota engine.
 *
 * Coverage gap this closes: every existing runner-quota test injects a STUB
 * `isTransient` recognizer, so none of them exercise the real production
 * composition. plugin.ts wires the real `isTransientThrottlePane` into
 * `detectRunnerQuotaCap`; these tests drive that same pairing against the
 * committed real-pane fixtures.
 *
 * WHAT THESE PROVE — and what they do NOT (established by mutation, QA phase):
 * deleting the `isTransient` short-circuit from `detectRunnerQuotaCap` leaves
 * every assertion below GREEN. That is not a gap in the tests; it is a fact
 * about the system: for a 529 pane the gauge parser already yields no cap, so
 * the transient guard is defense-in-depth rather than the load-bearing
 * protection. No committed fixture makes the guard decisive, because
 * `isTransientThrottlePane` refuses to suppress any pane carrying a real cap
 * (see the positive control below) — a real cap always wins over suppression.
 *
 * So these tests assert the OUTCOME Annie's red line names ("a transient 529
 * never switches accounts"), not the internals of any one guard. Do not read a
 * green run here as proof that the `isTransient` short-circuit works.
 *
 * The `throttle-529-then-usage-cap` case is the positive control: without it a
 * recognizer that suppressed everything would pass the no-switch assertions
 * while silently swallowing real caps.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { selectNextAccount } from "../account-heal/account-store.js";
import { parseModelCap } from "../account-heal/model-cap.js";
import { detectRunnerQuotaCap } from "../account-heal/runner-quota-detector.js";
import { isTransientThrottlePane } from "../bridge/pane-blocked-classifier.js";

const FIXTURES = join(__dirname, "fixtures", "lead-panes");
const loadPane = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const NOW = new Date("2026-07-16T12:00:00Z");

// Codex R2 MEDIUM: deriveAccountLimitForAlert reads an account store whose path
// DEFAULTS TO PRODUCTION (~/.flywheel/claude-accounts.json). A test that omits
// storePath both reads production state AND becomes machine-dependent — it passes
// only where a provisioned store happens to exist (green on this host, RED on CI).
// Inject a seeded scratch store so the composition is hermetic and deterministic.
const STORE_DIR = mkdtempSync(join(tmpdir(), "fly1182-red-lines-store-"));
const SCRATCH_STORE = join(STORE_DIR, "claude-accounts.json");
writeFileSync(
	SCRATCH_STORE,
	JSON.stringify({
		generation: 1,
		activeAccount: "alpha",
		accounts: [{ name: "alpha" }, { name: "bravo" }],
	}),
);
afterAll(() => rmSync(STORE_DIR, { recursive: true, force: true }));

/**
 * The exact production composition from plugin.ts (`isTransient:
 * isTransientThrottlePane`), with the account store pinned to scratch so the
 * test never reads production and is deterministic on every machine.
 */
const decideAsProduction = (pane: string) =>
	detectRunnerQuotaCap({
		pane,
		now: NOW,
		isTransient: isTransientThrottlePane,
		provider: "claude",
		storePath: SCRATCH_STORE,
	});

describe("FLY-1182 red line — a transient 529 never switches accounts", () => {
	it.each([
		"throttle-529-live.txt",
		"throttle-529-settled.txt",
		"throttle-529-stale-scrollback.txt",
	])("%s produces no switch decision", (fixture) => {
		expect(decideAsProduction(loadPane(fixture))).toBeNull();
	});

	// Positive control (Codex R1 MEDIUM-2): the no-switch assertions above are
	// only meaningful if the FULL production composition is CAPABLE of returning a
	// switch decision. Asserting only that isTransientThrottlePane does not
	// suppress is too weak — if detectRunnerQuotaCap/the gauge parser returned null
	// unconditionally, every no-switch test would pass vacuously. So drive the SAME
	// decideAsProduction path and require a non-null decision on a pane that carries
	// a real account cap next to the 529.
	it("does NOT suppress a 529 beside a real cap, AND the full composition yields a switch", () => {
		const pane = loadPane("throttle-529-then-usage-cap.txt");
		expect(isTransientThrottlePane(pane)).toBe(false);
		const decision = decideAsProduction(pane);
		expect(decision).not.toBeNull();
		expect(decision?.scope).toBeTruthy();
	});
});

describe("FLY-1182 — model-level cap detection (the 2026-07-11 incident shape)", () => {
	const INCIDENT =
		"You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

	it("recognises the verbatim incident text as capped", () => {
		expect(parseModelCap(`⏺ Working on the refactor\n${INCIDENT}`)).toEqual({
			state: "capped",
			model: "Fable 5",
		});
	});

	it("is generic — not hardcoded to Fable", () => {
		const verdict = parseModelCap(
			"You've reached your Claude Opus 4.8 limit. Run /usage-credits to continue or switch models with /model.",
		);
		expect(verdict).toEqual({ state: "capped", model: "Claude Opus 4.8" });
	});

	it("requires the /model discriminator so an account-level cap never matches", () => {
		expect(
			parseModelCap(
				"Claude usage limit reached. Your limit will reset at 9pm.",
			),
		).toEqual({ state: "clear" });
	});

	// Never destroy a live runner: an in-flight spinner after a cap is `unknown`.
	it("reports unknown (never capped) while an operation is still in flight", () => {
		const verdict = parseModelCap(
			`${INCIDENT}\n✻ Cooking… (esc to interrupt · 12s)`,
		);
		expect(verdict.state).toBe("unknown");
	});

	it("clears once real progress lands after the cap", () => {
		expect(parseModelCap(`${INCIDENT}\n⏺ tests passed`)).toEqual({
			state: "clear",
		});
	});
});

describe("FLY-1182 — switch target selection", () => {
	const account = (name: string, extra: Record<string, unknown> = {}) => ({
		name,
		quotaExhaustedUntil: null,
		weeklyResetAt: null,
		modelCaps: {},
		...extra,
	});
	const select = (accounts: unknown[], input: Record<string, unknown>) =>
		selectNextAccount(
			{ accounts } as never,
			{
				now: NOW,
				currentName: "zulu",
				...input,
			} as never,
		);

	it("weekly scope picks the soonest reset, unknown resets sort last", () => {
		expect(
			select(
				[
					account("alpha", { weeklyResetAt: "2026-07-20T00:00:00Z" }),
					account("bravo", { weeklyResetAt: "2026-07-16T18:00:00Z" }),
					account("charlie"),
				],
				{ scope: "weekly" },
			),
		).toBe("bravo");
	});

	it("5h scope skips an account that is still exhausted", () => {
		expect(
			select(
				[
					account("alpha", { quotaExhaustedUntil: "2026-07-16T23:00:00Z" }),
					account("bravo"),
				],
				{ scope: "5h" },
			),
		).toBe("bravo");
	});

	it("benches only the capped model, leaving that account usable for others", () => {
		const benched = account("alpha", {
			modelCaps: {
				"Fable 5": { until: "2026-07-16T23:00:00Z", backoffMs: 1_800_000 },
			},
		});
		expect(
			select([benched, account("bravo")], {
				scope: "model",
				models: ["Fable 5"],
			}),
		).toBe("bravo");
		// The same account is still a valid target for a model that is NOT benched.
		expect(
			select([benched], { scope: "model", models: ["Claude Opus 4.8"] }),
		).toBe("alpha");
	});

	it("returns null when nothing is usable (needs_human, never invents a target)", () => {
		expect(
			select(
				[account("alpha", { quotaExhaustedUntil: "2026-07-16T23:00:00Z" })],
				{
					scope: "5h",
				},
			),
		).toBeNull();
	});
});
