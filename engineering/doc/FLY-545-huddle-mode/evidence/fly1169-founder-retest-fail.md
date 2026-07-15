# FLY-545 /glaw 真机复测 (FLY-1169) — 结论: FAIL

Issue: FLY-545 (PR #503)
日期: 2026-07-11
基于: qa-verdict-opus.md, fly1158-evidence.txt

## 一句话结论

Annie 真机复测 (meeting FLY-1169, head 1fc98a99) = **FAIL**。Gemini Live 连接在她的会中
**反复抽风** (abort→reconnect→abort→reconnect), 第二次重连 `resumed=false` (会话没接续=
丢对话上下文), Lead 退化成裸 LLM ("I am just a llm and cant help"), **Annie 中途退房**、
meeting 被 released。FLY-1158 的连接脆弱 P0 **没根治**。

## 铁证 — daemon log 全 15 行 (fly1169-founder-retest-fail.log)

```
 9 [voice-bridge] meeting FLY-1169 assembling
10 [voice-bridge] [meeting] line flywheel-eng-lead error: Gemini Live connection closed unexpectedly: The operation was aborted.
11 [voice-bridge] [meeting] line flywheel-eng-lead reconnected (resumed=true)
12 [voice-bridge] [meeting] line flywheel-eng-lead error: Gemini Live connection closed unexpectedly: The operation was aborted.
13 [voice-bridge] [meeting] line flywheel-eng-lead reconnected (resumed=false)
14 [voice-bridge] [huddle] founder left mid-meeting — degraded landing
15 [voice-bridge] meeting FLY-1169 released
```

## 逐条对照验收标准

| 标准 | 结果 | 证据 |
|---|---|---|
| ≥3 轮真对话不掉 | **FAIL** | 连接抽风, Annie 中途退房 (line 14), 从没跑到 3 轮干净对话 |
| abort 后对话层真接回 (非 socket-only) | **部分/FAIL** | F1 重连每次都 fire (line 11/13), 但连接**持续掉** + resumed=false; 不是"稳定恢复", 是"反复掉+churn" |
| 环境噪音不误打断 | 未达 (她没跑到这步就退房了) |
| confirm-heuristic「对，不过…」不被当结束 | 未达 (她没跑到结尾) |
| founder 体验 | **FAIL** | Lead 退化裸 LLM "I am just a llm and cant help", 她中途离开 |

## 根因诊断 (给 implement 的 kickback 材料)

1. **核心 P0 未根治**: FLY-1158 的连接脆弱 (Gemini Live abort at assembly) 在真机**复现且加重** ——
   从单次 abort 变成**反复抽风** (line 10/12 两次 abort)。R4 的 P0(a)「root-cure fragility /
   make it break less」**没达到**。
2. **resumed=false = 上下文丢失**: 第二次重连 (line 13) session resumption 失败, 起了个没历史的新
   session。tools (ask_lead/issue_status) 在重连 config 里**是**有重发的 (genaiConnector.ts:65-67
   `tools: [{functionDeclarations: ...}]` + systemInstruction line 90), 所以"I am just a llm"
   **不是**工具掉了 —— 是连接抽风中途被问 + resumed=false 新 session 还没稳住 agentic 行为, Gemini
   退化成裸 LLM。根子仍是**连接不稳**。
3. **环境 vs 代码 (待 implement root-cause)**: 复测时 load ~9-10。不能排除 load 诱发的环境性 Gemini
   WS 抽风 (与 /gemini 那次 abort 同源, 那次判环境性可 ship)。但**无论环境还是代码, founder 真机验收
   挂了**。implement 侧要坐实: 是 load 诱发 (→ 需低负载复测 + 稳定性加固) 还是 fix 不够 (→ 代码修)。

## 机制级根因 (impl 3dcb1b94 只读定位坐实 + Tadashi 批 [ede333a1]) — 权威版

上面第 2 条我最初的"连接抽风 + resumed=false 新 session"是**表象**; impl 侧 3dcb1b94 read-only
定位出**机制级真因**, 已 Tadashi 确认:

1. **resumed=true 是谎**: `wireMeeting.ts` 里 rotator 的 `create(handle)` 闭包**根本没把
   resumeHandle 传进 createConversation** (签名里没这字段; handle 只用来算 `rebuiltWithoutResume`
   然后丢弃)。→ 日志里 `reconnected (resumed=true)` (line 11) **只表示 handle 存在, resume 从未
   真发生** —— 本文上方"铁证"里那行按此更正理解。
2. **假恢复 = 真伤害**: handle 存在 → `rebuiltWithoutResume=false` → `feed.replay()` 被短路 →
   继任 session **既无 Gemini 上下文、也无纪要回放** = 只有 persona 的空脑 = Annie 看到的裸 LLM。
   (所以"I am just a llm"不是工具掉了, 也不只是连接 churn —— 是 fake-resume + replay 被短路。)
3. 一句话: **连接抽风 = 诱因, resume 假恢复 = 真伤害。**

**修复面 (Tadashi 指定)**: (a) resumeHandle 直通 createConversation; (b) replay 兜底 (handle 在也
要能回放纪要); (c) 下面的 cue 去重。

## 附带 defect: F2 重复 wait-cue (Annie 截图, [FLY-545] thread)

「这轮回答等得比平时久…」的 slow-turn 提示**连发两条一模一样** = F2 wait-state UI 重复触发,
**是 545 的真 defect, 要 dedup** (定位: 同一 wait-state 为什么发两次 —— dedup bug 还是两个触发源)。
注: 那轮后台确实慢本身, 若是 Gemini 脑的老毛病 → 标 observation 归 FLY-1160, 不算 545 defect。

## Observation (非 545 defect → FLY-1160)

- ask_lead 工具不稳定触发 / "I am just an LLM" 的**通用**老短板 = 老 Gemini-thinks 架构已知限制
  (Tadashi [1d83de13]); 本轮**重连后**的空脑另有机制级真因 (见上, 属 545)。turn 慢本身若属
  Gemini 脑老毛病 → observation。

## 不属于本 PR 的一条 (澄清, 非 bug)

Annie 期待「常驻 1169 的 Claude Code session in CMux」—— 那是 **FLY-1160** (独立未来 issue)。
代码白纸黑字: ReadOnlyLeadBrain.ts「Until FLY-1160's resident session lands, every huddle brain
turn is bounded / spawns fresh」。#503 用 per-turn 的 headless `claude -p` (只读 Read/Grep/Glob),
**不是**常驻 session。她在 CMux 看不到常驻 = #503 的预期设计, 不是缺陷。

## 环境

- head: 1fc98a99 (PR #503)
- venue: start-545-staged.sh (pristine, Annie=founder, DISCORD_OWNER_USER_ID=Annie)
- 首次拉 daemon 撞 cold-start UDP race (IP discovery socket closed), retry 后稳 —— 那是环境性、
  非本次 FAIL 根因; 本次 FAIL 根因是会中 Gemini Live 连接抽风 (上面 line 10-15)。
- load ~9-10 (1-min)。
