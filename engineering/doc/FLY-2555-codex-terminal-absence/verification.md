# FLY-2555 daemon harvest — 实施验证
Issue: FLY-2555 (https://linear.app/geoforge3d/issue/FLY-2555)
日期: 2026-09-14
基于: plan.md

生产所需行经 Lead gate 6c36e867 授权 readonly SELECT，2026-09-14T18:05:34.880807Z，9 running + 9 StateStore sessions，包含目标 1 行、对照 8 行。evidence/production-rows.json 仅保留这些 execution 的声明与 TURN。

## C1 受控重放

修前运行真实 reconcile，9→9、删除 0、目标命中 parked conflict。修后调用真实 harvestTerminalCodexDaemon → reapCodexDaemonForSession → reapCodexDaemonForExecution，信号注入替身只收到 SIGTERM；第一轮 9→9，第二轮 9→8，removed 只有 412485c1。evidence/replay-before.json 与 replay-after.json 为结果。

运行时 unowned、socket holder/PID group、信号、关闭后 absence 为明确的受控替身；初始 daemon tuple 与 CommDB/FSM 行来自只读实测。**这不是生产关闭证明，也不是 Bridge 内 owner 已查明的证明。** Runner pgrep rc3，详情在 host-probe-diagnostic.json。Lead gate 7b6ff36e 明确 owner 必须运行时检查，owned 则记录 window_recovery_needed，窗口恢复不在本单范围。

## C3 fixture patrol

2026-09-14T18:32:21Z 运行 scripts/lead-patrol-snapshot.sh（部署命令 flywheel-patrol-snapshot 的源文件），指向隔离修后 CommDB 与只包含所需 session 的 StateStore fixture，使用实际 tmux 只读列表。exit 0。STEP 1 无 MISSING_PANE，仍是 LEAD-JUDGMENT-REQUIRED（脚本不代替 Lead 判断），五个纳入本 Lead scope 的实际窗口各有一 pane。见 evidence/patrol-step1.txt。其他 STEP 因刻意最小化 StateStore fixture 缺 schema 会 UNAVAILABLE，不能把此验证说成完整巡检健康。

## 开发门禁

- pnpm -r build：通过（/tmp/fly2555-implementation-build.log）。
- pnpm lint：exit 0，18 个既有警告（/tmp/fly2555-implementation-lint.log）。
- reaper 110、teardown 5 测试通过；harvest 回归已扩展至 38 项，含真实 CommDB target/TURN race、boot failed 保留、marker race、失败结果保留。
- 初始 pnpm test:packages:run 与源码改动重叠，最终 exit 1，TeamLead receipt 3 failures；保存 WC1719/summary.json，不作为精确头验收。最后一次本地 aggregate session 52671 在源码冻结后启动，日志 /tmp/fly2555-final-packages.log，最终 exit 0，全部包 passed；见 evidence/package-gate-final.json。Lead instruction 396881c9-79b9-413f-bd74-6141783ec637 要求不再重跑 aggregate；指定 host contention 红回执保留并附 isolated green，PR 精确头 CI 为权威。
- 没有新增 scripts/__tests__/*.test.sh。未触碰生产 daemon、CommDB、StateStore；未部署、merge 或调度 QA。

## Linear 描述回执

2026-09-14T18:39:40.296Z 已将 FLY-2537 仍遗留的“原因待查”替换为本单实测结论，并追加新范围与 owner/hold 保护、旧目标未重新采样、生产未关闭的边界。GraphQL issueUpdate success=true，返回描述验证通过；见 evidence/FLY-2537-update.json。

最新安全修复后 pnpm -r build 与 pnpm lint 均 exit 0；focused 81 passed。正式代码 review c6cc32fe-bde5-46c8-98c4-e4ad1463baff / request cc67e3f8-5bdf-4b9e-b870-e7b1c2137a51 对 b1b13c583d524deb822e2f90c7c28137a010733e effective APPROVED、reviewer APPROVED。最终 package 已 exit 0；PR 精确头 CI 尚未完成。

## 审查建议与实现边界

审查 4 条 MEDIUM/LOW advisories 均不阻塞，已报告 Lead，未扩大生产修改范围：

- 生产 boot 的 residue-aware sweep 会调用 full pass，因此会启用同一个有 owner/hold/TURN 保护的 harvest。plan 原文“普通 boot 无关闭副作用”仅适用于 legacy fallback，不适用于生产 full pass；wiring 测试只证明 legacy 分支。此处明确纠正保证范围，未声称 reowner barrier 先于该异步 sweep。
- full pass 对非 parked 的终态 Codex 行也要求 daemon absence + execution absence。缺失或旧版 ledger、无法查询 owner、残留 argv 等可导致保守保留；keptAliveTarget 不能解释为已经证明窗口活着。
- 原目标实测 liveness=unknown、valid_group、live socket。候选可尝试 close，但 reaper 还必须证明 socket holder 属于持久化 PGID；unknown 时返回 unverifiable、不发信号，并可能重复记录 cleanup-failed。受控重放的 holder/group 证明不能替代生产证明，因此未承诺目标当前已经收敛。
- owner guard 的 window_recovery_needed 可能在一次多次检查中重复输出；日志去重属于非阻塞后续工作。

最后 aggregate 的 manifest HEAD 为 10b9b654684a48b6ef8fa9fc725ebd1241b37d5a；之后仅文档/进度提交，packages 源码与测试无变化。TeamLead receipt：1115 files、14371 passed、0 failed、7 skipped、errors=[]。初始重叠运行的失败仍保留，不将其改写成通过。
