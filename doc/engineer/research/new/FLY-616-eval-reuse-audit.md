# Research: eval 通用质量测量 — 复用审计（reuse audit） — FLY-616

**Issue**: FLY-616
**Date**: 2026-06-28
**Source**: `doc/engineer/exploration/new/FLY-616-eval-output-quality.md`

> 目的：核实『复用现有 QA 框架 + 已产出信号』是否成立，列清楚**能直接借的**和**要新建的**，
> 让 plan 不凭空写。结论：v1 的指标几乎全是**聚合系统已经结构化产出的信号**，新建面很小。

---

## 1. 复用锚点（已核实存在于代码库）

### 1.1 FLY-599 eval bench —— 直接母版（`scripts/qa-fly-599/`，git history）

可量化、可重复的 eval 已经做过一次（独立 QA discord-reply prompt）。结构：

- `lib/leak-classify.mjs` —— **纯函数** ground-truth 判定（读 transcript JSONL），12 单测。
- `classify-cli.mjs` —— 读产物 → per-item 判定 JSON（counts / rate / firstLeakIndex / results）。
- `scorecard.mjs` —— 输入 `{meta, variants:[{classification, humanness?}]}` → **Apple-light HTML** +
  选 winner + verdict。**主观（humanness）机器初筛 + Annie 定线**。

→ FLY-616 = 把『variant』泛化成『condition』、把『漏发率』泛化成『客观质量指标集』、把
`scorecard.mjs` 泛化成 condition 对比。`scorecard.mjs` 是可直接改写的母版。

### 1.2 `ExecutionEvidenceCollector`（`packages/edge-worker/src/ExecutionEvidenceCollector.ts`）

**已经按 session 收集结构化 evidence**（best-effort，优雅降级）：

```
interface ExecutionEvidence {
  commitCount, filesChangedCount, commitMessages,
  changedFilePaths, linesAdded, linesRemoved, diffSummary, headSha,
  partial, durationMs,
  landingStatus?: LandingStatus   // 从 land-status.json，含 merged/failed/signal_missing 语义 + gh 校验
}
```

→ 这是 **diff economy**（linesAdded/Removed/filesChanged）+ **task landing**（landingStatus）的现成来源，
已测试、已有 GitHub API 校验。eval metric 提取**复用这个结构**，不重造 git/landing 采集。

### 1.3 `qa_result` event（FLY-579，`packages/flywheel-comm/src/commands/qa-result.ts`）

独立 auto-QA Runner 产出 `{status: pass|fail, targetExecutionId, qaExecutionId, prHeadSha, summary}`，
由 `AutoQaCoordinator`（`packages/teamlead/src/bridge/auto-qa-coordinator.ts`）消费。

→ **QA verdict 是系统一等结构化信号**，不是要新造。eval 读它当 `qaVerdict` 维度。

### 1.4 StateStore sessions + session_events（`packages/teamlead/src/StateStore.ts` / `DirectEventSink.ts`）

- `sessions`：`decision_route`（completed / needs_review / blocked / pr_handoff / no_code ...）、
  `status`、`adapter_type`（哪个 backend：claude / codex / agy / kimi —— **condition 维度直接可读**）、`pr_number`、`headSha`。
- `session_events`：stage 转换、review、gate 等带时间戳的事件流。

→ **task success**（route/status）+ **iteration cost**（数 review/QA 返工事件）+ **condition 标签**（adapter_type）
都从这里取。

### 1.5 land-status.json（本 run 也在写）

`{status: ready_to_merge|merged|failed, prNumber, mergeCommitSha}`。`ExecutionEvidenceCollector.readLandingStatus`
已有三态语义 + merged 的 gh 校验。→ task landing 的权威信号。

### 1.6 QA 框架 + 529 slot 框架（`packages/qa-framework/`）

- 5 步 QA 协议 + config loader（`src/config/`）。
- 529 real-runner slot 框架（`scripts/test-deploy.sh` / `inject-linear-issue.sh` / `test-teardown.sh`）：
  起**真 runner** 跑 `xrliAnnie/flywheel-qa-sandbox` 的 issue。**v1 执行借这套**，不重造 runner-spawner。

---

## 2. 映射：质量维度 → 现成信号源

| eval 维度（Tier 0） | 取自 | 形态 |
|---|---|---|
| task success | StateStore `sessions.decision_route` / `status` + land-status | 枚举（completed/blocked/failed/merged）|
| QA verdict | `qa_result` event / AutoQaCoordinator 记录 | pass / fail / (none) |
| CI health | land-status（`ready_to_merge` 隐含 CI 绿）+ 可选 `gh pr checks` | green / red / unknown |
| iteration cost | `session_events`（review / qa-fail 返工计数）/ comm.db gate rounds | 整数 |
| diff economy（报告项） | `ExecutionEvidence`（linesAdded/Removed/filesChanged） | 数字 |
| condition 标签 | `sessions.adapter_type` + 外部传入 condition label | 字符串 |
| 主观质量（v1 deferred） | —（schema 留槽，沿用 FLY-599 humanness 模式）| 0–10 + Annie 定线 |

---

## 3. 要新建的（很小）

1. **metric 提取器（纯函数 + CLI）**：输入 = 一批 (issue, condition) 的产物句柄（exec-id / land-status 路径 /
   sandbox repo），输出 = `QualityMetrics[]`。复用 §1.2/§1.3/§1.4 的读取，**自己不重造采集**，只做归一 + 聚合。
2. **通用 scorecard**：改写 `scorecard.mjs`：input `{meta, conditions:[{label, tasks:[QualityMetrics], aggregate}]}`
   → Apple-light HTML 对比 + verdict（持平 / 下降 / 数据不足）+ 主观槽。
3. **schema + 单测**：`QualityMetrics` / `EvalScorecardInput` 的 zod schema（沿用 qa-framework `src/config/types.ts`
   的 zod 风格）+ 纯函数聚合/verdict 的单测（沿用 FLY-599 `leak-classify.test.mjs` 模式）。
4. **README + runbook**：怎么跑一次 condition A vs B 对比（FLY-615 ponytail 当样例）。

---

## 4. 不复用 / 明确否决

- ❌ 从零建 eval 框架（违反 Cass + simplicity）。
- ❌ v1 造执行编排器（529 slot 框架已能起真 run；编排留 follow-up）。
- ❌ v1 主观 LLM-judge（留槽）。
- ❌ 碰生产（沿用 529 隔离）。

---

## 5. 风险 / 开放点

- **小样本噪声**：3–5 任务下单次差异可能是抖动，不是质量变化 → v1 不设数字 SLA，摊数字给人定线；
  verdict 含『数据不足』态。Follow-up 可加多 trial / 方差（FLY-599 variant B 跑了 28t）。
- **CI green 的权威度**：`ready_to_merge` 隐含 CI 绿，但更稳是显式 `gh pr checks`；v1 先用 land-status，
  `gh pr checks` 作可选增强。
- **condition 注入**：ponytail off/on 的实际开关 = FLY-615 的活；eval 只消费『跑完且打了 condition 标签』的产物，
  不负责注入 condition（解耦）。
