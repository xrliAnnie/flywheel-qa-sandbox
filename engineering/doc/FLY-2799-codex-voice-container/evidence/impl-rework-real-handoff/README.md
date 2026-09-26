# FLY-2799 真引擎交办复验 — 实测记录
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799)
日期: 2026-09-24
基于: QA 报告 https://fw-reports-356a6d.vercel.app/r/4efc3dbf2325b3c4ee4b1291199b8283/ (qa@1 FAIL @652ac775d)

## 做了什么

用 QA 的真引擎台架（`~/.flywheel/artifacts/FLY-2799-qa/qa4-real-codex-bench/real-codex-e2e.mjs`，未改一字）
对返工后本地构建的 dist 复跑一次，参数 `soleUser=1`：

- 真 `codex-standalone 0.156.1` + 真 `CodexVoiceContainer` / `CodexVoiceBackend` / `CodexRealtimeTransport`
- macOS `say` 合成的两句中文语音，按 20ms 实时节奏喂入：「你好，你是谁？你手上现在有什么事？」→「你帮我去看一下 2799 现在是什么状态」
- 语音 key 只从已授权的 `~/.flywheel/.env` 读，不进日志；证据落盘前已扫过 `sk-` / `Bearer` / `OPENAI_API_KEY`，0 命中

## 结论（对照 QA 同台架 run1/run2）

| 项 | QA 在 652ac775d | 本次返工后 |
|---|---|---|
| `handoff_request` 被转成交办 | 0 | **1**（`codex_execution_handoff` state=dispatched） |
| 交办绑定的话与归属 | — | 「你帮我去看一下两千七百九十九现在是什么状态。」known / founder |
| 后台 delegation 回合 | 跑满 16s，`turn/completed status=failed` | 约 95ms 内被 `turn/interrupt`，`turn/completed status=interrupted`，durationMs=27 |
| app-server `error` 通知（401 重试） | 10 | **0** |
| 会话中途结束 / session error | 否 / 0 | 否 / 0 |
| Lead 回复经 `speak()` 念出 | 真播，receipt `speech_not_equivalent` | 同上（「FLY-2799」念成「F L Y 二七九九」，QA 已判非阻塞，未在本轮处理） |

文件：`summary.json`（台架汇总）、`bench.jsonl`（全部非音频通知 + 证据事件，已脱敏）。

## 边界

- 这是引擎层真机证据，不是 529 真房：交办的下游（Bridge `voice_handoffs` 落行、Lead 信箱、Lead 回复念回）
  在台架里由台架自带的 `handoffToLead` 桩承接，真房里的这一段仍由 QA 在 529 房验。
- 只跑了单人房阳性一场；「无法绑定到唯一真人时不交办」的阴性由
  `packages/voice-codex/src/__tests__/codex-transport.test.ts` 的录制序列回放用例覆盖，真引擎阴性场未跑。
