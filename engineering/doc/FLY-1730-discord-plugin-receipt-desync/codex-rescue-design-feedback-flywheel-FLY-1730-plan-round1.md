# Design Review — FLY-1730 plan.md (Round 1)

Date: 2026-08-12
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向正确：复用 PR #20、净删 receipt/advisory 机制、以真实 cache 更新和载体重启定义交付，都与事故根因和 founder 红线一致。但当前计划会被现役 FLY-1676 完整性检查硬拦，且部署回执、回滚排序与寄生进程清场仍有会造成假完成或无法收敛的缺口，因此尚不能进入实施。已直接核验生产 cache/registry、`.env` flag、主仓 CLI 和当前部署脚本；本 sandbox 禁止 `ps`，所以实时进程数量未重取，但以下 blocker 均由静态生产路径即可确定。

## What's Good (Keep)

- 以 PR #20 全量基底加窄 delta 的单 PR 载具是正确取舍，避免重写已经通过 173 个测试和跨仓残留门的拆除工作；并且要求首次 review 覆盖基底而不只看 delta。
- D1/D2 通过删除 `AdviseFn`、marker 和 `channel.send('⚠️ …')` 通路落实“内部 plumbing advisory 不得进入 founder channel”，没有新 watcher、flag 或告警通道。
- 保留 `chat-ingest`、ingest spool 和 mailbox 投递语义，同时删除 begin/complete/settle/pending/quarantine，符合 FLY-1645 的兼容矩阵；当前主仓确实只有 `chat-ingest` case，没有 `chat-receipt` case。
- 交付定义包含安装 SHA/version 校验、统一重启、真实 Discord 回复、15 分钟观察窗和非空阳性对照，不把 repo merge 冒充生产修复。
- 对 FLY-1676 freeze、FLY-1645 retired-flag closeout 和 PR #21 rebase 邻接关系的识别是必要且基本正确的。
- 残骸清理明确保留 `ingest/`，并选择归档而非删除，方向正确。

## Issues & Recommendations

1. **BLOCKER — PR #20 的类重命名会被现役 FLY-1676 checker 判成损坏，导致统一重启在任何 Lead mutation 前中止。** 计划和 research 明确说 PR #20 将 `ChatReceiptRuntime` 重命名为 `ChatIngestRuntime`（`research.md:52-54`），但 canonical checker 仍逐字要求新 cache 的 `server.ts` 含 `ChatReceiptRuntime`（`scripts/discord-plugin/check-discord-plugin.sh:72-80`，生产 `~/.flywheel/bin/check-discord-plugin.sh` 同样如此）。`restart-services.sh` 在复检失败后返回 hard failure，并于重启波前退出（`:513-525`, `:968-976`）。因此 `plan.md:13,55-57` 的“主仓 docs only/零代码”与 `plan.md:65-66` 的部署步骤不可同时成立。**建议：**把 main-repo checker、其 fixture/tests 和 live ops convergence 纳入本单最小兼容 delta；使用同时接受旧 `ChatReceiptRuntime` 与新 `ChatIngestRuntime` 的过渡性 fork marker（仍需 exact remote SHA 与其余 marker），先在 0.0.4 上部署并证明 old/new 两类 fixture 都通过，再 merge/update fork。不要在新插件里塞一个过期的 `ChatReceiptRuntime` 假 sentinel 来骗 checker。

