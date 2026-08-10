# FLY-1574 Discord 收编:不再直推,统一走 mailbox — 实施计划

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10(R6,按 implementation-node cross-family design review 修订)
基于: research.md

---

## 0. 一句话

flag `FLYWHEEL_MAILBOX_DISCORD=1` 时,Discord 入站消息过完 gate 后**只写一行 `carrier='inbox'` 的普通 mailbox 信 + 尽力而为按门铃**,由现有投递环送达(Claude:inbox.json;Codex:unix socket);OFF = 旧直推流字节等价。双轨共存靠 **per-message lane 仲裁协议(五态,§2.0)** 保证同一条 Discord 消息恰好被一条道拥有;**ON 路径不存在 raw 直推**——入队失败走 durable intent 延迟送达,恰好一次不被牺牲(§2.4)。删除旧机制留给全家族清理单。**交付终态 = ON**(founder 2026-08-10 指令,见 design-correction.md):置 ON 并实测生效是 ship 完成定义的一部分,OFF 仅作运行时回滚手段保留。

## 1. 交付物与仓库分布

| # | 交付物 | 仓库 | 说明 |
| -- | -- | -- | -- |
| 1 | lane 仲裁 API(五态)+ `chat-ingest` 子命令 + 渲染器 + settle lane 感知(含 archived) | flywheel `packages/flywheel-comm` | 入队侧唯一入口 + 双轨互认协议 |
| 2 | flag 注册(`toggleable: 'readonly'`)+ 本仓 reader + 跨仓契约 fixture | flywheel `packages/config` / `flywheel-comm` | registry 仅登记本仓 readsite |
| 3 | Codex Gateway durable-accept strategy + route-aware mailbox last mile + Codex 专属 transition table | flywheel `packages/teamlead` | TUI/headless 共用 socket consumer;Discord batch 不跨 reply route |
| 4 | Discord 插件 fork 分叉 + fork 自有 flag reader + ingest durable intent | 插件 fork 仓(独立 PR) | 消费 #1 的 CLI |
| 5 | 硬检查:ingress-id 集合对账脚本 + 结构化证据(flag-error / ingest-stall) | flywheel | issue 硬检查条款 |
| 6 | flip runbook(census→清账→翻转)+ 清理单交接清单 | flywheel(本文件夹) | §6 |

**部署形态**:插件新版本需 Lead 会话重启一次加载(一次性 deploy);此后 ON/OFF 靠原子改写 `~/.flywheel/.env` 一行(mktemp+mv),零重启零重部署。翻转前必须过 §6.1 capability census。

## 2. 实施步骤(TDD,RED→GREEN→REFACTOR)

### Phase 0 — lane 仲裁协议(地基;R1 BLOCKER-1 + R2 BLOCKER-1/HIGH-3)

**事实**:`MailboxQueue.enqueue` 幂等靠 `mailbox_identity.insert_projection_hash`(全投影,`mailbox-queue.ts:307-338`);同 id 换道 enqueue 抛 `mailbox identity conflict`。且 **Codex 旧道的权威不在 `chat:` identity**:普通 Discord 入站只写 LeadJournal(idempotencyKey=messageId),cross-department 才写 `xdept:` external 行。仲裁必须分后端定义。

**0a. 通用五态 verdict(discriminated union,`packages/flywheel-comm/src/discord-chat-ingest.ts`)**

```
type LaneVerdict =
  | { lane: 'inserted_inbox' }      // 本次占有 inbox 道(已入队)
  | { lane: 'active_inbox' }        // inbox 道已占有(此前已入队)
  | { lane: 'inserted_external' }   // 本次占有 external 道(旧流 begin 成功)
  | { lane: 'legacy_external' }     // external 道已占有(注意:语义=「旧道已取得所有权」,
                                    //   不等于「已直推过」—— 行可能仍未 notify)
  | { lane: 'archived' }            // identity 已归档,两道都不再动作
```

单事务 `BEGIN IMMEDIATE` 内查 `mailbox_identity`(id=`chat:<leadId>:<msgId>`)并按调用方意图插入,五态穷举返回,绝不抛 identity conflict。

**0b. 双方动作表(每格都定义,含并发竞争败者格)**

