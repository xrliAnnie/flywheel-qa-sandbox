# FLY-1392 设计 v2 — category-agnostic 收据层(回炉后唯一设计 authority)

Issue: FLY-1392 (URL 不可得,只写 issue 号)
日期: 2026-07-21
基于: capture-facts.md(QA 纯事实清单)· design-correction.md · 分支 head 幸存实现

**Status**: codex-approved(design review 6 轮:R1 8 + R2 8 + R3 4 + R4 2 + R5 1 = 23 条 blocking 全部采纳,R6 APPROVED;R6 备注:§4 legacy migration fixture、child-id 幂等记账、三 crash seam 为对应切片合入 gate,非可延后补充)
**Founder 批准**:Annie 对 founder-design-v2.html 点头「lgtm」(thread msg 1529235408997712013,2026-07-21;经 Tadashi 转达 lead-instruction 4ffe5645)—— 阻塞门解除,implement 可接棒;R6 三条为切片合入硬 gate 随 handoff 传递。
**Authority 顺序**:本文 > design-correction.md > 本目录其余旧文(改型前记录,已带作废横幅)。

---

## 0. 一句话

任何人发给 Lead 的每一条消息,进来就记一笔账;账上只问一件事 ——「Lead 办了没有」;没办就顶回催办,再不办就升级;新种类的消息**不用任何人做任何事**就自动被这套账管住。

## 1. Founder 五条裁定 → 设计逐条对照(硬需求,可测,不回退)

