# FLY-1458 A/B/C prompt 三臂对比分析 — README(中间产物保存 / 暂停)

Issue: FLY-1458 (https://linear.app/geoforge3d/issue/FLY-1458/实验结账-abc-prompt-三臂对比分析-1392asuperpowers1385bmatt1393cbare-按-annie)
日期: 2026-07-24
基于: 无

## 本文件夹是什么

FLY-1458 原定「按 Annie 口径出三臂(A·superpowers / B·matt / C·bare)prompt 对比 HTML」。

**状态:现有数据版(中期),持续积累中。** 演进过程:先暂停(N=1/臂不足以定论)→ Annie 2026-07-24 最新拍板「分析要做完」→ 恢复开工。背景更新:split 分桶自今晚 R2 重启起转正,可分析数据比原先多——今晚已完成的 **design 阶段**攒到了多样本(阶段级可比)。故产出定位为**【现有数据版】对比**:能比的比(阶段级 duration 优先),N 小如实标注,「数据能说/不能说」保留,**不做终局推荐**;数据持续积累会有更新版。

**主交付物 = `comparison-current-data.html`**(Apple 浅色 interactive 报告)。臂位全部按 `sessions.skill_framework_mode` 核验(非猜测,遵 Lead 约束④)。

## 目录

- `comparison-current-data.html` — **主交付物**:现有数据版 interactive 对比(design 阶段多样本 + 历史三臂完整三段 + confound + 能说/不能说)。
- `interim-findings.md` — 早期三臂-only 文字版发现(被 HTML 的扩充数据版取代,保留作记录)。
- `scripts/design_compare.py` — **未来数据权威入口**:design first-pass / design-review visits 四臂对比,按 `skill_framework_mode` 分组并以 `ponytail_condition` 做 eligibility。
- `scripts/final.py` — 历史三臂:各阶段 first-pass active + review 轮数 + approve 等待 + wall-clock + 代码产出。
- `scripts/analyze.py` — 逐 session active/review/approve/wall-clock 分段(含 parked-in-active-stage 缺陷说明)。
- `data/stage_timelines.txt` — 全部载荷(历史3 + 今晚5)完整 stage_changed 时间线原始转储(重跑校对用)。

## 数据源(全部只读)

- `~/.flywheel/teamlead.db`(Bridge StateStore,299MB)— `sessions` / `session_events`(stage_changed / qa_result / codex_review_result / three_stage_*)/ `workflow_run*`。**核心源。**
- `~/.flywheel/token-usage.db` — **仅 2026-06-28~30 有数据,07-21/22 完全为空** → 三臂 token 消耗不可得(见 findings)。

## 如何重跑(未来数据攒够后)

四臂 rollout 后,从 rollout epoch 起跑权威入口(上线时把实际 ISO 时间补到下方):

```bash
python3 engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/design_compare.py \
  --since '<FOUR_ARM_ROLLOUT_ISO>'
```

可用 `--issues FLY-... FLY-...` 收窄 cohort。只做结构 smoke 时可显式传
`--allow-pre-rollout`;该输出会标为 all-history,**不可当成有效四臂比较**。脚本以
SQLite `mode=ro` 打开 `~/.flywheel/teamlead.db`,不碰生产状态。

`--since` 同时接受 ISO `T`/`Z` 与 StateStore 的空格分隔时间;脚本先校验时间,
再用 SQLite 时间语义比较,避免字符串排序静默漏掉 rollout 当天。无法解析的时间会
直接报错,不会生成看似有效的空 D 组。

Eligibility 口径固定为:D(`bare-ponytail`)只计 `ponytail_condition LIKE 'on:%'`;
A/B/C 只计 `off:%`;其余/null/unavailable 全部逐臂进入 `EXCLUDED`,同时打印每臂
condition 分布。`skill_framework_mode_via` 为 `noop_backend`(没有真正装配该臂)或
`fallback_superpowers`(readiness 失败后回退)的行即使 condition 符合也会排除。
每项均打印自己的样本数,不共用一个含混 denominator。`final.py` / `analyze.py`
继续作为 1392/1385/1393 三个 pilot 的历史定格脚本,不承担未来四臂分析。

## 臂归因机制(已验证,支撑后续采集)

`sessions` 表的 `skill_framework_mode` / `skill_framework_mode_via` 两列已在本三臂上干净落值:

| issue | skill_framework_mode | via |
|-------|----------------------|-----|
| FLY-1392 (A) | `superpowers` | `sticky`(per-issue stable-hash 自动分桶) |
| FLY-1385 (B) | `matt` | `override`(显式指定) |
| FLY-1393 (C) | `bare` | `override`(显式指定) |

→ 未来 FLY-1356 split 模式(`FLYWHEEL_SKILL_FRAMEWORK_MODE=split`)开启后,每个 session 会自动带上臂标签,重跑分析可直接 `GROUP BY skill_framework_mode`,不必再手工列 issue 号。

## 红线备注

本轮全程**只读分析**,未碰任何生产状态。本 commit 仅为「保存中间脚本留待重跑」(Tadashi 指令 659eb80c),**未 push、未开 PR、未 ship**。
