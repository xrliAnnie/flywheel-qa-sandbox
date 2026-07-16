# #555 常驻大脑 /glaw 真机测 (FLY-1186) — 结论: FAIL (STT 层 abort)

Issue: FLY-1160 (#555 常驻大脑) — Annie 真机验收, venue head c7398cac
日期: 2026-07-11
基于: fly1169-founder-retest-fail.md (545 R4 上一次 FAIL), qa-verdict-opus.md

## 一句话结论

Annie 真机测 #555 常驻 /glaw (meeting FLY-1186) = **FAIL** —— **Gemini STT 连接 abort**
(与 545 同款 `The operation was aborted`), 砸在她第一轮, 她那句音频在 abort 窗口丢了没转写 →
resident 没东西答干等 → 她看到「还在处理」cue → **中途退房**。但比 545 近了一大步: resident 脑子
扛住 abort 没死 (独立持久进程), STT 单次重连成功 (resumed=false, 没像 545 反复抽风)。

## 铁证 — daemon-555 log 全序

```
[voice-bridge] meeting FLY-1186 assembling
[voice-bridge] [resident-line] turn cancelled: resident turn cancelled
[voice-bridge] [meeting] resident line flywheel-eng-lead STT error: Gemini Live connection closed unexpectedly: The operation was aborted.
[voice-bridge] [meeting] resident line flywheel-eng-lead STT reconnected (resumed=false)
[voice-bridge] [huddle] founder left mid-meeting — degraded landing
[voice-bridge] meeting FLY-1186 released
```
- transcript `~/.flywheel/huddle/transcripts/FLY-1186.jsonl` = **0 行 (空)** = 她音频从未成功转写。
- resident claude 子进程 (PID 30949) 随 meeting release 已 reaped。
- 诊断当时实测: resident 子进程活着但 0.0% CPU / S 睡眠 / 无 Read/Grep 工具子进程 = idle (非正常读项目)。

## 根因 + 判定

**Gemini STT 连接 abort (P0, 同 545 abort class)。** 545 的 resumeHandle fix 修的是**对话层**连接的
resume; **STT 层** (resident 架构下 Gemini 只做 STT) 这条 Gemini Live 连接有自己的 abort 路径, **没被
545 fix 覆盖到**。abort 发生 → 她那轮音频丢失 → resident 干等 → 退房。

## #555 架构确实赢的地方 (这轮没救回来但结构上强过 545)

1. ✅ **resident 脑子扛住 abort 没死** —— 独立持久 claude 进程, STT abort 没杀它。545 那次 abort 直接
   把对话干死 (empty-brain 裸 LLM)。
2. ✅ **STT 单次重连成功** (resumed=false; 对 STT 无所谓, 新连接照转新音频), **没像 545 反复抽风**。
3. ❌ 但 abort 正好砸在她第一轮 + 她很快退了, 没等重连后的下一轮证明「能接回」。
4. ✅ pre-verify 已独立验证核心常驻脑: 真读项目答 issue (点3) + SIGKILL→--resume→memory intact (点4)
   + 多轮记忆 —— 脑子本身是对的; 挂的是**入口 STT 连接的脆弱**。

## 剩余 defect (kickback → #555 实现线 3c199365)

1. **P0: Gemini STT 连接 abort 仍复现** —— 要么根治 abort (Tadashi P0(a) 'make it break less', 现在
   在 STT 层), 要么 **STT abort 时缓冲/重放她那句音频** (跨重连保住 utterance, 别让她的话在 abort 窗口
   静默丢失)。
2. **F2 cue-lies: STT 断了却显示「还在处理」** —— 应显示「连接恢复中 / 请再说一遍」让她知道要重说,
   而不是干等 (与 545 F2 status-cue-lies 同类)。
3. founder 中途退房 (degraded landing)。

## 环境

- head c7398cac (#555 合体分支, 545 e74b10b8 已折入), venue start-555-staged.sh (resident /glaw,
  Annie=founder pristine, port 9882/9883)。
- 首拉无 crash, 预验四点 1/3/4 PASS (点2 cmux=FLY-1184 fast-follow)。本次 FAIL 根因是**会中** STT abort。

## RE-TEST 硬判据 (Tadashi 7defc387 + QA 自省)

1. **(Tadashi) 真机注入 STT 断连**: kill Gemini STT 连接 → 重连后她的话**必须继续转写 + 被回答**, 跑通才算过。
2. **(QA 自省) pre-verify 必须真组装一个 meeting**: 本次 pre-verify 只直喂了 resident brain (绕过 meeting/STT),
   所以漏掉了**组装期 STT abort**。下次 pre-verify 必须走真 meeting 组装 (ears→Gemini STT→resident 全链),
   才能在请 founder 之前抓到 assembly-period STT abort。Annie 原话: 「QA 没测就别叫我测」——教训成立。
3. 根因归属: FLY-1169 fake-resume 家族在 **resident line STT 腿**的复发/未覆盖面 (resumeHandle fix 覆盖了
   rotator, 但 STT 重连后的 ears→STT 接管没真正恢复)。kickback → 3dcb1b94。