| # | 裁定(capture-facts §2 逐字;msg id = founder 原话锚) | 设计落点 | 可测断言 |
|---|---|---|---|
| 1 | 完全照抄 Claude Code 拓扑;Bridge 不自己处理(msg 1529180997403410454) | Bridge 纯传送带 = **无条件性质**(不受任何 flag 影响,§4 flag 合同修正 —— R2#5);账本是影子记录不是处理者 | 逐字转发断言;flag-off 下同样零代答 |
| 2 | 一层收据,目的 = 防漏(msg 1529181179960365238) | 对外唯一概念「Lead 办了没有」 | 意图级 SQL 一行一列 |
| 3 | **message category agnostic:每条传到 Lead 的消息都要处理、都要有收据;到账处理与消息种类分隔**(msg 1529211733363785768) | 全触点去类型化(§2.3);**豁免面收窄到「非真实投递」**(§2.6 —— R2#1:telemetry 类别豁免撤销,progress 真投 Lead 就真追) | §2.3 清单逐点;豁免枚举仅 internal_mirror |
| 4 | 默认朝覆盖,新类型不能漏(category-agnostic 裁定同流,见 capture-facts §2 id 注) | 默认翻转 + 端到端突变(真 enqueue → 可见 T3) | §7 验收 2 |
| 5 | 地基先做对(issue 描述,非 Discord 消息) | activation episode 合同(§4)保证 cutover/反复开关时性质成立 | dry-run 门 + off/on 幂等测试 |

> 本方案路径经 founder A 路径确认(msg 1529214547016155176 与 1529215670045249727);裁定 6「QA/Opus 不做设计」= msg 1529216092730294382(流程纪律)。id 由 Lead 在场记录补齐(lead-instruction 68ebe4a6)。

## 2. 统一模型

```text
到了(delivered)  每一次真实 Lead delivery,账本恰有一条 canonical receipt row
办了(processed)  Lead 的统一 handle 动作,或「有权代表该 Lead」的客观证据(授权 auto-settle)
不必办(disposed) 业务对象已终态(如问题被别人答掉)→ 收据废止停催 —— 不冒充「Lead 办了」
没办(overdue)    超窗仍未办 → 顶回(重发进 Lead 收件箱)→ 再超窗 → 升级 founder
```

### 2.1 canonical receipt row(R1#2;R2#2/#3 修正)

**不变式(R2#2 修订版)**:**每条实际发生的 Lead delivery 恰有一条 canonical receipt row。** 按承运方分两族,行上显式 `carrier` 列区分:

| 族 | carrier | 承运方 | receipt 生命周期 |
|---|---|---|---|
| LeadInbox lanes(founder/runner 提问/报告/事件) | `inbox` | row 本身经 LeadInboxLoop 投递(msg_class=model) | delivered_at = adapter durable receipt(幸存) |
| External-transport lanes(跨部门 Discord/roundtable) | `external` | 现有 Discord/Codex transport 照旧承运;row 是**外部投递的收据行,永不被任何 queue 承运面选中** | 见 §2.4a 两库 saga |

**external 行的完整 queue lifecycle 合同(R3#4 —— 只改主 claim 谓词不够)**:
- schema:`carrier TEXT NOT NULL DEFAULT 'inbox' CHECK(carrier IN ('inbox','external'))`,migration 回填旧行为 `inbox`;
- external accept 的 delivered transition **同事务**写清 transport-consumed 状态:`consumed_at = delivered_at` + delivery disposition(`external_delivered`)—— 追办 deadline 仍按 delivered_at 初始化(追办 selector 只看 processed/disposed/豁免/时钟,不看 consumed);
- **枚举并修改全部 queue 承运/计数面**(实现验收清单):`countPending`(`lead-inbox-queue.ts:482-496`,只看 consumed_at —— external 若留 NULL 会把 loop 钉在 active cadence)、`claimPending`(`:561-618`)、`claimProtocol`/`claimByClass`、`claimModelBatch`、retry/dead-letter/index 面 —— external 行一律不选中;
- 验收:逐一调用每个公开 claim API 断言 external 行永不返回;`countPending` 不计已接受 external 行;receipt patrol 仍能按 deadline 选中它。

**founder 单行 producer 合同(R2#3 —— 修当前双行病的可执行形状)**:
- **唯一 writer** = founder handoff:构造**一次** canonical model payload(渲染后的原文 + msgId/issueId/threadId scope),经**支持 caller-supplied deliveryId 的 queue API** 原子入队,id = `founder_msg:<leadId>:<msgId>`、msg_class=model、P0、carrier=inbox;
- 现 `enqueueFounderHubRoot`(protocol/consumed 形态,`lead-inbox-queue.ts:388-438`)**退役**为该 API 的兼容 wrapper 或删除其独立 insert;`makeAmbiguousHandoff` 不再经 `enqueueLeadEvent` 派生第二条 `lead_event:*` 行(现 API 强制派生 id 且同 id 异字段抛错,`lead-event-queue.ts:10-67`/`lead-inbox-queue.ts:339-379` —— 所以必须由 queue API 新增 caller-id 支持,不是复用旧口);
- StateStore `appendLeadEvent` 如保留仅作 audit,**不得再物化第二条 lead_inbox 行**;
- founder cursor **只在** canonical row 的 durable queue receipt 返回后推进;
- `routeFounderReply` wrapper 从同一 row 校验原始 msgId/project/issue/thread scope;
- 测试:先写 row 后 crash / row 在而 StateStore marker 未落 / retry 幂等;真 RuntimeRegistry E2E 断言一消息恰一行、办结零 sibling overdue(旧 18/18 不作数)。

**纯内部镜像**:必须 link canonical(family_root_id)且以 `internal_mirror` 豁免(§2.6),绝不按业务类别豁免。

### 2.2 「办了」与「不必办」的写入面

#### (a) 统一 handle 动作合同(R1#5;R2#7 幂等键修正)

| 合同项 | 规定 |
|---|---|
| receipt id 可见性 | 投递内容随带 canonical receipt id(渲染层附带) |
| 授权 | `authenticatedLead === row.to_lead` ∧ lease/generation 有效;拒 reserved attribution |
| 动作 × 前置状态 | `relay/respond`:row 非终态 ∧ ref 业务对象仍 pending;`no-route`/`ack`:row 非终态;不满足 → 确定性错误码 |
| 事务边界 | response(如有)+ 终态写 + evidence + wake intent = 单 comm.db 事务;三窗 crash-injection |
| **幂等键(R2#7)** | **caller request id + canonical payload digest**(action 的 target/content 摘要持久化):同 id 同 digest → 返回原结果;同 id 异 digest → `idempotency_conflict`;新 request 撞终态 row → `already_processed` / `already_disposed`。`(id, action)` 二元组**不够**(relay(q1) vs relay(q2) 同键会吞冲突) |
| 审计 | evidence 记 action/actor/epoch/reason;结果持久化供重放 |
| 批量 ack | 逐项 request id + 授权校验 + 逐项结果;重试只重放失败/未知项 |

`routeFounderReply`(`db.ts:2008`)收编为经过验证的兼容 wrapper,原约束(root/source/type/ref/pending/scope 校验)一条不丢。

#### (b) 授权 auto-settle(优化,非覆盖条件;R1#4)

- question/gate:保留 `from_agent = to_lead`(`db.ts:3206`)并按授权处理者关系泛化(lease/generation/provenance);不放宽;
- 跨部门:仅 §2.4b 可证明因果;
- 负测:other-lead / bridge-legacy / stale generation / duplicate 不写 processed;正测:目标 Lead 本人写 processed。

#### (c) disposed —— 持久 schema 与终态互斥(R2#4)

```sql
disposed_at        TEXT;   -- 业务终态废止时刻
disposed_evidence  TEXT;   -- typed JSON(何事实、谁造成、authorized disposal predicate 判定依据)
```

- **DB 级不变式:终态互斥 = at-most-one(R3#1 修正 —— 不是字面 XOR:pending 行两者皆空是合法态)**:禁止 `processed_at` 与 `disposed_at` 同时非空;并成对约束 `(processed_at IS NULL) = (processed_evidence IS NULL)`、`(disposed_at IS NULL) = (disposed_evidence IS NULL)`(半写不可审计态非法)。SQLite 落地 = 建表 CHECK(旧库经重建迁移或等价 trigger)+ 应用层 CAS 双保险,migration 先验证存量数据;`markProcessed` CAS `disposed_at IS NULL`,`markDisposed` CAS `processed_at IS NULL`;同证据重试幂等,异证据/异终态 → conflict;验收覆盖 pending / processed-only / disposed-only 三合法态 + both / half-written 非法态;
- 两者共用**统一 family closure**:清 `next_unprocessed_at`、resend 行失效、outbox cancel/revalidation(幸存合同);
- authorized disposal predicate 显式定义(业务对象终态的客观来源:question superseded/answered-by-other 的现有 disposal 谓词收编 —— R1 真机 HIGH 修复语义在此存续);**不依赖实时 join 推断**;
- 现有 `disposition` 列(transport/delivery 结果)不复用为 receipt 终态 —— 职责分离;
- 竞态测试:dispose-vs-handle / dispose-vs-settle / dispose-vs-resend / dispose-vs-outbox / 重启持久性。

#### (d) 方向翻转

无 auto-settle 规则 → 照样追,催到 Lead handle(含 ack)为止。报告类翻为「追 + 批量 ack」。

### 2.3 追办统一 —— 全触点去类型化(R1#1)+ priority 合同(R2#6)

触点清单 T1–T7(锚点见 R1 反馈,冻结进实现验收):

| # | 触点 | v2 规定 |
|---|---|---|
| T1 | enqueue 入账 | 统一合同(§2.5);**priority 为 producer 显式必填参数**(缺省 P2) |
| T2 | consume 首窗 | 一切非豁免行 `COALESCE(next_unprocessed_at, delivered_at + priorityWindow)` |
| T3 | bootstrap 回填 | cohort =「delivered ∧ 未 processed/disposed ∧ 非豁免」,零类型集合(§4) |
| T4 | due advance | selector = 状态 + priority + 豁免 + owner 谓词 |
| T5 | 告警 revalidation | 按 row 状态,零类型 |
| T6 | escalation kind | 单一 `receipt_unprocessed`(type 只进 payload metadata) |
| T7 | priority 归一 | **P0–P3 全窗表(下);非法值拒收**;unknown 类型走缺省 P2 + 通用 context(project/issue/thread 入账时写全) |

**priority → 窗口表(R2#6 恢复并补全;env 前缀 `FLYWHEEL_RECEIPT_WINDOW_P<n>_MIN`)**:

| priority | 窗口默认 | 语义 |
|---|---|---|
| P0 | 30min | founder 消息等 |
| P1 | 30min | 提问/gate/跨部门点名 |
| P2 | 240min | 报告/缺省 |
| P3 | 24h | 低急缓(**有窗,会追** —— R2#1) |

每轮 resend 沿用同窗(幸存「每轮完整窗口」合同)。**`priorityForLeadEvent`(`lead-event-queue.ts:17-43`,type 字符串定级)退役**:现有 producer 逐一迁移为显式传 priority(迁移映射表冻结其当前有效级,行为保持);generic ingress 不解析 `event_type`。测试:mixed-priority batch / 缺省 P2 / 显式 P3 / 非法值。

### 2.4 入口清点与跨部门接入

| lane | 现状 | v2 |
|---|---|---|
| founder 消息 | 双行病 | 单行 canonical(§2.1) |
| runner 提问 | ✅ | 保留 |
| 报告类 | 入账不追 | 翻默认:追 + 批量 ack |
| **纯遥测(progress)** | 入账永不追 | **真投 Lead 就真追(P3 24h 窗,批量 ack)—— telemetry 类别豁免撤销(R2#1)**;仅「不展示给 Lead 的内部观测副本」按 internal_mirror 豁免且 link canonical |
| runner 唤醒工单 | ✅ `runner_phase_wakes` | 保留 |
| 跨部门 Lead 消息 | 零账本行 | accept 边界记账(下) |

#### (a) 跨部门 = transport durable-accept 边界记账 + 两库 saga(R1#6;R2#2)

- 记账判定 = transport 自身 accept 判定(mention-gate/echo-immunity/thread 发现),结构性零漂移;
- row:`id = xdept:<leadId>:<discordMsgId>`、carrier=external、P1;
- **两库 saga(Codex 侧 journal.db 与 comm.db 无单事务;且 `LeadInputRouter.submit` accept 即起 pump,receipt 不能放它之后)**:
  1. filters 通过后、submit **之前**:幂等写 receipt(`delivery_pending` 状态,delivered_at NULL);
  2. transport accept/duplicate 成功后:标 delivered_at + 首窗初始化(同事务);
  3. 任一步失败 → gateway 返回 false、cursor 不推进、重试补齐缺失步;
  4. **`delivery_pending` 孤儿永不进追办**(selector 要求 delivered_at 非空 —— 幸存谓词);
  5. **saga reconciler(R3#3 —— 盲 TTL 清理禁止)**:`delivery_pending` 行与「submit 已 durable accept 但 delivered 未标」的 crash 形态外观相同,Lead 可能已真的开跑该 turn。孤儿收敛只能经 durable reconciler 按 msg id/幂等键**反查 Lead journal**:journal 已 accept/更后态 → 幂等补完 delivered transition;journal 确证不存在且已越过安全 retention/watermark → 标 `delivery_aborted`(tombstone+审计,不算真实 delivery);journal 不可读/结论未知 → quarantine + 可见告警,**绝不删除**。TTL 只触发 reconciliation,自身不是 disposal authority。测试三分支:submit 后失去 Discord 重放 / journal 不可用 / journal absent;
- cutover watermark:activation 时持久化 snowflake 下界,独立于 fetch 成功;
- 测试:两处 crash seam(receipt 后 submit 前 / submit 后标 delivered 前)+ Lead 恰收一次 + baseline 失败/重启/记账失败注入。

#### (b) 跨部门 auto-settle —— 可证明一对一因果(R1#7)

证据枚举:① Discord explicit reply reference;② durable journal inbound→turn→outbound 映射。同 channel + 时间接近**禁止** settle;证据缺失靠显式 ack;reply-before-ingest 可重放补 settle;竞态统一幸存 CAS/family-closure/outbox-revalidation;测试矩阵同 R1#7。

### 2.5 入账合同(唯一硬规则)

每次真实 Lead delivery 发生时必须存在 canonical receipt row;enqueue 调用点显式二选一:默认(追办)或 `exempt('internal_mirror')`。没有第三态;未知收件人拒收。

### 2.6 豁免 —— 收窄 + 审计(R1#8;R2#1)

- 枚举**仅** `internal_mirror`(不代表真实 Lead delivery 的行);**任何真实投递给 Lead 的消息不可豁免,无论类别**;
- append-only `receipt_exemption_audit(event_id, receipt_id, reason, actor, ts, change_source, operation, prev_value, new_value)` —— 设置与撤销均可无歧义重放;
- 新增 reason = 代码变更;运行时无豁免开关。

## 3. per-type 凭据合同机器 — 正式退役方案

| 退役对象 | 处置 |
|---|---|
| 对外两层收据叙事 | 已废 |
| per-type coverage/window/bootstrap/revalidation 谓词(T2–T5) | 删,换状态+priority+豁免 |
| per-type escalation kinds(T6) | 收敛单一 kind |
| `priorityForLeadEvent` type 字符串定级(T7) | 退役,producer 显式 priority + 迁移映射 |
| 「新类型默认不催」 | 翻转,端到端突变锁死 |
| `deriveProcessedReceipts` per-type 推导 | 收编授权 auto-settle 注册表;身份约束不放宽 |
| telemetry 类别豁免(v2.1 草案) | **撤销**(R2#1) |
| bridge-protocol 自动归因 | 已删;不回潮断言 |
| hub-root 双行形态 | 废除(§2.1) |
| evidence/actor/epoch | 保留 = 内部卫生 |

## 4. activation episode 与 flag 合同(R1#3;R2#5)

- **持久 activation episode 表**(替代一次性 marker):`receipt_activation_episodes(episode_id, disabled_at, enabled_at, activation_at, status, dry_run_counts, commit_counts, high_water_mark)` —— 支持任意次 off/on,重启可判「本次 enable 是否已回填」;
- **每次 enable 的幂等 cohort**:所有 `delivered ∧ 未 processed/disposed ∧ 非豁免` 的 pending 行(**含 flag-off 前已 pending、关闭期 deadline 过期的行**),该 episode 首次 commit 时统一重锚 `enabled_at + priorityWindow`;**未 delivered 行不入 cohort**(由正常 delivery 事务初始化 —— R2#5 补 delivered 条件);
- **`delivered_rounds` 字段迁移与投递事务合同(R5#1 —— 旧 `resend_round` 是物化计数,不得直接沿用)**:
  - schema 新增 root `delivered_rounds INTEGER`(**不复用**未经重算的旧 `resend_round` —— 现实现于 due-advance 物化 child 的同一事务就把 root 计数 +1,`db.ts:3382-3419`,child 未必投递过);
  - **首次迁移按 durable delivery evidence 回填**:只统计该 root 下 `delivered_at IS NOT NULL` 且确属成功 reminder effect 的 **distinct logical rounds**;无 episode 的 legacy child/outbox 归入 `legacy/v1` generation —— 已投递者计数,未投递者 activation 时 supersede,旧 pending outbox 按当前 episode 规则取消/重建;§4 旧「resend_round=COALESCE(,0)」条款作废,以本算法替代;
  - **未来投递事务合同**:LeadInboxLoop 确认 resend child 的 adapter durable receipt 时,**同一 comm.db 事务**完成:child delivered/consumed + root `delivered_rounds` 幂等 CAS 增量(同 child 重放不重复计数,以 child id 为幂等键)+ `next_unprocessed_at = delivered_at + priorityWindow`(下一轮完整窗);
  - migration fixture:旧 r1 已物化未投递 / 旧 r1 已投递 / r1+r2 混合;投递事务三 crash seam(receipt 后 CAS 前 / CAS 后窗前 / 全后)—— 断言 cap 与最终 T3 精确;
- **dry-run 门**:per-priority 计数(eligible/auto-settled/disposed/exempt/pending)+ T1/T2/T3/outbox 峰值预估;超阈不翻默认;
- **flag 语义修正(R2#5,宪法级)**:**Bridge 纯传送带无条件成立** —— `FLYWHEEL_RECEIPT_FOUNDATION=0` 只暂停 deadline advance/resend/escalation,**绝不回退到 legacy Bridge 代答分支**(现状 `founder-reply-deliverer.ts:581` else 路径恢复旧拓扑 = 违反裁定 #1,实现时移除该回退;逃生阀的 severe 告警幸存);入账照记;
- **chase artifacts 的 episode 围栏(R3#2;R4#1 定稿为 generation-scoped id 模型,消除三处冲突)**:
  - **id 模型(唯一,写死)**:resend child id = `<root>#r<logicalRound>@<episode>`;outbox id = `unprocessed:<root>@<episode>` —— generation 在 id 里,**没有固定 id,也就没有 resurrection 问题**(v2.3 的「固定 id + not_before 原地 rearm」表述作废 —— 它与 generation-in-id 互斥,R4#1);旧 generation 未 effect 的行 supersede/cancel 即可,新 episode 到期时创建**自己的**唯一行;
  - **outbox sender 校验(R4#1 修正)**:`alert.episode = currentEpisode ∧ alert.not_before <= now ∧ root 非终态` —— **不得**依赖 `root.next_unprocessed_at`(幸存 T3 路径在 outbox 入队时把它清 NULL,`db.ts:3440-3454`,三值逻辑下永不满足);
  - **cap 计数 = 已实际投递的 reminder 轮(R4#1)**:root 的 round 计数只在 resend child **真投递**后生效;supersede 一个从未投递的 child 不消耗 cap —— 新 episode 从**同一 logical round** 重建;已投递轮保留。逻辑轮与 materialized child 分离(root 记 `delivered_rounds`,child 记 logicalRound);
  - flag-off:未投递 resend child 不被 claim/发送(claim 谓词校验 episode 现势);patrol 停 = outbox 不 drain;
- 测试:连续两次 off/on / off 期间旧 deadline 到期 / 启动中断 / 重复启动零副作用 / flag-off 下零代答 / **r1 已入队未投递时 flag-off**、**T3 已入 outbox 未 drain 时 flag-off**(两者:off 期零 effect;re-enable 后新窗结束才继续,且断言具体 id/generation、delivered reminder count、cap 不被未投递轮消耗、最终恰一次 T3)。

## 5. 关键取舍(founder HTML 第 4 节的源)

1. **报告与低急缓消息也追**:一切真投 Lead 的消息都有窗(P3 24h);代价 = Lead 定期批量 ack;换 = 裁定 #3 无例外成立。提醒按 Lead/priority 聚合展示 + 稳定 id 批量 ack,账本仍逐行。
2. **auto-settle**:留作优化;身份约束不放宽;他人办了 = disposed 不冒充 processed。
3. **跨部门**:accept 边界记账(跟踪不承运);两库 saga 保「恰一次投递 + 孤儿不追」。
4. **豁免**:仅 internal_mirror + append-only 审计;运行时无开关。

## 6. 诚实边界(founder HTML 第 5 节的源)

1. Bridge 死 = 账本与追办停(W-2/FLY-1393);
2. 「办了」= Lead 办结动作或其授权证据;ack 不验证办的质量;
3. 跨部门 lane:账本保证「没办会被发现」,投递可靠性 = transport 现状;只有被点名的消息入账(刻意边界);
4. Lead 单点不缓解;
5. 追办时效受 loop/patrol cadence 约束;
6. 默认翻转经 dry-run 门 + 分片顺序(§8)控制,但 Lead ack 习惯是真实成本。

## 7. 验收(能力级)

1. 四 lane 同断言组(入账→办结 processed;或 disposed 停催);
2. 端到端突变:虚构新类型真 enqueue → 可见 T3;
3. 单行不变式:真 RuntimeRegistry founder E2E;
4. 授权 settle 负测 + 终态合同(at-most-one + paired-null:pending / processed-only / disposed-only 合法;both-non-null / processed 半写 / disposed 半写非法 —— 逐项断言,零 XOR 表述);
5. 豁免仅 internal_mirror,审计行可重放;
6. 跨部门真机腿:accept 记账 / 两 crash seam / 恰一次投递 / explicit-reply settle / 同频道闲聊不误 settle;
7. activation:两次 off/on 幂等 + dry-run 计数落档 + flag-off 零代答;
8. 不回潮:Bridge 零代答逐字断言(真 queue 路径,替代旧 18/18);
9. 意图级:Annie 任一真实消息一条 SQL。

## 8. 实施切片(R2#8 —— flip 真正最后)

- **S1** dormant 通用化:schema(carrier/disposed/audit/episodes)+ T1–T7 触点 + generic handle + flag 语义修正 —— 全部 flag-off/休眠落地,随片单测+竞态测试;
- **S2** 跨部门 accept 记账 + saga + settle 注册表(随片 crash-seam 测试);
- **S3** activation machinery(episode/dry-run)—— 仅 opt-in staging 验证,不翻默认;
- **S4** 能力级 harness 全量:四 lane + 真 RuntimeRegistry founder 单行 + 两库 fault injection + 容量 dry-run 落档;
- **S5** **默认翻转 + post-flip smoke + rollback drill** —— 任何翻转提交不得在 S4 全部 gate 通过前部署(若同一原子 PR,此约束写入 PR 部署说明)。

幸存器官(重发/升级/outbox/wake 台账/CAS 收口/severe 告警)零重写。

---

## 9. 已知限制 · QA 复核的非阻塞 advisory(QA 整理 · 纯事实 · 非设计)

> 由 QA(Opus)按 lead-instruction 25cab318 归档。**纯事实记录:每条 advisory + QA 复核发现 + 处置归属,零设计提案**(修法归 Fable 设计者)。灵魂不变式判据 = 消息 durable 记录 / 无静默丢 / 无代答。逐条 review 全文在 code review 输出。

| # | advisory(v2 code review,非阻塞) | QA 复核发现 | 处置归属 |
|---|---|---|---|
| 1 | external episode-stamp coupling | generation-scoped id(`@<episode>`)使旧 generation 行 supersede 而非复活;不击穿灵魂(孤儿不追、不重复) | 非阻塞;设计者按需 |
| 2 | 时区渲染 retry 分歧 | resend child 以 generation-scoped **id** 为幂等键,不靠内容哈希;时区/内容分歧不产生重复行;不击穿灵魂 | 非阻塞;设计者按需 |
| 3 | default-on 须 capability+dry-run+rollback 门控 | 是**部署前置**(§8 S5:flip 不得在 S4 全 gate 前部署),非代码 bug;dry-run 机器(`reconcileReceiptActivation` dryRun)已在 | 部署纪律;flip 前门控 |
| 4 | delivery-processed 审计顺序 | handle = 单 comm.db 事务(response+终态+evidence+wake intent 原子),事务内顺序不产生可观察半态;不击穿灵魂 | 非阻塞;设计者按需 |
| 5 | hub-root retry 过严 | v2 founder 单行 producer(caller-supplied deliveryId)+ generation-scoped id;不复用旧 strict-content-equality 卡滞路径;不击穿灵魂 | 非阻塞;设计者按需 |

**结论(QA)**:5 条均非阻塞、均不击穿灵魂不变式。#3 是真实部署前置(default-on flip 需 capability+dry-run+rollback 门,勿在 QA+founder 双绿前翻默认)。各条**修法/取舍归 Fable 设计者**,本表只记事实与复核。
