# FLY-1671 手动重启入口 — 设计修正
Issue: FLY-1671 (https://linear.app/geoforge3d/issue/FLY-1671/fix-给既有的独立重启器comflywheelupdater-fly-270加一个手动触发入口)
日期: 2026-08-11
基于: plan.md

## Founder 补充约束

Annie 在 FLY-1671 thread 于 2026-08-11 01:05 PT 明确要求:

> 「重启的时候记得要pull latest main」

这不是入口侧自行 `pull` 的授权,而是对既有 FLY-270 单写者链路的硬约束。`scripts/request-restart.sh` 只读取远端 `origin/main` 的目标 SHA、向既有队列写 marker 并 nudge `com.flywheel.updater`;随后必须由 `scripts/update-flywheel.sh` 执行原生的 `git pull origin main --ff-only`，成功后才运行 `restart-services.sh --reason updater`。

因此手动入口不得绕过 updater、不得直接调用 `restart-services.sh`。若日志出现目标 SHA 未收敛却直接进入 `Already built` / 同 SHA 重启,应按「漏 pull latest main」病签名处理,而不是视为成功。只有 updater/队列故障且 Lead/founder 明确知情时才允许直接运行 `restart-services.sh` 作紧急兜底；该兜底不具备 pull latest main 的保证。
