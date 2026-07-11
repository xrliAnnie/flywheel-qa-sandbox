# FLY-1065 真机 E2E:turn 聚合链对生产 model 全过(8/8)

Issue: FLY-1065 (https://linear.app/geoforge3d/issue/FLY-1065/voice-gemini-文本面板双向转写-会话记录持久化annie-真机验收反馈)
日期: 2026-07-09
基于: plan.md P7「staged E2E」(voice-core 腿) + evidence/finished-flag-probe.md(信号链修订依据)

## 跑法

`packages/voice-core/e2e/fly1065-live-aggregation.mjs` —— 走**真 GeminiLiveBackend**(不是裸 SDK;transport→connector→session 聚合→sink 全链)直连生产同款 model `gemini-3.1-flash-live-preview`,输入 = mini-spike 同一段合成中文语音(「今天我们聊一聊转写面板…」,16kHz PCM,20ms 帧实时节奏)+ `endUserTurn()`,收全部 transcript 事件时序 + JSONL sink。原始时序:`live-aggregation-e2e.json`;sink 原件:`live-aggregation-e2e-sink.jsonl`。

## 断言(8/8 ✅,exit 0)

| # | 断言 | 结果 |
|---|------|------|
| 1 | user final 恰 1 条(turn 聚合,非逐分片) | ✅ |
| 2 | assistant final 恰 1 条(多信号不多发) | ✅ |
| 3 | user final 是整句聚合文本 | ✅(`今 天 我 们 聊 一 聊 转 写 面 板 …`) |
| 4 | assistant final = 分片拼接全文 | ✅(36+ 分片 → 一条整轮) |
| 5 | user final 先于 assistant final(首个模型输出即 flush) | ✅(@6869ms < @10326ms) |
| 6 | assistant final 先于 response-done(generation-complete flush,不等 turnComplete) | ✅ |
| 7 | JSONL sink 恰 2 行,均 final:true | ✅ |
| 8 | sink 两行 = 双角色聚合文本 | ✅ |

## 关键时序(与探针互证)

- user final @**6869ms**(她说完、模型接话那一刻——不是轮末);
- assistant final @**10326ms**;response-done(turnComplete)@**20523ms**;
- **caption 领先 turnComplete 10197ms** —— 与探针实测的 10.2s 空窗完全吻合:若按原「turnComplete 兜底」方案,字幕要晚约十秒;修订后的信号链(首个输出 flush user / generation-complete flush assistant)把「实时」拿回来了。这是 §6b 续跑修订的行为级铁证。

## 边界(Discord staged 腿 → QA 阶段)

本 E2E 覆盖 voice-core 聚合链(本 issue 的地基与主要风险面)。**Discord TIV 渲染 + kickoff issue 双 comment 的 staged 全链**需要 staged rig 凭证(pool bot tokens / staged Bridge / staged guild),implement runner 环境不持有(967 先例:staged rig 由 QA runner 持凭证跑)。渲染/落地层已由 197 个 voice-bridge 单测覆盖(TivPresenter 合同、wiring 全链、landing chunk 幂等)。**QA 阶段断言清单**(gemini-staged.mjs 形态 + autostart,一轮后):
1. TIV 频道出现 ≥1 条 caption 消息(`🗣️ **Annie**:…` / `💬 **助理**:…`,逐轮短消息);
2. status 全程只 1 条消息(edit-in-place,无刷屏);
3. kickoff issue 出现 **纪要 + 逐字记录** 两类 comment(marker:`assistant-summary` / `assistant-transcript … chunk i/n`);
4. `~/.flywheel/voice-assistant/<project>/<sessionId>.jsonl` 落盘非空(路径 = landing 读的同一文件);
5. 中英混说一轮:字幕分轮/角色不乱(语言合同)。
