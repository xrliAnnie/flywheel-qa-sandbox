# FLY-1499 消息消费循环 — v2 终稿映射
Issue: FLY-1499
日期: 2026-07-27
基于: plan.md

## 0. 本文地位

本文只做一件事：把 Founder 已批准的 v2 收敛终稿映射到 FLY-1499 当前实现，逐项说明哪些保留、哪些整块删除、哪些补齐。本文通过增量设计评审后，成为本单后续实现的直接依据；旧 `plan.md` 与本文冲突处全部由本文取代。

终稿证据已固化为同目录 `v2-converged-final-source.md`；它是 `/tmp/v2arch/v2-final-design.html`
（SHA-256 `e0078266d1bb852a17e484d9aea0b7f14ad076a9f48c79bac9394f463f334b17`）的正文导出并记录 Founder
随后对四个红项的全部采纳。当前实现快照为提交 `42019be7/821d91bd`。

Founder 已确认默认采纳终稿裁决台中的四项：actions 黑匣子、心跳列、世代号保险丝、完成事务内查询并把批准落库的 ship 门。其中 FLY-1499 只实现消息层、心跳写侧和世代消费 fence；actions、ship 门及调度重启逻辑不在本单。

终稿正文把 heartbeat 画在 mailbox 附近，没有给 current generation 一个可约束的实体。Founder 采纳世代号后，Lead
在本单定案新增最小 `agents` 侧表，专门承载**地址存在性 + current generation + heartbeat**。这是终稿之后的显式
结构澄清，不是执行者注册/认领：它不保存 task、owner、activation、claim 或工作状态。

原 FLY-1499 两条前置台账保持已评审结论，不因终稿映射重开：

- STAT4：四路候选继续用 `INDEXED BY` pin 对应 VIP/非 VIP partial index，保留无统计与带 STAT4 统计的 query-plan 矩阵；
- 写入面 SQL 守卫：按 brainstorm gate 的反 over-reaction 裁决，维持 1497 已加固的现有关键字层，不继续追逐对抗变体，不新增语句注册表，也不在本单重做完整类型化写 API。

本轮不重新讨论大方向：

- 拉取模型固定为每个 agent 的壳按 config 中的默认 1 秒周期查询自己名字；
- 没有门铃、投递泵、watchdog、SLA 档位或 `T_deliver`；
- 处理完才销账，mailbox 与产物在同一 SQLite 事务中提交；
- 世代号只做僵尸旧会话写入保险丝，不承担 owner/病历卡语义；
- C5 `InjectionShim` 接口保持冻结，vendor 投递实现归 FLY-1501。

## 1. 终稿要求到 FLY-1499 的逐项映射