| 调用方 | verdict | 动作 |
| -- | -- | -- |
| ON ingest | `inserted_inbox` | nudge → 结束(正常路) |
| ON ingest | `active_inbox` | 幂等短路(重放/重试),不重复入队、不直推 |
| ON ingest | `legacy_external` | 跳过(旧道所有;补投由旧重投 worker 负责,kick 一次 worker) |
| ON ingest | `archived` | 跳过 |
| OFF begin | `inserted_external` | 照旧直推(正常旧路) |
| OFF begin | `legacy_external` | **跳过直推**(并发第二个 OFF handler / spool 重放的败者格;kick 重投 worker 兜补投),intent 正常消费不再冲突 |
| OFF begin | `active_inbox` | **跳过直推、不写 spool**(ON→OFF 重放:投递环会送/已送) |
| OFF begin | `archived` | 跳过 |

**0c. Codex 专属 transition table(**两种 flag 状态都运行**;R2 BLOCKER-1 + R3 BLOCKER-1/HIGH-4)**

Codex strategy 对每条入站按序跨 store 判定。saga 真实协议 = `begin → router.submit → complete`(`saga.handle` 是模型 turn 完成后的 settlement hook,**不能**代替 `complete`):

| # | 检查(按序) | 动作 |
| -- | -- | -- |
| 1 | LeadJournal 已有该 messageId **且** active `xdept:` 行仍未 complete(典型崩溃点:submit 后/complete 前) | 幂等 `saga.complete` 补 ACK → 返回 true(测试必须断言 xdept 行终态 ACK,不只断言无双 turn) |
| 2 | LeadJournal 已有该 messageId,无未完 `xdept:` | 跳过一切,返回 true(cursor 前移) |
| 3 | active `xdept:` 存在且 journal 未 accept(saga begin 后崩溃) | **fenced legacy-recovery**:`router.submit`(new/duplicate 均幂等)→ `saga.complete`;后续 outbound settlement 仍走既有 `onEntryCompleted → saga.handle`。不占 `chat:` 道 |
| 4 | **`chat:` inbox identity 已 active/archived(ON 期已提交;本检查 OFF 下也执行)** | **跳过旧直推**,返回 true —— 否则「ON 提交 → cursor 持久化前崩溃 → 切 OFF 重放」会经旧 router 造出第二个 turn(`acceptBatch` 按 batchId 去重,对 Discord messageId 无感) |
| 5 | 以上皆无 | ON:进入 0a 仲裁占 `chat:` inbox 道;OFF:旧路径直推(字节等价) |
| * | 任一 journal/xdept lookup 或 complete 失败 | 返回 false(cursor 不前移,RestPoll 重投重试) |

- **ON-lane 前置硬件:live per-Lead runtime mutex(R4 BLOCKER-1 + implementation review MEDIUM)**。第 4 格的新道正确性需要「ON 期每 Lead 恰一个 runtime 可取得新道所有权」;OFF 仍是完整旧流逃生口,不得被新 mutex 拒起。TUI/headless 共用 `LiveDiscordLaneGuard`:runtime 启动后、gateway 启动前先现读 flag;ON 时必须持锁才启动/继续新道,OFF 时释放 helper 并 bypass;运行中 OFF→ON 由 guard 的单一低频现读器异步取锁,取锁完成前 `handle` 返回 false(cursor 不前移),ON→OFF 立即释锁并恢复旧流。锁为 stateDir 下稳定文件的内核 `fcntl.flock`;Node 父进程 spawn 一个 non-detached Python helper,以专用 stdin pipe 作生命线:helper 取锁后回一个 ready byte,然后阻塞读到 EOF;父进程死亡/close → pipe EOF → helper 立即退出释锁;helper 在 ON 期意外退出 → guard lost,handler 全部 false 且 runtime fail-stop。禁止 PID file/`mkdir`/lease 库;删 lock 文件不是解锁手段。
- 测试矩阵:表 1-5 逐格;旧消息 accepted 后翻 ON + Gateway 重放;`xdept:` submit 后/complete 前崩溃(断言补 ACK);`xdept:` begin 后 journal 前崩溃再 ON(断言经 3 格收敛且行 ACK);**ON commit → cursor 持久化前崩溃 → OFF 重放(断言第 4 格跳过,零双 turn)**;**顺序 OFF 胜 → ON 后到者命中第 2 格 `legacy_codex_accepted`(journal hit,不是 `legacy_external`)**;mutex:ON 时 TUI-vs-TUI、TUI-vs-headless 双启动恰一胜,败者零新道提交;父进程 SIGKILL 后 helper 收 EOF 释锁;活 holder 不可被 socket unlink 顶掉;helper 独立崩溃时 fail-stop;OFF 不受锁故障影响,ON→OFF→ON 可实时回切。

