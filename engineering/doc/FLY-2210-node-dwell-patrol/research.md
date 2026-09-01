# FLY-2210 节点停留巡检 — 调研
Issue: FLY-2210 (https://linear.app/geoforge3d/issue/FLY-2210/巡检舰队规范-3小时节点停留规则超阈强制-deep-dive勾销台账重置计时等-founder-提醒founder-拍板-v2-设计)
日期: 2026-08-31
基于: exploration.md

## 现有实现落点

- `packages/teamlead/src/StateStore.ts` 的 `migrateWorkflowClaimsLedger()` 已创建 `workflow_run` 与 `workflow_run_node`，适合在同一幂等迁移入口创建新收据表。
- `scripts/lead-patrol-snapshot.sh` 是生产 `flywheel-patrol-snapshot` 的目标；它已只读 attach StateStore 与 CommDB、解析 project/Lead owner scope，并原子发布报告骨架。
- 快照现有 STEP 3/4 使用 `OWNER_ATTRIBUTION_CTES` 将 execution、当前 issue cohort、最近历史 cohort 收敛到唯一 Lead。停留表必须复用同一归属规则，不能扩大到别的 Lead pane 或 issue。
- CommDB 的 `mailbox_message_projection` 用 `parent_id` 表示 response 子消息；开放 gate 的权威形状还排除 `terminal_disposed` 与 `superseded_at`。
- `packages/config/src/feature-flags/registry.ts`、`store-policy.ts` 与 Bridge flag routes 管理 `flag_values`。新阈值若不登记，Bridge 启动时会把该 identity 判为非法；因此它必须成为严格校验的 project-scoped scalar value。现有机械门只允许 project boolean：实现必须窄化扩展 authoring policy、增加 `readScopedValue`、把 exact-reader drift guard 加上这一种 reader，并提供 snapshot 实际调用的 TS consumer；不能直接删掉 boolean 限制。consumer 只通过 `StateStore.openForMaintenance(...,{readonly:true})` 进入 runtime wrapper，严禁每 tick `StateStore.create()` 跑全迁移/WAL checkpoint，也不另写 direct SQL 旁路 wrapper。
- `packages/teamlead/lead-rules-base/runner-patrol-rules.md` 与测试固定了六个数字 STEP。为避免旧读取器整体重编号和污染 STEP 2 extractor，新段采用 `STEP DWELL`，放在 STEP 6 后；完成门额外要求该段定稿，同时 FLY-2080 finding validator 必须接受且只接受 `step=DWELL` 这一新增 accountability key，保留数字 STEP 1–6。

## 数据与时间判定

新表采用 founder v2 的逐列 DDL，不加会改变写入语义的额外外键。快照用 SQLite UTC 时间计算：

```text
baseline = max(unixepoch(workflow_run_node.started_at),
               unixepoch(max(node_dwell_review.examined_at)))
dwell_seconds = unixepoch(now) - baseline
over_threshold = dwell_seconds >= threshold_hours * 3600
```

时间不可解析、flag 值非法或 schema 缺失时，`STEP DWELL` 必须 `UNAVAILABLE(...)`，不能静默当健康。单个 node owner 不可唯一归属时只把该 node 标为 unavailable，不能压掉其他可归属 node。报告对每个名下在场节点输出 `NODE_DWELL` 行，并对超阈行给出 `route=deep_dive|founder_reminder`，同时形成可扫描的超阈名单。

未答 `approve_to_ship` 不能按 projection 中不存在的 `issue_id` 猜关联。首选每个 gate 都有的 StateStore `workflow_gate_holder.run_id -> question_id` 且 holder `state='awaiting_review'`，再与 CommDB question 精确绑定；只有切换前历史行缺 holder 才接受 `question.from_agent -> comm.sessions.execution_id -> issue_id` 的唯一映射。`workflow_ship_target_binding` 对 `engine_terminal` run 合法缺失，不能作 primary。缺失或歧义必须 fail closed 为 unavailable，不能误走 deep dive。

## 收据写入

默认 snapshot 路径保持只读；显式 receipt 模式才写 `node_dwell_review`。shell 只做前端，真正的 threshold reader / receipt writer 位于 `packages/teamlead/src/node-dwell-control.ts`：readonly 路径用 `StateStore.openForMaintenance(...,{readonly:true})` 调 scoped runtime wrapper，write 路径用 `better-sqlite3` 参数绑定、5s busy timeout 与事务，禁止使用 sqlite3 CLI `.param`。committed mode `100755` 且大于 script-sanity 1024-byte floor 的 `scripts/flywheel-node-dwell-control` wrapper 用自身 realpath 找 trusted checkout 的 built CLI；converge 把 wrapper（不是 gitignored dist）作为 strict symlink 安装在 snapshot 同一 bin，snapshot 不做 repo-relative猜测或 exec-path env override。写模式要求 `FLYWHEEL_LEAD_ID` 与参数相同，并验证已登记 project、active run、仍在场的精确 node/attempt、合法 verdict 与 CommDB owner；同 UID 可伪造 env 是明确接受的单机 trust-domain 风险，env 不是强认证。

同 issue 的合并提醒用一个 JSON batch 写所有 covered node。`cycle_no` 在一个 `BEGIN IMMEDIATE` 中逐节点取 `max+1`，任一项失败则全批 rollback；`examined_at` 由数据库生成，避免调用者倒填时钟或造成部分去重。BUSY 必须 non-zero 且有稳定错误 token。

规则要求 Lead 在 deep dive 得到结论后写 `normal|cleared|fixed`；founder 提醒实际投递后写 `waiting_founder`。写收据前不抑制提醒，写后由同一 baseline 公式自动去重三小时。

## 测试面

- StateStore：表结构、四值 CHECK、复合 PK、重开幂等、失败写 rollback。
- flag store：默认 3、合法正数、非法/零/非有限值拒绝、project 覆盖优先于 `*`。
- shell 回归：4h 节点、收据立即重置及 3h 再报、founder gate 与未答 `approve_to_ship` 分支、合并提醒 N 节点/N 收据、跨 Lead/跨 project 隔离、非法输入与 BUSY 负向守卫。
- 规则合同：新 STEP、deep dive 内容判定、FLY-2178 原文、thread 合并与三小时去重、receipt 命令，以及 `STEP DWELL: FINDING` 必须有合法 `FINDING step=DWELL` accountability 行。
