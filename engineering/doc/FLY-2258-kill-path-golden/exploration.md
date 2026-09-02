# FLY-2258 kill-path golden 对账 — 探索
Issue: FLY-2258 (https://linear.app/geoforge3d/issue/FLY-2258/hotfix-main-红-kill-path-inventory-golden-漏-fly-2240-的-4-条-qa-only)
日期: 2026-09-01
基于: 无

## 现象

`main` 的 `packages/claude-runner/test/kill-path-inventory.test.ts` 在基线
`e3554c812` 上失败：`scanKillPathInventory()` 返回 556 条，而已提交 fixture
只有 552 条。

## 已确认事实

- `155e1e78a`（FLY-2240）引入了两处新的测试资产：
  - `packages/claude-runner/test/claude-profile.test.ts` 中同一条
    `process.kill(-callerGroup.pid, "SIGKILL")` 出现 3 次。
  - `scripts/__tests__/restart-account-switch-runtime-preflight.test.sh` 中包含 1 条
    同行的 `kill -0` 探针命中。
- `e3554c812`（FLY-2211）随后引入 552 条的 golden fixture；两个改动分别验证时
  基线未同时包含对方，合序后 fixture 才产生漂移。
- 现有扫描器先按路径识别测试目录，因此上述 4 条全部被分类为 `qa-only`。
- RED 证据：
  `pnpm --filter flywheel-claude-runner exec vitest run test/kill-path-inventory.test.ts`
  明确报出 `expected [ Array(556) ] to deeply equal [ Array(552) ]`，且 diff 只显示
  上述 4 条新增项。

## 范围与约束

- 行为 seam 已由 issue 锁定：现有 scanner 输出必须与 committed fixture 完全相等。
- 产品代码改动只允许重生
  `packages/claude-runner/test/fixtures/kill-path-inventory.json`。
- 不修改扫描、分类逻辑，不修改 FLY-2211/FLY-2240 生产代码，不重构。
- DOC-FLOW 文档与最终 milestone 是流程要求；“仅一个 fixture 文件”的验收按
  产品/实现 diff 理解，流程文档不扩大运行时改动范围。

## 成功判据

1. inventory 单测转绿，扫描结果与 fixture 均为 556 条。
2. fixture 相对基线只新增 4 条，且全部是 `qa-only`。
3. 所有非 `qa-only` 条目逐字节不变。
4. 完整仓库 gates 与所有 `scripts/__tests__/*.test.sh` 通过。
