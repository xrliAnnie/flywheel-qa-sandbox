# FLY-1507 QA Fix Round 1 — 验证记录
Issue: FLY-1507
日期: 2026-07-27
基于: QA-REPORT.md

## D1 修复

新增 public seam 回归测试，通过 `lead_body_terminate` 的 full pane 路径重现：

1. body 在完整 identity proof 后收到 pane `C-c`；
2. 第一次 post-interrupt `lead_body_process_alive` 返回 alive；
3. 随后的 `lead_body_process_start_identity` 返回成功但空值；
4. 立即复查 liveness 时返回 dead，tmux window 随进程回收消失。

修复前结果为 20 passed / 1 failed，`lead_body_terminate` 返回 2。
修复后结果为 21 passed / 0 failed，返回 0。

实现只改 `_lead_body_tuple_state`：`lstart` 读取失败或为空时立即复查
liveness；只有已确定消失才返回 dead（rc=1），仍存活则保持 fail-closed
sensor error（rc=2）。PID reuse 仍因存活而保持 rc=2，不会获得 signal
authority。

## 验证结果

- `scripts/test-lead-body-sweep.sh`: 21 passed / 0 failed
- `scripts/test-restart-services.sh`: 84 passed / 0 failed
- `pnpm lint`: passed（只有仓库既有 warnings）
- `pnpm -r build`: passed
- `git diff --check`: passed
- `pnpm test`: 受当前 managed runner 的 macOS GUI 权限限制；
  `packages/core/test/tmux-viewer.macos.test.ts` 的 2 个真实 Terminal/
  Apple Events 测试失败（其余已执行的 core tests 为 219 passed），与本次
  shell restart 改动无关。

## 隔离真机 probe

按 QA 指令启动了 `probe-sensor-race.sh 10`，但当前 managed runner 对
throwaway label 的 `launchctl bootstrap` 返回 macOS error 5
（Input/output error）。round 1 因此没有生成 fixture body，不能形成
有效 race 样本；随即停止，trap 已清理 throwaway label/tmux socket。
未触碰任何生产 Lead job。原始 probe 已逐字导入本目录，待具备 launchd
写权限的 QA runner 重跑 10 rounds。
