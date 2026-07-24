# FLY-1458 A/B/C prompt 三臂对比 — 中期发现(N=1/臂,方向感,不定论)

Issue: FLY-1458 (https://linear.app/geoforge3d/issue/FLY-1458/实验结账-abc-prompt-三臂对比分析-1392asuperpowers1385bmatt1393cbare-按-annie)
日期: 2026-07-24
基于: 无

> ⚠️ **样本量 = 每臂 1 次(N=1),不足以定论。** 下面数字仅供方向感。Annie 已决定先攒几天 split 数据再做终局分析。**不做终局推荐。**

## 三臂到底是什么(头号 confound:三个不同 issue,不是同一任务换 prompt)

| 臂 | issue | 任务 | prompt 模式 |
|----|-------|------|------------|
| **A·superpowers** | FLY-1392 | [foundation·收据地基] 主管唯一枢纽 + 两级收据 + 无收据→标记→重发→升级闭环 | superpowers(重,全技能框架) |
| **B·matt** | FLY-1385 | [bug·DAG引擎] 死 exec 永久楔死 node(失败无 completion receipt) | matt |
| **C·bare** | FLY-1393 | [foundation·看门收编] Watchdog 最小集落地 + 开关真值修复 | bare(最简) |

三臂模型恒定:design=Fable / implement=gpt-5.6-sol / QA=Opus,同阶段模型可比。

## 主指标:分阶段 duration(已测部分)

单位换算说明:`first-pass active` = 从该 role 的 onboard 到「首次交 review / 首个 verdict」的连续工作段(可干净测量);跨轮 fix 的**总** active 时间**不可干净分离**(见下"不能说")。

| 指标 | A·superpowers | B·matt | C·bare | 备注 |
|------|:---:|:---:|:---:|------|
| Design first-pass active | **1h00m** | 20m | 30m | A 最长(但 A 任务最大) |
| Implement first-pass build | **2h44m** | 2h12m | 1h08m | 与任务规模同序(A>B>C) |
| QA first-pass | 1m12s* | 25m | 25m | *A 是快速 smoke-fail,不可比 |
| code_review 轮数(全 implement) | **11** | 5 | 7 | A review churn 最多 |
| implement 阶段重入(fix cycle) | 8 | 4 | 3 | |
| qa 判定 FAIL→PASS | 1→多 | 1→3 | 1→1 | 三臂都是一轮 fail 后转 pass |
| **founder approve 等待** | 11h47m | 9h41m | 39m | 等 founder,非计算时间 |
| **arm wall-clock 总计** | **24h20m** | 18h20m | 16h47m | 见下:被 founder 等待/过夜主导 |

wall-clock 窗口:A `07-21 03:40 → 07-22 04:01`(跨夜);B `07-21 03:40 → 22:01`;C `07-21 05:10 → 21:57`。

## 次级指标:代码产出(token 不可得,用行数/文件数当产出规模代理)

| 臂 | design | implement | QA | 合计 |
|----|--------|-----------|----|----|
| A | 9f / +773 | 110f / +15933 / -2625 | 78f / +12102 / -394 | **197f / +28808** |
| B | 5f / +480 | 64f / +7843 / -524 | 24f / +2110 / -37 | 93f / +10433 |
| C | 4f / +668 | 53f/+3130 + 57f/+3666(两次 implement) | 7f / +378 | 121f / +7842 |

→ **A 的 implement 产出 ≈ C 的 4.3×**(+15933 vs +3666 行)。三臂建的东西体量根本不对等。

## Confound 清单(必须显式标注,不许拿脏数直接比)

1. **【最大】任务规模不对等**:三个不同 issue,implement 产出差 ~4×(A≈4.3×C)。A wall-clock 最长很大程度是"A 建得最多",不能直接归因于 superpowers prompt。workflow_run 的 `tier`/`task_category` 系统难度标签全为 NULL,无客观难度分级。
2. **【Annie 已知】B 中途注入第 6 修复面**:design 阶段 scope 被扩,B 的 design first-pass=20m 偏短可能与此有关。
3. **【新发现】C 的 implement 被 blocked + 过夜 11h 重派**:C 第一个 implement session 07-21 09:30 blocked,直到 19:54 才重新 dispatch(隔 ~11h),是两个 implement session 拼起来的。
4. **【方法学】wall-clock 被 founder-approve 等待 + 过夜 park 主导,不是计算时间**:approve 等待 A 11h47m / B 9h41m / C 39m。C 的 approve 等待极短只是因为它当晚 founder 在线时段命中 gate,A/B 的 implement gate 撞上过夜 → 差异反映 founder 何时在线,**不反映 prompt 效率**。
5. **【噪声】QA first-pass 不可比**:A 的 1m12s 是一次快速 smoke-fail,B/C 的 25m 是完整跑一遍。

## 数据能说什么(方向感,N=1)

- first-pass design active:A(1h) > C(30m) > B(20m)。
- first-pass implement build:A(2h44m) > B(2h12m) > C(1h08m)——但与任务规模同序。
- review churn(code_review 轮数):A(11) > C(7) > B(5),A 迭代最多。
- wall-clock:A(24h20m) > B(18h20m) > C(16h47m)——但每臂 ~40–70% 是 founder 等待/过夜,wall-clock ≈ founder 在线时机,**≠ prompt 效率**。

## 数据不能说什么(诚实边界,不可估算冒充实测)

- ❌ **哪个 prompt 更快 / 更好——无法定论。** 因为:(a) N=1/臂;(b) 任务体量差 ~4×;(c) 已知+新发现的多个 confound;(d) token 成本不可得;(e) Annie 要的主指标(扣除等待的 active 工作时间)只能部分测量。
- ❌ **每臂 token 消耗:不可得。** `token-usage.db` 仅 2026-06-28~30 有数据,07-21/22 全空;GPT(implement)侧 token 也不在 Claude 侧账本。仅有行数/文件数当产出规模的**部分**代理。
- ❌ **跨轮 fix 的总 active 工作时间:不可干净分离。** 一个 QA/design session 停在 active 标签的阶段(如 `test`)时,它其实在等 implementer 修完(parked-in-active-stage)——从时间戳无法把"真在算"和"在等别的 role"分开。这正是 Annie 预警的「等待态无法从时间戳区分」。只有 first-pass active 可干净测。
- ❌ **active 阶段内部的 idle**:从 stage 边界无法在分钟粒度分辨"真算"vs"空转"。

## 后续数据采集方案(让多臂数据自动积累)

- **FLY-1356 split 模式**:`FLYWHEEL_SKILL_FRAMEWORK_MODE=split` —— 按 per-issue stable-hash 自动把 issue 分桶到 A/B/C 三臂,per-dispatch 也可显式指定臂。开启后每天正常干活就自动积累多臂样本。
- 关键收益:(1) N>1/臂,消除单点噪声;(2) 大量不同 issue 随机分桶,**任务规模 confound 会在臂间平均掉**(这是当前 N=1 最致命的问题);(3) `sessions.skill_framework_mode` 已能干净归因每个 session 的臂(本三臂已验证:1392=superpowers/sticky、1385=matt/override、1393=bare/override),重跑分析直接 `GROUP BY skill_framework_mode`。
- 攒够数据后重跑 `scripts/final.py`(改为按 `skill_framework_mode` 分组),即可得到有统计意义的分阶段 duration 对比。

---
*本轮全程只读分析,未碰生产状态。数字来源见同目录 `scripts/` 与 `data/stage_timelines.txt`。*
