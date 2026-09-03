# FLY-2271 daemon 自动切号失败零证据 — 实施说明
Issue: FLY-2271 (https://linear.app/geoforge3d/issue/FLY-2271/切号器daemon-自动切号在-token-轮转后必失败委托模式对-stale-active-marker不修复直接-46)
日期: 2026-09-02
基于: plan.md

## Code review round 1 收口

Round 1 在 `d67133198651b73682fe1fd2933f78c913d765bf` 返回 `APPROVED`，包含一条 MEDIUM 与四条 LOW advisory。按 Lead 指令，本节点没有把 APPROVED 当成完成：

- MEDIUM `episode-identity-includes-volatile-child-evidence`：同一个 `reasonCode + degraded` episode 现在只原位刷新 exit、child 与 detail，不再因为子进程证据抖动重置 `startedAt`、告警次数、重告警冷却或十次上限。
- LOW `stale-task4-guidance-in-founder-alert`：删掉“Task 4 尚未落地”的过时承诺，改成无条件的 restart / re-run deploy wave 操作指引。
- LOW `apply-child-started-semantic-widening`：诊断载体仍保留最后一条真实 child evidence；但 `applyProfileChildStarted` 只描述终止本次执行的 child。后一个无 child 的 plain failure 不再继承前一候选的 `true`，因此手动入口会补写该终态审计。
- LOW `rqm-runtime-sha-unbounded-and-pre-domain-check`：先用只读 `launchctl print` 证明 job 在域，再调用 runtime SHA 命令；旧 binary 在 job 不存在时不再有机会误入前台 daemon loop、卡死部署。
- LOW `not-loaded-double-alerts-with-converge`：`not_loaded` 保持日志可见，但由相邻 non-Lead convergence / fleet census 独占告警，不再发第二条 quota-monitor degraded warning。

`_rqm_now_ms` 与 `_rqm_read_record` 仍是直接、固定程序的本地 Node 调用，没有再包一层 timeout。它们只在 job 已证明 loaded 后运行，代码体分别是 `Date.now()` 和最大 64 KiB 的 owner-only JSON 读取；本单已消除会把旧 daemon binary 启成常驻进程的实际无界路径。若以后统一给这些短本地 probe 加预算，应在 restart helper 家族做一张独立收敛单，避免本单引入新的 process wrapper。

## 本机全仓门说明

`pnpm lint` 与 `pnpm -r build` 通过。精确 `pnpm test:packages:run` 的非零项均与本单无关：Core 两个 Terminal.app / AppleEvents 用例在 resident sandbox 无 GUI/XPC；config drift census 在并发负载下超过五秒。Core 非 GUI 219/219 与 drift-scan 27/27 的单 worker 隔离复跑通过。

`flywheel-claude-runner` 聚合首次为 972 pass / 2 skipped 后仅报 Vitest worker RPC timeout；单 worker 全包 972 pass / 2 skipped、零 error。`flywheel-teamlead` 聚合为 10182 pass / 6 skipped，三项并发 timeout/mock spillover 隔离 26/26 通过；另一个真实 tmux 用例因本机 tmux 拒绝带 TAB 的 window name 而失败，和本单路径无关。

本地 `codex:rescue` companion 已按合同以 review-only task 调用，但在读取仓库前被 resident 外层 macOS seatbelt 拒绝 nested `sandbox-exec`（status 71）；没有使用 raw `codex exec`，也没有把该尝试记作 review PASS。权威结论来自 request-driven cross-family review gate。

Round 2 在 `83194f2a1fd8d5f2504a8db857120a17d441b35b` 再次 `APPROVED`，确认上述 MEDIUM 与生产 LOW 已收口；唯一新增 LOW 是 runtime-hash-failure 测试的 `print*` 会跨换行匹配。该断言已改为同时要求 launchctl 日志恰好一行，避免未来追加 `kickstart` 后仍假绿。uniform timeout residual 保持上述明确边界。
