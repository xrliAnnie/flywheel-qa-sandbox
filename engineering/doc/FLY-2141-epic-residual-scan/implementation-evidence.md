# FLY-2141 Epic 残余扫描 — 实施证据
Issue: FLY-2141 (https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活)
日期: 2026-09-04
基于: plan.md + design-correction.md

## 1. 已验证实现头

- 实现与规则头：`56fab12267fe97bc76d5919f4cdad56a400d574f`
- 该头包含 FLY-2140：`git merge-base --is-ancestor fd5ac60c9 HEAD` 返回 0。
- 本轮没有新增 `scripts/__tests__/*.test.sh`。

## 2. 相关行为测试

设计增量修正已落地：`trigger="scope"` 且 `remainingForLead=0` 保持为合法的
`kind:"available"` 成功观测，并在空名册路径正常静默；查询、schema 或 session 账本不可读
仍走独立的 `kind:"unavailable"` 稳定 token，不能伪装成零剩余。对应回归分别覆盖 residual
断言、空名册静默和 `session_ledger_unreadable` 退化。

执行：

```text
VITEST_MAX_THREADS=4 pnpm exec vitest run \
  src/epic-page/__tests__/residual.test.ts \
  src/bridge/__tests__/epic-residual-scan.test.ts \
  src/__tests__/patrol-tick.test.ts \
  src/__tests__/patrol-tick-render.test.ts \
  src/bridge/__tests__/epic-page-route.test.ts \
  src/__tests__/fly2141-epic-residual-rule.test.ts \
  src/bridge/__tests__/epic-residual-plugin-wiring.test.ts
```

验收测试并行度显式限制为 `VITEST_MAX_THREADS=4`。该命令只运行上述七个 FLY-2141
定向文件，明确排除与本单无关、依赖本机 Terminal.app 自动化能力的
`packages/core/test/tmux-viewer.macos.test.ts`。

结果：7 个 test files、132 个 tests 全部通过。覆盖 residual 计算与断言、共享
materializer、scan fail-soft/回执、tick 同 pass memo 与空名册触发、渲染 fail-closed
与缺席字节兼容、route fail-loud 保持、生产 plugin 单次接线，以及 dept-only Lead 规则
bundle。

执行 `pnpm --filter flywheel-teamlead typecheck`，返回 0。

## 3. 保护边界

以下命令返回 0 且没有 diff：

```text
git diff --exit-code origin/main -- \
  packages/teamlead/src/epic-page/rules.ts \
  packages/teamlead/src/epic-page/model.ts \
  packages/teamlead/src/bridge/runner-admission.ts \
  packages/teamlead/src/bridge/runs-route.ts \
  scripts/lead-patrol-snapshot.sh \
  packages/teamlead/scripts/lead-rules-bundle.sh
```

因此本单没有改 `ready.v1` / EpicPage 模型 / 派发准入 / `runs/start` / STEP 快照脚本 /
rules bundle 装配器，也没有新增 timer、flag、配置键、路由、表或告警通道。

## 4. 生产真数据演练前置审计

计划 §4.3 把真数据演练明确约束为“Lead 已补 Linear binding”之后才执行。2026-09-04
在不输出任何 secret 的前提下检查当前生产配置，得到：

| 证据 | 结果 |
|---|---|
| runner 环境 `LINEAR_API_KEY` | present |
| `~/.flywheel/teamlead.db` | present |
| geoforge3d / joycon-typeless / personal-assistant / growth / flywheel / tidal-echo 的 `linear` binding | **六个全部 absent** |

因此本节点没有猜 Linear Project 名称，也没有用伪 binding 对真实 Linear 发查询；没有复制或
写生产数据库，没有发送真实 `[patrol_tick]`。这不是实现缺口：plan §8 把 binding 明确列为
Lead-owned 部署前置且禁止本 PR 修改 `projects.json`。

binding 补齐后，QA/部署前演练仍需在生产库副本上记录：scope item 数、耗时、每个 Linear
请求的 `x-complexity`、渲染三行，以及副本中新 `trigger=scan` 回执版本；全程不得写生产库
或发送真 tick。

## 5. 非验收性全套测试观察

一次误用 `test:run -- <filters>` 被 Vitest 解释成全包运行；该次运行不是本单签收证据。
它完成 822 个 test files：814 pass、7 fail、1 skip；失败集中在未预构建 `dist` 的 launcher /
maintenance 用例、一个 shell 环境用例、一个本机 tmux window-name 用例，并出现一个 worker
回报超时。本单上述 7 个目标文件随后以明确路径和 `VITEST_MAX_THREADS=4` 独立重跑全绿。