2. **HIGH — runbook 绕过了既有单写者锁，并把“重启已入队”当成了可继续清理的同步步骤。** `plan.md:63-66` 直接执行裸 `claude plugin update`，但当前受控写者是 `~/.flywheel/bin/update-discord-plugin.sh`：它持全机锁、锁内复检、刷新 marketplace、执行 user-scope update 并再次校验（`:79-123`）；`restart-services.sh:470-529` 已复用它。裸 CLI 会与 launcher/restart 的 updater 竞写 registry。更关键的是，`scripts/request-restart.sh` 成功只表示 durable handoff 已入队，源码和 stdout 都明确“不代表重启完成”（`:2-5`, `:72-79`），计划却没有冻结一个 terminal completion predicate 就进入进程核验、归档和 closeout 解锁。`uninstall + install` fallback（`plan.md:84`）还会在活舰队中短暂移除/重启插件 authority。**建议：**只走 managed updater（或让 `request-restart.sh` 内部的 `restart-services.sh` 调它），删除裸 update 与无静默门的 uninstall/install fallback；冻结 fork expected SHA 和 merged manifest version，等待 `reason=updater` 的终态播报，并要求 `~/.flywheel/leads-restart-status.json` 对目标 `codeDeployedSha` 为 `healthy, failed=0, skipped=0`，随后再做 registry/cache/process 校验。入队成功、update 命令成功或单次 checker 成功都不是完成收据。

3. **HIGH — FLY-1645 `.env` 解锁发生在独立 QA 之前，且当前 rollback 会与该解锁组合成比今日更坏的状态。** runbook 在 `plan.md:68` 已通知 closeout 可删 retired flag，而 A1-A5 从 `plan.md:70` 才开始；若 QA 随后失败，`plan.md:87` 的 full revert 会回到仍读取 `FLYWHEEL_MAILBOX_DISCORD` 的 0.0.4。此时 flag 若已被 closeout 删除，入站也会落到已不存在的 legacy `begin` CLI，除了原有 settle 事故还会新增 inbound 失败。**建议：**把 closeout 解锁移到 A1-A5 全部通过、零旧进程和 rollback 决策关闭之后；在此之前保持 `FLYWHEEL_MAILBOX_DISCORD=1`。把 rollback 分两级写清：优先 roll-forward/部署“PR #20 teardown 保留、只撤有问题 delta”的下一 patch；只有 PR #20 本体造成更严重回归时才允许回 0.0.4，并要求在旧进程启动前确认 flag=1、明确恢复 settle 事故并启动事件 containment。当前“revert → 0.0.6”不是健康 rollback。

4. **HIGH — `0.0.5` 被写死，与“PR #21 先落者赢”及每次 fork main 前进都必须 bump patch 的契约冲突。** 当前确实是 0.0.4，所以本单先落时 0.0.5 正确；但若 PR #21 先落，它按 FLY-1676 版本纪律也必须占用下一 patch，本单 rebase 后再写 0.0.5 会被 CLI 判 already latest 或留下旧 SHA。`plan.md:23,40,64` 目前没有重算规则。**建议：**D3 改成“merge 前 JIT 读取 fork main manifest，严格 patch +1”；0.0.5 只是当前预期。若 #21 先落，rebase 后重算版本、重新跑全 PR tests/residue gate，并对新的 exact head 复审；部署验收读取 merged manifest 的版本，不硬编码 0.0.5。

5. **HIGH — 全量 Lead restart 不拥有 FLY-1715 的 Runner 寄生进程，残骸归档也没有碰撞安全。** `restart-services.sh` 的 restart inventory 是 manifest + loaded Lead plist（`:1676-1758`），不是所有 Runner session；因此 `plan.md:66` 所称寄生进程会随统一重启自然消亡没有代码依据。全局 `ps` 零 0.0.4 是正确的 fail-closed gate，但计划没有在 gate 失败时如何用既有生命周期收敛 owner，若直接执行 `plan.md:67`，旧寄生进程仍可能继续写被移动的 spool。另将 root begin、`settle/` 和 `meta/` 扁平移入同一个按日期目录会在重复执行或相同 message ID 同时存在 begin/settle 时覆盖证据。**建议：**更新前记录每个 adapter 的 PID/PPID/argv/state-dir/owner，Lead wave 后再做全局 census；对仍 pin 旧 cache 的进程，先通过其现有 Runner/Lead 生命周期精确终止或重启，无法归属则停止部署并人工接管，零旧 producer 后才归档。归档使用唯一时间戳目录并保留 `begin/settle/meta` 相对层级，写 count/hash manifest 后再 move；`ingest/` 继续严格排除。

## Verdict

CHANGES REQUESTED — address items above
