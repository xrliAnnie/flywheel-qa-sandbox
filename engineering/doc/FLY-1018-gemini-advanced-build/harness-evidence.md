# FLY-1018 M3-harness 复演证据 — 降级 seam replay(chunk 15)

Issue: FLY-1018 (URL 不可得,只写 issue 号)
日期: 2026-07-09
基于: plan.md §5(M3-harness 行:spike run-s3-live.mjs 模式降级复演,不进 CI)

## 跑法

`packages/gemini-agent/scripts/harness-delegate-replay.mjs`(需 GEMINI_API_KEY):

- **Live 层**:文本驱动(不起真音频)——直接按 voice-core `LiveToolSpec.handler(args, {signal})` 合同 dispatch `delegate_task`;
- **delegate**:真 `createDelegateTool`(build 后的 dist 产物);
- **深脑**:真 `runAgentSession` → 真 Gemini API(`gemini-3.5-flash`,Interactions surface)→ spike 的合同对齐 mock-bridge(`engineering/spike/FLY-997-gemini-agent/mock-bridge.mjs`,error 体逐字对齐生产);
- 指令 = N1 短链:建 issue → dispatch runner → poll status → save memory。

## 结果(两次 clean run,2026-07-09)

| 判据 | 结果 |
|------|------|
| LiveToolSpec seam 兼容(类型级赋值 + 结构) | PASS(CI 单测 + harness 真跑) |
| ACK 即回(不等深脑) | **8ms / 12ms** |
| 深脑 N1 短链 completed | PASS,**5 tool calls,0 hallucinated,0 schema 违例** |
| 模型自发 search_memory 先查 convention 再 dispatch(spike N2 行为) | PASS(按 fixture 记忆选了 `backend-executor` + `plan_only`) |
| 完成经 CompletionSink 注回(Discord 文本形态) | PASS(✅ 文案含 finalText) |
| 审计完整(session_start 先于 model_call;delegate_accept 先于 ACK) | PASS(session-<sid>.jsonl + delegate.jsonl) |

## harness 抓到的真 wire bug(mock 单测测不出)

初版 client 把 `abortSignal` 放进 `interactions.create` 的请求 body —— 真
Interactions API 直接 400 `Unknown parameter 'abortSignal'`(mock/单测的假
SDK 不校验 body,全绿)。修法:abort 走 SDK 第二参数
`options.fetchOptions.signal`,body 保持纯 wire 参数。这正是 plan §8「Interactions
experimental,implement 当日冒烟复核」要防的那类漂移。

## 边界(如实)

- 真音频 Live + 语音注回不在本复演内(依赖 voice-bridge PR-2,plan §5 明确不承诺);
- Bridge 面用的是合同对齐 mock;**真 Bridge(529 Room)E2E 归独立 QA(plan §7)**。
