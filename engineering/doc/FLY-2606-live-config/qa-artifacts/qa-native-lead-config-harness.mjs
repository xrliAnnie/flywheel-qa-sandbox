// FLY-2606 QA — real-native lead-config acceptance.
// Slot-scoped isolated HOME/registry/StateStore + REAL `codex app-server`
// (no stub RPC) behind the real signed Lead inbox socket, driven by the real
// flywheel-comm `lead-config` CLI over a loopback Bridge route.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const { scrubToSlot } = await import("/tmp/fly2606-native/scrub.mjs");
const slot = process.argv[2];
const slotEnv = scrubToSlot(slot);

const REPO = "/Users/xiaorongli/Dev/flywheel-FLY-2606";
const home = join(slot, "home");
const codexHome = join(slot, "codex-home");
const leadStateDir = join(slot, "state/codex-lead/raya__raya");
for (const d of [home, join(home, ".flywheel"), codexHome, join(slot, "tmp"), leadStateDir])
  mkdirSync(d, { recursive: true });
process.env.HOME = home;
process.env.FLYWHEEL_MODELS_CONFIG = join(home, ".flywheel/models.json");
process.env.RAYA_BOT_TOKEN = "slot-test-bot-token-not-a-real-credential";
writeFileSync(process.env.FLYWHEEL_MODELS_CONFIG, JSON.stringify({ version: 1 }));

// ── registry fixture (mirrors the shipped writer contract) ──────────────────
writeFileSync(join(home, ".flywheel/summary-config.json"), JSON.stringify({
  granularity: "per-lead", setBy: "founder", setAt: "2026-09-16T00:00:00Z",
}));
const projectsPath = join(home, ".flywheel/projects.json");
const receiptPath = join(home, ".flywheel/state/summary-registry/migration-receipt.json");
mkdirSync(join(home, ".flywheel/state/summary-registry"), { recursive: true });
const raw = [{
  projectName: "raya", projectRoot: home,
  leads: [{
    agentId: "raya", summaryRole: "producer", backend: "codex-app-server",
    botTokenEnv: "RAYA_BOT_TOKEN", botUserId: "12345678901234567",
    chatChannel: "12345678901234568", match: { labels: ["Engineering"] },
    codexProfile: "full-access", canSpawnRunners: true, codexRunnerActions: true,
    model: "gpt-6-astra", effort: "low",
  }],
}];
const source = JSON.stringify(raw);
writeFileSync(projectsPath, source);

const { compileSummaryAssignments } = await import(`${REPO}/packages/flywheel-comm/dist/summary-assignment.js`);
const { readSummaryGranularity } = await import(`${REPO}/packages/flywheel-comm/dist/summary-config.js`);
const { compileLeadIdentityRows } = await import(`${REPO}/packages/flywheel-comm/dist/lead-identity.js`);
const { getModelConfigSnapshot } = await import(`${REPO}/packages/config/dist/index.js`);
const selection = readSummaryGranularity({ homeDir: home });
writeFileSync(receiptPath, JSON.stringify({
  schemaVersion: 1,
  postImageSha256: createHash("sha256").update(source).digest("hex"),
  summaryAssignmentDigest: compileSummaryAssignments(raw, selection).digest,
  granularity: "per-lead", migratedAt: "2026-09-16T00:00:00Z",
  assignments: [{ projectName: "raya", leadId: "raya", summaryRole: "producer" }],
  projectAggregators: [],
}));

const identity = compileLeadIdentityRows(raw, { homeDir: home, summarySelection: selection })
  .find((r) => r.identity.projectName === "raya" && r.identity.leadId === "raya").identity;

// ── real codex app-server ───────────────────────────────────────────────────
writeFileSync(join(codexHome, "config.toml"), [
  `model = "${identity.model ?? "gpt-6-astra"}"`,
  'model_reasoning_effort = "low"',
  'approval_policy = "never"',
  'sandbox_mode = "workspace-write"',
  "",
].join("\n"));

