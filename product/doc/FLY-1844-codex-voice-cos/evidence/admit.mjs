#!/usr/bin/env node
// FLY-1844 realtime ADMISSION probe (0.147.0 re-run of the FLY-1443 v3 question).
//
// Deliberately narrower than FLY-1443's probe.mjs: it answers ONE question —
// does the backend ADMIT this (version, voice, modality) combination? — and then
// stops. No audio is fed, no model turn is taken, so a run costs ~0 subscription
// quota. Use probe.mjs (FLY-1443) for the full audio loop once a version is admitted.
//
// Usage:
//   CODEX_BIN=<abs versioned path> RT_VERSION=v3 RT_VOICE=cove RT_MODALITY=audio \
//   PROBE_LOG=x.jsonl PROBE_MANIFEST=x-manifest.json node admit.mjs
//
// Discipline (inherited from FLY-1443): never writes ~/.codex/config.toml, never
// calls codex-profile, never uses codex-with-fallback, pins a versioned absolute
// binary (~/.local/bin/codex is a contended, mutating symlink).

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

const LOG = process.env.PROBE_LOG || "admit.jsonl";
const MANIFEST = process.env.PROBE_MANIFEST || "admit-manifest.json";
const VERSION = process.env.RT_VERSION || "v3";
const VOICE = process.env.RT_VOICE || "cove";
const MODALITY = process.env.RT_MODALITY || "audio";
const TRANSPORT = process.env.RT_TRANSPORT || "websocket";
const NO_ENABLE_FLAG = process.env.PROBE_NO_ENABLE_FLAG === "1";
const NO_EXPERIMENTAL_API = process.env.PROBE_NO_EXPERIMENTAL_API === "1";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (dir, obj) =>
  appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), dir, obj }) + "\n");

const CODEX_ARGS = NO_ENABLE_FLAG
  ? ["app-server"]
  : ["--enable", "realtime_conversation", "app-server"];

const CODEX_REQUESTED =
  process.env.CODEX_BIN || execFileSync("/usr/bin/which", ["codex"]).toString().trim();
const CODEX_RESOLVED = realpathSync(CODEX_REQUESTED);
const CODEX_SHA = sha(readFileSync(CODEX_RESOLVED));

const child = spawn(CODEX_RESOLVED, CODEX_ARGS, { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
const waiters = new Map();
const events = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    // Noise filters are the same as FLY-1443's probe; recorded here so the log's
    // nature (event log, not raw stdout) stays honest.
    if (m.method?.startsWith("mcpServer/") || m.method === "thread/started") continue;
    log("<<", m);
    if (m.method?.startsWith("thread/realtime/")) events.push(m);
    if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
child.stderr.on("data", (d) => {
  const s = d.toString().replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (s) log("ERR", s);
});
child.on("exit", (code, sig) => log("EXIT", { code, sig }));

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  log(">>", { id, method, params });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((r) => {
    waiters.set(id, r);
    setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); r({ __timeout: true, id, method }); } }, 30000);
  });
}
const notify = (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForStartOutcome(timeoutMs = 25000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const ev = events.find(
        (e) => e.method === "thread/realtime/started" || e.method === "thread/realtime/error",
      );
      if (ev) {
        return resolve({
          outcome: ev.method === "thread/realtime/started" ? "started" : "error",
          event: ev,
          waitedMs: Date.now() - t0,
        });
      }
      if (Date.now() - t0 > timeoutMs) return resolve({ outcome: "timeout", event: null, waitedMs: Date.now() - t0 });
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function main() {
  const manifest = {
    issue: "FLY-1844",
    probe: "admission-only",
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    codexRequested: CODEX_REQUESTED,
    codexResolved: CODEX_RESOLVED,
    codexSha256: CODEX_SHA,
    codexArgv: [CODEX_RESOLVED, ...CODEX_ARGS],
    probeScriptSha256: sha(readFileSync(new URL(import.meta.url))),
    params: { version: VERSION, voice: VOICE, outputModality: MODALITY, transport: TRANSPORT },
    gates: { enableFlag: !NO_ENABLE_FLAG, experimentalApiCapability: !NO_EXPERIMENTAL_API },
  };

  const init = await send("initialize", {
    clientInfo: { name: "fly1844-admit", title: "FLY-1844 realtime admission probe", version: "0.0.1" },
    ...(NO_EXPERIMENTAL_API ? {} : { capabilities: { experimentalApi: true } }),
  });
  manifest.cliUserAgent = init?.result?.userAgent ?? null;
  notify("initialized", {});
  await sleep(400);

  // Read-only: which voices does THIS build advertise, and does it now list v3?
  const voices = await send("thread/realtime/listVoices", {});
  manifest.listVoices = voices?.error ? { error: voices.error } : (voices?.result ?? null);
  log("STEP", { step: "listVoices", response: voices });

  const th = await send("thread/start", {});
  const threadId = th?.result?.thread?.id ?? null;
  manifest.threadId = threadId;
  manifest.cliVersionReported = th?.result?.thread?.cliVersion ?? null;
  if (!threadId) {
    log("STEP", { step: "thread/start-failed", response: th });
    manifest.result = { threadStartFailed: true };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    return finish(1);
  }

  const startParams = {
    threadId,
    transport: { type: TRANSPORT },
    outputModality: MODALITY,
    voice: VOICE,
    version: VERSION,
  };
  const startResp = await send("thread/realtime/start", startParams);
  manifest.startRequestResponse = startResp?.error ? { error: startResp.error } : { result: startResp?.result ?? null };
  if (startResp?.error) {
    // Synchronous rejection = local app-server gate, not the backend.
    log("GATE-RESULT", { rejectedAtRequest: true, error: startResp.error });
    manifest.result = { admitted: false, rejectedAtRequest: true };
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    return finish(0);
  }

  const outcome = await waitForStartOutcome();
  log("START-OUTCOME", { outcome: outcome.outcome, waitedMs: outcome.waitedMs, event: outcome.event });
  manifest.startOutcome = {
    outcome: outcome.outcome,
    waitedMs: outcome.waitedMs,
    message: outcome.event?.params?.message ?? null,
  };
  manifest.result = { admitted: outcome.outcome === "started" };

  // Stop immediately either way — this probe never takes a model turn.
  await send("thread/realtime/stop", { threadId });
  await sleep(1200);
  manifest.finishedAt = new Date().toISOString();
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  finish(0);
}

function finish(c) {
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} process.exit(c); }, 1200);
}
main().catch((e) => { log("THROW", String(e)); finish(1); });
