# FLY-2819 语音 launchd 迁移收敛 — 探索
Issue: FLY-2819 (https://linear.app/geoforge3d/issue/FLY-2819/班车部署阻塞-语音按需迁移-bootout-后立刻-bootstrap-失败报错被丢进-devnull-9-23-0000-pdt)
日期: 2026-09-23
基于: 无

## 目标与边界

本单只修复 `scripts/lib/restart-voice.sh` 的 launchd 迁移收敛：在 bootout 后等待旧 label 真正消失、保留 bootstrap 的 stderr/退出码、做有限退避重试，并让“新 plist 已安装但服务未注册”的残留状态在下一班班车恢复注册。不改变 FLY-2701 的按需唤醒、空闲退出、会话探测或推迟迁移语义，也不在生产 launchd 上做验证。

## 当前控制流与可复现故障

当前 `voice_migrate_to_on_demand` 的顺序是：

1. `launchctl bootout ... >/dev/null 2>&1 || true`
2. 覆盖 installed plist 并 chmod
3. `launchctl bootstrap ... >/dev/null 2>&1 || return 1`
4. 跑 `voice_on_demand_contract_check`

这有两个独立但串联的收敛缺口：

- `bootout` 返回不代表同 label 已从 launchd domain 消失。当前代码没有条件等待，立即 bootstrap；若 launchd 仍在清理旧 job，bootstrap 可返回 `5: Input/output error`。
- bootstrap 的 stderr 与退出码被丢弃，调用方又把细节覆盖成固定的 `on_demand_migration_failed`，部署日志无法区分竞态、权限或 plist 错误。

当前残留状态的分支也已确认：`restart_voice_managed` 在任何契约检查前先调用 `supervisor_is_loaded`。新 plist 已在磁盘但 `launchctl print` 找不到 label 时，该函数直接设置 `not_loaded` 并成功 no-op；下一班班车不会重新 bootstrap，因此无法自愈。

## 假设

- 只有 `launchctl print <domain>/com.flywheel.voice` 非零且 stderr 明确包含 `Could not find service` 或 `No such process`，才算 label 已卸载；legacy bootout wait 对其他结果 fail-closed。尚未 loaded 的 optional residual 对未知 probe 错误保持原有成功 no-op，不新增整车回滚路径。
- 磁盘契约完整、label 明确 absent 后的恢复 bootstrap 若耗尽，则返回失败并触发既有 deploy rollback；这是新路径，但 host 此时已处于 voice 无注册 outage，继续 no-op 会虚报成功。
- legacy 迁移仍须先证明 installed plist 是仓库曾发布的完整常驻契约、loaded job 是我们的 unit、且会话状态已证明安静。
- 残留恢复只接受磁盘上的 source/installed/wrapper 已满足现有完整 on-demand 文件契约；未知漂移或 loaded identity 不匹配仍拒绝。
- wait/bootstrap 默认预算与 FLY-2758 对齐：40 次 absent probe、5 次 bootstrap，并沿用相同的 tuning knobs。bootstrap 失败后按 1、2、3、4 个 interval 线性退避，第五次失败才返回失败。
- 本机验证仅使用 shell stub，不调用真实的 mutating launchctl。

## 方案比较

### A. 在 restart-voice seam 内增加小型条件等待与 bootstrap helper（推荐）

把现有 on-demand 契约检查拆出“磁盘契约”和“loaded identity”两层；legacy 迁移在 bootout 后调用有界 absent wait，再调用有限 bootstrap helper。残留状态只有在磁盘契约正确且 launchd 明确报告 absent 时走同一个 bootstrap helper；bootstrap 成功后还会有界等待完整 contract 可见。

优点：修改面与故障面一致；保留所有旧安全前置条件；stderr/rc 可直接进入 `VOICE_RESTART_DETAIL` 与既有 restart 日志；残留恢复无需重跑更宽的安装脚本。

代价：`restart-voice.sh` 会有少量与 `supervisor.sh` 同类的 launchctl polling 代码，但这里需要更严格的 failure detail 合同，不能直接复用 supervisor 的私有 helper。

### B. 残留和迁移都调用 `install-voice-launchd.sh`

优点：注册逻辑集中在安装器。

缺点：安装器是独立 CLI，包含更宽的环境、路径和退出行为；把 deploy restart seam 改成子进程调用会扩大故障面，也不自然承载 legacy 会话探测与 `VOICE_RESTART_DETAIL`。

### C. 直接复用 `supervisor.sh` 的 `_sup_darwin_*` 私有 helper

优点：代码更少，已有 FLY-2758 的同类实现。

缺点：helper 是 supervisor 私有接口；它把 bootstrap stderr 直接写日志而不返回给 `VOICE_RESTART_DETAIL`，且 wait 超时后仍尝试 bootstrap，不符合本 seam 的 fail-closed 收敛要求。方案 A 因此只对齐其默认预算与 tuning knobs，不调用这个无法返回错误细节的私有 bootstrap helper。

## 结论

采用方案 A。它是对现有 FLY-2701 迁移 seam 的最小修正，并能用一套 stateful launchctl stub 覆盖等待、重试、错误保真、bootstrap 后 contract 可见性和残留恢复。
