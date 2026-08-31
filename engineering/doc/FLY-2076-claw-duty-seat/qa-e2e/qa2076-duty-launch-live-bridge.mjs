// QA FLY-2076 (independent): compose the two halves the shipped harnesses test
// separately — a REAL booted Bridge + the REAL launcher provisioning script —
// and prove the Claw seat actually flips a real access.json mention gate.
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
const root = "/Users/xiaorongli/Dev/flywheel-FLY-2076";
const tl = (p) => import(join(root, "packages/teamlead/dist", p));
const { createBridgeApp } = await tl("bridge/plugin.js");
const { StateStore } = await tl("StateStore.js");
const { resolveSelfIdentity } = await tl("roundtable-allowbots.js");

const TOKEN = process.env.TEST_BOT_TOKEN_1;
if (!TOKEN) { console.error("FATAL: TEST_BOT_TOKEN_1 unset"); process.exit(2); }
const CHANNEL = "1519421055805165842";
const tmp = mkdtempSync(join(tmpdir(), "qa2076-launch-"));
const results = [];
const ok = (n, c, d = "") => results.push([c, `${n}${d ? ` — ${d}` : ""}`]);

// Real Discord identity for the alert dispatcher bot (no fake id).
const dispatcherId = (await resolveSelfIdentity(TOKEN)).id;
ok("real Discord resolves the dispatcher bot identity", /^\d{17,20}$/.test(dispatcherId), dispatcherId);

const projects = [{
  projectName: "flywheel", projectRoot: "/tmp/qa2076",
  leads: [
    { agentId: "claude-infra-bot-lead", chatChannel: "c-claw", match: { labels: ["infra"] }, alertChannel: CHANNEL, botUserId: "100000000000000001" },
    { agentId: "flywheel-eng-lead", chatChannel: "c-eng", match: { labels: ["eng"] }, botUserId: "100000000000000003" },
  ],
}];
const projectsFile = join(tmp, "projects.json");
writeFileSync(projectsFile, JSON.stringify(projects));

const store = await StateStore.create(":memory:");
const dispatcherHolder = { current: null };
const app = createBridgeApp(store, projects, {
  host: "127.0.0.1", port: 0, dbPath: ":memory:", notificationChannel: "c",
  defaultLeadAgentId: "flywheel-eng-lead", stuckThresholdMinutes: 15,
  stuckCheckIntervalMs: 300000, orphanThresholdMinutes: 60,
  founderConsent: { decisionMode: "off" },
  apiToken: "shared-api", alertDutyToken: "duty-only",
}, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
   undefined, undefined, undefined, undefined, undefined, undefined,
   { alertDuty: { dispatcherBotUserId: dispatcherHolder, alertHub: { current: undefined } } });
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
dispatcherHolder.current = dispatcherId; // what startBridge does after /users/@me

// A real, pre-existing access.json with the alerts group in the LOCKED shape.
const stateDir = join(tmp, "discord-state");
const { mkdirSync } = await import("node:fs");
mkdirSync(stateDir, { recursive: true });
const accessFile = join(stateDir, "access.json");
writeFileSync(accessFile, JSON.stringify({ allowBots: ["999999999999999999"], groups: { [CHANNEL]: { requireMention: true, allowFrom: ["someone"] } } }, null, 2));

const run = (bin, args, env) => new Promise((done) =>
  execFile(bin, args, { env, encoding: "utf8" }, (e, so, se) => done({ code: e?.code ?? 0, stdout: so ?? "", stderr: se ?? "" })));

const provision = join(root, "packages/teamlead/scripts/lead-duty-provision.sh");
const envBase = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  LEAD_ID: "claude-infra-bot-lead", PROJECT_NAME: "flywheel",
  FLYWHEEL_PROJECTS_FILE: projectsFile, FLYWHEEL_BRIDGE_URL: base,
  DISCORD_STATE_DIR: stateDir, TEAMLEAD_API_TOKEN: "shared-api",
  FLYWHEEL_ALERT_DUTY_SEAT_CLI: join(root, "packages/teamlead/dist/alert-duty-seat-cli.js"),
  FLYWHEEL_ALERT_DUTY_GATE_SCRIPT: join(root, "packages/teamlead/scripts/apply-alert-duty-gate.sh"),
};

// 1. The duty seat, with a capability token, against the live Bridge.
const seat = await run("bash", [provision], { ...envBase, FLYWHEEL_ALERT_DUTY_TOKEN: "duty-only" });
const line = seat.stdout.split("\n").find((l) => l.startsWith("[alert-duty]")) ?? "";
ok("seat launch line reports seat/channel/gate/dispatcher/token from the LIVE Bridge",
   line.includes("seat=true") && line.includes(`channel=${CHANNEL}`) && line.includes("gate=changed") &&
   line.includes(`dispatcher=${dispatcherId}`) && line.includes("token=set"), line.trim());
const afterTop = JSON.parse(readFileSync(accessFile, "utf8"));
const after = afterTop.groups[CHANNEL];
ok("the REAL access.json alerts group is now全队列 (requireMention off, allowFrom cleared)",
   after.requireMention === false && Array.isArray(after.allowFrom) && after.allowFrom.length === 0,
   JSON.stringify(after));
ok("the real dispatcher bot is ADDED to allowBots without dropping the existing entry",
   afterTop.allowBots.includes(dispatcherId) && afterTop.allowBots.includes("999999999999999999"),
   JSON.stringify(afterTop.allowBots));

// 2. Non-seat control: the same script for another Lead must change nothing.
writeFileSync(accessFile, JSON.stringify({ groups: { [CHANNEL]: { requireMention: true, allowFrom: ["someone"], allowBots: [] } } }, null, 2));
const nonSeat = await run("bash", [provision], { ...envBase, LEAD_ID: "flywheel-eng-lead", FLYWHEEL_ALERT_DUTY_TOKEN: "duty-only" });
const nsLine = nonSeat.stdout.split("\n").find((l) => l.startsWith("[alert-duty]")) ?? "";
const nsAfter = JSON.parse(readFileSync(accessFile, "utf8")).groups[CHANNEL];
ok("negative control: a non-seat Lead reports seat=false and leaves access.json untouched",
   nsLine.includes("seat=false") && nsAfter.requireMention === true && nsAfter.allowFrom.length === 1,
   nsLine.trim());

// 3. Token-less control: the seat must NOT flip the gate without the capability.
writeFileSync(accessFile, JSON.stringify({ groups: { [CHANNEL]: { requireMention: true, allowFrom: ["someone"], allowBots: [] } } }, null, 2));
const noTok = await run("bash", [provision], envBase);
const ntLine = noTok.stdout.split("\n").find((l) => l.startsWith("[alert-duty]")) ?? "";
const ntAfter = JSON.parse(readFileSync(accessFile, "utf8")).groups[CHANNEL];
ok("negative control: no duty token ⇒ gate stays closed (skipped:no_duty_token, access untouched)",
   ntLine.includes("gate=skipped:no_duty_token") && ntAfter.requireMention === true,
   ntLine.trim());

server.close(); store.close?.();
console.log("\n── QA FLY-2076 launcher provisioning against a LIVE Bridge ──");
let fail = 0;
for (const [c, m] of results) { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) fail++; }
console.log(`\nPASS ${results.length - fail} FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