| 终稿要求 | 当前证据 | 映射结论 |
|---|---|---|
| 一张 SQLite `mailbox`，按 `to_agent` 拉取 | v2-kernel `0001-base-schema.ts` 已建表；engine `enqueue.ts` 已写入 | 保留表与 canonical source 去重；`to_agent` 改为 FK 指向 typed address `agents.agent_id`；删“必须在线/active 才可入队”的门。地址分配事务可先建 generation=0/offline 行再入信，因此从未启动过但已分配地址的收件人也能冷启动 |
| `processing_attempts` 记录每次成/败/崩 | v2-kernel `0003-activations-processing-attempts.ts`；engine `transitions.ts`/`registration.ts` | 整体保留；authority 只用 `agent_id + generation`，instance/activation 留在处理账作审计，crash 重放 exactly-once。Lead/runner 的 attempt 都只覆盖“消息→durable proposal/task/failure”的短转化，绝不覆盖 TDD 工作或 gate 等待 |
| batch=1，处理并结算后逐条重查，空了才睡 | `ConsumerCoordinator` 的 Lead 分支已逐条 `start → convert → settle → requery` | 保留串行核心；入口从 `ring()/dirty` 改成壳显式 `poll/drain`，不再由门铃或全局 tick 驱动 |
| 每个 agent 壳默认每 1 秒 SELECT 自己名字 | 当前只有 30s Lead pull、60s tick、runner delivery pump | 删除旧三路唤醒；新增显式 poll API。1 秒只是 config 的默认值，壳负责独立 cadence；消息 handler 正忙时 cadence loop 仍继续 poll，但只刷新/观察同一 in-flight，不取第二条、不重复交给 converter/shim |
| poll 捎带写 `last_poll_at`，调度只读 | 当前没有 `agents` 表或心跳列 | 新建一行一个收件人的 `agents` 表；empty/busy/new 三种 poll 都验证 generation。heartbeat 按 config 合并写，健康 busy agent 仍持续推进；调度另读 durable running attempt age，超过单一 config 上限仍判 handler wedged。它不靠进程内 timer/watchdog |
| Founder/VIP 有界优先 + 超龄晋升，参数进 config | 四路 exact SQL、`selectNext`、K=4/30min 已完成；STAT4 测试已 pin index | 保留四路 SQL、STAT4 断言和选择器；K 与 promotion age 改为从 durable config 读取，不由隐藏默认决定 |
| 第 N 次失败 dead，必须有人知道；N 进 config | 当前 N=5 是 `MAX_ATTEMPTS` 常量；只写 dead event | 删除硬编码 `MAX_ATTEMPTS`；N 从 config 读取。第 N 次原信 dead，并给该 `agents.agent_id` 写唯一 dead-letter event；FLY-1501 消费该事件，通知时按 DAG 现查 manager，绝不存 owner 镜像 |
| 处理结果与销账同事务 | `submitProposal` 已原子写 effect/event + mailbox applied + attempt succeeded | 原样保留并继续做 attempt/identity 全字段绑定 |
| 失败/崩溃不丢信 | failure retry 与 registration crash settlement 已覆盖 | 保留；退避参数从 config 读，注册 cutover 仍先精确收 running 账再换世代 |
| 世代号为接班保险丝 | 当前 `consumer_registry:*` meta JSON + 全写面 exact identity fence 已完成 | `agents` 成为 current authority 的唯一真相，fence 收敛为 `agent_id + generation`；meta consumer registry 删除；instance/activation 只作历史审计；删除 C4 `ownerLeadId` |
| 无门铃/无 30s 投递扫描 | engine 当前仍有 `ring`、Lead pull timer、runner pump/retry timer | 整块删除，不保留兼容路径 |
| 无 watchdog、无档位、无 SLA 公式族 | `driver.ts` 有 deliver/convert phase timer；`fairness-sla.test.ts` 有 585min 公式 | 整块删除 phase timers、注入 marker、`T_max/T_deliver/T_switch/T_tick` 及公式测试；保留公平性行为测试 |
| 垫片归 FLY-1501，C5 接口冻结 | `InjectionShim` 已是 `hint + deliver` 两方法 | 类型定义与精确 API 形状保留；engine 不再持有 shim、不调用 hint/deliver、不测试 vendor 投递行为 |
| 没有派发器/执行者注册/认领 | `enqueue` 当前把 live registry 当 admission；driver 把 attach 当投递承载者 | `agents` 只保存 typed address/current generation/runtime heartbeat；`provisionAgentRecipient` 是地址分配而非执行注册，入队不以 online/active 为前提，attach 不再携带 shim 或触发“注册必拉” |
| 离线 agent 的信留库，调度按 pending 拉起 | `disposeTerminalRecipient` 会把 terminal runner 的 pending 信改投/dead/tombstone | 删除 terminal-recipient disposal 整块；下线不是销毁信箱。dead 只由单封消息达到 config 中的失败上限产生 |

## 2. 逐模块处置

### 2.1 v2-kernel

| 文件/导出 | 处置 | 说明 |
|---|---|---|
| schema migration | 新增 | 以 `fkMode:'rebuild'` 建 `agents`/`config` 并重建 mailbox。先从合法 `consumer_registry:*` 物化 agents，再验证无 orphan recipient/旧 tombstoned 行；显式复制原 `seq` 与全部列，DROP old → RENAME new → 复建 **7 个** mailbox 命名索引并校准 `sqlite_sequence`，最后由 migrator 在同一迁移提交前跑 `foreign_key_check`，覆盖 `processing_attempts → mailbox` 入边。任一验证失败整笔回滚 |
| `agents` integrity | 新增 | `agents(agent_id TEXT PRIMARY KEY NOT NULL, kind TEXT CHECK(lead|runner), generation INTEGER CHECK(generation>=0), last_poll_at TEXT, state TEXT CHECK(online|offline))`。精确 trigger：任意 DELETE 拒绝；`UPDATE OF agent_id` 值变化拒绝；`UPDATE OF kind` 值变化拒绝；`UPDATE OF generation WHEN NEW.generation < OLD.generation` 拒绝。相等 generation 的 heartbeat/offline UPDATE 合法；注册 API 另以 `WHERE generation=@old` CAS 只允许 `old+1`。行不可删除所以旧 generation 不能从 1 复用；generation=0 表示“地址已分配但从未注册”，第一次注册升 1 |
| `config` integrity | 新增 | `config(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)`；值域与交叉约束由 engine 在使用事务内统一校验，migration 不复制已删除 SLA key |
| consumer registry meta API | 删除/收敛 | `consumerRegistryKey` 与 consumer `readRegistry/writeRegistry/identitiesEqual` 调用全部由 typed agents SQL 取代；`agents(agent_id,generation)` 是消息 authority 的唯一来源，不保留镜像 JSON |
| connection-state SQL guard | 不改 | 两轮绕过属于已声明威胁模型外的对抗构造；本单不加固 blocklist、不加 allowlist/语句注册表、不扩成 per-table typed API，继续由已有回归测试守住无意误用合同 |
| `src/sql/candidates.ts` | 保留 | F1/F2/N1/N2 四路 exact SQL 和 `INDEXED BY` 是 STAT4 下保持 VIP 分区的必要机制；继续返回 `created_at` 供晋升 |
| query-plan / STAT4 tests | 保留 | 同时覆盖空统计与带 STAT4 统计；F1/F2/N1/N2 精确命中各自 partial index，detector 继续命中 `mailbox_pending_age`，不把 planner 偶然选择当合同 |
| `FENCE.mailboxCasScheduleRetry` | 保留 | 失败未达 N 时原子递增并设 due |
| `FENCE.mailboxCasFailureDead` | 保留并由 engine 组合 | 原信 dead + retry_count 递增；dead-letter event 在同一外层事务写 |
| `FENCE.mailboxCasDisposalDead` | 删除 | 只服务将被删除的 terminal disposal |
| `FENCE.mailboxCasDisposalTombstoned` | 删除 | 只服务将被删除的 terminal disposal |
| `FENCE.mailboxCasRedirect` | 删除 | terminal disposal 的整行换收件人语义与“离线信留库”冲突；dead-letter 只升级，不改投 |

