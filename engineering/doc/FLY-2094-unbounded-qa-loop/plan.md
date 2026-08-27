# FLY-2094 取消 QA 循环上限 — 实施计划
Issue: FLY-2094 (https://linear.app/geoforge3d/issue/FLY-2094/founder-直令-取消-qa实现循环上限删-codesimple-code-模板的-maxiterationsonlimit菜单校验qa)
日期: 2026-08-27
基于: research.md

## 目标

让新建的 `code` 与 `simple_code` run 默认在 QA FAIL 后无限次返回实现节点，不产生上限停机；同时让模板仍可显式声明正整数 cap，并完整保留旧 frozen/custom manifest 的有界 loop、通用超限行为与 FLY-1707 `escalationAck` / `heldLoopLimit` 恢复出口。实现只删默认值和强制有界限制，不增加提醒、告警、状态或配置。

## 完成态合同

| 合同 | 完成态 |
| --- | --- |
| 内建声明 | 两个 YAML 的 `qa_retry` 与 `founder_rework` 都不含 limit pair |
| menu shape guard | `code` / `simple_code` 的 QA loop 可无上限或声明正整数 + `escalate`；不再锁死 3/10 |
| manifest schema | v1/v2 loop 可无上限或显式有界；半对继续拒绝 |
| 新 run snapshot | `qa_retry` 无 `max_iterations` / `on_limit` |
| QA 高轮次 | 第 4、5、后续轮继续创建 implement attempt；run 保持 active |
| 事件 | 每轮 `loop_iteration.payload` 无 `maxIterations`；零 `loop_limit_escalated` |
| frozen/custom | 已有 3/10 manifest 仍可解析；显式有界 custom loop 仍可超限 held |
| 有界恢复出口 | `escalationAck`、`heldLoopLimit`、`WorkflowLoopLimitEscalationAck` 行为与测试保持不变 |
| 告警 | 不新增任何告警或“第 N 轮”机制 |

## 实施顺序（TDD）

### 1. RED：声明与 schema 合同

修改 `packages/teamlead/src/__tests__/workflow-menu.test.ts`：

- 更新 `code` / `simple_code` 精确 loop 断言，预期 `qa_retry` 不含 `maxIterations` / `onLimit`；
- 断言 `compileWorkflowMenuSeed` 的 QA loop 不含 `max_iterations` / `on_limit`；
- 对两个 shape 分别复制 fixture，并给 `qa_retry` 加不同的正整数 limit pair，要求接受并原样编译；
- 保留半对、非法整数与其他结构校验的既有覆盖。

修改 `packages/teamlead/src/__tests__/workflow-template.test.ts`：

- v1 旧工程 manifest 删除 QA limit pair 后应合法；原带 3 的 frozen fixture 仍合法；
- v2 review/QA loop 删除 limit pair 后应合法；
- 任意 loop 只保留 limit pair 的一半仍拒绝。

先运行这两个测试文件，确认在实现前失败。

### 2. GREEN：声明与 parser

修改：

- `menus/shapes/code.yaml`：删除 `qa_retry.maxIterations/onLimit`；
- `menus/shapes/simple_code.yaml`：删除同两行；
- `workflow-menu.ts`：删除“非-founder loop 必须有界”的 parser 分支；删除 `code` / `simple_code` shape invariant 中 QA 必须为 3/10 的检查，更新错误文案；保留 founder-rework 既有无上限 invariant；
- `workflow-template.ts`：v1/v2 都删除按 loop 类型强制有界的分支，保留 pair/整数/枚举验证。

运行步骤 1 的定向测试直至通过，并检查编译出的两个 seed manifest。

### 3. RED：运行时默认无限循环与声明 cap 回归

在 `StateStore.workflow-engine-transition.test.ts` 使用真实 `compiledCodeEngineRun`：

- 从 design→implement 开始，连续完成 5 次 implement→QA FAIL；
- 每轮收敛既有 rework delivery，使下一轮可继续；
- 断言 loop iteration 为 `[1,2,3,4,5]`、implement attempt 单调、run 始终 active；
- 精确断言每个 `loop_iteration.payload` 没有 `maxIterations`；
- 断言没有 `loop_limit_escalated`。

保留使用 legacy max-3 manifest 的既有超限测试，证明 custom/frozen 有界路径未被删。

保留原“ack 后继续 4/5/6 轮”的 FLY-1707 正向测试以及 route 的 `escalationAck` 转发与 malformed-ack 边界测试。实现前运行相关测试，确认高轮次无 cap 用例因 manifest 校验或 `loop_limit_missing` 失败，而有界回归仍为绿。

### 4. GREEN：运行时按 limit pair 分流

修改 `StateStore.ts`：

- 删除 `loop_limit_missing` 拒绝；
- 把通用超限分支显式限定为存在 `max_iterations/on_limit` 的 loop；
- 保持 `openOperatorRework`、`WorkflowLoopLimitEscalationAck`、latest-hold 查询与 receipt 零变化。

`bridge/runs-route.ts` 不修改。运行步骤 3 测试直至通过；以既有 ack 测试证明显式有界 loop 的恢复出口没有回归。

### 5. 定向回归与格式化

运行：

```bash
pnpm --filter @cyrus/teamlead test -- workflow-menu.test.ts workflow-template.test.ts StateStore.workflow-engine-transition.test.ts
pnpm --filter @cyrus/teamlead build
pnpm exec biome check menus/shapes/code.yaml menus/shapes/simple_code.yaml packages/teamlead/src/workflow-menu.ts packages/teamlead/src/workflow-template.ts packages/teamlead/src/StateStore.ts packages/teamlead/src/__tests__/workflow-menu.test.ts packages/teamlead/src/__tests__/workflow-template.test.ts packages/teamlead/src/__tests__/StateStore.workflow-engine-transition.test.ts
```

若 package script 的参数转发方式不同，按 `package.json` 的真实脚本调整，但保留相同测试范围。

### 6. 全仓门禁

按 executor 合同依次运行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
```

本单不新增 `scripts/__tests__/*.test.sh`，无需额外 shell harness。若全量 vitest 对生产 host 资源有风险，仍按派工硬门执行，但记录耗时/失败证据，不运行 provisioning 或服务重启。

### 7. 代码评审与 PR

1. 提交实现与测试，push 当前 feature branch。
2. 通过 `review_code` gate + `request-review --type code` 注册跨模型代码评审；CHANGES 则修复并开新 gate，直到 `reviewVerdict=APPROVED`。
3. 创建 PR（base `main`），不 merge、不请求 ship approval。
4. 确认 PR 号后，新建 `engineering/doc/milestones/FLY-2094.md`，按单写者合同作为 PR 最后一个 commit；不改 `CLAUDE.md`。
5. push 后运行 `complete --route needs_review --pr <NUMBER>`。

## 文件清单

| 文件 | 动作 |
| --- | --- |
| `menus/shapes/code.yaml` | 删除 QA limit pair |
| `menus/shapes/simple_code.yaml` | 删除 QA limit pair |
| `packages/teamlead/src/workflow-menu.ts` | 允许 parser 无上限 loop；内建 QA 不锁死 cap |
| `packages/teamlead/src/workflow-template.ts` | v1/v2 接受可选 limit pair |
| `packages/teamlead/src/StateStore.ts` | 无上限 loop 正常转移；保留显式有界超限路径 |
| 三个对应测试文件 | RED/GREEN 与有界/无界回归更新 |
| `engineering/doc/FLY-2094-unbounded-qa-loop/*` | exploration/research/plan/progress |
| `engineering/doc/milestones/FLY-2094.md` | PR 最后 commit 新建 |

## 验收映射

| 原验收 | 权威证据 |
| --- | --- |
| 新 run payload 无 `maxIterations` | compiled code engine 的 5 轮事件精确断言 |
| 第 4、5、…轮照常 rework | 同测试的 attempt/iteration 单调与 active status |
| 不出现 `loop_limit_escalated`、run 不 held | 同测试事件计数 0 + 每轮 status |
| 菜单允许模板声明不同 cap | code/simple_code declared-cap mutation 正例 + half-pair/非法值反例 |
| frozen manifest 解析零变化 | legacy manifest/snapshot 既有 fixture + bounded 正例 |
| 无新增告警层 | diff 审计；无新 alert/event kind；高轮次只用既有 `loop_iteration` |
| FLY-1707 出口保留 | 既有 ack 续跑、stale/digest/replay 与 route 边界测试 |

## 回滚与部署边界

本 PR 不触发部署或服务重启。若合入后需要回滚，只回滚本 PR 即恢复内建 3/10 cap；`escalationAck` API 在前后都不变，不对已有 frozen run 做数据迁移。部署由后续 00:00/12:00 updater 窗口处理，Runner 不运行 `request-restart.sh` 或 `restart-services.sh`。

## 会过期的结论

| 结论 | as-of | 重核命令 |
| --- | --- | --- |
| 预计只改上述生产文件与四个测试文件 | `dedf2aed5` | `git diff --name-status origin/main...HEAD` |
| `compiledCodeEngineRun` 使用 menu seed，可证明新模板而非 legacy fixture | `dedf2aed5` | `git log -S 'async function compiledCodeEngineRun' -- packages/teamlead/src/__tests__/StateStore.workflow-engine-transition.test.ts` |
| package/full-repo 门禁命令仍存在 | `dedf2aed5` | `node -e 'const p=require("./package.json"); console.log(p.scripts)'` |
| 里程碑单写者路径为 `engineering/doc/milestones/FLY-2094.md` | `dedf2aed5` | `sed -n '1,140p' engineering/doc/milestones/README.md` |
