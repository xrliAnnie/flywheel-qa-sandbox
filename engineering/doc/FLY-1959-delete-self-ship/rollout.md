# FLY-1959 删除老 self-ship 路 — 切换手册
Issue: FLY-1959 (https://linear.app/geoforge3d/issue/FLY-1959/self-ship净删除-删掉老自-ship-重启路只留定时班车-founder-紧急一张票)
日期: 2026-08-21
基于: plan.md

## 1. implement 节点边界

本文件定义 merge 后由 QA/ship 窗执行的 production cutover；implement 节点不运行 `bootout`、`bootstrap` 或真机 restart。`r4_restore_updater` 是仓内现有的 staged + atomic installed-plist 实现，代码与测试需同步收敛到本合同。

production canonical state root 是 updater 启动时捕获的 `${HOME}/.flywheel`，urgent watched dir只能是 `${HOME}/.flywheel/self-ship-urgent.d`。macOS plist 使用当前 production owner 的绝对展开路径，producer与consumer解析到同一 canonical root，Linux supervisor从 `$st` 派生同名目录。`FLYWHEEL_HOME` / `SELF_SHIP_*_DIR` override只用于source harness；正常执行会主动覆盖 `.env` 中的同名值，避免producer、consumer与plist分叉。

## 2. 紧急票语义

Founder `request-restart.sh` 的成功只证明 token 已持久化并 nudge updater，不证明 restart 完成。紧急票是 at-most-once：updater取得 singleton lock 后先做最多三次、每次20秒上限且禁交互的 remote fetch probe；deploy阶段再次 bounded fetch，随后冻结 `origin/main` SHA并做纯本地 `merge --ff-only`，不会用网络 timeout强杀 worktree mutation。bounded runner缺失会fail-fast并在独立告警中点名路径，不会被误报成网络失败。全部 fetch尝试失败后，或后续 probe/deploy/可捕获的退出失败时，都会把可移动的开场票移出 watched dir并以 token basename 唯一 signature 告警，绝不靠留票自动重试；这样坏票不会让 `QueueDirectories` 每分钟热拉或永久阻塞后票。唯一例外是 filesystem 令原子 claim本身失败：该 exact entry仍会保持 watched condition，看到 `claim-failed` 后 operator必须先修正/删除它再重投，不能把每分钟 runs当正常重试。SIGKILL、宿主 panic 或断电无法执行 trap，仍可能无告警地丢失本票。Founder 未观察到完成播报或明确失败告警时，需要重新运行 `request-restart.sh`；本单不增加 receipt、retry ledger 或 quarantine 来填这个缺口。updater的handled rc已登记进 launchd manifest，失败仍靠自身逐票/每日告警，不应再出现持久 census `live_failure` 双报。

同一 updater 开场 snapshot 中的多张票合并为一次 restart；claim 后的新票是新的 founder intent，下一轮允许再 restart，`ThrottleInterval=60` 保证进程拉起至少间隔一分钟。`targetSha` 不能作为幂等键，因为当前代码已经是最新时，founder 仍可能需要强制全舰重启。

## 3. production cutover 顺序

1. 确认 `~/.flywheel/self-ship-urgent.d` 没有待处理票；只读记录 legacy pending 目录的存在性和 entry 数，任何残留都视为已退役的 merge intent，不得再执行。
2. 用 `install -d -m 700 ~/.flywheel/self-ship-urgent.d` 创建 watched dir，并断言 owner 是当前 uid、mode 是 `700`。
3. 对 repo plist 运行 `plutil -lint scripts/launchd/com.flywheel.updater.plist`；用结构化读取确认 `QueueDirectories` 只有 urgent dir、calendar只有本地 `00:00/12:00`、`ThrottleInterval=60`。
4. 在 installed plist 的同一目录创建 stage，复制 repo plist，设置 mode `0644`，验证 owner/mode与结构；不要直接覆盖 live path。
5. 对旧 label 执行 `launchctl bootout gui/$(id -u)/com.flywheel.updater`；已 unload 时只接受明确的 not-loaded状态，不忽略其他错误。
6. 只有在 bootout成功后，精确绑定 `legacy_pending="${HOME}/.flywheel/self-ship-pending.d"`，断言它等于该 canonical path；若目录存在，先留存 entry 名称到 cutover证据，再用 `find "$legacy_pending" -depth -mindepth 1 -delete` 和 `rmdir "$legacy_pending"` 删除全部退役 marker与目录。断言路径已不存在；不得在 live旧 plist 仍监视时删除/重建该目录。
7. 用同目录原子 `mv` 把 stage替换成 `~/Library/LaunchAgents/com.flywheel.updater.plist`。
8. 执行 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flywheel.updater.plist`。
9. 用 `cmp` 证明 installed bytes等于 repo plist，再用 `launchctl print gui/$(id -u)/com.flywheel.updater` 证明 live trigger只含 urgent dir、calendar为00/12、throttle为60；同时断言 legacy pending path仍不存在。installed bytes本身不是live证明。

## 4. QA/ship 观测

- merge 后确认 updater `runs` 不增长，不发生即时 restart。
- 下一班车在 `deployed-sha` 落后 `origin/main` 时只部署一次并只播报一次；追平时不部署。
- founder 紧急票即使 `deployed-sha == origin/main` 仍触发一次全舰 restart；同一开场批次多票只 restart一次，晚到票由下一实例处理。
- 人为制造一次 remote probe失败，确认该紧急票只产生一次明确失败告警、watched dir回空，随后新票仍可用；不得出现每分钟重复 runs。
- 完成 bootout/bootstrap 循环后持续观察24小时：`runs` 只随班车或 founder紧急票增长；不把 implement 阶段的静态/fixture结果冒充此真机证据。
- 预期部署事件由 `restart-services.sh::record_deployed_range` 以 `fallback-git-log` 补齐，若未来启用当前处于 `hold` 的 daily digest，UI会将其标为 `inferred`；这不是漏报，但是否恢复 authoritative source需另行裁定。
