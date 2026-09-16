// Does the real app-server emit thread/settings/updated for a same-value update?
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { scrubToSlot } = await import("/tmp/fly2606-native/scrub.mjs");
const slot = process.argv[2];
scrubToSlot(slot);
const REPO = "/Users/xiaorongli/Dev/flywheel-FLY-2606";
const home = join(slot, "home"), codexHome = join(slot, "codex-home");
for (const d of [home, codexHome, join(slot, "tmp")]) mkdirSync(d, { recursive: true });
process.env.HOME = home;
writeFileSync(join(codexHome, "config.toml"),
  'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n');
const { spawnCodexAppServer } = await import(`${REPO}/packages/teamlead/dist/lead-backends/codex/codex-lead-runtime.js`);
const { CodexLeadProcess } = await import(`${REPO}/packages/teamlead/dist/lead-backends/codex/CodexLeadProcess.js`);
const events = [];
const proc = new CodexLeadProcess({
  experimentalApi: true, requestTimeoutMs: 60000,
  spawnChild: () => spawnCodexAppServer({
    codexBin: "/Users/xiaorongli/.local/bin/codex", mcpArgv: [], codexHome,
    baseEnv: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, TMPDIR: join(slot, "tmp"), USER: "x", SHELL: "/bin/zsh" },
    washSecrets: false,
  }),
});
proc.on("notification", (m, p) => { if (m === "thread/settings/updated") events.push({ at: Date.now(), m, p }); });
await proc.start();
const threadId = await proc.startThread({});
const out = { threadId, phases: [] };
const mark = (label, t0) => out.phases.push({ label, emitted: events.filter(e => e.at >= t0).map(e => e.p), count: events.filter(e => e.at >= t0).length });
let t0 = Date.now();
await proc.updateThreadSettings({ threadId, model: "gpt-6-astra", effort: "low" }); // same value
await new Promise(r => setTimeout(r, 3000));
mark("same-value(low->low)", t0);
t0 = Date.now();
await proc.updateThreadSettings({ threadId, model: "gpt-6-astra", effort: "high" }); // change
await new Promise(r => setTimeout(r, 3000));
mark("change(low->high)", t0);
t0 = Date.now();
await proc.updateThreadSettings({ threadId, model: "gpt-6-astra", effort: "high" }); // same value again
await new Promise(r => setTimeout(r, 3000));
mark("same-value(high->high)", t0);
console.log(JSON.stringify(out, null, 2));
await proc.stop();
