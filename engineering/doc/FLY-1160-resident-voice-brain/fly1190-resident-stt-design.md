# FLY-1160 resident-STT 恢复 (FLY-1190 折入 #555) — 设计

Issue: FLY-1160 (#555) — folds FLY-1190
日期: 2026-07-12
基于: progress-phase-b.md + 545 STT-abort 修复 (qa-fly545-r5-stt-leg)

## 目标 (Annie 拍板)
/glaw 大脑必须是常驻 Claude 且**默认**;耳朵(STT)用 Gemini。她撞过的 STT-abort bug
(说话中途 STT 断线 → 内容丢) 的保护,必须在 **resident 那条腿**上也生效 —— 否则一切默认,
bug 回来。一个 PR 一次做完,end-to-end,再让她测。

## 关键洞察 (读码确认)
545 的 STT-abort 恢复机制在 HuddleSession 里,**与引擎无关**:
- `handleFounderFrame` 把她的音频缓冲进 `founderAudio`,keyed 到 **addressed line**(非
  gemini-gated)。
- `handleLineReconnected` 重放是 `line.session.sendAudio(f)` + `line.session.endUserTurn?.()`
  —— 作用在 **STT/耳朵层**(`line.session` = STT rotator),gemini / resident 都一样。
- resident line 的 `session.sendAudio` 已经 route 到它的 Gemini STT rotator(wireMeeting:723)。

⇒ 恢复机制**已经能给 resident 用**,只差两件:①resident STT rotator 没调
`handleLineDown/handleLineReconnected`;②一个真·correctness 陷阱(见下)。

## 陷阱 (为什么不是纯 wiring)
`handleLineReconnected` 有两行是「假设 turn 死于 session」的清理:
- `this.turnText.set(leadId, "")`
- `if (this.currentSpeaker === leadId) this.currentSpeaker = undefined;`

对 gemini 对:session = 耳+脑,session 死 = turn 死。
对 **resident 错**:STT session(纯耳朵,NOOP_BRAIN)死 ≠ resident 回答死(回答在常驻大脑那个
独立进程 / ResidentLineDriver 上跑)。若 STT 在 resident 正回答时闪断而naively 清 currentSpeaker,
后续 `handleResidentAnswer` 会因 `leadId !== currentSpeaker` 提前 return → **丢掉她那轮回答的
caption + fan-out**。turnText 对 resident 无用(driver 自己持文本),清了无害;currentSpeaker 是真雷。

## 设计
1. **HuddleSession.handleLineReconnected 变 resident-aware**:
   `const isResident = !!this.lines.get(leadId)?.resident;`
   对 resident **跳过** turn-death 清理(`turnText` reset + `currentSpeaker` 清)—— resident 的
   回答 turn 独立于 STT session。其余(linesDown/failed 清理、handoff、音频 replay、
   addressed-scoped watchdog)照旧。gemini 路径**字节不变**。

2. **wireResidentLine 的 STT rotator 接上恢复机制**(耳朵层,不碰大脑输出 turn):
   - `onDown: () => huddleRef.current?.handleLineDown(p.leadId)` —— 真实「线路闪断」状态。
   - `onReconnected`:调 `huddleRef.current?.handleLineReconnected(p.leadId)`(重放缓冲音频进
     后继 STT session → 转写补到 → 常驻大脑经既有 transcript→handleLineTranscript→respond 流拿到
     她的话)。**不 flush resident mouth**(STT 闪断 ≠ resident 回答死,gemini 才 flush 因为死的是
     它的答);**不 feed.replay**(STT session 是 NOOP_BRAIN,无对话上下文可丢;上下文在常驻大脑
     进程里、跨 STT 闪断存活)。用 `{replayed, handoffDelivered}` 返回选对 TIV 提示。
   - resident line 的 `session` 补 `endUserTurn: () => rotator.endUserTurn()`(让 replay 能收句,
     否则后继 VAD 等不到静音)。

3. **切默认**:`config.ts` `huddle.brain.mode` 默认 gemini → resident。字节兼容口子保留
   (显式配 gemini 仍走老路;absent 现在 = resident)。

## 测试 (RED→GREEN)
- resident STT 断线 + 重放:她说话中途 STT 断 → 缓冲音频 replay 进后继 session + endUserTurn 收句
  (对等 gemini 的 qa-fly545-r5-stt-leg)。
- **turn 独立性回归(本设计的核心 correctness)**:resident 正回答时 STT 闪断 → currentSpeaker
  不被清 → 她那轮 `handleResidentAnswer` 仍 caption + fan-out(不丢)。
- resident onReconnected 不 flush resident mouth、不 feed.replay。
- 默认 = resident:config 不配 mode → resident;显式 gemini → gemini(字节兼容)。
- gemini 路径 handleLineReconnected 字节不变(现有 qa-fly545-r4 / r5 全绿)。

## 流程
brainstorm(本文)→ TDD → Codex code review → QA → Annie end-to-end 测。设计方向 Tadashi 授权我自决;
无必须他拍的点(纯运行时合同判断)。不 ship 不自 merge,verify-approval gate。
