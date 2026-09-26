# FLY-2373 完工消息排空 — 实施计划
Issue: FLY-2373 (https://linear.app/geoforge3d/issue/FLY-2373/病根-完工-drain-与中途延后门铃互锁codex-体在一个-turn-里轮询等-lead-答案-deferred-midturn)
日期: 2026-09-25
基于: research.md

状态：待显式设计评审；本文不是实施授权或线上验收。

## 1. 给 founder：交卷先看有没有没读的正文
门铃是“有事找你”的通知，不等于事情本身。系统将核对消息正文的消费记录；正文已读时立即交卷，正文未读时直接在当前对话交给 Runner，Runner 处理并确认后再交卷。
Lead question 63ea323f-de86-46cc-8dce-51fa4987ca9b 已明确：已读/纯信号一次 complete；新指令最多两次 complete，中间读取/ACK（确认收到并处理），同一 turn（模型的一轮工作）内完成，无 park、terminate、重开、手改库或 Lead救援。
实现与QA用Opus。设计不会实现、部署、派发后继或改变审批。

~~~mermaid
flowchart TD
 C[Runner交卷] --> R[核对正文与消费证据]
 R -->|已读或确证纯信号| S[记录语义结算并交卷成功]
 R -->|真实未读| B[返回完整正文和精确确认令牌]
 B --> M[同一轮模型读取并处理正文]
 M --> A[显式确认对应正文]
 A --> C
 R -->|身份不符或证据缺失| F[保留原消息并说明拒绝原因]
~~~

## 2. 范围、不变量与术语
- completion drain：交卷前检查是否还有需要该执行体读取的正文。
- transport ACK：投递设施接收，不证明模型读取。现有legacy enqueue提前ACK属于此类。
- consumption receipt：消费凭据；证明特定执行体通过受支持读取/确认路径接收了特定正文版本。不是任意客户端JSON，也不是机器能证明“理解”的证据；QA必须另有完整模型行为。
- settlement：门铃义务已经由内容消费或受权处置满足；不伪写started/finished、不改turn_generation。
- 精确身份保持 project/execution/run/node/attempt/activation/epoch；display issue label不充当权限。
- 现有gate、reviewVerdict、rework delivery、TURN、completion businessDigest、权限检查照常先验。正文消费不授予任何ship或merge权限。
- 不删CLI命令；新增字段向后兼容；不做全库ACK/backfill，不通过TTL、DEAD、purpose或push_attempts=0推断已读。
- 真未读指令要求修改交付物时，先执行、重新走受影响审查，再提交。≤2次是无其它新业务阻塞、无持续新消息的固定QA场景，不允许为凑次数吞掉新工作。

## 3. 来源及义务解析
research.md“来源全集”是必改/确认清单：Lead send/respond、review verdict、runner-wake、founder nudge、TURN恢复、rework、ship carrier、sweep、reroute，全部写producer测试。
解析优先级：
1. valid batch metadata → 按memberIds联结mailbox.delivery_id（不是mailbox.id）；核对execution/recipient_kind/carrier；每个成员都成为正文义务。
2. source_instruction_id → 联结同exec原instruction，即使mailbox已经ACKED也不能省略。
3. typed control来源 → 联结真实持久outbox/activation记录；只有“相同activation已取得TURN的重复通知、无附加正文”可以由原权威记录证明signal_only。rework、approval、feedback不是默认纯信号。
4. 其它raw wake（包括purpose=park_wake）→ inline正文义务，按原文字节digest返回；缺metadata不能丢正文。
5. 找不到应存在的source或digest不符 → source_missing/source_conflict，保留义务并拒绝；“查不到”不等于空。
legacy重放/重复门铃按义务身份+digest去重，不仅按activation；同activation不同正文都必须读。
pending batch会合并：集合按deliveryId排序、去重并绑定digest；确认旧集合后新增成员仍未读。started/finished和admission_state均不证明正文已读；finished+deferred不再单凭admission阻塞，仍核对义务。

## 4. 数据合同：加消费来源，不重写运输账
在CommDB通过现有schema migration/open gate增加窄表，只加结构不补造历史消费：
- runner_content_consumption：receipt_id PK；execution_id；subject_kind(mailbox|inline_wake)；subject_id（delivery_id或wake message_id）；content_sha256；source_kind(inbox|check|drain_ack)；activation_id（inline必需，mailbox按原受件身份与合法绑定）；consumed_at；read_batch_id可空。唯一键exec+kind+subject+digest+activation。
- runner_wake_settlement：execution_id+wake_message_id+obligation_digest唯一；activation_id；reason(content_consumed|signal_satisfied|authorized_disposal)；evidence_json（消费receipt ids或已有处置/控制receipt）；completion_event_id；created_at。
字段均server派生；source_kind不是客户端可选值。类型和规范化digest函数新建 packages/flywheel-comm/src/completion-obligations.ts；CommDB事务访问保留db.ts，不复制第二套状态词汇。
digest采用域分隔canonical JSON：版本、exec、kind、subject、activation（适用）、原正文UTF-8 sha256、完整排序成员集合；不trim/翻译正文。大正文按既有content-ref解析并hash实际正文；引用不可读则拒绝。
settlement不改wake历史state/admission/push_attempts。phase reader查询、claim与sweep排除匹配当前obligation_digest且证明仍有效的已结算wake；批次合并改变digest自然恢复可见。旧reader不理解新表会重复叫醒，故必须一起升级。

### 4.1 凭据来源与伪造边界
- commands/check.ts → consumeGateResponse：验证question.from_agent===execution，读取实际response，ACK与新receipt同一事务。getResponse、review coordinator、Lead/后台探针不写消费receipt。
- commands/inbox.ts：仅实际返回的完整instruction正文在原ACK路径同事务写receipt；pending summary/空返回不签。debug exec override不签可用于完工的receipt。
- legacy ACKED/source instruction与raw wake：第一次complete返回read envelope原文；模型读后执行新增 node "$FLYWHEEL_COMM_CLI" inbox --ack-consumed <read-id>。ACK只接受服务端已发行并持久化的envelope，核验当前exec/activation与每个subject/digest；原子ACK正文并插入receipt，不能传任意id数组。
- read envelope复用StateStore drain challenge记录，增加version、read_id、完整subject/digest集合、issued_at；read_id不可预测。ACK endpoint在Bridge读取记录，不接受客户端evidence/digest/source_kind。只读输出不自动ACK。
- 随机read_id不是身份认证。沿现有Runner event caller/activation/TURN校验；参数exec、env、同UID、知道read_id不能单独授予权限。受信CLI直接写CommDB属于既有本地信任边界，本单不声称防恶意同UID任意DB写；HTTP body不能提交receipt字典。QA用真实模型行为证明读取。
- 新指令仍按full lead-instruction id报告DONE，ACK不代替行动报告。
- 历史ACK但无新receipt保守再读取，不从read_at/acked_at自动补消费。DEAD只有既有授权处置receipt且subject/digest/scope匹配才能满足；过期不等于已读。

### 4.2 返回与两次调用
complete照常带原route/业务payload，不需额外预检。服务器先完成既有身份/审核校验，再解析全部当前义务：
- 无未读：直接消费合法issued challenge（如有）并commit；调用者不需旧drain-receipt，没有challenge也一次成功。
- 有未读：409 consume_pending_mail，包含protocolVersion=2、challengeId、readId、完整unread数组（type、stable id、sender、正文、questionId或lead-instruction id）、ackCommand参数数组与retry信息。CLI完整解析按原文输出，不自动运行ACK；derived text不能当shell执行。
- 模型处理正文并报告后ACK，再次原complete；服务端重新检验全部当前义务，成功。读取后身份/正文变动，只确认已读精确版本，新内容仍未读；错误content_changed/reader_identity_changed，不污染旧证。
- ACK重放幂等；complete成功重放返回原receipt，不再次handoff。不同businessDigest仍走原stale_resubmission合同。
- 协议body有明确上限和分页；正常QA正文在一个409完整返回。超过上限返回非截断envelope和只读page命令，所有页均向模型输出后才允许ACK。CLI移除JSON.parse之前slice(0,1000)；只允许截错误日志，缺页/缺content-ref不能成功。
- v1 drain receipt仍绑定exec/activation/businessDigest，但由新语义重新验证，不将旧state字典伪造为started。旧CLI不理解v2时安全拒绝并显示可执行文本。
- consume_pending_mail是预期可恢复状态，单独退出码及pending记录，不写永久FAIL-CLOSE marker；网络/权限/提交失败继续FAIL-CLOSE。complete-marker-reconciler不能替模型ACK或自动提交未读正文。

## 5. 完工边界、并发与恢复
event-route只读state判断抽入同一Bridge completion service；StateStore.consumeDrainChallengeTx与event-route共用v2 proof类型，不能留下第二处started/finished旧条件。
异步PR/审核准备完成后，短同步阶段固定CommDB → StateStore顺序：
1. CommDB IMMEDIATE事务锁住mailbox/wake生产者，重读exec/current TURN和全部义务（不限旧challenge），验证receipt，构造server proof。
2. 同步StateStore.commitEnrolledCompletion；内部再CAS activation/current writer、businessDigest、gate、challenge，无await/网络/反向新CommDB连接。
3. 成功后同CommDB事务保存digest匹配settlement并提交；失败不结算。外部后继副作用在两库持久收据完成后才派发。
这不是跨库原子事务：StateStore成功后CommDB提交失败/崩溃，以持久completion receipt恢复。dispatcher释放后继前要求drain settlement reconcile；按原completionEvent/activation/proof重放settlement，不重交业务completion。StateStore completion记录保存完整server proof清单/digest（空集也有版本），不能只存内存。
若当前StateStore提交钩子存在反向CommDB连接，先移到提交后effect队列；不得锁内await。真实双连接测试验证不自锁，锁内只做两库同步本地写。
并发边界：
- 锁前新消息/新成员 → 完整扫描纳入；不能只验冻结challenge。
- 锁后新信 → 边界后新消息，保留QUEUED与原recipient，由现有后继/parked receiver按当前authority送达；本次proof不得ACK。若旧receiver不接，沿现有reroute/Lead-return保留pending并报告，不能静默丢弃。
- 第二个complete → 幂等原receipt；不同activation拒绝。
- rework、取消、hold竞争 → writer/authority CAS否决或独立新事件；drain clean不绕过它。
settlement只避免运输重复，不满足独立rework-delivered门。没有精确权威的control正文仍须读。

## 6. 等待源合同与carrier
修改 packages/claude-runner/agents/codex-runner-contract.md 和动态prompt生产者 packages/teamlead/src/bridge/run-dispatcher.ts / phase protocol源，同步消费者，不改当前agent home副本：
注册非阻塞gate → 有独立工作继续 → 无独立工作则保存progress → node "$FLYWHEEL_COMM_CLI" park --reason "waiting for question <id>" → 结束当前turn。
不在同turn sleep/check无限循环；慢gate不blocked，不借goal complete结束阶段。
当前index.ts:runDeclareState已有park；codex-phase-lifecycle.ts:observeBoundary读parked，daemon-client边界enterPhaseHold；复用此机制，不新增goal终态。
答案/门铃唤醒先TURN再check精确questionId。park前后入站竞态、restart、答案已消费但通知残留均测试。必要时daemon持久gate观察检测answered恢复，不造重复park_wake。
等待改动独立于drain：QA长turn故意不park仍须成功。FLY-2904 #10交叉引用，不能仅靠提示词修复。非phase Codex没有phase controller时应结束turn并由既有gate waiter调度恢复，不伪装phase park成功。

## 7. 旧体收尾归属
本单主实现不放宽codex-phase-shutdown.ts两个live-pane拒绝。子项“Codex生命周期/close-runner正式恢复入口”交Engineering Lead建单并安排owner，覆盖：
phase_shutdown_controller_lease_stale_live_pane；
phase_shutdown_ack_timeout_heartbeat_stopped_live_pane。
正门要求Lead认证、exact execution/incarnation、shutdown request、controller generation绑定；fence旧controller并持久化恢复owner，沿daemon/TUI shutdown接口关闭，读回daemon+TUI+归属进程全absence后才结算session。活或unknown不删记录；不裸TERM/按pane名kill，不以stale heartbeat授权。
参考close-runner.ts:cleanupWorkflowResumeAttempt/retireWorkflowProcessBody的generation/owner；其ship_parked内部bypass不能给任意运行体。FLY-2662 land reclose有merged operation边界，不替代子项。
交付明确“已定归属，恢复能力待独立实现”，drain QA通过不能宣称旧体收尾解决。依据用户允许拆子项，本设计报告Lead决定排期，不擅自派发。

## 8. 实施步骤
每项失败测试 → 最小改动 → 同测试PASS → 小提交。不运行全仓suite。
T1 义务与消费
- 新completion-obligations.ts；修改db.ts migration、inbox.ts、check.ts；新增src/__tests__/completion-obligations.test.ts。
- fixtures：batch delivery_id映射、legacy transport ACK、inline park正文、混合合并、错exec/ref/digest、missing/DEAD、重复activation异正文。
- getResponse/enqueue零消费receipt；旧数据重读、参数化SQL、实际正文hash。
T2 当前turn返回/确认
- 修改Bridge completion-drain.ts/event-route.ts并新增窄ACK路由；flywheel-comm index.ts inbox参数与commands/inbox.ts/complete.ts。
- first complete完整原文且零ACK → 正确ACK → second成功且active_turn_id不变。错exec/旧digest/readId拒绝；>1000字符JSON、分页缺页、引用失败、网络中断。
T3 settlement/并发
- 修改StateStore.ts challenge版本/proof/consumeDrainChallengeTx；db.ts settlement/phase claim过滤、codex-phase-lifecycle.ts reader；dispatcher对completion proof reconcile后才放后继。
- 测试锁前新成员、锁后新信、双提交、旧challenge已读、回滚、StateStore提交后中断、reconcile后无重复handoff、finished+deferred残留。
T4 等待/兼容
- codex-runner-contract.md及动态prompt源。prompt一致性、park→boundary→response、重复通知、重启、普通非phase Codex。
- Claude同一正文安全判定，保留原route；显式Claude回归，不能用“没改Claude文件”代替。
T5 真QA/版本
- Opus实现后review，Opus QA第9节建房起真Codex，记录完整模型行为。
- schema先加，Bridge/reader具备v2能力再允许新settlement；旧writer/reader不兼容保持安全拒绝，不假签凭据。
- rollback停发v2 settlement，保留已有receipt和completion，不逆转/删表。未完工旧版本可能恢复旧409，必须说明；独立updater部署。

## 9. 验证
以下已有测试文件已定位；两个新增文件由实施创建。包内逐批并核Tests数，零文件不是PASS：
~~~sh
pnpm --dir packages/flywheel-comm exec vitest run src/__tests__/completion-obligations.test.ts src/__tests__/db.fly2268.test.ts src/__tests__/db.fly1774.test.ts src/__tests__/complete.test.ts
pnpm --dir packages/flywheel-comm exec vitest run src/__tests__/receipt-wake-state-machine.test.ts src/__tests__/mailbox-settlement.test.ts
pnpm --dir packages/teamlead exec vitest run src/bridge/__tests__/completion-drain-v2.test.ts src/__tests__/fly2268-replay.test.ts src/__tests__/event-route-session-completed-guard.test.ts
pnpm --dir packages/claude-runner exec vitest run test/fly2268-resident-receiver.test.ts
~~~
新增completion-drain-v2.test.ts含真实两库临时文件、同步锁/崩溃边界，不把整个CommDB/StateStore mock。用临时库，不复制生产活库。

| QA | 成功证据 | 反证 |
|---|---|---|
| Q1 Lead send长turn | 529真Codex实现体active_turn_id非空时Lead发随机口令指令；留deferred/push_attempts=0；first complete原文→模型执行无害动作→ACK和DONE full id→second complete receipt；同turn≤2次、零park | 未读已成功、自动ACK、QA替模型做动作 |
| Q2 verdict长turn | 真实review-request coordinator投递message_traffic；体check后仍pending deferred；第一次complete成功 | 直接插库冒充verdict；把review当ship批准 |
| Q3 未读负向 | 已读review+新指令合并、legacy提前ACK、raw park正文，每条读后才签receipt | 因ACKED/purpose/started/DEAD自动放行 |
| Q4 重复/残留 | 同activation两条纯信号有精确证明则一次；异正文不去重；finished+deferred不改库 | 不同rework内容被吞 |
| Q5 Claude | 真Claude正常交卷成功；未读仍先消费，旧CLI回归 | skip、controller stub、零Tests |
| Q6 race/restart | 两连接竞态、旧receipt新成员、崩溃reconcile，无重复handoff或丢信 | 仅测冻结集合 |
| Q7 等待 | 真Codex pending gate park结束turn、答复恢复check，另保留Q1不park控制 | 仅prompt快照，无carrier行为 |

保存manifest：实际Bridge/CLI/adapter构建digest、room/exec/run/node/activation/turnId、deliveryId/正文digest、wake queue_seq/metadata、模型transcript/工具、消费receipt/DONE报告、每次complete请求响应、completion/handoff读回。
拆房前ask Lead；本机仅相关测试。×34是输入事故数，不是已验收数。设计阶段上述QA全部未执行。

## 10. 设计交付
HTML一句话、Mermaid本地SVG流程/数据模型、取舍/边界、逐节评论、pathname隔离localStorage、1800字符分段复制、单nonce脚本、无外部依赖。mmdc失败按任务重试一次，仍失败保留源并明确占位。
plan提交push → stage design_review --plan → gate+request-review → effective reviewVerdict APPROVED → HTML提交push/静默publish/托管校验/ask report → role学习 → exact complete --route phase_design_complete → park结束turn；phase controller继续持有goal。

## 11. Lead 裁定修订（实现期 4 条）
来源：实现节点 ask 4e60d44a-06d0-4b3f-8a90-c3dcdf7ba3ac，Lead 2026-09-26 回复“同意这 4 条”。本节只记录实现与上文的差异，其余条款不变；设计评审的其余非阻塞建议进 PR Follow-ups。

1. **结算即 finished（替代 §4「保持 pending、只让 reader 过滤」）**：completion 提交后，已证明的 wake 置 `state=finished`、`started_ack_scope='drain_settled'`，并写 `runner_wake_settlement` 行关联消费凭据。markTurnCompleted 提升、T1 push、T2 升级、doorbell 合并等所有 pending 读者自然跳过，不再重复投递或误报 T2；新义务生成新 doorbell。结算在完工事务内以 savepoint 执行，失败只回滚结算、不回滚已提交的完工。
2. **义务枚举根**：= pending wake（queued / deferred_midturn，仅 phase_keep_alive 生命周期）+ QUEUED/LEASED runner mailbox。started/finished wake 不作为根：inline wake 以 turn 输入送达即正文已送达；已 started 的 doorbell 其未读成员仍是 live mailbox 行。「历史 ACK 无凭据再读」只限 pending wake 的成员，409 页面标注“可能已处理，先核对再执行”。同一 durable TURN wake 的字节相同副本（verified T+3m 重推）若已有一份以 turn 输入送达，则其余副本视为已满足（signal_satisfied）；异正文绝不去重。
3. **分页**：每页 6 KiB / 120 行（低于 Codex exec 可见上限并留余量），有换行时在行界切页；Bridge 记录已发页，未全部发出前 ACK 返回 `pages_not_read`。
4. **不在 dispatcher 上加阻断门**（替代 §5「dispatcher 放后继前要求 reconcile」）：StateStore 与 CommDB 之间的崩溃窗口只会留下冗余门铃；完工证明写入 `completion_drain_consumed` 事件，complete 幂等重放时按当前 obligation digest 仍一致的 wake 补做结算并打告警日志。

另：消费凭据写在 `consumeGateResponse` 内（check 与阻塞 gate 共用）；`verify-approval` 的 `getResponse` 有意保持纯查询（审批答复若是 doorbell 成员，按 check 读取即签凭据，否则走一次 drain ACK）。两张新表登记 retention 片段（protectedCurrentOrAuthority，按 runner 消息量线性增长，后续可改 deleteTarget）。§7 旧体收尾归属不变：交 Engineering Lead 另建子单。

### 11.1 代码评审 R1 修订（gpt-5.6-sol，PR #1358）
- **`started` 不是送达凭据**：daemon 先 `markWakeStarted` 再 `startTurn`，`inbox` 也会把 queued 的 legacy 指令 wake 标 started 却不返回其正文。故枚举根补上 `state='started'`（未 finished）的 wake；turn 输入送达以 `finished` 且 `started_ack_scope='message'` 为准（重复副本去重同样只认已 finished 的副本）。这是对 §11 第 2 条的收紧，不放宽任何已读判定。
- **已结算 wake 不再被重投**：`claimRunnerPhaseWakeStart` 对 `finished/drain_settled` 返回 `disposed`，daemon 不再对它 `startTurn`；结算同时覆盖 pending 与 started。
- **source_missing fail closed**（回到原设计 §3 第 5 条）：doorbell 指针文本不能替代缺失的真实正文，解析不算满足、drain ACK 拒绝（`source_missing`），409 提示报告 Lead。
- **读/确认身份**：page/ACK 必须携带 runner 自己的 workflowActivation，且 activation/run/node/attempt 与当前绑定一致、TURN epoch 与 `workflow_activation_turn` 一致——与 session_completed 同等强度（§4.1 的本地信任边界不变，不新增凭据）。
- **重试命令**：完整复现 session-role/summary/exit-reason/base-ref 等全部参数并做 shell 单引号转义。

### 11.2 代码评审 R2 修订
- **双向派发栅栏**：daemon 对 started wake 的 replay claim 同事务把 `started_ack_scope` 置为 `message`；解析把 `started/message`（已被 daemon 认领、尚未记录送达）视为 `in_flight` 义务——不可 ACK、不可结算，直到 finishWake。先结算后 claim → `disposed`；先 claim 后完工 → 409 in_flight，送达记录后重跑即可。两侧都在 IMMEDIATE 事务内，天然串行。
- **ship carrier 身份**：carrier 的 CLI 不发 workflowActivation（与 complete 一致），改发 `carrierActivation {activationId, turnEpoch}`；Bridge 按 `workflow_carrier_delivery` 校验 carrier_activation_id → source_execution_id 与 turn_epoch（与 carrier wake receipt 同形），并仍要求 envelope 属于该执行的当前绑定。
