// FLY-1018 M3-harness — degraded seam replay (plan §5 chunk 15; NOT in CI).
//
// Replays the spike's run-s3-live.mjs shape WITHOUT real audio: a text
// driver plays the Live layer, delegate_task is the REAL createDelegateTool
// from the built package, and the deep brain is the REAL runAgentSession
// hitting the REAL Gemini API + the spike's contract-aligned mock Bridge
// (engineering/spike/FLY-997-gemini-agent/mock-bridge.mjs).
//
// Verifies (evidence printed at the end):
//   1. LiveToolSpec seam compatibility — the tool plugs where voice-core
//      dispatches extraTools;
//   2. ACK-before-work — handler returns 已受理 immediately;
//   3. deep loop completes the N1 short chain against the mock Bridge
//      (create issue → dispatch runner → poll → memory) with REAL model
//      function-calling;
//   4. completion reaches the injected sink (today's Discord binding shape).
//
// Usage: GEMINI_API_KEY=... node scripts/harness-delegate-replay.mjs

import { startMockBridge } from "../../../engineering/spike/FLY-997-gemini-agent/mock-bridge.mjs";
import { loadAgentConfig } from "../dist/config.js";
import { createDelegateTool } from "../dist/delegate.js";

const PORT = 47996;

if (!process.env.GEMINI_API_KEY) {
	console.error("GEMINI_API_KEY required");
	process.exit(2);
}

const server = await startMockBridge({ host: "127.0.0.1", port: PORT });
console.log(`[harness] mock-bridge up on :${PORT}`);

const config = loadAgentConfig({
	...process.env,
	FLYWHEEL_GEMINI_AGENT: "1",
	FLYWHEEL_BRIDGE_URL: `http://127.0.0.1:${PORT}`,
	FLYWHEEL_GEMINI_AGENT_BRIDGE_TOKEN: "harness-token",
	FLYWHEEL_GEMINI_AGENT_AUDIT_DIR: `${process.env.TMPDIR ?? "/tmp"}/fly1018-harness-audit`,
});

const completions = [];
const sinkMessages = [];
const tool = createDelegateTool({
	config,
	binding: { projectName: "geoforge3d", leadId: "flywheel-eng-lead" },
	contextNote: "voice huddle harness replay",
	onComplete: (taskId, terminal) => {
		completions.push({ taskId, terminal });
		// today's Discord-shaped sink: just record what would be posted
		sinkMessages.push(
			terminal.reason === "completed"
				? `✅ 任务 ${taskId} 完成:${terminal.finalText}`
				: `⚠️ 任务 ${taskId} 未完成(${terminal.reason})`,
		);
	},
});

// --- the "Live layer" (text-driven) dispatches the delegate tool call ----
console.log("[harness] Live(text) dispatches delegate_task ...");
const t0 = Date.now();
const ack = await tool.handler(
	{
		instruction:
			"File a Linear issue titled 'printer nozzle jam on layer 2' describing the firmware bug, then dispatch a runner on that new issue in project geoforge3d, poll its status once, and save a memory that the harness replay completed.",
	},
	{ signal: new AbortController().signal },
);
const ackMs = Date.now() - t0;
console.log(`[harness] ACK in ${ackMs}ms: ${ack}`);
if (!ack.includes("已受理")) {
	console.error("HARNESS FAIL: no immediate ACK");
	process.exit(1);
}

// --- wait for the async deep brain to finish -----------------------------
const deadline = Date.now() + 180_000;
while (completions.length === 0 && Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 1000));
}
server.close();

if (completions.length === 0) {
	console.error("HARNESS FAIL: deep session never completed (180s)");
	process.exit(1);
}
const { taskId, terminal } = completions[0];
if (terminal.error) {
	console.log(
		`[harness] terminal.error: ${terminal.error.kind} — ${terminal.error.message}`,
	);
}
console.log(
	`[harness] deep session ${taskId} → ${terminal.reason} (steps=${terminal.stats.steps}, toolCalls=${terminal.stats.toolCalls}, toolErrors=${terminal.stats.toolErrors}, hallucinated=${terminal.stats.hallucinatedToolCalls}, ${terminal.stats.durationMs}ms)`,
);
console.log(`[harness] sink message: ${sinkMessages[0]?.slice(0, 300)}`);
console.log(`[harness] finalText: ${(terminal.finalText ?? "").slice(0, 500)}`);

const ok =
	terminal.reason === "completed" &&
	terminal.stats.hallucinatedToolCalls === 0 &&
	terminal.stats.toolCalls >= 3;
console.log(
	ok
		? `HARNESS PASS — ack ${ackMs}ms; N1 chain ${terminal.stats.toolCalls} tool calls, 0 hallucinated`
		: "HARNESS FAIL — see terminal above",
);
process.exit(ok ? 0 : 1);
