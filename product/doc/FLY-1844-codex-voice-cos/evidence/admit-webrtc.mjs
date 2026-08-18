#!/usr/bin/env node
// FLY-1844: v3 admission over the WebRTC transport the CLI actually builds for it.
// The websocket-only probe cannot answer this: the binary says
// "AVAS realtime calls require realtime v1 or v3" and posts an SDP offer as
// multipart to /backend-api/.../realtime/calls, so v1/v3 are the WebRTC route.
// Here we produce a real SDP offer with a pure-JS WebRTC stack (werift) and hand
// it to thread/realtime/start, then record whether the backend admits the session.

import { spawn, execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { RTCPeerConnection } from "werift";

const LOG = process.env.PROBE_LOG || "admit-webrtc.jsonl";
const MANIFEST = process.env.PROBE_MANIFEST || "admit-webrtc-manifest.json";
const VERSION = process.env.RT_VERSION || "v3";
const VOICE = process.env.RT_VOICE || "cove";
const MODALITY = process.env.RT_MODALITY || "audio";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const log = (dir, obj) =>
  appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), dir, obj }) + "\n");

const CODEX_ARGS = ["--enable", "realtime_conversation", "app-server"];
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
    if (m.method?.startsWith("mcpServer/") || m.method === "thread/started") continue;
    // SDP answers are long; record a digest instead of dumping the blob.
    if (m.method === "thread/realtime/sdp") {
      const s = m.params?.sdp ?? m.params?.answer ?? "";
      log("<<SDP", { chars: String(s).length, sha256: sha(String(s)), head: String(s).slice(0, 120) });
      events.push(m);
      continue;
    }
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
function send(method, params, { redact = false } = {}) {
  const id = nextId++;
  log(">>", { id, method, params: redact ? "<redacted: sdp offer, see SDP-OFFER record>" : params });
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
    probe: "admission-only, webrtc transport",
    startedAt: new Date().toISOString(),
    codexRequested: CODEX_REQUESTED,
    codexResolved: CODEX_RESOLVED,
    codexSha256: CODEX_SHA,
    codexArgv: [CODEX_RESOLVED, ...CODEX_ARGS],
    probeScriptSha256: sha(readFileSync(new URL(import.meta.url))),
    params: { version: VERSION, voice: VOICE, outputModality: MODALITY, transport: "webrtc" },
  };

  // Real SDP offer from a real (pure-JS) peer connection.
  const pc = new RTCPeerConnection({});
  pc.addTransceiver("audio", { direction: "sendrecv" });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = pc.localDescription.sdp;
  manifest.sdpOffer = { chars: sdp.length, sha256: sha(sdp), hasAudioMLine: /^m=audio /m.test(sdp) };
  log("SDP-OFFER", manifest.sdpOffer);

  const init = await send("initialize", {
    clientInfo: { name: "fly1844-admit-webrtc", title: "FLY-1844 webrtc admission probe", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  });
  manifest.cliUserAgent = init?.result?.userAgent ?? null;
  notify("initialized", {});
  await sleep(400);

  const th = await send("thread/start", {});
  const threadId = th?.result?.thread?.id ?? null;
  manifest.threadId = threadId;
  if (!threadId) { manifest.result = { threadStartFailed: true }; writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2)); return finish(1); }

  const startParams = {
    threadId,
    transport: { type: "webrtc", sdp },
    outputModality: MODALITY,
    voice: VOICE,
    version: VERSION,
  };
  const startResp = await send("thread/realtime/start", startParams, { redact: true });
  manifest.startRequestResponse = startResp?.error ? { error: startResp.error } : { result: startResp?.result ?? null };
  if (startResp?.error) {
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
  manifest.sawSdpAnswer = events.some((e) => e.method === "thread/realtime/sdp");
  manifest.result = { admitted: outcome.outcome === "started" };

  await send("thread/realtime/stop", { threadId });
  await sleep(1200);
  try { pc.close(); } catch {}
  manifest.finishedAt = new Date().toISOString();
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  finish(0);
}

function finish(c) {
  try { child.stdin.end(); } catch {}
  setTimeout(() => { try { child.kill("SIGKILL"); } catch {} process.exit(c); }, 1200);
}
main().catch((e) => { log("THROW", String(e)); finish(1); });
