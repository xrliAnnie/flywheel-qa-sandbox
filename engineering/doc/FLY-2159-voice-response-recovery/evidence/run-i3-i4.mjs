import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readJsonIfComplete,
  readJsonLinesIgnoringTornTail,
} from "./readers.mjs";

const [rayaRoot, roundDir] = process.argv.slice(2);
if (!rayaRoot || !roundDir) {
  throw new Error("usage: node run-i3-i4.mjs <raya-root> <round-dir>");
}

const stateDir = join(roundDir, "state");
const eventsFile = join(stateDir, "voice-evidence", "events.jsonl");
const sessionFile = join(stateDir, "voice-session.json");
const resultFile = join(roundDir, "artifacts", "i3-i4-room-result.jsonl");
mkdirSync(join(roundDir, "artifacts"), { recursive: true });
const botEnv =
  "/Users/xiaorongli/.flywheel/qa-fly684-cfg/channels/discord-flywheel-eng-lead/.env";
const audioFile =
  "/Users/xiaorongli/.flywheel/raya/qa/FLY-2031/emitter.aiff";
const botId = "1516207680836866219";
const guildId = "1485787271192907816";
const channelId = "1542708795720081408";
const rayaBotId = "1542068543645024257";
const timeoutMs = 180_000;
const silenceMs = 65_000;

const { appendVoiceInboxItem, readVoiceInbox } = await import(
  pathToFileURL(join(rayaRoot, "packages/contracts/dist/index.js"))
);
const { loginDiscordEmitter } = await import(
  pathToFileURL(join(rayaRoot, "probes/c9-voice-emitter.mjs"))
);
const { loadBotToken } = await import(
  pathToFileURL(join(rayaRoot, "probes/c9-voice-emitter-lib.mjs"))
);
const {
  comparableSpokenText,
  summarizeReadbackCapture,
} = await import(
  pathToFileURL(join(rayaRoot, "probes/fly2031-voice-experience.mjs"))
);

function readEvents() {
  return readJsonLinesIgnoringTornTail(eventsFile);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollFor(description, check) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`${description} timed out`);
    }
    await delay(100);
  }
}

