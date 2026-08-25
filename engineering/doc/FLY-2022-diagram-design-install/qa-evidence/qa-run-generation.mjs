import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT = "/Users/xiaorongli/Dev/flywheel-FLY-2022";
const SCRATCH = "/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2022/a56a953e-2991-4790-83a9-913e7b4ab4dc/scratchpad";
const PROMPT_PATH = path.join(SCRATCH, "qa-request.md");
const OUT_HTML = path.join(PROJECT, "engineering/doc/FLY-2022-diagram-design-install/qa-evidence/qa-independent-generated.html");
const TRANSCRIPT = path.join(SCRATCH, "qa-transcript.jsonl");
const STDERR_LOG = path.join(SCRATCH, "qa-stderr.log");
const EVIDENCE = path.join(SCRATCH, "qa-generation-evidence.json");

function sha256File(p) { return createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

function dirFingerprint(root) {
  if (!fs.existsSync(root)) return { exists: false };
  const st = fs.statSync(root);
  if (st.isFile()) return { exists: true, files: 1, sha256: sha256File(root) };
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile()) files.push(fp);
    }
  })(root);
  files.sort();
  const h = createHash("sha256");
  for (const f of files) { h.update(path.relative(root, f)); h.update("\0"); h.update(fs.readFileSync(f)); h.update("\0"); }
  return { exists: true, files: files.length, sha256: h.digest("hex") };
}

const home = os.homedir();
function snapshot() {
  return {
    projectSkill: dirFingerprint(path.join(PROJECT, ".claude/skills/diagram-design")),
    projectConfig: dirFingerprint(path.join(PROJECT, ".diagram-design")),
    userPaths: {
      diagramDesignHome: dirFingerprint(path.join(home, ".diagram-design")),
      claudeSkill: dirFingerprint(path.join(home, ".claude/skills/diagram-design")),
      agentSkill: dirFingerprint(path.join(home, ".agents/skills/diagram-design")),
      codexSkill: dirFingerprint(path.join(home, ".codex/skills/diagram-design")),
      agentLock: dirFingerprint(path.join(home, ".agents/.skill-lock.json")),
    },
  };
}

const before = snapshot();
if (fs.existsSync(OUT_HTML)) fs.unlinkSync(OUT_HTML);

const args = [
  "-p", "--no-session-persistence", "--no-chrome",
  "--output-format", "stream-json", "--verbose",
  "--permission-mode", "acceptEdits",
  "--allowedTools", "Skill,Read,Write,Edit,Glob,Grep,Bash(python3 .claude/skills/diagram-design/scripts/self_check.py:*)",
  "--disallowedTools", "WebFetch,WebSearch",
];

const prompt = fs.readFileSync(PROMPT_PATH, "utf8");
const startedAt = new Date().toISOString();
const out = fs.createWriteStream(TRANSCRIPT);
const err = fs.createWriteStream(STDERR_LOG);

const child = spawn("claude", args, { cwd: PROJECT, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.pipe(out);
child.stderr.pipe(err);
child.stdin.end(prompt);

const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 30 * 60 * 1000);
let timedOut = false;
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  setTimeout(() => {
    const finishedAt = new Date().toISOString();
    const after = snapshot();
    const lines = fs.readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean);
    const skillEvents = [];
    const brandingHits = [];
    const parseErrors = [];
    lines.forEach((ln, i) => {
      let ev; try { ev = JSON.parse(ln); } catch (e) { parseErrors.push({ line: i + 1, error: String(e) }); return; }
      const scan = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(scan); return; }
        if (node.type === "tool_use" && node.name === "Skill") skillEvents.push({ line: i + 1, skill: node.input?.skill ?? null });
        Object.values(node).forEach(scan);
      };
      scan(ev);
      const txt = JSON.stringify(ev);
      if (/style guide is still at the default|atomic-tangerine|customize it to match your brand|Do you want to customize/i.test(txt)) {
        brandingHits.push({ line: i + 1, snippet: txt.slice(0, 400) });
      }
    });
    const evidence = {
      mode: "qa-independent-natural",
      startedAt, finishedAt,
      claudeVersion: "2.1.241",
      command: ["claude", ...args],
      promptTransport: "stdin",
      request: { path: PROMPT_PATH, sha256: sha256File(PROMPT_PATH) },
      exit: { code, signal, timedOut },
      transcript: { path: TRANSCRIPT, sha256: fs.existsSync(TRANSCRIPT) ? sha256File(TRANSCRIPT) : null, jsonEvents: lines.length, parseErrors },
      skillEvents,
      invokedDiagramDesign: skillEvents.some((s) => s.skill === "diagram-design"),
      brandingQuestions: brandingHits,
      output: fs.existsSync(OUT_HTML)
        ? { path: OUT_HTML, exists: true, bytes: fs.statSync(OUT_HTML).size, sha256: sha256File(OUT_HTML) }
        : { path: OUT_HTML, exists: false },
      guard: {
        projectSkillUnchanged: JSON.stringify(before.projectSkill) === JSON.stringify(after.projectSkill),
        projectConfigUnchanged: JSON.stringify(before.projectConfig) === JSON.stringify(after.projectConfig),
        changedUserPaths: Object.keys(before.userPaths).filter((k) => JSON.stringify(before.userPaths[k]) !== JSON.stringify(after.userPaths[k])),
        before, after,
      },
    };
    fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
    console.log("DONE exit=" + code + " skill=" + evidence.invokedDiagramDesign + " html=" + evidence.output.exists + " branding=" + brandingHits.length + " userChanged=" + JSON.stringify(evidence.guard.changedUserPaths));
  }, 500);
});
