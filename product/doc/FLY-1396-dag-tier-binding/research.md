# FLY-1396 DAG 分档 binding — 技术调研

Issue: FLY-1396 (https://linear.app/geoforge3d/issue/FLY-1396/prdhl-dag-分档-binding-不同类型的单走不同模板不再一律-eng-heavy-highway)
日期: 2026-07-20
基于: exploration.md(同文件夹)

> 目的:把「分档 binding 落地需要动哪些现成机制、哪些是净新」查清楚,给 PRD 一个可行性底座。**纯技术事实 + 可行性,不替 Annie 拍分类/形状**(那些留 co-eval 收敛)。所有结论核过源码,附文件行号。

---

## 1. 现成机制清单(哪些已具备,哪些缺)

| 能力 | 状态 | 证据 |
|---|---|---|
| 模板定义(YAML DAG:节点/边/loop/skip) | ✅ 已有 | `workflow-seeds/*.yaml` + `validateWorkflowManifest`(`workflow-template.ts:958`),v1/v2 双 schema |
| 6 套 shipped 模板 | ✅ 已定义(生产仅装 3 套 v1) | `BUNDLED_SEED_FILES`(`:1085`);v2 被 generalized flag 挡(`:1119`) |
| 每节点绑 vendor/model/effort | ✅ 已有 | manifest node 字段(`:53`) |
| 每节点 model/effort **override** + **skip** | ✅ 已有 | `applyWorkflowOverride`(`:985`):可改 model/effort、可 skip 非-QA/非-review 节点并自动重连图 |
| category → template binding 表 | ✅ 表在,但只挂了 3 条工程档 | `workflow_category_binding`(`StateStore.ts:2708`);seeder `:1140` |
| 按 category 解析模板 | ✅ 已有(含 `*` 兜底) | `resolveWorkflowTemplateCandidate`(`workflow-template-selection.ts:29`);SQL `IN (?, '*')` 兜底(`StateStore.ts:13214`) |
| Lead 派单显式指定模板(覆盖 binding) | ✅ 已有 | `leadTemplateId` + `leadReason`(`workflow-template-selection.ts:38/151`) |
| **从 label/issue 自动推 category** | ❌ **缺** | `taskCategory` 是 run-start 透传字段(`runs-route.ts:928`),无任何 label 推导 |
| **把非工程模板挂到 category** | ❌ **缺** | 默认 binding 列表只有 3 条工程档(`:1140`) |
| **运行时改 binding 的入口** | ❌ **缺** | 唯一写 = boot seeder;HTTP 模板路由显式只读(`workflow-template-routes.ts:26`);management writer 只改节点 model/effort |

**一句话**:模板引擎、override/skip、binding 表、按 category 解析、Lead 覆盖 —— 全已具备。缺的三件是 ① 非工程模板的 binding 没种 ② category 判定没接线 ③ 运行时改 binding 无入口。**分档 binding 主要是「接线 + 种对默认值」,不是重建引擎。**

---

## 2. FLY-1380 根因(工程侧要修的 bug,git 实锤)

`ensureDefaultWorkflowBindings`(`workflow-template.ts:1151`)的守卫:
```js
const existing = store.listWorkflowCategoryBindings(project);
if (existing.length > 0) continue;   // 只种「零 binding」项目
```
- 生产 6 项目的 `*→eng_heavy` 行种于 **2026-07-16 07:20:09 UTC**,当时部署的是 commit `c808dab98`,其 seeder 只种一条 wildcard。
- 把默认列表扩成 3 档的 commit `9ccf47335` 于 **2026-07-17 04:49 UTC(晚约 21h)** 才落地。
- 此后 `existing>0 continue` 对所有已存在项目永久生效 → 新档再也种不上。

**修法方向(FLY-1380 域,本 PRD 只提约束不定实现)**:seeder 从「项目级 all-or-nothing」改成「per-(project,category) 缺哪补哪」的幂等补种,或走一次性 migration。**约束**:不能覆盖 founder 手改过的 binding(`system:bundled-default` vs 人工 `updated_by` 要能区分,`updated_by` 列已存在)。

---

## 3. 「eng 3 档 → 1 套 + 旋钮」可行性(Lead 提议)

- 3 个工程模板(heavy/light/trivial)**DAG 形状完全相同**(design→implement→qa→gate + QA↔implement loop×3),只差每节点的 vendor/model/effort:
  | 节点 | heavy | light | trivial |
  |---|---|---|---|
  | design | claude/fable | codex/gpt-5.6-sol | codex/gpt-5.6-sol |
  | implement | codex/gpt-5.6-sol xhigh | codex/gpt-5.6-sol | codex/gpt-5.6-sol |
  | qa | claude/opus | claude/opus | claude/fable |
- ⇒ 合并成 1 套 base 模板 + 一个「档位旋钮」(trivial/light/heavy)完全可行:**旋钮 = 一组 per-node model/effort override**,而 `applyWorkflowOverride` 已支持 per-node model/effort 覆盖。不需要新引擎能力。
- **设计问题(留 co-eval / PRD)**:旋钮是 3 个预置档,还是连续可调?谁定档(自动按 label / Lead 派单选 / founder)?—— 属块 A/B,不在本调研拍。

---

## 4. category 判定的三种接线(块 C 的可行性对比,不拍)

现成信号 = `.flywheel/config.yaml` `agents[].match.labels`(engineer/qa/product-designer/pm/prototype/designer + general 兜底)。三种接法:

| 方案 | 怎么接 | 改动面 | 备注 |
|---|---|---|---|
| A. 自动从 Linear label 推 | run-start 前加一个 `label → taskCategory` resolver,填 `req.body.taskCategory` | 净新一个纯函数 + 一处调用点;复用现成 label 表 | = FLY-1020 §4② 原意「复用已有信号」。`research`/`plan` 现挂 engineer,需在映射里改判去 research |
| B. 从派单 agent/Lead 推 | 派单方(CoS/Lead)按自己身份带 category | 派单侧改 | Lead 已能带 `leadTemplateId` 直接指模板,是 B 的强化版 |
| C. 手动指定 | 派单请求显式填 taskCategory/templateId | 已支持(透传字段 + leadTemplateId) | 现状即支持,但没人填 |
- **不互斥**:典型落法 = A 出默认 + C 允许 Lead 覆盖(`leadTemplateId` 已在)。**A 是让「零人工」也能分档的关键**;B/C 是覆盖阀。
- **谁拍**:选哪种(或组合)= 块 C,留 co-eval。本调研只确认三种都技术可行、A 的改动最小且复用现成信号。

---

## 5. enable / 安全模型(不动,但 PRD 要知道边界)

- DAG 走不走 = **per-project `pipeline.dag` config(`config/types.ts:325`)× 5 个全局 founder flag(全 default OFF)**。现生产全局 `FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=0` → DAG 休眠。
- 每套模板都以 `founder_gate`(`predicate: founder_approved`)收尾 → **分档不削弱 ship 安全性**:再轻的模板最后仍 founder 审。这让「兜底走轻」在安全上成立(省的是中间重型阶段,不是 founder gate)。
- 本 PRD **不动** flag/enable 层(issue 边界),只定「走了 DAG 的单怎么分流」。

---

## 6. 对 PRD 的可行性结论(给 co-eval 收敛后写 PRD 用)

1. 分档主体 = **接线 + 种对默认 binding**,引擎/override/skip 全现成 → 工程量集中在 FLY-1380(种子修复)+ category resolver(净新小函数)。
2. eng 3→1+旋钮:**可行**,旋钮 = override 组,无新引擎能力。
3. category 判定:**A(label 自动推)+ C(Lead 覆盖)** 组合技术最省、复用现成信号;具体选法留 Annie。
4. 兜底走轻:**安全上成立**(founder_gate 恒在);落到哪套(研究轻/裸 session)留 Annie。
5. 谁能改 binding + gate:今天无入口;PRD 需定「谁能改 + 要不要 founder-gate」,入口实现可交 FLY-1380 或后继。

---

## 待 co-eval 收敛后进 PRD 的开放点(全在 exploration §4 块 A–E)
分类法粒度(A)· 每类形状 + 旋钮档数(B)· category 判定选型(C)· 改 binding 权限+gate(D)· 兜底落点(E)。
