# FLY-2555 Codex 终态缺席判定 — 实施计划
Issue: FLY-2555 (https://linear.app/geoforge3d/issue/FLY-2555/巡检假报修-codex-设计死体的-commdb-行带-parked-声明-窗口不解析时-reconcile-只-veto)
日期: 2026-09-14
基于: research.md

状态：R4 APPROVED（gate 46b8d1e4-59d4-44fe-87da-5894c447d24b；修复 R3 HIGH harvest-kill-bypasses-inprocess-owner，替代此前版本）。权威裁定：Lead gate 5892368a-4513-4ee0-aad9-5657c3fd8556。零证据 fallback 完全取消，不修改 executionAbsence 对 unknown 的判定。

## 问题与目标

目标 412485c1-93e3-4bbf-b228-b12410649347 为 StateStore completed 的 Codex design：tmux @2877 已消失，但 2026-09-14T18:07:09.486Z daemon evidence = unknown/valid_group/socketLive=true/spawnLock=live。reconcile veto 正确；需要关闭泄漏 daemon 后由后续 reconcile 清理。Lead 已更新 FLY-2555；Implement 已完成 FLY-2537 描述修订，见 verification.md 和更新回执。

只读生产样本 9 running 行（含目标，所以对照为另外 8 行，而不是额外 9 行），9 FSM、2 声明，时间 18:05:34.880807Z。Lead host probe 18:08:31Z 给出 executionId argv 无匹配；该结果不覆盖哈希 socket argv，不能替代 daemon ownership。Runner pgrep rc3，不宣称真实无进程。

## 实施方案

1. RED 测试先行：用真实临时 CommDB，目标终态、parked、注册窗口 dead、marker missing、live daemon；旧 reconcile 只保留且从不请求关闭。新要求为 first pass 调既有关闭 seam、保留行；模拟适配器关闭完成后，second pass 真正 absence 才删除；同批其他 exec 集合严格不变。生产 tuple replay 单独标明 ownership/host 注入来自 Lead 或受控测试；不调用真实目标的关闭动作。
2. 新增 opt-in reconcile harvest hook，默认不启用。生产只在 residueHarvester 的 full pass 接入；legacy boot fallback 无关闭副作用。审查澄清：生产 residue-aware boot sweep 本身会运行 full pass，因此也启用相同保护条件下的 harvest，不能声称全部 boot 都无关闭副作用。候选仅同 execution 的 codex-tmux 且 StateStore completed/failed/terminated，注册窗口已 proven dead、execution marker missing、daemon 详细 evidence 有 valid_group/live socket。spawnLock 仅记证据，不以 live 作为候选要求，允许部署后 stale lock 的真实孤儿。最高优先级要求 Bridge 内 !codexExecutionOwners.isExecutionOwned(execId) 且 store.getResidentHold(execId) 不为 resident/woken；缺少这两个可用的权威查询或抛错一律保留，零信号。非终态、Claude、blocked、窗口/marker 存在或未知、证据抛错均保留且零关闭调用。
3. 使用既有 close-runner 的 daemon teardown seam `reapCodexDaemonForSession` → `reapCodexDaemonForExecution`，不新建进程管理器。该 reaper 当前有 SIGTERM 超时升级 SIGKILL，因此新增显式 gracefulOnly 选项（默认 false，既有调用不变），此 harvest 必须设 true：只 SIGTERM；超时返回 residual，不 SIGKILL。不用整个 closeRunner，因为它会在同次调用删除 CommDB；本任务要求后续 reconcile 才清理。新的关闭策略只复用 daemon teardown 部分，不绕过其 socket-holder-to-persisted-PGID 所有权验证；证据 unknown 无法证实 ownership 时 reaper 返回 unverifiable，不信任 PGID 直接发信号。
4. 关闭前重读 StateStore/session 身份、CommDB exact tmux target/TURN、marker 与 daemon 证据、进程内 owner 与 residentHold，防止异步探测期间复活/换窗口/接 TURN。保持 no-turn、target_changed 的既有 finalizer guard；不持数据库事务等待进程退出。增加既有 reaper 的可选同步 beforeSignal guard（默认不改变其他调用），在每次异步 ownership 检查完成后、实际 SIGTERM 之前同步复查 owner/residentHold/session/target/TURN，避免早先 helper 检查与 reaper 内 await 的间隙误杀；拒绝返回 unverifiable，不重试发信号。按同 exec 串行并使用当前 harvester cadence，不新增定时器/并发管理器。关闭尝试后本轮总是保留 CommDB；residual/unverifiable/error 也保留，记录现有 teardown 失败事件与含 exec/status/window/evidence/outcome 的日志。
5. 下一次 reconcile 仍需真实 absence，绝不以关闭调用成功替代 proof。completed/terminated 沿用原 parked override；failed 仅 harvest 路径可获 Codex-only absence override，legacy boot keptPreserve，Claude/blocked 不变。不修改 RECONCILE_DELETABLE_STATES 全局语义。FLY-1319 conservative 分支保持原字节，原 FLY-2498 unknown veto 不变。
6. 测试矩阵：正常两 pass；失败/拒绝/超时/异常均不删；gracefulOnly 超时仅 SIGTERM 无 SIGKILL；默认 reaper 升级行为原样；non-terminal live daemon 零调用；owned 的 completed/parked/window-dead 零调用；resident/woken hold 零调用；owner 在最后一次 await 后取得也零信号；Claude 零调用；failed harvest 与 boot 差异；状态/target/TURN race；marker renamed/unknown；unknown ownership 不发信号；socket absence 无误操作；其它 running 行不变。现有 commdb-fsm-reconcile、FLY-2498、FLY-1319 与 daemon teardown 测试保持。
7. QA C1 修订：生产行 fixture + daemon-evidence replay 的 RED 为保留且 socket live；GREEN 为既有 adapter teardown seam 被调用并受控结束后下一 pass prune。Lead 的宿主证据须 provenance 标签，不把合成关闭或注入 ownership 宣称生产 live closure。C2 非终态 live daemon 不受影响。C3 修后 fixture patrol STEP 1；其他 8 对照行计数准确。QA hosted ship-report 200 与实际生产闭环由 QA/ship 验证，不在实现阶段越权执行。
8. 门禁 pnpm lint、pnpm -r build、pnpm test:packages:run 及新增 shell tests；injected code review 有效 APPROVED；最后 milestone commit 后建 PR，精确头 CI 绿。报告全部边界，complete --route needs_review --pr NUMBER；不调度 QA、不 merge/deploy/restart，不直接对生产目标执行关闭。

无 schema migration、新 StateStore reader 仅现有 session 字段，不新增持久消费者；复用已有 teardown audit 事件。回滚 revert 本单提交，既有 opt-in 默认关闭与旧 reaper 行为恢复。


## R3 审查后的目标身份核实

目标 live socket 仅证明不可当作死体，并不单独证明它是无主泄漏。Bridge 内 adapter 可能仍持有执行 lease；直接杀 owned daemon 会触发 transport death 重启和账号轮换。本计划绝不信号 owned/resident/woken 执行。gate 7b6ff36e-c92d-4a9f-8d95-57393dd80ce1 已请求 Lead 提供 Bridge 上下文的 isExecutionOwned、getResidentHold 与 host daemon evidence。若实际 target owned，则本 harvest 不得收割它，须由 Lead 纠正为窗口恢复任务；在该事实确定之前不能声称原目标 C1 已完成。

保留选择 close-runner 的现有 daemon teardown seam，因为本任务要求 graceful-only + 后续 reconcile 清理；不扩展 FLY-2169 的全局 orphan 枚举/信号规则。其最高优先级 in-process ownership veto 在本路径同样强制执行。
