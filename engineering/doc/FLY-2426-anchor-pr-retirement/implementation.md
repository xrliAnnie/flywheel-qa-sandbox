# FLY-2426 主仓锚 PR 误退休 — 实施证据
Issue: FLY-2426 (https://linear.app/geoforge3d/issue/FLY-2426/批准通路2394-founder-的两条批准通路对同一张卡全部失效-reaction-挂-13-小时reply-to)
日期: 2026-09-07
基于: plan.md

## 实施范围

- 生产代码只改 `packages/teamlead/src/bridge/terminal-gate-retirement.ts`。
- `approve_to_ship` 的 `superseded_merged` 在 current workflow holder 存在时，必须匹配 active/current run、`land|runner_ship` authority、未 supersede 的 `__main__` ship target、current exact-head node binding 和同一 PR number。
- `founder_review` 不接受 PR merge 作为 artifact-review authority；`retireIssueDone` 行为不变。
- 没有 current holder 的 legacy ship gate 保留原行为。
- 未改 `StateStore.ts`、`plugin.ts`、approval/claim/authority ledger、`pr_head_sha`、Runner 终局、merge/deploy，也未补写 founder approval。

Design review 通过后，Lead 在 report response `0d5b884e-b69c-4ed8-a5c2-d15816fed64f` 撤回了防御性的 fresh-`mergedAt` 切片：`#25/#27` 本来就有合法 `mergedAt`，它不是根因，也挡不住错号。pinned `plan.md` 保持不改；本记录、PR 与 milestone 以该后续 ruling 为准。parked-finalization 的同号残余由 Lead 归入 FLY-2428，本单只在 PR 披露，不建票、不修改。

## TDD 证据

### 主仓 anchor 硬红 → 绿

新增 FLY-2394 生产形状：current ship gate anchor 为 flywheel `#1103`，external candidate 为历史嵌套 PR number `#25`，且旧 revalidation 返回 authorized。

- 红：旧代码实际把 question 从 `open` 写成 `terminal_disposed`，`resolved_via=superseded_merged`；focused 结果 `1 failed / 6 passed`。
- 绿：增加 question-local main-anchor guard 后，focused 结果 `7 passed`；wrong candidate 不调用 revalidation。

### founder-review 四态硬红 → 绿

同一个 merged candidate 对 founder-review question 参数化 `workflow_run.status` 为 `active / held / completed / terminated`。

- 红：旧 merged-retirement 对四态全部写 `terminal_disposed`；focused 结果 `4 failed / 7 passed`。
- 绿：merged reason 对 founder-review 无条件 skip；focused 结果 `11 passed`。
- 既有 `retireIssueDone` founder-review 正例同轮保持通过。

### 正向与 fail-closed 对照

- current `land` gate 的 exact anchor `#1103` 仍以 `superseded_merged` 退休。
- current `engine_terminal` 与 legacy-null holder 没有 PR authority 时保持 open，且不调用 revalidation。
- 无 current holder 的 FLY-1687 形状 legacy ship gate 仍退休。
- public external-reconciler `pass()` 使用历史 `#25` probe 接入真实 `TerminalGateRetirement`，question 保持 open。
- 两个 focused 文件：`48 passed`；TeamLead typecheck：通过。

## 旧逻辑变异证明

只在未提交工作树临时旁路新 ship-anchor comparison，再运行名称含 `FLY-2394-shaped` 的两个 production-call-site 回归：

- terminal retirement：红，expected `open`，received `terminal_disposed`；
- public external reconciler：红，expected 1 次 probe，received 2 次（第二次是旧错误 revalidate）。

恢复 guard 后同一命令为 `2 passed / 46 skipped`。临时变异未提交，工作树无残留。

## 生产副本回放

对 WAL-consistent 的 `teamlead.db` / `comm.db` 副本运行当前实现；只在二级回放副本中把两张事故 question 恢复为 open，并从 archive 事实重建两张 legacy ship question。revalidation 对正例使用 live `gh pr view`，坏例在 anchor guard 前即被拒绝。

| 集合 | 旧逻辑 | 修复逻辑 | 结果 |
| --- | ---: | ---: | --- |
| FLY-2394 `#25`、FLY-2381 `#27` 错号 candidate | 2 张退休 | 0 张退休 | 两张均保持 `open`；revalidation probe 次数 0 |
| FLY-1687 `#827`、FLY-1679 `#801` 正确 legacy main merge | 2 张退休 | 2 张退休 | 两张均为 `terminal_disposed / superseded_merged`；各 fresh probe 1 次 |

fresh GitHub 事实：flywheel `#1103/#1109/#1106` 均 OPEN；正确 legacy `#827/#801` 均 MERGED。

CommDB `resolved_via='superseded_merged'` checkpoint 分区：current mailbox 2 条、archive 2 条，**四条全部是 `approve_to_ship`，`founder_review=0`**。因此 FLY-1687/1679 的 `2 → 2` 分母确定是 ship gate；本改动历史上停止用 merge-retirement 清理的 founder-review 数为 0，但四态单测仍固定新 authority 规则。

## 全仓验证边界

- `pnpm lint`：退出 0；14 条既有 warning、0 error。
- `pnpm -r build`：当前 HEAD 退出 0（22/23 workspace projects）。
- 新增 `scripts/__tests__/*.test.sh`：无，因此没有额外 shell suite。
- `pnpm test:packages:run`：退出 1；package gate 共显示 TeamLead `11717 passed / 6 skipped / 5 failed`，另有 1 个 worker RPC timeout。隔离单 worker 复跑 4 个失败文件后，3 个并发 timeout/watcher/preflight 失败恢复为绿；只剩 `fly-2006-database-retention-sweep.test.ts` 的表数硬编码稳定红（expected 176，received 177）。
- retention 稳定红与本单无关：`origin/main` 中同一测试仍断言 176，同一分类源码已产生 177；FLY-2426 对该测试、retention 源码和 `StateStore.ts` 的 diff 均为零。本单不扩大范围修主线既有 gate 漂移。
- 本单 focused 行为验证：`terminal-gate-retirement.test.ts` 与 `external-merge-reconcile.test.ts` 合计 `48 passed`。

## 本地审查入口边界

按实现节点合同通过 `codex:rescue` companion 发起了只读、fresh 的
`origin/main...HEAD` 标准/规格双轴审查，没有调用 raw `codex exec`。companion
在读取仓库前被 resident 外层 macOS sandbox 拒绝（status 71，
`sandbox_apply: Operation not permitted`），因此未产生可消费 finding，也不计为
review PASS。最终审查权威由后续 request-driven `review_code` 结构化 verdict 提供。

## 结构化代码审查

request-driven `review_code` R1 在
`f69566298dedd783834cb8b989e349bacbd0a5db` 返回 `APPROVED`，无 HIGH / blocking
finding。它保留 3 条 MEDIUM 与 2 条 LOW advisory：

- legacy / 无 current holder 的 ship gate 仍保留同号碰撞面；
- 同一错号 merge proof 在 parked finalization / TURN reclaim 的残余已交 FLY-2428；
- held run 的真 anchor merge 收敛依赖 FLY-2427 recovery / issue-done；
- merged input 的 unchecked cast 可改为 discriminated union；
- merged retirement 可在查询层不扫描 founder-review。

根据 `medium_low_findings_are_non_blocking_v1` 它们不阻断本轮；完整 finding key
和证据已通过 `ask --report` 回报 Lead。本单不越过已批准边界扩张修复。

## 并行分支碰撞验证

在 R1 审查 head 刷新远端后：

- `origin/main@fb9146878a89ea97dedf5136de8b57b6ec792ddf` 与本分支 merge-tree
  返回合并树 `59edd66f3f4b5a80ab5211b1e147b616b98c93e8`，0 个冲突文件；
- `flywheel-FLY-2427@ba2f58f8f5548c18621d266a41645e98ea2d4f3d` 与本分支
  merge-tree 返回 `7c12105e5d88eda8f6bf32ad06f4c26be136843d`，0 个冲突文件。

交付前 FLY-2427 前进到
`638269971b0c8efcf21f70dd6d05b148fb50b4db`；以本分支最新普通文档 head
重跑后，对 `origin/main@fb9146878a89ea97dedf5136de8b57b6ec792ddf` 产生合并树
`d864d0de677f7369ea19637e931f4c1d71c83100`，对 FLY-2427 产生合并树
`62b9e5b9b08179a43c7660bd9f6571500e7f1ad2`；两者仍均为 0 个冲突文件。
本分支没有合入对方分支。

## 待补收尾

- 创建 PR 与 literal-last milestone；
- 在 literal-last head 上重新注册 exact-head code review，避免用 R1 审查旧 head。