### Phase 1 — flywheel-comm 入队侧

**1a. 渲染器 `renderDiscordChatContent(envelope)`**

- 形态锚 = **真实旧链路捕获的 golden fixture**(实施第一步:测试环境旧路径真发一条,抓 Lead transcript 中 `<channel source="discord" ...>` 实际可见形态)。后端差异明示:Claude 收到 `from=bridge` 的 teammate 信封,正文里的 `<channel ... receipt_id="<delivery_id>">` 是可见 mailbox id;Codex 收到投递环生成的 `[receipt:<delivery_id>]` 头。不把 Codex-only 头误写成 Claude 形态;
- canonical encoder + 信任边界:属性转义(引号/`<`/`>`/换行/控制字符);正文中伪造 `</channel>`/`<channel>`/附件行经转义不可能被读成结构;附件真相只在机器信封头(`[discord-chat-receipt v1] {json}` 首行)+ 转义后可见清单;
- **内容上限(R2 MEDIUM-5)**:mailbox `content` 是 SQLite TEXT,**无既有通用上限,也不发明一个**;输入边界 = Discord base 正文 2000 字符(Nitro 可 4000)、附件条目有界 → **全量保真,零截断**;测试:2000 字符正文逐字往返 + 4000 字符不被本地截断;
- `from_agent`:`founder`(authorId==FOUNDER_ID)/ `discord:<authorId>`(不凭空造 Lead 映射)。这是 DB 归因/审计字段;Claude 最后一公里 teammate `from` 仍为 `bridge`,因此信任边界必须依靠正文内受控的 `<channel source="discord" ...>` 机器信封,不把 teammate 显示名当作发件人真相;
- 测试:golden fixture 对齐;注入(closing-tag/属性/控制字符/附件名);中文/emoji;最大长度。

**1b. `ingestDiscordChat(args)`**:0a 仲裁 + `inserted_inbox` 分支 enqueue(`carrier:'inbox'`, `recipient_kind:'lead'`, `msg_class:'model'`, `type:'discord_chat'`, **priority 统一为 1**,`created_at`=discord ts)。Discord 同一会话不按发件人重排;founder 仍会早于 priority 2 的普通 lead event。已核 `QuestionAdmission.revalidate` 对非 question 放行(`question-admission.ts:64-75`)。机器信封保存现有 route resolver 的**结构化结果**(`replyChannelId?` + `replyRoute?`),并将其 canonical hash 写入 `collapse_key=discord-route:<sha256>`;

**1c. 门铃**:复用既有 `nudgeLeadInboxBestEffort`(`lead-inbox-nudge.ts:34`,200ms 超时 + 401/403 refresh);不新造。

**1d. flag reader `readMailboxDiscordFlag(envPath)`**(本仓,供 Codex 用)

- 现读 `~/.flywheel/.env`;`'1'`→ON;显式其他/未设→OFF;**读失败→OFF + `readError` 标记**,调用方输出结构化 flag-error 日志(message_id/lead/project);
- **跨仓契约 fixture**:env 样本(缺失/`=0`/`=1`/畸形/不可读)+ 期望裁定;本仓与插件仓 reader 都过同一组(fixture 随主 PR 入库,插件仓 vendored + PR 互链)。

**1e. CLI `flywheel-comm chat-ingest`**

- **提交协议(R2 MEDIUM-6 修正)**:enqueue 事务提交 → stdout 单行 verdict JSON → 再 nudge(失败仅 stderr);**输出为按 lane 区分的 union(R3 MEDIUM-5)**:`inserted_inbox`/`active_inbox` 带 `{deliveryId, seq}`;`legacy_external` 带 `{deliveryId}`;`archived` 无 live 行,**省略 seq(不伪造序号)**;**调用方合同:解析 stdout 中第一条完整 verdict JSON——有效 JSON 的裁定优先于非零退出码/超时**(插件 `runCommand` 等进程退出收全量 stdout;超时杀死后已捕获的部分 stdout 仍须解析——JSON 在场 = 提交已发生的权威证据);无 JSON + 非零/超时 = 结果未知 → Phase 4 write-ahead intent 已在场,由 worker 收敛;
- flag 判定不在 CLI 内(可重放机械臂);
- **`--version-probe`(R2 MEDIUM-6)**:零 DB 副作用,输出 `{command:'chat-ingest', protocolVersion:1, ok:true}`,exit 0;census 用;有测试;
- 显式实施项:`package.json` exports + `src/lib.ts` + `src/index.ts` 路由/usage/async;
- 测试:JSON 契约;nudge 失败不改退出码;commit 后 kill → 重放得 `active_inbox`;部分 stdout 含 JSON 时裁定优先;`--version-probe` 零副作用。