### 2.2 `types.ts`

保留：

- `AttemptHandle`、proposal/effect/result/converter 类型；
- `DeathEvidence`、`IdentityDraft`、`RegisteredAgent`（由现役 `RegisteredConsumer` 重命名）；
- proposal 大小与字段安全上限；
- C5 `InjectionShim` 的精确两方法形状。

修改：

- `EngineConfig` 收敛为消息层参数：poll interval、heartbeat write interval、heartbeat stale age、running-attempt max age、cold-start alert age、VIP burst、promotion age、max attempts、retry base/cap、notice pending limit；
- 这些值由 SQLite `config` 行提供；TypeScript 默认对象只用于 bootstrap seed/测试 fixture，不是第二份运行时真相；
- 删除 `tMaxMs`、`tTickMs`、`tDeliverTotMs`、`tSwitchMs`、`leadPullIntervalMs`；
- 删除硬编码 `MAX_ATTEMPTS`；
- `RunnerIdentityDraft` 删除 `ownerLeadId`；
- 新增最小 `ConsumerAuthority { agentId, kind, generation }`；消息 handle/fence 只依赖这三项；
- instanceId/activationId 可随 attempt audit 输入保留，但不进入 authority equality 或 agents；
- `DeathEvidence` 改为 dead `agentId + generation + confirmedAbsentAt`，不再声称 instance/activation 是 current fence；
- 删除只为内部 timer 服务的 `EngineScheduler`/`CancelTimer`；
- 新增 `PollResult` union：`available` 携带至多一条新 started 消息；`busy` 只回当前
  `attemptUid`（禁止重新交付）；`empty` 携带本次 config snapshot 的 `retryAfterMs=pollIntervalMs`。
  三者都不携带 vendor 状态；
- 新增 `PollTransientError`（仅包装 SQLite `BUSY/LOCKED`）与 `EngineConfigError`。壳对前者沿用最近一次
  成功 cadence 重试；后者、unknown agent、generation fence 失败均 fail-loud 退出，交 supervisor 暴露，
  不把 authority/config 错误伪装成空信箱。

### 2.3 `bootstrap.ts` / `sql.ts`

schema 由 v2-kernel migration 建；engine bootstrap 只 seed/configure，不在运行时 `CREATE TABLE`。补齐：

- durable `config` 的消息层 seed，重复 bootstrap 不覆盖人工配置；
- `agents` 恰包含消息层所需 current authority：`agent_id` 主键、`kind CHECK(lead|runner)`、`generation`、`last_poll_at`、`state CHECK(online|offline)`；不加 instance/activation/owner/task/phase；
- `provisionAgentRecipient(agentId,kind)` 是唯一 mailbox-first 地址创建入口：同一写事务
  `INSERT ... generation=0,last_poll_at=NULL,state='offline' ON CONFLICT DO NOTHING` 后逐字段 read-back；
  异 kind collision fail-loud。engine 只能验证 typed row/冲突，不能验证“这个名字能否被拉起”；地址真实性
  由 §6 的 DAG/调度 address-allocation 合同负责，任意字符串不是合法上游输入。分配一个地址时先 provision
  再 enqueue；它不创建 task/attempt/session、不拉进程、不 claim 工作。若上游 allocator 仍出错，
  generation=0/offline 且有 pending 超过 `coldStartAlertAfterMs` 由调度 fail-loud 并通知 founder，
  禁止无限静默 kickstart；
- 注册同样支持 self-first：行不存在时原子 `INSERT generation=1,state='online'`；已存在 generation=0 或更高时
  只做 `generation=current+1` CAS。这样新进程首次自启与“先来信、后冷启”两条顺序都不死锁；
- poll 先做短只读 fast path；该读 façade 不开 `BEGIN`，只提供尽力而为早退，不承诺多条 SELECT
  的一致快照。只有 heartbeat 已超过 `heartbeatWriteIntervalMs` 或可能 start 新 attempt 时才开
  `BEGIN IMMEDIATE`，并在写事务内重读 config/authority/running/candidates。heartbeat 只 UPDATE 已存在的
  current `agent_id + generation` 行；unknown/generation mismatch 零行一律 fail-closed，禁止 poll upsert authority；
