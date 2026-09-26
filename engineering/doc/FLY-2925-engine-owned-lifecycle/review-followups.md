# FLY-2925 引擎统一体生命周期 — 调研
Issue: FLY-2925 (https://linear.app/geoforge3d/issue/FLY-2925/病根修复-7-codex-体生死只认引擎一侧goal-结束不等于死引擎终结后-goal-不得自续重启只按原会话续接6-张-43)
日期: 2026-09-26
基于: plan.md

## 获批身份

R3 有效 reviewVerdict=APPROVED，reviewerVerdict=APPROVED，request `b797be09-535e-4a2e-9635-f95e99a0035c`，question `475e1488-63cf-4948-bb03-87b325b0b7f9`。引擎 design_review_approval_proof.state=approved，当前 plan blob `989780531149c2bd73c37bb3da1fe1a08ba60e62` 与批准一致。获批 plan 字节不再修改，原“待评审”状态为提交时历史；正式结论以 evidence/review-approved.json 的持久凭证为准。

## 非阻塞设计建议 → 实施必须验收项（未声称已修复）

### steady-state-rollback-forward-compat

R2 的 HIGH（pinned-snapshot-cross-version-contracts）已由 §4.5 充分修复：有兼容清单与最旧在用部署门、CLI/HTTP/事件合同版本、openExistingWriter 事务内 writerContractVersion 围栏（已核实 db.ts 中 openReadonly/openExistingWriter 存在且不迁移）、FLY-1914 活快照 sweep root、compatibility_hold、carrier_upgrade，以及真实双版本的 A9。遗留问题在反方向：§4.5 与 §9.5 要求回滚目标的支持清单覆盖全部在用快照。如果任一次日常部署 D(k+1) 提升了 CLI、事件或写入合同，而 Bridge 在 updater 健康检查完成前就用新快照准入了宿主，那么 D(k+1) 健康失败时回滚到 D(k) 会因为不支持更新的合同而被拒，最后退化成“停止部署并报警”，Bridge 停在坏版本上。§9 只处理了 N/N+1 首发这一段。建议：新快照只有在对应部署写下 known-good 回执后才可用于 admission；或者要求每次合同提升至少与上一版 Bridge 前向兼容一步。另需给部署门拒绝率和旧合同支持期定一个上限，避免 standby 长期停驻让整个班车长期受阻。

### n-health-window-sweep-disabled-unbounded

R2 的 first-deploy-rollback-blocks-whole-bridge 已修复：接管推迟到 N 健康并写下 known-good 之后，健康前失败仍可回 N-1。新写法要求 N 启动时关闭 adoption、reowner 和相关 sweep，直到外部 known-good 回执到达。若 updater 在健康检查后、写回执前崩溃，或者 launchd KeepAlive 在回执前重启了 N，这个等待就没有上限，期间旧 daemon 既无控制者也无人收尾。FLY-2903 的终态 stop/drain 本身是 N-1 也能理解的操作，不涉及所有权变更，应在健康窗口保持开启，窗口内终结的 issue 才不会继续消耗。建议写明：只暂停会改变所有权的动作，终态清理保持开启；等回执设超时告警；N 重启时按 rollout 状态判断是否已 known-good。

### pinned-cli-existing-writer-busy-and-scope

openExistingWriter 用 `timeout: 0` 打开，定位是“Never ... wait on a lock”；现有 CLI 在 packages/flywheel-comm/src/commands 下有 17 处 `new CommDB(`，走的是带 busy_timeout=5000 且会做迁移的构造器。把封存 CLI 的写路径全部换成 openExistingWriter 后，模型调用的 complete/gate/ask 只要撞上 Bridge 的并发写就会立刻 SQLITE_BUSY，并以错误形式返回给模型。§4.5 只写了“退回可重试等待”，没有规定 CLI 侧的有界重试，以及同一 requestId 的重放语义。这个 CLI 同时被 Claude runner 和各 Lead 使用：应写明新行为只对宿主快照调用生效（例如按 env 或 contract 模式开关），或者对全体使用者做 sweep 和负控，避免违反 §1.2 的“不改变 Claude 运行方式”。

### snapshot-budget-per-deploy-retention

§15 如实写了 12GiB 只是保护上限、可能暂停新 admission，并把分层去重、物理占用报告和容量估算交给 Lead 决定归属，没有把它冒充为已解决。这可以作为非阻塞项接受。由于 §4.5 又把 rollback-pin、upgrade-in-progress 和 standby 都计入在用，保留集会比 R2 时更大，上线前的容量验收必须按真实部署频率和 runner 寿命给出数字，否则 Codex 新派单可能被预算门拒绝。

## 交接边界

Lead 已回复报告 cf0ed513-7653-42e2-b856-656286d86a14：全部四项转为 FLY-2925 实施必须修复并验收的条目，已写入 issue；不重开设计。原 plan §15 的人工 reset 可撤掉 checkout wrapper 限制保留，后续 PR 必须明写。没有将这些实施要求变成本设计的额外审批门。实施与 QA 仍须按获批方案逐项证明 A1–A9，容量验收报告实际保留集，设计批准不等于真实验收或上线。

本次只补审查闭包，没有新增超出现有“核对实际载体/消费者/权威回执”原则的通用角色记忆，故本轮 role memory 保持 unchanged；审查细节保留在本单文档，避免把任务特例写成全局规则。

## Lead 实施验收裁定（回复 cf0ed513-7653-42e2-b856-656286d86a14）

1. 日常回滚保持前向兼容，必须有跨版本回滚测试。
2. N 健康等待有界，终态清理持续可用，并记录明确超时结果。
3. 固定 CLI writer 的 busy 重试有界且保持幂等，只作用于宿主路径；保留非宿主消费者负控。
4. 每次发布快照保留集/容量提供真实数字，并有超预算回收测试；不删在用版本凑绿。

该裁定叠加在获批计划上，由 implement/QA 执行，不改已批准 plan blob、不重新评审。设计节点仍只发布、报告和交卷。
