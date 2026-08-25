// FLY-2022 independent QA (attempt 2) — natural, unnamed Chinese request against the
// project-scoped diagram-design install. Captures the full stream-json transcript, the
// branding-gate scan, and a before/after fingerprint of every path the run must not touch.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { analyze, selfTest } from "./analyze.mjs";

const PROJECT = "/Users/xiaorongli/Dev/flywheel-FLY-2022";
const DIR = path.join(PROJECT, "engineering/doc/FLY-2022-diagram-design-install/qa-evidence-2");
const RUN = process.argv[2] || "natural";
const PROMPT_PATH = path.join(DIR, "request-natural.md");
const OUT_HTML = path.join(DIR, `generated-${RUN}.html`);
const TRANSCRIPT = path.join(DIR, `transcript-${RUN}.jsonl`);
const STDERR_LOG = path.join(DIR, `stderr-${RUN}.log`);
const EVIDENCE = path.join(DIR, `generation-evidence-${RUN}.json`);

const sha256File = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

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
const snapshot = () => ({
  projectSkill: dirFingerprint(path.join(PROJECT, ".claude/skills/diagram-design")),
  projectMarker: dirFingerprint(path.join(PROJECT, ".diagram-design")),
  userDiagramDesignHome: dirFingerprint(path.join(home, ".diagram-design")),
  userClaudeSkill: dirFingerprint(path.join(home, ".claude/skills/diagram-design")),
  userAgentSkill: dirFingerprint(path.join(home, ".agents/skills/diagram-design")),
  userCodexSkill: dirFingerprint(path.join(home, ".codex/skills/diagram-design")),
});

const before = snapshot();
for (const p of [OUT_HTML, TRANSCRIPT, STDERR_LOG, EVIDENCE]) if (fs.existsSync(p)) fs.unlinkSync(p);

const args = [
  "-p", "--no-session-persistence", "--no-chrome",
  "--output-format", "stream-json", "--verbose",
  "--permission-mode", "acceptEdits",
  "--allowedTools", "Skill,Read,Write,Edit,Glob,Grep,Bash(python3 .claude/skills/diagram-design/scripts/self_check.py:*)",
  "--disallowedTools", "WebFetch,WebSearch,Task",
];

const prompt = fs.readFileSync(PROMPT_PATH, "utf8");
const startedAt = new Date().toISOString();
const child = spawn("claude", args, { cwd: PROJECT, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.pipe(fs.createWriteStream(TRANSCRIPT));
child.stderr.pipe(fs.createWriteStream(STDERR_LOG));
child.stdin.end(prompt);

let timedOut = false;
const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, 30 * 60 * 1000);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  setTimeout(() => {
    const finishedAt = new Date().toISOString();
    const after = snapshot();
    const lines = fs.existsSync(TRANSCRIPT) ? fs.readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean) : [];
    const scan = analyze(lines);
    const detectorSelfTest = selfTest();
    const evidence = {
      mode: `qa-attempt2-${RUN}-unnamed`,
      qaExecId: "fef97b23-9282-4091-9f72-b082742ae355",
      startedAt, finishedAt,
      claudeVersion: "2.1.243",
      command: ["claude", ...args],
      cwd: PROJECT,
      promptTransport: "stdin",
      request: { path: PROMPT_PATH, sha256: sha256File(PROMPT_PATH) },
      exit: { code, signal, timedOut },
      transcript: { path: TRANSCRIPT, sha256: fs.existsSync(TRANSCRIPT) ? sha256File(TRANSCRIPT) : null, jsonEvents: lines.length, parseErrors: scan.parseErrors },
      skillEvents: scan.skillEvents,
      invokedDiagramDesign: scan.skillEvents.some((s) => s.skill === "diagram-design"),
      finalResult: scan.finalResult,
      detectorSelfTest,
      brandingQuestionsAssistantAuthored: scan.assistantGateHits,
      brandingWordingRawHitLines: scan.rawGateHitLines,
      assistantTextChars: scan.assistantTextChars,
      output: fs.existsSync(OUT_HTML)
        ? { path: OUT_HTML, exists: true, bytes: fs.statSync(OUT_HTML).size, sha256: sha256File(OUT_HTML) }
        : { path: OUT_HTML, exists: false },
      guard: {
        projectSkillUnchanged: JSON.stringify(before.projectSkill) === JSON.stringify(after.projectSkill),
        projectMarkerUnchanged: JSON.stringify(before.projectMarker) === JSON.stringify(after.projectMarker),
        changedPaths: Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])),
        before, after,
      },
    };
    fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
    console.log(`DONE exit=${code} signal=${signal} timedOut=${timedOut} skill=${evidence.invokedDiagramDesign} html=${evidence.output.exists} assistantGateHits=${scan.assistantGateHits.length} rawGateLines=${JSON.stringify(scan.rawGateHitLines)} changedPaths=${JSON.stringify(evidence.guard.changedPaths)}`);
  }, 500);
});
