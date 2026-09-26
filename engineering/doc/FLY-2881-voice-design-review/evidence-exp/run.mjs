// FLY-2881 minimal experiment: realtime (API key via env) + background turn (ChatGPT auth via symlinked auth.json).
// Read-only. Realtime session capped at 30s. Never prints secrets.
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";

const EXP = "/tmp/fly2881-exp";
const LOG = `${EXP}/log-${process.argv[2] || "run"}.jsonl`;
const HOME_DIR = `${EXP}/home`;
const WORK = `${EXP}/work`;
const t0 = Date.now();
writeFileSync(LOG, "");
const redact = (s) => s.replace(/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***").replace(/eyJ[A-Za-z0-9_\-.]{20,}/g, "jwt-***");
const log = (kind, data) => {
  const line = JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(2), kind, data });
  appendFileSync(LOG, redact(line) + "\n");
};

const child = spawn("codex", ["app-server"], {
  cwd: WORK,
  env: { ...process.env, CODEX_HOME: HOME_DIR },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
let nextId = 1;
const pending = new Map();
const waiters = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("nonjson", line.slice(0, 300)); continue; }
    if (msg.id !== undefined && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      const { resolve, method } = pending.get(msg.id);
      pending.delete(msg.id);
      log("response", { method, error: msg.error, result: summarize(method, msg.result) });
      resolve(msg);
    } else if (msg.method && msg.id !== undefined) {
      log("server_request", { method: msg.method });
      child.stdin.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "declined by experiment" } }) + "\n");
    } else if (msg.method) {
      const p = msg.params || {};
      const keep = ["thread/realtime/started", "thread/realtime/error", "thread/realtime/closed", "thread/realtime/itemAdded",
        "turn/started", "turn/completed", "item/started", "item/completed", "error", "account/updated", "thread/status/changed"];
      if (keep.includes(msg.method) || msg.method.startsWith("thread/realtime/")) {
        log("notify", { method: msg.method, params: shorten(p) });
      }
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  }
});
child.stderr.on("data", (d) => log("stderr", d.toString().slice(0, 500)));
child.on("exit", (code, sig) => log("exit", { code, sig }));

function shorten(p) {
  const s = JSON.stringify(p);
  return s.length > 1200 ? JSON.parse(JSON.stringify(p, (k, v) => (typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v))) : p;
}
function summarize(method, r) {
  if (!r) return r;
  if (method === "thread/start") return { threadId: r.thread?.id ?? r.threadId, model: r.model, sandbox: r.sandbox, approvalPolicy: r.approvalPolicy };
  if (method === "account/read") {
    const a = r.account || {};
    const em = a.email ? a.email.replace(/^(.{3}).*(@.*)$/, "$1***$2") : undefined;
    return { type: a.type, planType: a.planType, email: em, requiresOpenaiAuth: r.requiresOpenaiAuth };
  }
  return shorten(r);
}
function rpc(method, params, timeoutMs = 20000) {
  const id = nextId++;
  log("request", { method });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  return new Promise((resolve) => {
    pending.set(id, { resolve, method });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); log("timeout", { method }); resolve({ error: { message: "timeout" } }); } }, timeoutMs);
  });
}
function waitFor(pred, ms) {
  return new Promise((resolve) => {
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hardStop = setTimeout(() => { log("hard_stop", {}); child.kill("SIGTERM"); setTimeout(() => process.exit(0), 1500); }, 150000);

(async () => {
  await rpc("initialize", { clientInfo: { name: "fly2881-exp", title: null, version: "0.0.1" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  await rpc("account/read", {});
  const th = await rpc("thread/start", { cwd: WORK, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
  const threadId = th.result?.thread?.id ?? th.result?.threadId;
  if (!threadId) { log("abort", "no thread"); child.kill(); process.exit(0); }

  // Realtime: websocket V2, text output (no audio), auto handoffs (clientManagedHandoffs=false).
  const rtStartAt = Date.now();
  const rt = await rpc("thread/realtime/start", {
    threadId, outputModality: "text", clientManagedHandoffs: false, includeStartupContext: false,
    transport: { type: "websocket" }, version: "v2",
    prompt: "You are a test voice front. For ANY request about files, immediately call the background_agent tool with the user's words. Keep replies to one short sentence.",
  });
  let realtimeOk = !rt.error;
  const started = realtimeOk ? await waitFor((m) => m.method === "thread/realtime/started" || m.method === "thread/realtime/error" || m.method === "thread/realtime/closed", 10000) : null;
  realtimeOk = realtimeOk && started?.method === "thread/realtime/started";
  log("realtime_status", { realtimeOk, got: started?.method ?? null });

  let turnViaHandoff = false;
  if (realtimeOk) {
    await rpc("thread/realtime/appendText", { threadId, text: "请读取当前目录下的 hello.txt，告诉我第一行写了什么。", role: "user" });
    await rpc("thread/realtime/appendSpeech", { threadId, text: "请处理上面这个读文件的请求。" });
    const ts = await waitFor((m) => m.method === "turn/started", 15000);
    turnViaHandoff = !!ts;
    log("handoff_turn_started", { turnViaHandoff });
  }
  if (!turnViaHandoff) {
    // Same code path as a background_agent turn (ordinary user turn on the thread).
    await rpc("turn/start", { threadId, input: [{ type: "text", text: "Read ./hello.txt and reply with its first line only. Do not modify anything." }], turnTrigger: "fly2881-exp" });
  }
  // Keep realtime at most 30s.
  const stopRealtimeIn = Math.max(0, 30000 - (Date.now() - rtStartAt));
  const stopTimer = realtimeOk ? setTimeout(() => { rpc("thread/realtime/stop", { threadId }); log("realtime_stop_sent", {}); }, stopRealtimeIn) : null;
  const done = await waitFor((m) => m.method === "turn/completed", 110000);
  log("turn_done", { completed: !!done, status: done?.params?.turn?.status, error: done?.params?.turn?.error });
  if (process.argv[2] === "2" && realtimeOk) { log("observe_voice_reply", {}); await sleep(Math.min(9000, Math.max(0, 29000 - (Date.now() - rtStartAt)))); }
  if (stopTimer) { clearTimeout(stopTimer); await rpc("thread/realtime/stop", { threadId }, 5000); }
  await sleep(1000);
  clearTimeout(hardStop);
  child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 1500);
})();