- busy poll 必须刷新到期 heartbeat，返回 `busy`，不取第二条也不把同一 handle 再交给 handler；
- 第 N 次失败时写唯一 dead-letter event：确定性 `event_uid='mailbox:<message_uid>:dead'`，`source_kind='agent'`、`source_id=agent_id`，payload 带 message/attempt/generation；runner 的通知归属由 activation/attempt/task/DAG 现查，Lead 的通知对象固定为 founder，孤儿归属 fail-loud + founder；
- config 读取必须 fail-closed：缺键、非整数、非正数或互相矛盾均不开始新 attempt。

删除：

- 注入 marker `pa.injected` 的专用读写；
- delivery timeout/phase timer 所需查询；
- terminal disposal 专用查询。

### 2.4 `candidates.ts`

保留选择算法与四路候选：

1. 已连续服务 VIP 达 K 且存在普通消息时，强制普通消息；
2. 普通消息超 promotion age 后进入 VIP class；
3. class 内按 `created_at, seq` 决定；
4. 重启初值继续保守设为 K，先偿还一次普通消息机会。

修改仅限参数来源与命名：`founder` 是现有 `source_kind='founder'` 的 VIP 分类事实，K/promotion age 来自本次 poll 读到的 config snapshot。

### 2.5 `transitions.ts` / `settlement.ts`

保留：

- `requireActiveConsumerTx` 改为只查 `agents(agent_id,generation)` 的 `requireCurrentGenerationTx`；`state` 供调度观察，不作为消息写 fence；
- per-recipient 单在途检查、same-agent+generation resume；
- success proposal 按 attempt uid/message/agent/generation 绑定、effects + applied + attempt success 原子提交；
- explicit failure 与 crash 共享失败账；
- 迟到 success/failure 对已结 attempt fail-closed。

修改：

- `settleFailureMailboxTx` 读取 config 的 max attempts 与 retry 参数；
- 达到 N 时同事务：原 attempt failed/crashed、原 mailbox dead、按 `agent_id` 追加唯一 dead-letter event；
- dead-letter 消费/通知时不读 owner 镜像：runner 经当前 attempt/activation → task → issue/DAG 查该 issue 的 Lead；Lead 直接升级给 founder；归属链缺失时记录 orphan 事实并通知 founder，不猜；
- dead event 使用按 message 稳定的 `event_uid` 并在冲突时逐字段 read-back；同一死亡事务重放只能命中同一事实，碰到异形 collision 必须整笔回滚；
- success/failure commit 后不 `ring`；壳在处理结束后直接再次 poll，兑现喝干循环。

删除：

- `recordInjectedTx`；
- `reportDeliveryTimeoutTx`；
- `pa.injected` marker 及其时间锚/read-back 矩阵；
- Lead start 时自动写 injected marker。

### 2.6 `registration.ts`

保留：

- generation 只在事务内从 durable current 值单调 `+1` 分配，调用方不能指定；agents 行永不 DELETE，
  generation 永不回退或复用；
- old generation 必须有匹配 `agent_id + generation` 的 `DeathEvidence`；
- old generation 的 running attempts 在同一 cutover 事务结 crash；
- 同 agent 的其他 generation running 行 fail-loud；
- 外层组合事务回滚零残留。

删除：

- `ownerLeadId` 输入、校验、写入和 C4 skip；
- meta `consumer_registry:*` 读写与 instance/activation current equality；
- “注册 commit 后立刻 ring/装 timer”的合同。

注册事务的三路写死：

1. 行不存在：`INSERT generation=1,state='online',last_poll_at=NULL`；
2. generation=0/offline 预配地址：CAS 到 generation=1/online；
3. generation≥1：必须有匹配旧 `agent_id + generation` 的 DeathEvidence，先精确结旧账，再 CAS
   `generation=old+1,state='online',last_poll_at=NULL`。

instance/activation 进入 `processing_attempts`/`activations` 审计面。第一轮工作由壳立即 poll 触发；之后 empty
poll 返回 config 当前 sleep，默认 1 秒。注册与 poll 并发由 SQLite 写串行和 generation fence 裁决；任何
回退由 schema trigger + API 双拒；跳号由只写 `old+1` 的 CAS API 拒绝；删除后从 1 复用由
no-delete trigger 结构性排除。heartbeat 与 offline CAS 不改 generation，必须正常通过。

### 2.7 `consume-loop.ts`

保留并收窄为纯消费状态机：

- 同一 agent 进程内 handler single-flight；heartbeat poll 不被 handler Promise 阻塞；
- cadence loop 或 settlement 后的 handler loop 任一方收到 `available`，都必须先把该 handle 移交同一个
  handler single-flight 才能睡眠/返回；Lead 由包内 coordinator 调 converter，runner 由 FLY-1501 壳调
  C5 shim。single-flight 以 attempt uid 去重；
- resume 既有 running 优先；
- 无在途时读取四路候选并只 start 一条；
- Lead converter 成功/失败结算后立刻逐条重查直到空；
- runner poll 至多返回一条 durable started/resumed 消息给壳。

整块删除：

- `ring()`、`dirty`、ring storm 合并；
- runner mode 持有 `InjectionShim`/sessionRef；
- `#pumpRunner`、`#boundedDeliver`、delivery rounds、retry/delivery timers；
- injected hooks 与任何外部 vendor 调用。