**1f. settle lane 感知(含 archived;R2 HIGH-4)**

- 活行:读 `mailbox.carrier` → inbox 道返回稳定 `ignored_inbox`(不写 settlement ledger、不报错);external 照旧;
- **archived 行:identity 无 carrier → 从 `mailbox_log` 的 archived row snapshot 读 lane**;snapshot 缺失/不可判 → `ignored_unknown_archived` + warning(不写 ledger)——宁可少记一笔 telemetry,不冒写错账;
- 测试:ON 行 reply;旧 external reply;**归档 external 迟到 reply 仍可 settle**;**归档 inbox reply ignored**;lane 不可判 fallback;翻转后 settle intent 重放。

**1g. route-aware batch 与 Discord 投递失败政策(implementation review HIGH-1/HIGH-3)**

- 不加 schema 列:结构化 `replyChannelId`/`replyRoute` 已在受信 machine envelope 中持久化;`collapse_key` 仅放 canonical route hash,不放未转义用户文本;
- `claimLeadBatch` 在冻结一个 `discord_chat` batch 时,只取同 `type + collapse_key`,不与普通 model 信或不同 route 的 Discord 信混批;同 route 的连发信仍可由 D 的 60s 窗合批;
- `LeadDeliveryBatch`/Codex socket request 带一份 batch-level route metadata;`CodexLeadInboxServer` 将它传给 `LeadJournal.acceptBatch`,journal entry 仍是 `source:'mailbox'`(不触发旧 `ExternalReceiptSaga`),但保留 `replyChannelId`/`replyRoute`,因此既有 `ensureReplyRoute`、`seedBudgetForRoute`、typing 和 outbound reply target 全部原样工作;
- 路由解析失败或同 batch 中 route 不一致 = delivery failure,绝不降级到 default chat;
- 现 C 期通用 model lane 在 5 次 adapter 失败后转 DEAD。本单仅对 route-homogeneous `type='discord_chat'` batch 传入「不耗尽」策略(不改其他类型的 D 机械):继续现有 bounded backoff,第 5 次起每个 stall episode 只发一次结构化 `discord_mailbox_delivery_stalled` 告警,恢复后清 episode;row 不转 DEAD,不丢 founder 消息。D 合入后由其 dead-letter gate 接管此特例。

### Phase 2 — flag 注册(`packages/config`)

- `registry.ts` 增 `mailbox_discord`:完整 `FeatureFlagSpec`(source `env`/envVar/valueKind `bool`/polarity `opt_in`/category `feature`/scope `bridge_global`);**交付合同(founder 2026-08-10,design-correction.md):极性 opt_in 只是取值机制(ON 时点须受 §6.1 栅栏控制),不是交付形态 —— 生产终态 = ON,「代码合入未置 ON」只允许作为 ship 序列中的中间态存在**;
- readSites 只登记本仓可扫描位点(flywheel-comm reader + Codex strategy 调用点,timing `dotenv_live`);插件 fork consumer 记在 note + 契约 fixture;
- **`toggleable = 'readonly'`**(R2 MEDIUM-6:当前流程为人工原子改文件,不是 console 直切);drift 测试要求两个主仓 readSite 文件都字面包含 `FLYWHEEL_MAILBOX_DISCORD`;
- 测试:registry 结构套件。

### Phase 3 — Codex 侧(`CodexDiscordGateway` + 两种 runtime)

接入点 = `CodexDiscordGateway.handle(msg): boolean`(`CodexDiscordGateway.ts:186`),`passesFilters` 与 reply-route 解析之后,注入式 durable-accept strategy(TUI + headless 两处 wiring 同一 strategy):

