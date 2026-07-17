# FLY-1348 每日 Token 报告回归 — 探索
Issue: FLY-1348 (https://linear.app/geoforge3d/issue/FLY-1348/bug-每日-token-报告回归-分项目块未渲染-柱状图比例失真annie-直报hl-已复核实锤)
日期: 2026-07-17
基于: 无

## TL;DR — 根因已实锤(生产数据四路独立证据)

**`SupabaseUsageStore.queryDaily`(`packages/token-usage/src/store/supabase-store.ts:83-93`)没有分页。Supabase PostgREST 对单次请求默认最多返回 1000 行(`db-max-rows` 默认值),查询按 `day` 升序排序,窗口内行数一旦超过 1000,最新的天被静默截断。**

报告的 28 天读窗口(trend + 对比 hero + 当日,`generateReport` 一次大查询喂所有视图)从 **2026-07-09 起越过 1000 行**,此后每晚报告读到的数据在 ~07-11 处被砍断 → 当日总量 0、分项目全 0、Leads 空、trend 停在 07-11。**数据本身从未丢**(写路径一直正常,Supabase 里 07-12..07-17 每天都有 21-58 行真实数据),纯读侧截断,修好读路径历史即自动恢复,无需回填。

这不是某个 commit 引入的回归 —— 代码自 07-01(FLY-744 #409)后没动过报告链路;是**数据基数随 fleet 增长(项目/Lead/issue/模型维度行数 40-58 行/天)自然越过隐形上限**。「之前明明都做好了、这几天又不对了」和「有的天错得离谱、有的天看着还行」都由此解释:窗口行数逐日递增(1093→1252),截断点每天漂移。

## 症状 → 实证对照

Annie 样本页(2026-07-16 报告,https://fw-reports-a53de2.vercel.app/r/69762ab3952b1045a290370c0e8914a8/)逐项解析:

| # | 症状(issue 描述) | 页面实际状态 | 根因归属 |
|---|---|---|---|
| 1 | 分项目块基本没渲染,只剩「项目」字样 | 分项目 section 其实渲染了,但 7 张卡全是 `pcard zero` 压缩卡(「0 · 今日无用量」)—— known-projects 兜底逻辑在数据全空时的正常输出 | queryDaily 截断 → 当日行全无 |
| 2a | 总用量柱状图不按比例 | trend SVG 柱高与数值**线性一致**(实测 1.54B→31.7px、5.84B→120px、5.00B→102.7px);真正的问题是 **trend 只画到 07-11、报告日 07-16 的高亮柱根本不存在**,且当日总量卡显示 0,和图表自相矛盾 | queryDaily 截断 → 07-12+ 无数据点 |
| 2b | 「柱高 14px/9px/10px/7px 混两个 100%」(HL 复核) | 这串数字与样式表逐字吻合:`.split{height:14px}` `.legend i{height:9px}` `.pbarw{height:10px}` `.sbar{height:7px}` `.pbar{height:100%}` `.sbar span{height:100%}` —— 是检查时读到 CSS 固定高度的误会,**不是渲染 bug**(SVG trend 柱高是 `<rect height>` 属性,与这些 CSS 无关) | 检查方法 artifact |
| — | 当日总用量 0 tokens · $0;Leads 排名 0 · $0 空表 | 同上,当日行全无 | queryDaily 截断 |

## 证据链(全部在生产机实测,2026-07-17)

**E1 · 发布页解析**:07-16 报告页 `当日总用量 = 0 tokens · $0`;7 张项目卡全 zero;Leads 排名空;trend 数据点 = 06-19..07-11(28 天窗口的前 23 天),07-12..07-16 五天整体缺失。

**E2 · 生产作业日志**(`/tmp/flywheel-token-usage-daily.err`):launchd 作业(`com.flywheel.token-usage-daily.plist`,00:30,**存在且每晚触发**)每晚成功跑完,最近一晚打印 `aggregated + persisted 15 day(s): 2026-07-03 .. 2026-07-17 (store=supabase)`、`wrote HTML report`、`publishing to channel` → **写路径与调度活着**。(注意:该消息列的是尝试窗口,不证明每天有数据 —— 见 E4 才是数据存在证明。)

**E3 · CC 转录源正常**:`~/.claude/projects` 下 07-12 后修改的 `.jsonl` 有 927 个;抽样 07-15 文件的 usage 行完全符合 `parseUsageLine` 预期(type=assistant、message.usage、timestamp、requestId 齐全)→ 扫描源没断。

**E4 · Supabase 数据在库**(REST + service key 实测):
- `token_usage_daily` 里 07-08..07-17 每天行数:43/58/49/45/**37/40/58/40/40/21** —— 07-12 之后每天都有真实数据,**MAX(day)=2026-07-17**;
- 07-16(报告日)单日 = 40 行。

**E5 · 截断复现**(决定性):窗口 `06-19..07-16` 总行数 **1252**;按 `day.asc` 不带 Range 的裸查询(supabase-js `.select()` 的默认形态)返回**恰好 1000 行,首=06-19,末=07-11** —— 与坏报告的 trend 终点逐字节吻合;第 999-1000 行(0-based)正落在 `2026-07-11`。

**E6 · 回归日期定位**:各报告日的 28 天读窗口行数:07-09=1093、07-10=1124、07-11=1157、07-12=1181、07-13=1204、07-14=1227、07-15=1242、07-16=1252 —— **07-09 起全部 >1000**,即报告从 ~07-10 晚(07-09 的报告)开始逐步变坏,且越往后砍掉的天越多。

## 代码链路(读侧,全部同一根因下游)

```
token-usage-daily.sh (launchd 00:30)
  → flywheel-comm token-report daily
    → packages/token-usage/src/cli.ts main()
      → aggregateAndPersist()          # 写路径,正常(RPC replace_token_usage_daily 有 error 检查)
      → generateReport()               # pipeline.ts:131 — 一次 queryDaily({since: min(trendSince, before.since), until: reportDay})
        → SupabaseUsageStore.queryDaily()   # ← 无分页,PostgREST 静默 1000 行封顶  ★根因★
        → buildReportModel(rows)       # 当日行/trend/对比 hero/Leads/模型 全从同一 rows 切
        → renderReportHtml(model)      # 数据全空时输出「合法」的全 0 残图,零报错  ← HL 验收 3 要堵的口
```

旁证:表 PK = `(day, scope, dim_key)`(migration `20260628_token_usage_daily.sql`),无 serial id;本地 SQLite fallback 的 `queryDaily` 无 LIMIT,不受影响(但生产 primary=supabase,fallback 自 06-30 未写,符合预期)。

## 对 Lead 转来的 Cass 定位的逐条核对(据实证)

1. 「Supabase MAX(day) 是否 07-11」→ **否**,MAX(day)=2026-07-17,07-12 后每天有数据(E4)。「趋势停在 07-11」是**读侧截断的假象**,不是写侧断线。
2. 「daily/aggregate 作业跑没跑」→ 每晚 00:30 跑且 exit 0(E2)。
3. 「plist 丢没丢」→ 在(`~/Library/LaunchAgents/com.flywheel.token-usage-daily.plist`),且触发正常(E2 时间戳)。
4. Bug②「`render-html.ts:324` 的 `maxTok = m.projects[0]` 按名排序 ≠ 最大值」→ **与代码不符**:`build-report.ts:145` 先 `projects.sort((a,b)=>b.tokens-a.tokens)`(按 tokens 降序),零用量已知项目在其后 append(L149-166),所以 `projects[0]` 恒为最大用量项目;样本页 SVG trend 柱高实测线性(症状表 2a)。改成 `Math.max(...)` 是无行为差异的健壮性加固,可顺手做,但**不是本 bug**,trendBars(L141)算法确认正确、不动。

## 修复方向(细节见 research.md / plan.md)

- **Fix A(根治)**:`queryDaily` 分页 —— 按全 PK `day.asc, scope.asc, dim_key.asc` 稳定排序 + `.range()` 循环拉全(页大小 1000,循环至短页)。修完后历史报告数据自动恢复(数据从未丢,无需回填)。
- **Fix B(自检,HL 验收 3 + Lead 指定语义)**:报告生成入口加完整性自检 —— reportDay 无 total 行 / 分项目全 0 / trend 最新天 < reportDay 时:页面加显式红 banner「数据陈旧/缺失,最新=YYYY-MM-DD」,且 CLI 以可区分的非零码退出 → `token-usage-daily.sh` 走 `fail_loud`(`notify_digest_failed` alert),不许静默出全 0 残图。
- **Fix C(回归测试)**:mock SupabaseLike 加 1000 行封顶复现截断(红→绿);柱高线性断言(解析 SVG rect);自检触发/逃生口测试。
- 同类隐患 observation(本票不动,遵守 scope discipline):`CipherSyncService`(edge-worker)也有裸 `.from()` 读,同样暴露于 1000 行上限。

## 验收对照(HL 三条)

1. 分项目表格真渲染、数字对得上台账 → Fix A 后 07-16/最新报告日应有 ~40 行支撑的完整分项目卡;QA 对账 Supabase 行 vs 页面数字。
2. 柱高与数值线性成比例(抽查可验)→ 已实证现算法线性;加 Fix C 断言测试固化 + QA 真页抽查。
3. 生成时自检、不许静默出残图 → Fix B。
4. 修好后 HL 收 + 次日真实报告实证(部署注意:launchd 跑的是 `~/Dev/flywheel` 的 dist,merge 后需 pull + build 才生效)。
