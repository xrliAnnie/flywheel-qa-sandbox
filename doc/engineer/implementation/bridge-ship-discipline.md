# Bridge 侧 PR Ship 纪律

**Date**: 2026-06-03
**Source**: Annie 在 FLY-193 (PR #212) ship 时拍的纪律

## 规则

> **merge 永不即时重启;多个 Bridge 侧 PR 由下一班 updater 班车一次部署。**

不要在 merge 后投重启票。正常变更等本地 00:00/12:00 班车统一收敛；紧急入口只接受
founder 本次直接指令，或已独立激活的 `lead-closeout-restart/v1` 在 a/b/c 全部满足时的
Lead 收尾决定。merge 本身不满足任何一种。

## 为什么

- 每次 Bridge 重启都是一次生产扰动:heartbeat sender 死(FLY-172 reconcile 兜底,但 advisory 噪音照发)、监控窗口断、launchd throttle 风险
- 重启本身有已知坑(FLY-176 multi-PID kill bug、bootout 杀错 PID 变体),次数越少踩坑面越小

## 两个部署入口(FLY-1959,取代旧 merge 后投票流程)

1. **正常班车**:本地 00:00/12:00 由 `com.flywheel.updater` 检查 `deployed-sha` 与 `origin/main`;只有落后时才批量部署,整班只播报一次。merge 只进入下一班车的候选集合,不 kick updater。
2. **受控紧急票**：founder 对本次波次给出明确直接指令时，运行 bare `bash ~/Dev/flywheel/scripts/request-restart.sh`，保留原 AUTH-CANON(A) v1。Lead 收尾只走 schema-v3：active standing manifest + founder 当日本地日期上的固定语法意图 + 全部在飞体已 push、判决落库、可恢复且无 active turn/wake（或 founder 精确 waiver）+ 工程频道播报。历史 v2 已退休，不能重解释、升级或 fallback。
3. **v3 顺序不可交换**：先用 `restart-request.js scope-snapshot --request <absolute-private-draft>` 从 StateStore、全部项目 CommDB、TURN/wake、进程与 Git 状态物化并保存固定 scope；再发送绑定 decision/revision、intent ref、scope digest、target、目的、打断集合和恢复预期的工程播报；回读并写入该真实消息引用后，才运行 `request-restart.sh --request <absolute-private-request>`。播报后不得重新物化 scope，否则绑定失效。
4. updater 从独立确认的不可变执行包取得全局锁、重新核验并原子 claim 一张有效 ticket，运行一次 `restart-services.sh --reason updater`。v3 在第一次停服务前的最终闸门再次完整枚举并核验，随后才原子写 `started`；闸门失败记 `consumed-no-deploy`。同一波重叠/晚到票被合并审计，不造第二波；started/unknown 永不自动重试。
5. 以 updater/restart 报告为完成证据:核对 Bridge 健康、Lead supervisor 收敛,以及「本体」行的换本体/被接管(未换)/未知计数。成功出票不是完成证据。
6. updater 故障时停止并报告；不得把直接 `restart-services.sh`、手工 `kickstart` 或旧 merge follow-on 恢复成第三条路，也不得把失败 v3 自动改成 bare v1。
