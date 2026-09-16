import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { buildBrowserSandboxSpec } from "/Users/xiaorongli/Dev/flywheel-FLY-2519/packages/teamlead/dist/lead-capabilities/browser-sandbox.js";
const require = createRequire("/Users/xiaorongli/Dev/flywheel-FLY-2519/packages/teamlead/package.json");
const root = realpathSync(mkdtempSync("/tmp/fw2519r/chrome-"));
const pr = join(root, "project"), pa = join(root, "qa"); mkdirSync(pr, { mode: 0o700 }); mkdirSync(pa, { mode: 0o700 });
const q = mkdtempSync(join(pa, "browser-")); for (const n of ["profile", "tmp", "artifacts"]) mkdirSync(join(q, n), { mode: 0o700 });
const l = buildBrowserSandboxSpec({ packageRoot: dirname(require.resolve("chrome-devtools-mcp/package.json")), nodeExecutable: process.execPath, chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", projectRoot: pr, qaRoot: q, proxyPort: 4311 });
const launcher = join(q, "chrome-arm64");
const cases = {
  version: ["--version"],
  headlessDump: ["--user-data-dir=" + join(q, "profile"), "--no-first-run", "--headless=new", "--dump-dom", "about:blank"],
  headfulPort: ["--user-data-dir=" + join(q, "profile2"), "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "about:blank"],
};
const variants = {
  wrapperVersion: [launcher, "--version"],
  wrapperVersion2: [launcher, "--version"],
  archDirect: ["/usr/bin/arch", "-arch", "arm64", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--version"],
  chromeDirect: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--version"],
};
for (const [k, argv] of Object.entries(variants)) {
  const r = spawnSync(l.command, ["-p", l.policy, ...argv], { cwd: l.cwd, env: l.env, encoding: "utf8", timeout: 25000, maxBuffer: 1 << 20 });
  console.log("**", k, "status", r.status, "signal", r.signal, "out", (r.stdout||"").trim().slice(0,80), "err", (r.stderr||"").trim().slice(0,200).replaceAll("\n"," | "));
}
for (const [k, args] of Object.entries(cases)) {
  const r = spawnSync(l.command, ["-p", l.policy, launcher, ...args], { cwd: l.cwd, env: l.env, encoding: "utf8", timeout: 25000, maxBuffer: 1 << 20 });
  console.log("==", k, "status", r.status, "signal", r.signal, "err", (r.error||{}).code || "");
  console.log("   stdout:", (r.stdout || "").slice(0, 300).replaceAll("\n", " | "));
  console.log("   stderr:", (r.stderr || "").slice(0, 800).replaceAll("\n", " | "));
}
rmSync(root, { recursive: true, force: true });