const { spawnCodexAppServer } = await import(`${REPO}/packages/teamlead/dist/lead-backends/codex/codex-lead-runtime.js`);
const { CodexLeadProcess } = await import(`${REPO}/packages/teamlead/dist/lead-backends/codex/CodexLeadProcess.js`);
const { NativeLeadRuntimeConfig } = await import(`${REPO}/packages/teamlead/dist/lead-backends/codex/NativeLeadRuntimeConfig.js`);
const { CodexLeadInboxServer, resolveCodexLeadInboxSocketPath } = await import(`${REPO}/packages/teamlead/dist/lead-backends/codex/CodexLeadInboxSocket.js`);
const { StateStore } = await import(`${REPO}/packages/teamlead/dist/StateStore.js`);
const { LeadConfigRegistryWriter } = await import(`${REPO}/packages/teamlead/dist/lead-config-registry.js`);
const { LeadConfigRuntimeAdapter } = await import(`${REPO}/packages/teamlead/dist/bridge/lead-config-runtime-adapter.js`);
const { LeadConfigService } = await import(`${REPO}/packages/teamlead/dist/bridge/lead-config-service.js`);
const { createLeadConfigRouter } = await import(`${REPO}/packages/teamlead/dist/bridge/lead-config-routes.js`);
const { ConfirmTokenStore } = await import(`${REPO}/packages/teamlead/dist/bridge/fleet-admin.js`);
const { runLeadConfig } = await import(`${REPO}/packages/flywheel-comm/dist/commands/lead-config.js`);
const { createRequire } = await import("node:module");
const express = createRequire(`${REPO}/packages/teamlead/package.json`)("express");

