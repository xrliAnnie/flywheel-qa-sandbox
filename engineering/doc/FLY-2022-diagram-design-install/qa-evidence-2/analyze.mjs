// Shared analyzer for a stream-json transcript produced by run-generation.mjs.
//
// Two-channel branding scan. The skill body itself quotes the §0 gate wording
// ("atomic-tangerine", "Do you want to customize ...") and Claude Code injects that
// body as a user-role tool result, so a raw whole-transcript grep ALWAYS hits once the
// skill loads. Only text the assistant itself authored can be an actual question to the
// operator, so that is the channel the verdict uses; the raw channel is reported too so
// the difference is visible rather than hidden.
export const GATE = /style guide is still at the default|atomic-tangerine|customize it to match your brand|Do you want to customize|pull from your website URL|load a saved client profile|first diagram in this project/i;

export function analyze(lines) {
  const skillEvents = [];
  const parseErrors = [];
  const assistantGateHits = [];
  const rawGateHits = [];
  let assistantTextChars = 0;
  let finalResult = null;
  lines.forEach((ln, i) => {
    let ev;
    try { ev = JSON.parse(ln); } catch (e) { parseErrors.push({ line: i + 1, error: String(e) }); return; }
    (function scan(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(scan);
      if (node.type === "tool_use" && node.name === "Skill") skillEvents.push({ line: i + 1, skill: node.input?.skill ?? null });
      Object.values(node).forEach(scan);
    })(ev);
    if (GATE.test(JSON.stringify(ev))) rawGateHits.push(i + 1);
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type === "text" && typeof b.text === "string") {
          assistantTextChars += b.text.length;
          if (GATE.test(b.text)) assistantGateHits.push({ line: i + 1, snippet: b.text.slice(0, 500) });
        }
      }
    }
    if (ev.type === "result") finalResult = { subtype: ev.subtype, is_error: ev.is_error, api_error_status: ev.api_error_status ?? null, terminal_reason: ev.terminal_reason ?? null, result: typeof ev.result === "string" ? ev.result.slice(0, 400) : null };
    if (ev.type === "result" && typeof ev.result === "string" && GATE.test(ev.result)) assistantGateHits.push({ line: i + 1, snippet: ev.result.slice(0, 500) });
  });
  return { skillEvents, parseErrors, assistantGateHits, rawGateHitLines: rawGateHits, assistantTextChars, finalResult };
}

// Positive control: the detector must fire on the literal gate question from SKILL.md §0
// when that text appears in an assistant text block. Without this, "0 assistant hits"
// could just mean the regex is broken.
export function selfTest() {
  const gateLine = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "This is your first diagram in this project. The style guide is still at the default (neutral white-smoke + atomic-tangerine). Do you want to customize it to match your brand first?" }] },
  });
  const benignLine = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "已经画好了，写到 generated-natural.html。" }] } });
  const pos = analyze([gateLine]).assistantGateHits.length;
  const neg = analyze([benignLine]).assistantGateHits.length;
  return { firesOnGateText: pos === 1, silentOnBenignText: neg === 0, pos, neg };
}
