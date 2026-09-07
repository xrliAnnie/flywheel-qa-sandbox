# FLY-2427 Ship gate 死卡收敛 — 调研
Issue: FLY-2427 (https://linear.app/geoforge3d/issue/FLY-2427/批准通路-lead-对-approve-to-ship-gate-的非批准回复被接受并消耗掉这道门却不铸-source-event)
日期: 2026-09-07
基于: exploration.md

## 1. 正常 authority 与发卡路径

Workflow 从上游节点进入 `gate` 时，StateStore 在同一 transition 事务中：

1. 把新的 gate attempt 投影为 `workflow_run_node.state='review'`；
2. 写 `gate_opened` run event；
3. 调 `createWorkflowGateHolderTx` 解析当前 workflow evidence；
4. 以 `runId + gateNodeId + attempt + subject` 的稳定 digest 生成
   `workflow-gate:<digest>` question id；
5. supersede 旧 holder/ship target，写新 holder 与
   `gate_holder_created` event。

随后 `gate-materializer.ts` 以 durable stage 推进
`question_intent → question_written → session_bound → card_posted →
card_bound → completed`。Discord 只在 `postCard` 外部边界发生；其余状态可
重放。

结论：收敛器不应直接 INSERT 一张“特制卡”，也不应补 approval/claim。正确
实现是让 StateStore 原子产生新的正常 holder，再让已有 materializer 继续。

## 2. 为什么 replacement 必须使用下一 attempt

`createWorkflowGateHolderTx` 的 question id 对
`run/gate/attempt/subject` 是确定性的。若保持旧 attempt 和同一 head，生成的
question id 与旧行完全相同；旧行即使已经 superseded，`question_id UNIQUE`
仍会拒绝新行。

因此 recovery 必须创建下一 gate attempt，并同步写新的
`workflow_run_node(review)` 与 `gate_opened`。这也让后续 founder verdict
通过 holder attempt 进入正常 transition，不会引用不存在的 node attempt。

## 3. 当前 head 与 frozen evidence

生产 7 个 active holder 的 `head_sha` 均与各 run 当前
`workflow_node_pr_binding.head_sha` 相同。replacement 事务仍应显式要求：

- run 为 engine-owned active；
- `run.current_node_id` 等于 holder gate node；
- holder 是该 run/gate 唯一 current `awaiting_review` 行；
- 当前 PR binding 唯一且 head 与重新解析的 gate evidence 相同；
- head 是 40 位 SHA。

如果这些前提漂移，收敛应拒绝并留待下一 tick/人工调查，不能拿旧 holder 的
字符串冒充 current head。

### Origin preflight 是 replacement admission，不只是 materializer 细节

现有 `createWorkflowGateOriginPreflight` 会校验 current ship target、current
node PR binding，并用只读 `gh pr view` 验证 PR 为 OPEN、非 draft、同 head；
但 defer/hold adapter 会写旧 holder 的 `origin_probe_*`，不满足判据 I 的
“铸不出来则旧 holder 逐字段原样保留”。

实现需从该模块抽出共享的纯 inspection：同一组 local binding guard、project
probe budget、`probeWorkflowPr` payload guard 与外部状态分类，返回
`{ok:true, receipt}` 或 `{ok:false, disposition:defer|hold, reason}`，本身零写入。
既有 materializer preflight 继续用 adapter 把失败投影为原来的 defer/hold；
recovery 则把失败投递到既有 workflow alert outbox，不改 holder。告警 UID 只
按 question id 定位，payload 是不含动态 reason 的固定
`origin_inspection_blocked` 形状，所以跨 tick 失败原因改变也不会触发 UID/
payload 冲突。

成功 receipt 冻结 question/run/node/head、ship-target identity、PR number/repo 与
observedAt；replacement 事务逐项重验 current StateStore binding 后才写新
holder，并在新 holder/event 上保留 receipt digest/时间用于审计。新 holder 的
正常 materializer 不复用/短路该 receipt，仍执行自己的生产 preflight；如果
两次检查间 PR 漂移，新 holder 已 durable 存在但新卡不发，旧卡也因 successor
未 completed 而不 void，维持判据 I 的可见性不变量。

2026-09-07 10:47 PDT 的只读现场探测显示 FLY-2381/2394/2408 对应 PR
#1109/#1103/#1118 都是 OPEN、非 draft、head 精确匹配，所以当前副本验收应能
通过 admission；若验收时外部状态已漂移，正确结果是该 issue `skipped`、旧
holder/card 不变并记录 preflight defer/hold，而不是伪造“恰好 3 张新卡”。

## 4. 跨库顺序与有效 founder source event

CommDB 的合法 founder 写入在一个 immediate transaction 中同时完成：

- response；
- question `terminal_disposed`；
- append-only `workflow_source_event`。

所以不存在合法的“founder response 已提交但 source event 尚未提交”窗口。
收敛器先在同一个 CommDB read snapshot 中判断 question 坏态，再确认该
question 没有 founder source event。坏态字段/response 是单向的；观察到坏态
之后，新的合法 founder writer 已无法通过 answerable predicate。因此跨到
StateStore CAS 前不会出现一个后来成功的 founder write。

若 source event 已存在，question 虽不可再次回答，但它不是本单定义的静默
消费；应让 `founder-approval-projector` 处理，收敛器不得抢跑造第二张卡。

## 5. Source-event lookup 的有界索引方案

`workflow_source_event` 主键为 `(project, source_event_id)`。founder
source id 的稳定前缀为：

- `founder-approval:<questionId>`
- `founder-feedback:<questionId>`

每个前缀同时覆盖无 msg-id 的历史形状和
`:<msgId>` 后缀的新形状。用两个 scalar `EXISTS` + 半开前缀 range 查找，
SQLite 的现场 `EXPLAIN QUERY PLAN` 均走
`sqlite_autoindex_workflow_source_event_1 (project=? AND
source_event_id>? AND source_event_id<?)`。不需要 JSON payload 全表扫描，也
不需要 CommDB migration。

## 6. 有界 pass 与 crash/replay

- StateStore candidate API 固定 `LIMIT`，默认 20、最大 100，只返回
  engine-owned active run 当前 gate 的 `awaiting_review` holder，并把本单
  mutation 面限定为 `gate_carrier_epoch=1 / authority_mode=land /
  subject_kind=git_head / carrier_binding_state=bound`。runner_ship 与 epoch-0
  不进入 replacement，留作 Lead 裁定的 follow-up，避免混用 question
  digest/holder shape。
- Reconciler 按 project 复用一个 CommDB handle；单候选异常隔离。
- Pass 最短间隔 30 秒；这是 Bridge 3 秒 tick 的 10 倍，并与相邻
  sessionless reconciler 的常驻扫描节流相同。
- 项目级 flag `workflow_gate_question_recovery` 由现有 flag store 管理，默认
  ON；off 时函数在 candidate scan、CommDB open、preflight 与任何 StateStore
  mutation 之前返回 `disabled`。flag 读取异常也 fail closed 为 off 并告警。
- StateStore replacement 是单事务 CAS。成功后旧 holder 不再出现在 candidate
  集，新 holder 由已有 materialization list 接管。partial write 抛错会回滚旧
  holder supersede；SQLite commit 外没有“无 current holder”中间态。
- 若进程在 replacement commit 后、发卡前退出，新 holder 的 durable
  `question_intent` 会在后续 tick 继续；不会重造第二个 holder。
- 对旧 question id 重放 replacement API 时，若找到同 reason 的 superseded
  旧 holder及其 current successor，返回 idempotent replay。

### 同 head recovery 熔断

FLY-2426 的 external-merge 误退休在本单之外，可能再次杀掉 replacement
question。为避免两个 reconciler 形成无限循环，StateStore 在 replacement
事务中统计同一 `(run_id, gate_node_id, head_sha)` 上
`superseded_reason='question_unanswerable_recovery'` 的行数。该计数等于已
完成的 recovery 次数：

- 少于 3：允许再执行一次 recovery；
- 达到 3：holder/question/run 均不再变化，写 stable escalation uid 的
  durable workflow alert；
- 之后重放只观察到同一 alert，不重复入队。

选择 3 是为了与已有 card-post 最大尝试数一致：允许有限的暂态恢复，又把同
head 最坏新卡噪音明确限制为 3。head 改变后是新的 recovery key，但仍须满足
current evidence/head guard。该额度刻意按 `(run,node,head)` 的整个生命周期
累计，而不是按 question episode 重置；这是冻结判据 H 要求的 fail-stop 语义，
避免同 head 在换 question 后重新获得无限额度。

## 7. C1 的双层阻断

仅改 CLI 可以阻止已知现场命令，但 Bridge endpoint 仍是公开的 server-side
写边界。实现采用同一语义的两层守卫：

1. `respond()` 在认证后、fetch 前拒绝 Lead 对
   `approve_to_ship` 的任意 answer，并提示 founder 在卡上回复；
2. `writeGateResponseAndRunPostWrite()` 对携带 `leadRequest` 的调用在
   storage write 前拒绝，防止直接 POST 或未来新 caller 绕过 CLI。

可信 founder reaction/reply 继续走
`trustedFounderGateResponse` / `insertFounderApprovalResponseWithSource`，
不会经过 Lead rejection。CLI 继续解析兼容参数，但 `--kickback` 不具备
越过 founder-only authority 的能力。

这是外部可消费 CLI 行为的收窄。实现前后都要按 CLAUDE.md FLY-1914 对主仓
scripts/packages、`external_plugins/` 与本机 plugin cache 做带时间戳的消费者
sweep，并把结果存为 evidence。被拒绝的 Lead 操作没有成功消费 gate，因此
也不应调用 `retireMarker`；正常 founder 路径与后续 holder recovery 各自处理
自己的 authoritative lifecycle。

## 8. 旧卡状态

统一 supersede helper 会保存 `superseded_from_state`，并对已发卡 holder
设置 `card_void_state='pending'`。但 recovery reason 的 card-void reader 还要
求同 run/node 的 current successor 已 `materialization_stage='completed'` 且
有 `card_message_id`。composition order 为 recover → materialize successor →
void old card；因此新增文案“旧卡已坏并自动重铸，请使用新卡”只在新卡确实
存在时出现。Discord 编辑失败继续由既有重试/告警机制处理。

## 9. 验证映射

| 判据 | 权威证据 |
| --- | --- |
| A 可合入 | 最终 head 对最新 `origin/main` 的 `git merge-tree` 无冲突标记 |
| B 收敛 | 真实 StateStore+CommDB 测试及 backup-copy 前后 diff |
| C 不静默消费 | CLI 与 writer 两个 exact-call-site 红绿测试 |
| D 健康阴性 | healthy holder/question 全字段快照不变且 postCard=0；手工放宽 mutation 后测试红 |
| E 幂等有界 | 同 pass 连跑两次，第二次 recovered/reminted/changed 全为 0；limit 断言 |
| F 真数据 | SQLite backup 副本命令输出：3 个指定 issue 新卡，4 个指定 issue逐字段不变 |
| H 同 head 上限 | 连续构造 4 次坏 question：前三次 replacement，第四次 0 新卡 + 1 durable alert；再次运行 alert 数不增 |
| Origin 失败 | preflight defer/hold 时旧 holder/card 全字段不变、new holder/card=0；生产副本使用真实只读 `gh pr view` |
| J 逃生阀 | project flag 默认 ON；off 时 candidate/CommDB/preflight/mutation 调用均为 0 |
| I 可见性不变量 | replacement 事务失败则旧 holder 原样；successor card 未 completed 则旧卡不可 void；defer/hold 告警各 stable-dedup 一次 |
