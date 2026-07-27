# Flywheel v2 设计稿 v2 (2026-07-27)
> 相对 v1:吸收 Codex R1 全部 11 项修改 + Annie 信箱考古修订(SQLite 信箱为唯一消息通道)
> 变更标记:[R1-n]=对应修改项;[A]=Annie 修订

## 0. 目标与范围 [R1-11]
体验契约同 v1。**范围精确化**:不改的是**第三方 API 与 vendor adapter 本身**(Discord/Linear/GitHub 的 API、claude/codex CLI 调用方式);**必须改**的是我方的 ingress/projector/receipt 接线(谁产收据、谁写投影、founder 消息怎样进 kernel)。
notify-then-do 的两个例外不是"无门槛可做":**Ship**=exact-head founder gate(§1.6);**不可逆删除**=独立 capability + 预览范围 + 审计的专用 gate(§2.6)。

## 0.5 消息通道选型依据 [A]
历史:最早抄 cc 的 JSON 信箱→规模化后崩溃(整文件重写)→为此造 SQLite→后来文件信箱又被加回,双轨至今。
**决定:唯一消息通道 = SQLite 信箱(comm.db 瘦身版);JSON 信箱文件退役。**
规模故事(选型必答):SQLite 行级 append+WAL 顺序写,读取按 consumed 游标,永不重写旧内容;写入 O(1) 不随信箱体积退化。它的死法是"只进不出"(lead_inbox 3.8 万行实证)——因此信箱表带强制 retention(消费后 N 天删除,未消费超期转 obligation)。
**元规则:本稿每个选型均须写明规模故事——到什么量级、会怎么死。**

## 1. 数据层
### 1.1 权威库 9 张表(8 概念 + obligations)[R1-3]
沿用 v1 的 tasks/task_dependencies/attempts/events/commands/gates/capabilities/source_receipts,修订如下:
- **commands 状态机重写** [R1-2]:`state ∈ CHECK('pending','claimed','accepted','executing','succeeded','failed')`;
  字段增 `accepted_at, completed_at`(分离);`acked_at` 废除。
  语义:claimed=executor 领取(带 lease);accepted=已接收**尚未产生副作用**;executing=已写 effect intent;succeeded/failed=仅由 effect receipt 或 terminal observation 驱动。
  崩溃规则:accepted 后崩溃→lease 过期→reconcile(查 effect intent/receipt)→无 intent 则安全重放,有 intent 无 receipt 则先对账;effect_unknown 永不猜测重发。
- **新表 obligations** [R1-3]:`(id, kind, target_task_id, target_attempt_generation, root_episode_id, parent_obligation_id, depth CHECK(depth IN (0,1)), state ∈ ('open','resolved','tombstoned'), opened_at, resolved_at, tombstoned_at, resolution, resolver_capability_id)`
  - parent 为 obligation 时禁止再建(depth CHECK + 触发器);target 终态→同事务 tombstone;
  - 告警/待决事项的唯一权威;founder page 的 delivery 走 commands(confirmed-sent receipt 才记 ledger)。
- **epoch 字段** [R1-9]:`commands.cutover_epoch`、`events.cutover_epoch`、observation envelope 必带 `cutover_epoch`;当前 epoch 持久化于 `meta(key='cutover_epoch')`;kernel 对 mismatch fail-closed。
- **events 归档协议** [R1-8]:月度冷文件 = 单事务内 (SELECT 段→写冷文件→写 manifest{seq_range,sha256,row_count}→校验回读→DELETE 段);幂等键=seq_range;冷文件只读+校验和;`archive_manifest` 表登记。冷区 reader:按 manifest 定位文件,kernel 提供跨冷热 `events_read(seq_from)` 视图;transcript_cursor 指向冷区时经该视图 replay;超 14 天长任务恢复走同一视图,不因归档失忆。
### 1.2 信箱(comm.db 瘦身)[A][R1-6]
只留 `mailbox(id, to_agent, kind, payload, created_at, consumed_at, retention_class)`。
**canonical inbound key** [R1-6/P3]:每条 Discord 入站消息 = 唯一 `source_receipts(source_kind='discord_msg', source_id=<message_id>)` 一行;delivery receipt 由机器 ack;**仅当存在可路由业务目标**(待批 gate/待答问题)才由 kernel 建 obligation——chat:/founder_msg: 双 producer 废除。
### 1.3 执行所有权 [R1-4]
**每个 command.kind 有且只有一个 executor class**:`spawn/terminate`→process-dispatcher;`discord_post/thread`→discord-projector(定义为 dispatcher 的专用 adapter,同一 claim loop);`github_*`→github-projector;`linear_*`→linear-projector。全部 executor 经 **kernel observation API** 提交结果,无直接 DB 写权。启动顺序修正:kernel→dispatcher(含各 projector adapter)→observer→runner supervisor。

