# FLY-744 Token 日报重做 — 探索

Issue: FLY-744 (https://linear.app/geoforge3d/issue/FLY-744/redo-token-daily-report-restore-14-daypast-week-trend-week-display)
日期: 2026-07-01
基于: 无

## 1. 背景与 issue 前提

Annie 2026-07-01 报告:FLY-713 对 token 日报的「重做」丢了早前版本的功能(14 天/过去一周趋势、星期显示),= "rebuild loses old feature" 回归。issue 要求恢复 url1 的功能 + 保留 713 的改进($ 定价 + 可点 issue 链接 + 00:35 调度)。Cass 用 WebFetch 做过确认。

## 2. 审计发现(硬证据 —— 推翻部分前提)

我先审计了 codebase 与真实产物,而不是照 issue 直接重做。

### 2.1 两个 PR 都已 merge 到 main

- `cd822c28 feat(FLY-614)`:细粒度 token usage tracking(scanner/classifier/aggregator/store/report)。
- `0e2eb258 feat(FLY-713)`:$ 成本估算 + 可点 Linear issue 链接 + 00:30 调度。

`render-html.ts` / `build-report.ts` / `cli.ts` 的 git 历史只有这两个 commit —— 当前 main 同时含 614 + 713。

### 2.2 当前 main 代码 = 已有全部「被认为丢失」的功能

读 `render-html.ts` 确认代码里**已存在**:
- `trendBars()` —— 全 fleet 每日柱图,柱下标 `WEEKDAY_CN` 星期字、周末高亮、柱上标 token+$。
- `trendLines()` —— 每项目趋势线图,X 轴带星期。
- `weekdayCN()` —— 大日期显示 `周X`。
- `linearIssueUrl()` + `<a href>` —— issue 可点跳 Linear。
- `formatUsd()` —— $ 成本估算(713)。
- 项目/Lead/model 维度 + 项目内 issue-level 明细。
- `comparisonHero()` —— 改动前后用量对比 hero(**但仅当传 `--before/--after` 时渲染**)。

`cli.ts` daily 模式默认 `trendSince = shiftDay(reportDay, -27)`(28 天趋势窗),但 `before/after` 仅在显式传 flag 时才有。

### 2.3 真实产物验证

用 main 代码对**真 Supabase**(实测 30 天数据,06-02→07-01)跑 `token-report report --date 2026-06-30`,生成的 HTML(30KB)含:
- 趋势 06-03→06-30(约 28 天,x 轴按 4 天采样标签)。
- 大日期 `周二`。
- 11 个可点 Linear issue 链接。
- 页脚 = 713 文案「成本估算 · issue 可点跳 Linear」。
- **无** `改动前后` hero。

对比两个参考 URL 的 raw HTML:
- **url1 (0314cc61,标注「旧 final」)** = 当前 post-713 代码输出(全功能:14 天趋势 06-16→29、`周一`、12 个可点链接、713 页脚)。
- **url2 (05a083b5,标注「新 regressed」)** = 旧的 pre-713 输出(旧「重量(weight)·非账单」页脚、只 2 天数据、无星期、无链接)。

=> **issue 里两个 URL 的标签是反的。** WebFetch 的 markdown 转换丢了 `<a>` 链接语义、也没识别趋势天数,误导了 Cass 的诊断。**render 层没有代码回归**;趋势/星期/可点链接/$ 都在 main。

## 3. 真正的问题(重新定位)

| 项 | 现状 | 是否真缺 |
|----|------|----------|
| 14 天趋势 | 代码有,依赖 store 有历史数据 | 部分:数据健壮性问题 |
| 星期显示 | 代码有 | 否 |
| 可点 issue 链接 | 代码有(713) | 否 |
| $ 成本估算 | 代码有(713) | 否 |
| 项目/role/model 维度 | 代码有 | 否 |
| **改动前后用量对比 hero** | 代码有,daily 从不传 --before/--after | **是,唯一真缺的功能** |

### 3.1 两个运维缺口(极可能是 Annie 07-01 看到「退化」的真因)

1. **趋势数据健壮性**:趋势只渲染 store 里存在的天。daily 聚合(`aggregateAndPersist`)只算 `since=昨天, until=今天` → 每次只写 2 天。本地 fallback store 现仅 3 天(06-28→30)。当 Supabase 不可达 → 静默回落本地 → 趋势塌成 2-3 天(正是 url2 的症状)。历史只靠 Supabase 累积,本地永远补不齐。
2. **频道投递未配置**:`FLYWHEEL_TOKEN_USAGE_CHANNEL` 在 `~/.flywheel/.env` **未设** → daily 脚本只写 HTML、不 publish 到 Discord。Annie 未必稳定收到自动日报。

## 4. 确认的方向(Tadashi brainstorm gate APPROVED)

**不重做已能用的 trend/week/links/$。** scope:

- **A. before/after usage-delta hero 接进 daily** —— 真正缺的、= Annie「改动前后用量增减」。
- **B. 趋势健壮性** —— daily 聚合改**滚动窗口(近 14-28 天)**,Supabase 不可达 fallback 也自愈成完整趋势不塌 + 保留 fallback banner。(Tadashi 标为关键:极可能是 07-01「退化」真因。)
- **C. 频道投递** —— 配置 + 验证 `FLYWHEEL_TOKEN_USAGE_CHANNEL`(Annie 真收到)。
- **D. 护住 713** —— 加防回归测试锁死 trend/week/links/$ 存在;调度 00:30 vs issue 写的 00:35 对齐。

### 4.1 before/after 语义(已拍)

- **默认 = 周比周**(过去 7 天 vs 前 7 天,滚动,适合每天出的报告)。
- **anchor date 可配**(支持 ponytail 式固定 rollout 前后对比)。两个都给。
- 最终默认由 Tadashi 拿**真报告**给 Annie 确认(她早期提过 ponytail 灰度对比)。

### 4.2 硬要求(Tadashi)

必须用**真 529 E2E**对**真数据**(staging、真 Supabase 或真 fallback)生成报告,坐实「render 无回归 + url 标签反了」。这份真报告 = 给 Annie 的证据。若真 E2E 出来没有完整报告 → 真回归、重新评估,不能只靠本地跑的印象。

## 5. 假设

- Supabase 生产项目会继续保留 ≥14 天历史(实测 30 天),周比周 hero 的「前 7 天」数据可用。
- 滚动窗口聚合(14-28 天扫 CC 日志)每晚成本可接受(scanner 流式、按 [since,until] 时间戳过滤,~1100 文件)。
- 频道 ID 由 Annie/Tadashi 提供(或复用现有 cost-dashboard 频道)。

## 6. 非目标(scope discipline)

- 不重写 render-html/build-report 的 trend/week/links/$ 逻辑(已能用)。
- 不并入 Codex 用量(= FLY-714)。
- 不改 Supabase schema / 聚合存储结构(成本/维度字段已在)。
- 不做实时 dashboard 前端。