### 2.8 `driver.ts`

保留：

- agent → current coordinator map；
- register/cutover 与 attach 的同 agent 串行化；
- durable `agents` 行的 `agent_id + generation` 是 coordinator replacement 的唯一裁判；
- proposal/failure 入口核对 current coordinator identity；
- stop 清理内存 coordinator。

修改：

- `attachRunner(agent, identity)` 不再接 shim，也不触发 deliver；
- 新增壳调用的显式 `poll(agent,currentAttemptUid?)`；cadence loop 与 handler loop 独立。busy 时传当前 attempt，
  engine 验证与 durable running 行一致、按合并间隔刷新 heartbeat、返回 `busy`，绝不 deliver/convert；
- `currentAttemptUid` 是可过期提示，不是 authority：若它在 poll 落地前已经 terminal，或 durable running
  已换成另一条，engine 不抛 fence；丢弃旧提示并走常规 resume/select。返回的 `available` 仍交同一个
  attempt-uid single-flight，正常 settlement 与并发 cadence 不能把健康 agent 杀掉或重复处理；
- `poll` 的 empty 结果返回本事务读取的 `retryAfterMs`；壳按它睡眠后再 poll，有信及每次 settlement 后均立即再 poll；
- Lead 的 `drain(agent)` 在一次壳 poll 后可持续处理至空；
- runner 的 poll result 由 FLY-1501 壳交给冻结的 C5 shim；
- settlement 后壳直接继续 poll，不依赖 owner-route/ring。
- graceful `stop()` 在一个事务内对该 current generation 自有 running attempt 结 `crashed` 并复用失败账，
  再 CAS `state='offline'`；随后才清 coordinator。迟到 handler 因 attempt 已 terminal 而 fail-closed，旧
  generation 的迟到 stop 不得改新世代。进程硬 crash 不会写 offline，调度侧用 stale heartbeat 识别并
  在新 generation cutover 收账。

删除：

- constructor 全局 tick；
- Lead 周期 pull timer；
- phase timer registry、deliver/convert phase、`onTMaxExceeded`；
- `tick()` 与 restart timer rebuild；
- 注册必拉与任何 hint。

### 2.9 `enqueue.ts`

保留：

- 输入/cutover epoch 校验；
- canonical `(source_kind, source_id)` 去重与 digest 冲突；
- notice overload、business 不因 notice 水位拒绝；
- 入队单事务。

修改：

- notice 上限从 config 读；计数 SQL 改为
  `SELECT count(*) FROM (SELECT 1 ... LIMIT @probeLimit)`，其中安全校验后的
  `probeLimit=noticePendingLimit+1`，判据 `count > noticePendingLimit`，禁止残留 501/500 字面量；
- 删除 live registry/activation routability 校验。`agents` 中不存在的名字由
  `EnqueueResult {status:'rejected',reason:'unknown_recipient'}` 拒绝
  （FK 仍作最后防线）；调用方若在分配新地址后先发信，必须在同一业务流程先
  `provisionAgentRecipient`，且该名字必须来自 §6 的 DAG/调度 address allocator。已存在但
  offline 或暂无 active activation 的收件人仍可入队，调度按 pending + heartbeat 冷启动；generation=0
  地址过 `coldStartAlertAfterMs` 仍未注册必须通知 founder；
- 不在入队后发 hint。

### 2.10 `disposal.ts`

整文件及公开导出删除。理由不是“代码暂时不用”，而是其语义与终稿冲突：

- terminal activation 不等于 agent 永久不可达；
- 下线 mailbox 必须保留，供调度冷启动；
- notice 不应因会话结束自动 tombstone；
- business/dlq 不应在未经历 N 次处理失败时被 dead 或升级。

旧 running attempt 的收账归 generation cutover/crash 路径；单封消息的 dead + 升级 event 归失败上限路径。

### 2.11 `index.ts` / public API

目标 runtime value 恰等集合（逐符号）：

- `DEFAULT_ENGINE_CONFIG`、`EngineConfigError`、`PollTransientError`；
- `EngineDriver`；
- `initializeEngineDb`、`provisionAgentRecipient`、`enqueue`、`registerAgentTx`；
- `reportConversionFailure`、`submitProposal`、`selectNext`；
- `MAX_EFFECTS_PER_PROPOSAL`、`MAX_FIELD_BYTES`、`MAX_PROPOSAL_TOTAL_BYTES`。

目标 root type 集合：

- `Candidate`/`CandidateLane`/`CandidateSet`；
- `ConsumerAuthority`、`IdentityDraft`、`LeadIdentityDraft`、`RunnerIdentityDraft`、
  `RegisteredAgent`、`DeathEvidence`；
- `AttemptHandle`、`PollResult`、`ConversionProposal`/`ConversionResult`/`Converter`、`Effect`；
- `MailboxEnvelope`/`EnqueueResult`；
- `EngineClock`/`EngineConfig`/`EngineRuntime`；
- C5 `InjectionShim`（精确原形不变）。

显式删除的既有根导出：

