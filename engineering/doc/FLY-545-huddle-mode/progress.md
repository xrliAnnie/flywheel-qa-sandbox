---
issue: FLY-545
phase: qa
phaseCursor: 1/1
updated: 2026-07-11T17:00:00.000Z
nextStep: "FOUNDER RETEST FLY-1169 (head 1fc98a99, PR #503) = FAIL. Annie 真机复测: Gemini Live
  连接会中反复抽风 (abort→reconnect→abort→reconnect, daemon log line 10-13), 第二次重连
  resumed=false (丢对话上下文), Lead 退化裸 LLM ('I am just a llm and cant help'), Annie 中途退房
  (line 14 'founder left mid-meeting — degraded landing'), meeting released (line 15)。FLY-1158 的
  连接脆弱 P0 未根治 (P0-a 'make it break less' 没达到), 真机复现且加重 (单次→反复)。tools 在重连
  config 里确认有重发 (genaiConnector 65-67), 所以 'I am just a llm' 不是工具掉了, 是连接抽风+
  resumed=false 新 session 退化。注: load ~9-10, 不排除环境性 (与 /gemini abort 同源), implement 要
  root-cause load-vs-code。她期待的常驻 CMux session = FLY-1160 (独立 issue, 非本 PR, 澄清非 bug)。
  证据: evidence/fly1169-founder-retest-fail.{log,md}。qa-result fail 已发 → kickback implement → park 等 retest。"
chunks: []
pointers: {}
---

# FLY-545 progress
**phase**: qa (1/1) — FOUNDER RETEST (FLY-1169, PR #503) = **FAIL** -> kickback

**verdict**: FAIL (founder real-machine retest, head 1fc98a99, PR #503). Annie 亲测 /glaw meeting
FLY-1169。Gemini Live 连接在会中**反复抽风** (abort→reconnect→abort→reconnect), 第二次重连
resumed=false (会话没接续=丢对话上下文), Lead 退化成裸 LLM ("I am just a llm and cant help"),
**Annie 中途退房**, meeting released。

**铁证 (daemon log 全 15 行, evidence/fly1169-founder-retest-fail.log):**
9 assembling → 10 abort → 11 reconnect resumed=true → 12 abort 又一次 → 13 reconnect resumed=false
→ 14 "founder left mid-meeting — degraded landing" → 15 meeting released。

**根因 (kickback 材料, 详见 evidence/fly1169-founder-retest-fail.md):**
- **核心 P0 未根治**: FLY-1158 连接脆弱真机复现且加重 (单次 abort → 反复抽风)。R4 P0(a)
  "make it break less" 没达到。
- **resumed=false = 上下文丢失**: 第二次重连 session resumption 失败。tools 在重连 config 里确认有
  重发 (genaiConnector.ts:65-67 + systemInstruction:90), 所以 "I am just a llm" **不是**工具掉了 ——
  是连接抽风中途被问 + resumed=false 新 session 退化成裸 LLM。根子=连接不稳。
- **环境 vs 代码 (待 implement root-cause)**: load ~9-10, 不排除 load 诱发的 Gemini WS 抽风 (与
  /gemini abort 同源)。但无论环境还是代码, founder 真机验收挂了。

**澄清 (非 bug)**: Annie 期待的常驻 CMux session = **FLY-1160** (独立未来 issue)。#503 用 per-turn
headless claude -p (ReadOnlyLeadBrain, 只读), 不是常驻 session — 那是下一步 (FLY-1160)。

**Next**: qa-result fail 已发 -> kickback implement (本 branch, alive) 修 -> park 等 retest wake。
venue 处置待 Tadashi 定 (idle, meeting 已 released)。不 ship, 不 merge。
