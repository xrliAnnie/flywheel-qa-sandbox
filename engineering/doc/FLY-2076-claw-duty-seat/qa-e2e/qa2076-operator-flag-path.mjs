// QA FLY-2076 (independent): can an OPERATOR flip alert_system through the real
// management route, and does the RUNNING pipeline observe it with no restart?
// Uses the real handleFlagStage/handleFlagApply + real StateStore-backed flag store.
// Only the fleet-console token issuer and audit sink are substituted (declared).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const root = "/Users/xiaorongli/Dev/flywheel-FLY-2076";
const tl = (p) => import(join(root, "packages/teamlead/dist", p));
const { StateStore } = await tl("StateStore.js");
const { handleFlagStage, handleFlagApply } = await tl("bridge/flag-routes.js");
const { initializeFlagStore, storeAlertSystemEnabled } = await tl("bridge/flag-store-runtime.js");

const tmp = mkdtempSync(join(tmpdir(), "qa2076-op-"));
const store = await StateStore.create(join(tmp, "s.db"));
const flagStore = initializeFlagStore(store, {});
const issued = new Map();
const deps = {
  envPath: join(tmp, ".env"),
  readFile: () => "",
  env: {},
  flagStore,
  tokens: {
    issue: (sha) => { const t = createHash("sha256").update(sha + Math.random()).digest("hex"); issued.set(t, sha); return t; },
    verifyAndConsume: (t, sha) => issued.get(t) === sha ? (issued.delete(t), { ok: true }) : { ok: false, reason: "bad-token" },
  },
  audit: { record: () => true },
};
const results = [];
const ok = (n, c, d = "") => results.push([c, `${n}${d ? ` — ${d}` : ""}`]);

ok("baseline: the running pipeline reads ON", storeAlertSystemEnabled(flagStore) === true);

const stage = handleFlagStage(deps, { name: "alert_system", to: false, reason: "QA FLY-2076 independent operator-path proof" }, "http://127.0.0.1:9876");
ok("operator route accepts alert_system for staging", stage.code === 200 && !!stage.body.confirmToken,
   `code=${stage.code} body=${JSON.stringify(stage.body).slice(0, 160)}`);
if (stage.code === 200) {
  const apply = handleFlagApply(deps, stage.body.canonical, stage.body.confirmToken, "http://127.0.0.1:9876");
  ok("operator apply commits the change to flag_values", apply.code === 200, `code=${apply.code} ${JSON.stringify(apply.body).slice(0,160)}`);
  ok("SAME live flagStore object now reads OFF (no restart, no new object)", storeAlertSystemEnabled(flagStore) === false);
  const row = store.getFlagValueRow("alert_system");
  ok("value is durable in flag_values", row.raw === "0" && row.hasOverride === true, `raw=${row.raw} override=${row.hasOverride}`);
  // back ON through the same route
  const s2 = handleFlagStage(deps, { name: "alert_system", to: true, reason: "QA FLY-2076 restore" }, "http://127.0.0.1:9876");
  const a2 = s2.code === 200 ? handleFlagApply(deps, s2.body.canonical, s2.body.confirmToken, "http://127.0.0.1:9876") : { code: s2.code };
  ok("operator route turns it back ON hot", a2.code === 200 && storeAlertSystemEnabled(flagStore) === true, `code=${a2.code}`);
}
// negative control: staging without a reason must be refused for a managed flag
const noReason = handleFlagStage(deps, { name: "alert_system", to: false }, "http://127.0.0.1:9876");
ok("negative control: managed flag refuses a reasonless change", noReason.code === 400, `code=${noReason.code}`);

console.log("\n── QA FLY-2076 operator management path ──");
let fail = 0;
for (const [c, m] of results) { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) fail++; }
console.log(`\nPASS ${results.length - fail} FAIL ${fail}`);
store.close?.();
process.exit(fail === 0 ? 0 : 1);