- **第 0 步 = live guard**:两 runtime 在 gateway 前启动 §0c 的 `LiveDiscordLaneGuard`;OFF 直通旧流,ON 未持锁时 handler 只返回 false。guard 与 flag 同一个逃生口,不加第二 flag;
- **两种 flag 状态都先过 0c transition table**(R3 BLOCKER-1):ON 走到第 5 格才同步 `ingestDiscordChat`(better-sqlite3 同步事务,兼容 sync boolean),并把已解析的 `replyChannelId`/`replyRoute` 与正文一起持久化;任一「已有归属」verdict 均不进 `LeadInputRouter`、不注入 turn、不写 saga → 返回 true(cursor 前移);nudge 异步尽力而为(无凭据记 debug,tick 兜底,最坏 +30s 单列 SLO);
- **ON 且 enqueue 抛错:返回 false(cursor 不前移)→ RestPoll 自然重投 = 内建重试**;连续失败记结构化 ingest-stall 日志(该 channel 队头暂停 = 已知语义,flag OFF 为逃生口;RestPoll cursor 即 durable NACK,故 Codex 侧无需 write-ahead intent);
- OFF:0c 第 1-4 格照跑(过渡保护;第 4 格防翻转双 turn),第 5 格 = 现路径字节等价(哨兵);OFF 不声称修复旧流的双 runtime 运维风险;
- **headless 不得只写不读**:`codex-lead-runtime.ts` 补与 TUI 同构的 `CodexLeadInboxServer`;`startGateway` 先 `inboxServer.listen()` 再 `gateway.start()`,`stopGateway` 反序停 gateway 再 close socket。Bridge 的 `CodexLeadDeliveryAdapter` 因此在 TUI/headless 两种形态都有真正 last-mile consumer;
- 字段降级显式化:authorName=authorId、attachments=[]、msgKind 按现有 channel 信息;attachment-only 消息今天就被 `passesFilters` 丢弃,保持;
- 测试四层:Gateway(0c 全矩阵、route 保真、失败 false 重投、cursor 语义)/ route-aware batch(同 route 可合、跨 route 必分)/ RestPoll(回归)/ wiring(TUI+headless 都有 strategy + inbox socket,headless 缺 socket 的结构测试必红)。

### Phase 4 — Discord 插件 fork(插件仓,独立 PR)

`handleInbound` 第 5 步(`chatReceiptRuntime.begin` 位点)分叉:

- fork 自有 flag reader(bun,过 1d fixture);**ON 生效 = flag ON && `RECORDER_MODE.kind==='enabled'`**;读失败→OFF + flag-error 结构化 stderr;
- ON:**write-ahead ingest-intent → spawn `chat-ingest`**(替代 begin);跳过 `deliver()`/`complete()`;typing、ack reaction、permission 拦截、roundtable 路由原位不动;
- **失败协议(R2 BLOCKER-2 + R3 BLOCKER-2/HIGH-3:ON 路径零 raw 直推,intent 先行)**:
  1. **write-ahead**:第一次尝试 CLI **之前**原子写 ingest-intent(Discord `messageCreate` 没有 durable NACK——若先试 CLI、结果未知、进程在写 intent 前退出且 SQLite 实际未提交,消息在 mailbox/spool/直推三处皆无,重启也不会重放。intent 必须先落盘);
  2. spawn `chat-ingest` → 拿到任一权威 verdict JSON → 删 intent,结束(删失败 → 幂等 worker 再收敛,重放得 `active_inbox` 无害);
  3. 无 verdict → 重试一次 → 仍无 → intent 留场,交 worker;**不直推**;
  4. **intent 存储隔离(R3 BLOCKER-2)**:独立 `spool/ingest/` 子目录 —— 现产 `SpoolIntentV1` 无 `kind` 字段、根目录文件名即 `<messageId>.json`,混放会把旧 begin intent 判坏/覆盖;兼容测试:旧无 kind v1 → 恒为 begin,升级不重写不覆盖;
  5. **worker 重试语义(R3 HIGH-3,现 `workerLoop` 无周期 timer,`workRemains && !progress && no kick` 即退出——「定时重放」必须新建)**:intent 持久化 `firstFailedAt/nextAttemptAt/attempts`;单一 unref retry timer,退避有上限(如 5s→10s→…→cap 5min);无进展只预约**未来一次**唤醒,绝不 while 热旋;ingest 子目录独立 bounded pass,不为它高频触发旧 external pending/settle 扫描;**anti-spin 测试:固定时间窗内 CLI 调用次数有硬上限**(FLY-1646 直接教训);fake timer 锁「无新消息也会自恢复」「5 分钟必 advise」;
  6. intent 滞留超阈值(默认 5 分钟)→ 现有 advise 机制发 ingest-stall 通告 + 结构化日志;
  7. **intent 写失败的 fail-stop 语义**:不假装有恢复记录 —— 仍尝试 CLI 一次(verdict 成功即无事);无 verdict → **立发高优先级通告(含 message_id/channel,指明「此消息可能需人工重放」)**,不静默;
  8. 逃生口 = flag OFF(新消息回直推;滞留 intent 继续重放,经 inbox 道送达,顺序可能晚于新直推消息 —— §6.2 已知项);
  * **不存在「失败就 raw 直推」分支** —— 恰好一次优先于即时性;可用性代价 = 本地 comm.db 持续故障时消息延迟(可见、可查、可回切),见 §7.2;
