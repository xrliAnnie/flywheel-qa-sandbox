# FLY-1757 铸卡前确认 head 已在 origin — 探索
Issue: FLY-1757 (https://linear.app/geoforge3d/issue/FLY-1757/ship卡残刀-铸卡前head-已在-origin断言a4重复卡病已修好留证关闭原1818范围承接于此)
日期: 2026-08-21
基于: 无

## 1. 要解决的唯一残口

ship 卡把某个 `head_sha` 呈给 founder，并要求她只批准这个 exact head。当前 gate entry 会冻结 head、PR 与 repository binding，`gate-materializer.ts` 也会保证同一个 holder 的投卡 effect 收敛；但 materializer 真正创建 Discord POST intent 前，没有 fresh 证明这个 head 此刻已经由 `origin` 的 branch ref 广告。

因此本单只补 A4：**每一次新的 ship-card POST intent 之前，fresh 断言冻结 head 仍是该 gate 所绑定 PR 的 GitHub `headRefOid`；无法证明就不铸卡。**

## 2. 已有修复留证，不重复施工

- PR #869（commit `92adf6597`）已经把 holder-backed ship gate 的唯一投手收敛到 materializer，并用 durable POST intent + fail-closed reconciliation 修掉 2xx-without-id 重投；`gate-materializer.test.ts` 的 “converges a deterministic question and one current founder card” 对同一 holder 调用两次，断言只 POST 一次。
- PR #846（commit `7267ff3fe`）已经实现 founder 打回后的 card lifecycle：旧卡 supersede/void，新 head 允许产生新卡；`StateStore.founder-kickback-newcard-loop.test.ts` 覆盖 card A → 新 head → card B，且只有 B 能批准。
- PR #869 同时修了合入后 thread 被尾部消息重新打开的问题。它不是本单 A4 的缺口，本单不再扩张 lifecycle 或存量清账。

## 3. 假设与边界

1. “head 已在 origin”指 trusted `probe_repo_slug + pr_number` 指向的 GitHub PR，其 fresh `headRefOid` 与冻结 head 完全相等；本地 object、任意其它 remote branch、tag 或“该 commit 只是远端 tip 的祖先”都不够。
2. 断言只挡**新的 POST**。如果先前 POST 结果 ambiguous，系统必须继续既有 reconciliation；此时重复做 origin preflight 会让已发生的 Discord effect 无法收敛。
3. 断言范围与 ship-target binding 的产生条件同源：`authority_mode IN ('land','runner_ship')` 必须断言；`engine_terminal` 不适用。legacy `authority_mode IS NULL` 只有已有 ship-target binding 时才断言，否则维持既有兼容行为。
4. origin 不可读与 head 不在 origin 都 fail closed；沿用现有 materialization stuck 的 severe 通道，不新增报警器。

## 4. Ponytail 决策梯

1. 不能跳过：这是标题点名的 A4，且当前代码没有 fresh origin 证明。
2. 不需要新库或新 Git 原语：`workflow-decision-routes.ts` 已有 bounded `probeWorkflowPr()`，并已在 Bridge gate-entry 路径使用同一 `gh` 认证环境。
3. 复用现有 GitHub PR probe，避免读取 runner 可写的 worktree Git config；remote repo slug、PR number 与 frozen head 全来自耐久 binding。
4. 不加 dependency、schema、daemon、sweeper 或泛化 remote-authority 框架。
5. materializer 只增加一个 preflight callback 和一个精确调用条件；生产 callback 抽成小模块并独立测试。

## 5. 发生率与收益

issue 给出的实发事故是重复卡，不是 A4 本身；当前材料没有可审计的 A4 生产命中次数，因此发生率记为**未知，不能写成已实发**。本单是重复卡修完后留下的 fail-closed authority 残口。成本是每张新 ship 卡多一次现有 `gh pr view`（15 秒硬超时）；不是每 tick 都调用，pending/ambiguous reconciliation 不调用。

## 6. 明确不做

- 不限制一个 gate 生命周期只能有一张卡；换 head 后的新卡仍是必要行为。
- 不为未绑定卡 reaction 增加回执。
- 不重做 #869 的去重/reconciliation，不改变 card void、打回路由或 thread archive。
- 不做 21 张历史卡的一次性运维清账；当前 implement 节点只交付 A4 代码与证据。

## 7. 会过期的结论

| 结论 | as-of | 何时会过期 | 重核命令 |
|---|---|---|---|
| 新 card POST 前没有 fresh exact-PR probe | `origin/main` @ `d97bd1173` | `gate-materializer.ts` 或 plugin materialization loop 改动后 | `rg -n "probeWorkflowPr|postCard|claimWorkflowGateCardPostIntent" packages/teamlead/src/bridge/gate-materializer.ts packages/teamlead/src/bridge/plugin.ts packages/teamlead/src/bridge/workflow-decision-routes.ts` |
| #869 已保证同 holder effect-level exact-one | `origin/main` @ `d97bd1173` | materializer intent/reconciliation 或 GatePoller owner 规则改动后 | `git show --stat 92adf6597 && pnpm --filter flywheel-teamlead test:run -- src/bridge/__tests__/gate-materializer.test.ts` |
| 新 head 打回路径会 supersede 旧卡并产生新卡 | `origin/main` @ `d97bd1173` | gate holder PK/current index 或 rework route 改动后 | `pnpm --filter flywheel-teamlead test:run -- src/__tests__/StateStore.founder-kickback-newcard-loop.test.ts` |
