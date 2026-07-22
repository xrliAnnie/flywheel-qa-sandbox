# FLY-1392 收据地基 — 实施计划

Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-20
基于: research.md(brainstorm gate 已过;蓝图=FLY-1391 architecture-target.md)

**Status**: codex-approved(design review 5 轮:R1 11 + R2 5 + R3 2 + R4 1 条 blocking 全部采纳,R5 APPROVED)
**Version**: v1.5x.0(ship 时取空号)

---

## 2026-07-21 founder 改型裁定(覆盖本文 founder 六分支设计)

Annie 在实现后裁定控制面完全采用 claude-code agent-team 拓扑。本节是本文
founder 入站部分的最终 authority。完整定义见 `design-correction.md`;下文保留的
六分支/协议归因内容仅作历史设计记录,不构成产品模型:

1. founder 消息进入 issue thread 后,Bridge **不做归因、不跑 ship classifier、
   不按 pending question 数量分支**,只原样投递给该项目 Lead;
2. 每条 `founder_msg:*` hub-root 对外只回答一个问题:**Lead 办了没有**。
   只有 Lead 的 `route-founder-reply` relay/no-route UOW 能将它置为已办;
   `delivered_at` / `processed_at` 是内部到达/办结时间戳;
3. F-2(reply-to-card)、F-3(ship classifier)、F-5(唯一 matching question)均不得再
   产生 `bridge-protocol` response/evidence 或 runner wake;Lead relay 后才写 response+wake;
4. `lead_inbox` schema、内部 actor/epoch 防误写卫生、未办重发/升级、runner wake
   台账、lane-2(runner→Lead)与 lane-3(Lead instruction→runner)保持不变;
5. founder 原文事件携带 opaque message id 与 comm.db path,仅供 Lead 运行已有 relay/
   no-route UOW;不附 question 归因 hint。`FLYWHEEL_RECEIPT_FOUNDATION=0` 仅保留
   为**事故紧急临时回退**的逃生阀,不是常态运行模式;Bridge 在开关为 0
   时启动立即发 `receipt_foundation_off` severe 告警,之后每小时重复告警,
   直到恢复默认开启并重启 Bridge。

受影响的关单证据必须在新 head 上重跑:F-2/F-3/F-5、无 bridge-protocol evidence、
Lead actor 办结标记、未办重发/升级与 intent-level 真机回复。

---

## 0. 一句话方案

在 FLY-1373 的 `lead_inbox`(comm.db)上为每条消息建立一个“Lead 办了没有”标记:
founder 原文先持久到 Lead 域,只有 Lead relay/respond/no-route 才写 `processed_at`;
超时未办则标记、重发并唤醒 Lead,再超时升级。需要送 runner 时由 Lead 动作创建
`runner_phase_wakes` intent,并沿 T1 verified 重推 / T2 受审计终端拍醒 / T3
升级梯执行。所有复合写走 CommDB 连接绑定的组合事务;跨库副作用走幂等
intent/outbox。内部 `processed_evidence` 与 actor/epoch 只防误写,不构成对外合同。

## 0.1 内部一致性前提

1. `processed_at` 只能与真实 Lead 动作同事务写入;actor+epoch 在动作发生时冻结,
   缺失或不匹配不得把 root 标成已办。
2. **幂等或同事务 outbox 二选一,逐类落实**:复合 UOW 必须在**同一个打开的 better-sqlite3 事务**内提交(§2.5 组合事务 API);push(mailbox/Discord)= intent/outbox 行的执行,幂等键在台账。
3. 新类型默认不进入办结巡检;纯遥测永不被催。内部类型白名单只用于查询安全,
   不作为对外的逐类型凭据承诺。

## 1. 总验收(关单标准,对照 issue 六条 + review 附加)

1. **单层办结链路(529 真机)**:founder 在 issue thread 回复 → `lead_inbox` 出现
   `founder_msg:*` hub-root → Lead relay 后同行 `processed_at` 非空,runner 真收到;
   Lead relay 前不得有 Bridge response/hint/wake。
