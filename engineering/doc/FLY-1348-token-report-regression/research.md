# FLY-1348 每日 Token 报告回归 — 调研
Issue: FLY-1348 (https://linear.app/geoforge3d/issue/FLY-1348/bug-每日-token-报告回归-分项目块未渲染-柱状图比例失真annie-直报hl-已复核实锤)
日期: 2026-07-17
基于: exploration.md

## 1. 根因机制(PostgREST max-rows)

Supabase 的 REST 层(PostgREST)有实例级 `db-max-rows` 配置,**Supabase 托管默认 = 1000**:任何单次 `GET /rest/v1/<table>` 不带 `Range` 头时,服务端最多返回 1000 行,**不报错、不抛异常** —— supabase-js 的 `data` 就是那 1000 行,`error=null`。RPC 返回 SETOF 同样受此上限约束(所以「换 RPC 读」不能绕开)。

生产实测(2026-07-17,service key):
- 窗口 06-19..07-16 总行数 1252(`Prefer: count=exact` 头证实);
- 同窗口裸查询(supabase-js 默认形态)返回恰 1000 行,`day.asc` 排序下末行 = 2026-07-11;
- 全表当前 ~1252+ 行且以 ~40-58 行/天速度增长 → 不分页的读法结构性必坏,且会越来越坏。

## 2. 分页方案对比

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. offset 分页(选定)** | `.order(day).order(scope).order(dim_key)` 全 PK 稳定排序 + `.range(from, from+PAGE-1)` 循环,**按实际返回行数推进,返回 0 行才终止**(短页≠终止 — 服务端 cap < PAGE 时短页是常态) | 简单、改动局部(只动 `supabase-store.ts:queryDaily`)、排序覆盖全 PK 保证页间无重/漏。offset 分页对读时并发写敏感(page tear)——**仅在生产调度假设下可接受**:同一脚本先完成原子逐日写、后读,mkdir 单写锁,且约束读窗口期间不得并发手工 aggregate 写 |
| B. keyset 分页 | `or=(day.gt.X,and(day.eq.X,scope.gt.Y),...)` 复合游标 | keyset 对并发写确有收益,但在上述显式「无并发写」合同下不值得为此增加 PostgREST 复合游标的拼写复杂度。放弃 |
| C. 调大实例 `db-max-rows` | Supabase dashboard 配置 | 平台配置代码里不可见、只是把悬崖推远、影响整实例所有表。放弃 |
| D. 读侧改本地 SQLite 为主 | 绕开 Supabase 读 | 违背 FLY-614 设计(Supabase=持久化真源,本地只是 fallback),动架构超 scope。放弃 |

**选定 A**。实现要点:
- 页大小常量 `PAGE = 1000`(请求 range 大小,与服务端默认一致)。终止判定:**步进 = 实际返回行数**(`from += data.length`),**返回 0 行即止** —— 与服务端实际 cap 解耦(cap < PAGE 时每页返回 cap 行,照样推进),任何 cap 值下无重无漏(排序稳定前提下)。PostgREST 允许返回少于请求 range 的行数,短页不能当终止信号。
- 防御:保险丝**按累计行数 `MAX_ROWS = 100_000`,不按页数**(Codex R1#3:页数上限在小 cap 下会先于读完触发,与「任意 cap 正确」矛盾 — cap=10 读 1252 行需 ~126 页);超限 throw(fail-loud,宁可报错不可静默截断 —— 与本 bug 的教训一致)。
- `order` 链:supabase-js 多列排序 = 链式 `.order("day").order("scope").order("dim_key")`(均 asc);`.range` 0-based 双端含。现有 mock builder(store.test.ts)已有 `order` 记录点,扩展自然。
- offset page tear:生产调度假设下可接受(同一脚本先完成原子逐日写、后读,mkdir 单写锁)——**约束:读窗口期间不得并发手工 aggregate 写**;QA 流程只用 `report` 命令即天然满足。不为此上 keyset。

## 3. Fix B 自检的落点与语义

**层次**:完整性判定放 **`pipeline.generateReport`**(store 无关、`report`/`daily` 两命令共享),banner 渲染放 `renderReportHtml`,退出码映射放 `cli.ts`,alert 放 `token-usage-daily.sh`。

**判定条件**(报告日 = R,`rows` = 读回的全部窗口行;Codex design R1#1/#2 修订 — 全部锚定聚合器可证明的行不变量):
- `latestDataDay` = `max(rows.filter(scope=total).day)` ?? null — **只看 total 行**,与页面 trend 同源(trend 只读 total 行),banner 永不和图表矛盾;
- C1 `rows` 中无 `day=R, scope=total` 行 → 当日数据缺失;
- C2(对账不变量)当日 total 行存在时,`Σ(当日 project 行 totalTokens) + Σ(当日 lead 行 totalTokens) !== total.totalTokens`(整数精确相等)→ 归因不完整。聚合器保证健康日恒等(runner/main/sandbox/other → project 行,Lead → lead 行,total = 全体之和);截断/丢行必破坏等式。~~「project 行全 0」~~ 弃用:纯 Lead 活动的健康日会误报、残留一条 project 行时漏报;
- C3 `latestDataDay === null || latestDataDay < R` → 数据陈旧(trend freshness;与 C1 可同时命中,banner 分别报形态)。

**行为**:
- 三条任一命中 → 页面顶部红色 banner:`⚠️ 数据完整性自检未过:数据陈旧/缺失 —— 最新数据日=YYYY-MM-DD,报告日=YYYY-MM-DD(形态: C1/C2/C3 人话描述)`。复用现有 `.warn` 样式家族但升级为红(`#ff3b30` 左边框 + 浅红底),视觉上不可忽略;
- CLI:`daily`/`report` 在命中时**仍写出 HTML**(banner 在),然后返回**独立退出码 3**(区别于既有失败=1);
- `token-usage-daily.sh`:`fail_loud` 拆出只发 alert 不退出的 `raise_alert` helper;`rc==3` → 先照常 publish(Annie 在频道里看到的是带红 banner 的报告,不是静默残图)→ publish 成功后 `raise_alert`(`notify_digest_failed`,body 注明 step=integrity-check)→ `exit 3`;**rc=3 后 publish 又失败 → 以 publish 的非零码退出**(不许用 3 掩盖「报告没送达」,Codex R1#4)。其它非零 rc 保持现行为(立即 fail_loud + 不 publish);
- 逃生口:`--allow-empty` flag(+ `TOKEN_USAGE_ALLOW_EMPTY=1` env,**须加入脚本 `_PROCESS_WINS` 快照**防 .env 覆盖):命中时 banner 照出、退出码降为 0(QA 沙箱/新环境空库合法场景)。生产不设 → 默认 fail-loud;
- delegate seam:`flywheel-comm` 薄委托(`token-report.ts`)已把非零码写 `process.exitCode` — 补单测锁住(mock `runTokenReportCli` 返 3 → exitCode 3),QA 段再用构建产物实测 shell `$?`(Codex R1#5)。

**注意**:Fix A 修好后 C1-C3 正常永不触发;它是「反‘看着活着的死东西’」的安全网,专防下一次静默数据断链(无论断在哪层)。

## 4. Fix C 测试设计

| 测试 | 文件 | 断言 |
|---|---|---|
| 截断复现(红→绿) | `__tests__/store.test.ts` | mock builder 支持 `range(from,to)` 且单次最多返 1000 行、造 1252 行数据集 → 旧实现只得 1000(先红)、新实现得 1252 且与源集逐行相等(无重无漏、顺序稳定) |
| 服务端 cap < 页大小 · 生产规模 | 同上 | mock cap=10、数据 **1252** 行 → 返回全部 1252 行(小数据集证不了生产规模,Codex R1#3) |
| 保险丝 | 同上 | mock 病态返满页 → 累计行数超 `MAX_ROWS=100_000` throw(不按页数,不静默) |
| 自检 C1/C2/C3 | `__tests__/build-report.test.ts` | C1/C2(对账不等式)/C3 三形态 + 「reportDay 有非-total 行无 total 行 → C1+C3 且 latestDataDay=上一 total 日」+ 纯 Lead 健康日不误报 + 纯 project 健康日不误报;健康 rows → 无标记 |
| banner 渲染 | `__tests__/render-html.test.ts` | integrity 标记 → HTML 含红 banner 文案(含两个日期);无标记 → 不含 |
| 退出码 + 逃生口 | `__tests__/cli.test.ts` | 残缺数据 → main() 返回 3 且 HTML 已写出;`--allow-empty` → 返回 0 banner 仍在 |
| 柱高线性 | `__tests__/render-html.test.ts` | 解析 trendBars SVG `<rect>` height,断言 `height_i / height_max ≈ tokens_i / tokens_max`(±1% 容差,HL 验收 2 固化) |
| 脚本 rc=3 路径 | `scripts/__tests__/token-usage-daily-failloud.test.sh` 扩展 | stub node:rc=3 → 仍 publish、alert 在 publish 后、exit 3;**组合 daily=3+publish=4 → exit 4**;rc=1 → 现行为不变(不 publish) |
| delegate seam | `packages/flywheel-comm/src/commands/__tests__/token-report.test.ts`(新) | mock `runTokenReportCli` 返 3 → `process.exitCode===3`;返 0 → 不设 |

## 5. 部署与真机验收路径

- 生产 launchd 跑的是 `~/Dev/flywheel`(主 checkout)的 `packages/flywheel-comm/dist` → 依赖 `flywheel-token-usage` 包 dist。**merge 后必须 pull + pnpm -r build 才生效**(Lead 已确认排批量重启窗口;本修不需要 Bridge 重启,只需下一次 00:30 作业用到新 dist)。
- 真机 QA(implement/QA 段执行,读写分离防污染):
  1. 只读复现:worktree 里 `node dist token-report report --date 2026-07-16 --out /tmp/qa-1348.html`(`report` 命令不跑聚合、不写库)→ 修后页面应有完整分项目卡(40 行支撑)、trend 到 07-16、当日总量非 0;对账页面数字 vs Supabase 该日行(HL 验收 1);
  2. 柱高抽查:同页 SVG rect 高度 vs tooltip token 值线性(HL 验收 2);
  3. 自检演练:`--date` 设一个库里无数据的未来日 → 红 banner + exit 3(HL 验收 3);
  4. 终验:merge+部署后**次日真实报告**(00:30 作业产物)完整 → HL 收(issue 验收条款)。
- 风险:00:30 作业同时会写聚合(`daily` 含 aggregate)——QA 一律用 `report` 命令,绝不在生产库上手跑 `daily`。

## 6. 边界与不动项

- `trendBars`(render-html.ts:122-170)算法实测线性 → **不动**(Lead 确认)。
- `maxTok`(render-html.ts:324)非 bug(build-report.ts:145 已按 tokens 降序)→ 顺手 `Math.max(...m.projects.map(p=>p.tokens), 1)` 加固,行为无差异,一行。
- 本地 SQLite store 无 LIMIT 问题 → 不动。
- 写路径(RPC replaceDaily)有 error 检查、生产验证正常 → 不动。
- `CipherSyncService`(edge-worker)存在同类裸 `.from()` 读 → **observation only**,单列 follow-up 建议,本票不改(scope discipline;Lead 确认)。
- 数据回填:不需要(数据从未丢,读侧修复即历史全量可见)。
