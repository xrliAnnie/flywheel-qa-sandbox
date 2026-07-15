# FLY-1244 执法层 — 突变验证报告（QA 阶段）

Issue: FLY-1244
日期: 2026-07-14
基于: plan.md §4.2 / §4.3 / qa/acceptance-matrix.md

## Why this exists

本单是 FLY-1204 的重设计。FLY-1204 的教训原话是：**「每条安全测试必须突变验证 —— 我有 7 条绿测
在为 ship-gate 绕过背书」**。所以对本单，「测试全绿」本身不构成证据：必须逐条**打断执法点、
看是否真有测试红**。绿而杀不掉突变的测试 = 那条执法点其实没人守。

方法：对 `packages/flywheel-comm/src/ship-eligibility.ts` 的每个执法点做一次定点突变，
跑声称覆盖它的测试，要求变红（KILLED）。存活（SURVIVED）= 覆盖缺口。

## Round 1 — 实施阶段交付物原样（11 个突变）

| 突变 | 打断的执法点 | 结果 |
|---|---|---|
| M1 | durable-QA 分支整体短路 → 回落旧布尔 | ✅ KILLED |
| M2 | `lower(c.subject_digest) = ?` head 绑定失效 | ✅ KILLED |
| M3 | 过期检查停用 | 🔴 **SURVIVED** |
| M4 | revocation 忽略 | ✅ KILLED |
| M5 | `r.claims_read_enrolled = 1` enrollment 过滤丢弃 | 🔴 **SURVIVED** |
| M6 | `current_qa_attempt` 当前 attempt 过滤丢弃 | ✅ KILLED |
| M7 | predicate 检查弱化 → `qa_failed` 也放行 | ✅ KILLED |
| M8 | `subject_kind = 'git_head'` 过滤丢弃 | 🔴 **SURVIVED** |
| M9 | `decision_kind = 'qa_verdict'` 过滤丢弃 | 🔴 **SURVIVED** |
| M10 | binding `node_id = 'qa'` 过滤丢弃 | 🔴 **SURVIVED** |
| M11 | `c.issuer_execution_id = ?` 签发者过滤失效 | 🔴 **SURVIVED** |

**5/11 KILLED，6 条存活。** 核心两条（M1 红测分支、M2 head 绑定）真被守住 —— 执法层的主干是实的。

## 存活项定性：是覆盖缺口，不是实现缺陷

逐条读过实现：**6 条存活项的代码本身都写对了、且都 fail-closed**。存活的原因是
**fixture 只造得出「一切正常」的那一种行**，负面格从来没被构造过：

- `enrollQaClaim()` 恒定写 `claims_read_enrolled = 1` → 真值表 (e) 的「READ 开但**未
  enrolled**」这一格从未被测。而 plan §0 红线明写 enrollment「绝不由表内数据推断」。
- fixture 有 `expiresAt` 旋钮，但没有任何测试传过一个**已过期**的值（默认恒为 2999 年）。
- `subject_kind` / `decision_kind` / binding `node_id` 恒为合法值 → 三条纵深过滤无人守。
- M11 最隐蔽：既有 `["wrong issuer", { executionId: "other-qa" }]` 一格**同时**改了 binding
  和 claim 的 execution id，所以它实际测的是 **binding 查不到**（→ unenrolled_failclosed），
  `c.issuer_execution_id = ?` 这条过滤**自始至终没被单独验证过**。这正是「格子名字对了、
  测的东西不是它」的典型 —— 标签冒充事实。

## QA 补的测试（9 格）

`packages/flywheel-comm/src/__tests__/ship-eligibility.test.ts`：

- fixture 加旋钮：`enrolled` / `permanent` / `nodeId` / `decisionKind` / `subjectKind` /
  `issuerExecutionId`（与 `executionId` 解耦）/ `expiresAt: null`。
- `it.each` 增 6 格负测：expired / 无 expiry / expiry 不可解析 / 异 subject_kind /
  异 decision_kind / binding 落在非-QA 节点。
- 增 1 格负测：**claim 由另一个 execution 签发**（binding 保持正确）—— 单独钉死 M11。
- 增 1 格 (e) 正名测试：**READ 开 + run 未 enrolled → fail-closed**，且断言 reason 恰为
  `qa_claim_gate_unenrolled_failclosed`（不是笼统的 `passed=false`）。
- 增 1 格正测：permanent claim 无 expiry → 放行（锁住「过期守卫不能靠删掉来通过」）。

## Round 2 — 补测后重跑同样 11 个突变

**11/11 KILLED。** 每个突变都有指名道姓的测试变红：

| 突变 | 杀它的测试 |
|---|---|
| M3 | `durable enrolled QA refuses expired verdict` |
| M5 | `durable QA + READ on + run NOT enrolled → fail-closed, never inferred from claims` |
| M8 | `durable enrolled QA refuses claim for another subject kind` |
| M9 | `durable enrolled QA refuses claim of another decision kind` |
| M10 | `durable enrolled QA refuses binding on a non-QA node` |
| M11 | `durable enrolled QA refuses a claim issued by another execution` |

## 红测（E1）的突变验证 —— 单独一条，因为它跨包

`REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts` 在 teamlead 包，经 `node_modules/flywheel-comm`
符号链接解析到 **`dist/`（不是 src）** —— teamlead 的 vitest 无 src alias。所以对 src 的突变
**碰不到红测**，必须突变 `dist/ship-eligibility.js` 才是真验证：

| 突变（打在 dist） | 结果 |
|---|---|
| 把 `if (durableQa && !forceLegacy)` 整体短路（= 撤销本单修复） | ✅ 红测变红 |
| `durableQa` 恒 false（= 停用三段式身份识别） | ✅ 红测变红 |

→ **红测确实依赖本单的 fail-closed 分支**：撤掉修复，验收线立刻回红。它不是被绕过去变绿的。

## 复现命令

```bash
# Round 2 基线
cd packages/flywheel-comm && npx vitest run src/__tests__/ship-eligibility.test.ts   # 28 passed

# 红测
cd packages/teamlead && npx vitest run src/__tests__/REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts
```

突变脚本非交付物（QA 一次性工具），逐条突变文本已在上表逐格写明，可按表复现。
