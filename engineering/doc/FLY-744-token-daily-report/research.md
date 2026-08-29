# FLY-744 Token 日报重做 — 调研

Issue: FLY-744 (https://linear.app/geoforge3d/issue/FLY-744/redo-token-daily-report-restore-14-daypast-week-trend-week-display)
日期: 2026-07-01
基于: exploration.md

## 1. 精确 code touch points

### 1.1 已支持、不需改(护住即可)

- `report/render-html.ts` —— `trendBars`(星期+周末高亮)、`trendLines`、`weekdayCN`、`linearIssueUrl`+`<a>`、`formatUsd`、`comparisonHero`(`m.comparison` 存在时渲染)。
- `report/render-text.ts:24-32` —— `if (m.comparison)` 已输出「改动前后」文本行。
- `report/build-report.ts` —— `windowAgg()` + `model.comparison`(传 `before/after` 时算);trend(`trendSince`)。
- `pipeline.ts::generateReport` —— `queryDaily({ since, until })`,`since = min(reportDay, trendSince, before.since, after.since)`。**加了 before 窗口后 query 自动覆盖,无需改 query。**
- 已有测试 `__tests__/build-report.test.ts::"computes before/after comparison windows when requested"` —— 证明 model 层 comparison 完整。

=> **comparison 从 model 到 render 全链已就绪。唯一断点在 `cli.ts` 不给 daily 传 before/after。**

### 1.2 需改点

| 点 | 文件 | 改动 |
|----|------|------|
| A. before/after 接进 daily + 语义 | `cli.ts` | daily/report 模式在无显式 `--before/--after` 时,派生默认 before/after 窗口(周比周 + 可配 anchor) |
| B. 趋势健壮性 | `cli.ts`(+ 可能 `pipeline.ts`) | daily 聚合窗口从 `today-1..today` 拓成滚动 N 天(默认 14),让 primary/fallback store 都自愈成完整趋势 |
| C. 频道投递 | `scripts/token-usage-daily.sh` / 部署 env | 配 `FLYWHEEL_TOKEN_USAGE_CHANNEL`;脚本已支持,未配则只写 HTML。仅需 ops + 更响的未配告警 |
| D. 护 713 + 调度 | 新测试 + `com.flywheel.token-usage-daily.plist` | 加防回归测试;调度 00:30 vs issue 写 00:35 对齐(见 §5) |

## 2. before/after 语义设计

### 2.1 默认 = 周比周(滚动)

- `after` = 最近 7 天 `[reportDay-6, reportDay]`,label「本周」。
- `before` = 前 7 天 `[reportDay-13, reportDay-7]`,label「前一周」。
- 适合每天出的报告:每天都有意义、随时间滚动。

### 2.2 可配 anchor(ponytail 式固定 rollout)

- 新 flag `--rollout-date YYYY-MM-DD [--window N]`(N 默认 7):
  - `before` = `[rollout-N, rollout-1]` label「改动前」
  - `after` = `[rollout, reportDay]`(或 `[rollout, rollout+N-1]`,取「rollout 后到今天」更贴 Annie「灰度后累计」)label「改动后」
  - 对齐 FLY-614 plan §5.2 提过但从未实现的 `--rollout-date D --window 7d`。
- 环境变量 `TOKEN_USAGE_ROLLOUT_DATE` —— Annie 可 pin ponytail 日期,无需改代码/flag。
- 外部输入校验:`--rollout-date` / env 必须匹配 `^\d{4}-\d{2}-\d{2}$` 且能 parse,否则 warn + 回退默认周比周(不 crash)。

### 2.3 优先级(precedence)

显式 `--before/--after`(已存在)> `--rollout-date` flag > `TOKEN_USAGE_ROLLOUT_DATE` env > 默认周比周。

### 2.4 最终默认由 Annie 定

Tadashi 会拿真报告给 Annie:默认周比周 vs 固定 ponytail anchor 由她拍。代码两个都支持 → 改默认只是 env/flag,无需再发版。

## 3. 趋势健壮性设计(B —— Tadashi 标关键)

### 3.1 根因复述

- `aggregateAndPersist` 只 replace `[since, until]` 天。daily 传 `since=today-1` → 每次只写 2 天。
- `resolveUsageStore`:Supabase 可达 → primary=Supabase(现有 30 天);不可达 → primary=local(现仅 3 天)。
- Supabase 挂时报告读 local → 趋势只有 local 已积累的 2-3 天 → 塌。

### 3.2 修法:滚动聚合窗口

- daily 聚合 `since` 从 `today-1` 改 `shiftDay(today, -(BACKFILL_DAYS-1))`,`BACKFILL_DAYS` 默认 14,`--backfill-days N` / `TOKEN_USAGE_BACKFILL_DAYS` 可配。
- 效果:**任何一晚**(无论 primary 是 Supabase 还是 local)都把近 14 天写进当前 primary store。Supabase 挂那晚 primary=local → local 直接自愈到 14 天完整趋势 → 报告不塌。
- `replaceDaily` 幂等(删→插),重写近 14 天安全(completion 是 render-time filter、pricing 现算,历史行按当时数据重算一致)。
- 成本:scanner 流式按 `[since,until]` 时间戳过滤,14 天 vs 2 天 只多扫十几天窗口的 assistant turns,每晚一次,可接受。
- trend 渲染窗口保持现默认(`reportDay-27`):Supabase 健康仍显 ~4 周;fallback 保证 ≥14 天(= issue 的「14-day」)。两窗口都可配,若 Codex/Annie 想统一到 14 我再收窄。

### 3.3 fallback banner 保留

`generateReport` 已有 `本地 fallback 数据` / `Supabase 暂缺` banner(render-html `storeNote` + `warnBanner`)。不动,继续显式提示。

## 4. 频道投递(C)

- `scripts/token-usage-daily.sh` 已实现:`CHANNEL` 有值 → `flywheel-comm publish-report --html --project --channel --title`;无值 → 只写 HTML + log。
- 缺口纯 ops:`FLYWHEEL_TOKEN_USAGE_CHANNEL` 未在 `~/.flywheel/.env` / plist 配。
- 本 issue 代码侧不硬编码频道;交付:①脚本未配频道时的 log 提升为更醒目 warn(可选);②plist 模板注释保留 channel 占位;③真频道 ID 由 Tadashi/Annie 提供,部署时写 env。
- 529 E2E 用隔离测试频道验证真投递(见 §6)。

## 5. 调度 00:30 vs 00:35

- plist 现 `Hour=0 Minute=30`;FLY-713 plan 注释说 00:30 是「clear of 00:00 updater + 01:00/03:00/03:07 cron」的干净空档。
- issue 写「00:35 schedule」当作 713 改进 —— 实际是 00:30,Annie 应是约数。
- 决定:**保持 00:30**(= 保留 713 刻意选的空档 = 「keep 713 improvement」)。doc 注明差异是措辞,非功能。若 Tadashi/Annie 坚持 00:35,一行 plist 改动即可。

## 6. 529 E2E 计划(硬要求)

Tadashi 要求:真 529 Room + 真数据 + 真频道,坐实「render 无回归 + url 标签反了」,产出真报告给 Annie。

- 参考 `reference_qa_529_runner_injection_gotchas` + `token-usage-setup-channel.sh`。
- 步骤:①对真 Supabase(或强制 local fallback)跑 `token-report daily`;②验证报告含完整 trend + 星期 + 可点链接 + $ + **新 before/after hero**;③publish 到隔离测试频道验证真投递;④截图/hosted URL 交 Tadashi → Annie。
- 反向验证健壮性:模拟 Supabase 不可达(改 env 指向坏 URL)→ 跑 daily → 证明 local 自愈到 14 天趋势不塌(修前会塌成 2-3 天)。
- 由独立 QA runner 执行(实现者不验自己代码)。

## 7. 测试策略(TDD)

- `cli.test.ts`(新增,若不存在):默认周比周窗口派生正确;`--rollout-date` + `--window` 派生正确;env `TOKEN_USAGE_ROLLOUT_DATE` 生效;precedence(显式 > flag > env > 默认);非法 rollout-date 回退默认 + warn;`--backfill-days` 派生聚合 since 正确 + 默认 14。
- `build-report.test.ts`:已覆盖 comparison,补 week-over-week 具体窗口断言(可选)。
- `render-html.test.ts`:防回归 sentinel —— trend(峰值/星期字)、weekdayCN(周X)、可点链接(`<a href=...linear.app...issue`)、formatUsd($)、comparisonHero(改动前后)在;before/after hero 在 comparison 存在时出现。
- 全跑 `pnpm --filter flywheel-token-usage test` + 全仓 `pnpm lint`(biome)。

## 8. 风险 / 边界

- 滚动 14 天重聚合每晚重写历史行:pricing 用现价重算 → 历史 $ 可能随价表变(FLY-713 已知:改价只影响新聚合)。可接受(现价更准),doc 注明。
- 周比周需要 store 有 ≥14 天:Supabase 有 30 天 OK;全新机器首日无「前一周」→ hero 显示 before=0/降级,不 crash(windowAgg 用 `Math.max(days,1)` 防除零)。
- 频道未配 = 部署遗漏,非代码 bug;QA 必须验真投递以防再漏。
