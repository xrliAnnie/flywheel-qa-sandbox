// FLY-2886 local real-host voice parent smoke: no provider stubs, real codex 0.156.1,
// real Homebrew node, subscription auth by realpath to the production auth.json.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, lstatSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
import { join } from "node:path";
const WT = "/Users/xiaorongli/Dev/flywheel-FLY-2886";
const { startVoiceCapabilityParent } = await import(`${WT}/packages/teamlead/dist/lead-capabilities/voice-capability-parent.js`);
const base = realpathSync(mkdtempSync(join(homedir(), ".flywheel", "fly2886-smoke-")));
const dir = (p) => (mkdirSync(p, { recursive: true, mode: 0o700 }), chmodSync(p, 0o700), p);
const home = dir(join(base, "home"));
dir(join(home, ".flywheel"));
const head = execFileSync("/usr/bin/git", ["-C", WT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(join(home, ".flywheel", "deployed-sha"), `${head}\n`, { mode: 0o644 });
writeFileSync(join(home, ".flywheel", "summary-config.json"), JSON.stringify({ granularity: "per-lead", setBy: "smoke", setAt: new Date().toISOString() }));
const project = dir(join(base, "project"));
execFileSync("/usr/bin/git", ["init", "-q", project]);
const LEAD = "flywheel-eng-lead";
dir(join(project, ".lead", LEAD));
writeFileSync(join(project, ".lead", LEAD, "identity.md"), "# Smoke Lead\n\nFLY-2886 real-host parent smoke persona.\n");
for (const name of ["config.yaml", "menus", "agents", "templates"])
  require_("fs").cpSync(`${WT}/.flywheel/${name}`, join(project, ".flywheel", name), { recursive: true });
const projectsPath = join(base, "projects.json");
writeFileSync(projectsPath, JSON.stringify([{ projectName: "flywheel", projectRoot: project, projectRepo: "acme/smoke",
  leads: [{ agentId: LEAD, summaryRole: "producer", backend: "claude-code", chatChannel: "12345678901234567", match: { labels: ["Smoke"] }, voiceBackground: { enabled: true, browser: process.env.BROWSER ?? "off" } }] }]));
const codexHome = dir(join(base, "c", "h"));
const activation = dir(join(base, "c", "a"));
const state = dir(join(base, "state"));
const realAuth = realpathSync(join(homedir(), ".codex", "auth.json"));
const env = { PATH: process.env.PATH, HOME: home, LANG: "en_US.UTF-8", FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9", FLYWHEEL_API_TOKEN: "smoke-token", ...(process.env.WITH_LINEAR ? { LINEAR_API_KEY: process.env.LINEAR_API_KEY } : {}) };
const t0 = Date.now();
try {
  const parent = await startVoiceCapabilityParent({ projectName: "flywheel", leadId: LEAD, sessionId: "11111111-2222-4333-8444-555555555555",
    leaseFence: "smoke-fence", browserMode: process.env.BROWSER ?? "off", codexHome, codexBin: join(homedir(), ".flywheel/codex-standalone/0.156.1/bin/codex"),
    activationRoot: activation, projectsPath, stateDir: state, authSourcePath: realAuth, assertLeaseCurrent: () => {}, env });
  const link = join(codexHome, "auth.json");
  console.log(JSON.stringify({ result: "PARENT_OK", ms: Date.now() - t0, operations: parent.manifest.operationIds.length,
    unavailableIntegrations: parent.manifest.unavailableIntegrations, integrations: parent.manifest.integrations.map((i) => i.id),
    authIsLink: lstatSync(link).isSymbolicLink(), authInodeMatchesProduction: statSync(link).ino === statSync(realAuth).ino,
    closure: parent.nodeRuntimeClosure && { files: parent.nodeRuntimeClosure.files.length, directories: parent.nodeRuntimeClosure.directories.length },
    mcp: parent.mcp.included }, null, 1));
  if (process.env.APPSERVER) {
    const { CodexLeadProcess, spawnCodexAppServer } = await import(`${WT}/packages/teamlead/dist/codex-process.js`);
    const codexBin = join(homedir(), ".flywheel/codex-standalone/0.156.1/bin/codex");
    const work = dir(join(base, "c", "w"));
    const proc = new CodexLeadProcess({
      spawnChild: () => spawnCodexAppServer({ codexBin, mcpArgv: [...parent.permissionArgv, ...parent.mcp.argv, ...(process.env.NOAPPS ? ["-c", "features.apps=false"] : [])], codexHome, cwd: parent.cwd,
        baseEnv: { HOME: codexHome, TMPDIR: work, PATH: process.env.PATH, LANG: "en_US.UTF-8" },
        voiceProfile: { openAiApiKey: "smoke-not-used" }, profile: "voice-capability", capabilityModelEnv: parent.capabilityModelEnv }),
      experimentalApi: true, knownServerMethods: [], requestTimeoutMs: 60000, maxJsonLineBytes: 1024 * 1024,
      shutdownGraceMs: 50, shutdownTermMs: 5000, shutdownKillMs: 5000, clientInfo: { name: "flywheel-voice-codex", version: "0.1.0" } });
    const t1 = Date.now();
    await proc.start();
    const account = await proc.request("account/read", { refreshToken: false });
    const config = await proc.request("config/read", { cwd: parent.cwd, includeLayers: false });
    let configOk = "unchecked";
    try { await parent.verifyEffectiveConfig(config.result.config); configOk = "verified"; } catch (e) { configOk = `mismatch:${e.message}`; }
    const skills = await proc.request("skills/list", { cwds: [parent.cwd], forceReload: true });
    let skillsOk = "unchecked";
    try { await parent.verifyEffectiveSkills(skills.result, parent.cwd); skillsOk = "verified"; } catch (e) { skillsOk = `mismatch:${e.message}`; }
    const status = await proc.request("mcpServerStatus/list", { limit: 100 });
    const servers = (status.result?.data ?? []).map((row) => ({ name: row.name,
      tools: Array.isArray(row.tools) ? row.tools.map((t) => t.name) : Object.keys(row.tools ?? {}) }));
    console.log(JSON.stringify({ appServer: "STARTED", ms: Date.now() - t1, accountType: account.result?.account?.type,
      forcedLogin: config.result?.config?.forced_login_method ?? null, configOk, skillsOk, servers, statusError: status.error ?? null }, null, 1));
    await proc.stop();
  }
  if (process.env.KEEP) { console.log("KEEP", base); await new Promise((r) => setTimeout(r, Number(process.env.KEEP))); }
  await parent.close();
} catch (error) {
  console.log(JSON.stringify({ result: "PARENT_ERR", ms: Date.now() - t0, message: error?.message, stack: String(error?.stack).split("\n").slice(0, 8) }, null, 1));
} finally {
  rmSync(base, { recursive: true, force: true });
}
