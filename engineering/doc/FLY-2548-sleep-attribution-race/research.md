# FLY-2548 sleep 子进程归因 — 调研
Issue: FLY-2548 (https://linear.app/geoforge3d/issue/FLY-2548/flake-bridge-event-loop-guardtestts540-sigkill-子进程归因在-ci-teamlead3)
日期: 2026-09-14
基于: exploration.md

真实 worker 的 collectChildren 已按 ppid === harness pid 筛选，因此兄弟 node 混入尚无证据。当前夹具先启动 guard，然后 150ms 后 spawnSync sleep 0.6；guard 阈值 200ms。缺少 sleep exec 完成握手，取证可落在启动窗口，且 sleep 寿命短于繁忙宿主的取证时延。

精确历史 job：https://github.com/xrliAnnie/flywheel/actions/runs/34809758763/job/103871713683 。用 `gh api repos/xrliAnnie/flywheel/actions/jobs/103871713683/logs --allow-escape-sequences` 取证，/tmp/FLY-2548-exact-job.log：comm=node,pid=4589；1 failed / 4131 passed / 1 skipped。`gh run view --job --log-failed` 本次取到重跑绿日志，不能代替该精确 job 红回执。

方案比较：仅延长计时仍有竞态；修改生产筛选超出 scope 且现有 ppid 筛选正确；选择测试侧等待确定的直接 sleep PID 再启动原样 worker，保留真实 spawnSync 阻塞、真实 ps 和 SIGKILL。

本地原文件绿不等于复现。计划以测试夹具中受控 node exec 延迟重现 node→sleep 过渡；这证明测试启动窗口，不声称证明 CI 内核调度的唯一根因。

## 本地沙箱验收限制（09:18Z 实测）
`/bin/ps -p $$ -o pid=,ppid=,comm=` 和全表 ps 均被执行沙箱拒绝（operation not permitted）。因此本地 17/17 实际走 psAvailable=false 的 unknown/null 分支，不能支撑 sleep 归因绿色。受控 node exec 延迟探针 `/tmp/FLY-2548-reproduce.mts` 使用原样生产 worker 和真实 spawnSync；回执 `/tmp/FLY-2548-controlled-red.log` 证 SIGKILL/null exit、children=null，未复现要求的 node 归因红，不计入 RED。

已向 Lead 提问 e6466c8d-7c0c-490d-a37b-68b5e4345b79，请提供具有 ps 权限的授权验证执行端，或显式调整到 CI 证据。不会绕过沙箱。修复前红与本地 20 次 sleep 归因绿均仍缺失。

设计评审补充假设：主线程调度饥饿后，已过期的 150ms timeout 可能先于下一次 heartbeat interval 执行；守卫已观察到旧心跳，取证恰落在随后 child fork/exec 窗口。握手后刷新心跳覆盖这条路径；受控 exec-delay RED 只模拟启动窗口，不证明唯一 CI 根因。
