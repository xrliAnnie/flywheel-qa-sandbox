# FLY-616 — eval：测量产出质量（通用能力）

一个 **condition 无关** 的「测量 + scorecard」层：给两个 condition（如 ponytail off/on、
换模型、换 backend）跑同一组任务，客观回答 **「这次改动后产出质量有没有掉」**。
第一用途 = ponytail 灰度 A/B，但对任何改动通用。

> 设计：`doc/engineer/plan/inprogress/v1.61.0-FLY-616-eval-output-quality.md`
> （Annie brainstorm LOCKED + Codex design review 7 轮全收敛）。

## 量什么

| 信号 | 角色 | 来源 |
|---|---|---|
| completion route / 可评估 PR 产出（hardSuccess）| **进 verdict** | StateStore `sessions`（只读）+ land-status |
| QA 过不过 | **进 verdict** | `auto_qa_record`（只读，FLY-579）|
| CI 绿（v1：land-status `ready_to_merge`/`merged` 隐含；`gh pr checks` = follow-up）| **进 verdict** | land-status |
| 返工轮数（v1 = `qaFailLoops`）| advisory，不进总判定 | `auto_qa_record` |
| 成本（**token 读 FLY-614 不重算** / diff / 耗时）| context，不进 verdict | FLY-614 store（v1 mocked→null）+ git |
| 回炉率（过 QA 后又 reopen / 二次 main-runner / re-fix）| 滞后软信号，不进 verdict | Linear 状态转换史 + StateStore（v1 mocked / follow-up）|
| 优雅 / 可维护 / 真解决 | **下一阶段**（LLM-judge ≥80% 人校准 + 抽查）| — |

**铁律**：缺质量硬信号绝不当 pass（标 partial）；lagging/cost 缺失不影响 partial。

## 判定（count-first advisory）

摊全部数字 + 给软建议（**看起来持平 / 看起来掉了 / 说不准**），**Annie 定最终线、不自动卡**：
- 比**成功个数**不只百分比；`looks_dropped` 需 ≥2 任务掉、或 1 任务掉且另一指标也掉（拒绝把 3–5 样本单任务回退叫 drop）。
- Wilson 95% CI **仅 advisory 展示**，绝不当门。
- 样本 < 3 或任一硬指标 coverage < 1 → **数据不足**（仍摊数字）。
- **不做加权总分**（免掩盖失败模式）。

## 跑一次 ponytail A/B

```bash
# 0) 一次性 build（cli 消费 dist）
pnpm --filter flywheel-qa-framework build

# 1) 执行（借现有 529 slot 框架；eval 不负责注入 condition）
#    把同一小批任务（3–5 个 sandbox issue）各跑两遍：一遍 ponytail off、一遍 on。
#    每跑一条，抓 /api/runs/start 返回的 executionId，写进 manifest（见 fixtures/*.manifest.json）。

# 2) 提取每个 condition 的客观指标（只读 teamlead.db）
node eval/cli.mjs extract --manifest runs/ponytail-off.manifest.json --out runs/off.json
node eval/cli.mjs extract --manifest runs/ponytail-on.manifest.json  --out runs/on.json

# 3) 出对比 scorecard（第一个 = baseline）
node eval/cli.mjs scorecard --baseline runs/off.json --candidate runs/on.json --out runs/scorecard.html
```

`fixtures/` 有可直接跑的样例（`ponytail-{off,on}.condition.json` + `ponytail-off.manifest.json`）：

```bash
node eval/cli.mjs scorecard \
  --baseline eval/fixtures/ponytail-off.condition.json \
  --candidate eval/fixtures/ponytail-on.condition.json \
  --out /tmp/scorecard.html
```

## v1 边界（诚实）

- **执行借现成 529**，eval 只测量 + 对比 + 出 scorecard（不造 runner 编排器）。
- **token 读 FLY-614**：v1 mocked（`tokenUsage=null`）；真接入待 FLY-614 暴露稳定 public 读面
  （如 `token_usage_by_run` view / `getTokenUsageByRun({projectName,issueId,execId})`），616 薄适配器对齐它、**绝不直连 raw 表**。
- **回炉率（滞后信号）**：对真实生产 issue cohort 最有意义；v1 sandbox 集通常 `not_applicable`。
  纯逻辑（reopen 状态转换检测 / 排除 auto-QA 的 second-runner）已测；真 Linear 状态历史采集 = follow-up。
- **主观质量**：下一阶段（LLM-judge 先跟人 ≥80% 校准 + 人工抽查）。
- DB 一律 **真只读**（better-sqlite3 `readonly:true`+`fileMustExist:true`，绝不实例化 StateStore），**不碰生产**。

## 程序化 API

```ts
import {
  collectMetrics, createSqliteReaders, aggregate, compare,
  EvalRunManifestSchema, type QualityMetrics,
} from "flywheel-qa-framework";
```
