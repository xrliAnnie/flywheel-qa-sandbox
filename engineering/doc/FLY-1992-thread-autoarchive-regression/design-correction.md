# FLY-1992 thread 自动归档回归 — 设计修正
Issue: FLY-1992 (https://linear.app/geoforge3d/issue/FLY-1992/ship回归-thread-自动归档再次漏1832-已修已-ship-后回归同日同链-3-成-3-漏1831-漏-8h1975-1h1944)
日期: 2026-08-22
基于: plan.md

## Founder 原话

> 「这东西就是有必要专门看是不是Codex的容器吗?我觉得需要把它generic化,就是去看一下现在它的这些节点都还在不在,就不一定是说它是Codex或者Cloud或怎么样,不要做这种区分,就是我们要所有东西要做的通用化一点。」

## 废弃概念

废弃任何按 vendor（Codex / Claude / 未来其他 Runner）特判的探活或强拆分支。`adapter_type`、容器/daemon 品牌、vendor 名称不再是 shipped-terminal escalation 的资格或动作输入；本单不新增 `if Codex ... else Claude ...` 一类分叉。

原 `plan.md` 中 `isResidentCodexPhase`、`reapCodexDaemonForSession`、`codex_daemon_residual` / `codex_daemon_unverifiable` 作为通用强拆设计的概念依据均作废。它们仍可留在各自既有 vendor adapter 的旧合同里，但本单的新路径不得依赖。

## 保留器官

- 五道证据门保留：同 issue / 当前 run 的 workflow phase、节点窗口确实仍在、shutdown 请求已给满响应窗口、同一 closeout epoch 已失败过、terminal land 权威仍在。
- destructive boundary 的 identity / authority 双栅栏保留；任一证据不确定都不发信号。
- started → reaped / failed / aborted 的可重放审计、`aux:` 收据不重置 retry epoch、partial / held 的诚实说明全部保留。
- thread 只在所有节点证明收敛后归档；无法归档时必须说明机器原因，不静默。

## 修正后的通用合同

1. 候选按 workflow phase role 与 issue lineage 选取，不按 vendor 选取。
2. 「节点还在不在」统一读取 vendor-neutral 的 tmux window/process probe；Bridge 自己会刷新 `sessions.heartbeat_at`，所以该字段不能作为 runner-authored 活性证据，本路径不再使用。
3. 强拆只复用 tmux 原生 `kill-window` 与既有 strict cleanup：每个 destructive boundary 都验证 `@flywheel_exec_id` 与 land authority。禁止按继承的 `FLYWHEEL_EXEC_ID` 扫描并杀整个 host process group——Runner 启动的 IDE 等脱离应用也会继承该变量，误杀不可接受。
4. 结构化原因使用 `window_identity_mismatch` / `window_cleanup_failed` / `authority_lost` 等有界 token，founder 文案只解释节点状态。
5. kill switch 仍是 default-on 的 shipped-husk escalation 开关，但其实现和验证必须 vendor-neutral。

## Code review R2 安全修正

R2 在真机找到一个带 runner execution 环境变量的 Cursor process-group leader；旧实现会把整个 IDE 进程组 SIGTERM/SIGKILL。按 Ponytail ladder，最小且更安全的修复不是继续为 `ps` census 加分类器，而是删除这套新造的 execution-wide reaper，直接使用平台已有的 strict tmux cleanup。它已经能证明窗口属于目标 execution，并复用既有的、按 pane descendant 且有 classifier 的 MCP 清理。

跨 land claim 的 open force intent 也不再假装「窗口没了 = 所有进程已证明 absent」；重放只补 `aborted(window_gone_after_force_intent)` 审计终态，不写成功收据。新的 eligible pass 重新生成 intent，成功只由 strict window cleanup 的 `physicalGone` 结果落收据。

这次修正与长期红线一致：General 不写死，不为当前事故的 vendor 造永久分支。
