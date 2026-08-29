# FLY-1006 M2 P6-final — Annie 真人终验 live session 观察（① 修复坐实 + 脑限额健壮性 follow-up）

Issue: FLY-1006 (URL 不可得,只写 issue 号)
日期: 2026-07-11
基于: m2-r3-reverify.md（R3 PASS）、m2-annie-p6-session.md（P6 QA-FAIL 3 条）;live session 76ccc5f5-26b5-4657-9ade-15d1583acfd5

## 背景

R3 三条 defect 修复经机器 + 逻辑 + 真机(bot 注入)复验 PASS 后,Tadashi 带 Annie 做
真人终验(pristine head 11ad1b96 + 新 shim single-flight + venue+shim+tunnel health
三连绿)。本文件记录她这次 live session 的观察。

## ① 语音三条修复 —— live 真人会话再次坐实(session 76ccc5f5 turn-1)

Annie 第一句「你能听见我说话吗?」这一轮,三条修复全部 live 生效:

- **① barge-in 风暴根治**:`interruption source:local` = **0**(P6 是单 utterance 8+ 的
  风暴 → 每轮延迟雪崩)。`barge_in_idle` = 少量、不 suppress 答案。自然停顿不再误打断。
- **②③ 文本 + 状态上屏**:语音频道(1485787273193853170)文本区实测
  `🎙 在听 → 🧠 正在处理… → 🗣 <她的话> → 💬 回话中 → 🤖 <回话>` 完整生命周期。
  她能从文本分清「在想 vs 坏了」。
- **first_audio 首轮 3401ms**:不是 P6 的 28s 雪崩(收敛区间)。

→ 语音修复层(EarsReceiver holdoff + idle-no-suppress + TIV caption/status)在真人
live 会话下确认工作。**这三条不是本次 live 会话的问题。**

## 🔴 本次 live 会话真正的阻塞 —— 脑后端瞬时限额 + ElevenLabs 会话被毒死

**现象**(session 76ccc5f5):
- turn-1 唯一一条 `agent_response` = 错误串
  `"You've hit your session limit · resets 11:10pm (America/Los_Angeles)(brain error)"`
  —— shim 里 `claude -p` 撞了 Claude 订阅 session limit,shim 打了 `(brain error)` 标签,
  把原始 CLI 报错串当回答透传给 ElevenLabs → 播/显示给 Annie。
- turn 2-4:她一直说话,全是 `speech_end → cue_start → cue_stop → barge_in_idle` 死
  循环,**零 user_transcript、零 first_audio、零回话** —— ElevenLabs 那个 conversation
  在收到 turn-1 的 brain-error 后被毒死,不再转写/不再调 shim。

**定位**(QA 独立诊断):
- shim 用默认 `~/.claude`,跟 runner 同账号。事后(21:xx)直接跑 `claude -p` 返回 OK,
  直接打 shim 的 custom-LLM 端点返回真 claude 输出「SHIM_OK」→ **脑已恢复、shim 健康、
  不是 wedge**。限额是瞬时的。
- 真凶 = **ElevenLabs 会话侧状态被 turn-1 brain-error 毒死,不自恢复**。

**恢复动作**:不重启 shim(脑已恢复、shim 健康、同账号)。让 Annie **/eleven stop 再
重新 /eleven** 开干净会话即可(Tadashi relay,已确认)。

## 健壮性 follow-up(挂 FLY-1160,不阻塞今晚终验)

脑撞**瞬时**限额/错误时,当前 /eleven 行为有两个缺口:

1. **原始 CLI 报错串当回答播给用户**:她听到/看到
   「You've hit your session limit · resets 11:10pm」这种工程报错,而不是人话。
   → 应:限额/脑错误时播人话,如『我这边脑子暂时忙,稍等再说一句』。
2. **一次脑错误毒死整个 ElevenLabs 会话、不自恢复**:turn-1 报错后,后续所有轮次
   静默失败(连 STT 都不出),用户只能靠自己 /eleven stop 重开。
   → 应:脑错误后会话能自恢复(下一轮从零重试),不把错误串灌进 conversation 状态。

这与 /glaw(545) F1『脑/后端抖动时优雅降级 + 自恢复』同一类健壮性标准。今晚先让
Annie 重开会话验语音三条修复;这条健壮性缺口作为 follow-up。

## 复现

venue 起好后真人进 VC /eleven。若 `claude -p` 恰好撞订阅限额,turn-1 会收到
brain-error 串、后续轮次静默死。等限额恢复后 /eleven stop + 重开即可。观察
session jsonl `~/.flywheel/voice-eleven/flywheel/<id>.jsonl` 的 agent_response
(是否出现 brain error 串)+ 后续轮次是否有 user_transcript。
