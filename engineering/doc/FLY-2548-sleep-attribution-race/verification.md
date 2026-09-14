# FLY-2548 sleep 子进程归因 — 验证
Issue: FLY-2548 (https://linear.app/geoforge3d/issue/FLY-2548/flake-bridge-event-loop-guardtestts540-sigkill-子进程归因在-ci-teamlead3)
日期: 2026-09-14
基于: plan.md

## 验收责任
Lead 在问题 e6466c8d-7c0c-490d-a37b-68b5e4345b79 回复裁定：不绕沙箱；判据 1 的本地先红后绿和连续 20 次 GREEN 交由有 ps 权限的 QA 宿主在验收阶段执行。实现方需在 PR 提供受控 exec 延迟 RED 探针和 20 次 GREEN 循环脚本及预期输出。实现方完成设计评审后的测试修复、可运行的沙箱隔离绿和精确头相关 CI 分片连续两次绿。禁止修改 CI workflow 补环境限制。

## 已有回执及边界
- 基线 lint：`pnpm lint`，exit 0，/tmp/FLY-2548-lint-baseline.log。
- 基线 build：`pnpm -r build`，exit 0，/tmp/FLY-2548-build-baseline.log。
- 基线隔离：`pnpm --filter flywheel-teamlead exec vitest run src/__tests__/bridge-event-loop-guard.test.ts`，17/17 PASS，/tmp/FLY-2548-baseline.log。
- 实现沙箱 ps EPERM，children=null 只证 fallback 不证归因；红/绿由 QA 宿主复跑。本地受控 RED 探针未得到要求的 node 归因红，不计入先红证据。
- 历史 CI job 103871713683：node pid=4589，1 failed/4131 passed/1 skipped，/tmp/FLY-2548-exact-job.log。历史 CI 红不是本地复现。

测试实现已完成；最终 PR/CI 回执尚未产生。最终评审后不再提交文档；届时通过结构化报告和 PR 信息提供最终 HEAD 的 CI 回执。

## QA 宿主复跑命令（待 QA 执行，不能当已通过）

```sh
pnpm exec tsx packages/teamlead/src/__tests__/fixtures/loop-guard/attribution-probe.mts
```

要求支持 process.execve 的 Node 22 新版本或仓库当前支持的更高版本，且真实 /bin/ps 可用。脚本无 ps 时 exit 2，输出 UNVERIFIED。RED 使用原 guard-before-spawn 顺序加 800ms 同 PID node→sleep exec 延迟，必须输出真实 SIGKILL/null 与 node child，确认原 sleep 断言失败；这是受控启动窗口复现，不冒充无注入自然复现。随后连续 20 次运行真实 Vitest 目标用例，每轮 direct sleep 和 delayed exec 均通过，预期最终 `GREEN complete: 20/20 rounds, 40/40 kill cases`。可用 --red-only / --green-only 分开执行；保存命令、Node 版本、HEAD、完整 stdout 和退出码。

## 实现测试结果
- 修改后目标文件 18/18 PASS（直接 sleep 和延迟 exec 两个 kill 场景），/tmp/FLY-2548-focused-green.log。当前沙箱只证明 fallback。
- 探针沙箱预检正确拒绝：exit 2 / UNVERIFIED，/tmp/FLY-2548-probe-sandbox.log；不计 host RED/GREEN。
- 原始全仓 `pnpm test:packages:run`：exit 1；config fly1981-final-ledgers 台账测试超时，52 文件通过/1 文件失败，824 例通过/1 例失败。/tmp/FLY-2548-packages-baseline.log；这是未修改代码前的基线红。为避免真实 GUI 测试，后续补充全仓运行显式排除 tmux-viewer.macos.test.ts，并限制并发。

- 修改后 `pnpm lint` exit 0（既有 warnings 保留），`pnpm -r build` exit 0。修过一处探针 nullable 类型错误后全仓重新构建通过。日志 /tmp/FLY-2548-lint-final.log、/tmp/FLY-2548-build-final.log。
- `pnpm --filter flywheel-release-contract test:run` 24/24 PASS。
- 补充全仓验证命令 `pnpm --workspace-concurrency=1 --filter "./packages/*" --filter "!flywheel-release-contract" test:run --exclude "**/tmux-viewer.macos.test.ts" --maxWorkers=2` 已退出 1，日志 /tmp/FLY-2548-packages-bounded.log；不把运行中当通过，最终结果随 structured handoff 报告。release-contract 使用 node:test，不接受 Vitest flags，故单独完整运行。
- 无新增 scripts/__tests__/*.test.sh。仅新增目标测试夹具及 QA 探针；生产 src/bridge 与 CI workflow 零 diff。

- 强制走真实握手的沙箱阴性探针明确失败（ps EPERM 或自有 timeout）并清空本次临时目录；/tmp/FLY-2548-deadline-check.log。并发宿主测试期间实际 wall time 37133ms，说明 JS timer/进程创建受宿主调度影响，不能宣称 12s 是宿主饥饿下的硬墙钟上限；守卫的 timing 断言未放宽。

## 全仓补充运行发现与修复
claude-runner 分段：1 failed / 1333 passed / 2 skipped，并有独立的 onTaskUpdate unhandled timeout。失败测试 kill-path-inventory 检测到新增测试清理 process.kill 没有 qa-only 登记；这是本次改动引入的实质失败，不是 flake。已在 packages/claude-runner/test/fixtures/kill-path-inventory.json 仅增加这条 qa-only 条目，隔离 inventory 全部 5 例通过（/tmp/FLY-2548-inventory-green.log）。其余尚未执行包继续做受限并发验证，最终回执走结构化报告。新头需重新评审/CI，旧头 9519680d4 的回执不用于放行。