## 2. 引擎
### 2.1 三层分工(同 v1,LLM 提议/kernel 校验/dispatcher 执行)
**结果分类法** [R1-6/P8]:kernel/executor 的机器枚举结果 `stale|policy_denied|noop|retryable_failure|effect_unknown|succeeded`;前三类**返回调用方并结清 command,永不生成 alert**;retryable 走重试预算;effect_unknown 走 reconcile。
### 2.2 派发协议(同 v1,R1 判定正确吸收,不动)
### 2.3 探针(同 v1)
### 2.4 resume(同 v1 + command 状态机消歧 [R1-2]:runner 的"接收确认"=accepted,不是完成;完成只由 effect receipt 驱动)
### 2.5 逆向打回 = rework saga(全文重写)[R1-1]
- 目标 task 已 terminal → **不重开**;创建 successor task,带 `rework_of=<old_task_id>`(tasks 增列 rework_of,lineage 可查);terminal 单调性无冲突。
- 同一 kernel 事务:关闭旧 active attempt(desired=terminal)+ 下游 attempts desired 置 canceled/superseded + 撤销下游 capabilities/gates + 写 terminate/reconcile commands。
- **写者交接护栏**:旧 writer 未被同 host_epoch 明确观测 absent 前,不向冲突 worktree 授新 writer。
- 外部 effect 三分类:可补偿(Discord 帖→追加更正)/仅 forward-repair(Linear 状态→重投影)/不可逆(merge、删除→不进入自动 saga,走独立高权限 gate)。
- 旧代码处置:**不设"默认丢弃"**;Lead 在 saga 里显式选择 keep-branch/discard,discard 属不可逆类需专用 gate。
### 2.6 旁路分级(同 v1)+ 不可逆删除 gate [R1-11]:独立 capability(audience=founder)、操作前预览清单、审计。
### 2.7 凭据生命周期(同 v1)
### 2.8 Lead 可靠性协议(新增)[R1-7]
- supervisor=launchd(KeepAlive)持续监督 Lead;Lead 注册 `lead_generation`(权威库),新进程 generation+1;
- kernel 拒绝旧 generation 的 Lead 提议(旧进程复活≠双写者);
- Lead 的 durable cursor:`lead_cursor(lead_id, last_event_seq, last_mailbox_id)` 落权威库;crash 恢复=从 cursor 重放未处理 events/mailbox/obligations(transcript 是会话记忆,cursor 是义务账);
- Lead 不可用时:dispatcher/probe/告警照常(不依赖 Lead);需要 Lead 判断的事项积累为 obligations 等它回来;Ship 类动作 fail closed。
### 2.9 notify-then-do 的机器化 [R1-5]
- 需先知会的 action:kernel 建立 `notification command → action command` 的 durable dependency;
- action 仅在 notification 的 confirmed-sent receipt 到账后可被 claim;
- 通知发送 effect_unknown → 先 reconcile,禁止猜测重发或跳过;retry 用稳定 effect_key;
- 豁免 allowlist 明确列举(纯只读查询等),Ship/不可逆删除各走强 gate(§0)。

## 3. 告警(修订)
- 权威落点=obligations 表(§1.1);detector **只读+向 kernel 提 proposal**,写入由 kernel 原子完成 [R1-判定3.2];
- depth/tombstone/confirmed-ledger 语义由 schema 强制;
- 结果分类法(§2.1)保证 expected denial 永不进告警;
- 只报三类事(founder 决定在等/执行体死了没人管/权威账与现实矛盾),且第三类的判定必须引用具体 observation 证据。
### 3.1 Discord 唯一窗口契约 [R1-HIGH3]
`thread_bindings(project_id, task_id, thread_id, state)` 入权威库;founder ingress/Lead 回复/Runner 转达一律走绑定 thread;缺失时由 discord-projector 幂等重建;这是"Discord 唯一窗口"的机器形态。

## 4. 切换手册(修订)[R1-9/10]
九步同 v1,补齐:
- 步1 预演增:row counts/状态映射/FK+唯一性/业务 invariant 对账清单;
- 步2 冻结增:持久化 cutover intent(meta 表);每个不能 drain 的在途形成 durable checkpoint 行;
- 步5 迁移增:`PRAGMA foreign_key_check` + 业务 invariant queries(每 task ≤1 active attempt 等);
- 步6 重置增:旧共享 API token 一并列入拒绝清单;
- 步7 epoch:如 §1.1,字段级落地;
- 步8 启动:kernel→dispatcher(含 projectors)→observer→runner supervisor;
- 旧库切换后 chmod 只读归档。
**Go/No-Go 七条(逐字)**:①所有旧 writer PID/tmux/daemon 已退出 ②旧 API token 与旧 capability 被拒 ③每个 active task 至多一个 active attempt ④每个 dispatch command 有唯一 generation/effect key ⑤每个 in-flight external effect 要么有 receipt 要么进入 reconcile ⑥所有 migrated gate 绑定 exact subject/head ⑦v2 DB 权限、integrity、FK、WAL backup 测试通过。

## 5. 病例回归矩阵(细化)[R1-10]
- P1/P4/P11→单一权威+observation ingress+投影幂等重建(验收:kill 任一投影后重放一致)
- P2→outbox 派发+三态探针(验收:spawn 后立杀进程,60s 内 attempt observed=absent 且重派或 obligation)
- P3→canonical source key(验收:同一 Discord 消息在 source_receipts 恰一行;无业务目标不产生 obligation)
- P5→obligations depth CHECK(验收:构造告警的告警,INSERT 被 CHECK 拒绝)
- P6/P7/P9→同 v1(P7 验收:旧共享 token 调 founder 端点得 403)
- P8→结果分类法(验收:policy_denied 类 command 结清且零 alert 行)
- P10→rework saga 的显式 escape transition(验收:人为制造 carrier 错位,一条 saga 命令在 N 分钟内改道,全程审计)
- P12→逃生门可达性回归测试(验收:每个声明的 bypass 有自动化测试证明真实可达)
- 诚实基线保留:非"6 概念活跃双写"/非"全机制无旁路"/confirmed pages=3683/P3 为"可能双建"。
