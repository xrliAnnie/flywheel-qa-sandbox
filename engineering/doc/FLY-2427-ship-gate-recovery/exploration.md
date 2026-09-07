# FLY-2427 Ship gate 死卡收敛 — 探索
Issue: FLY-2427 (https://linear.app/geoforge3d/issue/FLY-2427/批准通路-lead-对-approve-to-ship-gate-的非批准回复被接受并消耗掉这道门却不铸-source-event)
日期: 2026-09-07
基于: 无

## 问题与用户影响

Lead 可以用 `flywheel-comm respond` 向 founder-only 的
`approve_to_ship` question 写非批准文本。该写入不会铸
`workflow_source_event`，却会通过 `insertResponse` 把 question 置为
`terminal_disposed`。StateStore 的 `workflow_gate_holder` 仍停在
`awaiting_review`，Discord 卡也仍显示可操作；founder 之后的 reaction/reply
又被 question 的 response/disposed 条件拒绝，形成永久死卡。

这不是 FLY-2426 的 `superseded_merged` 误退休病因，但两者产生同一种跨库
不一致：StateStore 认为 gate 活着，CommDB 已经不可回答。

## 当前事实

1. `packages/flywheel-comm/src/commands/respond.ts` 只拒绝
   `hasApprovalIntent`；非批准文本和 `--kickback` 会 POST 到
   `/api/founder-consent/runner-gate-response`。
2. `packages/teamlead/src/bridge/approval-signal/write-gate-response.ts` 对
   Lead attribution 无法进入 trusted founder/source 分支，最后调用
   `insertResponse`。
3. `CommDB.insertResponse` 写 response 后立即调用
   `markQuestionTerminalDisposed`；这笔事务没有 source event。
4. 正常 founder response 由
   `insertFounderApprovalResponseWithSource` 在同一 CommDB 事务内写
   response、dispose question 和 source event，不存在
   “founder response 已写但 source event 尚未写”的窗口。
5. 正常新卡路径已经存在：StateStore 创建一条新的
   `workflow_gate_holder`，`gate-materializer.ts` 再分阶段写 CommDB
   question、发卡并绑定 card。
6. 2026-09-07 对生产库的只读检查显示：19 条
   `awaiting_review` holder 中 7 条属于 active Flywheel runs。7 条的
   CommDB 形状恰好为：

| Issue | question 状态 | response | source event | 预期 |
| --- | --- | ---: | ---: | --- |
| FLY-2381 | `terminal_disposed` + `superseded_merged` | 0 | 0 | 收敛 |
| FLY-2394 | `terminal_disposed` + `superseded_merged` | 0 | 0 | 收敛 |
| FLY-2408 | `terminal_disposed` | 1（Lead） | 0 | 收敛 |
| FLY-2379 | `protected` | 0 | 0 | 不动 |
| FLY-2383 | `protected` | 0 | 0 | 不动 |
| FLY-2397 | `protected` | 0 | 0 | 不动 |
| FLY-2403 | `protected` | 0 | 0 | 不动 |

7. 2026-09-07 10:47 PDT 对三条目标 binding 做了只读 `gh pr view`：PR
   #1109 / #1103 / #1118 均为 `OPEN`、非 draft，且 `headRefOid` 与 holder
   head 完全相同。CommDB 的 `superseded_merged` 不是当前 GitHub PR 已 merged
   的事实；但 replacement 仍必须经过现有 origin preflight，不能从这次现场
   快照推断未来一定可发卡。

## 冻结边界

- 只实现验收判据 A–J，不补写 approval/claim/authority/consent，不修改
  `pr_head_sha`，不终结 Runner。
- 收敛只看 active run 当前 gate 的 `awaiting_review` holder；历史
  terminated-run residue 不属于本单。
- 每轮候选数有硬上限；单条失败隔离，后续 tick 可重入。
- 常驻 pass 最短间隔 30 秒，与相邻 sessionless reconciler 一致，避免 Bridge
  的 3 秒 materialization tick 每轮反复打开每个 project 的 CommDB。
- 项目级 `workflow_gate_question_recovery` flag 使用现有 flag store，默认 ON；
  设为 off 时该 project 的整个 pass 在 candidate/CommDB/preflight 之前返回，
  不得留下半截状态。它限制全局误行为，和同 head max-3 的单 key 熔断互补。
- 同一 `(run,node,head)` 最多执行 3 次 question recovery。达到上限后不再
  supersede/铸卡，并写一条 stable-identity durable alert；避免 FLY-2426
  尚未修复时 external-merge reconciler 持续杀卡而本 pass 持续补卡。
- replacement holder 与旧 holder supersede 必须在同一 SQLite 事务提交；任一
  新 holder/evidence/binding/event 写入失败都回滚，旧 holder/card 逐字段原样
  保留。旧卡只在新卡 durable completed 后进入已有 card-void 生命周期。
- 生产 `teamlead.db` / `comm.db` 永远只读。A–J 验收只在 SQLite backup
  副本上执行。

## 方案选择

选择 C1：`flywheel-comm respond` 对 `approve_to_ship` 的 Lead 任意文本
一律拒绝，错误指向 founder 在卡上 reaction/reply。Bridge writer 对携带
Lead request 的同类调用也 fail closed，保证绕过 CLI 直接 POST 仍不能静默
消费 question。保留参数解析兼容，但 `--kickback` 不再绕过 founder-only
边界。

不选 C2。保留 Lead response 会继续触发
`NOT EXISTS (... type='response')`，除非另造 response 分类/迁移协议；这比
在入口拒绝复杂，并容易再次混同 Lead 与 founder authority。

## 收敛模型

1. 从 StateStore 有界列出 active run 当前 gate 的 `awaiting_review` holder；
   只有 epoch-1 land 进入 CommDB/replacement，其它 authority/epoch 计 skipped。
2. 在对应项目 CommDB 中读取 question、response 与是否存在绑定该
   `question_id` 的 founder source event。
3. question 缺失、disposed、superseded、resolved 或已有 response 时命中；
   若已有 founder source event则跳过，留给 projector 正常消费。该附加守卫
   避免把已成功落 source transaction、仅尚未投影的有效 founder 决策重铸成
   第二张卡。
4. 在改变 holder 前，调用从生产 gate-origin preflight 抽出的同源纯 inspection。
   只有 current ship-target binding、node PR binding、GitHub PR `OPEN`/非
   draft/同 head 全部通过才返回 frozen receipt；inspection 自身不写 holder。
   defer/hold 时旧 holder/card 逐字段原样保留，通过既有 workflow alert outbox
   以 question-id 稳定 UID 告警一次；payload 使用固定的
   `origin_inspection_blocked` 文案，不嵌入可能跨 tick 改变的 reason，保证重放
   逐字节一致。
5. StateStore 以 CAS 方式验证 holder/run/current gate 与 frozen receipt 后，在
   单一 SQLite 事务中创建 epoch-1 land 的正常下一 attempt holder/evidence/
   binding/events，并 supersede 旧 holder。partial INSERT 或 CAS 失败整体回滚；
   对事务外观察者，新 holder 持久存在与旧 holder supersede 同时可见。
6. 同一 tick 先让已有 materializer 写新 question、发新卡、绑定并完成；只有
   current successor 已经 `completed` 且有 `card_message_id` 时，旧 recovery
   卡才会被 StateStore candidate reader 列给 void pass；等待期不调用 defer、
   不消耗任何 card-void budget。因此“请使用新卡”的文案不会指向不存在的卡。
7. replacement 前按同 run/node/head 统计已执行 recovery 的旧 holder；达到
   3 次即只铸一次告警、不再铸 holder。3 次与已有 card-post 最大尝试数同量级，
   足以吸收短暂/重复失配，同时给最坏噪音设置小而明确的上界。

## 已确认测试 seam

- CLI seam：`respond()`；断言所有 Lead 文本在 fetch/CommDB write 前失败。
- Bridge writer seam：`writeGateResponseAndRunPostWrite()`；断言 Lead
  request 不调用任何 response/source writer。
- 收敛 seam：新的有界 reconcile 函数，使用真实 CommDB + StateStore；
  覆盖五类坏 question、健康逐字段不变、已有 source event 阴性对照、二次运行
  零变化、origin preflight defer/hold 时零 replacement，以及非 epoch-1 land
  holder 全字段不变。
- 正常发卡 seam：`materializeWorkflowGateHolder()`；单元测试注入确定性
  preflight 与 Discord fake，真数据副本证明则使用生产 preflight（真实只读
  `gh pr view`）且只 fake Discord POST。replacement 不短路这次正常 preflight；
  若两次检查间外部状态漂移，新 holder 保留但旧卡不 void。
- 真数据 seam：生产库 SQLite backup 副本，命令输出必须推出恰好 3 收敛 /
  4 不动。
- 熔断 seam：同 run/node/head 前 3 次可 recovery，第 4 次新卡为 0、durable
  alert 为 1；再次运行 alert 数不增加。

## 显式假设

- “当前 head”由 StateStore 已有 workflow evidence / current PR binding
  解析，不从旧 holder 文本猜测，也不写 `pr_head_sha`。
- CommDB question 的不可回答字段是单向状态；一旦观察到坏态，之后不会合法
  恢复。founder 的合法 response 与 source event 同事务写，因此
  “坏态且 source event 不存在”可安全收敛。
- recovery 旧卡只有在 successor 卡已 durable completed 后才允许 void；Discord
  编辑失败由已有 bounded card-void pass 重试并 fail loud。
- 判据 I：任何 commit 边界都不得出现“旧 holder 已 supersede、replacement
  holder 未持久化”；任何 Discord side-effect 边界都不得出现“旧卡已 void、
  replacement 卡未 completed”。纯 origin inspection defer/hold 时旧 holder
  与 card-void 字段必须逐字段不变，告警 stable-dedup 为一次。
- 判据 J：`workflow_gate_question_recovery` 是默认 ON 的项目级 kill switch；
  off 时 pass 在第一笔候选读之前退出，没有任何半截状态。
- “question 缺失”在这里特指 engine-owned、current gate holder 的跨库损坏，
  StateStore 本身提供精确 run/node/head authority；这与 FLY-1099 Z2 对 legacy
  session-only、缺乏 first-class holder authority 的 unreachable gate 不同。

## Follow-up（本单不实现）

按 Lead 对 design review round 1 的裁定，除 kill switch、30 秒 throttle 与
preflight/void safety 外，其余 MEDIUM/LOW advisory 不扩入本单：runner-ship
carrier 的专门 recovery、epoch-0 holder recovery、旧 Z2 政策重整、recovery
额度 episode 化另开 follow-up。当前生产 7 条候选均为
`gate_carrier_epoch=1 / authority_mode=land / carrier_binding_state=bound`；本单
reader 只允许这一精确 first-class land 形状，其他形状保持不变并记录 skipped。
