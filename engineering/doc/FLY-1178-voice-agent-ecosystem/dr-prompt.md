# FLY-1178 ChatGPT Deep Research Prompt — 语音 Agent 生态（实时语音 + 委派 agent）

Issue: FLY-1178 (https://linear.app/geoforge3d/issue/FLY-1178/research-语音-agent-生态-deep-research-实时语音委派-agent-的行业形态记忆传递常驻取舍双视角技术形态)
日期: 2026-07-11
基于: research.md

> 用法：跑 deep-research skill 时，把下面代码块内的 prompt 原文（英文）整体粘入 ChatGPT
> Deep Research。若 DR 追加澄清问题，按本文件末尾「澄清问题预案」回答。
> Prompt 用英文写（官方文档/框架语料是英文），双栏（技术形态/产品体验含义）是硬性
> 输出格式；findings.md 会用中文重排，双栏由我们兜底保证。

```text
# Deep Research request: Voice-agent ecosystem survey — how the industry combines realtime voice with delegated agents (2026)

## Context (who we are and why we ask)

We run a small "AI company" system: a solo founder communicates with multiple AI
"department lead" agents through Discord. The agents' reasoning and memory live in our
own system (Claude-based agent sessions); Discord is the communication bus. We have
already built FOUR experimental voice command lines on top of this, each a different
architecture shape:

1. A pure hosted speech-to-speech assistant (one realtime voice model is ears + brain +
   mouth).
2. A hosted voice-agent platform (STT/TTS/turn-taking handled by the platform) bridged
   to our own Claude brain behind an OpenAI-compatible endpoint.
3. A realtime voice front-end that DELEGATES substantive work asynchronously to a
   deeper text-agent loop with real tools (create tickets, dispatch work, check status),
   then reports back by voice.
4. A multi-participant "huddle" mode: several agent personas join one Discord voice
   channel with the founder; a realtime model is used as ears (transcription + turn
   detection), a RESIDENT per-meeting Claude session is the brain, and a TTS engine is
   the mouth; the meeting ends with minutes written back into our issue tracker.

This research is the shared evidence base for a leadership discussion (founder +
product + engineering) deciding which of the four lines to keep, which to deepen, what
experience to aim for, and how to build it. It is a LANDSCAPE SURVEY of how others
architect voice + agents — NOT a vendor selection.

IMPORTANT — what we already know (do NOT re-cover; we completed a separate deep
research on this in July 2026): the OpenAI Realtime API vs Google Gemini Live API vs
local (CosyVoice-stack) BACKEND comparison — latency, per-minute cost, audio quality,
Chinese-English code-switching, tool calling, privacy, session limits; the generic
speech-to-speech vs STT→LLM→TTS vs hybrid architecture tradeoff; and Discord voice
transport details. Spend your budget on the AGENT LAYER on top of realtime voice:
delegation, memory, agent lifetime, ecosystem, and multi-party coordination.

For EVERY finding below, output two labeled lines (this dual lens is a hard output
requirement):
- "Technical form:" — how it is actually built/specified (mechanism, API surface,
  protocol, architecture), with citation;
- "Product-experience implication:" — what it means for the end user's experience
  (latency feel, continuity, trust, confusion avoided/created), and, where obvious,
  what it suggests for a system shaped like ours.

## Research questions

### Q1. Realtime voice + delegated agents — how the two major stacks (and notable others) compose them

NOTE: the generic speech-to-speech vs chained (STT→LLM→TTS) tradeoff itself is
ALREADY-KNOWN territory (see fence above). You may spend at most one short paragraph
restating OpenAI's official taxonomy as terminology background. Everything else in Q1
must be the AGENT-LAYER DELTA — do not re-compare generic latency/cost/audio quality:

- OpenAI: the Realtime API (gpt-realtime family) combined with the Agents SDK. Focus
  on: how agent HANDOFF/delegation works inside a live voice session (RealtimeAgent
  handoffs — what context transfers, what the user hears during a handoff: voice
  change? announcement? silence?); how long-running/async tool work is handled while
  the voice session keeps talking; how the architecture choice (s2s vs chained)
  CHANGES the handoff/delegation options and the user's voice experience during
  delegated work.
- Google: Gemini Live API combined with the Agent Development Kit (ADK). Focus on:
  ADK's bidi-streaming ("live") mode; sub-agents and agent transfer/delegation; how a
  live voice session hands work to other agents and gets results back, and what the
  user experiences meanwhile.
- Others ONLY if genuinely notable in 2025-2026: Amazon Nova Sonic + Bedrock Agents,
  Azure Voice Live + AI agent service, LiveKit Agents multi-agent workflows. One
  paragraph each maximum.
- Also note the composition pattern relevant to us: our brain is Claude (Anthropic has
  no native realtime voice API as far as we know — verify), so "ears/mouth from one
  vendor + brain from another" — how common is this split in production voice agents,
  and what named patterns exist for it?

### Q2. Memory hand-over between short-lived task agents (highest-priority question)

When work passes between short-lived agents (or between a voice front-end and worker
agents), how is MEMORY actually carried? Survey the three mechanism families and who
uses which in practice:

(a) Context injection at handoff time — e.g. Agents SDK handoff input filters /
    conversation-history passing; ADK transfer with shared session state.
(b) Platform-managed session/thread objects — e.g. OpenAI Conversations/Threads and
    Realtime session context; ADK Session/State/Memory services; what voice platforms
    (ElevenLabs Agents, Vapi, Retell) persist across turns AND across separate calls.
(c) Shared external memory stores — mem0, Zep, Letta (MemGPT), LangGraph
    checkpointers/stores, plain vector DBs; how production voice agents wire these in.

For each: what survives (facts? full transcript? summaries?), who writes/reads it,
staleness/conflict handling, and the typical COMBINATION stacks used in production
(e.g. "platform session for short-term + external store for long-term"). End Q2 with
the 2-3 dominant real-world patterns, each with a named example.

### Q3. Resident (long-lived) vs ephemeral (per-task) agents — the tradeoff

IMPORTANT — keep two DIFFERENT axes separate throughout Q3 (conflating them is the
most common error in this discussion):
- LOGICAL residency: the agent's identity/history/memory persist durably (e.g. in a
  database) and can be rehydrated on demand — the agent "exists" between calls but no
  process needs to stay up. (Example to verify: Letta documents agents as "stateful
  services" whose state lives in a DB while callers just send new messages — that
  proves persistent STATE, not a warm process.)
- COMPUTE/SESSION residency: a process, model connection, or live context actually
  stays warm/online during idle time (what "resident" means for us: a per-meeting
  always-on brain session).

For every case you survey, tag it on both axes plus: idle compute/cost, crash/restart
recovery, and lifetime boundary (per task / per conversation / per meeting /
indefinite).

- Who actually runs each form: Letta/MemGPT-style persistent agents, companion
  products, "ambient agents", any official vendor endorsement of resident sessions.
  Is there any documented "one resident session per MEETING" pattern like ours?
- Why the industry default is per-task ephemeral compute: collect the STATED reasons
  (cost of idle compute, context drift/pollution, crash recovery, horizontal scaling,
  security surface) from credible sources, not just inference.
- Under what conditions do practitioners say compute residency is worth it (warm-turn
  latency, continuous meeting presence, accumulated in-session context)? Any published
  hybrid patterns (resident conversational shell + ephemeral workers)?
- Structure the final Q3 comparison into at least three buckets: (i) ephemeral compute
  + persistent state, (ii) per-meeting/per-conversation resident, (iii) indefinite
  resident.

### Q4. The voice-agent framework/platform ecosystem — and whether our scenario is a market blank

- Survey: LiveKit Agents, Pipecat, Vapi, Retell AI, ElevenLabs Agents (Conversational
  AI). For each: architecture form (open framework vs managed platform vs API),
  published latency budgets (time-to-first-audio numbers the framework/platform states
  for its OWN stack — do NOT re-benchmark the underlying voice-model backends; mark
  vendor-claimed numbers as vendor claims), intended scenarios, and notable production
  users (also marked as vendor claims unless independently reported). Add at most 1-2
  others only if clearly significant (e.g. Hume EVI).
- THE MARKET-BLANK QUESTION: our scenario is "a founder voice-commanding their OWN
  engineering/agent organization" — spoken delegation, status queries, and approvals
  against a private multi-agent dev system. Since proving absence is hard, find the
  3-5 NEAREST existing cases (voice coding tools, voice-driven IDE/agent control,
  Jarvis-style org assistants, voice interfaces to agent frameworks) and analyze the
  GAP between each and our scenario. Conclude honestly: crowded / adjacent /
  effectively blank.

### Q5. Multi-party rooms: agent participation and multi-agent coordination (deep-dive for our huddle line)

5a. Human-facing meeting participation: which products make a voice agent behave like
    a PRESENT PARTICIPANT in a multi-party meeting (not a note-taker)? Zoom AI
    Companion / Google Meet Gemini are note-taker baselines; look for agents that
    speak with turn-taking, barge-in handling, and a "lurk mode" (listen silently,
    speak when addressed or when they have something valuable). Include multiparty
    turn-taking research (who-speaks-next prediction, backchannels, when-to-interject)
    if it has made it into products.

5b. Multi-AGENT same-room coordination (our real pain): turn-based snapshot agents
    (read room snapshot → think → commit → wait) in a continuously moving room cause
    DUPLICATE responses and duplicate work — two of our agents have repeatedly both
    answered the same founder message and both created the same ticket. Survey how
    the industry solves coordination/dedup/floor-control among multiple agents sharing
    one room:
    - SEED SOURCE (must read and cite): "Is having agents in the room meant to be
      chaotic?" — Tenny, Raft (raft.build), 2026-05-21,
      https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/
      — introduces the Agent Inbox (pull-based perception: notifications become a
      queryable queue, the agent decides what deserves its attention) and the Held
      Draft (pre-send freshness check: if the room changed while composing, the draft
      is held and returned with the delta; the agent chooses revise / send-as-is /
      stay silent / informed override), under the principles of "perception empathy"
      and "action explicitness", rejecting both extremes of rule-suppression
      (@-mention-only) and unstructured chaos.
    - Beyond the seed: speaker-selection in AutoGen group chat, LangGraph
      supervisor/swarm handoff, CrewAI coordination; floor-control / turn-taking
      protocols from multi-party dialogue literature that apply to agents; practical
      dedup/idempotency etiquette for multiple bots in shared channels (Slack/Discord
      bot ecosystems). Which of these exist in VOICE rooms specifically, vs text-only?

## Source guidance

- Today is July 2026; this space moves fast. Prefer primary sources (official docs,
  SDK references, engineering blogs of the named vendors/frameworks, dated release
  notes) and 2025-2026 material; mark anything older.
- Every load-bearing claim needs a working link, plus the source's published/
  last-updated date WHERE THE SOURCE PROVIDES ONE; otherwise mark it "undated" and
  give your access date — do NOT guess dates. If sources conflict, show both and say
  which is newer. Do NOT fabricate citations — a smaller number of real, clickable
  sources beats broad coverage with invented ones.
- The must-examine lists above are starting points, not limits — go beyond them where
  the evidence leads.
- Be explicit about what you could NOT verify.

## Output format

1. Executive summary (≤15 lines): the strongest cross-cutting findings, phrased as
   decision-relevant statements.
2. One section per research question (Q1-Q5, with 5a/5b subsections). Within each
   section, findings as bullets, EACH carrying the two labeled lines
   ("Technical form:" / "Product-experience implication:").
3. "Implications for our four voice lines" — map the findings onto the four
   architecture shapes from the Context section (keep / deepen / experience target /
   build approach), as OPTIONS with evidence, not verdicts.
4. "What we could not verify" — honest gaps list.
5. Citations inline with dates.
```

## 澄清问题预案（DR 开跑前若追问，按此口径回答）

- **范围**：行业形态综述（landscape survey），不是选型 —— 选型（后端对比）已单独做过。
- **受众**：founder + 产品 + 工程的联席讨论；粒度要能支撑「四条线留/砍/深挖」的
  PRD 级取舍，不是学术综述。
- **平台约束**：我们跑在 Discord + Node.js/TypeScript + macOS 本机；但本轮问的是
  行业通用形态，不必局限 Discord。
- **语言**：英文来源为主；中文生态来源可选，非重点。
- **是否要代码**：不需要示例代码；要架构结论 + 机制名 + 文档/repo 指针。
- **时间范围**：以 2025-2026 现状为准；历史演进只在解释「为什么行业这么走」时简述。
- **预算/商务**：不需要价格对比（已单独做过）；提及成本仅当它解释形态取舍
  （如常驻 vs 短命的成本论据）。