- `ConsumerCoordinator`（变为包内 handler single-flight 实现）；
- `ENGINE_SQL`（变为包内 SQL 拼装基元；此前实际误公开，本轮显式收口）；
- `registerConsumerTx`（重命名 `registerAgentTx`，语义是 generation cutover，不是执行者 registry）；
- `RegisteredConsumer` type（重命名 `RegisteredAgent`）；
- `AttemptStart` type（由 `PollResult` 完整取代）；
- `disposeTerminalRecipient`/`DisposalReport`；
- `CancelTimer`/`EngineScheduler` 及 timer/SLA 类型；
- `MAX_ATTEMPTS`；
- 任何 injected/delivery timeout 内部基元。

`api-surface.test.ts` 与 public type fixture 对上述集合做恰等/可导入断言，package subpath 继续全部关闭。

## 3. 目标消息流

### 3.1 空闲 poll

1. 壳启动后立即开启独立 cadence loop 调 `poll(agent,currentAttemptUid?)`；该 loop 不 await handler
   完成。上一轮若返回 empty，则按其 `retryAfterMs` 再调，默认 1000ms。
2. engine 先读 config/authority/running；fast path 只是无写、可撕裂的早退提示。任何 start、heartbeat、
   generation fence 或其他状态改变都在写事务重读后裁决。
3. 若调用方带来的旧 attempt uid 已 terminal/被下一条替代，视为过期提示而非错误，继续常规流程。
4. 若已有本世代 running attempt，返回同一 handle；否则执行 F1/F2/N1/N2 四路查询并按 config 公平参数选择至多一条。
5. 任一 loop 收到 `available` 都必须先移交共享的 attempt-uid single-flight；无候选才返回
   `{ status:'empty', retryAfterMs:config.pollIntervalMs }`。不启动 LLM、不发门铃、不建 timer。

### 3.2 Lead 喝干

1. poll start/resume 一条；
2. converter 只做“消息 → proposal/failure”；
3. converter 运行期间 cadence loop 继续 poll；engine 返回 `busy` 并只刷新到期 heartbeat，不再次调用 converter；
4. success 在同一事务写产物、mailbox applied、attempt succeeded；failure 写 attempt failed 并 retry/dead；
5. 结算返回后 handler loop 立即再次 poll，直到 empty；cadence loop 与 handler loop 共享同一 coordinator
   single-flight 状态，但不共享一个被 converter Promise 占住的串行锁。
6. **全局不变量**：Lead 与 runner 的 mailbox handler 都只承担“消息 → durable
   proposal/task/failure”的短转化，必须在 `runningAttemptMaxAgeMs` 内结算；TDD 实现、human gate、
   vendor 长工作等小时/天级工作在结算产出的 task/attempt 上继续，绝不占住 mailbox processing attempt。
   若转化 Promise 卡死但 cadence 仍活，调度按 durable `processing_attempts.started_at` 超龄切换世代，
   不等 heartbeat 停、不建进程内 phase timer。

### 3.3 Runner

1. FLY-1501 的 agent 壳按相同 poll API 取得至多一条 started/resumed 消息；无论是 cadence 还是 settlement
   后立即 poll 得到 `available`，都在返回/睡眠前移交同一个 attempt-uid single-flight；
2. 壳用冻结 C5 shim 做 vendor 投递；FLY-1499 不调用 shim、不观察 vendor 状态，也不建独立
   per-vendor delivery timer。全局 `runningAttemptMaxAgeMs` 只约束本段“吸收消息并形成 durable
   proposal/task/failure”的转化窗口，不约束后续 vendor task；
3. C5 吸收/转化期间 cadence loop 传 `currentAttemptUid`；`busy` 结果只证明 heartbeat/绑定仍有效，
   绝不再次 deliver；
4. runner 在 shim 确认消息已被 durable 吸收后，用 handle 立即提交 proposal/failure，先结 mailbox
   processing attempt；TDD、gate、human wait 等长工作只在该 proposal 产生的 task/attempt 上继续；
5. agent + generation + attempt binding 拒绝迟到结算；同一转化窗口不取第二条。崩溃后 cadence 停止，
   新 generation cutover 精确结 crash，再重试原 mailbox。

### 3.4 第 N 次失败

同一事务内：

1. 当前 running attempt 结 failed/crashed；
2. 原 mailbox `retry_count += 1` 并转 dead；
3. 追加唯一 `mailbox.dead` event，作为后续升级通知的 durable source；
4. event 用 `source_kind='agent' / source_id=agent_id` 绑定收件人，payload 只放 `message_uid/attempt_uid/generation`，不保存 owner；通知方读取 event 时按 DAG 现查 runner 所属 issue 的 Lead，Lead 收件人则升级 founder；
5. DAG 归属缺失时写 orphan 事实并升级 founder，不猜 owner；
6. 任一步冲突或失败，整笔回滚；重放只得到一个 dead 事实和一个升级 event。

## 4. 配置合同

消息层至少使用这些 durable config key：