- OFF:字节等价 + ON→OFF 重放按 0b 表(`active_inbox`→跳过直推不写 spool);
- reply handler / 重投 worker 零改动(settle 感知在 1f;worker 谓词只认 external);
- 测试:ON 只入队不 notify;OFF 哨兵;verdict-JSON-优先于退出码;两级失败→intent→worker 重放→送达恰一次;stall 通告;flag 现读;fixture;ON→OFF 重放跳直推。

### Phase 5 — 硬检查(主口径 = 时间窗 ingress-id 集合对账)

可执行脚本 `scripts/audit-discord-mailbox-ingest.sh`(随主 PR):

1. 窗口内 Discord ingress message ids(插件/Gateway 结构化 ingress 日志;QA 可用 Discord fetch 复核);
2. 每个 id 断言:`mailbox_identity` 有 `chat:` inbox 道记录 **或** 有对应结构化证据(flag-error / ingest-stall intent / Codex `legacy_codex_accepted`·`legacy_xdept_pending` 日志);
3. 窗口内 `carrier='external'` 行增量 = 0(ON 期);
4. durable-accept 收据抽查(Claude sidecar / Codex journal);
5. `CLAUDE_CONFIG_DIR` 感知;shard 枚举 + 预期行数由脚本输出;
6. **结构检查替代裸 `rg`(R2 MEDIUM-6 + R3 MEDIUM-5)**:「ON 路径无不受 lane verdict 保护的直推调用」由单一分叉函数 + 单测锁定(直推调用点只存在于 OFF 分支函数内);**唯一允许的 fenced 例外 = 0c 第 3 格 `legacy_xdept_pending` 的 legacy-recovery(router.submit→saga.complete)**,由独立单测单独锁定其 fence 条件,不与结构检查冲突。

### Phase 6 — 全仓门禁 + 评审 + PR

