// FLY-2022 QA negative control: identical skill copy, identical natural request,
// but NO `.diagram-design` marker in the project root. If the §0 brand gate fires here
// and stayed silent in the real project, the marker is what suppressed it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { analyze, selfTest } from "/Users/xiaorongli/Dev/flywheel-FLY-2022/engineering/doc/FLY-2022-diagram-design-install/qa-evidence-2/analyze.mjs";

const NEG = "/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2022/1d9e33ea-4c4d-4c66-a2c1-47efd7480c18/scratchpad/negctl";
const TRANSCRIPT = path.join(NEG, "transcript.jsonl");
const EVIDENCE = path.join(NEG, "evidence.json");
const args = [
  "-p", "--no-session-persistence", "--no-chrome",
  "--output-format", "stream-json", "--verbose",
  "--permission-mode", "acceptEdits",
  "--allowedTools", "Skill,Read,Write,Edit,Glob,Grep,Bash(python3 .claude/skills/diagram-design/scripts/self_check.py:*)",
  "--disallowedTools", "WebFetch,WebSearch,Task",
];
const child = spawn("claude", args, { cwd: NEG, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.pipe(fs.createWriteStream(TRANSCRIPT));
child.stderr.pipe(fs.createWriteStream(path.join(NEG, "stderr.log")));
child.stdin.end(fs.readFileSync(path.join(NEG, "request-natural.md"), "utf8"));
const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 25 * 60 * 1000);
child.on("exit", (code) => {
  clearTimeout(timer);
  setTimeout(() => {
    const lines = fs.readFileSync(TRANSCRIPT, "utf8").split("\n").filter(Boolean);
    const scan = analyze(lines);
    const ev = {
      mode: "qa-attempt2-negative-control-no-marker",
      markerPresent: fs.existsSync(path.join(NEG, ".diagram-design")),
      exitCode: code,
      detectorSelfTest: selfTest(),
      invokedDiagramDesign: scan.skillEvents.some((s) => s.skill === "diagram-design"),
      skillEvents: scan.skillEvents,
      assistantGateHits: scan.assistantGateHits,
      rawGateHitLines: scan.rawGateHitLines,
      finalResult: scan.finalResult,
      outputExists: fs.existsSync(path.join(NEG, "out/generated-natural.html")),
    };
    fs.writeFileSync(EVIDENCE, JSON.stringify(ev, null, 2));
    console.log(`NEGCTL exit=${code} marker=${ev.markerPresent} skill=${ev.invokedDiagramDesign} assistantGateHits=${ev.assistantGateHits.length} html=${ev.outputExists}`);
    if (ev.assistantGateHits.length) console.log("GATE TEXT:", ev.assistantGateHits[0].snippet.slice(0, 400));
  }, 500);
});
