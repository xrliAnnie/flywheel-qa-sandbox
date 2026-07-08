# FLY-968 V8-OpenAI + V9 — OpenAI 基础面真机验证

Issue: FLY-968
日期: 2026-07-07
基于: ../plan.md §3 P2

## Verdict

- **V8-OpenAI（中文声线）= PASS**：10 内置声线全部完成同句中文朗读，自动初筛
  可懂度 10/10 满分（0-2 制全 2 分）；≥3 个可用且可区分（初筛 top3 =
  marin(女)/shimmer(低男)/echo(中男)）。wav 样本落 `out/s3-voice-*.wav` 供
  founder 终审。
- **V9（function calling + 混说转写）= PASS**：语音触发真 tool call 全事件链
  跑通（speech-end→call 710ms）；u2 混说句转写 check/status/PR/approve 英文词
  全对，可辨认。
- **barge-in（附带）**：response 播报中推新语音，`speech_started` 后 **34ms**
  服务端自动 cancel（`response.done status=cancelled`），随即对新输入正常起新
  response——打断语义与文档描述一致，且是三家里我们实测过反应最快的。

## ① 声线（model=gpt-realtime-2.1，同句:「大家好，我是语音会议里的工程 Lead。Huddle 模式今天可以用了。」）

自动初筛 = model-as-judge（gemini-2.5-flash 音频入：逐字转写比对 + 声学描述；
只做第一道筛，方法学与 Gemini 侧一致，见 v8-gemini-voice-shortlist-predeclared.md）：

| voice | 可懂度(0-2) | 性别/音高 | 逐字 | 音色 |
|-------|------------|-----------|------|------|
| alloy | 2 | 男/中 | 完全一致 | 清晰稳定，略带共鸣 |
| ash | 2 | 男/中 | 完全一致 | 清晰，语速适中 |
| ballad | 2 | 男/中 | 完全一致 | 清晰，语速平稳 |
| cedar | 2 | 男/中 | 轻微出入 | 清晰洪亮，略带磁性 |
| coral | 2 | 男/中 | 轻微出入 | 清晰，带些共鸣 |
| echo | 2 | 男/中 | 完全一致 | 沉稳略低 |
| marin | 2 | 女/中 | 完全一致 | 清晰自然，语速平稳 |
| sage | 2 | 女/中 | 完全一致 | 清晰平稳，音色柔和 |
| shimmer | 2 | 男/低 | 完全一致 | 清晰略带磁性 |
| verse | 2 | 男/中 | 完全一致 | 洪亮略低有磁性 |

初筛 top3（judge 给两两可区分度 2/3）：**marin / shimmer / echo**。
注意声线分布偏男声（判读 8 男 2 女），女声弹药比 Gemini 侧薄。

## ② function calling（V9）

- 输入 = u2 真语音（「帮我 check 一下 FLY-968 的 status…」），session 声明
  `get_issue_status(issue_id)` 工具。
- 事件链：`speech_stopped` → `response.created` →
  `response.function_call_arguments.delta ×9` → `.done`（args =
  `{"issue_id":"FLYT-968"}`）→ 客户端回填 `function_call_output` →
  `response.create` → 终答「状态：进行中。PR：尚未批准。」
- speech-end→call 710ms。issue 号被听成 "FLYT-968"（专名转写误差，与 V1 的
  "flight968" 同源——编号类专名需要词表纠偏，工具侧可做模糊匹配）。

## ③ barge-in 时间线（节选）

```
1455  input_audio_buffer.speech_started      (第一问)
5375  response.created                        (开始答)
6234  CLIENT: 播报中推入新语音
6921  input_audio_buffer.speech_started       (VAD 捕获打断)
6955  response.done status=cancelled          (+34ms 自动取消)
10702 response.created                        (对新问题起新 response)
```

## 复现

```bash
cd engineering/spike/FLY-968-voice-bakeoff
node s3-openai-basics.mjs voices   # ① 10 声线 wav
node s3-openai-basics.mjs tool     # ② tool call
node s3-openai-basics.mjs barge    # ③ barge-in
GEMINI_API_KEY=... node s4b-voice-judge.mjs out/s3-voice- openai   # 初筛打分
```