| key | 默认值 | 用途 |
|---|---:|---|
| `mailbox.poll_interval_ms` | 1000 | 壳的空闲轮询周期 |
| `mailbox.heartbeat_write_interval_ms` | 5000 | poll 心跳合并写周期 |
| `mailbox.heartbeat_stale_after_ms` | 30000 | pending + 心跳超过此年龄时调度判进程 stale |
| `mailbox.running_attempt_max_age_ms` | 1800000 | handler 无结算的最长年龄；调度读 started_at 判 wedged |
| `mailbox.cold_start_alert_after_ms` | 300000 | generation=0 pending 地址未成功注册的告警年龄 |
| `mailbox.vip_burst` | 4 | VIP 连续服务上限 K |
| `mailbox.promotion_age_ms` | 1800000 | 普通消息晋升年龄 |
| `mailbox.max_attempts` | 5 | dead 阈值 N |
| `mailbox.retry_base_ms` | 30000 | 失败退避基数 |
| `mailbox.retry_cap_ms` | 900000 | 失败退避上限 |
| `mailbox.notice_pending_limit` | 500 | notice admission 水位 |

规则：

- bootstrap 只 `INSERT ... ON CONFLICT DO NOTHING`；
- 每个 poll/settlement 事务读取需要的 config snapshot，不缓存成第二真相；
- 值必须为 canonical 十进制正整数；未知 key 可存在但本包不解释。逐项闭区间固定为：
  `poll_interval_ms=250..60000`、`heartbeat_write_interval_ms=1000..60000`、
  `heartbeat_stale_after_ms=3000..600000`、
  `running_attempt_max_age_ms=60000..86400000`、`cold_start_alert_after_ms=60000..3600000`、
  `vip_burst=1..100`、`promotion_age_ms=60000..604800000`、`max_attempts=2..100`、
  `retry_base_ms=1000..3600000`、`retry_cap_ms=1000..86400000`、
  `notice_pending_limit=1..1000000`；
- 交叉约束固定为 `heartbeat_write_interval_ms >= poll_interval_ms`、
  `heartbeat_stale_after_ms >= 3 * heartbeat_write_interval_ms` 与
  `retry_base_ms <= retry_cap_ms`。缺键、前导零、空白、符号、小数、越界或交叉矛盾都抛
  `EngineConfigError`，不 start/settle 新 attempt；
- poll 的纯读 fast path 是可撕裂、无副作用的早退提示；它不能独自授权 start/settle/heartbeat/
  generation 变化。只有 heartbeat 到期或需要 start 时写，并在写事务内重读权威状态。
  默认 50 个持续在线 agent 的心跳写上界约为 10 tx/s，而不是每秒 50 个写事务；`BUSY/LOCKED`
  被分类为 `PollTransientError`，壳按最近一次成功 cadence 重试，authority/config/integrity 错误不得降级；
- 终稿已删除的 `T_deliver/T_max/T_switch/T_tick/SLA` key 不创建。

## 5. 测试迁移

| 测试族 | 保留/改写 | 删除/新增 |
|---|---|---|
| migration | 保留 0001–0004 升级历史 | 新增全量 upgrade/rollback：地址物化与 orphan/tombstone fail-loud、`seq`/`sqlite_sequence` 保持、7 个 mailbox 索引逐名复建、`processing_attempts → mailbox` 入边 + 全库 `foreign_key_check` |
| config | 无 | 新增 11 个 seed、逐项边界/非 canonical 值/交叉约束/缺键、重复 bootstrap 不覆盖、同事务即时生效；验证默认 50 agent 心跳写预算 |
| candidate/STAT4 | 保留四路 SQL、K 上界、promotion、重启保守初值 | 参数改从 config fixture 读；无统计/带 STAT4 两组都逐路断言 exact partial index，age detector 断言 `mailbox_pending_age` |
| registration | 保留 generation/crash/exactly-once/rollback/foreign-generation | 删除 C4/owner、meta registry 与 instance/activation authority；覆盖 self-first insert=1、预配 0→1、旧世代证据后 `+1`、行不可删/世代不可回退复用、heartbeat/offline 同 generation 正例、graceful stop 自有 running 恰一次 crash+失败账、stale-generation stop no-op |
| start/settle | 保留单在途、resume、原子 effects、late result、retry | max attempts/退避改 config；新增 dead + agent dead-letter event exactly-once + FLY-1501 DAG 现查升级合同 |
| consume loop | 保留 batch=1、converter exception→failure、逐条重查 | 删除 ring storm、runner pump/deliver；新增显式 poll、任一 loop 的 available 必移交 single-flight、stale uid 正常交接、忙时不取第二条且不重复 converter/deliver |
| liveness | due 消息由持续 poll 达终态 | 删除 hint/tick/marker/T_max/T_deliver/timer 全族；新增 empty/busy/new 三路 heartbeat、转化低于 max age 不误判、超 max age 即使 heartbeat 新鲜也判 wedged、长 task/gate 已先结 mailbox 不参与判定、阻塞 cadence/硬 crash 按 heartbeat stale key 判定、generation=0 cold-start 超龄告警合同、empty `retryAfterMs` 即时反映 config |
| fairness | 保留真实 poll 路径的 K/promotion | 删除 585min SLA 公式和 ring 变异；新增 config 改值即时生效 |
| enqueue | 保留 dedup/overload/cutover | 覆盖 provision 后离线 recipient 可入队、未知地址精确返回 `unknown_recipient`、generation=0 超龄告警的 durable 查询条件；上游地址真实性在 §6 address-allocation 合同验收，不伪装成 engine 单测；notice probe 使用参数化 `limit+1`，边界与无 500/501 字面量 |
| disposal | 无 | 整族删除；新增“terminal/offline 不改 pending mailbox”回归 |
| shim | 保留 type/API exact shape、opaque session type | 删除 engine 调 shim、重复 vendor turn/marker 行为测试（归 FLY-1501） |
| public API | runtime/type 两套更新恰等集合与可导入 fixture | 删除 `ConsumerCoordinator`/`ENGINE_SQL`/Disposal/timer/MAX_ATTEMPTS/owner；新增 `EngineDriver`、provision/agent registration、poll result/config/error 类型 |

