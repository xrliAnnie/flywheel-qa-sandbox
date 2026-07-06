# FLY-883 ChatGPT Deep Research Prompt — Realtime Voice-to-Voice 选型

Issue: FLY-883 (https://linear.app/geoforge3d/issue/FLY-883/researchvoice-realtime-voice-to-voice-技术选型-deep-research喂给-543-地基用)
日期: 2026-07-04
基于: 无

> 用法：跑 deep-research skill 时，把下面代码块内的 prompt 原文（英文）整体粘入 ChatGPT
> Deep Research。若 DR 追加澄清问题，按本文件末尾「澄清问题预案」回答。
> Prompt 用英文写（API 文档/benchmark 主要是英文语料），但显式要求覆盖中文生态来源
> （CosyVoice/FunAudioLLM、中英混说实测）。

```text
# Deep Research request: Realtime voice-to-voice backend selection for a Discord-based AI agent system (2026)

## Context (what we're building)

We run a small "AI company" system: a solo founder communicates with multiple AI
"department lead" agents through Discord (text today). We are adding a voice layer so
the founder can talk with these agents hands-free (cooking, walking, commuting) and the
agents talk back — realtime, interruptible, natural conversation. Key facts:

- Runtime: Node.js / TypeScript on macOS (bots run locally on the founder's machine).
  Discord is the communication bus; each agent is a Discord bot. The voice feature =
  the bot joins a Discord voice channel, captures the founder's mic audio, and responds
  with spoken audio in the channel.
- The agents' reasoning/memory lives in our own system (Claude-based agent sessions).
  The voice model does NOT need to be the brain; it can be the "mouth and ears". But
  voice interactions must be able to TRIGGER ACTIONS in our system (create a ticket,
  check status, approve work) — so tool/function calling from inside the voice loop
  matters a lot.
- The founder speaks mixed Chinese and English in the same sentence (中英混说,
  code-switching): mostly Chinese sentence frames with embedded English technical terms
  (e.g. "帮我把这个 PR merge 了", "OpenAI Realtime 的 latency 怎么样"). Recognition AND
  synthesis quality for this mixed speech is a hard requirement, not a nice-to-have.
- Design constraint: the voice backend must be PLUGGABLE — we will define a
  backend-agnostic interface and want to pick the best DEFAULT backend now, while
  keeping others swappable.
- Usage pattern for cost modeling: assume 2 conversations/day × 15 minutes each, plus
  occasional longer sessions; single user.

## Research questions

### Q1. Backend comparison (the core deliverable — a table)

Compare these three backend options, as of today (include model/version names and dates
for everything — this space moves fast):

A. OpenAI Realtime API (gpt-realtime family; WebRTC + WebSocket + SIP)
B. Google Gemini Live API (native-audio Live models)
C. A local/self-hosted stack built around Alibaba's CosyVoice (FunAudioLLM ecosystem) —
   note CosyVoice is TTS-only, so specify the full local pipeline it implies (ASR:
   e.g. FunASR / SenseVoice / Whisper-family; LLM: any; TTS: CosyVoice 2/3) and
   evaluate THAT stack as option C.

Also flag briefly any strong 4th option we should know about (e.g. Amazon Nova Sonic,
Azure Voice Live, or open speech-to-speech models like Moshi / GLM-Voice / Qwen-Omni /
Step-Audio) ONLY if it clearly beats the three on our criteria — keep the deep
comparison to the three.

Dimensions (address each, with evidence and citations):

1. End-to-end latency: time-to-first-audio and full turn latency under realistic
   network conditions; barge-in/interruption support and how quickly it stops speaking.
2. Cost: realistic per-minute conversation cost (both directions), token pricing
   details, cached-input discounts; monthly estimate for our usage pattern (2×15
   min/day). For the local stack, give hardware requirements instead: can it run well
   on an Apple Silicon Mac (M-series, 64–128 GB unified memory), or does it need a
   dedicated GPU box?
3. Audio quality / naturalness of the synthesized voice (published evals + credible
   community assessments), voice variety, and voice cloning / custom-voice options (we
   later want a distinct voice per agent persona).
4. Chinese-English code-switching: BOTH understanding (ASR side) and speaking (TTS
   side — English terms embedded in Chinese sentences). Look for actual benchmarks
   (code-switching ASR test sets such as ASCEND or SEAME), user reports (including
   Chinese-language communities), and official claims. This dimension has the highest
   decision weight.
5. Tool/function calling from inside the voice session: supported? how (schema, async
   tool results, can the model keep talking / play filler while a tool runs)?
   reliability reports. Also whether the session can emit BOTH text transcripts and
   audio (we need transcripts for records).
6. Privacy / self-hosting: can it run fully local; what data leaves the machine; data
   retention posture of the hosted options.
7. Node.js/TypeScript SDK maturity + Discord-integration friction: native audio
   formats (sample rates, encodings) vs Discord's 48 kHz Opus; existing examples of
   wiring each backend to a Discord bot.
8. Reliability/ops: session length limits, reconnection story, rate limits, regional
   availability.

### Q2. Architecture: direct speech-to-speech vs STT→LLM→TTS pipeline vs hybrid

- Tradeoffs (latency / flexibility / cost / controllability) of:
  (a) native speech-to-speech — one model listens, thinks, and speaks;
  (b) modular STT→LLM→TTS pipeline with streaming at every stage;
  (c) hybrid — a realtime speech model as the conversational front-end that calls our
      own agent (a bigger LLM) as a TOOL for anything substantive.
- What do production voice-agent frameworks do in 2026 (LiveKit Agents, Pipecat, Vapi,
  etc.), and what patterns have emerged as best practice for "voice front-end +
  separate agent brain"?
- Evaluate the hybrid pattern specifically for OUR case (agent reasoning stays in our
  Claude-based system): how well does each backend support "speech model defers
  substance to an external brain via tool calls" — latency masking, filler speech,
  async tool results?

### Q3. Discord voice-channel integration (Node.js)

- Current (2026) state of a Discord bot joining a voice channel and doing BOTH capture
  (per-user audio receive) and playback: @discordjs/voice receive support and caveats
  (audio receive is not officially documented by Discord — how risky in practice?),
  Opus decode/encode, 48 kHz ↔ 24 kHz/16 kHz resampling, VAD/turn-detection
  considerations inside a voice channel.
- Existing open-source projects that already wire Discord voice to OpenAI Realtime or
  Gemini Live (or Pipecat/LiveKit Discord transports). Assess maturity; link repos.
- Any Discord policy/ToS considerations for bots recording/processing voice audio
  (consent, storage).

### Q4. Recommendation

- Which backend should be the DEFAULT for our pluggable design, and why — grounded in
  Q1 evidence, weighted: code-switching quality > tool-calling reliability > latency >
  cost > self-hosting.
- What the pluggable interface must abstract so backends stay swappable: audio format
  negotiation, turn-taking/VAD events, interruption semantics, tool-call surface,
  transcript events, voice/persona selection.
- A realistic risk list for the recommended default (pricing changes, model
  deprecations, code-switching weaknesses, Discord receive fragility).

## Source guidance

- Prefer primary sources (OpenAI/Google/Alibaba official docs + pricing pages, model
  cards, GitHub repos) and dated benchmarks; include Chinese-language sources for the
  CosyVoice/FunAudioLLM ecosystem and for code-switching quality reports (知乎/CSDN/
  bilibili tech reviews acceptable as secondary evidence, marked as such).
- Every price / latency / model-name claim must carry a date and a link. If sources
  conflict, show both and say which is newer.
- Be explicit about what you could NOT verify.

## Output format

1. Executive summary (≤15 lines) with the recommendation up front.
2. The Q1 comparison table (rows = dimensions, columns = the 3 backends).
3. Per-backend detail sections with citations.
4. Architecture analysis (Q2) with a recommended pattern for our hybrid case.
5. Discord integration (Q3) with concrete library/repo pointers.
6. Recommendation + pluggable-interface requirements + risks (Q4).
```

## 澄清问题预案（DR 开跑前若追问，按此口径回答）

- **预算/规模**：单用户（founder 一人），订阅或 API 均可接受；成本按 2×15 分钟/天建模即可。
- **平台**：只考虑 Discord voice channel（不做电话/SIP/网页端）；bot 跑在 macOS 本机 Node.js。
- **语言**：中文为主、句内嵌英文技术词；不需要其他语言。
- **本地硬件**：Apple Silicon Mac（M 系列，64–128GB 统一内存），无独立 NVIDIA GPU；如本地栈必须 GPU 请直说。
- **时间范围**：只要当前（2026）可用的版本/价格；历史演进不重要。
- **是否要代码**：不需要示例代码，要架构结论 + 库/repo 指针。
