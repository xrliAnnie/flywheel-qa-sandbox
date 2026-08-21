# Bridge 侧 PR Ship 纪律

**Date**: 2026-06-03
**Source**: Annie 在 FLY-193 (PR #212) ship 时拍的纪律

## 规则

> **merge 永不即时重启;多个 Bridge 侧 PR 由下一班 updater 班车一次部署。**

不要在 merge 后投重启票。正常变更等本地 00:00/12:00 班车统一收敛;只有 founder 对某一次紧急重启单独授权后,才使用紧急入口。

## 为什么

- 每次 Bridge 重启都是一次生产扰动:heartbeat sender 死(FLY-172 reconcile 兜底,但 advisory 噪音照发)、监控窗口断、launchd throttle 风险
- 重启本身有已知坑(FLY-176 multi-PID kill bug、bootout 杀错 PID 变体),次数越少踩坑面越小

## 两个部署入口(FLY-1959,取代旧 merge 后投票流程)

1. **正常班车**:本地 00:00/12:00 由 `com.flywheel.updater` 检查 `deployed-sha` 与 `origin/main`;只有落后时才批量部署,整班只播报一次。merge 只进入下一班车的候选集合,不 kick updater。
2. **Founder 紧急票**:founder 对本次重启单独拍板后运行 `bash ~/Dev/flywheel/scripts/request-restart.sh`。它向 `~/.flywheel/self-ship-urgent.d` 原子写一张最小 token 并 nudge updater;`QueueDirectories` 只看该目录,`ThrottleInterval=60`。
3. updater 取得全局锁后原子 claim 同一启动快照里的有效 token,统一运行一次 `restart-services.sh --reason updater`。晚到 token 留给下一次启动;每张票至多 claim 一次,不设 receipt/quarantine/retry 状态机。
4. 以 updater/restart 报告为完成证据:核对 Bridge 健康、Lead supervisor 收敛,以及「本体」行的换本体/被接管(未换)/未知计数。成功出票不是完成证据。
5. updater 故障时停止并请 founder 决定恢复方式;不得把直接 `restart-services.sh`、手工 `kickstart` 或旧 merge follow-on 恢复成第三条路。
