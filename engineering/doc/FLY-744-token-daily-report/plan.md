# FLY-744 Token 日报重做 — 实施计划

Issue: FLY-744 (https://linear.app/geoforge3d/issue/FLY-744/redo-token-daily-report-restore-14-daypast-week-trend-week-display)
日期: 2026-07-01
基于: research.md

## 0. 目标(Tadashi APPROVED scope + Codex R1 CHANGES 已 fold)

在**不重做已能用的 trend/week/links/$** 前提下:
A. 把 before/after usage-delta hero 接进 daily(默认周比周 + 可配 anchor,严格日期校验)。
B. 趋势健壮性:daily 聚合改滚动窗口,且窗口覆盖报告真正要用的所有天(修 off-by-one),fallback 自愈完整趋势 + before 窗口不缺天。
C. 频道投递:修 `token-usage-daily.sh` env-load 顺序真 bug + 验证。
D. 护住 713(防回归测试)+ 调度对齐说明 + 更新过期文档。
→ Codex design review(R1 CHANGES→R2 **APPROVED**)→ implement(TDD)→ 真 529 E2E(真数据+真频道)→ 真报告回 Tadashi → Annie。

**Codex R2 非阻断提示(实现时纳入)**:① `deriveAggregateWindow` 的 min 也纳入 `comparison?.after?.since`(防御,虽周比周/anchor 下 before.since ≤ after.since)。② 默认 comparison 同样作用于 ad-hoc `report`(与 daily 一致,可预期);ad-hoc 用户不想要对比可传显式空窗口 —— 保持一致默认。③ `FLYWHEEL_REPO` 也在 source `.env` 后解析(只有 `ENV_FILE`=`$HOME/.flywheel/.env` 与 source 本身须在前),让 .env 里的 FLYWHEEL_REPO 也生效。

## 1. 改动 A — before/after hero 接进 daily(含 Codex R1 严格校验)

**文件**:`packages/token-usage/src/cli.ts`

新增纯函数(可单测):
```
parseIsoDayStrict(s): string | null   // 严格 YYYY-MM-DD:构 UTC 日期并 round-trip 回同串,拒 2026-02-31 之类被 JS Date 规整的非法日
deriveComparison(reportDay, flags, env): { before, after } | undefined
```
逻辑(precedence):
1. 显式 `--before A..B` + `--after C..D` → 用现有 `parseWindow`(保持不变)。
2. 否则 `--rollout-date D`(或 env `TOKEN_USAGE_ROLLOUT_DATE`)+ 可选 `--window N`(默认 7,校验为 1..90 整数,否则 warn+用 7):
   - D 经 `parseIsoDayStrict` 校验;非法 → warn + 落第 3 步。
   - **D 晚于 reportDay(未来 rollout)→ warn + 落第 3 步周比周**(避免 after.since>after.until 的静默零对比,Codex R1 MEDIUM-1)。
   - `before` = `[shiftDay(D,-N), shiftDay(D,-1)]` label「改动前」
   - `after` = `[D, reportDay]`(rollout 后累计到报告日)label「改动后」
   - 对齐 FLY-614 plan §5.2 提过但从未实现的 `--rollout-date D --window 7d`。
3. 否则默认**周比周**:
   - `after` = `[shiftDay(reportDay,-6), reportDay]` label「本周」
   - `before` = `[shiftDay(reportDay,-13), shiftDay(reportDay,-7)]` label「前一周」

`main()` report/daily 分支:`const cmp = deriveComparison(reportDay, flags, process.env); before = cmp?.before; after = cmp?.after;`(替换现只读 `--before/--after` 的两行)。`generateReport` 已消费 before/after,其 `queryDaily` 的 `since` 已含 before.since → 无需改 pipeline query。

## 2. 改动 B — 滚动聚合窗口(趋势健壮性,含 Codex R1 off-by-one 修正)

**文件**:`packages/token-usage/src/cli.ts`

**关键(Codex R1 HIGH-2)**:daily 渲染 `reportDay = today-1`,默认周比周 `before.since = reportDay-13`。若聚合只从 `today-(N-1)` 起会**漏掉** before.since 那天 → fallback 下 `windowAgg` 只按已存在的天求均值(`build-report.ts:282-301`)→ hero 数字静默偏掉。故聚合下界必须覆盖报告真正要用的所有天。

- 新纯函数 `deriveAggregateWindow(today, reportDay, comparison, flags, env): { since, until }`(可单测):
  - `backfillDays` = `str(flags,"backfill-days") ?? env.TOKEN_USAGE_BACKFILL_DAYS ?? 14`,校验 `Number.isInteger && 1..90`,否则 warn + 用 14。
  - `trendSince` = 报告趋势下界(现 `shiftDay(reportDay,-27)`,或 `--trend-since`)。
  - `since = min( shiftDay(reportDay,-(backfillDays-1)), trendSince, comparison?.before?.since )` —— 取所有下界最小值,保证聚合覆盖报告 query 到的每一天(镜像 `generateReport` 的 since 计算)。
  - `until = today`(保留今天预聚合)。
- aggregate/daily 分支用 `deriveAggregateWindow` 得 since/until 替换现 `shiftDay(today,-1)`;显式 `--since/--until` 仍覆盖。
- 效果:每晚把「报告需要的完整窗口」写进当前 primary store;Supabase 挂那晚 primary=local → local 自愈完整趋势 **且 before 窗口不缺天**。
- 注释:幂等重写 + pricing 现价重算的已知行为(FLY-713)。
- 单测:`today=2026-07-01`(→reportDay=06-30,默认 before.since=06-17)→ 聚合 since 必须是 **06-17** 不是 06-18。

**不改** `aggregateAndPersist`/`replaceDaily`(已幂等、按天 replace)。

## 3. 改动 C — 频道投递(修 Codex R1 HIGH-1 env-load 顺序 bug)

**文件**:`scripts/token-usage-daily.sh` + `scripts/com.flywheel.token-usage-daily.plist`(注释)

**真 bug(Codex R1 HIGH-1)**:脚本现在 `:19-25` 就从 env 解析 `OUT/CHANNEL/PROJECT/COMM`(带默认),而 `~/.flywheel/.env` 到 `:36-42` 才 source。setup helper(`token-usage-setup-channel.sh:71-73`)让运维把 `FLYWHEEL_TOKEN_USAGE_CHANNEL` 写进 `.env`,plist 注释也说频道可来自 `.env` —— **这条部署路径当前完全失效**(CHANNEL 在 .env 加载前已定为空),会直接让 529 E2E 真频道投递失败。

- 修:**先 source `.env`(存在则),再解析 `OUT/CHANNEL/PROJECT/COMM` 等 env-backed 变量**(或 source 后重算)。`REPO`/`ENV_FILE`/`LOCK_DIR` 需在 source 前定(ENV_FILE 路径本身要先有);其余 env-backed 值移到 source 之后。保持 `set -euo pipefail` 语义 + lock 逻辑不变。
- 无频道时仍只写 HTML(render-only),但 log 升级为更醒目 warn(「日报未投递 Discord —— 设 FLYWHEEL_TOKEN_USAGE_CHANNEL」)。
- **hermetic shell 测试**:临时 `.env`(只放 `FLYWHEEL_TOKEN_USAGE_CHANNEL`)+ 假 `flywheel-comm`(stub 记录 argv)+ 假 CC 数据 → 跑脚本 → 断言走到 `publish-report --channel <id>`;另一 case 无频道 → 只 render 不 publish。
- plist 注释保留 channel 占位;真频道 ID 部署时 Tadashi/Annie 提供写 env;529 E2E 用隔离测试频道验真投递。

## 4. 改动 D — 护 713 + 调度 + 过期文档(含 Codex R1 LOW)

- 调度:**保持 00:30**(= 713 刻意选的干净空档 = keep 713 improvement)。plist 注释补「issue 写 00:35 为约数,实际 00:30」。
- 防回归测试见 §5.
- **过期文档更新(Codex R1 LOW)**:`packages/token-usage/README.md:31-41`、`packages/flywheel-comm/src/index.ts:88-92`、`packages/flywheel-comm/src/commands/token-report.ts:6-10` 现仍写 daily = "today+yesterday" 且没提新 flag → 更新为滚动窗口描述 + 补 `--rollout-date/--window/--backfill-days`。plist 注释同步。

## 5. TDD 步骤(RED → GREEN → REFACTOR)

### 5.1 `cli.test.ts`(新增)——纯函数 + 操作接缝(Codex R1 MEDIUM-2)
先写失败测试:
- `parseIsoDayStrict`:合法通过;`2026-02-31`/`2026-13-01`/`2026-6-1`/空/乱串 → null。
- `deriveComparison`:默认周比周窗口(since/until/label 精确);`--rollout-date 2026-06-20 --window 7` → before `[06-13,06-19]`/after `[06-20,reportDay]`;env `TOKEN_USAGE_ROLLOUT_DATE` 生效;flag>env;显式 `--before/--after` > 两者;非法 rollout-date → 回退周比周+warn;**未来 rollout-date → 回退周比周+warn**;非法 `--window` → 用 7+warn。
- `deriveAggregateWindow`:默认 backfill=14 + 周比周 → `today=2026-07-01` 得 since=**06-17**(证覆盖 before.since,不 off-by-one);`--backfill-days 28` 更宽则取更小下界;非法 backfill(0/负/NaN/100)→ 回退 14+warn;`--trend-since` 更早时取它。
- 编排接缝:抽一个可测入口证明「无显式 flag 时 `generateReport` 收到 before/after」(可注入 fake store/generate spy,或断言传入 `generateReport` 的 opts)。

### 5.2 `render-html.test.ts` 防回归 sentinel(补/加)
断言在(锁死 713+614 功能不再被"重做"丢):
- trend 存在(`峰值` + svg 内星期字)。
- `weekdayCN`:bigdate 含 `周`。
- 可点链接:含 `href="https://linear.app/.../issue/`。
- `$`:含 `formatUsd` 输出。
- comparison:`m.comparison` 存在时 HTML 含 `改动前后`。
- incomplete-history case(Codex R1 MEDIUM-2):comparison 的 before 窗口缺天时行为明确(fixture 覆盖 / 断言 `windowAgg.days`)。

### 5.3 shell 测试(§3)
hermetic `.env`-only 频道 → 达到 `publish-report --channel`;无频道 → 只 render。放 `scripts/` 或 package 测试目录,遵循仓内既有 shell 测试惯例(先 grep 现有 `*.bats`/`*test*.sh` 模式)。

### 5.4 GREEN + 全量
实现 §1/§2/§3/§4 到全绿。`pnpm --filter flywheel-token-usage test` 全绿 + 全仓 `pnpm lint`(biome format,防 FLY-224/248 那类第一轮 CI 挂 format)。

## 6. 验证(实现者本地,非替代 QA)

- 本地对真 Supabase 跑 `token-report daily --out /tmp/r.html` → 确认 trend + 星期 + 链接 + $ + **改动前后 hero** 全在。
- 模拟 Supabase 坏(SUPABASE_URL 指坏值)→ 跑 daily → 确认 local 自愈完整趋势 + before 窗口不缺天(修前会塌 & hero 偏)。

## 7. 529 E2E(独立 QA,ship 前硬门)

- 真 529 Room + 真数据 + 真隔离频道。
- 正向:daily 报告含全功能 + 新 hero → 经 `.env` 配频道 → publish 到测试频道(验 HIGH-1 修好)→ 截图/URL。
- 反向:强制 fallback → 趋势不塌 + hero 数字正确(before 窗口齐)。
- 交 Tadashi 真报告 → Annie 看真的 + 诚实说明真因(url 标签反了 + render 无回归 + 真缺的是 hero + 07-01 退化真因 = fallback 塌 / 频道 env-load bug)。

## 8. DoD

- [ ] `cli.ts`:before/after hero 接进 daily(周比周默认 + rollout anchor 可配 + precedence + parseIsoDayStrict + 未来日回退 + window 校验)。
- [ ] `cli.ts`:`deriveAggregateWindow` 滚动窗口覆盖报告全窗口(off-by-one 修正,单测锁 06-17)。
- [ ] `token-usage-daily.sh`:先 source `.env` 再解析 env-backed 变量(HIGH-1)+ hermetic shell 测试;无频道更醒目 warn。
- [ ] 防回归测试锁 trend/week/links/$/hero;cli 派生 + 编排接缝单测全绿;全仓 lint 绿。
- [ ] 调度保持 00:30 + 注释;README/flywheel-comm help/comment 过期文档更新(LOW)。
- [ ] PR → Codex code review → 真 529 E2E(真数据+真频道)→ 真报告回 Tadashi。
- [ ] 文档 archive 进主 PR(git mv,最后 commit)。

## 9. 非目标

- 不重写 trend/week/links/$ 逻辑(已能用)。
- 不并 Codex 用量(FLY-714)。
- 不改 Supabase schema / 聚合结构。
- 不做实时 dashboard 前端。
- 频道 ID 不硬编码进代码。
