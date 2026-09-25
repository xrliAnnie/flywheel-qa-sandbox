import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const S = process.argv[2];
const c = spawn("/Users/xiaorongli/.codex-raya/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex", ["app-server"], { cwd: S + "/work", env: { HOME: S + "/home", CODEX_HOME: S + "/home", PATH: process.env.PATH }, stdio: ["pipe", "pipe", "ignore"] });
c.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "orphan", title: null, version: "0" }, capabilities: { experimentalApi: true } } }) + "\n");
c.stdout.once("data", () => { writeFileSync(S + "/child.pid", String(c.pid)); process.kill(process.pid, "SIGKILL"); });
