# FLY-2799 插话后交办 — 真引擎复验记录
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799)
日期: 2026-09-24
基于: QA 报告 https://fw-reports-356a6d.vercel.app/r/8e69ddbdf5b45f62f9aae89ed8cad3e8/ (qa attempt 2 FAIL @c11799762)

## 做了什么

用 QA 的两个真引擎台架，对返工后本地构建的 dist 复跑：
`~/.flywheel/artifacts/FLY-2799-qa/qa5-c11799762-bench/real-codex-e2e-barge.mjs`，未改一字；`BARGE=1` 表示在模型开口约 0.8s 后调用 `interrupt()`，随后紧接着说出交办请求。

- 真 `codex-standalone 0.156.1` + 真 `CodexVoiceContainer` / `CodexVoiceBackend` / `CodexRealtimeTransport`
- macOS `say` 合成的两句中文语音，按 20ms 实时节奏喂入
- 语音 key 只从已授权的 `~/.flywheel/.env` 读；落盘前已扫过 `sk-` / `Bearer` / `OPENAI_API_KEY`，0 命中

## 结论

| 目录 | 形态 | 插话证据 | 交办 | 模型交办时的原话 | 是否出声请重说 | Lead 回复念回 |
|---|---|---|---|---|---|---|
| `bargeSole2/` | 插话 + 单人房（QA run5/run6 的复现形） | `droppedBytes=0 providerInputPending=false inputGap=false` | **1 次**，known/founder | 「我确认一下。」 | 否 | completed / transcript_equivalent |
| `plainSole2/` | 不插话 + 单人房（已过项回归） | — | **1 次**，known/founder | 「我确认一下。」 | 否 | completed / transcript_equivalent |
| `bargeAmbiguous2/` | 插话 + 无法绑定唯一真人 | `inputGap=false` | 0 次（`known_user_missing`） | 「我确认一下。」 | **是**，逐字念出「刚才这件事还没有交给 Lead。我没能确认那句话是你说的。请再说一遍。」receipt completed / transcript_equivalent | completed / transcript_equivalent |
| `bargeAmbiguous/` | 同上，**加 `[BACKEND]` 规则之前** | `inputGap=false` | 0 次 | 「我确认一下。」 | 否：appendSpeech 已发出，模型却回了第二句「我确认一下。」，而 best_effort 回执误报 completed | speech_not_equivalent |

`bargeAmbiguous/` 是保留的反例：它说明 0.156.1 的 `appendSpeech` 会以一条带 `[BACKEND] ` 前缀的 user `input_text` 进入会话，由模型转述，而不是硬逐字通道。修法是在生产 realtime 提示词中补上研究阶段已验证的「`[BACKEND]` 开头的话要逐字念出、不回答、不交办」规则，并把「请重说」的回执改为 `verification: "required"`，让没念对时回执如实失败。

QA 在 c11799762 的对照（`qa5-c11799762-bench/run5`、`run6`）：插话证据是 `codex_input_gap generation_changed droppedBytes=0`，下一句被判为 `unknown/input_gap`，交办 0 次，模型仍口头说「好的，我先把这个请求交给后台代理」。

## 边界

- 引擎层真机证据，不是 529 真房：Bridge `voice_handoffs` 行、Lead 信箱、真人耳机听感仍由 QA 在真房验。
- 「插话时旧 generation 里确有未出终稿的语音 ⇒ 真丢、作废归属」这一格在真引擎上很难稳定造出来，由 `packages/voice-codex/src/__tests__/codex-transport.test.ts` 的真 transport + 真 backend 录制序列回放用例覆盖，真引擎未跑。
- 台架的 `handoffToLead` 是桩，所以 Lead 拒绝交办的出声路径只由单测覆盖。
