// FLY-2885 zero-quota probe: account/read + thread/realtime/listVoices on codex 0.157.0,
// temp CODEX_HOME whose auth.json is a symlink to the fleet credential. No realtime start.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, lstatSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const BIN = "/Users/xiaorongli/.codex-raya/packages/standalone/releases/0.157.0-aarch64-apple-darwin/bin/codex";
const SRC = join(homedir(), ".codex", "auth.json");
const root = mkdtempSync(join(process.argv[2] || tmpdir(), "fly2885-probe-"));
const home = join(root, "home"), work = join(root, "work");
mkdirSync(home, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
symlinkSync(SRC, join(home, "auth.json"));
writeFileSync(join(home, "config.toml"),
  'forced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\n[features]\nrealtime_conversation = true\n', { mode: 0o600 });
const before = statSync(SRC).mtimeMs;
const env = { HOME: home, PATH: process.env.PATH, CODEX_HOME: home, TMPDIR: work };
const child = spawn(BIN, ["--enable", "realtime_conversation", "app-server"], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", id = 1; const pending = new Map();
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
child.stderr.on("data", () => {});
const rpc = (method, params) => new Promise((r) => { const n = id++; pending.set(n, r); child.stdin.write(JSON.stringify({ id: n, method, params }) + "\n"); setTimeout(() => { if (pending.has(n)) { pending.delete(n); r({ error: { message: "timeout" } }); } }, 15000); });
const out = {};
out.init = (await rpc("initialize", { clientInfo: { name: "fly2885-probe", title: null, version: "0" }, capabilities: { experimentalApi: true } })).error ?? "ok";
child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
const acct = await rpc("account/read", {});
out.account = { type: acct.result?.account?.type ?? null, planType: acct.result?.account?.planType ?? null, error: acct.error?.message ?? null };
const lv = await rpc("thread/realtime/listVoices", {});
out.listVoices = lv.result ?? lv.error;
child.kill("SIGTERM");
await new Promise((r) => child.on("exit", r));
out.authStillSymlink = lstatSync(join(home, "auth.json")).isSymbolicLink();
rmSync(root, { recursive: true, force: true });
out.sourceSurvivesRm = statSync(SRC).isFile();
out.sourceMtimeChanged = statSync(SRC).mtimeMs !== before;
console.log(JSON.stringify(out, null, 1));