- `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 插件仓测试;
- codex 代码评审循环至 approved;
- PR:flywheel 主 PR(0/1/2/3/5)+ 插件 fork PR(4)互链;CLAUDE.md 里程碑 + 文档随主 PR 最后 commit。

## 3. QA 计划(真机,独立 QA 节点)

> 顺序:**FLY-529 隔离房先过,才上生产**。

### 3.1 QA Room

| # | 场景 | 判据 |
| -- | -- | -- |
| Q1 | ON:test founder 发 1 条 | mailbox `carrier='inbox' type='discord_chat'` 一行;Claude 正文 `<channel>` 带 `receipt_id`,Codex 带 `[receipt:]`;reply 正常 |
| Q2 | ON:60s 内连发 3 条 | 3 行独立入账、各恰一次且同 route hash;D 未合:如实记录批次形态;D 已合:一次收 3 条 |
| Q3 | ON:跨 Lead(#test-leads-roundtable) | roundtable 走 mailbox;Codex journal 的 `replyChannelId`/`replyRoute` 与旧流一致,topic 确保、budget seed、typing、reply 都在正确 thread;不同 route 同 tick 不混批 |
| Q4 | 零丢失(03:57 重放):在途杀 Bridge / Lead 不在 | Claude:行 `QUEUED` 或已写 inbox.json;Codex:TUI 与 headless 均验 socket consumer,停 consumer 跨过 5 次失败仍不 DEAD、有一次 stall alert,恢复后恰好一次、内容完整 |
| Q5 | OFF 回切(原子改 env,不重启) | 下一条走旧直推;已入队/LEASED 行按 §6.2 drain 继续送完;再 ON 恢复 |
| Q6 | **失败注入(零直推)**:注坏 comm.db | 消息**不直推**、write-ahead intent 已先落盘;退避重试无热旋(窗口内 CLI 调用数有上限);超阈值出 stall 通告;**无新消息也自恢复**(定时唤醒);修复 db 后经 inbox 道送达**恰好一次**;窗口全程 external 增量 0 |
| Q7 | 幂等:Gateway 重放同 message_id | mailbox 一行不重,Lead 只见一次 |
| Q8 | 翻转竞态:OFF 直推后立刻 ON 重放 / 反向 / 顺序竞争 | 0b 表逐格验证;**按胜者分组断言:ON 胜 → OFF 败者 `active_inbox`;OFF 胜 → ON 败者 `legacy_external`**;零双投零 identity-conflict 日志 |
| Q9 | Codex transition 全矩阵 + mutex | 0c 表 1-5 格全验;ON 双 runtime 恰一 guard READY,败者零新道提交;杀 parent 后 helper 释锁可 takeover;杀 helper 则 runtime fail-stop;OFF 不受锁故障影响,OFF→ON 取锁窗口 cursor 不前移,ON→OFF→ON 真时回切 |
| Q10 | 序列与 route batch | 允许的普通用户先发、founder 后发时仍按 seq 出现;同 route 可合批,不同 channel/thread 必分批 |

### 3.2 生产验收(映射 issue 验收 1-6)

1. founder 真发一条 → mailbox 行/状态机/(D 后)租约与 ack;
2. 60s 内 3 条(D 合入后验完整合批;未合如实记录 C 期行为);
3. `#leads-roundtable` 跨 Lead 走 mailbox(含 Mufasa Codex 路径),以 journal 结构化 route + 真 Discord reply thread 双证据确认未回落 default chat;
4. **结构检查**:ON 路径直推调用点仅存在于 OFF 分支函数(单测/结构测试证明;**唯一 fenced 例外 = 0c 第 3 格 `legacy_xdept_pending` recovery,独立单测锁定**)+ 窗口内 `carrier='external'` 增量 = 0;
5. 回归:延迟实测给数 —— SLO 分开:Claude(有 nudge)≤3.5s;Codex 无 nudge 最坏 +30s(单列已知项);`#flywheel-core` / issue thread 路由正常;
6. ON 期同一 message_id 恰一行(inbox 道)+ Phase 5 脚本全量一窗;
7. **ship-enabled 验证环(founder 2026-08-10 指令)**:部署后**实测新流真的在跑**(founder 真发一条 → mailbox `discord_chat` 行出现、该消息零直推)→ OFF 回切实测旧流 OK → **再回 ON 并停在 ON**;「配置写了」不算完成,以行为证据为准。ship 未走完这一环 = 本单未交付。

## 4. 清理单交接清单(本单列全,不删)

- `mailbox.carrier` 列 + **5 个** `carrier='inbox'` partial index(`mailbox_claim`/`mailbox_lead_reclaim`/`mailbox_claim_runner`/`mailbox_claim_bridge`/`mailbox_bridge_reclaim`)+ `'external'` CHECK 分支(清理单用 schema introspection 测试锁全集);
- `type='external_delivery'`;`markExternalDelivered`/`listExternalPending`/`listChatReceiptPending`/`quarantineChatReceipt`/settle-external 分支(含 1f 的 `mailbox_log` archived 判道逻辑);
- 插件:重投 worker、spool(begin/settle/ingest 三类 intent)、`chat-receipt` begin/complete/settle CLI 面、`deliver()` 直推分支;
- Codex:`ExternalReceiptSaga` + Gateway 旧直推分支 + 0c 全部 legacy transition(第 1-4 格:journal 补 ACK / journal skip / fenced xdept recovery / chat: 所有权读检查 —— 旧道死后整表退化为纯 0a 仲裁);route machine envelope/collapse-key fence/Discord non-exhausting retry 特例;清理单删 flag 后 `LiveDiscordLaneGuard` 简化为始终 ON 的常驻单-runtime 不变量,不删内核锁本身;
- lane 仲裁的 `legacy_external`/`inserted_external` 分支;
- flag + registry 条目 + 契约 fixture + 本清单。