额外负断言：

- engine 调用表达式不存在 `ring(`、`.hint(`、`.deliver(`、`reportDeliveryTimeout`、`onTMaxExceeded`、
  `pa.injected`；`InjectionShim.hint` 的冻结接口声明本身必须保留，不能用裸 `hint(` 文本断言误杀；
- config seed 不含任何已删除 SLA key；
- C4/`ownerLeadId` 在 engine 与新增 kernel 测试中零命中；
- terminal activation 不会触发 mailbox redirect/dead/tombstone。

## 6. 跨单边界

只剩五条跨单合同：

1. **C5**：FLY-1499 继续唯一定义 `InjectionShim`，接口不变；FLY-1501 实现 vendor 投递和连接清理。FLY-1499 不调用它。
2. **heartbeat / progress detector**：FLY-1499 建 `agents`/config 并在 poll 合并写 `last_poll_at`，
   同时保留 current running `processing_attempts.started_at`。调度单的只读谓词写死为：
   pending + offline/无活进程则冷启动；pending + heartbeat age
   `>= heartbeatStaleAfterMs` 则重启；current running age
   `>= runningAttemptMaxAgeMs` 时即使 heartbeat 新鲜也按 wedged handler 重启；generation=0/offline
   pending age `>= coldStartAlertAfterMs` 仍无法解析/注册则 fail-loud 通知 founder；反复失败走风暴刹车。
   这仍是“看库 → 拉进程”，不创建 watchdog、进程内 timer、档位或 SLA 公式。本单不实现 restart、
   告警或 scheduler scan；外部唤醒者采用 OS timer + portable bounded `scheduler-once` 的裁决见
   `scheduler-AB-verdict.md`。
3. **dead-letter consumer**：FLY-1499 在失败上限事务内只产出稳定唯一的 `mailbox.dead` event；
   FLY-1501 消费它并在通知时用 `attempt/activation → task → issue/DAG` 现查 runner 的 Lead，Lead
   收件人直达 founder。归属链缺失必须保留 orphan 事实并通知 founder，不能丢弃、重路由业务信或猜 owner。
4. **shell polling contract（FLY-1501）**：runner 壳必须让 cadence loop 独立于 handler Promise；
   busy 时回传 current attempt uid；cadence/settlement 任一 loop 收到 `available` 都在睡眠/返回前移交
   同一个 handler single-flight；single-flight 以 attempt uid 去重，禁止同一 message 重复 deliver。
   C5 的“成功”表示消息已被 durable 吸收并形成可立即结算的 proposal/task，而不是等待 task/TDD/gate 完成。
5. **address allocation（DAG/后续调度单，与 `scheduler-once` 同 owner）**：只有该层能从 durable
   DAG/Lead identity 分配可拉起的 agent id，随后调用 `provisionAgentRecipient`。engine 不发明或验证
   调度拉起描述；它只验证 typed agents row/kind 并对未知地址返回 `unknown_recipient`。调度单必须
   对 generation=0/offline + pending 超 `coldStartAlertAfterMs` 的地址停止静默重试、保留事实并通知 founder。

明确删除的旧跨单项：

- C4 `ownerLeadId` 全部作废；
- `meta consumer_registry` 与 exact instance/activation current fence 作废，agents 是唯一 authority；
- DLQ obligation/病历卡不再存在；这里保留的是一次性 dead event 消费合同，不是 obligation 状态机；
- owner-route/ring、启动 timer rebuild、T_switch 信号重试等旧 SLA 接线全部作废。

## 7. 完成定义

映射圈完成需同时满足：

1. `agents` 首次创建/世代单调、busy-safe heartbeat + durable handler-progress detector、双 loop 交接、
   dead-letter consumer 与 config 值域均有唯一合同，无待定结构点；
2. 增量设计评审仅按“与 v2 终稿一致性 + 覆盖完整性”给出 APPROVED；
3. 后续代码 diff 对本文每个“删除/修改/保留”都有对应测试或静态负断言；
4. engine/kernel 目标测试、全仓 lint/build/test、跨族 code review 与 CI 通过；
5. PR 只包含 FLY-1499 消息层与五条明确跨单合同，不重建病历卡、owner、门铃、watchdog 或 SLA 机器。
