# FLY-2517 换体后旧唤醒退役 — 实施验证
Issue: FLY-2517 (https://linear.app/geoforge3d/issue/FLY-2517/病根-引擎-proven-dead-replacement-换体后仍向旧体投-phase-wakerework-wake20-分钟后判)
日期: 2026-09-11
基于: plan.md

## 实现与证据

实现严格的 rework wake 四元组解析、StateStore 换体事务内 retirement proof/outbox、CommDB 幂等退役 tombstone、投影身份缓存、watch/hold 最终事务防线、有界历史回填、原子 start claim、受限 cancel，以及 FLY-2518 failed 操作终结和 completed replacement reroute no-op。没有修改批准计划。

| 计划验证 | 可执行证据 |
|---|---|
| T1 原事故顺序 | fly2504-rework-replacement-receipt.test.ts 的 FLY-2517 incident order：真实 materialize、launch content receipt、enrolled completion；旧父/phase wake；+21min 两轮 projector/watch/operations；run active、父 cancelled、源 finished 且无 started 时钟；下一 QA activation 为 current；credential-backed QA PASS accepted。该测试调用真实 StateStore 决策提交，HTTP 决策入口另由 workflow-decision-routes.test.ts 覆盖。 |
| T2/T15 替身未完成与真正失联 | fly2517 retirement projection/hold 测试保留 replacement_pending；fly2504 的内容未送达/缺回执拒绝；fly2278-undeliverable-hold 的真实失联保护。 |
| T3 多代与 writer convergence | fly2504 的 generic writer convergence：同 request A→B materialize，B→C generic rollback/converge；两份不同 retirementId，历史 A 证明仍可解析。 |
| T4 事务回滚 | fly2517 的 retirement insert failure 回滚 route/actor/dispatch；fly2278-hold-cancel 的失败事件事务回滚。 |
| T5/T14 重启与迁移 | fly2517 disk restart：State commit、Comm apply、projected 三边界各重开两次；legacy schema upgrade 重建缺少新表/列的旧库并重开两次，回填一次；坏 receipt 与正常 receipt 分页 limit=1，游标推进且诊断去重。 |
| T6/T7 迟到、真实时钟与 start race | Comm db.fly2517：同/新 physical ID disposed、父 acked 时钟保留、started→retire 时钟保留；Codex lifecycle observe→retire→claim；daemon disposed/missing 不调用 turn/start、不恢复预算、不解除 hold。 |
| T8 投影/hold 窗口 | fly2517：mint 前后 retirement、parent hydration、watch 历史义务、直接 hold writer；缓存 refresh 不丢身份，换 recipient 的 child 不被错误退役。 |
| T9/T10 否定与兼容 | 严格 metadata 无效值表、错 tuple/run/physical identity、损坏 metadata 不饿死下一行；Comm db.fly1774/db.fly2268/receipt-wake-state-machine 及正常 wake replay 保留原行为。 |
| T11–T13 历史 hold | exact retired live/settled/pruned source resolver；master HTTP stage+confirm+resume+replay，scoped token 401；新 hold 保持 held，terminal 不复活，错 physical/run 拒绝；普通 phase cancel 仍由 fly2278-hold-cancel 拒绝。 |
| T16 失败自锁 | fly2278-hold-cancel/comm-reroute-flow：rejected/operator-required manual operation failed、唯一失败事件、新 client request 可继续；不关闭原 hold。 |
| T17/T18 完成目标 no-op | fly2517：完整 binding/route/launch/completion proof，新请求及旧 staged 请求；closed episode 可恢复；无 child/transport/revision，唯一 noop receipt；缺 launch/completion、错 target、stage 后 route 变化拒绝。物理 reroute 既有记录排除 no-op；fly2278-comm-reroute-flow 的 staged/applied crash recovery 保持。 |

## 消费者检查

实际非测试调用：Codex phase lifecycle 调用 claimRunnerPhaseWakeStart 并把四值结果交给 daemon；daemon 显式处理 started/replay/disposed/missing。旧 boolean markRunnerPhaseWakeStarted 保留兼容包装。Claude T1/T2 SQL 排除 retirement_id，退役同时清 claim。plugin resident receiver 的 enqueueRunnerReceiverDelivery 返回值使用 kind != no_consumer，因此 disposed 被确认而不重发。投影显式 SELECT 包含 retirement_id。两个新表都已纳入 protected retention 分类与 schema fixture/count。

## 验证结果

- pnpm lint：PASS，15 个 warning，0 error。StateStore 大文件沿用仓库现有 Biome 大小限制；完整 TypeScript build 检查该文件。
- pnpm -r build：PASS。
- plan.md 列出的 11 个 TeamLead focused test files：217 PASS、1 SKIP；随后加强的多代用例所在完整文件 33 PASS。
- Comm：db.fly2517、db.fly1774、db.fly2268、db.fly2248-delivery-reroute、receipt-wake-state-machine 共 90 PASS。
- Codex lifecycle/daemon 两个文件：92 PASS。
- 没有新增 scripts/__tests__ 测试文件。
- Lead [lead-instruction e976ce4c-e109-4fa2-af6a-27a9730ab0a9] 指定主机仅 focused tests + lint/build，完整 package suites 由 exact-head CI 执行；因此未在主机运行 pnpm test:packages:run。

以上是本地实现证据。code review、最终 PR exact-head CI 与 implement completion receipt 仍待工作流独立确认；不把本地 focused green 等同于这些门已通过。未执行生产数据库修复、merge、部署或服务重启。

## 首次 PR CI 与契约清单修正

PR #1168 的 R1 effective/raw review 均 APPROVED，reviewedHeadSha=4321dc5d7bfd9e2b807bfcafefa912adce835da8。七项 MEDIUM/LOW 建议已报告 Lead，按冻结范围未修改。

Exact-head CI run 34651344968 的 TeamLead shard 3 失败：新增 backfill 的 sync marker 未纳入 child-process-census.json（9→10），维护管线契约仍要求三个 drain（现为四个）。本地重现两失败后，更新该清单及测试，并增加 baseline < backfill < projector < watch 的顺序断言；10/10 聚焦验证通过。该 shard 另有 Vitest onTaskUpdate RPC timeout；它未被本地聚焦结果消除，需下一 exact-head CI 重新证明。

本次修正不改变引擎行为，不处理 R1 advisories。完整 CI 结果及新的 R2 reviewedHeadSha 由工作流回执确认。
