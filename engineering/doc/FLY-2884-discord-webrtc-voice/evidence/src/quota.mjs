// FLY-2884: read-only subscription quota + auth identity snapshot. No login/logout, no model calls.
// Usage: node quota.mjs <label>   → appends one JSON line to runs/quota.jsonl
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, statSync, mkdirSync, existsSync, symlinkSync, lstatSync } from "node:fs";

const ROOT = "/tmp/fly2884-proto";
const HOME = `${ROOT}/home-quota`;
const label = process.argv[2] || "unlabeled";
mkdirSync(HOME, { recursive: true });
if (!existsSync(`${HOME}/auth.json`)) symlinkSync(`${process.env.HOME}/.codex/auth.json`, `${HOME}/auth.json`);
if (!lstatSync(`${HOME}/auth.json`).isSymbolicLink()) throw new Error("auth_json_not_symlink");

function authSnapshot() {
  const p = `${process.env.HOME}/.codex/auth.json`;
  const d = JSON.parse(readFileSync(p, "utf8"));
  const part = (d.tokens?.id_token || "").split(".")[1] || "";
  const c = JSON.parse(Buffer.from(part, "base64url").toString("utf8") || "{}");
  return { mtime: Math.floor(statSync(p).mtimeMs / 1000), email: c.email ?? null, plan: c["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null, lastRefresh: d.last_refresh ?? null };
}

const env = { ...process.env, CODEX_HOME: HOME };
delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
const child = spawn("codex", ["app-server"], { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
let id = 1;
const rpc = (method, params) => new Promise((res) => { const k = id++; pending.set(k, res); child.stdin.write(JSON.stringify({ id: k, method, params }) + "\n"); setTimeout(() => { if (pending.has(k)) { pending.delete(k); res({ error: { message: "timeout" } }); } }, 20000); });

const before = authSnapshot();
await rpc("initialize", { clientInfo: { name: "fly2884-quota", title: null, version: "0.0.1" }, capabilities: { experimentalApi: true } });
child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
const rl = await rpc("account/rateLimits/read", {});
const us = await rpc("account/usage/read", {});
child.kill("SIGTERM");
const rec = { t: new Date().toISOString(), label, auth: before, rateLimits: rl.result ?? null, error: rl.error ?? null, usage: us.result ?? null, usageError: us.error ?? null };
appendFileSync(`${ROOT}/runs/quota.jsonl`, JSON.stringify(rec) + "\n");
console.log(JSON.stringify(rec));
setTimeout(() => process.exit(0), 300);
