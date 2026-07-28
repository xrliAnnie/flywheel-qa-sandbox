# FLY-1498 门与图 — 实施计划
Issue: FLY-1498
日期: 2026-07-28
基于: `mapping-v2final.md`

## 0. 状态与权威

本计划取代 2026-07-27 旧版。唯一设计权威是同目录 `mapping-v2final.md`；旧版中的
dispatcher GitHub executor、terminal task successor/rework_of、obligations 与
`ownerLeadId` 方向全部作废。

评审结果的准确口径：head `8edee28167184763dd34c868d4f978ed5731111d`
的 APPROVED 只覆盖并稿前 mapping 缩减载荷；并入 FINAL/design-chain 后不得继承
该标签，交付以当前 PR head 绑定的 request-driven review 为准。

本单是**纯设计文档单**。不修改 `packages/`，不加 feature flag，不实现 migration；
schema/runtime 接线由后续实现单按本设计交付。

## 1. 交付物

| 文件 | 动作 | 完成条件 |
|---|---|---|
| `doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md` | 新增详细设计 | 完整承接节点合同、DAG、同 task 返工、agent-first ship、actions/reconcile、验收与诚实边界 |
| `doc/engineer/plan/v2/design-FINAL-v2.md` | 并入活权威 | §T、§1.0/1.1/1.4/1.5/1.7、§2.5/2.9/2.12、§3/§5/§6 同步，无旧口径冲突 |
| 本文件 | 重写实施计划 | 只保留批准后的并稿步骤和验证，不留可被误执行的旧设计 |
| `mapping-v2final-r5-delta.md` | 留审计 | 明确为非权威 review record，不并入 FINAL/design-chain |

## 2. 必须并入的设计合同

### 2.1 节点完成合同

- `contract = declared(parse_contract(task.contract_json)) ∪ derived(canonical diff)`；
  declared 部分固定存于 `tasks.contract_json` canonical JSON array，
  `tasks.writes_repo` 是显式 boolean 列。task admission/创建 API 必须提交两者，不按
  kind/节点名推断。
- product-code diff 派生 exact-subject 跨族 code review；test-only/docs-only/空 diff
  不派生 code review。节点名、session role、三段式 phase 不参与分类。
- `review_capable_families - effective_author_set` 为空时，product-code completion
  typed `review_family_exhausted` 并保持未完成；披露不能充证据。选定出口是认证
  第三方 reviewer family 对原 subject digest review；不引入缺逐贡献权威的 split
  review。test/docs-only 不触发该边界。
- manifest、author-set、证据满足清单、activation/attempt/task terminal、
  `node_completed` 与 `span_tip` 推进在同一 kernel 事务提交。
- admission 以 merge target 与 HEAD 的 merge-base 初始化
  `span_tip=writer_chain.chain_head`；禁止用 admitted HEAD 惰性开链。既有分支领先
  anchor 时先走通用 writer-gap 归因，首个 done 必须消费 anchor 后全部 diff。
- manifest 要求 span_tip 是 head ancestor；history rewrite 后用新 worktree
  identity 重新 admission，不原地 re-anchor。
- 所有 git/GitHub observation 在事务外；事务内只有 expected value/version/CAS。
- writes-repo attempt 的所有终态路径统一折叠 author state；非写 attempt 不进该
  谓词。lost worktree/ref 复用受审计的 `adopt_writer_gap(lost_open_attempt)`。

### 2.2 DAG 与返工

- dispatcher 只执行通用 eligibility：
  `ready + incoming all done + no active attempt + writer slot available`。
- 1/2/N、串/并行、PRD、QA、三段式只是 task/edge 数据形状；引擎零模板/节点名分支。
- rework 在同一个 task 上创建新 attempt，不建 successor 或回边。
- 同一事务先 terminal/revoke/release 直接 task 与下游活套件，再 acquire 被打回 task
  的新 writer slot；下游只重算 ready/blocked，待通用 dispatcher 后续派发。
- `maybe_refresh_ship_gate` 是 completion/revision/excision/cancellation/rework 共用
  谓词；tip 只取同事务 current span_tip，HEAD≠span_tip 时 expire 并告警，不把
  excised/failed attempt 的未消费 diff 绑进 gate；“最后节点”是事务查询结果，不是
  特殊 node kind。

### 2.3 ship 与 actions

- ship 是 agent 外部动作，不是 DAG 节点。
- 前置恰三条：current founder approval 绑 tip、当前 DAG 全 done、GitHub head 未
  漂移；ship 不重查 review/QA/docs/session role。
- founder approval 事务选 emitter 或只读 merge target ref 上可信配置的
  `default_action_agent_id`，记录配置 digest，写 durable mailbox，并为 attempt 1
  签发绑定 gate/effect_key/repo/pr/head/attempt_no 的 one-shot capability。