function time(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function appendResult(payload) {
  appendFileSync(
    resultFile,
    `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`,
  );
}

const startedAtMs = Date.now();
const baselineSession = await pollFor(
  "complete baseline voice session",
  () => readJsonIfComplete(sessionFile),
);
const baselineLiveAt = baselineSession.lastLiveAt;
const baselineEventCount = readEvents().length;
let emitter;
let joined = false;

try {
  const token = loadBotToken(botEnv, "DISCORD_BOT_TOKEN");
  emitter = await loginDiscordEmitter({ token, botId, guildId });
  const baselineTextIds = new Set(
    (await emitter.recentTextMessages(channelId)).map((message) => message.id),
  );

  await pollFor("Raya room presence", () => {
    const census = emitter.census(channelId, [rayaBotId]);
    return census.botVoiceChannels[rayaBotId] === channelId;
  });
  await emitter.join(channelId, { selfMute: true });
  joined = true;
  await pollFor("QA room presence", () =>
    emitter.census(channelId).channelMemberIds.includes(botId),
  );
  const liveSession = await pollFor("new realtime live session", () => {
    const session = readJsonIfComplete(sessionFile);
    return (
      session?.activeRun?.bootId &&
      session.lastLiveAt &&
      session.lastLiveAt !== baselineLiveAt &&
      time(session.lastLiveAt) >= startedAtMs
    )
      ? session
      : null;
  });

  await emitter.armRayaAudioCapture(rayaBotId, { decodePcm: true });
  const item = {
    v: 1,
    id: `fly2159-i3-${Date.now()}`,
    ts: new Date().toISOString(),
    source: { lead: "Tadashi" },
    kind: "report",
    needsDecision: true,
    text: "FLY-2159 isolated normal-path voice validation",
    refs: { issue: "FLY-2159" },
    speechBrief: {
      what: "这是一段正常路径念读，我会把这段话从头到尾清楚地说完。",
      why: "现在连续说明，是为了确认语音会稳定输出，随后也能完整接住你的问题。",
      next: "我说完以后请问一条中立问题，不需要做任何批准决定。",
    },
  };
  const expectedReadback = [
    item.speechBrief.what,
    item.speechBrief.why,
    item.speechBrief.next,
  ].join("");
  const pendingKey = `inbox:${item.id}`;
  const readbackStartedAtMs = Date.now();
  appendVoiceInboxItem(stateDir, item);
  const readback = await pollFor("spoken normal-path readback", () => {
    const events = readEvents().slice(baselineEventCount);
    const transcript = events.find(
      (event) =>
        event.kind === "realtime_transcript" &&
        event.role === "assistant" &&
        comparableSpokenText(event.text) ===
          comparableSpokenText(expectedReadback),
    );
    const injected = events.some(
      (event) =>
        event.kind === "speech_injected" &&
        event.pendingKey === pendingKey,
    );
    const ack = readVoiceInbox(stateDir).acks.find(
      (candidate) => candidate.id === item.id,
    );
    return transcript && injected && ack?.how === "spoken"
      ? { transcript, ack }
      : null;
  });
  const readbackEndedAtMs = Date.now();
  const readbackAudio = summarizeReadbackCapture(
    emitter.rayaPcmFrames(rayaBotId),
    readbackStartedAtMs,
    readbackEndedAtMs,
  );

  const knownTranscriptIds = new Set(
    readEvents()
      .map((event) => event.transcriptId)
      .filter((id) => typeof id === "string"),
  );
  await emitter.setSelfMute(false);
  try {
    await emitter.play(audioFile);
  } finally {
    await emitter.setSelfMute(true);
  }
  const turn = await pollFor("attributed user final and assistant final", () => {
    const events = readEvents();
    const userIndex = events.findIndex(
      (event) =>
        event.kind === "realtime_transcript" &&
        event.role === "user" &&
        event.speakerUserId === botId &&
        !knownTranscriptIds.has(event.transcriptId),
    );
    if (userIndex < 0) return null;
    const assistant = events
      .slice(userIndex + 1)
      .find(
        (event) =>
          event.kind === "realtime_transcript" &&
          event.role === "assistant" &&
          typeof event.transcriptId === "string",
      );
    return assistant ? { user: events[userIndex], assistant } : null;
  });

  const textMessages = await pollFor("voice text mirror", async () => {
    const fresh = (await emitter.recentTextMessages(channelId)).filter(
      (message) => !baselineTextIds.has(message.id),
    );
    const contents = fresh.map((message) => message.content);
    return contents.includes(
      `🗣️ **语音参与者**:${String(turn.user.text).trim()}`,
    ) &&
      contents.includes(
        `💬 **Raya**:${String(turn.assistant.text).trim()}`,
      ) &&
      contents.some((content) => content.startsWith("💭 **Raya**:"))
      ? fresh
      : null;
  });

  const silenceStartedAt = new Date().toISOString();
  await delay(silenceMs);
  const silenceEndedAt = new Date().toISOString();
  await emitter.leave();
  joined = false;
  const finalEvents = await pollFor("clean voice exit and counters", () => {
    const events = readEvents().slice(baselineEventCount);
    const exit = [...events]
      .reverse()
      .find(
        (event) =>
          event.kind === "voice_exit" &&
          event.code === 0 &&
          event.reason === "last-human-left",
      );
    const counters = [...events]
      .reverse()
      .find((event) => event.kind === "audio_counters");
    return exit && counters ? { events, exit, counters } : null;
  });

  const recovery = finalEvents.events.filter((event) =>
    [
      "response_recovery_attempted",
      "response_recovery_result",
      "response_recovery_suppressed",
      "response_recovery_unavailable",
    ].includes(event.kind),
  );
  const userAt = time(turn.user.ts);
  const assistantAt = time(turn.assistant.ts);
  if (recovery.some((event) => event.kind === "response_recovery_unavailable")) {
    throw new Error("response recovery became unavailable");
  }
  if (recovery.some((event) => event.kind === "response_recovery_attempted")) {
    throw new Error("I3 normal path unexpectedly attempted recovery");
  }
  if (!userAt || !assistantAt || assistantAt <= userAt) {
    throw new Error("user/assistant final timestamps are invalid");
  }
  if (
    !Number.isFinite(finalEvents.counters.counts?.sent) ||
    finalEvents.counters.counts.sent <= 0 ||
    !Number.isFinite(finalEvents.counters.counts?.voice) ||
    finalEvents.counters.counts.voice <= 0
  ) {
    throw new Error("audio counters do not prove sent and voice traffic");
  }

  appendResult({
    status: "PASS",
    bootId: liveSession.activeRun.bootId,
    readback: {
      transcriptId: readback.transcript.transcriptId,
      ackHow: readback.ack.how,
      audio: readbackAudio,
    },
    turn: {
      userTranscriptId: turn.user.transcriptId,
      assistantTranscriptId: turn.assistant.transcriptId,
      responseLatencyMs: assistantAt - userAt,
    },
    textMirrorMessageCount: textMessages.length,
    silenceWindow: {
      startedAt: silenceStartedAt,
      endedAt: silenceEndedAt,
    },
    recovery,
    audioCounters: finalEvents.counters.counts,
  });
  process.stdout.write(
    `${JSON.stringify({ status: "PASS", responseLatencyMs: assistantAt - userAt })}\n`,
  );
} catch (error) {
  try {
    appendResult({
      status: "FAIL",
      message: error instanceof Error ? error.message : String(error),
    });
  } catch (resultError) {
    process.stderr.write(
      `FLY-2159 could not persist I3/I4 failure: ${resultError instanceof Error ? resultError.message : String(resultError)}\n`,
    );
  }
  process.stderr.write(
    `FLY-2159 I3/I4 failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (emitter) {
    if (joined) {
      try {
        await emitter.leave();
      } catch {
        // Preserve the primary result.
      }
    }
    await emitter.destroy();
  }
}
