# Bridge 侧 PR Ship 纪律

**Date**: 2026-06-03
**Source**: Annie 在 FLY-193 (PR #212) ship 时拍的纪律

## 规则

> **多个 Bridge 侧 PR 待 ship 时,攒成一次重启。**

不要每个 PR 单独重启一次生产 Bridge。开 ship 前先问 team-lead:有没有其他 Bridge 侧 PR 在排队?有就合并到同一次重启窗口。

## 为什么

- 每次 Bridge 重启都是一次生产扰动:heartbeat sender 死(FLY-172 reconcile 兜底,但 advisory 噪音照发)、监控窗口断、launchd throttle 风险
- 重启本身有已知坑(FLY-176 multi-PID kill bug、bootout 杀错 PID 变体),次数越少踩坑面越小

## 统一重启流程(FLY-1671,取代旧手动 kill 流程)

1. **先把配置/代码提交并推到 `origin/main`**,再请 founder 拍重启时机。入口的目标版本固定取远端 `origin/main` SHA;入队不代表重启已经完成。
2. founder 拍板后运行 `bash ~/Dev/flywheel/scripts/request-restart.sh`。它复用 FLY-270 的 `~/.flywheel/self-ship-pending.d` 队列与 `com.flywheel.updater`,只写 marker + nudge,不直接杀任何服务。
3. 独立 updater 消费 marker并运行既有 `restart-services.sh --reason updater`。updater 不属于 Bridge/Lead 被重启集合,所以无需豁免任何 Lead,原发起 Lead 也能换到新本体。
4. 以 updater/restart 报告为完成证据:核对 Bridge 健康、Lead supervisor 收敛,以及「本体」行的换本体/被接管(未换)/未知计数。成功入队的命令输出不是完成证据。
5. 只有队列/updater 故障且 Lead/founder 明确知情时,才直跑 `restart-services.sh` 作紧急兜底;不要恢复本节旧版的 `pgrep`/`kill -9`/手工 `kickstart` 流程。兜底由 Lead 发起时,报告会显式暴露可能被 adoption 的旧本体。
6. 纯 Bridge 侧改动是否需要全量重启仍按变更面判断;一旦决定统一重启,都走上述 updater 入口。