- 活着的 current-generation agent 亲手调用 GitHub merge；无活 agent 时 dispatcher
  只按 `consumer_registry` + heartbeat 唤醒同一 logical agent。
- `actions` 是外呼黑匣子：稳定 effect_key + 有界 attempt_no，prepared/executing/
  terminal 状态与 result_ref；它不选择 actor、不派发、不授予权限。
- capability mint 只有 founder approval 首次签发与 ActionReconciler 在同批准/head/
  DAG 未变、未超限下的有界再武装两点。
- ActionReconciler 是 kernel-owned、GitHub read-only probe，不属于 dispatcher，
  不执行 merge；它对账 stale executing，并按 5min reconcile、6 attempts、2min
  exponential base、15min cap 的 actions 行策略快照驱动有界恢复。
- 超限先结算 action failed，再在同事务直接 expire gate；正常 rework/revision
  失效会清 failed.next_retry_at，reconciler 静默收尾，不制造 founder 告警。
- CI 不进入三条 ship 谓词；v2 激活前必须实测 required checks + non-admin、
  non-bypassable merge actor，失败则保留 v1 ship lane。

### 2.4 删除与跨单边界

- obligations/病历卡族、v2 `ownerLeadId` consumer、action executor registry/claim、
  ship task/node 全部删除。
- schema 所有者后续以新的 forward migration 重建 tasks（新增
  `contract_json`/`writes_repo`，删除 `rework_of`/`lineage_root_id` 与 self-rework
  triggers，保留 id 并 foreign_key_check）、drop obligations、create actions、
  重建 issue-scoped gates 与显式 task|issue thread_bindings；四项在同一 PR 原子
  交付。已登记 checksum 的 0001/0002 逐字不改，表总数仍为 17。
- 跨单依赖只保留：已冻结 vendor adapter；FLY-1499 建 heartbeat 列供 wake 查询读。

## 3. 并稿步骤

1. 新建 detail design-chain，逐节写入 §2 的规范与 mapping 的事务/竞态/验收细节。
2. 更新 FINAL 评审链与术语，删除 obligation/owner/successor/dispatcher-action 旧口径。
3. FINAL §1.0/§1.1 写 tasks contract_json/writes_repo 前向重建、actions、stable
   canonical worktree、同 task attempts；
   §1.4 写 dispatcher 边界；§1.5 写 agent-first ship；新增 §1.7 完成合同。
4. FINAL §2.5 写同 task rework；§2.9 将外部 effect 与 commands outbox 分开；
   新增 §2.12 DAG dispatch/agent wake/ActionReconciler。
5. FINAL §3 把 obligation 告警替为 typed event + durable mailbox；§5/§6 加
   PRD/QA、任意图、author-set、返工、gate/action 双序与 recovery 场景。
6. 对 FINAL、detail、mapping 做双向术语和旧方向零命中检查。

## 4. 验证

### 4.1 静态一致性

- FINAL 的 ship 谓词只能出现三条通用项。
- FINAL 的 DAG engine 不出现 design/implement/qa/template 形状分支。
- v2 核心设计不出现 obligations、ownerLeadId、terminal successor rework、
  dispatcher GitHub executor。
- detail 与 FINAL 对 `actions`、`attempt_no`、reconcile/retry policy、
  `canonical_worktree`、merge-base anchor、gate tip 来源、lost-open adoption、
  capability mint 点口径一致。
- `mapping-v2final-r5-delta.md` 明确非权威。

### 4.2 仓库检查

本单没有产品代码变更，仍跑仓库级验证；设计 checker 固定为 C byte semantics，
并从两种 caller locale 复现同一结果：

```sh
LC_ALL=C bash engineering/doc/FLY-1498-gate-dispatch-model/qa/verify-design-consistency.sh
LC_ALL=en_US.UTF-8 bash engineering/doc/FLY-1498-gate-dispatch-model/qa/verify-design-consistency.sh
bash engineering/doc/FLY-1498-gate-dispatch-model/qa/verify-design-consistency.sh --selftest
pnpm lint
pnpm -r build
pnpm test:packages:run
```

若主干既有失败，记录命令、失败文件与 `main...HEAD` 无交集证据；不得把既有债务修进
本单。

## 5. 完成定义

- detail、FINAL、plan 三份并稿通过静态一致性检查；
- `git diff main...HEAD --name-only` 无 `packages/` 与 feature-flag 修改；
- 仓库验证完成并记录；
- commit/push 后创建 docs PR；
- PR head 经 request-driven cross-family code review；
- code review 与 CI 通过后报告 Lead，由 Lead 触发独立 QA；QA PASS 必须绑定 exact
  parked head，之后才开新的 approve_to_ship gate、完成 needs_review + park。