const BUILD_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ev = { probe: "native-lead-config", slot, slotEnv, head: null, steps: [] };
const errs = [];
let proc, server, http, store, native;
try {
  proc = new CodexLeadProcess({
    experimentalApi: true, requestTimeoutMs: 60000,
    spawnChild: () => spawnCodexAppServer({
      codexBin: "/Users/xiaorongli/.local/bin/codex",
      mcpArgv: [], codexHome,
      baseEnv: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/Users/xiaorongli/.local/bin",
        HOME: home, TMPDIR: join(slot, "tmp"), USER: process.env.USER ?? "x", SHELL: "/bin/zsh",
      },
      washSecrets: false,
    }),
  });
  proc.on("stderr", (c) => errs.push(String(c)));
  await proc.start();
  const threadId = await proc.startThread({});
  const nativePid = proc.childPid ?? null;
  ev.steps.push({ step: "native_boot", threadId, nativePid, codexVersion: "codex-cli 0.153.2" });

  native = new NativeLeadRuntimeConfig({
    config: {
      projectsFile: projectsPath, projectName: "raya", leadId: "raya",
      leadKey: identity.leadKey, identityDigest: identity.identityDigest,
      botUserId: identity.botUserId, modelContextWindow: identity.modelContextWindow,
      stateDir: leadStateDir, codexHome,
    },
    process: proc,
    build: { artifactBuildSha: BUILD_SHA, bootstrapBuildSha: BUILD_SHA },
    log: (m) => ev.steps.push({ step: "native_log", message: m }),
  });
  native.bindOwner(() => true);
  await native.bootstrap(threadId, { model: identity.model, reasoningEffort: identity.effort });
  ev.steps.push({ step: "native_bootstrap", supported: native.hooks.isSupported(), identity: native.hooks.identity() });

  const socketPath = resolveCodexLeadInboxSocketPath(leadStateDir);
  server = new CodexLeadInboxServer({
    socketPath, leadId: "raya", authSecret: process.env.RAYA_BOT_TOKEN,
    socketOwnerId: native.socketOwnerId,
    router: { submitBatch: async () => ({ accepted: 0 }) },
    runtimeConfig: native.hooks,
  });
  await server.listen();

  store = await StateStore.create(join(slot, "state/teamlead.db"));
  const writer = new LeadConfigRegistryWriter({
    store, home, root: REPO, projectsPath, receiptPath,
    env: process.env, modelSnapshot: getModelConfigSnapshot,
  });
  const runtime = new LeadConfigRuntimeAdapter({
    projectsPath, home, env: process.env, runtimeBuildSha: BUILD_SHA,
    stateDir: () => leadStateDir,
  });
  const service = new LeadConfigService({
    store, writer, runtime, tokens: new ConfirmTokenStore(), runtimeBuildSha: BUILD_SHA,
  });
  const app = express();
  app.use("/api/lead-config", createLeadConfigRouter(service));
  http = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const bridgeUrl = `http://127.0.0.1:${http.address().port}`;

  const cli = async (args) => {
    const out = [], err = [];
    const code = await runLeadConfig(args, {
      env: { FLYWHEEL_BRIDGE_URL: bridgeUrl },
      log: (l) => out.push(l), error: (l) => err.push(l),
    });
    return { code, out: out.map((l) => { try { return JSON.parse(l); } catch { return l; } }), err };
  };

  // ① same-value set (no-op)
  const noop = await cli(["set", "--project", "raya", "--lead", "raya", "--effort", "low", "--reason", "QA isolated no-op"]);
  ev.steps.push({ step: "cli_set_noop", exit: noop.code, receipt: noop.out.at(-1), stderr: noop.err });

  // ② effort change
  const change = await cli(["set", "--project", "raya", "--lead", "raya", "--effort", "high", "--reason", "QA isolated effort change"]);
  ev.steps.push({ step: "cli_set_effort_high", exit: change.code, receipt: change.out.at(-1), stderr: change.err });
  const changeOpId = change.out.at(-1)?.operation?.input?.operationId;

  // native settings actually read back from the real binary
  ev.steps.push({ step: "native_readback_after_change", settings: await proc.readThreadSettings(threadId) });

  // a real turn → rollout turn_context observation
  try {
    const notes = [];
    proc.on("notification", (m) => notes.push(m));
    const turnId = await proc.startTurn({ threadId, input: [{ type: "text", text: "ping" }] });
    for (let i = 0; i < 24 && !notes.includes("turn/completed"); i++)
      await new Promise((r) => setTimeout(r, 2500));
    await new Promise((r) => setTimeout(r, 4000));
    ev.steps.push({ step: "native_turn_notifications", methods: [...new Set(notes)], sawCompleted: notes.includes("turn/completed") });
    const rollout = await proc.readThreadRolloutPath(threadId);
    const contexts = readFileSync(rollout, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r?.type === "turn_context")
      .map((r) => ({ turn_id: r.payload?.turn_id, model: r.payload?.model, effort: r.payload?.effort, ts: r.timestamp }));
    ev.steps.push({ step: "native_turn", turnId, rollout, turnContexts: contexts });
  } catch (e) {
    ev.steps.push({ step: "native_turn", error: e instanceof Error ? e.message : String(e) });
  }
  let afterTurn;
  for (let i = 0; i < 6; i++) {
    afterTurn = await cli(["status", "--operation-id", changeOpId]);
    if (afterTurn.out.at(-1)?.effectiveStatus === "observed") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  ev.steps.push({ step: "cli_status_after_turn", exit: afterTurn.code, receipt: afterTurn.out.at(-1) });
  try {
    ev.steps.push({ step: "runtime_config_state", state: JSON.parse(readFileSync(join(leadStateDir, "runtime-config.json"), "utf8")) });
  } catch (e) { ev.steps.push({ step: "runtime_config_state", error: String(e) }); }

  // ③ rollback
  const rollback = await cli(["rollback", "--operation-id", changeOpId, "--reason", "QA isolated rollback"]);
  ev.steps.push({ step: "cli_rollback", exit: rollback.code, receipt: rollback.out.at(-1), stderr: rollback.err });
  ev.steps.push({ step: "native_readback_after_rollback", settings: await proc.readThreadSettings(threadId) });
  ev.steps.push({ step: "registry_final", projects: JSON.parse(readFileSync(projectsPath, "utf8"))[0].leads[0] });
  ev.ok = true;
} catch (e) {
  ev.ok = false;
  ev.error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
} finally {
  ev.stderr = errs.join("").slice(-3000);
  try { native?.close(); } catch {}
  try { await server?.close(); } catch {}
  try { http?.close(); } catch {}
  try { store?.close(); } catch {}
  try { await proc?.stop(); } catch {}
}
writeFileSync(join(slot, "native-lead-config-evidence.json"), JSON.stringify(ev, null, 2));
console.log(JSON.stringify(ev, null, 2));
