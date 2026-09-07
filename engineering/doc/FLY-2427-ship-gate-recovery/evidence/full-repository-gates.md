# FLY-2427 Ship gate 死卡收敛 — 全仓验证
Issue: FLY-2427 (https://linear.app/geoforge3d/issue/FLY-2427/批准通路-lead-对-approve-to-ship-gate-的非批准回复被接受并消耗掉这道门却不铸-source-event)
日期: 2026-09-07
基于: plan.md

验证基线：`origin/main@fb9146878a89ea97dedf5136de8b57b6ec792ddf`。

## 通过

- `pnpm lint`：exit 0；14 条非阻塞 warning，均不在本单变更面；另有
  `StateStore.ts` 超过 Biome 1 MiB 上限的提示。
- `pnpm -r build`：22/22 workspace projects 完成。
- `pnpm exec vitest run test/async-exec-file.test.ts --maxWorkers=1
  --minWorkers=1`（`packages/claude-runner`）：7/7。
- `git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main`：exit 0，
  输出为空，0 个 conflict marker。
- 本分支没有新增 `scripts/__tests__/*.test.sh`。

## 未通过的 aggregate 边界

`pnpm test:packages:run` 已按字面运行，但不能声明 full gate green：

1. 首轮中 `claude-runner` 的 45 个文件全部通过（1105 passed、2 skipped），
   Vitest 在 worker 汇报 `onTaskUpdate` 时超时，aggregate exit 1。
2. 第二轮 claude-runner aggregate 中 1104 passed、2 skipped，
   `async-exec-file.test.ts` 的 500ms 子进程用例在负载下超时，并再次出现同一
   `onTaskUpdate` error；该文件随后单 worker 7/7 通过。
3. claude-runner 全包单 worker 复验消除了 RPC error，但
   `runner-env-isolation.real-tmux.test.ts` 启动隔离 tmux server 时得到
   `server exited unexpectedly`；其余 1102 passed、4 skipped。
4. 上述 real-tmux 文件单独重跑仍失败；在 detached 的精确
   `origin/main@fb9146878` 临时 worktree 中运行同一命令，得到字节等价的
   `server exited unexpectedly`。因此这是当前机器/基线故障，不是 FLY-2427
   分支引入；临时 worktree 已清理。

FLY-2427 变更涉及的 config、flywheel-comm、teamlead 测试在 aggregate 输出中
均通过。core 的 `tmux-viewer.macos.test.ts` 被实际执行，15 个用例中 13 passed、
2 个因当前进程无法解析 Terminal.app 而 skip；这里保留该 skip 边界，不把它
写成 full green。
