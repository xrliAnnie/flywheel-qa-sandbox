# FLY-1462 独立 QA 证据 — 死亡演练 + d261eddb 重验
Issue: FLY-1462 (https://linear.app/geoforge3d/issue/FLY-1462)
日期: 2026-07-24
基于: plan.md / research.md（同文件夹）+ Annie 直令的真机死亡演练

## 候选 head 变更（关键）
Annie 直令的死亡演练指定 head=6f382d7d。执行中部署 slot Bridge 时,从 bridge-boot 日志
抓到运行 HEAD=**d261eddb**——实现者在 **Codex code-review R1** 后推的加固版
「fix(FLY-1462): require process-remnant proof + recover replacement_pending (Codex R1)」,
worktree 与 origin/flywheel-FLY-1462 均已是 d261eddb。**故对 d261eddb 重新验证**
(早先 qa-result PASS 是对 6f382d7d,对 d261eddb 不成立)。

## d261eddb 相对 6f382d7d 的实质变化
`terminal_status_dead` replace 从三证升级为**四证**:新增第 4 证 process-remnant 探测
(`phase-actor-remnant.ts`)。exec-marker sweep 报窗口 `missing` 不再足够,必须
`probeActorProcessRemnant` 返回 `none` 才 replace——理由:marker 发布是 best-effort、
**resident codex daemon 会比它的 TUI 窗口活得久**,窗口没了≠进程死了(Codex R1 HIGH-1)。
- claude-tmux:`deriveRunnerMailboxIdentity` 派生 needle → 扫真 `ps -axww` argv(found/none)
- codex-tmux:读 `session.json` daemonPid → 真 `process.kill(pid,0)`(found/none;state 缺失=indeterminate)
- 未知/no-transport adapter → indeterminate；每条失败路径 fail-closed 到 hold

## 证据(全部对 d261eddb 真代码,真基建)
| 项 | 结果 |
|---|---|
| module-driven 真基建 harness(`packages/teamlead/qa-fly1462-reentry-realinfra.mjs`) | **25/25 ✓** |
| —— 真 tmux server(建/删 @flywheel_exec_id 窗口):missing/found/ambiguous | ✓ |
| —— 真 CommDB:gone→absent / corrupt→indeterminate(实报 file is not a database) | ✓ |
| —— **真 ps** claude-tmux remnant:needle 进程 alive→found / 杀掉→none | ✓ |
| —— **真 process.kill** codex-tmux remnant:活 pid→found / 死 pid ESRCH→none / 无 state→indeterminate | ✓ |
| —— 全四证矩阵:6 终态+missing+remnant none→replace terminal_status_dead | ✓ |
| —— **R1 新保护:marker missing 但 remnant FOUND→仍 hold**(护 codex daemon) | ✓ |
| —— marker found 短路不查 remnant / running·completed→hold / CommDB-error→hold / 未接线→fail-closed hold | ✓ |
| FLY-1462 单测 113:remnant 12(新)+ probe 3 + rework-coordinator 34 + workflow-engine-dispatcher 64 | ✓ |
| tsc build | 干净 ✓ |
| biome lint(7 改动文件) | 干净 ✓ |
| live slot-3 Bridge(port 19873)跑 d261eddb（bridge-boot HEAD 确认） | ✓ |

### run-dispatcher 套件 9 失败 = pre-existing flake（非回归）
`run-dispatcher.ts` 及其测文件对 origin/main **字节不变**,FLY-1462 全 scope 不含它 →
同码同测同机=同结果。失败项均为 FLY-751 MCP-profile / FLY-142 Agent-Team-identity /
FLY-1188 vendor wiring(与本 fix 无关的环境态 flake，见 reference_teamlead_full_suite_preexisting_machine_state_flakes）。

## Layer-2（live-Bridge seeded rework）— 环境阻塞
在真 Bridge 里 seed 一个 rework 观察真 materialize 替换需 stop→sqlite insert→start
(sql.js 覆盖运行中外部写),而 FLY-913 部署护栏拦手动 stop/start。materialize+接管那段是
FLY-1462 **没改**的旧 plumbing,已由 coordinator/engine-dispatcher 单测 e2e 证
(reconcile→replacement_pending→materialize)。故 live-Bridge 端到端 seed 演示留待
sanctioned seed 通道；决策级+真基建能力级证据已到位。

## 诚实边界
- 未在生产 Bridge 重放 FLY-1150 真实卡死态(生产事故态,QA 不改生产)。
- Layer-2 live-Bridge seeded materialize 未跑(FLY-913 seed-surgery 阻塞)。
- 死亡演练全程用独立 tmux server / 独立 slot / 隔离 delivery-secret,未碰生产、未碰他人 slot。
- qa-result 已消费在 6f382d7d;d261eddb verdict 走给 Tadashi 的重验报告(他定 ship-gate)。
- 遗留:slot-3 Bridge PID 58573 跑 d261eddb,FLY-913 拦手动 teardown → cmux lease 空后运维正规收。
