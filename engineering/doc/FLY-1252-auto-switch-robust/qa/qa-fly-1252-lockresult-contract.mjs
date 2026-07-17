// FLY-1252 QA — regression probe for the withLock/LockRunResult seam contract.
//
// WHY THIS EXISTS
// The R15/R16 refactor unified the lock seam: `SwitchDeps.withLock` is now an
// `AccountsLock`, i.e. it resolves to a TAGGED `LockRunResult<T>`
// (`{kind:"ok",value} | {kind:"reconciled",...} | {kind:"blocked",...}`) rather
// than to the callback's raw return value. `switchAccount` pattern-matches on
// `locked.kind` with NO default case: TypeScript's exhaustiveness over the union
// satisfies the compiler, so an OFF-CONTRACT `withLock` (one that resolves to the
// raw value, as every pre-refactor stub does) matches no case and `switchAccount`
// silently returns `undefined`. Callers then crash far away — e.g.
// `account-switch-repair.executeSwitch` reading `result.outcome` of undefined.
//
// That is exactly how `scripts/qa-fly-1252-quota-state-e2e.sh` breaks at this
// head: its two `withLock: async (_path, fn) => fn()` stubs are pre-refactor.
// This probe reproduces the failure in ~1s with no fixtures, so the seam contract
// is pinned instead of being rediscovered by a 400-line e2e crashing at section 5.
//
// PASS = switchAccount does NOT silently resolve to undefined on an off-contract
//        lock result (it either honours the contract or fails loudly).
// FAIL = silent `undefined` — the silent-failure mode that produced the crash.
//
// Usage: node qa-fly-1252-lockresult-contract.mjs <teamlead-dist-dir>
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = process.argv[2];
if (!dist) {
	console.error("usage: node qa-fly-1252-lockresult-contract.mjs <dist>");
	process.exit(2);
}

const { switchAccount } = await import(
	pathToFileURL(join(dist, "account-heal/switch-executor.js")).href
);
const { writeStore } = await import(
	pathToFileURL(join(dist, "account-heal/account-store.js")).href
);

const root = mkdtempSync(join(tmpdir(), "fly1252-lockresult-"));
const storePath = join(root, "accounts.json");
writeStore(
	{
		generation: 1,
		activeAccount: "shopping",
		accounts: [
			{ name: "shopping", quotaExhaustedUntil: null, weeklyResetAt: null },
			{ name: "school", quotaExhaustedUntil: null, weeklyResetAt: null },
		],
	},
	storePath,
);

// The PRE-REFACTOR stub shape: resolves to the callback's raw value, not to a
// tagged LockRunResult. This is byte-for-byte what qa-fly-1252-quota-state-e2e.sh
// still injects at lines 346 and 374.
const offContractDeps = {
	storePath,
	lockPath: join(root, "accounts.lock"),
	withLock: async (_path, fn) => fn({ lockPath: _path }),
	renewLock: () => true,
	readActiveProfile: async () => "shopping",
	applyProfile: async () => ({ ok: true }),
	now: () => new Date("2026-07-16T12:00:00.000Z"),
};

// NOTE: switchAccount(input, deps) — deps is the SECOND argument
// (switch-executor.ts:175-178). Getting this backwards makes the probe throw
// "deps.withLock is not a function", which LOOKS like a loud failure and would
// vacuously pass. Keep the argument order pinned to the real signature.
let result;
let threw = null;
try {
	result = await switchAccount(
		{ preferredOrder: ["school"], reason: "qa-lockresult-contract" },
		offContractDeps,
	);
} catch (e) {
	threw = e?.message ?? String(e);
}
if (
	threw !== null &&
	/withLock is not a function|is not a function/.test(threw)
) {
	console.log(
		`INVALID: probe wired switchAccount wrong (${threw}) — this is a probe bug, not a product result.`,
	);
	process.exit(2);
}

if (threw !== null) {
	console.log(
		`PASS: switchAccount failed loudly on an off-contract lock result (${threw})`,
	);
	process.exit(0);
}
if (result === undefined) {
	console.log(
		"FAIL: switchAccount SILENTLY resolved to `undefined` on an off-contract " +
			"withLock result — no default case in `switch (locked.kind)` " +
			"(switch-executor.ts:344). Downstream reads (e.g. " +
			"account-switch-repair.executeSwitch → result.outcome) crash with a " +
			"TypeError far from the real cause. This is the live break in " +
			"scripts/qa-fly-1252-quota-state-e2e.sh section 5.",
	);
	process.exit(1);
}
console.log(
	`PASS: switchAccount returned a usable result (${JSON.stringify(result)})`,
);
process.exit(0);
