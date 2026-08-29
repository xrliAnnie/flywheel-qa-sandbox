# FLY-980 V1 — shim 合同验证（本地，无 ElevenLabs）

Issue: FLY-980（URL 见 plan.md）
日期: 2026-07-07（取证时间 PT 晚间）
基于: plan.md §S1/§S2

## Verdict: PASS

OpenAI chat.completions SSE 合同本地全绿：单测 15/15 + curl 三类回放全过。

## 1. 单测（node --test，无外部依赖）

```bash
cd engineering/spike/FLY-980-eleven && npm install && node --test shim.test.mjs
# ℹ tests 15 / pass 15 / fail 0
```

覆盖（V1 四组 + Codex R2 建议的 adapter/session/cwd 组）：

| 用例 | 结果 |
|------|------|
| SSE：role 首帧 + content delta + finish_reason=stop + `[DONE]` | ✅ |
| tools 数组存在 → 正常流式回复（容错） | ✅ |
| Bearer 缺失/错误 → 401 | ✅ |
| client abort → brain 收到 AbortSignal（子进程清理通路） | ✅ |
| messages→Turn[]：最后一条 user=turn.text，其余按序入 history，system 不进 history | ✅ |
| system 消息落 per-conversation identity 文件（persona override 通路） | ✅ |
| 两个 conversation key 不共享 resume brain | ✅ |
| `FLY980_RESUME=0` → 每请求 fresh brain 实例 | ✅ |
| CwdProcessRunner 转发 `{cwd}`（空 cwd seam） | ✅ |
| `force:<tool>` → OpenAI tool_calls 格式 + finish_reason=tool_calls | ✅ |
| stream:false → 聚合 chat.completion JSON | ✅ |
| **dedupeFinalEcho**（见 §3 发现） | ✅ |

## 2. curl 回放（echo 脑，S2）

```bash
mkdir -p out && FLY980_TOKEN=t FLY980_BRAIN=echo node shim.mjs 8980 &
# A1 纯文本(zh) / A2 带 tools / A3 错 token
curl -N localhost:8980/v1/chat/completions -H "Authorization: Bearer t" \
  -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"链路通了吗？"}]}'
```

- A1：role 帧 → 多个 content delta（中文按 6 字切块）→ stop → `[DONE]` ✅
- A2：tools 数组透传下正常回复 ✅；A3：HTTP 401 ✅
- B（中断）：`FLY980_SLEEP_MS=3000` + `curl --max-time 1` → jsonl 记录
  `{"type":"aborted","t":1127}`，AbortController 触发 ✅

## 3. 真 claude 脑本地两轮（S2 round C，haiku、空 cwd）

```bash
FLY980_TOKEN=t FLY980_BRAIN=claude FLY980_MODEL=haiku node shim.mjs 8982 &
# turn1: 全新会话+system persona；turn2: 同 conversation_id 问"我刚才问了你什么"
```

- turn1 回复正常（口语化中文）；turn2 **resume 记忆命中**（"你问我链路通了
  没有，要求一句话确认"）—— resume 模式下 shim 只发新 turn，回忆来自
  `--resume` session 本身 ✅
- 本地打点（无隧道、含 CLI 启动，单样本非中位数——正式数据见 V4）：
  fresh first_delta ≈ 6.9-10.1s；resume first_delta ≈ 5.7s

### 🔴 真机发现：claude -p 流会把完整回复重复吐一遍

`claude -p --output-format stream-json --include-partial-messages` 同时输出
`text_delta` 流 **和** 最终完整 `type:"assistant"` message；voice-core
`parseStreamLine` 两种形状都识别并 emit → 同一句话到 TTS 会念两遍。

- 复现：直接跑 claude -p 观察行类型序列（text_delta ×N 之后跟
  `type=assistant msg_content_list=True`）。
- spike 修复：shim 侧 `dedupeFinalEcho`（丢弃与本 turn 已累积文本完全相等的
  piece），测试覆盖；**voice-core 本体未动（D8'）**。
- ⚠️ follow-up：/glaw（FLY-543 生产路径）用同一 parser，可能同样念两遍 ——
  建议开 issue 验证/修 voice-core。

### 附带观察（进 V4 变量矩阵）

- haiku 默认先出 thinking_delta 再出 text_delta；`MAX_THINKING_TOKENS=0`
  单样本把 fresh 首文本 7.2s→4.4s，但 thinking 未完全消失 —— V4 阶梯把它
  作为附加配置行实测。
- CLI 启动→首个 stream 事件 ≈ 1.0s（进程冷启动是固定税）。

## 4. 复现环境

- shim: `engineering/spike/FLY-980-eleven/`（commit 见 git log
  `spike(FLY-980): S1`）
- voice-core dist: `pnpm --filter flywheel-voice-core build`（fresh checkout 必做）
- claude bin: `~/.local/bin/claude`；空 cwd: `~/fly980-eleven/cwd-empty/`
