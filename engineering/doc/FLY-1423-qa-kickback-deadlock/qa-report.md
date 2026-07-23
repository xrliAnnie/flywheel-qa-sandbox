# FLY-1423 QA 踢回锁死修复 — QA 报告
Issue: FLY-1423 (https://linear.app/geoforge3d/issue/FLY-1423/enginebug4-qa-fail-踢回锁死-attempt2-admit-幽灵-exec-terminal-complete-硬)
日期: 2026-07-22
基于: plan.md

## 结论

通过。隔离房中的权威运行完成了 `implement#1 → qa#1 fail → implement#2 → qa#2 pass → founder_gate`。两个重做 attempt 都绑定原有且可探活的真实 actor，不产生幽灵 execution；同内容的 terminal `complete` 重放没有生成重复节点完成；QA retest 自动回到原 QA actor 并推进 founder gate。

本轮同时发现并修复了一个只在真实 Bridge 重启时出现的幂等缺口：TURN 已落 CommDB、StateStore 投影也已落盘，但 mailbox 尚未投递时重启，旧实现会用新的 wall-clock 时间重投不可变记录，造成 `activation_turn_conflict`。修复后重放读取 CommDB 中的持久化 `granted_at`，同一 source/activation 可继续投递。

## 权威隔离运行

- 环境：QA Testing Room slot 1，Bridge `127.0.0.1:19871`，隔离 StateStore `/tmp/flywheel-test-slot-1/teamlead.db`，隔离 CommDB `~/.flywheel/comm/test-slot-1/comm.db`。
- Linear fixture：FLY-1303；workflow run：`a2fbb425-6305-4b90-8a86-c6bb92299e2e`；模板：`tpl_eng_heavy@3`。
- design actor：`dad49b2f-e665-4952-bf0a-debb615d1dfd`，真实 launcher/session 行，实际 adapter `claude-tmux`。
- implement actor：`10f778e9-c48a-4d11-a40a-209c613a364a`，真实 launcher/session 行，实际 adapter `codex-tmux`。
- QA actor：`72c19209-4907-438d-a1cc-24e24896eaf8`，真实 launcher/session 行，实际 adapter `claude-tmux`。
- 被测 revision/head：`e9a75dfed141b5744acd3a86cc9e8063b271465c`。

### 运行结果

1. design#1、implement#1、qa#1 均由真实 dispatcher launch，并在隔离 StateStore 留下 session 行；不是只写 admission。
2. implement#1 的同内容 `complete --route needs_review` 连续提交两次。session 已 terminal 时第二次仍被幂等承认；ledger 只有一条 `implement#1 node_completed` 和一条 implement→QA 边。
3. qa#1 通过 scoped workflow decision 提交 fail，写入 claim `2`，创建 QA-authority rework；implement#2 以 `mode=wake` 绑定同一个已存在且探活成功的 implement execution。
4. implement#2 再次提交相同 completion 两次，ledger 仍只有一条 `implement#2 node_completed`。引擎生成确定性的 QA verification child request，而不是开一个无 session 的新 execution。
5. QA child rework 以 `mode=wake` 绑定原 QA execution。Bridge 在 TURN 已落盘后重启，先复现 `activation_turn_conflict`；应用持久化 grant-time 修复并重启后，delivery 进入 `wake_delivered`，mailbox 中出现同一 activation/epoch 的 phase wake。
6. qa#2 使用当前 activation 的 submission credential 经 `/api/workflow/decision` 提交 pass，写入 claim `3`。最终 `qa#2=done`、child delivery=`completed`、run `current_node_id=founder_gate`，并生成唯一 founder gate。

最终 ledger 计数：design node completion 1；implement node completion 2（attempt 1/2 各 1）；QA outcome 2（fail/pass 各 1）；implement/QA rework request 各 1；implement/QA wake-delivered 各 1；founder gate 1。生产 `teamlead.db` 对上述 run 与三个 execution 的命中均为 0，生产 `comm/flywheel/comm.db` 对三个 execution 的 session 命中为 0。

## 受控限制与排除项

Managed host 会在嵌套 runner shell 启动后拒绝其 sandbox（`sandbox-exec: sandbox_apply: Operation not permitted`），因此本轮不能宣称“三个 agent 都自主跑完”的全自动 E2E。真实 Bridge、dispatcher launch、StateStore、CommDB、admission、TURN、mailbox、rework coordinator、credential 和 decision route 均被执行；runner 侧 completion 使用外部 CLI 驱动，wake liveness 使用隔离 tmux 中的 parked process stand-in。进程级限制不影响本单验证的引擎/交接路径，但已明确保留在报告中。

FLY-124、FLY-136 的早期探路运行全部排除：其中包括旧 `dist` 启动和一次错误的双重 `test-slot-1/test-slot-1` CommDB 根路径。它们不计入通过证据。权威运行修正 CommDB 根、重建当前分支 `dist` 后完成。全局 pinned CLI 产生的一条 legacy `/events` QA pass 也明确标注为“NOT a DAG decision”，未作为通过证据；最终 pass 使用本分支 credential-aware CLI。

## 自动化回归

- `workflow-rework-coordinator.test.ts` 新增真实 CommDB source-replay 测试，证明不同调用时间仍返回同一个持久化 epoch/grant time。
- `workflow-rework.e2e.test.ts` 覆盖真实 StateStore + CommDB：QA fail、同 actor implement rework、确定性 QA retest child、QA pass 和再次 fail 的 verification path。
- lifecycle、capability、route、dispatcher 和 terminal completion 契约测试覆盖 launch rollback、真冲突拒绝及同内容 replay。
- 隔离辅助脚本 `qa-529-rework-e2e.mts` 仅接受 `/tmp/flywheel-test-slot-*` 数据库，并通过公开 credential rotation/decision primitive 驱动 managed-host recovery 场景；不读取或写入生产数据库。

隔离房已执行 `scripts/test-teardown.sh 1` 并释放；仅出现 host `~/.claude.json.lock` 的 trust-prune 超时警告，teardown 明确保持该全局文件不变，slot worktree、临时目录和隔离 CommDB 均已清理。