2. **kill Lead**:Lead 被 kill / 不处置模型巷行 → 窗到 → 重发(root resend_round=1,内容带「第 N 次」)→ 仍无 → detection-escalation 升级可见(notified 后 escalated_at 非空,episode 恰一次),**C3 reconcile 在新装配下真的 page founder**(R1#7)。
3. **重发含唤醒**:runner parked/idle → 投递落 wake intent(同事务)→ push;杀 pane → T2 健康门失败 → `wake_failed` 记录入升级链;正常场景 runner 醒后第一个 CLI 动作按 observedAt 约束标 started(R1#6)。
4. **已过门的 gate 不再被催**:gate 已答 → 有合法 actor+epoch provenance 时巡检推导回填 processed;无论能否安全铸造 processed evidence,催办 eligibility 都必须先确认 question 仍 pending(`resolved_at/superseded_at` 为空、非 `terminal_disposed`、无 response)→ 零催办零重发(阳性对照:未答门有催)。
5. **纯遥测零收据要求**:P3 行永不被催办/升级查询选中(谓词单测)。
6. **意图级**:Annie 真实回复一条,一条 SQL 能回答“Lead 办了没有”。
7. **对抗 fixture**:零 pending thread 里「帮我把这个也改了」/「等下先别 ship」+ emoji 🛑/🚢/❌ 均不被标 `no_route_needed`(R1#9)。
8. **flag-off 紧急回退**:`FLYWHEEL_RECEIPT_FOUNDATION=0` 下 S1–S4 业务行为回到
   FLY-1392 前拓扑(含 claim 节奏、退避、死信、六分支、wake writer、巡检/
   新 reconcile 装配),但回退状态必须 fail-loud:启动立即告警+周期告警,
   sentinel 同时验证旧拓扑与告警都存在(R1#11)。
9. Codex design review APPROVED(1339 吸收内容全量重审,provenance=commit 06c6dfa07 / PR #648 CLOSED)+ code review APPROVED + 全量测试 + CI 绿 + 529 真机独立 QA PASS。

## 2. Schema(comm.db,additive、幂等;PRAGMA table_info 判断)

### 2.1 `lead_inbox` 加列

```sql
processed_at        TEXT;    -- 内部办结时刻;对外“Lead 办了没有”标记
processed_evidence  TEXT;    -- 内部防误写审计;无真实 Lead 动作不得写 processed
read_at             TEXT;    -- 预留,v1 零接线(D-6)
escalated_at        TEXT;    -- notifyLeadFirst outcome ∈ {notified, already_notified} 且 durable 行核实后才写(R1#7)
next_retry_at       TEXT;    -- 未送达轴持久退避;existing-batch 与 fresh-batch 两条 claim 路径都尊重它(R1#10)
next_unprocessed_at TEXT;    -- 未处理轴 root 的下一次到期(每轮重发后重置完整窗口,R1#4)
resend_of           TEXT;    -- 重发行 → root id;root 本行 NULL
resend_round        INTEGER; -- root=已发轮数;重发行=本行轮次
candidates_json     TEXT;    -- founder_route 行:冻结候选集+scope(结构化,R1#9)
family_root_id      TEXT;    -- founder_route 模型巷行 → 其 hub-root id(同一 founder 消息一个 family,R2#2)
routing_state       TEXT;    -- hub-root:awaiting_rebind|model_promoted|bound|no_route;模型巷行:**model_pending**(owner 身份用正值表达,不靠 NULL —— R3#1:SQLite 的 NULL NOT IN (...) 恒非真,会把 owner 从 selector 里静默排除)
```

**单一 retry owner 合同(R2#2;R3#1 修订)**:一个 founder 消息 family(hub-root + 可选模型巷行)**恰有一个** reminder/escalation owner —— 模型巷行产生时(A-1..A-4 / F-4 晋升),同一事务把 hub-root 的 `next_unprocessed_at` 置 NULL(退出 patrol 选取)+ 模型巷行标 `routing_state='model_pending'`;route UOW 双标收口。root 的 `next_unprocessed_at` 在 `awaiting_rebind` 期表示晋升到期,在无模型巷行且要求 processed 时表示重发到期 —— 两用途由 `routing_state` 谓词互斥。**未处理首窗 = 统一 delivery 合同(R3#1;R4#1 推广到全类型)**:**所有**要求 processed(§3.3)、`resend_of IS NULL`、非 ship 的行 —— 含普通 `gate_question`/`runner_question` —— 创建时 `next_unprocessed_at=NULL`;在落 delivery fact 的**同一事务**(model 巷=transport 成功的 `markConsumed(disposition='delivered')`;hub-root=入账事务本身,其 delivered=入账)内以 `COALESCE(next_unprocessed_at, delivered_at + typeWindow)` 初始化 + `resend_round=0`;未 delivered 只走未送达轴(adapter 连败绝不进未处理轴,负测)。model-lane 只是该规则的一个实例,不是唯一实例。

**flag-on 存量 bootstrap(R4#1)**:启用后一次性、可重启的 backfill —— 先跑 provenance derivation(已答行零催),再对仍未 processed 的既有 eligible delivered 行,在同一幂等 UOW 内执行 `next_unprocessed_at = COALESCE(next_unprocessed_at, activationAt + typeWindow)` **与 `resend_round = COALESCE(resend_round, 0)`**(R5 非阻塞守卫:旧库新增列的 NULL round 否则进不了 r1)—— **完整窗口、自 durable activation time 起算**(持久化 activation 时刻,绝不用旧 `delivered_at` 立即到期 → 启用瞬间零历史风暴);`flag=0` 不执行 backfill。测试:(a) 新 gate delivery 后才起窗;(b) transport 延迟不蚀窗;(c) 旧库已答门先 derive 零催;(d) 旧库未答门 bootstrap 后到期进 r1;(e) bootstrap crash/restart 幂等零风暴。

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_inbox_resend
  ON lead_inbox(resend_of, resend_round) WHERE resend_of IS NOT NULL;  -- R1#4
```

### 2.2 `runner_phase_wakes` 加列(R1#5 —— v1 草稿「零 schema 改动」撤回)

```sql
admission_state   TEXT;     -- queued|duplicate|suppressed_cap(事务内裁决;R2#1 —— ledger 写失败=整个 UOW 回滚 fail-loud,无 suppressed_ledger_unavailable 态)
envelope_json     TEXT;     -- 稳定 envelope(重推/writeVerified 按此重建,不重造 timestamp/id)
push_attempts     INTEGER NOT NULL DEFAULT 0;   -- initial+T1 共享硬预算(≤2);**claim 事务内、I/O 之前消耗**(R2#1)
last_push_at      TEXT;
last_push_result  TEXT;     -- 按 attempt ordinal 合并(成功/失败/超时都占预算)
claim_token       TEXT;     -- attempt claim-before-write(并发 tick CAS)
claim_expires_at  TEXT;
t2_claimed_at     TEXT;     -- T2 durable claim-before-act(终身一次;先 claim 再注键,crash 不重打)
t2_result        TEXT;      -- injected|forbidden:<reason>
escalation_outbox_id TEXT;  -- T3 两阶段:先落 outbox 行,投递器消费(R1#5/#10 同一机制)
```

**预算硬上限语义(R2#1)**:claim 事务 = 分配单调 attempt ordinal + `push_attempts++`(**先扣后推**);completion 只按 ordinal/token 合并 result、释放 claim —— transport 抛错、crash-after-main-write-before-sidecar-finalize(`ClaudeMailboxCodec.ts:688-749` stale-pending 重执行窗口)都**已占预算**,不产生免费重推;stale success 只补 delivery fact。**跨 intent 风暴上限**:admission 加 per-exec 滑动窗 cap(默认 6 push / 10min / exec,env 可调),同事务判定,超限 → `admission_state='suppressed_cap'` 零 push + outbox 告警恰一次(id=`wake_cap:<execId>:<windowStart>`)。负载测试:持续 transport 错误下 per-intent ≤2 push;N 个不同 causal key 不突破 per-exec cap;DB 故障期零 push。

**保留语义**(R1#5):`finalizeSession` / issue-terminal cleanup(`db.ts:2456-2464, 2502-2513`)改为**保留非终态行**(pending/claimed/未 alerted 的 exhausted);只 TTL-prune 终态证据(started/finished/suppressed 且超龄)。session 终态/started 后所有梯级 stand-down。

### 2.3 告警 outbox(新小表,comm.db —— 死信与 T3 告警的两阶段出口,R1#10)

```sql
CREATE TABLE IF NOT EXISTS receipt_alert_outbox (
  id            TEXT PRIMARY KEY,    -- 确定性:dead_letter:<batchId> / wake_failed:<intentKey> / unprocessed:<rootId> / wake_cap:<execId>:<window>
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  delivered_at  TEXT,                -- 投递确认后置位;恰一次靠 id 幂等
  canceled_at   TEXT,                -- R2#4:外部 effect 前 source revalidation 失败 → 持久 cancel,不通知
  cancel_reason TEXT
);
```

**consumer revalidation 合同(R2#4)**:投递器在**每次外部 effect 前**事务性重验 source —— `unprocessed:<rootId>`:root 仍 `processed_at IS NULL` 且 owner 现势;`wake_failed:<intentKey>`:intent 仍非 started 且失败条件仍成立;不成立 → 落 `canceled_at/cancel_reason`,零通知。测试:outbox commit 后 response 到 / wake 标 started 的两个 race 均 cancel 不误发。

## 2.5 组合事务 API(R1#1 —— 本计划的地基件,S1 首刀)

**问题**:`LeadInboxQueue` 私有连接(`lead-inbox-queue.ts:114-125`)与 `CommDB` 私有连接各自提交;`insertResponse`/`insertFounderApprovalResponseWithSource` 自带事务(`db.ts:1077-1145, 1276-1338`);「同库」≠「同事务」。

**方案**:comm.db 的组合 UOW 收口到 **CommDB 连接**上:
- `LeadInboxQueue` 支持**共享连接构造**(接受外部 `Database` 句柄;Bridge 内 loop 用自己的连接不变 —— 组合 UOW 场景由 CommDB 句柄构造轻量 queue facade 执行 lead_inbox 写);
- `CommDB` 新增组合 UOW API(每个 = 单一 `db.transaction(...)`):
  - `respondAndReceipt(...)`:response 行 + founder_msg root processed + wake intent 行;
  - `trustedFounderApprovalAndReceipt(...)`:**扩展既有 trusted-writer 事务体**(授权/业务语义零改动,R1#1)+ founder_msg processed + wake intent;
  - `instructionAndIntent(...)`:send 的 instruction 行 + wake intent;
  - `routeFounderReply(...)`:response(如 --to-question)+ founder_msg root processed + founder_route 模型巷行 processed(**两行都标**,R1#2)+ 重发 family 收口(§7.2)+ wake intent;
- 这些 UOW 内**禁止**触碰第二个连接(lint/测试断言);
- crash-injection 测试:每个 UOW 的 commit 前 / 各 INSERT 间 / commit 后三窗。

## 3. Evidence 合同(R1#2 —— typed、producer 冻结)

### 3.1 谁在什么时刻冻结 provenance

| producer | 冻结时刻 | actor/fence 来源 |
|---|---|---|
| bridge-protocol(F-2/3/5/白名单) | 归因终局的组合 UOW 内 | 当时通过 fence 校验的 loop `owner_epoch`(校验在同事务内做,不事后读) |
| Lead(route CLI / respond) | CLI 组合 UOW 内 | 已验证 lease generation + provenance(`authorizeLeadWrite` 既有件) |
| trusted founder writer | 扩展后的 trusted 事务内 | 既有 authority source(workflow_source_event 同事务) |
| runner(wake started) | inbox/turn ack | execId 会话绑定(§6.3 observedAt 约束) |

### 3.2 evidence JSON per kind(typed contract)

`{v:1, kind, ref, actor, actor_kind:"lead"|"bridge-protocol"|"founder-writer"|"runner", fence:{lease_generation?|owner_epoch?|authority?}, basis?:[...]}` —— 写入侧断言 kind 相应必填字段;**推导只复制既存 provenance**:`deriveProcessedFromResponses` 从 response 行的 `from_agent`+provenance/`sender_generation` 复制,任何字段缺失或与合同不符 → 不填 processed(留给催办轴走正常流程)。负测:owner takeover 后旧副作用不得归新 owner;reserved attribution 拒;null provenance 不推导;他人先造成的 response 只按其真实 actor 记。

### 3.3 合同表(research §3 不变)+ 谁要求 processed

要求 processed:`gate_question`/`runner_question`(非 ship)、`founder_reply`(hub-root)、`founder_reply_ambiguous`(模型巷行,由 route CLI 与 root 同事务双标,R1#2)。不要求:P2 报告类、P3 遥测、ship 零缓冲档。

## 4. founder 入站(S2)

### 4.1 hub-root 生命周期(R1#3 —— root 不是普通 protocol 行)

`enqueue founder_msg` 的组合写**同时置 `delivered_at=consumed_at=now, disposition='hub_recorded'`** —— root 从不进入 LeadInboxLoop 的 claim 集合(claim 谓词 `consumed_at IS NULL` 天然排除),从不到 ProtocolIngress/adapter;「未处理」完全由 `processed_at IS NULL ∧ disposition='hub_recorded'` 表达,巡检按此选中。测试:root 永不被 loop claim/投递/隔离;巡检能选中;`countPending`/loop 健康指标不被 root 污染(谓词核对)。

### 4.2 六分支终局(归因/授权/游标逻辑逐字节保留)

research §2.2 表不变;修订两点:
- **F-3 deferred** 由既有 durable deferred-rebind owner 收口(bound 时经组合 UOW 补 processed);**F-4 ❓** 显式 `routing_state='awaiting_rebind'` + `next_unprocessed_at = now + REBIND_WINDOW`,到期由巡检**CAS 晋升**(`awaiting_rebind → model_promoted`,同事务产模型巷行 + root 退出 resend 选取;late-rebind 竞态:晋升前重查 binding,已 bound → CAS 到 `bound` 直接收口;R1#8/R2#2);
- 白名单(§4.4)不命中的 F-1 → 模型巷。

### 4.3 扫描面扩展 + cursor bootstrap 合同(R1#8)

- byThread 从「非终态 session 绑定的 thread」出发(pending questions 作 matching 集合,可空);deliverer 的 `questions.length===0 → noop` 改为允许空集(matching 恒空,只走入账/白名单/模型巷分类);
- **bootstrap watermark**:无 cursor 的 thread 首次进入扫描时,**先持久写当前 Discord head 为 cursor**(一次 GET limit=1 取 head;写失败则本轮跳过该 thread)——**只保证启用后的消息**,零历史回放(历史聊天灌入模型巷 = 事故);watermark 写入本身幂等(cursor store 既有);
- 空 matching 消息的 maturity = 默认 `ctx.graceMs`(她可能连发/编辑);同 thread 多 session → thread 归组本就按 thread_id 去重,root id 键 msgId 幂等;
- 游标 pin/waterline/dead-letter(FLY-1099)与 FLY-605 flush 纪律逐字节保留。
- 测试:无 cursor 老 thread 不回放历史;watermark 并发新消息不丢(head 之后的下轮可见);有 cursor thread 行为不变;空 pending thread 入账;晋升/late-rebind race。

### 4.4 no_route_needed 白名单(R1#9 收紧)

三条件不变(matching=0 ∧ thread 零 pending ∧ 非 reply);词面 = **封闭枚举 token 表**:短 ACK 语(好/好的/嗯/ok/okk/谢谢/辛苦了/收到)+ **被逐一批准的 ACK emoji 仅 👍 与 ✅**(🛑/🚢/❌/任何未列 emoji 一律不命中 → 模型巷)。evidence.basis 记具体 token。对抗 fixture 含 emoji 组(验收 #7)。

### 4.5 route CLI(R1#9 边界收紧)

`flywheel-comm route-founder-reply --msg <msgId> (--to-question <qid> | --no-route --reason <r>)`:
- 模型巷行落 `candidates_json`(结构化冻结候选集:questionId 列表 + leadId/project/issueId/threadId scope);
- CLI 组合 UOW 内**重新校验**:模型巷行仍 current(未 processed/superseded)∧ qid ∈ 冻结候选集 ∧ scope 匹配 ∧ question 仍 pending ∧ 非 report/review-gate/superseded ∧ 非 GATED_CHECKPOINTS(ship 目标拒绝,提示走 card-reply/✅ 重确认);
- response race 两分(R2#3 —— 赢家 response **不是**本 founder 消息的路由证据):
  - 同一 route UOW 已提交过(root/model evidence 已在)→ 真幂等 success;
  - 竞争者先答该 question → 返回 `stale_candidate`,模型巷行**保持 pending**,Lead 必须另选冻结候选或显式 `--no-route --reason already_answered` —— 后者才写 typed evidence(kind=lead_no_route, basis=already_answered, ref=winningResponse, actor=本 Lead)并双标两行;绝不把他人 response 自动当本消息的 processed 证据。测试:他人先答 / 同 CLI commit 后重试两分支;
- lease 授权 + 拒 reserved attribution(对齐 `respond.ts:57-87`);response 的 fromAgent=leadId(不伪造 founder 归属)。

## 5. Runner 方向:wake 持久状态机(S3;provenance=06c6dfa07/PR#648 CLOSED,全量重审)

### 5.1 admission(事务内,R1#5;R2#1 简化)

组合 UOW 内裁决:`INSERT OR IGNORE` 命中既有行 → `duplicate`(不重推);per-exec 滑动窗 cap 超限 → `suppressed_cap` 零 push + outbox 告警恰一次(§2.2)。**ledger 写失败 = 整个 UOW 回滚、fail-loud**(intent 与业务写同事务,不存在「业务成了台账没成」的中间态;R1 草稿的 suppressed_ledger_unavailable 态与 recovery 腿随之删除 —— 同事务化让它们无必要)。causal key 合同同 research §6.2(gate-answer/instruction/founder-route/ship-hint;ship-hint 记账不进梯)。`envelope_json` 在 admission 时冻结(重推按此重建,不重造 timestamp/flywheelId)。

### 5.2 push 与 T1(claim-before-write + 硬预算,R2#1)

initial push 与 T1 重推**共享** `push_attempts ≤ 2`,**claim 事务内先扣**:单事务 CAS(`claim_token`+`claim_expires_at`)+ 分配 attempt ordinal + `push_attempts++` → push(T1 用 `MailboxTransport.writeVerified` :77,按 envelope_json 重建)→ completion 单事务按 ordinal 合并 `last_push_result/last_push_at`、释放 claim;并发 tick 输者 no-op。crash 任何一窗**预算都已耗**(claim 后崩 = 该 ordinal 记为未知结局,不退款);stale success 只补 delivery fact。耗尽仍 pending → 走 T2/T3,绝无第三次 push。

### 5.3 T2(受审计终端原语,R1#6 —— 不新造裸注键路径)

T2 **扩展 `runner-recovery-nudge.ts` 既有 sanctioned primitive**(fresh capture+fingerprint、idle input box、scope、audit-before-send,`:1-18,144-274`)加 `wake_pointer` mode(allowlist 新增该动作):
- 真值表(全过才注,任一不确定 fail-closed):pane 探测 waiting ∧ session ∈ {parked, awaiting_review} ∧ **causal question 无 terminal response 悬空错配**(gate-answer 类:该 questionId 的 response 已存在——即 wake 有效)∧ 无其他 unanswered gate 冲突 ∧ live binding 一致 ∧ fresh capture/fingerprint/输入框空闲 ∧ adapter/target 合法;
- **durable claim-before-act**:先单事务落 `t2_claimed_at`(终身一次),再注键;crash 不重打;门不过 → `t2_result='forbidden:<reason>'` → 直进 T3;
- 注入文本 = 短指针「你有 pending wake,跑 flywheel-comm inbox」。

### 5.4 T3(两阶段 outbox)与 patrol

- T3 到期:单事务落 `receipt_alert_outbox(id='wake_failed:<intentKey>')` + intent 行 `escalation_outbox_id`;投递器(Bridge,piggyback)消费 outbox → **effect 前 source revalidation**(§2.3 合同)→ `notifyLeadFirst(kind='wake_failed')` → 确认后标 `delivered_at`。恰一次靠 outbox id;crash 两窗测试(落 outbox 前/后)。
- patrol(GatePoller piggyback,零新 timer):T1/T2/T3 推进 + **terminal 分流 stand-down(R2#4)**:
  - cancel(真 stand-down):intent 已 `started` / causal 业务已完成(gate 已答且 wake 目的达成)/ 明确 superseded;
  - **不 cancel、直升 T3**:session 终态为 failed/dead / target 消失且 intent 从未 started → 落 `wake_failed:terminal_before_started` outbox(kill-pane 验收 #3 正是此路 —— terminal sync 先于 patrol 到也不吞升级);
  - 测试:terminal sync 先于 T2 / clean completion 与 dead runner 两分支 / started 后各级取消。

### 5.5 started ack(R1#6 约束)

- `inbox`/`turn` 命令**入口先捕获 `observedAtMs`**,本职成功后,仅 ack `queued_at <= observedAtMs` 的 pending 行(exec-level scope;Codex daemon 保持既有逐 message 精确 ack,`ack_scope` 区分);
- 身份:优先 launcher env/session 绑定推导 execId;`--exec-id` 仅 debug override(audit 标记);
- vendor=none:不入梯(admission 标 skipped_no_transport)。

## 6. 未处理轴:root 唯一状态机(S4;R1#4)

### 6.1 巡检(piggyback,先推导后催)

1. `deriveProcessedFromResponses`(§3.2 provenance-copy 规则)—— 验收 #4;
2. 选取:**仅 retry-owner 行**(R2#2;R3#1 NULL-safe):`resend_of IS NULL` ∧ 要求 processed(§3.3)∧ `processed_at IS NULL` ∧ **`delivered_at IS NOT NULL`** ∧ `next_unprocessed_at <= now` ∧ `(routing_state IS NULL OR routing_state NOT IN ('awaiting_rebind','model_promoted'))`;其中 gate/runner question 还必须仍 pending(`resolved_at/superseded_at` 为空、非 `terminal_disposed`、无 response),该守卫在 bootstrap、到期选取、consumer revalidation 与 delivery 初始化四处一致(模型巷 owner 带正值 `model_pending`,天然入选;hub-root 让位后 next_unprocessed_at=NULL 天然出局;每个 Discord msgId 全链恰一个 family/owner/outbox)。测试:F-6/A-3 真库全链(创建→delivery→WINDOW→r1→cap→单 outbox),以及 Lead/founder 任一方答门后均零重发零升级;
3. **cap 判断先于递增(R2#2)**:`resend_round < RESEND_CAP` → 单事务:`resend_round++`、`next_unprocessed_at = now + WINDOW`(每轮完整窗口)、插入重发行 `{id:<root>#r<N>, resend_of, resend_round:N}`(UNIQUE(resend_of,resend_round) 幂等;**不复制 ref_message_id** —— idx_lead_inbox_ref 全局唯一,重发行经 content 携带上下文,R1#4);
4. `resend_round >= RESEND_CAP` → 升级(**不再改 round、不再插行**):单事务落 `receipt_alert_outbox(id='unprocessed:<rootId>')`;投递器 → source revalidation(§2.3)→ `notifyLeadFirst(kind='receipt_unprocessed:<type>', episodeFingerprint=rootId)` → outcome ∈ {notified, already_notified} 且 durable 行核实 → root `escalated_at` 回填;`no_owner`/`target_clearing` **不写** escalated_at(保持可重试,R1#7)。

### 6.2 family 收口

evidence 到达(response/route/显式 no_route/推导)→ 组合 UOW 内:root processed(+ 模型巷行双标,如在)+ **全部重发行**标 `disposition='superseded_by_evidence'` + 未投递 outbox 行 cancel(§2.3)+ 关联 wake 梯级按 R2#4 分流 stand-down。重发行永不自己升级、永不有独立 episode。测试:重复 tick 幂等;r1 后 response 到 → family 全收口零催;cap 边界(恰 RESEND_CAP 次重发,零 r{cap+1} 行);无嵌套 id;**每个 Discord msgId 全链恰一个 family/owner/outbox**;重启后 next_unprocessed_at 尊重。

### 6.3 detection-escalation 新装配(R1#7)

- **新 reconcile callback + kind-scoped 过滤合同(R2#5)**:GatePoller 只有一个 `onDetectionReconcileTick` slot(`gate-poller.ts:199-206`),且现 `getDetectionEscalationsForReconcile()` 读**全部** non-RESOLVED 行 —— 直接复用 = 旧 legacy 行被新 flag 重新激活。落法:StateStore 加 **kind-scoped 查询**(参数化 kind 集合);plugin 把两个 pass 组合进单一 callback(single-flight),**互斥 kind 集**:新闭环只消费 `wake_failed` + `receipt_unprocessed:*`(封闭枚举),受 `FLYWHEEL_RECEIPT_FOUNDATION` 门;旧 pass 只消费其余 kind,仍受 `legacyDeliveryWatchdogsOn` 门;禁用 unfiltered run;
- **cohort-aware CLEARING 合同(R3#2 —— 全局 mute 会跨 cohort 死锁)**:`hasClearingDetectionEscalationForTarget` 是 target 全局、不看 kind(`StateStore.ts:10067-10074`)—— legacy CLEARING 行 + legacy pass 关闭时,`wake_failed` 会被 mute 成 NEW 且**无人执行 CLEARING TTL→NEW rebound** → 永久静音,连带 kill-pane 验收失效。采 **(b) 拆分方案**:CLEARING TTL maintenance(`detection-escalation.ts:349-369` rebound 逻辑)抽成**无 page/fleet 副作用的共享 pass**,任一 cohort 开启即运行(target 全局 mute 语义保留 —— 清理期不吵是对的);page/fleet 严格 kind-scoped 不变。**矩阵预期相应修订**:receipt-only 下允许对过期 legacy CLEARING 做 rebound(仅状态回弹),仍禁止对旧行 page/fleet。**flag 矩阵测试 00/01/10/11** + **同一 targetKey 组合测试**:legacy CLEARING + receipt NEW → fresh mute 生效、TTL 后 receipt 恢复可升、legacy 行零 page;
- **owner/pager resolver 补 Lead-keyed 目标**:`<project>:<leadId>` targetKey → owner=该 Lead 自己(notify 巷)+ founder-page resolver 走 issue thread(root 行内有 issueId/threadId)或统一告警频道 fallback;runner 可定位的 episode(wake_failed)继续用 execId target 走既有 resolver;
- `escalated_at` 语义 = **Lead-first notified 已确认**;founder page 状态查
  `detection_escalations` 行(ESCALATED)——办结与升级各有 durable 锚,不混写;
  restart 两 crash 窗测试。

## 7. flag 与切片顺序(R1#11 —— flag 先行)

**S1(首刀)= flag + registry + 组合事务 API + schema**:
1. 注册 `FLYWHEEL_RECEIPT_FOUNDATION`(`packages/config/src/feature-flags/registry.ts`,kill_switch,默认 ON,readSites 列全 + boot/live timing);
2. migration(§2 全部)——schema additive 常驻,**所有行为变化**(S1 的 claim 退避/model 上限/死信、S2 入账、S3 台账、S4 巡检、§6.3 新 reconcile)统一受该 flag 门;
3. §2.5 组合事务 API + crash-injection;
4. **flag-off sentinel 先落**:`=0` 断言 —— 零新写入(founder_msg/phase_wakes claude 路径/outbox)、model adapter 连败行为逐字节(无上限差异)、claim 节奏逐字节(无 next_retry_at 过滤)、六分支逐字节、巡检/新 reconcile 零执行;突变验证(sentinel 真的会红)。

**S2** founder 入账+路由 CLI(§4);**S3** wake 状态机(§5);**S4** 未处理轴+升级装配(§6);**S5** 验收 fixture + 529 真机独立 QA。

未送达轴三缺口修法(research §7.4)归 S1,细化(R1#10):model 巷 `maxModelAttempts`(默认 5)超限 → **独立 batch dead-letter 事务**:冻结整批(不动 immutable membership)、行标 disposition=dead_letter、落 `receipt_alert_outbox(id='dead_letter:<batchId>')`,一次提交;投递器恰一次告警;existing-batch discovery(`:365-383`)与 fresh claim 都尊重 `next_retry_at`。测试:双 crash 窗、Bridge restart、sink 失败重试恰一次、并发 tick、`=0` 连败行为逐字节。

## 8. 参数表(env 全带 `FLYWHEEL_RECEIPT_` 前缀)

| 参数 | 默认 |
|---|---|
| WAKE_T1_MS / T2_MS / T3_MS | 90s / 5min / 12min |
| UNPROCESSED_WINDOW_MIN(内部按类型覆盖) | 30 |
| RESEND_CAP | 2 |
| MODEL_MAX_ATTEMPTS | 5 |
| RETRY_BACKOFF_BASE_MS / CAP_MS | 5s / 10min |
| REBIND_WINDOW_MIN | 15 |
| PUSH_BUDGET(initial+T1,per-intent 硬上限) | 2 |
| EXEC_PUSH_CAP / EXEC_PUSH_WINDOW_MIN(per-exec 滑动窗,R2#1) | 6 / 10 |

## 9. 逐调用点改线矩阵(R1 修订)

| 调用点 | 处置 |
|---|---|
| `founder-reply-deliverer.ts:482-787` | S2:hub-root 入账(hub_recorded)+ 终局写;归因/授权/游标不动 |
| `gate-poller.ts:3877-3946` ambiguous handoff | S2:产模型巷行(candidates_json 冻结);审计镜像保留 |
| `gate-poller.ts:3097-3175` 扫描面 | S2:byThread 从非终态 session 出发 + bootstrap watermark |
| trusted founder writer(`db.ts:1276-1338`) | S1:**事务体扩展**(授权/业务语义零改动);R1#1 |
| `respond.ts:134,201,273` / `send.ts:102-134` | S3:组合 UOW + intent(gate-answer/instruction key) |
| `wake.ts:57` | S3:按 intent 行 push(envelope_json),不再裸写(flag-off 回裸写) |
| `lead-inbox-loop.ts` claim/failure | S1:next_retry_at 过滤 + model 上限 + batch dead-letter(flag 门) |
| `runner-recovery-nudge.ts` | S3:wake_pointer mode(唯一 sanctioned 终端路径) |
| `detection-escalation.ts` | 状态机零改动;S4 新装配 reconcile + Lead-keyed resolvers |
| `db.ts:2456-2464,2502-2513` cleanup | S3:保留非终态 wake 行;TTL-prune 终态 |
| `inbox.ts` / `turn.ts` | S3:observedAt 约束 ack |
| `question-admission.ts` / founder approval 授权语义 / FLY-1373 consumed 语义 / ACK 退役 | **不动** |

## 10. 风险与边界

1. 原子性三条 = 承重墙(§0.1),review blocking。
2. Known Limitations 承接 research §10(报告类降级、无已读层、终态 thread 不扫、Bridge 死=失明(W-2/FLY-1393)、Lead 单点不缓解、ship 延迟实测);实施后 R4 的 10 条 non-blocking advisory 已逐条写入 research §10.1,含可接受理由/护栏/后续处置,不以“review 通过”掩盖限制。
3. 唤醒风暴:事务内 admission + 预算 CAS + episode 恰一次 + fail-closed;负载测试断言 DB 故障期零 push。
4. 顺序合同:v1 保持 `ORDER BY priority, seq`(显式取舍,research §8)。
5. 与 FLY-1373 定案零冲突;processed 是叠加列不是改写 consumed。
6. FLY-1339 落地后 re-scope(B3 未吸收,留其裁决)。
7. 独立 QA 按 research §10.2 强制注入两类“发生时必须变响”的失败:transient T2 refusal 提前退休 wake、edited founder content 卡滞 retry;另在 529 房记录全 non-terminal thread scan 的 REST/429 观测。
