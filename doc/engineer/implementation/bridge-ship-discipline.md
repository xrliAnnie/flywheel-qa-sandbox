# Bridge 侧 PR Ship 纪律

**Date**: 2026-06-03
**Source**: Annie 在 FLY-193 (PR #212) ship 时拍的纪律

## 规则

> **多个 Bridge 侧 PR 待 ship 时,攒成一次重启。**

不要每个 PR 单独重启一次生产 Bridge。开 ship 前先问 team-lead:有没有其他 Bridge 侧 PR 在排队?有就合并到同一次重启窗口。

## 为什么

- 每次 Bridge 重启都是一次生产扰动:heartbeat sender 死(FLY-172 reconcile 兜底,但 advisory 噪音照发)、监控窗口断、launchd throttle 风险
- 重启本身有已知坑(FLY-176 multi-PID kill bug、bootout 杀错 PID 变体),次数越少踩坑面越小

## 经过验证的重启流程(FLY-193 ship 实录,2026-06-03)

1. **先改配置再杀进程**(env / projects.json 等)—— 新进程起来直接读新配置,一次重启生效
2. `pgrep -f run-bridge` → 逐 PID `ps -p <pid> -o command=` **按路径过滤**确认是 run-bridge 树(绝不杀 `bun server.ts` Lead adapter)→ 逐个 `kill -9`
3. `lsof -i :9876` 确认端口释放
4. **launchd KeepAlive 会在数秒内自动拉起新 Bridge** —— 先等 ~5s 查 `launchctl print gui/$UID/com.flywheel.bridge`,job 已 running 就不需要 kickstart;没拉起再 `launchctl kickstart -k`(exit 37 = throttle,稍等重试)
5. 验证:boot log(`/tmp/flywheel-bridge.log`)无 ALERT-UNREACHABLE、`/health` 的 `sessions_count` 与重启前一致、在途 Runner tmux 全存活(FLY-172 合同)、Lead adapter 进程数不变
6. 纯 Bridge 侧改动 **Lead 不需要重启**(FLY-175 Track 2、FLY-193 先例)
