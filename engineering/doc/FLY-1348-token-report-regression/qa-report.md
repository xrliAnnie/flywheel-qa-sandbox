# FLY-1348 每日 Token 报告回归 — QA 验收报告
Issue: FLY-1348 (https://linear.app/geoforge3d/issue/FLY-1348/bug-每日-token-报告回归-分项目块未渲染-柱状图比例失真annie-直报hl-已复核实锤)
日期: 2026-07-17
基于: plan.md, exploration.md, research.md

## 结论:PASS ✅

独立 QA 段(与 implement 段不同 session)对本分支 `flywheel-FLY-1348` @ `fce79f0` 的 FLY-1348
修复做了三层验证:① 全量单测/集成/脚本测试;② HL 三条产品验收在**真实生产 Supabase 数据**上逐条实证;
③ **阳性对照**证明真机 pass 真正打中了截断修复路径,不是小窗口空过。全部通过,无 FAIL、无 kickback。

---

## 1. 自动化测试(全绿)

| 套件 | 结果 | 说明 |
|---|---|---|
| `pnpm --filter flywheel-token-usage test` | **166/166 通过** | 含 Fix A 分页红→绿、Fix B 自检 C1/C2/C3、柱高线性、cli exit 3/逃生口、pipeline 端到端 |
| `flywheel-comm` delegate seam (`token-report.test.ts`) | **2/2 通过** | `runTokenReportCli` 返 3 → `process.exitCode===3`;返 0 → 不设 |
| `bash scripts/__tests__/token-usage-daily-failloud.test.sh` | **9/9 通过** | rc=3 仍 publish→alert→exit 3;组合 daily=3+publish=4 → exit 4;rc=1 现行为不变 |

**非空过校验(mutation reasoning)**:
- `store.test.ts` 「paginates beyond 1000-row cap」:mock 服务端 cap=1000、数据集 1252 行 → 断言返回**全部 1252 行**且末行 `project-1251`。旧的无分页实现只会拿到 1000 行 → 该测试对旧代码**真会红**,非空过。
- 「advances by actual batch length when server cap smaller」:cap=10、1252 行 → 断言全读、步进=实际返回行数([0,999]→[10,1009]→[20,1019]…),证明对任意 cap 正确(Codex R1#3)。
- 「fails loudly at 100000-row safety fuse」:病态永返满页 mock → 断言抛错(消息含 99000/100000)且恰 100 次 range 调用,保险丝真触发。

**flywheel-comm 全量套件本机 18 failed 说明**:失败全部落在 `ship-eligibility` / `await-codex-gate` /
`cli(check)` / `commands(tmux capture)` / `e2e-workflows` / `progress.realgit` —— 这些文件 FLY-1348
**一个字都没改**(本 commit 的 flywheel-comm 改动只有 `token-report.ts` 3 行注释 + 新增
`token-report.test.ts`)。它们是重负载下的环境/时序/git/claims-DB flake 家族(memory 已记录
`ship-eligibility` 本机红=claims-DB env flake、CI 绿),与本修复无关。

---

## 2. HL 三条验收 — 真实生产数据实证(只读,绝不跑 daily/aggregate)

命令:`source ~/.flywheel/.env`(拿 Supabase 只读凭据)后
`node packages/flywheel-comm/dist/index.js token-report report --date 2026-07-16 --out /tmp/qa-1348-0716.html`。
`report` 命令不触发 `aggregateAndPersist`(仅 `daily`/`aggregate` 写库,cli.ts:272 已核),纯读安全。

### 验收 1 — 分项目表格真渲染、数字对得上台账 ✅

- 页面渲染 **6 张真·分项目卡**(flywheel / geoforge3d / tidal-echo / (sandbox) QA测试槽 / joycon-typeless / growth)+ 2 张已知 0 卡。**修前是全 7 张 zero 压缩卡「今日无用量」**(exploration E1)。
- 独立 Supabase REST 拉 2026-07-16 = **40 行**(total×1 / project×3 / lead×10 / issue×22 / model×4),与 exploration E4 一致。
- **对账不变量精确成立**:`Σ project(2,388,386,124) + Σ lead(1,817,873,928) = 4,206,260,052 == total 行 total_tokens`。页面「当日总用量」显示 **4.21B**(修前显示 0)。项目卡按「runner+main + 其 Leads」嵌套,合计=total,台账对得上。

### 验收 2 — 柱高与数值线性成比例 ✅

- 解析 trend SVG 16 根 `<rect height>` vs 独立 Supabase 每日 total tokens:**height% 与 tokens% 最大偏差 0.0387%**(远在 ±1% 容差内)。峰值 07-09=5.84B=120.0px=100%,与 exploration 实测逐字吻合。
- **trend 现在画到报告日 07-16**(修前只到 07-11,exploration E1/2a);当日高亮柱存在、与「当日总量」不再自相矛盾。
- 分项目 pbar 亦线性:flywheel=100%(=maxTok,`Math.max` 加固生效)、geoforge3d 159M/4.02B≈4%。symptom②「14/9/10/7px 固定像素」经查是 CSS 固定高度的误读(exploration 2b),非渲染 bug。

### 验收 3 — 生成时自检、不许静默出残图 ✅(穿过真·构建产物,非 stub)

`token-report report --date 2027-01-01`(库里无数据的未来日):
- 无 `--allow-empty` → **exit 3** + HTML 含红 banner「报告数据完整性自检未过」+ 渲染 `alert-red` div;stderr 打「缺少 total 汇总行 / 最新 total 数据日为 无」。
- `--allow-empty` → **exit 0**,banner **仍在** HTML 中(反「静默残图」)。
- env `TOKEN_USAGE_ALLOW_EMPTY=1` → **exit 0**,banner 仍在(生产脚本逃生口)。
- 该退出码穿过 `flywheel-comm` dist 委托层传播,证明 delegate seam 真实生效(非仅单测 stub)。

---

## 3. 阳性对照(证明真机 pass 打中了截断修复,非小窗口空过)

- `report --date 2026-07-16` 的真实读窗口 = `min(trendSince=06-19, …)..07-16` = **2026-06-19..2026-07-16**。
- 该窗口 Supabase `Prefer: count=exact` = **1252 行**(> 1000)。
- 裸(无分页)查询同窗口 `order=day.asc` 返回**恰 1000 行、末行 = 2026-07-11** —— 逐字复现 exploration E5 的截断,证明旧读法今天仍会坏。
- 而分页修复后的报告正确读到 07-16(过了 1000 行截断点)、当日总量 4.21B、6 张真项目卡 —— **旧代码在此数据形态下必产出全 0 残图**,故本 pass 真正走过了修复路径。

---

## 4. 观察项(不阻塞,非本票 scope)

1. 保险丝 `if (rows.length + batch.length >= QUERY_MAX_ROWS)` 用 `>=` 且在 push 前判,理论上无法读取「恰好 100,000 行」的合法窗口(会提前一批 throw)。生产窗口 ~1300 行,阈值 77× 于生产,且设计明确选择 fail-loud 优先于静默截断 —— **可接受,非缺陷**。
2. `CipherSyncService`(edge-worker)存同类裸 `.from()` 读、同暴露 1000 行上限 —— exploration/plan 已列 observation-only follow-up,本票遵守 scope 不动。

## 5. 部署终验(交付合同,非本 QA 段可完成)

merge 后生产 `~/Dev/flywheel` 需 `git pull && pnpm -r build` 才生效(launchd 跑 dist);
**次日 00:30 真实报告完整 → HL 收**(issue 验收终条款)。本 QA 段已在真机只读复现证明修复正确。