## 5. 边界(不做)

- ❌ Discord 出站 / 替换最后一公里传输(inbox.json/unix socket 仍是原通道;socket 只扩 route metadata,headless 补同一 consumer) / D 单租约、60s 窗、死信闸机械 / 删旧机制 / permission·pairing·typing·reaction·roundtable resolver / founder 批准链;
- ❌ Codex attachment-only 行为扩展(今天就丢,保持);RestPoll 字段扩展(降级文档化,follow-up);
- ❌ mailbox content 通用长度上限(不存在也不发明;Discord 自身约束即输入边界)。

## 6. flip runbook(生产)

### 6.1 上线序列(census → 清账 → **置 ON = ship 收尾的无条件动作**)

> founder 2026-08-10 指令(design-correction.md):**ship 完成的定义包含「flag 已置 ON 且实测生效」**。下面 1-4 是 ON 的受控前置(防裂脑),不是把 ON 变成可选 —— 栅栏全绿后必须立即走 5-6,不存在「合了等人来开」的停留态。

1. 主仓兼容版本部署(OFF,验旧流无回归);
2. 插件 fleet 全量部署 + Lead 重启;
3. **capability census**:每个 Lead/shard 探 `chat-ingest --version-probe` + 插件启动日志 + 每个 Codex runtime 的 route-aware socket protocol probe(TUI/headless 都必须在) + guard/helper 取放锁自检;在 OFF 期不要求持锁,翻 ON 后必须见到每 Lead 恰一个 READY holder,全绿才继续;
4. 清旧账:全 shard `chat-receipt pending` 清零 + Codex `xdept:` reconciler 水位确认;
5. 原子改写 `~/.flywheel/.env` 置 ON(mktemp+mv);
6. 立刻真 Discord 完整对话一轮(founder 参与)+ Phase 5 对账脚本一窗。

mutex 诊断:锁文件是稳定 inode,不删;用 `lsof <stateDir>/discord-inbound.lock` 查 holder/helper,对照 runtime 结构化 READY 证据。若 helper 无父 runtime,先将 flag 置 OFF(新道停用),再终止该 orphan helper;不用 unlink 伪装解锁。

### 6.2 回滚语义(诚实版)

- 回 OFF = **停止新消息入队**;已入队/LEASED 行继续由投递环送完;滞留 ingest-intent 继续重放至送达(顺序可能晚于新直推消息 —— 已知项);drain 检查:`SELECT count(*) FROM mailbox WHERE type='discord_chat' AND state IN ('QUEUED','LEASED')` + intent 目录空;
- 投递环整体故障:行滞留 QUEUED 不丢;回 OFF 恢复新消息可用性;
- census/清账反向适用。

## 7. 已知接受项(明示)

1. E 先于 D:C 期语义(无租约到期/60s 合批窗/死信闸);
2. **本地 comm.db 持续故障时,ON 路径 founder 消息延迟送达**(durable intent + 超阈值 stall 通告 + flag OFF 逃生;恰好一次不牺牲)—— 取代 R2 前的「带标记重复」方案:延迟可见可控,双投不可撤销;
3. Codex 无 nudge 凭据 → 最坏 +30s;Codex ingest 持续失败 = 该 channel 队头暂停(cursor 不前移,结构化日志 + flag OFF 逃生);
4. mailbox 版可见形态按后端区分:Claude = teammate `from=bridge` + 正文 `<channel receipt_id>`;Codex = `[receipt:]` + 正文;DB `from_agent` 只作归因,不是 Claude 显示发件人;
5. dotenv_live 多进程翻转短暂裂脑窗(§6.1 census 管理);
6. 归档行 lane 不可判时 settle 记 `ignored_unknown_archived`(telemetry 缺一笔,不写错账);
7. Codex 0c 第 4 格在 ON 新道下由 live per-Lead guard 保证;OFF 是显式回滚到旧流的风险边界,新 guard 不能让 OFF 拒起;
8. 插件 intent 写失败(磁盘级故障)→ 尝试 CLI 一次 + 高优先级人工重放通告(不静默;此时 comm.db 大概率同盘同坏);
9. Discord priority 统一 1 以保留同会话 seq;不同 reply route 不会合成一个 Codex turn。
