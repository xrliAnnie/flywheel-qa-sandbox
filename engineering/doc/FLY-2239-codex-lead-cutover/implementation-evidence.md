# FLY-2239 Codex Lead 全员 cutover — 实施证据
Issue: FLY-2239 (https://linear.app/geoforge3d/issue/FLY-2239/cutover-resident-codex-lead-全员切换2216-ship-后名册-opt-in-激活五步-pane-告警对齐)
日期: 2026-09-05
基于: plan.md

## 实施边界

本节点只提交 pane guard 名册驱动代码、测试和收官状态页。D0–D6 已设计、未执行,待 founder 真正需要时再跑。没有执行生产 kill、kickstart、bootout、plist 安装、Bridge/runner 重启或任何 cutover;`claude-infra-bot-lead`(Claw)零触碰。绿色实现提交为 `d3e36a728`。

## TDD 证据

1. 先补 T1–T12:旧实现下 `tui-window-alert.test.ts` 25 格中 7 格按预期红,runtime 新文案 1 格红,Raya preflight 新空名册负控 1 格红。
2. 最小实现后,聚焦组 72/72 绿;`raya-activation-preflight.test.sh` 8/8 绿;`test-tui-window-lost-alert.sh` 绿。
3. 生产 guard 中 `codex-infra-bot-lead` / `"raya"` 身份字面量扫描为 0 行。

## 变异验证

每次变异都以绿色提交 `d3e36a728` 为还原锚点:

| 变异 | 预期红 | 实测 |
|---|---|---|
| 删除 roster `find` 中的 `leadKey` 比较 | T5 第二格 | 25 格中仅 `rejects mismatched lead key` 1 格红 |
| 删除 `if (!target) return null` | T4/T6/T7 家族 | 25 格中 7 个名册拒绝/静默负控红 |

两轮后 `git diff --exit-code d3e36a728 -- packages/teamlead/src/lead-backends/codex/tui-window-alert.ts` 均为空,再跑目标文件均为 25/25 绿。

## 本地验证

| 命令 / 分解门 | 结果 |
|---|---|
| `pnpm lint` | PASS;14 条既有 warning,无 error |
| `pnpm -r build` | PASS |
| teamlead 最终 touched-file 单 fork 门 + 两个 shell 门 | PASS;85/85、8/8、shell PASS |
| `flywheel-core` 安全全量(显式排除 `tmux-viewer.macos.test.ts`) | PASS;219/219 |
| `flywheel-claude-runner` 单线程全量 | PASS;1047 通过、2 跳过 |
| `flywheel-config` 单线程全量 | PASS;762/762 |
| 后序 voice/token 包 | PASS;token 173、voice-core 320(+4 skip)、voice-bridge 649、voice-headphone 54 |
| `flywheel-teamlead` 单线程全量 | 11191 通过、6 跳过、1 个既有环境夹具失败 |

全仓命令按批准计划拆开执行,没有运行会真实打开 Terminal.app 的 `packages/core/test/tmux-viewer.macos.test.ts`。最初多包并发出现 Vitest worker `onTaskUpdate` 与超时噪声;依 Lead 指令改用 `--pool=forks --poolOptions.forks.maxForks=1` 后全部消失。

唯一剩余本地失败是 `src/bridge/__tests__/patrol-orphan-sweeper.test.ts` 的 FLY-2118 real-tmux 格:本机 `tmux 3.7c` 在进入被测枚举逻辑前拒绝夹具的 `new-window -n $'SCRATCH\tTAB'`(`invalid window name`)。该测试文件与 `origin/main` 字节一致,且与 FLY-2239 diff 无交集;本 PR 不扩大范围修改它。最终硬门以 PR exact-head GitHub CI 为准。

根目录 `scripts/__tests__` 没有本分支新增的 `*.test.sh`;本分支修改的 teamlead shell 回归已按上表执行。
