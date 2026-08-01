# FLY-1586 Lead 收件循环全舰队停摆 — 实施计划

Issue: FLY-1586 (https://linear.app/geoforge3d/issue/FLY-1586/p0承接-1579-修复-lead-收件循环全舰队停摆-毒行隔离-截断修复-存量冻结只投新增)
日期: 2026-07-31
基于: research.md

> 时间戳一律 UTC。本机 PDT = UTC-7。
> **R2 修订**：本版按 **FLY-1579 的** Codex design review R1 的 5 BLOCKER + 4 HIGH 全面重写。所有被采纳的结论均已由当时的 runner 独立复核（见 §11 复核记录），不是照单全收。
> ⚠️ **消歧（R2 LOW-10）**：这一行说的是 **FLY-1579** 的 R1（A/B/C 主体那 5 轮里的第一轮）。**FLY-1586 自己的**新增面评审轮次与计数**全部在 §13b**，两套编号不要混。

---

## 0.0 本版（FLY-1586）相对 FLY-1579 原稿改了什么

本文的 §0–§12 主体来自 FLY-1579 的分析与计划（Codex design review **5 轮 APPROVED**，thread `019fbaee-485c-76e3-a24c-72e2c0724b23`）。那个 run 被 FLY-1584 的 `no_code` 路由缺陷搞浅——节点 `completed` 后 DAG 跳过落地节点直奔 `founder_gate`，分支零提交、无 PR、无 remote 分支，1136 行产出只以未被 git 跟踪的文件存在。本单承接它去落地，原文按下面三点适配：

| # | 改动 | 理由 |
|---|------|------|
| 1 | **scope 收敛为 A + B + C + §1b 存量冻结；D 移出本单** | FLY-1586 的 scope 表逐字划界只写了这四项，六条验收里也没有 D 的接收端 alert receipt 那条。D 会改动**全舰队的告警路由**，在 P0 窗口里 blast radius 不小 → 另开 follow-up（见 §12.4）。<br>⚠️ 已就此非阻塞问 Lead（question `1b1ad330`），按默认（D 移出）继续；若 Lead 要求 D 留在本单，改回即可，A/B/C/§1b 的设计不受影响。 |
| 2 | **§1b 从「红线清单」补写为实现级设计**（§1b.4–§1b.9 全新） | §1b 是 5 轮 APPROVED **之后**才由 Lead 指令 `9f7c2f70` / `761c8bc6` 加入的新设计面，原稿只写了「九条硬性要求 + 拆单建议」，**没有实现设计**。plan §13 自己标了「实施前建议对 §1b 单独走一次 design review」——本版补上设计，并单独过一轮 review。 |
| 3 | **存量分流 + 解冻 → 承接单 B** | 本单只做「只投新增」，存量根本不进投递管道 ⇒ 重播风险**结构性为零**，而不是靠「分流先做对」来规避。 |

> **一句话记住本单的切线**：Lead 原版是**顺序约束**（分流必须先于隔离，P0 得等分流）；本版是**范围约束**（存量不进管道）。
> **前者要求分流做对；后者让分流做不对也不会伤人。**

---

## 0. 三个必须先纠正的前提（写在最前面，因为它们决定方案）

### 0.1 断裂点是 2026-07-29T13:00:23Z 的 Bridge 重启，不是回滚

回滚（07-31T23:18:59）比断点晚 **58 小时**，只是撤走了一直在掩盖它的 v2 通路。故障已存在 **60+ 小时**。

### 0.1b ⚠️ 影响面的正确说法：**拆掉了一个一直在工作的消音层**（Lead 指令 `629464fc`）

**不要写成「产生了新告警」。** Lead 先给了一个「触发器 = Lead 回复正在干活的 runner」的结论，随后**自己撤回**（他做了 7 次 respond 零条新 `wake_failed`，又去量了基线）：

```
wake_failed 按天计数（长期、高频、正在衰减的背景现象）
  07-22 132   07-23 128   07-24 71   07-25 2
  07-27  43   07-28  44   07-29  6   07-31 4
```

⇒ 在这种基线下，任意两条跟某个动作对上时间**是巧合的先验概率很高**。

但真正的结论**反而更强**：最近 15 条 `wake_failed` 里**只有 1 条走到 PAGED** —— 就是今晚 00:59 吵到 Annie 那条。

```
正常：wake_failed 触发 → Lead 收到通知 → Lead ack → 停在这里（几百条都是）
今晚：wake_failed 触发 → 通知走本单这条死掉的路 → Lead 收不到 → 不可能 ack → 一路 page founder
```

⇒ **本 bug 的影响面正确表述：把一个既有的高频告警源，从「被消音」变成「直达 founder」。**
**Lead 的 ack 是那道把它挡在 founder 之前的墙；墙塌了，它就漏出去了。**

⚠️ `wake_failed` 自身为什么高频触发，**不归本单，归编号 1514**，不要碰。

### 0.2 影响面是整条 `carrier=inbox`，不只是 question

16 个生产 Lead、6 个项目全部停摆。**60+ 小时**内 `carrier=inbox` 只被消费过 1 行。`carrier=external`（Discord 直投，不经过 loop）完好 —— 这就是 Lead 看起来还活着的原因。

### 0.3 ⚠️ 守卫**已经开火了 16 次**，缺的不是检测，是投递闭环

`InboxLoopHealthChecker`（`packages/teamlead/src/bridge/inbox-loop-health-checker.ts`，W2 默认开启，阈值 `FLYWHEEL_INBOX_LOOP_STALL_MIN` 默认 10 分钟）在通路死后 11 分钟准确开火，`lead_events` seq **57003–57018** 共 16 条 `inbox_loop_stalled`，`loop_heartbeat.stall_episode_at` 16/16 全部写上。

> ⚠️ **本节 R2 修正过一次。** 二稿曾断言「告警被路由进了它正在报告的故障里」，理由是 `delivered_at` 全空。**该推论不成立，已删除。**
> `LeadAlertNotifier.alert()` 的 Step 3 用 `tryClaimLeadEvent` 写 `lead_events` 只是**去重/审计 claim**；Step 5 是**直接 POST Discord**（`LeadAlertNotifier.ts:873-910`），**不经过 `LeadInboxRuntime` / `enqueueLeadEvent` / `lead_inbox`**。`delivered_at` 只由 `markLeadEventDelivered()` 写，notifier 成功 POST 后**不调用它**。
> ⇒ `delivered_at=NULL` 只证明**审计镜像**被 wedge 挡住，**不证明根告警没发出去**。二稿引为「正对照」的 07-20 那两条同理。

独立复核后可确证的只有三条：

| 结论 | 证据 |
|------|------|
| ✅ 检测开火 16/16 | `lead_events` seq 57003–57018；`stall_episode_at` 16/16 |
| ✅ 进到了 notifier 的跨进程 claim | `~/.flywheel/alerts/claims.db` 的 `alert_claims` 16 个 event_id 齐全 |
| ❓ **是否真的发到 Discord、有没有人看见 —— 无法确定** | 见下 |

**为什么无法确定**：`claims.db` 里那张看起来像收据的 `alert_deliveries`（`state IN ('leased','sent','queued','dead_lettered')`）**只由 `scripts/lead-alert.sh` 写**（shell 通道），**TS 侧 `LeadAlertNotifier` 根本不写它**。所以那 16 条在里面查不到 —— **这什么都不证明**。（阳性对照：该表在 07-29 13:01–13:22 有大量 `sent` 行，说明表当时在用，但那些是 shell 通道的别的告警。）

⇒ **TS 告警通道的发送结果在本仓没有任何持久化记录。** 这就是为什么 60+ 小时后没人能回答「当时到底有没有人看见」。

雪上加霜：`claimHealthEpisode` **先 latch episode、再发告警**，且**不校验 `alert()` 返回值**（`sent` / `queued` / `deadLettered` / `skipped:'duplicate'`）。latch 落下就不再重复开火 —— 无论当时发没发出去，**之后都永久闭嘴**。

⇒ **D 的正确定义**（三条都不同于二稿）：
1. **不新建 checker** —— 检测本来就是好的
2. **不写「改成 out-of-band」** —— 现有 `LeadAlertNotifier` **已经是** out-of-band 直发 Discord；要保留它
3. **要补的是发送结果的 durable outcome + receiver receipt**（见 §7）

---

## 1. 取证（在任何代码改动和任何重启之前）

⚠️ 本修复生效需要重启 Bridge，**重启会销毁现场基线**。

仓内可审查脚本：`scripts/fly-1579-capture-evidence.sh`（本单交付物之一，非临时命令）。硬性要求：

- 输出到**绝对路径** `engineering/doc/FLY-1579-question-admission-wedged/evidence/`，脚本内 `mkdir -p`，不依赖调用者 cwd
- **project/lead 目标集合从生效的生产配置动态导出**，不得硬编码，不得直接 glob `~/.flywheel/comm/*/`（那里混着 test-slot-* 和没有 `loop_heartbeat` 表的库）

必须留档的内容：

| # | 证据 | 为什么 |
|---|------|--------|
| 1 | 每个生产项目的 `loop_heartbeat`（含 `stall_episode_at`） | 通路活性铁证 |
| 2 | 每个生产 Lead 的 `lead_inbox` 积压计数 | 修复效果的分母 |
| 3 | `lead_events` seq 56649 的 payload | **回归 fixture 的原料** |
| 4 | `grep -c "was reused with different content" /tmp/flywheel-bridge.log` | 事务回滚只在日志里可见 |
| 5 | **16 条 `inbox_loop_stalled` 事件 + 生效的 W2 配置 + alert claim/outbox/dead-letter + Discord receipt + `/health.watchdogs`** | §0.3 的告警为什么不可见，必须先查清 |
| 6 | **冻结的 question cohort**（见 §5） | 否则部署时「7 可救 / 13 不可救」已漂移 |

**不留档就重启 = 把「修好了没有」变成不可证明。**

---

## 1b. 🔴 存量重播红线（Lead 指令 `9f7c2f70` + `761c8bc6`，最高优先级）

> **这一节推翻了「先解封让舰队恢复，再慢慢修」这个直觉。解封本身就是引爆动作。**

### 事实

积压里有 **40 条未投递的 `founder_msg`**，其中 39 条 `processed_at` 为空，**但全都已经生效了**。最要命的一条：

```
01:05:11  founder_msg  answer="ship"  issue=FLY-1569   delivered_at=NULL  processed_at=NULL
01:07:28  PR #742 MERGED                                ← 两分钟后就合了
```

⇒ **任何以 `processed_at IS NULL` 或 `delivered_at IS NULL` 为谓词的补扫/重投，会把 founder 已经执行完的 ship 指令重播一遍。**

一旦毒行被隔离、tick 恢复，投递循环会**照常把这 255 行投出去** —— Annie 的 ship 会被重新送到 Lead 面前一次，其他 Lead 的积压里有什么还不知道。

### 积压构成（Lead 已逐类核过）

| class | 未投递 | 近 1h 新增 | 性质 |
|-------|-------|-----------|------|
| `lead_event`（纯遥测） | 108 | 44 | 零 gate、零 question，重放只是吵，**无副作用** |
| `chat` | 28 | 10 | — |
| **`founder_msg`** | **40** | **2** | **唯一危险的**，有界、基本静止 |

⇒ 噪音面 +56/小时，**伤害面 +2/小时**。**不用抢工** —— 赶工的分流最可能的失手方式，正好是把 `founder_msg` 一刀切进去。

### 硬性要求（全部进实现）

| # | 要求 |
|---|------|
| 1 | **修复不能只是「让 tick 重新跑起来」。** 恢复投递前必须先对存量积压分流 |
| 2 | 分流**要有证据支撑，不能凭时间戳一刀切**。「ship→merge 时间对照」就是「已生效」的证据形状 |
| 3 | **做不到自动判定就默认不投存量、只投新增**，存量导成清单交给人。**宁可漏投一条陈旧通知，也不能重播一条 founder 的 ship** |
| 4 | **分流逻辑必须先于或同时于隔离逻辑生效，不能后补** —— 否则 Bridge 重启那一瞬间毒行被隔离、tick 恢复、255 行同时开闸 |
| 5 | 补扫**默认 dry-run，只出清单不投递**；真投递要**显式 flag** |
| 6 | **`founder_msg` 禁止自动重投** —— 只列，不投，人来决定 |
| 7 | **不变量检查器不许触发重投** —— 它是尺子，不是执行器 |
| 8 | 补扫要能**按 class 过滤**，输出里标注每条的「是否可能已生效」证据（有就贴） |
| 9 | **不要手工删 / 改 `lead_events` seq 56649 当作修复。** 隔离必须做在代码里。一次性运维解封是独立动作、要 founder 点头，**不进这个 PR** |

### 我的判断（回应 Lead「这种拆单判断我接受你来提」）

**建议拆单，切线是「只投新增、不投存量」** —— 这正是 Lead 自己给的第 3 条默认值：

| | 本单 | 拆出去的新单 |
|---|------|-------------|
| 范围 | A 规范化 + B 隔离 + C 截断 + **存量冻结（只投新增）** | 255 行存量的证据驱动分流 + 解冻 |
| 效果 | **P0 解除**：新 question / 新通知恢复流动 | 存量按证据逐条决定投或不投 |
| 重播风险 | **结构性为零**（存量根本不进投递） | 有，但可以慢慢做对 |

理由：Lead 的数据显示伤害面有界且基本静止（+2/hr），而噪音面是纯遥测。**把「恢复流动」和「处理存量」解耦，既立刻解除 P0，又让分流不必赶工。** 若 Lead 认为存量冻结实现代价过高，退回到「本单只做隔离 + 完全冻结投递（不解封）」也可接受，但那样 P0 实际未解除，需要 founder 知情。

---

## 1b.0 ⚠️ 两处必须先纠正的继承错误（不纠正会直接写错代码）

FLY-1579 原稿（和 FLY-1586 issue 正文）里有两句措辞，独立复核代码后**不成立**。结论都不变，但**照字面实现会写出不工作的代码**，所以必须先改口径。

### 纠正 1：`founder_msg` / `lead_event` / `chat` **不是 `msg_class` 的值**

`msg_class` 这一列的取值集合**只有两个**：

```sql
-- packages/flywheel-comm/src/lead-inbox-queue.ts:159
msg_class TEXT NOT NULL CHECK(msg_class IN ('protocol','model')),
```
```ts
// packages/flywheel-comm/src/lead-inbox-queue.ts:5
export type LeadInboxMessageClass = "protocol" | "model";
```

Lead 盘点里那个「class」是**业务类别**，实际编码在 `id` 前缀 / `source` / `type` 三列上：

| 业务 class | `id` 形状 | `source` | `type` | `msg_class` | 写入点 |
|---|---|---|---|---|---|
| **`founder_msg`** | `founder_msg:<leadId>:<msgId>` | `founder_reply` | `founder_reply` | `model`（`priority=0`） | `lead-inbox-queue.ts:667-670`；id 由 `founder-reply-routing.ts:19-21` 铸 |
| `lead_event` | `lead_event:<leadId>:<eventId>` | `lead_event:<seq>` | 事件类型 | `model` | `lead-event-queue.ts:11,25-27`；回填 `legacy-lead-event-reconciler.ts:113,142-144` |
| `question` | `question:<leadId>:<questionId>` | `question:<seq>` | `gate_question` \| `runner_question` | `model` | `question-admission.ts:154-158` |
| `chat` | 回执 id | `discord_chat` | `external_delivery` | `model` + **`carrier='external'`** | `commands/chat-receipt.ts:185-193` |
| ack | `ack:<leadId>:<receiptId>` | `ack_receipt:<id>` | `ack_receipt` | **`protocol`** | `protocol-ingress.ts:65-68` |

⇒ **`WHERE msg_class='founder_msg'` 永远匹配零行。** 冻结与清单的 class 过滤（§1b 红线 #8）必须按 **`id` 前缀 / `source` / `type`** 写，并且 `founder_msg` 的**权威判据取 `source='founder_reply'`**（`id` 前缀由调用方铸，`source` 由 `enqueueHubRoot` 自己写死，更可信）。

### 纠正 2：`admit()` **不在 tick 最前面**——但结论更强，不是更弱

`packages/teamlead/src/bridge/lead-inbox-loop.ts:156-273` 的实际顺序：

| 行 | 动作 | 在 try 内？ |
|---|---|---|
| `:158` | `recordTickStarted` | ❌ 在 try **之外** |
| `:159` | `afterTickStarted?.()` | ❌ 在 try **之外** |
| `:164-172` | `acquireOrRenewOwner` → 失败 `throw` | ✅ |
| **`:173`** | **`await this.opts.admit?.()`** | ✅ |
| `:175-220` | protocol claim 循环（`claimProtocol`） | ✅ |
| `:222-230` | **`claimModelBatch`**（真正的投递批） | ✅ |
| `:261` | `catch` → 记 warn，返回 `{ok:false}`，**异常不再上抛** | — |

⇒ 正确表述：**`admit()` 排在两条 claim 路径之前**；它抛异常 → `:261` 捕获 → **`claimProtocol` 与 `claimModelBatch` 一条都不执行** ⇒ 投递零动作，且 tick 对外只表现为 `ok:false`。

`admit` 的三步串行（`lead-inbox-runtime.ts:109-113`）：
```ts
admit: async () => {
    await this.ensureCutover(secretProvider);      // ← 毒行在这里抛
    await admission.materializePending();          // ← 永远走不到
    protocol.materializePending(lead.agentId);     // ← 永远走不到
},
```

**为什么这个纠正重要**：原措辞「admit 在最前面」会让人以为把 admit 往后挪就能绕过。真实机制是 **admit 与两条 claim 在同一个 try 里，一荣俱荣一损俱损** —— 这也正是 §10「不改 `admit()` 在 tick 中的位置」那条禁令的真实理由（挪位置会动 at-least-once 语义，且并不解决问题）。

---

## 1b.4 F 的数据模型：freeze epoch + **冻结身份集**（不是「冻结行集」）

**约束回顾**：不改 `lead_inbox` 的列（§10）、不加 feature flag（§10）。⇒ 冻结状态落在 **CommDB 里新增的独立表**，靠**数据为空**实现字节兼容，不靠 env 旁路。

> ⚠️ **R1 BLOCKER-1 带来的核心修正：冻结的对象是「稳定身份（`id`）」，不是「安装那一刻已经存在的行」。**
> 存量的**权威**不在 `lead_inbox`——事故当下大量存量还躺在 `lead_events` 里没被搬过来，还有些 question 连 inbox 行都还没有。
> 只冻结「已物化的行」= 把**尚未物化的存量**当成新增放行。**必须按身份预登记。**

```sql
-- 一个库最多一条 active epoch。安装一次性、幂等、可验。
CREATE TABLE IF NOT EXISTS lead_inbox_freeze_epoch (
  epoch_id       TEXT PRIMARY KEY,          -- 逐字确定性:'FLY-1586.v1'(见下)
  incident_ref   TEXT NOT NULL,             -- 'FLY-1586'
  installed_at   TEXT NOT NULL,             -- UTC ISO
  inbox_seq_floor        INTEGER NOT NULL,  -- 安装事务内 lead_inbox 的 MAX(seq)(空表记 0)
  legacy_event_seq_floor INTEGER NOT NULL,  -- StateStore lead_events 的 MAX(seq) 快照
  -- ⚠️ R3 BLOCKER-3:原 founder_snowflake_floor 列已作废(本机时钟不是 Discord
  --    的 authority),改由 founder_thread_watermark 表承担,见 §1b.8 来源 ④
  schema_version INTEGER NOT NULL,          -- ⚠️ R3 HIGH-6:comparator 需要它
  activation     TEXT NOT NULL              -- 'freezing' | 'inert'  (见 §1b.7)
                 CHECK(activation IN ('freezing','inert')),
  install_identity_count INTEGER NOT NULL,  -- ⚠️ R2 BLOCKER-2:安装时登记数,immutable
  install_counts_json    TEXT NOT NULL,     -- 按业务 class 的安装时快照(取证),immutable
  status         TEXT NOT NULL
                 CHECK(status IN ('active','superseded'))
);
-- 「最多一条 active」用 partial unique index 强制,不靠口头声明
CREATE UNIQUE INDEX IF NOT EXISTS idx_freeze_epoch_active
  ON lead_inbox_freeze_epoch(status) WHERE status = 'active';

-- 逐条冻结身份 = append-only 审计 + 交给人的那份「清单」本身
CREATE TABLE IF NOT EXISTS lead_inbox_frozen_identity (
  epoch_id     TEXT NOT NULL,
  inbox_id     TEXT NOT NULL,               -- 稳定身份。行可能还不存在
  enrollment_phase TEXT NOT NULL            -- ⚠️ R3 HIGH-6:install 与 delayed 必须可区分
               CHECK(enrollment_phase IN ('install','delayed')),
  enrolled_via TEXT NOT NULL                -- 见 §1b.8 的四个来源
               CHECK(enrolled_via IN ('inbox_row','legacy_event','pending_question','founder_ingress')),
  inbox_seq    INTEGER,                     -- 物化后回填;未物化时为 NULL
  to_lead      TEXT NOT NULL,
  biz_class    TEXT NOT NULL,               -- 派生自 source/type/id 前缀(§1b.0 纠正 1)
  source       TEXT,                        -- 未物化时可空
  type         TEXT,
  origin_ref   TEXT,                        -- legacy_event 记 lead_events.seq;question 记 question id
  frozen_at    TEXT NOT NULL,
  unfrozen_at  TEXT,                        -- 本单永远为 NULL;承接单 B 才写
  unfreeze_evidence TEXT,                   -- 承接单 B 的证据字段,本单只建列不写
  PRIMARY KEY (epoch_id, inbox_id)
);
CREATE INDEX IF NOT EXISTS idx_frozen_identity_active
  ON lead_inbox_frozen_identity(inbox_id) WHERE unfrozen_at IS NULL;
```

**`epoch_id` 必须逐字确定性** = `'FLY-1586.v1'`（incident ref + 版本）。理由：多进程 / 多 Lead 共享同一个 project DB，随机 ID 会让「幂等安装」退化成「每个进程各装一条」。配 partial unique index，第二个进程的 INSERT 直接撞唯一约束 → 走 verify 分支。

### ⚠️ R2 BLOCKER-2：安装必须 **existing-first**，绝不能「重算快照再逐字比对」

原稿写的是「已存在 epoch 时**重新计算**并逐字段比对 floors / activation / counts，任一不同即抛」。**这个设计会让正常重启自己把自己 wedge 死**，失败序列可复现：

```
第一次安装 → activation='freezing', inbox_seq_floor=N
B 修复生效 → tick 成功 → recordTickSuccess 推进 last_success_at
Bridge 正常重启 → 新 tick 重算:floor 变成 N+k(有新 enqueue)、
                  activation 算出来是 'inert'(机器已经不 wedge 了)
                  → comparator 抛 → ensureCutover 每跳失败 → 又 wedge
```

这些字段**全都不是确定性输入**：新 enqueue 推进 inbox floor、新 StateStore event 推进 legacy floor、延迟登记改变 counts、修复成功本身改变 activation。

**定稿：existing-first。**

1. 安装事务开头**先读**确定性 `epoch_id`
2. **存在** ⇒ **已存的那条就是权威**。**不重算任何 floor / activation / heartbeat / StateStore**。

   ⚠️ **R3 HIGH-6：「内部一致性」必须写成封闭集合，否则实现不出来、或在正常 delayed 登记之后失去判别力。** 定稿只校验**持久化数据彼此的 immutable 关系**：

   | # | 校验 |
   |---|---|
   | 1 | epoch 常量 / `schema_version` / `status` 合法，且**恰有一条** active epoch |
   | 2 | `inert` ⇒ 三个 floor 全 0、`install_identity_count=0`、**零 identity** |
   | 3 | `freezing` ⇒ `install_identity_count = COUNT(enrollment_phase='install')`，且 canonical `install_counts_json` 的分项和**等于**该 count |
   | 4 | `enrollment_phase='install'` 且 `enrolled_via='inbox_row'` ⇒ `inbox_seq <= inbox_seq_floor`；所有非 NULL `inbox_seq` 必须能 join 到**同一** `id`/`seq`/`to_lead` |
   | 5 | `enrolled_via='legacy_event'` 的 `origin_ref` 必须是安全整数且 `<= legacy_event_seq_floor`；`founder_ingress` 的 origin 必须是合法 snowflake 且 `<=` **对应 thread** 的 watermark |
   | 6 | 稳定 ID 必须由**共享 helper 复算一致** |
   | 7 | `delayed_enrolled_count` **只由 `enrollment_phase='delayed'` 现查**，不参与恒等断言 |

   > **绝不校验**：当前 floors / heartbeat / StateStore 全集、以及会正常变化的 `delivered_at`/`consumed_at`/`unfrozen_at` 状态。
   > **未来 supersede**：新版本 installer 接管后，旧 `FLY-1586.v1` 的 comparator **不得**因为看见一个合法 successor 就永久抛。
3. **不存在** ⇒ 才计算 proposed snapshot 并 INSERT
4. 并发 INSERT 的**输家**撞 unique 冲突后 **重读赢家那条并接受**，绝不拿自己稍早/稍晚的快照要求字面相等

**counts 必须拆成两个**：`install_identity_count`（安装时，**immutable**）与运行时查询得到的 `delayed_enrolled_count`（**会合法增长**）。把一个会合法增长的计数当成恒定快照去断言，是 R2 抓到的同一个错误的另一面。
`install_counts_json` 用 **canonical encoding**（key 排序固定），否则「同一份内容不同序列化」也会误判。

**为什么用「显式逐条身份表」而不是只留一个 seq 水位线**：

1. §1b 红线 #3 要求「存量导成清单交给人」—— **这张表本身就是那份清单**，不需要另写导出逻辑二次推导（二次推导 = 两边理解漂移 = 下一个同类事故）。
2. 255 条是**很小**的量，逐条完全负担得起。
3. 承接单 B 的解冻是 **per-row CAS 写 `unfrozen_at` + 证据**，天然可审计、天然幂等。
4. **单靠 seq 水位线堵不住旁路** —— 见 §1b.11：resend 子行、late materialization 的 seq 都是**新的**。

---

## 1b.5 判定边界必须用 `seq`，**绝不能用 `created_at`**

`lead_inbox` 的主键就是单调递增列：

```sql
-- lead-inbox-queue.ts:154
seq INTEGER PRIMARY KEY AUTOINCREMENT,
```
`AUTOINCREMENT` 保证**严格单调、永不复用**（允许 gap，但已提交的值不回退）。

而 `created_at` **不是入库时刻**——legacy 回填会把它显式写成**源事件的历史时间**：

```ts
// legacy-lead-event-reconciler.ts:148
createdAt: envelope.timestamp,   // ← 来自 sqliteTimestampToIso(row.created_at)(:92)
```
```sql
-- lead-inbox-queue.ts:570-577
created_at = COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
```

⇒ **一行可以是「刚刚才插进来的」但 `created_at` 写着 07-29。** 用 `created_at` 划线两个方向都会错。`created_at` 上也**没有任何索引**。

> 这同时回应 §1b 红线 #2「不能凭时间戳一刀切」：本设计**不读时间戳做冻结判定**。
> ⚠️ 注意区分：§1b.7 的**激活判据**会读 `loop_heartbeat` 的时间差——那是判断「这台机器是不是真的 wedge 了」，不是判断「某一条消息是不是存量」。两者不能混。

---

## 1b.6 结构性闸：**所有** `carrier='inbox'` claim seam 共用一个谓词

§1b 红线 #4 要求「分流必须先于或同时于隔离生效，不能后补」。**用执行顺序满足它是脆的**。改成**结构约束**：

> **没有 active freeze epoch，`carrier='inbox'` 的投递选行一律抛。**
> **有 epoch 时，冻结身份一律选不中。**

### ⚠️ R1 HIGH-3：seam 比「三条选行 SQL」多，逐个都要接

单一共享 helper（`deliveryEligiblePredicate` + `assertActiveEpoch`），**必须**接到下面**每一个** seam —— 候选 SELECT、CAS UPDATE、最终 read-back 三段都算：

| # | seam | 位置 |
|---|---|---|
| 1 | `claimByClass` 候选 SELECT | `lead-inbox-queue.ts:2028-2043` |
| 2 | `claimByClass` CAS UPDATE | `:2044-2058` |
| 3 | `claimModelBatch` 找旧批 | `:1187-1198` |
| 4 | `claimModelBatch` 取回旧批成员 | `:1209-1216` |
| 5 | `claimModelBatch` 组新批 | `:1236-1244` |
| 6 | `claimModelBatch` 冻批 CAS UPDATE | `:1256-1262` |
| 7 | `claimModelBatch` 最终 read-back | `:1278-1280` |
| 8 | **`claimPending()`** | `:1086-1144` — **公开导出方法**，候选 / UPDATE / read-back 三段都能返回任意 pending inbox 行 |

⚠️ **`claimPending()` 目前没有生产 caller**（仓内唯一同名命中是 `account-heal/pending-store.ts:116` 的**另一个无关函数**），但它是**导出的公开 API** ⇒ 不接它，「所有投递侧 claim 都受闸」这条 API 不变量就是假的。
**处置**：接同一个闸（不删、不改签名 —— 删公开方法属于 scope 扩张）。

谓词形状（`NOT EXISTS`，命中身份表的 partial index）：

```
（现有全部谓词） AND NOT EXISTS (
    SELECT 1 FROM lead_inbox_frozen_identity f
     WHERE f.unfrozen_at IS NULL
       AND ( f.inbox_id = lead_inbox.id
             OR f.inbox_id = lead_inbox.resend_of )   -- 子行继承父行,一层足够(§1b.11 旁路 A)
)
```

epoch 存在性断言在每个 claim 入口**最前面**：读不到 active epoch → **抛**（不是返回空 —— 返回空会被上层误读成「队列空了」，那是把 fail-closed 悄悄变成 fail-open）。

| 情形 | 行为 |
|---|---|
| epoch 缺失 / 表不存在 | **抛** → tick `ok:false` → 下跳重试。**绝不投递** |
| epoch `activation='inert'` 或身份集为空 | 谓词退化恒真 → **与改动前逐字节等价**（§1b.7） |
| epoch `activation='freezing'` | 冻结身份**永远选不中**，新增照常流动 |

**安装点**：`ensureCutover`（`lead-inbox-runtime.ts:206-268`）内、**在 `LegacyAckDrain` 与 `LegacyLeadEventReconciler` 之前**。安装失败 → 抛 → 清 memo 下跳重试（现有行为）。

⇒ **F 先于 B 生效不靠调用顺序，靠「没 epoch 就不投」这条结构性事实。** 即使有人把安装挪到后面、或进程在中间崩溃，**最坏结果是不投，不是重播**。

### ⚠️ R1 HIGH-3 的第二半：**降级（rollback）会打穿这个闸**

旧 binary **完全不认识**冻结表。新代码一旦把 seq 56649 正文化并留下 pending 行，旧 reconciler 会因 `existing` 命中而 `continue`（`legacy-lead-event-reconciler.ts:112-124`），**旧 claim SQL 随后把全部冻结存量投出去**。⇒ 只写「运行纪律」不够，`§9` 的回滚矩阵在这一格是**不安全**的。

**定稿：把闸下沉到 DB 层，让它在旧 binary 上也生效。**

```sql
CREATE TRIGGER IF NOT EXISTS lead_inbox_frozen_claim_fence
BEFORE UPDATE OF claimed_by ON lead_inbox
-- ⚠️ R2 HIGH-3:绝不能加 `OLD.claimed_by IS NULL`。三条 claim SQL 都允许
-- 重占过期 claim(`claim_expires_at < ?`)或同 owner 续占 ⇒ 非NULL→非NULL
-- 的 UPDATE 会整个绕过 trigger。Codex 用本 DDL 实跑复现:
-- expired_nonnull_reclaimed=old-binary-owner。
-- 新 binary 本来就不该去 claim 冻结行,所以无条件拦是对的。
WHEN NEW.claimed_by IS NOT NULL
 AND EXISTS (SELECT 1 FROM lead_inbox_frozen_identity f
              WHERE f.unfrozen_at IS NULL
                AND (f.inbox_id = OLD.id OR f.inbox_id = OLD.resend_of))
BEGIN SELECT RAISE(ABORT, 'lead_inbox row is frozen by FLY-1586 freeze epoch'); END;
```

**这个 trigger 的代价必须明写**：旧 binary 撞上它会**抛 → tick 失败 → 又 wedge**。
**这是有意选择的交换**：`wedge`（可观测、可前滚修）**优于** `replay founder 的 ship`（不可逆）。方向与红线 #3 一致。

### ⚠️ R2 HIGH-3：原稿「旧 binary 只会 wedge，不会 replay」**是错的**

trigger 只认 CommDB 里**已存在**的冻结身份。原稿的来源 ② 是**延迟登记** ⇒ 那些 legacy 行在被物化前身份根本不存在 ⇒ 旧 binary 用旧 reconciler enqueue 它们时**没有任何东西会写身份**，trigger 无从知道 `source='lead_event:<seq>'` 落在 floor 之内 ⇒ **旧 claim 直接投出去 = replay**。

**两处修复合起来才闭合**：

1. **来源 ② 改为安装时急切预登记**（§1b.8）—— 身份在旧 binary 有机会跑之前就已在 CommDB 里，trigger 于是拦得住
2. **trigger 去掉 `OLD.claimed_by IS NULL`**（上面 DDL 的注释）—— 否则带过期 claim 的冻结行可以「非 NULL → 非 NULL」穿过去

⇒ 修完之后仍然**只声明到这里为止**：

> **本迁移正式声明为 roll-forward only。**
> 回滚矩阵「降级到旧 binary」一格写 **不安全 —— 会 wedge，且在急切预登记未覆盖的边角仍可能 replay**。**不写「安全」，也不写「最多只是 wedge」。**
> PR 必须附**前滚恢复 runbook**，部署系统层面**禁止旧 binary 启动**（不能只靠运行纪律）。

**F12 必须覆盖四条**：① `claimed_by` 从 NULL 起的 claim；② **过期非 NULL claim 的重占**；③ 同 owner 续占；④ **旧 binary 对 legacy 行的后物化**。

---

## 1b.7 激活判据：**不是「任何库第一次跑新代码就冻」**

### ⚠️ R1 MEDIUM-7：无条件首装会冻掉健康库的合法消息

原稿把这条写成「已知代价、方向保守、接受」。R1 指出它比看上去重：本单**没有解冻能力**，所以被误冻的合法消息要**一直等到承接单 B**，不是短暂 backpressure。而且安装在**首个 tick 的 lazy `ensureCutover`** 里，进程启动到 epoch 安装之间到达的**真正新消息**也会被算进存量。

**定稿：激活由「安装事务内可判定的 incident 谓词」决定，不是「第一次跑就冻」，也不加 env flag。**

### ⚠️ R2 BLOCKER-1：原稿的谓词会把**全新库**判成 wedged（已实跑复现）

原稿写 `last_success_at IS NULL` **也算** wedged。但 `recordTickStarted()` 在 `try` 与 `ensureCutover()` **之前**执行（`lead-inbox-loop.ts:156-173`），它 `INSERT INTO loop_heartbeat (lead_id, last_started_at)` —— **只写 `last_started_at`**（`lead-inbox-queue.ts:1923-1931`）。

⇒ **全新库首个 tick**：`last_started_at` 已被本 tick 写上、`last_success_at` 仍是 `NULL` ⇒ 原谓词**必然返回 true** ⇒ 全新库被判 freezing。Codex 用本计划的 SQL 做最小 SQLite 复现，得 `fresh_db_wedged=1`。**M-7 根本没闭合。**

**定稿谓词：要求「曾经成功过、然后停了」，而不是「没成功过」。**

```
wedged := EXISTS (
  SELECT 1 FROM loop_heartbeat
   WHERE last_success_at IS NOT NULL          -- ← 关键:必须曾经成功过
     AND last_started_at IS NOT NULL
     AND (julianday(last_started_at) - julianday(last_success_at)) * 1440.0
           >= <FLYWHEEL_INBOX_LOOP_STALL_MIN 的生效值>
)
```

| 库 | `last_success_at` | 判定 | epoch |
|---|---|---|---|
| **全新库**（首 tick） | `NULL`（从没成功过） | **不** wedged | `inert`，身份集空 |
| **健康库** | 刚刚 | 不 wedged | `inert`，身份集空 |
| **本次生产 fleet** | 冻结在 07-29 13:00，已 61+ 小时 | **wedged** | `freezing` + 完整登记 |

### `inert` 的语义必须写死（R2 指出它不是封闭状态）

原稿隐含「inert ⇒ 身份集永远为空 ⇒ 字节兼容」。R2 指出两个反例，**都成立**：

1. **inert 库仍会长出冻结身份** —— §1b.8 的延迟登记原稿只判 `row.seq <= floor`，**没判 activation**；§1b.6 的 `NOT EXISTS` 也没关联 epoch。⇒ inert 库跑完 reconciler 就变成「有 active 冻结身份的 inert 库」，开始挡消息。
   **修**：**所有** enrollment 路径**必须显式要求 `activation='freezing'`**；`inert` epoch 的三个 floor **一律写 0** 且**绝不运行延迟登记**。
2. **inert 是永久 fail-open** —— 安装时健康、之后才 wedge 的库，会永远满足「有 active epoch」这个 claim gate，却一条冻结身份都没有。

**定稿口径（写进代码注释与 PR）**：

> `activation` **immutable，不允许 CAS**。
> `inert` 的含义**只有一个**：**「FLY-1586 这次部署在这个库上没命中」**。
> 它**不是**「replay fence 已就位」的证明，**不得**被后续任何隔离动作当成安全依据。
> 未来的 incident 需要**新的 epoch 版本**（`FLY-XXXX.v1`），通过把旧 epoch 置 `superseded` 来接管（`status` 列与 partial unique index 正是为此留的）。
>
> ⇒ claim gate 的断言含义要精确写成「**F 已就位**」，**不是**「存量已冻」。这两句话不一样，混起来就是下一个「拿标签冒充事实」。

**为什么这满足「不加 feature flag」**：判据完全 **data-driven**，读的是这个库自己的健康状态，没有任何 env 开关、没有人工拍板位。同一份二进制在健康库上自动 inert、在 wedge 库上自动 freezing。

**为什么这不是「凭时间戳一刀切」**（红线 #2）：它判的是**这台机器是否处于 wedge 状态**（机器级、可独立复核的健康事实），**不是**判某一条消息是否已生效。逐条消息的判定仍然**一条都不做** —— 全部冻住交给承接单 B。

**残留窗口（诚实写明）**：进程启动 → 首个 tick 安装 epoch 之间到达的新消息，seq ≤ floor ⇒ 会被登记为存量。
但在 `activation='freezing'` 成立的前提下，这台机器**本来就一条都投不出去**，该窗口内不存在「本可正常投递却被误冻」的消息。**在健康库上这个窗口根本不激活。**

---

## 1b.8 登记来源：**四个**，不是一个（R1 BLOCKER-1/2 + R2 HIGH-4 的正解）

冻结身份集的权威是「**epoch 之前就已存在的源事实**」，不是「安装那一刻的 `lead_inbox` 行集」。

### 来源 ①：安装事务内的 `lead_inbox` 行 —— **两类，不是一类**

```sql
-- (a) 未消费的 model 行(会被直接投出去的那批)
SELECT id, seq, to_lead, source, type FROM lead_inbox
 WHERE carrier='inbox' AND msg_class='model'
   AND consumed_at IS NULL AND seq <= :inbox_seq_floor

UNION ALL

-- (b) ⚠️ R1 BLOCKER-2:能生成 resend 提醒的 canonical root。
--     它们通常已 delivered / 已 consumed,不在 (a) 里,但子行会被投出去。
SELECT id, seq, to_lead, source, type FROM lead_inbox
 WHERE carrier='inbox' AND resend_of IS NULL
   AND delivered_at IS NOT NULL
   AND processed_at IS NULL
   AND disposed_at IS NULL
   AND receipt_exempt_reason IS NULL
   AND seq <= :inbox_seq_floor
```

⚠️ **R2 MEDIUM-7：(b) 不是「逐字对齐」真实候选，我写错了。** 真实的 `advanceDueUnprocessedReceipts()` 还要求 `processed_evidence IS NULL`、`escalated_at IS NULL`、`next_unprocessed_at IS NOT NULL AND <= now`、`receipt_episode_id` = active episode（`db.ts:4745-4761`）。

**定稿**：抽一个**共享的稳定子谓词 `resendCapableRoot`**（= 上面 (b) 那五个条件），installer 直接用它；`advanceDueUnprocessedReceipts` 在它之上**追加运行时条件**（active episode / due time / 未 escalated）。

⇒ enrollment 是**有意为之的保守 superset**（登记数会多于当轮真正 due 的 root），**不是**「逐字相等」。一个 helper 不可能同时表达「安装时的潜在可能性」与「此刻的到期资格」。文档需给出多余登记数的可观测预期，避免被当成 bug。

### 来源 ②：`lead_events` 里 `seq <= legacy_event_seq_floor` 的存量 —— **安装时急切预登记**（R2 后改）

这些还没物化成 inbox 行；它们会在 cutover 时由 `LegacyLeadEventReconciler` 首次 enqueue，**拿到新 seq**。

⚠️ **跨库**：`lead_events` 在 StateStore（`teamlead.db`），`lead_inbox` 在 CommDB（每项目 `comm.db`）。

> **R2 HIGH-3 促成的改动：从「延迟登记」改为「安装时急切预登记 + 延迟兜底」。**
> 原稿只做延迟登记，留下一个 DB-level fence 堵不住的洞：**降级到旧 binary** 时，旧 reconciler 会 enqueue 这些 legacy 行但**不写身份** ⇒ trigger 无从知道它该拦 ⇒ 旧 claim 直接投出去。
> ⇒ 原稿「旧 binary 只会 wedge，不会 replay」**是错的**。急切预登记把身份**在旧 binary 有机会跑之前**就写进 CommDB，trigger 于是能拦住它。

**定稿协议**：

1. 安装事务内记水位线 `legacy_event_seq_floor`（对 StateStore 取 `MAX(seq)` 快照读）
2. **新增一个 transaction-owning StateStore snapshot API**（⚠️ R3 BLOCKER-2：**不能**直接用现有 `listUndeliveredLeadEvents()`）：在**一个 StateStore 读事务内**同时取 floor 与全部 `delivered_at IS NULL AND seq <= floor` 行，用 `(afterSeq, limit)` **完整分页**取尽。
   > **为什么现有 API 不行**（`StateStore.ts:9984-9992`）：它是**全局** `delivered_at IS NULL ORDER BY seq LIMIT ?`，默认硬上限 **10,000**，**没有** `seq <= floor`、**没有**分页、**没有** project/lead 过滤。后果：① 超过 10k 时后半存量**没有急切身份**，旧 binary 的 trigger 又失去挡板；② `MAX(seq)` 与 list 两次独立读之间新插入的 `seq > floor` 会被**误冻**；③ 每个 project CommDB 会枚举**全 fleet** 的身份，清单与 counts 越权失真。
   > 生产现在只有 ~255 行不构成性能问题，但**正确性合同不能暗含「永远少于 10k」**。
3. 快照结果**按生效配置里的 project/lead 分区**，再在各自 CommDB 的安装事务内写对应身份，`enrolled_via='legacy_event'`、`enrollment_phase='install'`（`inbox_seq` 留 NULL，`origin_ref` = `lead_events.seq`）。
   - 某个 project 安装失败 ⇒ **该 project 无 epoch ⇒ claim fail-closed**；已提交的其它库由 existing-first 接续
   - 跨库读失败 → **抛**（fail-closed，不装 epoch）
   - ⚠️ **不要把全局 scan 放在 CommDB 写事务里** —— 会重复扫描并长时间占住 SQLite writer lock

### ⚠️ R3 HIGH-4：急切登记**绝对不能走现有的 envelope 构造路径**，否则 F 会自我瓦解

计划要求调**生产的** id 铸造函数。但仓内唯一「从 row 构造生产 envelope」的 helper 在 `event: JSON.parse(row.payload)` 处**解析 payload**（`legacy-lead-event-reconciler.ts:82-94`）。

⇒ 若 installer 顺手复用这条自然路径，它会**在 epoch 安装阶段就撞上毒行并抛** —— 而验收 #8a 恰恰要求 invalid JSON 是可隔离的 poison。**结果是 A/B 根本没机会运行，整个 fleet 继续 wedge。**

**这是本设计最讽刺的一个自毁开关：为了保护存量而加的登记，会先被存量里的毒行干掉。**

**定稿**：抽一个 **identity-only helper** `canonicalLeadEventDeliveryId({ leadId, eventId, seq })` —— 它本来就只需要这三个字段（`lead-event-queue.ts:7-12`），正常 enqueue 与 installer **共用它**。

> **installer 严禁**：解析 payload、render envelope、probe delivery、触碰任何 routing shape。
> **必须留 fixture**：invalid JSON / lone-surrogate 的行**也能被急切登记身份**，证明**安装成功**，随后才由 B 分类隔离。
4. **延迟兜底仍保留**：reconciler 处理某行时若 `row.seq <= floor` **且** `activation='freezing'` **且**身份不存在 ⇒ 在 enqueue 的**同一个 CommDB 事务内**补写身份。写身份失败 → **抛**（与 enqueue 同生共死）
   - ⚠️ 实现必须提供一个 **transaction-owning API**（一个函数内开事务、同时做 enqueue + identity），**不能靠调用方纪律去调两个独立方法**

> 跨库不假装原子：水位线是**快照读**，不与 CommDB 事务同生共死。这没问题 —— 水位线只用于**划界**，真正的挡人靠 CommDB 里的身份集，而身份集的写入全部在 CommDB 事务内。

⇒ 水位线**之后**新产生的 event 才是真新增。

### 来源 ④：founder ingress 的 Discord 水位线（⚠️ R2 HIGH-4 新增，第五条旁路的正解）

**R2 抓到的洞**：founder 指令的 authority **在 Discord，不在这三个本地枚举源里**。`founder-reply-deliverer` 会在 epoch **之后**从 `after=<cursor>` 读到**早就存在于 Discord** 的 founder message（`founder-reply-deliverer.ts:264-309`），然后才铸 `founderMessageRootId(leadId, msg.id)` 并 enqueue（`:393,556`）。该行的 seq 与稳定身份**都是 epoch 后新出现的** ⇒ 前三个来源全部放行。

**这正是本单最不能漏的那一类** —— founder 的 ship 指令。

### ⚠️ R3 BLOCKER-3：用「本机安装时刻派生 snowflake」当上界 **不成立**，改用 per-thread Discord 快照

我上一版写「`founder_snowflake_floor` = 由 `installed_at` 派生的 snowflake 上界」，并引 `db.ts:4381-4383` 作先例。**三处都错**：

| 错处 | 事实 |
|---|---|
| 引错先例 | `db.ts:4381-4383` 只校验十进制文本，且明说是 **lower bound**；仓内唯一转换 helper `msToSnowflakeLowerBound()` 还**减 1 ms**、返回给 `after=` 用的 exclusive **下界**（`founder-notify-utils.ts:55-64`）—— 不是「包含安装毫秒全部 snowflake 的上界」 |
| 比较类型未定义 | snowflake **超过 JS safe integer**，转 `Number` 丢位；TEXT 词典序在**位数不同**时错（`'999' <= '1000'` 为 false） |
| 时钟 authority 错 | **本机时钟不是 Discord 的 authority**。本机若落后，安装前就已存在的 message 仍可能算出 `id > floor` 而**逃逸**；同一毫秒内本机 commit 与 Discord sequence **没有全序关系** |

**定稿：authority 取 Discord 自己，不取本机时钟。**

安装 freezing epoch **之前**，对每个受影响的 founder thread 读 Discord **当前最新 message ID**，持久化为 **per-thread inclusive watermark**（新表 `founder_thread_watermark(epoch_id, thread_id, watermark_msg_id)`）。**任一 thread 读取失败 ⇒ 不激活**（fail-closed）。

ingress 在**同一个 CommDB enqueue 事务**内判定：严格十进制校验后 **`BigInt(msg.id) <= BigInt(watermark)`** ⇒ 登记 `enrolled_via='founder_ingress'`。

> **per-thread 比全局水位线更准**：一个全局 watermark 会把**别的 thread 的真正新增**误冻。
>
> **为什么不用「已观察过的 cursor」**：cursor 之前的消息**已经**被处理过（不在积压里）；危险的恰恰是 **cursor 之后、但 Discord 上早已存在**的那些 —— per-thread newest-ID 快照正好圈住这一段。

**必须补的 fixture**：本机时钟快 / 慢、同毫秒的首尾 snowflake、不同位数的字符串比较、超过 `Number.MAX_SAFE_INTEGER` 的值。

⇒ 因此 `lead_inbox_freeze_epoch.founder_snowflake_floor` 这一列**作废**，改由 `founder_thread_watermark` 表承担。
>
> **诚实边界**：这条线切的是 **Discord 上的消息时间**，不是「这条指令是否已被执行」。它**保守地**把 epoch 前的全部 founder 消息都冻住 —— 与红线 #3「宁可漏投一条陈旧通知，也不能重播一条 founder 的 ship」方向一致。已执行 / 未执行的逐条判定仍然**一条都不做**，全部归承接单 B。

### ⚠️ R2 MEDIUM-8：`probe.status='delivered'` 分支有第三种跨库半状态

普通分支（enqueue + identity 同一个 CommDB 事务）的两个半成品都会整体回滚，这一点成立。但 **delivered-probe 分支不同**：它**先** `StateStore.markLeadEventDelivered(row.seq)`，**再**做 terminal CommDB insert（`legacy-lead-event-reconciler.ts:153-158`）。

若 terminal 那个 CommDB 事务失败：下一次 `listUndeliveredLeadEvents()` **不再返回该 event**（StateStore 已标 delivered）⇒ CommDB 里**既无 terminal row、也无冻结身份**。

**这不会造成重播**（legacy receipt 已证明它投递过），但它**打破 §1b.4 的一个声明** —— 「身份表本身就是完整的人工清单 / 审计 authority」。那一行会**永久缺席**。

**定稿（⚠️ R3 MEDIUM-8：这是 crash authority 设计，不留给实现者现场二选一）：选 durable repair journal。**

1. 在 **StateStore 里、与 `markLeadEventDelivered()` 同一事务**写一条 deterministic 的 `terminal_mirror_pending` 记录
2. CommDB terminal mirror 成功后，再把它标 complete
3. 重启时**独立扫描** pending 并**幂等重驱**

**三个 crash fixture 分别对应三个提交点**：① StateStore commit **前**崩溃；② StateStore commit **后 / CommDB 前**崩溃；③ CommDB 成功**后 / repair complete 前**崩溃。

**F6c 必须补三个 crash fixture**：① identity insert 失败；② enqueue comparator 失败；③ **delivered-probe 之后 CommDB 失败**。

### 来源 ③：安装时的 pending question —— **按身份预登记，即使 inbox 行还不存在**

事故中仍 open、但**从未生成过 inbox 行**的 question，会在 cutover 后由 `materializePending()` **首次** enqueue（`lead-inbox-runtime.ts:109-113`）。原稿的旁路 B 只证明了「**已有**冻结行的 question 重扫仍命中同一行」，**没覆盖这一类**。

**定稿**：安装事务内调用**真实的** `getPendingQuestions()`（**不得自己重写谓词** —— 与 §6 同一条纪律），把每条的稳定身份 `question:<leadId>:<questionId>` 预登记为 `enrolled_via='pending_question'`（`inbox_seq` 留 NULL，物化时回填）。

> ⚠️ `getPendingQuestions` 读的是 CommDB（`db.ts:2457-2472`），与 epoch 安装**同库**，可在同一事务内完成 —— 这一条是原子的。

**汇总不变量**（写进实现注释与 PR）：

> 一条 `carrier='inbox'` 的行可投 **当且仅当** 它的稳定身份**不在**冻结身份集里，**且**它的 `resend_of` 也不在。
> 冻结身份集 = ①(a)+①(b) ∪ ② ∪ ③ ∪ ④，全部以 **epoch 之前的源事实**为界。
> **仅在 `activation='freezing'` 时登记**；`inert` epoch 的身份集恒为空（§1b.7）。

⚠️ **这条不变量的边界必须诚实收窄（R2 HIGH-4 / HIGH-5）**：它保证的是「**epoch 前的源事实不会作为消息投给 Lead**」，**不保证**「epoch 后一条 model 行都不会由 epoch 前的事实派生出来」。
已知且**有意允许**的一个派生：旧 protocol 行终态失败产生的 `protocol_alert:*` 运营告警（§1b.11 旁路 F）。它不是 founder 指令、不携带业务指令，**允许投**。

---

## 1b.9 ⚠️ R1 HIGH-4：`delivery-eligible` 语义必须**统一**，否则 F 会打瞎 D 依赖的观测

冻结行会**长期**保持 `consumed_at IS NULL`。而下面这些地方**把「未消费」直接当成「还欠着没投」**：

| 位置 | 现状 | 被 F 打瞎的后果 |
|---|---|---|
| `recordTickSuccess()` `lead-inbox-queue.ts:1934-1947` | 只有**不存在** overdue 未消费行时才清 `stall_episode_at` | 一条带 `deadline_at` 的冻结行 ⇒ 旧 episode **永远清不掉** ⇒ checker **永久静默** |
| `claimHealthEpisode()` `:1957-1980` | 同样统计所有 overdue 未消费行 | 同上 |
| `countPending()` `:1007-1021` | 纯 `consumed_at IS NULL` 计数 | 所有 Lead **永远用 active cadence 空转** |

⇒ **F 不能先把 D 赖以工作的观测语义弄坏**（哪怕 D 本身移出了本单）。

**定稿**：抽出**一个共享的 `deliveryEligible` 语义**，同时应用到：8 个 claim seam（§1b.6）+ `countPending` + `recordTickSuccess` 的 overdue `EXISTS` + `claimHealthEpisode` 的统计。

冻结积压**另立显式指标**（`frozenCount` / `frozenOverdueCount`），**绝不冒充 live pending**。

**部署验收必须证明**（并入 §8 #6b）：
① heartbeat 重新推进；② 修复前留下的旧 stall episode 能按约定关闭；③ 冻结计数**仍然可见**（不是被抹掉）；④ 真正的**新** overdue 仍能开启新 episode（阴性对照）。

---

## 1b.10 清单导出：只出清单，绝不投递（红线 #5 / #7）

`lead_inbox_frozen_identity` 本身就是清单。仓内可审查脚本（**非临时命令**）只做**读**：

- 按 `biz_class` + `enrolled_via` 过滤（红线 #8），默认输出**全部并分组计数**
- 每条标注「**是否可能已生效**」的证据形状 —— `founder_msg` 一律标 `⚠️ 可能已生效`，并贴可核对锚点（`ref_message_id` / `created_at` / 对应 issue）
- ⚠️ **必须能展开 `resend_of` 派生子行** —— 身份表里只有 root 的身份，子行是**靠继承**被挡住的，**清单不能假装身份表天然含子行**（R1 BLOCKER-2 的附带要求）
- **默认且唯一模式 = dry-run**。本单**不提供** `--apply` / `--deliver`（红线 #5 说「真投递要显式 flag」，那个 flag 属于**承接单 B**）
- **检查器是尺子不是执行器**（红线 #7）：脚本与任何不变量检查器**不得**写 `lead_inbox`、不得清 `unfrozen_at`、不得调 enqueue

**`founder_msg` 的额外硬护栏**（红线 #6）：解冻 API（本单只留桩供承接单 B 用）对 `source='founder_reply'` **无条件拒绝**，必须走带 founder 证据的独立路径。配负向测试。

---

## 1b.11 旁路盘点：**七条**（R3 后修订）

> R1 从三条补到四条；R2 又找出**第五条（founder ingress）与第六条（protocol quarantine 派生）**；R3 找出**第七条（切换期 in-flight handoff 派生的 `model_alert`）**。
> 每一轮都在找「epoch 前的事实如何在 epoch 后拿到新身份」，这就是本设计的**唯一**攻击面。
>
> **producer 侧的枚举现在是完整的**（R3 独立核过）：生产代码里能新建 `lead_inbox` 行的底层 INSERT **只有四处** —— 通用 `enqueue()`（`lead-inbox-queue.ts:557`）、model quarantine advisory（`:1518`）、terminal legacy mirror（`:1599`）、resend child（`db.ts:4783`）。
> 通用入口的生产调用方 = founder root / question / lead event / protocol / `protocol_alert`，外加两条明确 `carrier='external'` 的 chat 与跨部门回执。
> ⇒ **A–G 覆盖了全部已知 producer。** 补上 quiescence 之后，R3 未再找到第八条。

### 旁路 A —— `advanceDueUnprocessedReceipts` 给旧 root 生出**新 seq 子行**

`db.ts:4745-4801`（⚠️ 实际方法名是 `advanceDueUnprocessedReceipts`，不是原稿写的 `advanceUnprocessedReceipts`）：选出 `resend_of IS NULL AND delivered_at IS NOT NULL AND processed_at IS NULL AND next_unprocessed_at <= now` 的 root，`INSERT OR IGNORE` 一条 id 为 `${root.id}#r${round}@${episode}` 的**新 pending 行**。

**一层继承够不够**：够。候选**硬性限定** `resend_of IS NULL`（`:4748`），子行 `resend_of` 直接写 `root.id`（`:4763-4801`），且这是仓内**唯一**的生产 resend INSERT ⇒ **不存在 resend-of-resend**。
**但前提是 root 真的被冻住** —— 这正是 R1 BLOCKER-2，已由 §1b.8 来源 ①(b) 修复。

### 旁路 B —— `QuestionAdmission.materializePending()` 重新物化

`question-admission.ts:47-57` 每跳重扫 `getPendingQuestions()`（无时间下界）。**两种情形，原稿只覆盖了第一种**：

| 情形 | 处置 |
|---|---|
| 存量 question **已有** inbox 行 | 稳定 id 幂等命中现有行 ⇒ 仍是冻结的 ⇒ 投不出去 ✅ |
| 存量 question **还没有** inbox 行 | ⚠️ **R1 BLOCKER-1**：首次物化拿新 seq ⇒ 原设计放行。由 §1b.8 来源 ③ **预登记身份**修复 |

**本单有意接受的代价（诚实写明）**：本单只保证「**新增**流动」。FLY-1579 §6 点名的「可救 4 条 + tidal-echo 3 条」**属于存量，归承接单 B**。
⇒ **不在本单实现 unfreeze-on-reaffirm** —— 那会把「按证据解冻」偷偷塞进 P0 单，正是 §1b 要避免的赶工分流。

### 旁路 C —— `protocol` 车道

⚠️ **R1 MEDIUM-6 把原稿的假设证伪了**：原稿说「陈旧 ack 是 inert 的，实施期验证」。实际 `ProtocolIngress.handle()` 只在 event **已 retired/acked** 时才 no-op；否则校验 token 后会调 `markLeadEventAcked()` 并 `consumeReceipt()`（`protocol-ingress.ts:85-147`）⇒ **会改变 ACK/escalation 状态**，「不改变任何 founder-facing 状态」是错的。

**定稿（现在拍，不留给实现者现场选）：`protocol` 行不进冻结集**，但理由改写为可验证的那一条：

> ACK 是**精确 owner/token-fenced 且幂等**的**接收证据**。它记录的是「某条 event 已被 ack」这个**已经发生过的事实**，不是一条待执行的指令。**延迟结算一条真实发生过的 ack 是安全的**；而**丢弃**它反而会让 escalation 状态永久失真。

**必须配的测试**（不是「验证它 inert」，而是验证上面这条理由成立）：
① 只作用于**绑定的那条 event**（token/owner fence 生效，错 token 拒绝）；
② **重复处理无额外效果**（幂等）；
③ **不进 model adapter**、不作为消息呈现给 Lead。

⚠️ **翻转条件写明**：若 Lead 认定「只投新增」也禁止**任何**旧的内部副作用，则 protocol 必须并入冻结集 —— 那是一个**明确的口径决定**，不是实现细节。

### 旁路 D —— `carrier='external'` 车道

`ExternalReceiptSaga` → `listExternalPendingForLane`（`lead-inbox-queue.ts:775-828`），**已有** `seq > cursor` 游标 + 可选 `created_at <=`，**不经过** `LeadInboxLoop`。
**处置：不动。** 本次 wedge 在 `carrier='inbox'`，§0.2 已确证 external 完好。动它 = 扩大 blast radius。

> ⚠️ **实施第一步必须先核的口径不一致**：Lead 的积压盘点里 `chat` 有 28 条，但按代码 `chat` 走 `carrier='external'`（`chat-receipt.ts:184-195`，id 形如 `chat:<lead>:<message>`），而 external 车道被认定完好。
> **先核这 28 条到底在哪条 carrier 上**，再写过滤器。**不要照抄那张表。** 这正是 §11b 总结的模式 —— 拿一张不是为这个问题设计的表去回答这个问题。

### 旁路 E —— founder ingress 从 Discord 首次拉进 epoch 前的消息（⚠️ R2 HIGH-4）

**这是本单最危险的一条旁路** —— 走的正是 founder 指令。

`founder-reply-deliverer` 用 `after=<cursor>` 拉 Discord（`:264-309`），对 cursor 之后的每条消息铸 `founderMessageRootId(leadId, msg.id)` 并 enqueue root（`:393,556`）。**cursor 之后、但 Discord 上早已存在**的 founder 消息，会在 epoch 之后拿到**全新的稳定身份** ⇒ 前三个来源全部放行。

**堵法**：§1b.8 来源 ④ 的 `founder_snowflake_floor`。

**一个有价值的安全事实（但不足以单独依赖）**：代码是**先 enqueue root、再进 auto ship/route**（`:574-590` 在 `:617` 之前）⇒ 凡是**被这条自动路径执行过**的 founder 消息，**必然已经有 row** ⇒ 它就在存量里、会被来源 ①(a) 冻住。
⚠️ **但这不能证明**一条 epoch 前、尚未被 poller 观察到的 founder 指令**没有被人手工执行过**。所以仍然需要来源 ④ 的水位线兜底。

### 旁路 F —— 旧 protocol 行终态失败派生出**新的 model 行**（⚠️ R2 HIGH-5）

旧 protocol 行连续失败到 dead-letter 后，`LeadInboxLoop` 调 `onProtocolQuarantine`（`lead-inbox-loop.ts:200-216`），runtime 随即 enqueue：

```ts
// lead-inbox-runtime.ts:115-126
id: `protocol_alert:${lead.agentId}:${row.id}`,
type: "protocol_quarantined",
msgClass: "model",              // ← 是 model 行,会被 claimModelBatch 投出去
```

⇒ **epoch 前的 source fact（旧 ACK 行）在 epoch 后得到新 model 身份并被投递。**

⚠️ 同时它**证伪了旁路 C 的第三条测试**：「protocol 不进 model adapter」只对**成功的 ACK 行自身**成立，**不能**当作整条 protocol lane 的性质。

**定稿口径决定（现在拍）：允许它投。**

理由：`protocol_alert` 是**运营告警**，不是 founder 指令、**不携带任何业务指令**（内容是 `[protocol_quarantined] <type> (<id>) was rejected after repeated failures: <error>`）。风险形状与 founder replay 差着量级；而**压掉它**会让「protocol 行被隔离了」这件事**无人知晓** —— 正是本次事故（守卫开火 16 次没人看见）的同一个病。

⇒ **代价**：§1b.8 的总不变量必须**收窄**（已改），不能再说「所有 stock 零投递」。
### ⚠️ R3 HIGH-5：当前实现的 alert **确实会携带业务指令** —— 我上一版的安全断言被源码直接证伪

runtime 把**任意 `error.message` 原样拼进 model 内容**（`lead-inbox-runtime.ts:115-126`），而 `ProtocolIngress.handle()` 对 malformed row 直接 `JSON.parse(row.content)`（`protocol-ingress.ts:85-97`）。Node 的 JSON 错误**会回显输入片段**：

```
JSON.parse('ship FLY-1569')
  → SyntaxError: Unexpected token 's', "ship FLY-1569" is not valid JSON
```

⇒ **一条旧的 malformed protocol 行，会把 `ship FLY-1569` 这样的字面指令（或 prompt-injection 片段）当作 `protocol_alert` 投给 model。** unsupported-type 分支还会回显 `row.type`（`:85-88`）。

**这直接打穿本单的核心目的** —— 我们正是在防「founder 的 ship 被重播」。

**定稿：口径保留（允许运营告警），但内容必须净化。**

- protocol handler 与 alert renderer 之间只传 **typed、allowlisted 的 reason code**（枚举）
- alert 内容**只含**：固定模板 + 安全枚举 + **受约束的 row locator / hash**
- **绝不含** raw `error.message`、raw payload、任意 `type` / `id`

⇒ **F15 必须加一条 exact negative assertion**：喂一个含 `ship` 与 prompt-injection 的恶意 malformed payload，断言产出的 alert **逐字不含**这些片段。
且覆盖旧 ACK 的 **malformed payload / 错 token / 过期 token / missing event / 达到 max attempts 终态**五条路径。

**净化完成之后**，「允许这条运营告警、同时继续结算 ACK」这个口径才成立。

### 旁路 G —— 切换期 **in-flight handoff** 派生的 `model_alert:*`（⚠️ R3 BLOCKER-1）

**这条与前六条不同：它暴露的不是「少登记了一类身份」，而是「切换本身缺一道 barrier」。**

`LeadInboxLoop` 在把批次交给 transport 之前**只做一次 owner 检查**，随后 `await adapter.deliverBatch()`（`lead-inbox-loop.ts:283-304`）。owner lease 默认**只有 10 秒**（`:99`），而 Claude adapter 的 `writeMailboxBatch()` **没有可见的 timeout / cancellation**（`lead-delivery-adapter.ts:50-65`）。

⇒ 新进程等旧 lease 过期后就能拿到 owner 并安装 epoch（`lead-inbox-runtime.ts:213-224`）—— **但旧进程可能已经把 stock batch 交给外部 adapter 了**。

**冻结谓词和 DB trigger 都只能阻止「未来的 claim」，撤不回「已经发生的 handoff」。**

而且旧调用若随后撞上 membership conflict，还会拿 **pre-epoch batch** 去铸 `model_alert:<lead>:<batch>`（`lead-inbox-queue.ts:1481-1522`）—— 这就是第七条派生身份。

⚠️ **不能用「本次事故里 admit 每跳都先失败、所以走不到那里」来免责**：激活谓词只判 heartbeat stall，**并不证明 stall 的原因就是 admit 撞毒行**；一次长时间的 adapter 调用**同样满足**那个谓词。**「结构性零重播」不能依赖本次事故的偶然执行位置。**

**定稿：把 rollout quiescence 写成 F 安装前的硬门，而不只是「禁止旧 binary 回滚」。**

1. **停掉所有可能访问受影响 CommDB 的旧 Bridge 进程**
2. **证明进程已退出**、且**不存在运行中的 adapter handoff**
3. 之后才允许新 binary 取得 owner / 安装 freezing epoch

> 若将来要求支持进程重叠，则需要一个 **receiver 也能识别的 durable delivery generation / barrier** —— **只靠 SQLite lease 做不到撤销外部副作用**。这一点必须写进 §12 遗留，不要假装本单解决了它。

**新增 fixture**：旧 owner 已 claim、adapter promise 挂起、lease 过期、新进程尝试安装 ⇒ **在旧 handoff 被确定终止之前，安装与恢复投递都必须失败**。
并断言：**在 quiescence 保证下，stock 不可能触发 `model_alert`**。

---

---

## 1b.12 F 的测试矩阵（R3 后修订）

| # | 用例 | 断言 |
|---|---|---|
| F1 | **零重播（红线核心）** | epoch 装好后跑满一轮 tick：冻结身份**零投递**；`source='founder_reply'` 的 40 条**一条都没进任何 claim 结果集** |
| F2 | **新增照常流动** | epoch **之后**新 enqueue 的行 → 被 `claimModelBatch` 选中 → 接收端 `consumed_at` 非空 + `disposition='delivered'` |
| F3 | **fail-closed** | 删掉 / 不安装 epoch → **8 个 seam 每一个都抛**（不是返回空）；tick `ok:false`；零投递 |
| F4 | **字节兼容哨兵** | `activation='inert'` / 身份集为空时，改动前后 claim 结果**逐字段、逐顺序相同** |
| **F5** | **旁路 A（重写）** | 冻结一条 **`delivered_at IS NOT NULL AND processed_at IS NULL`** 的 root（来源 ①(b)）→ 触发 resend → 子行生成但**选不中**；**root 与全部 `resend_of` 后代**的 `consumed_at`/`delivered_at` 均无推进；清单能展开子行 |
| **F6** | **旁路 B（重写）** | ⚠️ 原稿写「返回值不算 admitted」**事实错误** —— 现有回归逐字断言重复扫描**两次都返回 1**（`question-admission.test.ts:103-111`）。<br>改为断言：**稳定 id、只有一行、无 unfreeze、零 claim、不抛** |
| **F6b** | **旁路 B 的未物化分支（新增，闭 BLOCKER-1）** | 源 question 存在但**无 inbox 行** → 安装 epoch（预登记身份）→ cutover + `materializePending()` → 行被创建但**零 claim** |
| **F6c** | **legacy late materialization（新增，闭 BLOCKER-1）** | `lead_events.seq <= floor` 的行在 cutover 时物化 → 身份在**同一 CommDB 事务**内登记 → **零 claim**；对照：`seq > floor` 的行 → 接收端 delivered |
| F7 | **解冻护栏** | 解冻 API 对 `source='founder_reply'` **抛**（负向） |
| F8 | **清单只读** | 导出脚本跑完：`lead_inbox` **零写入**（前后整表 digest 相同） |
| **F9** | **existing-first 安装 + 并发（R2 重写）** | ⚠️ **必须证明「正常重启不自撞」**：装完 → tick 成功 → 重启 → **不重算、不抛**，沿用已存 epoch。<br>⚠️ R3 HIGH-6 文案修正：不能写「activation 会翻成 inert」（那与 immutable 矛盾）。**准确说法**：此时**若重算**会得到 `inert`，但 **persisted `activation` 仍是 `freezing`，且不被重算触碰**。并发 INSERT 输家撞 unique 后**重读赢家并接受**。fixture：commit 前崩溃 / 跨 project DB 中途崩溃 / 同 project 双进程 / 同库多 Lead |
| **F10** | **激活判据（R2 重写，闭 BLOCKER-1）** | 四条都要验 identity 数 + claim 结果 + 接收端 receipt：<br>① **真·全新库首个 tick** → `inert`（这是原谓词踩雷的那条）<br>② 全新库**已有合法 pending** → `inert`，那些 pending **照常投出去**<br>③ 健康库**含 pre-floor 未投 legacy** → `inert`，legacy 照常投<br>④ **安装时健康、之后才 wedge** → epoch 仍是 `inert`、身份集仍为空（证明 `inert` 不会偷偷长出身份，也不冒充 replay fence） |
| **F11** | **观测语义（闭 HIGH-4）** | 带 `deadline_at` 的冻结行**不**让 `stall_episode_at` 永久 latch；`countPending` 不把冻结行算进 live pending；`frozenCount` 可见 |
| **F11b** | **真 stall 没被一起消音（R2 新增，闭 MEDIUM-9）** | 只放冻结积压 → 先让 loop 成功一次清掉旧 episode → **停止 heartbeat 推进** → 超过阈值后必须得到 **`stalled=true, overdue=0`** 的新 episode。<br>⚠️ 这条专防一种实现失手：把 `claimHealthEpisode` 整个绑到「存在 eligible 行」上 —— 那会让**没有任何 overdue 行的真实 loop stall** 报不出来。现有 checker 的 `stalled` 是独立读 `last_success_at` 的（`lead-inbox-queue.ts:1976-1980`），**这个独立性必须保住** |
| **F12** | **降级 fence（R2 重写，闭 HIGH-3）** | 四条都要：① NULL→非NULL claim 被 ABORT；② **过期非 NULL claim 重占被 ABORT**；③ 同 owner 续占被 ABORT；④ **旧 binary 对 legacy 行的后物化** —— 因为身份已在安装时急切预登记，trigger 拦得住 |
| **F14** | **旁路 E:founder ingress（R2 新增，闭 HIGH-4）** | Discord 上 epoch **之前**就存在、但在 cursor 之后的 founder message → epoch 后被 poll 到 → enqueue 与身份登记在**同一 CommDB 事务** → **零 claim**。对照：epoch **之后**发的 founder message → 接收端 delivered |
| **F15** | **旁路 F:protocol_alert 净化（R3 重写，闭 HIGH-5）** | 旧 ACK 行终态失败 → `protocol_alert:*` 被投出（**允许**）→ ⚠️ **exact negative assertion**：喂含 `ship FLY-1569` 与 prompt-injection 的恶意 malformed payload，断言 alert **逐字不含**这些片段（当前实现会含，因为 `error.message` 回显输入）。覆盖五条失败路径：malformed payload / 错 token / 过期 token / missing event / 达到 max attempts |
| **F16** | **旁路 G:切换 quiescence（R3 新增，闭 BLOCKER-1）** | 旧 owner 已 claim、adapter promise **挂起**、lease 过期、新进程尝试安装 → **在旧 handoff 被确定终止前，安装与恢复投递都必须失败**；并断言 quiescence 下 stock 不可能触发 `model_alert` |
| **F17** | **急切登记不碰 payload（R3 新增，闭 HIGH-4）** | invalid JSON / lone-surrogate 的 `lead_events` 行**也能被急切登记身份** → **安装成功**（证明 installer 没有解析 payload）→ 随后才由 B 分类隔离。<br>⚠️ 这条防的是本设计最讽刺的自毁开关：为保护存量而加的登记，被存量里的毒行先干掉 |
| **F18** | **StateStore 快照完整性（R3 新增，闭 BLOCKER-2）** | ① **>10,000 行**时后半存量仍有急切身份（证明分页取尽）；② 快照后并发 append 的 `seq > floor` **不被误冻**；③ 两个 project 的 lead 身份**互相隔离**（不越权枚举全 fleet） |
| **F19** | **snowflake 边界（R3 新增，闭 BLOCKER-3）** | 本机时钟快 / 慢；同毫秒的首尾 snowflake；不同位数的字符串比较（`'999'` vs `'1000'`）；超过 `Number.MAX_SAFE_INTEGER` 的值 —— 全部走 `BigInt` 比较且对 **per-thread** watermark |
| F13 | **与 B 的联合** | 毒行 fixture 在场 + epoch 已装：cutover 隔离毒行并继续 → **新增行 delivered**、**存量零投递**（同时覆盖 issue 验收 #2 与 #4） |

---

## 1b.13 R1 复核记录（未照单全收）

Codex R1 的每一条都由本 runner 独立查证后才写进本版：

| R1 条目 | 复核结论 | 我的证据 |
|---|---|---|
| **B-1** epoch 后物化的旧源数据绕过冻结 | ✅ **成立，是我的设计洞** | 我在 §1b.4 定义了 `legacy_event_seq_floor` 却**从没写消费规则**；`legacy-lead-event-reconciler.ts:106-164` 确实在 epoch 之后才 enqueue |
| **B-2** resend root 不在「未消费」集合里 | ✅ **成立，我自相矛盾** | `db.ts:4748` 候选谓词是 `delivered_at IS NOT NULL`；而我的安装定义只收「未消费行」。F5 用例与安装定义打架 |
| H-3 `claimPending` + 降级 | ✅ 成立 | `lead-inbox-queue.ts:1086` 确为公开方法；`grep` 确认无生产 caller（另一处同名是 `account-heal/pending-store.ts:116` 的**无关函数**）。降级路径确实无 fence |
| H-4 frozen 行污染 health 语义 | ✅ **成立，且比 R1 说的更要紧** | 亲眼核了 `recordTickSuccess`（`:1934-1947`）的 `stall_episode_at` 清除条件 与 `countPending`（`:1007-1021`）—— 两处都是裸 `consumed_at IS NULL` |
| H-5 验收假绿 + 目标数写错 | ✅ 成立 | issue 正文写「14 个 Lead / 7 个项目」，本计划 §11 复核后写「16 个 Lead / 6 个项目」—— **两者矛盾**。⇒ 一律**动态导出**，禁止写死 |
| M-6 protocol 不是 inert | ✅ **成立，原稿假设被证伪** | `protocol-ingress.ts` 确实调 `markLeadEventAcked()` + `consumeReceipt()`。已改为可验证的新理由 + 三条测试 + 翻转条件 |
| M-7 无条件首装冻健康库 | ✅ 成立 | 原稿把它写成「接受的代价」，但本单**没有解冻能力** ⇒ 不是短暂 backpressure。已改为 data-driven 激活判据 |
| M-8 epoch schema 没兑现声明 | ✅ 成立 | 原 DDL 只有 `epoch_id PRIMARY KEY`，无 status CHECK、无 active partial-unique、ID 未定确定性 |
| L-9 F6 与 §13 文案错误 | ✅ **成立，§13 那条是我最该自省的** | `question-admission.test.ts:103-111` 逐字断言两次都返回 1。§13 我**在 review 跑之前**就预写了「已执行 / APPROVED」—— 拿流程标签冒充事实 |

**这一轮我自己写错的地方**：冻结对象搞成「行」而不是「身份」（B-1/B-2 同源）、把 protocol 的 inert 当成待验证而非已可证伪、以及**在 review 之前预写 APPROVED**。
前两个是**同一个模式**：**拿「安装那一刻能看见的东西」当成「全部存量」** —— 与 §11b 记的那个模式同类。

## 1b.14 R2 复核记录（未照单全收）

Codex R2 的每一条同样经本 runner 独立查证。**R2 有三条是用真实 SQLite 最小复现跑出来的，不是推测。**

| R2 条目 | 复核结论 | 我的证据 |
|---|---|---|
| **B-1** 激活谓词把全新库判成 wedged；`inert` 不封闭 | ✅ **成立，两半都成立** | 亲眼核 `recordTickStarted`（`lead-inbox-queue.ts:1923-1931`）—— 它 `INSERT ... (lead_id, last_started_at)` **只写 started**，且在 `try` 与 `ensureCutover` **之前**（`lead-inbox-loop.ts:156-173`）⇒ 全新库首 tick 必然 `last_success_at IS NULL` ⇒ 原谓词命中。且我的延迟登记**确实没判 activation** ⇒ inert 库会长出身份 |
| **B-2** insert-or-verify 比较 mutable 值 → 正常重启自撞 | ✅ **成立，这是个会自伤的设计** | floors 会被新 enqueue / 新 event 推进；`recordTickSuccess`（`:1934-1947`）在修复后会让 activation 的自然算法翻成 `inert` ⇒ 重启必抛。已改为 existing-first |
| H-3 trigger 漏 expired non-NULL；降级仍可 replay | ✅ **成立，我的「只会 wedge」是错的** | 三条 claim SQL 都允许 `claim_expires_at < ?` 重占（`:1108-1128,1236-1274,2028-2057`）⇒ 非NULL→非NULL 绕过 trigger。且延迟登记留下的窗口确实让旧 binary 能物化 legacy 行而无身份。已改为**急切预登记 + 去掉 `OLD.claimed_by IS NULL`**，并把回滚矩阵改写成「会 wedge，边角仍可能 replay」 |
| H-4 founder ingress 是第五条旁路 | ✅ **成立，且这是最危险的一条** | 亲核 `founder-reply-deliverer.ts`：`after=<cursor>` 拉 Discord（`:264-309`），对 cursor 之后的消息铸 `founderMessageRootId`（`:393,556`）⇒ epoch 前就存在于 Discord 的 founder 消息会在 epoch 后拿新身份。已加来源 ④ snowflake 水位线 |
| H-5 protocol quarantine 派生 model 行 | ✅ **成立，证伪了我旁路 C 的第三条测试** | 亲核 `lead-inbox-runtime.ts:115-126`：`protocol_alert:*` 的 `msgClass` 就是 `"model"`。已作显式口径决定（允许投）并收窄总不变量 |
| H-6 #10c 不可执行且自相矛盾 | ✅ **成立，是我改表名时漏改** | 表已改名 `_identity`，#10c 还写着 `_row`；且「冻结集零 consumed」与来源 ①(b)「root 常已 consumed」直接打架 |
| M-7 ①(b) 不是「逐字对齐」 | ✅ **成立，我用词不准** | 真实候选还含 `processed_evidence IS NULL` / `escalated_at IS NULL` / `next_unprocessed_at` / active episode（`db.ts:4745-4761`）。已改为共享 `resendCapableRoot` 子谓词 + 明说是保守 superset |
| M-8 delivered-probe 跨库半状态 | ✅ 成立 | `legacy-lead-event-reconciler.ts:153-158` 确实先 StateStore 后 CommDB |
| M-9 F11 缺 `stalled=true, overdue=0` 对照 | ✅ 成立 | checker 的 `stalled` 独立读 `last_success_at`（`:1976-1980`），这个独立性必须被测试钉住 |
| L-10 §13 状态文案 | ⚠️ **部分成立 —— 我不照单全收** | 尾部裸 `APPROVED`（确实矛盾，**已收窄**）与交叉引用错指 §1b.12（**已改**）成立。<br>但「页首把 R1 写成 5 BLOCKER + 4 HIGH 是错的」这条**我不接受**：那一行说的是 **FLY-1579 的 R1**，在原文语境里数字正确。真正的问题是**两套编号混在一篇文档里会误读** ⇒ 我的处理是**消歧**（显式标注哪套是 FLY-1579、哪套是 FLY-1586），不是「改正数字」 |
| L-11 D 的 follow-up 需要真 owner | ✅ 成立 | 已写进 §9 部署纪律作为**发布前硬门**：必须有真实 Linear issue + owner + priority + 验收，不能只留文档 |

**这一轮我自己写错的地方**：激活谓词踩到 `recordTickStarted` 的写入顺序（**又一次没验到终点**）、comparator 拿会变的值做恒等断言、把「降级只会 wedge」说得太满、以及改表名时漏改验收 SQL。
**共同模式**：**在「我以为的顺序 / 我以为的不变量」上下结论，而没有回去核实际执行顺序与实际可变性。** 与 §11b 记的那个模式同源。

## 1b.15 R3 复核记录（未照单全收）

| R3 条目 | 复核结论 | 我的证据 / 处置 |
|---|---|---|
| **B-1** 切换期 in-flight handoff（旁路 G） | ✅ **成立，而且这条最不一样** | 前六条都是「少登记了一类身份」，这条是「**切换本身缺一道 barrier**」。`lead-inbox-loop.ts:283-304` 确实是 owner 检查后就 `await adapter.deliverBatch()`，lease 默认 10s（`:99`），adapter 无可见 timeout（`lead-delivery-adapter.ts:50-65`）。**冻结谓词与 trigger 只能挡未来的 claim，撤不回已发生的 handoff。**<br>⚠️ 我特别接受 R3 的这句反驳：**不能用「本次事故 admit 每跳都先失败所以走不到」来免责** —— 激活谓词只判 heartbeat stall，**不证明 stall 的原因**。已改为 quiescence 硬门。 |
| **B-2** StateStore 枚举不是完整快照 | ✅ **成立** | `StateStore.ts:9984-9992` 确为全局 `delivered_at IS NULL ORDER BY seq LIMIT ?`、默认 10,000、无 seq 下界、无分页、无 project 过滤。已改为 transaction-owning snapshot API + 分页 + project 分区。 |
| **B-3** snowflake 上界算法与时钟 authority | ✅ **成立，我三处都错** | 引的 `db.ts:4381-4383` 明说 **lower bound**；`msToSnowflakeLowerBound()` 还减 1ms（`founder-notify-utils.ts:55-64`）。比较类型未定义（超 safe integer / 词典序）。本机时钟不是 Discord authority。已改为 **per-thread Discord inclusive watermark + BigInt**。 |
| **H-4** 急切登记会先解析毒行 | ✅ **成立，这是最讽刺的一条** | 唯一的 row→envelope helper 在 `JSON.parse(row.payload)`（`legacy-lead-event-reconciler.ts:82-94`）。⇒ **为保护存量而加的登记，会被存量里的毒行先干掉**，A/B 根本没机会跑。已改为 identity-only helper + installer 严禁碰 payload + F17。 |
| **H-5** `protocol_alert` 会携带业务指令 | ✅ **成立，我上一版的安全断言被源码证伪** | `lead-inbox-runtime.ts:115-126` 把 `error.message` 原样拼进 model 内容；`JSON.parse('ship FLY-1569')` 的错误消息**逐字包含 `"ship FLY-1569"`**。⇒ 一条旧 malformed protocol 行能把 ship 指令投给 model —— **直接打穿本单的核心目的**。已改为 typed reason code + 固定模板 + F15 的 exact negative assertion。 |
| **H-6** existing-first 的一致性校验不可实现 | ✅ 成立 | identity 表当时没有 `enrollment_phase`，也没有 `schema_version` ⇒ 校验写不出来。已补两列并把 comparator 写成 7 条封闭集合；F9 的「activation 会翻成 inert」文案与 immutable 矛盾，已改为「若重算会得到 inert，但 persisted 仍是 freezing 且不被触碰」。 |
| **H-7** #10c 仍不是可执行验收 | ✅ **部分是我没做完** | 我只写了自然语言 bullets，**一条 SQL 都没有**；且 schema 里没有 ①(b) root 的安装时 lifecycle baseline ⇒「相对快照无推进」查不出来。<br>已锁定形状与依赖（install baseline 表 / canonical digest）并写明「最终 `claimed_by IS NULL` 不能冒充『从未 claim』」。**真 SQL 属于实施阶段交付物**，本文档只锁定它的形状 —— 这一条**我没有在本轮完全闭合**，诚实标出。 |
| **M-8** delivered-probe repair 二选一 | ✅ 成立 | 已拍板 **durable repair journal**（StateStore 同事务写 `terminal_mirror_pending` → CommDB mirror 成功后标 complete → 重启独立扫描幂等重驱）+ 三个提交点各一个 crash fixture。 |
| **L-9** 文案漂移 | ✅ 成立 | 「三个来源」→「四个」、连续分隔线、F9 文案，均已清理。 |

**R3 对 R2 的闭合评定**：4 RESOLVED（B-1 activation/inert、M-7 resend predicate、M-9 health 对照、L-10 编号消歧 —— 其中 L-10 **Codex 明确接受了我的反驳**：页首数字属于 FLY-1579、不应改数，显式消歧已足够）、5 PARTIAL、1 NOT RESOLVED（#10c）。

**这一轮我自己写错的地方**：直接引了一个 **lower bound** 的先例去当 **upper bound** 用（没读它的语义就引）、让 installer 走会解析 payload 的自然路径（**没想过安装器自己会被它要保护的毒数据干掉**）、以及断言 alert 安全却没读 alert 的内容是怎么拼的。
**共同模式**：**在「这个函数/这条先例听起来是干这个的」上下结论，而没有读它实际做了什么。** 这与前两轮的模式（不核实际执行顺序、不核实际可变性）是同一族 —— 都属于 [feedback_label_substituting_for_fact]。

---

## 1b.16 F 的定稿:**seq 水位线冻结**(Tadashi 裁定,已实现)

### 走过的三条路

实现期把 §1b.6 的「投递侧没有 active epoch 就抛」真接进 claim seams 之后,立刻暴露一个设计文档没预料到的后果:**它把每一个 `LeadInboxQueue` 消费方都耦合到 F**,仓内既有测试当场红 3 条。

| 候选 | 做法 | 为什么否 |
|---|---|---|
| A 运行时闸留在 claim | 生产侧由 `ensureCutover` 装 epoch | 耦合面 = **每一个消费方**,是**永久成本**;而存量冻结是**一次性的历史问题**。不该拿永久耦合换一次性清理 |
| B 装在取得 owner 时 | `acquireOrRenewOwner` 内幂等安装 | 耦合面小,但**激活判定被锁在拿 lease 那一瞬**,而且闸**几乎不可达** —— 代码路径本来就要求先拿 owner 才能 claim |
| **✅ C seq 水位线** | 取 `max(seq)` 作水位线,把 `seq <= 水位线` 且未投递的行**一次性标记**;投递查询天然跳过 | **零消费方耦合、零既有测试改动、不依赖时钟** |

> **B 的「几乎不可达」不是优点。** Tadashi 的原话:**一个存在但永不触发的安全机制不是防线,是比没有更坏的东西 —— 它让人以为有防线。** 同一晚 FLY-1589(stuck 检测因时间戳格式混存对 DAG session 当天全盲)与 FLY-1585(把摘要标成 Head:)已经是这一类的两个实例,不要造第三个。

### 为什么必须是 `seq` 而不是时间窗

FLY-1589 正是栽在 `last_activity_at` 同一列**混存两种时间戳格式** + 朴素字符串比较。
本仓 `created_at` 还有第二个问题:legacy reconciler 把**源事件的历史时间**写进去(`legacy-lead-event-reconciler.ts:148`),所以一行可能是刚插入的、时间戳却是几天前。
`seq` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`,严格单调、永不复用 —— **clock-free**。

### 落点:`consumed_at` + `disposition`,**不新增列、不改任何投递查询**

```sql
UPDATE lead_inbox SET consumed_at = ?, disposition = 'frozen_fly1586'
 WHERE carrier='inbox' AND msg_class='model'
   AND delivered_at IS NULL AND consumed_at IS NULL AND seq <= ?
```

每一条投递查询本来就带 `consumed_at IS NULL`,所以**一个谓词都不用改**就天然跳过。

**`delivered_at` 刻意留 NULL** —— 这行**没有**被投递,这里任何东西都不许暗示相反。「投递过没有」必须一直答得出真话;答不出正是让原事故 61 小时后无法复盘的根本。

### 白捡的一个好处(epoch 方案要专门重构才有)

`countPending()` 与 `recordTickSuccess()` 的 stall 判定**也**只看 `consumed_at IS NULL`。
⇒ 冻结行**不会**虚增 pending、**不会**把 `stall_episode_at` 永久 latch 住。
**R3 HIGH-4(冻结积压打瞎 checker 观测语义)在这个方案下自动消失**,不需要抽共享 `deliveryEligible` 语义。

### 实现前核实的两个事实前提(不是假设)

1. **`founder_msg` 不走 `lead_events`** —— 它经 `founderMessageRootId` → `enqueueHubRoot` → **直接进 `lead_inbox`**(`founder-reply-deliverer.ts:393,556`;`db.ts:2586`)。
   ⇒ 那 40 条危险行**全部在水位线以下**,一次标记全部冻住。
2. **水位线之后才物化的 legacy 行是 `lead_event` 遥测** —— `appendLeadEvent` 的调用方全是 DirectEventSink / RunnerIdleWatchdog / HeartbeatService / stuck-escalation 一类,没有 founder 路径。
   ⇒ 它们拿到更大的 seq 会流过去,但 plan 自己已论证 `lead_event` **零 gate、零 question,重放只是吵、无副作用**。

⇒ **C 盖住了真正的危险面**,漏过的只是无害遥测。

### 已知边界(诚实写明,交承接单)

- 冻结**不覆盖**「已投递但未处理」的 resend root(它们 `delivered_at IS NOT NULL`,按定义不是被扣住的存量)。这类行若开着 receipt foundation 仍可能派生提醒子行。**那是提醒,不是新指令**,风险形状远低于 founder 重播;但要写进承接单。
- 仍开着的 question 会由 `QuestionAdmission` 重新物化并拿到更大的 seq ⇒ **会被投出去**。这是**期望行为**(一条还开着的提问需要答案),与 epoch 方案「全冻」相比更贴合意图。

### ⚠️ 顺带记一个缺陷:`msg_class` 过滤是 fail-OPEN

`msg_class` 的 schema CHECK 只允许 `'protocol' | 'model'`(`lead-inbox-queue.ts:5,159`)。
所以 `WHERE msg_class = 'founder_msg'` **永远匹配零行**。
在冻结过滤器里这**不是无操作,是 fail-OPEN** —— 每条 founder 消息直接放行。
业务类必须由 `source` / `type` / `id` 前缀派生(`bizClassOf`),`source='founder_reply'` 为权威(`enqueueHubRoot` 自己写死它,比调用方铸的 id 更可信)。

**这条被用作变异体验证过**:把候选谓词改成 `msg_class = 'founder_msg'` → 5 条测试立刻红(含对照组那条)。Tadashi 在指令 `22839940` 里独立点出同一陷阱,两边结论一致。

---

## 1b.17 Codex code review R1 —— CHANGES REQUESTED(未闭合项在此,不粉饰)

报告:`/tmp/codex-fly1586-code-review-round1.md`(xhigh,针对 `origin/main...HEAD` 的 ~996 行生产代码)

**R1 推翻了我 7 条「已核实」声称中的 6 条。** 逐条记在下面 —— 这些**不是**已解决问题,是**当前状态**。

### 已修(本轮)

| # | 发现 | 处置 |
|---|---|---|
| **HIGH-3** | **我引入的生产级 bug**:`LeadInboxQueue` 的 existing-connection 构造分支**直接 return**,从不装审计表;而 `CommDB.enqueueFounderHubRoot()` **永远走这条分支**。⇒ fresh CommDB 上一条需要修复的 founder 回复会在 `recordSanitation()` 撞 `no such table` → **把 canonical row 一起回滚掉**。**净化审计会毁掉它本该记录的那条 founder 消息。** | ✅ 两个分支都装(幂等 CREATE IF NOT EXISTS)+ 走**真 CommDB facade** 的测试。变异验证复现逐字相同的 `no such table` |

> ⚠️ 这个 bug 之所以活到 code review,是因为我所有审计测试都**直接构造 `LeadInboxQueue(dbPath)`** —— 那条路会装 schema,把生产路径完全遮住。
> **教训:测生产 facade,不要测你自己方便构造的那个对象。**

### 未闭合(必须在 ship 前处理)

| # | 发现 | 为什么要紧 |
|---|---|---|
| ~~**BLOCKER-1**~~ ✅ **已闭合** | ~~**F 是死代码**~~ —— `freezeStockBelowWatermark()` **没有任何非测试调用方**。`ensureCutover` 从 owner/ACK drain 直接进 reconciler,不冻结。⇒ **A/B 恢复投递后,危险存量照样可被 claim。**<br>而且它**不是持久的一次性操作**:每次调用都重算 `MAX(seq)`,所以「每次 boot 调一下」会把**新行**也冻住。现有幂等测试两次调用之间没插入新行,遮住了这一点 | **已修**: 新表 `lead_inbox_freeze_install` 存第一次的水位线(重入复用绝不重算)+ 接进 `ensureCutover`(owner 之后、ACK drain 与 reconciler 之前)。新增两条 R1 点名的测试: 跨 boot 到达的真流量必须存活 / 第二次必须复用第一次的水位线。变异验证过 |
| ~~**BLOCKER-2**~~ ✅ **已闭合** | ~~pre-watermark 的 founder 指令仍能在水位线之上被重新生成,两条路~~:<br>① 冻结排除已投递行,但 `advanceDueUnprocessedReceipts()` 选「已投递未处理」的 root 生成新 model 子行,**内容以原 founder payload 开头**;`LeadReceiptPatrol` 生产在调<br>② **我的「founder_msg 不走 lead_events」声称被推翻** —— GatePoller **确实**往 `lead_events` 追加 `founder_reply`(含 founder 答复与祈使动作),再**另一条 autocommit** 标 delivered。两者之间崩溃 ⇒ 留下未投递的 `founder_reply`,而它**不在** reconciler 的 audit-only 集合里 ⇒ 水位线之后被物化成新 model 行 | **已修**: 路① 冻结事务追加 UPDATE 清 `next_unprocessed_at`(候选谓词的闸门;不谎称 processed/delivered/disposed)。路② 把 `founder_reply` 加进 `DEFAULT_AUDIT_ONLY_TYPES` —— 与 `gate_question` 完全同形的先例:canonical 行由别处建,物化镜像会造出第二条 model 行。两条都变异验证过 |
| ~~**HIGH-4**~~ ✅ **已闭合** | `reconcileEnqueueConsumed()` 修复了 content 但**不写审计**;复用比对**漏了** `ref_message_id` / `legacy_alias` / `deadline_at` / `created_at` / `delivered_at` vs `terminal.delivered`。另外 `receiptExemptionAudit.*` 三个字段**绕过** lone-surrogate 拒绝(只查非空、丢弃返回值),原值直接持久化并比对 | **已修**(三处): exemption audit 三字段过 assertNoLoneSurrogate 且两侧用校验值 / 终态首次 insert 写 sanitation audit / 比对补 ref_message_id+legacy_alias+deadline_at+delivered-vs-terminal。三条变异判据各自重现对应故障 |
| ~~**HIGH-5**~~ ✅ **已闭合** | B 仍允许**确定性坏行永久 wedge**:合法 JSON 但 shape 错的 payload 被裸 cast 成 envelope,渲染器随后 `session_role.toUpperCase()` 抛**未分类 `TypeError`** ⇒ 每次 boot 同样地抛、拿不到 quarantine marker | **已修**: 走 plan §4.2 定稿的【可审计 raw-JSON fallback】,不隔离(presentation 出问题不该让真通知消失)。新表 legacy_render_fallback,只记 error_name 不记 message。⭐ 变异判据用了最强形式: 去掉 fallback → 未分类 TypeError 中止整个 cutover、**毒行后面那行根本没机会落地** = 重现 wedge 本身 |
| ~~**REFUTED**~~ ✅ **已闭合** | ~~C 漏了一处~~:`gate-poller.ts:1737` 的 `m.content.slice(0, 2000)` 在写进 `lead_events` 之前按码元切 | **已修**: 换成 `truncateCodePoints`。这个 payload 会被持久化进 `lead_events`,所以在这里按码元切,铸的正是把全舰队卡死的那个毒形状 |
| — | quarantine alert 的 outbox 在接口/schema 里描述了,但**没有 producer / drainer** | **部分修**: marker 本身即 intent(同行同事务);补 list/accept/failure 状态推进 + dead-letter + runtime drain。两条约束守住: 告警绝不走 lead_inbox(否则卡在它报告的东西里)、sink 故障绝不让 ensureCutover 失败(否则告警通道故障拖死全场)。<br>✅ **sink 已接线**(后续提交):新增 `legacy_row_quarantined` alert 类型(穷举 switch 让 TS 指出全部 3 处需补点)+ plugin.ts late-binding holder(notifier 比 runtime 晚创建)。未就绪时回调**抛错而不是静默成功** —— 静默成功会把告警标成已接受然后丢掉,正是这条告警要防的事。已 grep 核实生产提供方存在 |

⇒ **当前状态:PR 不可部署。** A/B/C 的窄修在各自边界内是对的(R1 确认了 5 条),但 F 等于没接,而且 founder 重播还有两条活路。

---

## 1b.18 Codex code review R2 —— CHANGES REQUESTED(当前状态,不粉饰)

报告:`/tmp/codex-fly1586-code-review-round2.md`

R1 的 7 条我全闭合了,R2 又找出 **1 BLOCKER + 4 HIGH + 3 MEDIUM**。

### 已闭合(本轮)

| # | 发现 | 处置 |
|---|---|---|
| **HIGH-2** | **我在修 HIGH-5 时把 blanket catch 又造了一遍。** `renderEnvelope` 没有 purity 合同,撞上 `SQLITE_BUSY` 的渲染器会被「处理」成投递 raw JSON —— 把一条**只是需要重试**的消息永久降级。Codex 实跑复现。<br>⚠️ **这正是本单存在的意义要防的失效模式**,我为它写过一整个 `legacy-row-errors` 模块论证「判定取类型不取文本」,然后自己用了 catch-all。<br>附带:fallback 审计写在队列操作**之前**,后续失败会让它变成谎话 | ✅ 收窄为 `TypeError && code === undefined`(SQLite/I-O 错误带 `code`),其余原样抛;审计移到队列操作成功之后。⭐ 变异:退回 blanket catch → SQLITE_BUSY 测试从「拒绝」变成「resolved」 |

### 未闭合(必须在 ship 前处理)

| # | 发现 | 为什么要紧 |
|---|---|---|
| ~~**BLOCKER**~~ ✅ **已闭合** | ~~我的 resend 围栏被重新武装了。~~ 冻结只在 `next_unprocessed_at` 恰好非空时清它,而 receipt activation 随后会**把 timer 和 episode 重新写回去**(`db.ts:4558-4582`、`:4630-4651`),patrol 于是造出水位线之上、内容以旧 founder 指令开头的 model 子行。<br>**还有第三条路**:冻结之前就已存在的 `receipt_unprocessed` outbox 依然活着(`db.ts:5528-5588`),它的通知内容嵌了 `contentSummary` 并要求 Lead 完成路由副作用(`plugin.ts:8115-8147`)—— 一条旧的 `ship` 答复由此再次到达 Lead。<br>⚠️ 我加的那条围栏测试**看到 NULL 就停了**,从没跑 activation 或 advance | **已修**: 新表 `lead_inbox_fenced_root` 按【显式 id】登记水位线以下可能成为 resend root 的行(登记条件【故意不看】 `next_unprocessed_at` —— timer 当下的值不相关,这正是上一版的 bug)。四处选择器全部排除:两处 activation、`advanceDueUnprocessedReceipts`、`revalidateReceiptAlert` 的 live 检查(第三条路)。<br>枚举用谓词安全,因为带 `seq <= watermark` 下界:seq 是严格单调主键,水位线取定后集合不可能长大。<br>⭐ 变异判据(这次真跑了 activation):拿掉排除 → `expected 2026-08-01T01:01:00.000Z to be null`,精确重现「围栏被重新武装」 |
| ~~**HIGH-3**~~ ✅ **已闭合** | ~~`reconcileEnqueueConsumed` 仍把「owner 丢失」与「确定性冲突」都压成 `false`,`terminalizeNew` 再统一抛成 owner-fence → 分类器正确地 rethrow ⇒ **HIGH-4b 的新行为不是端到端闭合**:boot 时那个确定性冲突每次重试都中止 admission ~~ | **已修**: 实现 `inserted | idempotent | owner_lost | conflict{field}`;`terminalizeNew` 分流 —— owner_lost 照旧抛(瞬时,走 retry),conflict 抛 `LegacyRowPoisonError("terminal_conflict")` 走隔离。顺带闭合 MEDIUM-6(比对补 created_at,现覆盖 12 字段)。<br>⚠️ **诚实说明**: 这条路【只在竞态下可达】—— reconciler 先 getById,看到已存在的行就返回,单线程走不到。测试用 Proxy 让 getById 对该 id 报「不存在」把竞态确定性构造出来,注释里写明了这是竞态不是常规流。<br>⭐ 变异: conflict 退回当 owner_lost → `owner fence lost while reconciling ...` 从整个 run 冒出去 |
| ~~**HIGH-4**~~ ✅ **已修,但判据弱一档(见下)** | `questionAlreadyAnswered()` 仍吞掉 routing parse / CommDB open / query / close 的**所有**异常并返回 false ⇒ 一个 busy 的权威库会让一条**已被回答**的 question 被重新物化 | **已修**: catch 收窄为只吞 snapshot 解析的 `SyntaxError`;CommDB open/query/close 的异常原样抛。<br>⚠️ **这条我没能正面验到。** `routing_snapshot` 不是可直接设置的字段,它由 payload 经 `routingSnapshotForLeadEvent()` 派生,所以构造「权威库不可读」的 fixture 需要先摸清那个函数的形状。我写了一版测试,但它用 `store.setLeadEventRoutingSnapshot?.()` —— 那个 API 不存在,可选调用会**静默什么都不做**,是一条空过绿。**我把它删了而不是留着凑数。**<br>**当前依据 = 代码路径,不是实测。** |
| ~~**HIGH-5**~~ ✅ **已闭合** | 确定性隔离**仍然没有 alert outbox / drainer**。marker 上的 `pending_alert` 只是个标签,没有 producer、没有 drain、没有 dead-letter ⇒ 一条真通知可以永久隐身且无人知晓 | **部分修**: marker 本身即 intent(同行同事务);补 list/accept/failure 状态推进 + dead-letter + runtime drain。两条约束守住: 告警绝不走 lead_inbox(否则卡在它报告的东西里)、sink 故障绝不让 ensureCutover 失败(否则告警通道故障拖死全场)。<br>✅ **sink 已接线**(后续提交):新增 `legacy_row_quarantined` alert 类型(穷举 switch 让 TS 指出全部 3 处需补点)+ plugin.ts late-binding holder(notifier 比 runtime 晚创建)。未就绪时回调**抛错而不是静默成功** —— 静默成功会把告警标成已接受然后丢掉,正是这条告警要防的事。已 grep 核实生产提供方存在 |
| ~~MEDIUM ×3~~ ✅ **全部闭合** | ~~终态比对漏 created_at / 净化审计无冲突检测 / carrier 与 receiptExemptReason 抛通用枚举错误~~ | **已修**: created_at 并进 HIGH-3 的 12 字段比对;`recordSanitation` 加读回冲突检测(INSERT OR IGNORE 不是 append-only,是「先写者静默胜出」—— 一个 lone HIGH 和一个 lone LOW 会修复成同一个串,没有读回就再也说不清第二次的原值);carrier / receiptExemptReason 在枚举校验【之前】先过 lone-surrogate 拒绝。三条各有变异判据 |

⇒ **当前状态:PR 仍不可部署。**

### 我要留档的一句自省

R1 我犯的是「拿标签冒充事实」(review 没跑就预写 APPROVED)。
R2 我犯的是**更糟的一种**:我把自己刚论证过的原则,在修另一处时亲手违反了。
写下原则和遵守原则是两件事,而**深上下文下我更容易违反自己刚写的东西** ——
今晚三次自伤(重复插 schema、劈开多行 import ×2、blanket catch)都发生在后半程。

---

## 1b.19 Codex code review R3 —— 当前状态(BLOCKER 仍开着)

报告:`/tmp/codex-fly1586-code-review-round3.md`

### 已闭合

| # | 发现 | 处置 |
|---|---|---|
| **HIGH** | 告警 drain 的三个真缺陷 | ✅ ① **我的 drain 位置写错了**:脚本锚点 `}).run();` 匹配到 `LegacyAckDrain` 而非 reconciler,所以 drain 跑在**创建 marker 之前**,同一次 boot 的隔离压根不会被告警 —— 而我还照着「我以为的位置」在 commit message 里写了「drain AFTER reconciliation」。已移到 reconciler 之后。<br>② sink 忽略 `AlertResult`:`alert()` 对永久失败是 **resolve** 不是 reject,所以 `{deadLettered:true}` 会被标成 `alert_accepted` —— 记下「运维已被告知」,而通知系统刚放弃了它。改为抛错记诚实失败。<br>③ 晚绑定期间烧掉的重试没人补 → 绑定后立刻补一次 drain |
| **LOW** | freeze 总述注释与实现相反 | ✅ 已更正,并写明「不要凭旧那句话把围栏简化掉」 |

### ✅ BLOCKER 已闭合 —— 第五条 founder replay 通道

`receipt_unprocessed` → `detection_escalation` 被 `notifyLeadFirst` **持久写进 `lead_events`**(在 best-effort 投递之前)。若当初那次 enqueue 撞上毒行而未投递,下次 boot:F 只冻结**已在 `lead_inbox` 里**的行,随后 reconciler 在水位线**之后**把这条 detection 事件物化 —— 产出的 model 行**带着旧的 founder 答复**,且可被 claim。

⚠️ **R3 点出的关键**:`buildUnprocessedReceiptAlertPayload` 把 founder root 抄进 `contentSummary`,而**制造 seq 56649 的正是这条路径上的那次截断**。所以这不是相邻遥测,**是同一根管子** —— 这条通道不修,那个毒行的成因就还留着。

**窄修法(R3 给的,不能一刀切)**:只压制 payload 为 `escalation_kind='receipt_unprocessed'` **且**源 receipt 指向**已 fenced root** 的那些 detection_escalation。
❌ **不要**把所有 `detection_escalation` 设成 audit-only —— 多数没有别的 canonical 投递,一刀切会造出新的静默。

**已解决(用真库跑出来的,不是读代码猜)**: `episode_fingerprint` **就是 root id** —— 真的 join 了 founder_msg / chat / lead_event 三种形状,各自在【对应项目】的 CommDB 里 1:1 命中。`detection_target_key` 只是 `project:lead`,必然一对多,不可用。⇒ 不需要给 payload 补 root id(那是扩范围)。

**窄修法已实现**: 只压制 `event_type=detection_escalation` 且 `escalation_kind=receipt_unprocessed` 且 `episode_fingerprint ∈ fenced 集合` 的行。新表 `legacy_stock_suppressed`(与 quarantine 分开:这行不是毒、没有失败,是我们已经决定扣住它描述的那个东西),扫描一并排除,**绝不写 delivered_at**。
⭐ 变异:去掉 fenced 检查 → 带 `answer="ship"` 的 escalation 在水位线之上被物化出来。

**当前生产暴露面(真库量的)**: 2,157 条未投递的 receipt_unprocessed escalation 里 founder_msg 形 **0 条**(317 条全部已投递)⇒ 机制真实、该修,但**此刻没有在流血**。

**原始拦路问题(留档)**:escalation payload(`detection-escalation.ts:188-202`)里有 `escalation_kind` / `detection_target_key` / `episode_fingerprint`,但**没有显式的 root id**。所以第一步是确定**从哪个键能可靠地回指到被 fence 的 root** —— 在那之前写不出正确的压制条件。

---

## 1b.20 通用教训(比这一单本身更通用,Tadashi 要求单独记)

### ① 「fixture 造错了 ⇒ 测试为【错误的理由】通过」

**一个为错误理由通过的测试,比红的测试更坏** —— 它给你假的安全感,而且没人会再回来看它。

本单撞到两次,都是**查真实行状态**才发现的,不是靠读代码:

| 情形 | 表面 | 真相 |
|---|---|---|
| 用 `markConsumed` 造「已投递未处理」的 root | 以为 fixture 就绪 | `markConsumed` 在**未被 claim** 的行上是 **no-op** —— 所有字段仍是 NULL,围栏当然不登记它 |
| 用测试 helper `append()` 造 `detection_escalation` | 以为事件类型是它 | helper 把 `event_type` **写死成 `session_completed`**,被测的判断根本没被触发 |

**做法**:测试第一次红时,**先去看真实持久化状态**(逐字段打印/查库),再决定是改实现还是改 fixture。第一反应去改实现,是把正确的实现改坏的最短路径。

同族的还有本单更早的两次:
- 我写过一条用**根本不存在的 API** + 可选调用(`store.setLeadEventRoutingSnapshot?.()`)的测试 —— 静默什么都不做、必然绿。**删掉而不是留着凑数。**
- 我做变异验证时用索引切片改文件,把语法切坏,vitest 报 `no tests` —— **文件加载失败不是「验证通过」,是「验证没跑成」。**

### ② 「补了编译器指出的地方 ≠ 补全」

新增 `AlertEventType` 时,TS 精确指出了 3 处穷举 switch,我补完就报了全绿。
但 `kind-contract.test.ts` 里有两条**类型系统看不见**的不变量:
- `escalatesAtEnqueue` 必须恰好等于 `none_escalate` 那组(硬编码期望集)
- contract 的 owner 必须与 `resolveTicketOwner` 逐个一致(防**表↔路由漂移**)

⇒ CI 红。**编译器能证明的是类型一致,不是语义一致;后者只活在测试里。**
改了一个「有配套表/路由」的枚举,必须去跑断言那个配套关系的测试文件。

### ③ 用脚本改代码时,锚点必须**唯一**

本单因锚点歧义自伤 5 次,最严重的一次:`}).run();` 匹配到了 `LegacyAckDrain` 而不是
reconciler,于是 drain 跑在创建 marker **之前** —— 而我照着「我以为的位置」在 commit
message 里写了「drain AFTER reconciliation」,**写下了一句假话**。

**做法**:替换前 `assert s.count(old) == 1`;插 import 要锚在**完整的单行 import 语句**上,
不要锚在 `import ` 前缀的最后一次出现(那可能落在一个多行 import 块中间)。

### ④ 「等 CI 出结论」和「继续 push」互斥

每次 push 都会取消上一次 run。本单连续三次自己掐掉自己的判据,最后一次是被一个
**纯文档提交**掐的。要判归因就**停手等**,别一边等一边推。

---

---

## 2. 改动清单

| # | 目标 | 主要文件 | 类型 |
|---|------|----------|------|
| A | **authoritative enqueue 边界**的统一写入规范化（收窄声明见 §3.2） | `packages/flywheel-comm/src/lead-inbox-queue.ts` | 修复（根因层） |
| B | 严格分类的 per-row 隔离：确定性毒行不拖死全场，瞬时故障照常重试 | `packages/teamlead/src/bridge/legacy-lead-event-reconciler.ts`<br>`packages/teamlead/src/bridge/lead-inbox-runtime.ts` | 修复（韧性层） |
| C | 码点安全截断（共享 helper） | `db.ts` / 两套 runtime / `hook-payload.ts` / `gate.ts` | 修复（源头层） |
| **F** | **存量冻结（只投新增）**：freeze epoch + 冻结集 + 投递侧 fail-closed 闸 | `packages/flywheel-comm/src/lead-inbox-queue.ts`（新表 + 谓词） | **新增（安全层，见 §1b）** |
| ~~D~~ | ~~修既有 `InboxLoopHealthChecker` 的投递闭环~~ | ~~`inbox-loop-health-checker.ts`~~ | **移出本单 → §12.4 follow-up** |

**补扫不写新逻辑** —— 见 §6。本单的补扫**只出清单、不投递**（§1b 红线 #5）。

> ⚠️ 编号说明：新增项用 **F**（freeze）而不是复用 D，是为了让「A/B/C 三件套」在 FLY-1579 原稿、Codex 5 轮 review 记录、和本单 PR 之间**保持同一套指代**，避免复用字母造成跨文档误读。

---

## 3. A — `LeadInboxQueue` 统一规范化写入

### 3.1 三个写入/比对入口，不是一个

Codex R1 抓出的关键遗漏（已复核）：

| 入口 | 行 | 问题 |
|------|-----|------|
| `enqueue()` | ~514-650 | INSERT 后读回比对（本次引爆处） |
| `reconcileEnqueueConsumed()` | ~1579-1638 | **直接 `INSERT OR IGNORE` 并用原始 `input.content` 比对，完全绕过 `enqueue()`**。legacy reconciler 的 answered / probe 分支走它 |
| `enqueueHubRoot()` | ~656-702 | 内部调 `enqueue()`，但**外层又拿读回行与原始 `input.content` 再比一次**。内层净化、外层不净化 → 照抛 |

⇒ 「8 个 `.enqueue` 调用点一次性覆盖」**不成立**。收口必须是一个三方共用的 normalized write object。

### 3.2 做法

```
normalized = normalizeInboxWrite(input)   // 一次，且只有一次
INSERT ... VALUES (normalized...)          // 写它
expected（每一层，含 enqueueHubRoot 外层） = normalized   // 比它
```

分层取向。⚠️ R2 修正：字段全集比二稿写的大，且**三个入口形状不同，不能用一个模糊 spread 假装同形**。

定义三层 normalized 对象 + 各自的 exact comparator：
`NormalizedInboxWriteBase` / `NormalizedHubExtension` / `NormalizedTerminalExtension`，**保留每个入口现有的 byte semantics**（base `enqueue` 允许空 `content` 且不 trim；hub root 要求并 trim content；`reconcileEnqueueConsumed` 收完整 input 却不写 carrier/exemption/audit，且当前 comparator 还漏 ref/alias/deadline）。

| 字段 | 取向 |
|------|------|
| `id` / `to_lead` / `source` / `type` / `legacy_alias` / `ref_message_id` | **拒绝**（fail-closed） |
| `receiptExemptionAudit.eventId` / `.actor` / `.changeSource` | **拒绝**。⚠️ 当前只调 `requiredText` 校验、**没用其返回值** |
| **`enqueueHubRoot.routingState`** | **拒绝**。⚠️ R2 新增 —— 会 trim/default 后直接写 `routing_state` 并 read-back compare（`:656-700`），与本次完全同形 |
| **`reconcileEnqueueConsumed.terminal.disposition`** | **拒绝**（枚举 / authority string）。⚠️ R2 新增 —— 直接持久化并比较 |
| `msg_class` / `carrier` / `receiptExemptReason` | **拒绝**（持久化字符串枚举）。`carrier`/reason 已有运行时校验；`msg_class` 目前只靠 SQLite CHECK，一并纳入 boundary |
| `deadlineAt` / `createdAt` / audit `at` / hub `now` | 现有严格 UTC regex 天然拒绝代理项，**继续复用**；但必须列入 normalized 合同，INSERT 与 expected **不得回到原始 input** |
| `content` | **修复**（替换孤立代理项为 U+FFFD）+ 净化审计（见 §3.5） |

### ⚠️ A 的不变量声明必须收窄（R3 HIGH-5）

二稿的声明「孤立代理项进不了 `lead_inbox`」**过强、不成立**。除三个主入口外，还有两处 direct INSERT / 诊断字段写入：

| 位置 | 性质 | 处置 |
|------|------|------|
| `quarantineModelBatch()`（`lead-inbox-queue.ts:1516-1534`） | direct INSERT + read-back compare；但 `error` 会写 `last_error`（`:1500-1509`），**并非全部由受控常量派生** | 调用同一 primitives **或**加 source-proof 测试 |
| **`CommDB.advanceUnprocessedReceiptState()`（`db.ts:4783-4812`）** | ⚠️ **R3 新增** —— direct INSERT + read-back compare 写 receipt resend；值主要来自已读回的 SQLite row 与受控常量 | 显式分类 + source-proof 测试 |
| `recordFailure()` / model / protocol failure APIs | 持久化**调用方错误文本** | 归为 diagnostic mutation |

**定稿的不变量声明**（写进代码注释与 PR）：

> A 保护的是 **authoritative enqueue 边界的 insert/verify value-drift**。
> **后续 diagnostic mutation（`last_error` 等）不参与 comparator**，由 SQLite readback 自然 well-formed 化。
> **不声称 `lead_inbox` 全表所有 TEXT 都已规范化。**

**身份不变量已核**：稳定 ID、去重键、delivery membership 都由 event / question / member ID 构成，**不由 `content` 哈希构成**，所以在首次持久化前统一规范化不会破坏它们（Codex R1 独立确认，本 runner 复核 `lead-event-queue.ts:20-36` 与 `lead-inbox-loop.ts:286-301` 一致）。

### 3.3 ⚠️ 不能用 `toWellFormed()` —— 编译不过

根 `tsconfig.base.json` 的 `target` / `lib` 都是 **ES2022**。`String.prototype.toWellFormed()` 是 ES2024，用仓内 TypeScript 5.9.3 编译探针会报：

```
Property 'toWellFormed' does not exist ... Try changing the 'lib' compiler option to 'es2024' or later.
```

**运行时 Node 25 支持，消不掉编译期类型错误。**

⇒ 本单实现一个**局部、带类型的 helper**（只替换未配对的 high / low surrogate），**不为一个 P0 抬高全仓 lib 基线**。

helper 测试必须覆盖：lone high、lone low、有效 surrogate pair（不得改动）、相邻多组、空串、纯 ASCII。

### 3.4 净化审计（R2 要求：必须选定持久化位置，不能只写「需明确」）

`LeadInboxQueue` **没有 StateStore 依赖**，所以审计落在 **CommDB 内一张 append-only sanitation audit 表**（**不改 `lead_inbox` 的列**，符合「不改 schema」的约束 —— 那条约束指的是 `lead_inbox`）。

必须定义：稳定 ID、被替换的字段名与替换计数、**原始 UTF-16 code-unit digest**（用于事后取证与冲突比较）、以及**与 inbox INSERT 同事务同生共死**。审计写失败 → 抛（fail-closed）。

> 结构化日志**不足以**满足 §8 验收 #11 的重启回归 —— 必须是可查询的 durable 事实。

### 3.5 回归测试

三个入口各一条；外加一条专测 **`expected` 用的是规范化之后的值**（若仍取原值，异常照抛 = 等于没修 —— 这是本改动最容易写错的地方）。

---

## 4. B — 严格分类的 per-row 隔离

### 4.1 现状

`legacy-lead-event-reconciler.ts:106-164` 的单行体**不只有** `JSON.parse` / render，还包含 StateStore / CommDB 读写、owner-fenced queue 操作、legacy filesystem probe。

⇒ **裸 `try/catch` 会把 `SQLITE_BUSY`、I/O / probe 故障、owner fence / lease 变化误判成「确定性毒行」并永久丢弃真实通知。**

⚠️ R1 修正：原写「复用 `onProtocolQuarantine`」**不成立**。`lead-inbox-runtime.ts:115-127` 那个 callback 是协议行**已被 `recordProtocolDeliveryFailure` 终态化之后**发的 model advisory，不是 cutover 行的 durable dead-letter API。

### 4.2 ⚠️ R2：必须给出可编码的 typed boundary，"原则"不够

R2 指出两个**真实确定性坏行仍会掉进「继续抛」从而再次 wedge** 的漏口（已复核）：

| 漏口 | 说明 |
|------|------|
| **合法 JSON 也可能是坏 payload** | 字段类型错时生产 renderer 会执行 `session_role.toUpperCase()`、`summary.slice()`、`last_error.slice()`（`mailbox-lead-runtime.ts:224-349`、`hook-payload.ts:283-315`）。这类 `TypeError` 对同一行**是确定性的**，但既不是 JSON parse 失败也不是 routing surrogate → 按「只 catch 窄化 poison」会继续抛 → **仍永久卡死** |
| **`reconcileEnqueueConsumed()` 的 boolean 混义** | 它把「owner 已丢失」与「同 ID 行内容/终态冲突」都压成 `false`（`:1595-1638`），`terminalizeNew()` 再统一抛成 `owner fence lost`（`legacy-lead-event-reconciler.ts:167-182`）→ **确定性 conflict 被误分类成瞬时 owner-fence，永远重试** |

反方向还有一个：`questionAlreadyAnswered()`（`:185-201`）**catch 了 routing snapshot parse、CommDB open/query/close 的所有异常并返回 false**，与「DB/FS 错误必须继续抛」的新合同直接矛盾，可能在不可证明已回答时重复物化通知。

**要求的 typed 合同**：

| 类型 | 抛出位置 | 处置 |
|------|----------|------|
| `LegacyRowPoisonError('invalid_payload_json')` | **只包在精确的 `JSON.parse(row.payload)` 周围**（`SyntaxError`） | quarantine |
| **envelope shape 不合法** | 新增 **explicit decoded-envelope shape validator** | ⚠️ **R3 定稿：走「可审计的 raw-JSON fallback」，不 quarantine。**理由：presentation shape 有问题不该让一条**真实通知**消失。<br>⇒ 该行**无 marker、正常入列、最终 delivered**（状态与 #7 相同）。<br>⚠️ validator 必须覆盖**生产 renderer 与共享 renderer 实际解引用的全部字段**，不能只覆盖 `session_role` / `summary` / `last_error` 三个示例。<br>⚠️ 任何**未分类**的 renderer 异常仍然**抛并重试**，**禁止 blanket catch**。 |
| `InboxWriteValidationError(field, reason)` | normalized routing validator | quarantine |
| `InboxWriteConflictError` | ID reuse / expected conflict（**与 owner-fence 分开**） | quarantine |
| `SQLITE_BUSY` / I/O / `owner_lost` / 未知异常 | 原样 | **继续抛，走现有 retry** |

配套改动：
- `reconcileEnqueueConsumed()` 改成 **discriminated result**：`inserted | idempotent | owner_lost | conflict` —— **禁止 boolean 混义**
- `questionAlreadyAnswered()` **只允许窄化处理 malformed / irrelevant snapshot**；CommDB / FS 异常必须重新抛

### 4.3 ⚠️ R2：quarantine 状态机（必须选定，不能让实现者现场发明）

现有 `lead_events.dead_lettered_at` 属于**已退役的 ACK state**，且 `listUndeliveredLeadEvents()` 只按 `delivered_at IS NULL` 查询（`StateStore.ts:9984-9992`）—— **直接复用不会让 cutover 跳过该行**。marker 在 StateStore、alert 在别的 DB/FS 时也拿不到「两次都成功」的原子性。

**选定方案**：在 **StateStore 同一事务内**写 `legacy_cutover_quarantine` marker **与 out-of-band alert intent/outbox**。

| 项 | 定义 |
|----|------|
| 稳定键 | immutable `seq` + payload digest |
| 状态 | `pending_alert` → `alert_accepted` → `replayed` |
| 附带 | poison reason / field、created / accepted / replayed 时间 |
| **per-row cutover commit point** | ⚠️ **R3 修正 —— 这是本计划自己的一个真设计 bug。** 二稿把「能否跳过该行」绑到 `alert_accepted`，那等于把「一行坏数据拖死全场」改写成「**告警通道故障拖死全场**」（`LeadAlertNotifier` 可能永久返回 no-channel / no-token / 4xx dead-letter → `ensureCutover` 每 tick 清 promise 重试 → 同一类 fleet-wide wedge，只换了触发条件）。<br>**正确定义：marker + pending outbox 在 StateStore 同一事务里提交成功，即为 per-row commit point。**提交成功 → 该行可**带审计地跳过**，cutover 继续。 |
| outbox 推进 | `queued` / `delivered` / `dead_lettered` **独立推进**，保持可观测、保持红色、可 redrive。**Discord 可用性绝不作为 boot admission 的依赖。** |
| drain 时序 | 必须写清三处：**同步首次 drain、独立 timer drain、Bridge 重启 boot drain** 的顺序 |
| 失败 | 任何 marker / outbox 写失败 → **抛**（这才是真正的瞬时故障） |
| **绝不** | **绝不写 `delivered_at`** —— 这条通路的全部价值就是「投递过没有」的真实性 |
| 人工 replay | **CAS 清 marker / 标记 replayed**，**不删审计** |

### 4.4 `ensureCutover` 的失败分类

`lead-inbox-runtime.ts:206-268`：

- **瞬时失败** → 清缓存重试（现状）
- **确定性 poison**：**marker + pending outbox 的原子提交成功即成功** → 让 cutover 成功返回，不再无限重试
- **只有 marker / outbox 事务本身失败**才抛并清 promise 重试

> ⚠️ R4 抓出：本节二稿残留「已到 `alert_accepted` 才算成功」，与 §4.3 定稿冲突，**照它实现会完整复活 R3 B1（告警通道故障拖死全场）**。已删除。

> 当前「失败即清缓存重试」把**一次性崩溃放大成永久死循环**，是本次 **60+ 小时**停摆的放大器，与毒行本身同等重要。

**不做**：不改 `admit()` 在 tick 里的位置（会动 at-least-once 语义，超出 scope）。

### 4.5 测试

- 保留现有「StateStore delivery commit 后崩溃」回归
- **负对照：瞬时故障（`SQLITE_BUSY` / probe I/O / owner-fence）绝不允许被 quarantine**

---

## 5. C — 码点安全截断（共享 helper）

引入共享 `truncateCodePoints(s, limit) -> { text, truncated }`，**同时驱动正文和省略号**。

⚠️ R1 抓出的遗漏（已复核）：

| 位置 | 说明 |
|------|------|
| `packages/flywheel-comm/src/db.ts:4931` | 本次实际引爆的那个 |
| `packages/teamlead/src/bridge/mailbox-lead-runtime.ts:348-349` | 在 `renderEnvelope` 内部，渲染时现场铸毒 |
| **`packages/teamlead/src/bridge/commdb-lead-runtime.ts:219-220`** | **漏了** —— CommDB rollback runtime 仍可经 `FLYWHEEL_COMM_BACKEND` 选中（`plugin.ts:851-963`），有同款截断 |
| **`packages/teamlead/src/bridge/hook-payload.ts:296-297`** | **漏了** —— 两个 runtime **共用**的 session-stuck renderer |
| **`packages/teamlead/src/bridge/hook-payload.ts:476`** | **漏了** —— `suspicious_pane_tail.slice(0, 2_000)` |
| **`packages/teamlead/src/bridge/hook-payload.ts:253-257`** | ⚠️ **R2 新增** —— `tail.slice(-STUCK_TAIL_MAX_CHARS)`，共享 `runner_stuck_escalation` renderer，**从尾部边界切开 surrogate pair**，且 §5 原来的 `.slice(0, N)` grep **扫不到它** |
| `packages/flywheel-comm/src/commands/gate.ts:188,351` | question 路径本身 |

⚠️ **`args.message.length > 500` 这个判断也要一起改。** 只改 slice 不改比较，会让「≤500 码点但 >500 码元」的串产生**错误的省略号**。

⚠️ **重新扫描时必须支持数字分隔符** —— 原计划的 `[0-9]{2,}` 会漏掉 `2_000`：

```bash
# 同时覆盖正向与负向截断，并支持数字分隔符；substring/substr 逐项人工审查
grep -rnE "\.slice\(\s*(0\s*,\s*)?-?[0-9][0-9_]*\s*\)|\.substring\(|\.substr\(" \
  packages/flywheel-comm/src packages/teamlead/src --include='*.ts' | grep -v __tests__
```

并**逐项分类每个命中点能否到达 `lead_inbox`**，不要只按已知命中点下结论。

### ⚠️ helper 的合同（R2 要求明确，否则与 A 的审计边界打架）

`Array.from()` 按码点切**只保证不切开原本有效的 pair**，**不会修复输入本来就带的孤立代理项**。两种合同二选一：

| 合同 | 后果 |
|------|------|
| **✅ 选它 —— C 只做安全截断，修复与审计全部留给 A** | A 保持**唯一**的净化审计边界，语义最干净 |
| ❌ C 也调用 repair helper | 毒行在到达 A 之前就被修掉 → **净化审计丢失** |

⇒ 因此「输出绝无孤立代理项」这条测试**限定 well-formed 输入**；malformed 输入的 repair + 审计由 A 负责。

测试：mailbox / commdb 两套 renderer 的 parity + well-formed 输入下「输出绝无孤立代理项」+ 负向截断（`slice(-N)`）不切开尾部 pair。

---

## 6. 补扫：不写新逻辑，只写「证明」和「清单」

`QuestionAdmission.materializePending()` 本身就是幂等重扫。**通路一恢复，仍 open 的 question 自动被捞回来。**

一次性命令（仓内可审查脚本，非临时命令）的职责：

1. **冻结 cohort**：取证阶段（§1 证据 #6）就把 question ID 集合固化下来，避免部署时漂移
2. **从生效的生产配置导出 project/lead 集合**，对每个配置的 DB 调用**真实的 `CommDB.getPendingQuestions`**，同时记录生效的 `FLYWHEEL_COMMDB_PROTECTION`（`db.ts:299`，默认 ON）
3. **出两份清单**：可救的、需人工决定的

⚠️ 命令**不得自己重写 pending 谓词** —— 两边理解一旦漂移就是下一个 FLY-1579。

⚠️ **补扫成功的标准不是「出现在 `lead_inbox`」**，而是 `consumed_at IS NOT NULL AND disposition='delivered'` **且有 Lead / 独立 QA 的接收确认**。

参考量（07-31 实测，部署时以冻结 cohort 为准）：flywheel 漏 17 / 可救 4；tidal-echo 漏 3 / 可救 3。其余已 `terminal_disposed` 或已被 Tadashi 手工回答，`getPendingQuestions` 结构性排除 —— **这是正确行为，不绕过**。

---

## 7. D — 修既有 `InboxLoopHealthChecker` 的投递闭环

**不新建 checker。** 见 §0.3。

| # | 改动 | 理由 |
|---|------|------|
| D1 | **保留**现有 `LeadAlertNotifier` direct Discord sink（它已经是 out-of-band），**补 durable delivery outcome + receiver receipt** | 现在发送结果**没有任何持久化**，所以 60+ 小时后无人能回答「有没有人看见」 |
| D2 | **durable episode 状态机**（见下），而不是一句「成功后 latch」 | R2 指出：只检查返回值不够，现有 dedupe 顺序会让重试被 `duplicate` 永久吞掉 |
| D3 | L1 业务不变量（question 超时未进 `lead_inbox`）**复用同一个 HeartbeatService**，不另起 GatePoller checker | 单一守卫，单一闭环 |
| D4 | 目标集合**从生产配置动态导出** | 不得硬编码 16（初稿写 14 就是错的） |

### 7.1 ⚠️ 为什么「检查返回值后再 latch」不够（R2 BLOCKER，已复核）

`LeadAlertNotifier.alert()` 在**网络发送之前**依次 claim `claims.db` 和 `lead_events`（`:794-848`）。所以第一次调用若在 claim 之后崩溃 / 返回 `queued` / 进入 `deadLettered`，**同一 event ID 的下一次调用只会拿到 `{skipped:'duplicate'}`** —— 这个结果**无法区分**「此前已 sent」「仍在 queue」「已 dead-letter」「claim 后 POST 前崩溃」。

另外：
- `queued:true` 只是 **durable accepted，不是 receiver success**，不能直接 latch 成成功
- `deadLettered:true` 明确是失败
- legacy per-Lead 成功路径按兼容约束**只返回 `{sent:true}`**；`messageId` 只有 unified path 才暴露（`:921-931`）→ **验收 #4 的「真实 message/receipt ID」在部分生产配置下拿不到**
- `claimHealthEpisode()`（`lead-inbox-queue.ts:1956-2004`）是**原子写 `stall_episode_at` 后才返回 payload**；把 alert 简单挪到它之前会**丢失稳定 episode identity 与并发 claim**

### 7.2 选定的 episode 状态机

### ⚠️ R4 定稿：episode authority 只能有一个（否则 queue-first 起点之前还有一个静默窗口）

R4 抓出：`InboxLoopHealthChecker` 先调 `LeadInboxQueue.claimHealthEpisode()`，它在 **CommDB 事务内**写 `loop_heartbeat.stall_episode_at`（`lead-inbox-queue.ts:1965-2004`），之后**只要 latch 非空就直接返回 `undefined`**（`:1980`）。而 queue-first 是在**另一个 store** 里 `ensure` episode。

⇒ 若进程在 **latch 已提交、episode row/file 尚未创建**之间退出：重启后 checker 认为已 claim，而 `reconcileLeaseEpisodeQueue()` 只能扫 episode store 里**已存在**的 `listPending()` 行（`lead-lease.ts:1460-1480`），**无从发现这个缺失 episode** → **latch 已落、outbox 不存在、以后永久闭嘴** —— 正是 D 要消灭的失败类，只是换了窗口。

**定稿（取 Codex 给的第一个选项，更干净）：generalized episode store 的 active pointer 是唯一 claim authority。**

- `claimHealthEpisode()` 的 CommDB 查询降级为 **read-only observation**
- 先 `ensure + materialize` durable intent，**再**写 `stall_episode_at`，且它只作为**可重建的 mirror**
- ⇒ 不再存在「latch 是权威但 outbox 不存在」的状态

**必须新增 crash fixture**：在 latch commit 之后、episode row/file 创建之前**终止进程**；重启后**无需人工清 latch**，仍能自动 materialize → POST → 持久化 receipt，并在恢复时正确关闭**同一个** active episode。

### R3 定稿：queue-first 顺序，照抄仓内更接近正确的先例 `ensureLeaseEpisodeMaterialized()`（`packages/flywheel-comm/src/lead-lease.ts:1337-1406`）—— **先 durable 写 queue file / send intent，再标 `queued`；由独立 drain 发送，POST 之后才标 terminal**（`LeadAlertNotifier.ts:1083-1132,1176-1180`）。

**为什么必须 queue-first**：现有 `alert()` 在网络 I/O **之前**先写 claims.db 和 `lead_events`（`:794-848`）。进程若在 claim 之后、POST 之前退出，durable outcome 永远停在 `unmaterialized`，重试只会拿到 `skipped:'duplicate'` —— **「duplicate 时回读 outcome」无法让一个不存在的 outcome 前进**。queue-first 让 crash-before-POST **可恢复**。

**crash-after-POST-before-ack**：明确采用 **at-least-once 重发**（可能重复一条告警，可接受），**不假装有远端 reconciliation**。

### ⚠️ R4 定稿：现有 drain 不能直接照抄 —— terminal ack 是 best-effort，会删掉唯一的重试事实

R4 复核出被我引为先例的代码本身有缺陷：`markEpisodeTerminal()` **catch 后只记日志并返回 `void`**（`LeadAlertNotifier.ts:1315-1331`），而两个成功 POST 分支在调用它之后**无条件 `unlinkSync(path)`**（`:1128-1132,1176-1180`）。

⇒ Discord 已返回 message ID、但 episode DB 此刻 `SQLITE_BUSY` / 损坏：**receipt 没写成，queue file 却被删了** —— 既回答不了「送达没有」，也**不会**按计划 at-least-once 重发。dead-letter 分支同样（`moveQueueFileToDeadLetter()` 吞掉 terminal 写失败后仍 move，move 失败甚至 best-effort unlink，`:1243-1266`）。

**定稿：durable terminal outcome（含 channel / message ID）是 `unlink` / `move` 的 fence。**

| 情形 | 要求 |
|------|------|
| delivered ack 写失败 | **保留 queue file**，下轮允许重复 POST（at-least-once） |
| dead-letter | **先**形成可由 boot reconcile 恢复的 durable terminal / file，**再**移除源 intent |

**必须新增两条故障注入**：① POST 200 后 terminal DB write 失败 → 文件仍在、下轮重发后落 receipt；② dead-letter 的 state write / move 任一失败 → **至少一个可重建事实始终存在**。

### ⚠️ R4 定稿：泛化 episode store 必须按 domain 分区

`counts()` / `activeCount()` 当前对**整表 / 全部 pointer** 计数（`lead-lease.ts:1282-1316`），`collectLeadLeaseDiagnostics()` 又把任意 `unmaterialized` / `queued` / `dead_lettered` / active episode 视为 **lease unhealthy**（`:1620-1623,1775-1788`）。

⇒ 直接塞进 `inbox_loop_stalled`，**一次 Discord outage 会把 health-alert episode 记进 lead-lease readiness**，制造新的跨域故障信号。

**定稿**：保留「同一 store / 同一状态机」，但 **查询、diagnostics、`reconcileLeaseEpisodeQueue()`、active counts 全部按 domain / kind 分区**。负对照：pending / dead-lettered 的 inbox-health episode **不得改变**既有 lease readiness；lease episode 的原语义**逐字保持**。

状态机沿用 `unmaterialized → queued → delivered / dead_lettered`。⚠️ `LeadLeaseEpisodeStore`（`lead-lease.ts:1033-1092,1114-1289`）目前**只接受 lease fault kinds** —— **定稿：泛化该模式**（而不是另建 inbox-health 表），以免又多一套并行的 episode 语义。

要求：

1. 第一次检测**只创建稳定 episode / pending record**，**绝不把「检测到」混作「已送达」**
2. `{sent:true}` → 记 `delivered` + channel / message receipt；`queued:true` → 记 `queued`，由**现有 drain 在真实 POST 之后**推进到 `delivered`；`dead_lettered` **保持可见**并允许配置恢复后**显式 redrive**
3. **`skipped:'duplicate'` 必须回读 durable outcome，绝不视作成功**
4. episode 恢复后**关闭 active pointer**，下一次真实 recurrence 才产生新 ID
5. **⚠️ R3 定稿：legacy receipt 走「additive `messageId` 字段」，不强制 unified 模式。**现有 `postMessage()` 只在 unified 模式解析/返回 message ID，legacy 成功仍是精确 `{sent:true}`，legacy drain 也不把 receipt 放进 `delivered[]`（`:921-931,1010-1026,1155-1180,1458-1471`）。<br>选 additive 的理由：强制 unified 会在 **P0 期间改动全舰队的告警路由**，blast radius 远大于给 legacy 成功路径加一个**可选字段**（`{sent:true}` 逐字保留 → 字节兼容）。

⚠️ **L1 的 class-aware 硬约束（写进实现注释）**：只扫 `question`。正对照 = 07-29 当天 38/47 question 有对应行、最后一条 `question:flywheel-eng-lead:8af841ba-…` 带完整 `consumed_at` + `disposition=delivered`。**对 `instruction` / `response` 类此推论不成立**（走别的通路，`lead_inbox` 里本来就没有），绝不泛化成「所有 message 都该有 inbox 行」。

---

## 8. 验收标准

判据（写进 PR 描述）：

> **如果一条验收能在「接收方不存在」的情况下通过，那这条验收是无效的。**

依据：编号 742（守卫开火 16 次、16/16 卡在同一处、17 天无人知晓）。**本次同类**：`InboxLoopHealthChecker` 检测开火 16/16、`alert_claims` 16/16 齐全，但 **TS 告警通道的发送结果在本仓没有任何持久化记录** —— 60+ 小时后**无人能回答「当时有没有人看见」**。所以本单的验收必须落到接收端 receipt，而不是「emitter 被调用过」。

| # | 验收 | ❌ 不算 | ✅ 才算 |
|---|------|--------|--------|
| 1 | 真机端到端 | 「admission 被调用了」/「返回 0」 | 真 runner 发 question → `lead_inbox` 有 `ref_message_id` 匹配行 → **`consumed_at` 非空 + `disposition='delivered'`** → Lead 侧确认 |
| 2 | 前后对比 | 「进入率 90%+」（cohort / 窗口 / 分母未定义，且允许 10% 有效消息继续丢） | **固定部署后 cohort，在明确 SLA 内 100% 的 eligible question 达到 receiving-end delivered**；业务排除逐条列出。heartbeat 判据改为 `last_started_at - last_success_at <= 阈值`，不要求字面「追上」 |
| 3 | 补扫可用 | 「进了表」 | 冻结 cohort 内可救的全部 `delivered` + 接收确认；不可救的出人工清单 |
| ~~4~~ | ~~检查器阳性~~ | — | **随 D 移出本单**（§0.0 / §12.4）。判据原文保留在 follow-up 用：拿到 alert channel 真实 message/receipt ID + 独立 QA 或人类确认 |
| ~~5~~ | ~~检查器阴性对照~~ | — | **随 D 移出本单**。原文：①正常 question → 不告警；②接收器断开时验收必须失败 |
| **3b** | **`lead_notified` 类通知也要到 Lead**（FLY-1586 验收 #3） | 「question 通了就算」 | **不只验 runner 的 `question`**：`lead_event` 车道（`source='lead_event:<seq>'`）的**新增**行同样要走到接收端 `consumed_at` 非空 + `disposition='delivered'`。<br>⚠️ 这条与 D **无关** —— 它验的是**收件循环本身**通了，不是告警通道有没有 receipt。今晚那条误报 page 之所以吵到 founder，正是因为 Lead 收不到通知 ⇒ 不可能 ack ⇒ 升级链一路走到底 |
| 6 | 反向验证 | 「可观测」 | 指定确切 event type、持久化位置、alert receipt/message ID、安全故障注入点 |
| 7 | **真实毒行 fixture（A+B 贯通）** | ~~「该行被隔离并告警」~~ ⚠️ 与 A 自相矛盾，R1 抓出 | seq 56649 的孤立代理项在**可修复的 `content`** 里 → **正文被规范化、该行成功入列、后续行继续、最终接收端 `delivered`**，并验证净化审计。⚠️ fixture 必须**保存原始 JSON 文本里的转义 `\ud83c`**（让 `JSON.parse` 后才产生真 lone surrogate）；**从生产证据提取脱敏最小 payload 提交进 test fixtures 并锁定 code unit**，CI **不得**依赖本机 evidence 目录 |
| 8a | **合成 poison — 不可解析 payload** | — | invalid JSON → 命中 `LegacyRowPoisonError('invalid_payload_json')` → quarantine + alert，后续行继续 |
| 8b | **合成 poison — routing 字段带孤立代理项** | — | valid JSON + routing field lone surrogate → 命中 `InboxWriteValidationError` → quarantine + alert，后续行继续 |
| 8c | **合成 shape 失败 → fallback（不是 poison）** | ~~「typed poison 或 fallback 均可」~~ ⚠️ R3 抓出：两可 = 三类不互斥 | valid JSON 但 envelope shape 不合法 → 按 §4.2 定稿走**可审计 raw-JSON fallback** → **无 marker、正常入列、最终 delivered**（**状态与 #7 相同**，不与 #8a/#8b 同类）。⚠️ #8a/#8b 的 quarantine alert 必须走 **direct alert sink，不得再进 `lead_inbox`** |
| 9 | **合成瞬时故障 fixture** | — | `SQLITE_BUSY`（fake / locked second connection）、probe I/O（注入 `probeLegacyDelivery`）、owner-fence（错误或过期 owner epoch）→ **本轮失败并重试、下次成功，绝不 quarantine** |

⚠️ **三类 fixture 的判据必须按「类型/状态」互斥，不能按 error message**：

| | quarantine marker | outbox | cutover 是否继续 | 本轮 run | 最终 |
|---|---|---|---|---|---|
| #7（真实毒行，content 可修） | **无** | 无 | 继续 | 成功 | 接收端 `delivered` + 一次稳定净化审计 |
| **#8c（shape 失败 → fallback）** | **无** | 无 | 继续 | 成功 | 接收端 `delivered` |
| #8a（invalid JSON）<br>#8b（routing 代理项） | **有** | `pending`→`queued` | 继续 | 成功 | outbox 独立推进到 `delivered`；**sink 断开时 cutover 仍不得 fleet-wedge**，outbox 保持 pending/dead-letter **可见**，恢复后拿到 receiver receipt |
| #9（瞬时故障） | **无** | 无 | — | **reject** | 下一轮**真实成功**（不是「发生过重试」） |

> ⚠️ 前置：在 `reconcileEnqueueConsumed()` 改成 discriminated result 之前，**owner-fence 与 deterministic conflict 无法互斥断言** —— 所以 §4.2 的 discriminated result 是验收 #9 的硬依赖。

| 10 | **normalized-source 护栏** | — | 三个入口的 INSERT、**内外层 expected**、审计 conflict compare **全部来自同一 normalized object**；且日志**无** `was reused with different content`、**无**被事务隐藏的 rollback |
| 10b | **「那道墙」端到端**（Lead 指令 `629464fc` 定稿） | ❌ ~~「Lead 回复繁忙 runner ⇒ 零 founder page」~~ —— Lead 已撤回，建立在被证伪的触发器机制上 | ✅ **通知能到 Lead + Lead 能 ack + ack 能让升级链停住**。这三段是本单真正要证明的那道墙；不要去证「不再产生 wake_failed」（那不归本单） |
| 10c | **存量零重播**（§1b 红线） | 「补扫跑完了」 | 部署后**存量 255 行零投递**；`founder_msg` 40 条**一条都不许被投出去**；补扫默认 dry-run 只出清单。<br>⚠️ **R2 HIGH-6：原稿这几条判据不可执行，且与来源 ①(b) 自相矛盾** —— 用了已改名的表 `lead_inbox_frozen_row`（现为 `lead_inbox_frozen_identity`），而且「冻结集内零行 `consumed_at IS NOT NULL`」会**在正确实现上立即失败**：来源 ①(b) 的 resend root 在安装时**本来就常常已 delivered/consumed**。<br>**定稿：按 enrollment class 分别写可复制 SQL，不用一条笼统 SQL 验全生命周期。**<br>　• **①(a) pending model**：冻结后**零 claim**；`delivered_at` / `consumed_at` **不从 NULL 推进**<br>　• **①(b) resend root**：**允许** baseline 已 delivered/consumed；只断言 root 的生命周期字段**相对安装快照无新增推进**，且**所有 post-epoch 后代零 claim / 零 delivered**<br>　　⚠️ **R3 HIGH-7：当前 schema 查不出这条。** identity 表里**没有** root 在安装时的 `delivered_at`/`consumed_at`/`processed_at`/`disposed_at`/`delivered_rounds`/`next_unprocessed_at` baseline ⇒「相对安装快照无新增推进」**无从比较**。<br>　　**定稿**：在 identity 表或**独立的 install snapshot 表**里持久化这些 baseline 字段（或一个 canonical lifecycle digest），验收才写得出 SQL。<br>　　⚠️ **另一条**：最终看到 `claimed_by IS NULL` **不能证明它从未被 claim**（claim 会被清空）。「从未 claim」必须由 **DB trigger fixture + claim seam 测试**证明，**不能由最终行状态冒充历史**（除非另加 durable claim audit）。<br>　• **②/③/④（可能尚未物化）**：用 **LEFT JOIN** 允许 `inbox_seq IS NULL`；一旦物化必须回填**同一** `inbox_id`/`inbox_seq` 且**零 claim / 零 delivered**<br>　• **count 断言分三层**：immutable `install_identity_count` / 预期的 pre-floor legacy 数 / **会合法增长**的 `delayed_enrolled_count` —— **绝不把会增长的计数当恒定快照**<br>　• `source='founder_reply'` 的冻结行 `delivered_at` **全部仍为 NULL**；<br>④ **class 配对对照组**（⚠️ R1 HIGH-5：笼统的「有新行投出去了」不够）——对**同一个 Lead**，下列每一对都要各验一遍：<br>　• pre-epoch `founder_reply` **冻** / post-epoch `founder_reply` **通**<br>　• pre-epoch `question` **冻** / post-epoch `question` **通**<br>　• pre-epoch `lead_event` **冻** / post-epoch `lead_event` **通**<br>　• 冻结 root 派生的 resend child **冻**（含全部 `resend_of` 后代）<br>每条都查 claim membership、`consumed_at`、`disposition`、接收端 receipt。<br>**这样才能同时排除三种假绿**：「整类封死」（实现错误地永久屏蔽所有 `founder_reply`）、「late materialization 漏冻」、「resend 漏冻」<br>⚠️ **R3 HIGH-7 未闭合项**：以上仍是自然语言 bullets，**没有一条真 SQL**。**交付要求：提交真实的验收脚本 / SQL 文件**（按 ①(a)/①(b)/②/③/④ 分组、对未物化身份用 LEFT JOIN、展开全部 resend 后代、保留同 Lead 同 class pre/post 对照），并依赖上面那张 install baseline 表。**这一项在实施阶段完成，本设计文档只锁定它的形状与依赖。** |
| 6b | **`loop_heartbeat` 复活**（FLY-1586 验收 #6） | 「tick 不报错了」 | 生产 Lead 的 `last_success_at` **重新开始推进**；判据用 `last_started_at - last_success_at <= 阈值`（不要求字面追上）。一句 SQL 可验。<br>⚠️ **目标集合必须从生效的生产配置动态导出，禁止写死数字**：issue 正文写「14 个 Lead / 7 个项目」，本计划 §11 复核后写「16 个 Lead / 6 个项目」——**两者矛盾**，写死任一个都会放过若干仍在 wedge 的 Lead。<br>并入 §1b.9 的四条观测断言：① heartbeat 推进；② 旧 stall episode 能关闭；③ 冻结计数仍可见；④ 真正的新 overdue 仍能开新 episode |

> ⚠️ **10c 必须带对照组（④），否则它是一条无效验收。** 「存量零投递」在**整条投递路彻底死掉**时也成立 —— 那正是修复前的状态。
> 只有同时证明「**新增投出去了**」+「**存量一条没投**」，才证明冻结在工作而不是 wedge 还在。
> 这是 [feedback_healthy_control_group_rules_out_by_design] 那一类：**报「卡住」必带正常结算的对照组**。
| 11 | **reverse-compat 护栏** | — | well-formed 输入的**整行**持久化结果与改动前**逐字段相同**，且**不产生** sanitation audit |

> ⚠️ #10 / #11 是 #7 E2E 的**内部不变量护栏，不能被「最终收到了」替代** —— 否则实现可能靠改别的字段或绕过 comparator 偶然通过。（R2 提过，我在 R3 重写 §8 时误删，R3 复审抓回。）

⚠️ **验收脚本的额外约束**：`lead_inbox` 里查不到某行 **≠** 那行没被写过。本次毒行就是「写了又被事务回滚」，唯一证据在 Bridge 日志。**只查表不查日志的验收会漏掉这一整类失败。**

---

## 9. 顺序与发布（⚠️ 四项不是互相独立的）

R1 修正：原计划称「4 项互相独立、可分别验收」**不准确**，会导致不安全的局部发布。

| 单独发布 | 后果 |
|----------|------|
| 只发 C | **不修复已存毒行**，Bridge 一重启还是死 |
| 只发 B | 以**隔离真实通知**换 fleet 恢复，必须配 replay / 人工处置 |
| 只发 A | 修得了本次正文毒行，但**下一类确定性坏行照样拖死** |
| **只发 A+B+C、不发 F** | ⚠️ **最危险的组合**：毒行被隔离、tick 恢复、**255 行存量同时开闸** —— 包括那 40 条 `founder_msg`。等于亲手引爆 §1b 描述的重播。**禁止**。 |
| **只发 F** | 无害但无效：tick 仍卡在毒行上，什么都不会投 |

**实施与测试顺序**：A（统一规范化）→ 在其上做 B（严格分类 + durable）→ 补 C → **F 与 B 同一个受控单元**（F 的闸必须在 B 让 tick 恢复之前就位，见 §1b.6）。

**部署**：取证完成后，**A+B+C+F 作为一个受控的 Bridge 重启单元**一起上。**不允许把 F 拆出去后补**（§1b 红线 #4）。

PR 需附一张 **A/B/C/F 单独发布与回滚矩阵**，写明任何临时组合下的消息损失与恢复步骤，并逐字写明「A+B+C 不带 F」是禁止组合。

### 部署纪律

1. 全仓 `pnpm lint` + `pnpm -r build` + 相关包测试
2. Codex code review（`codex:rescue`；触及消息投递权威路径 → xhigh）
3. 独立 QA 真机 E2E（验收 #1–#11，含 8a/8b/8c）；**QA 由独立 agent 把关，不由实现者自报**
4. ⚠️ **发布前硬门（R2 LOW-11）**：D 与承接单 B **必须已经是真实的 Linear issue**，带 owner / priority / 验收标准，并在本 PR 里链接。
   > 「拆 scope」如果只留下文档段落而没有交付 authority，就会退化成**又一个没人负责的遗留** —— 本次事故本身（守卫开火 16 次、60+ 小时无人知晓）就是这种退化的产物。
5. 重启 Bridge 前：§1 取证必须已留档
   - ⚠️ launchd `KeepAlive` 会自动重起 —— 改配置要在 kill **之前**
   - ⚠️ 停 Bridge 用按 port + run-bridge 进程树的**精准杀**（FLY-239），不要裸 pattern sweep（会误杀 QA slot 的 bridge）
6. 部署后由**独立 QA** 复验：`loop_heartbeat` 全部恢复、积压清空、新 question 端到端通、**告警 out-of-band 真的送到人**

---

## 10. 不做什么（issue 明确划界）

- ❌ 不重写消息层架构（FLY-1569 总纲下那 7 个单）
- ❌ 不改 `lead_inbox` schema —— ⚠️ 这条约束指的是**不改 `lead_inbox` 这张表的列**。F 的冻结集与 A 的净化审计都是 CommDB 里**新增的独立表**，不动 `lead_inbox` 一个字段（见 §1b.4 / §3.4）
- ❌ 不加 feature flag —— ⚠️ 因此 F **不是**一个开关：它靠「冻结集为空 ⇒ 零行为变化」做到字节兼容（见 §1b.7），而不是靠 env 旁路
- ❌ 不「顺手优化」admission 逻辑
- ❌ 不改 `admit()` 在 tick 中的位置
- ❌ **不为一个 P0 把全仓 `lib` 抬到 ES2024**（见 §3.3）
- ❌ **不做存量分流、不解冻**（承接单 B）
- ❌ **不手工删改 `lead_events` seq 56649**（§1b 红线 #9）——隔离必须做在代码里；一次性运维解封是独立动作、要 founder 点头，不进这个 PR
- ❌ **不做 D（告警投递闭环）**——移出本单，见 §12.4

---

## 11. R1 复核记录（未照单全收）

Codex R1 的每一条 BLOCKER/HIGH 都由本 runner 独立查证后才写进本版：

| R1 条目 | 复核结论 | 证据 |
|---------|----------|------|
| #1 W2 已存在且已开火 | ✅ 成立 | seq 57003–57018 共 16 条；`stall_episode_at` 16/16；`alert_claims` 16/16。⚠️ **R3 更正**：07-20 的 seq 32096/32097 只能称为 **audit-mirror delivered 的正对照**，**不是 alert receipt 正对照**（`delivered_at` 不是 Discord 收据） |
| #1 「16 个 Lead 不是 14」 | ✅ 我写错了 | 5+3+3+1+3+1=16，test-slot-* 的 6 个 `stalled=0` 不算生产 |
| #2 `reconcileEnqueueConsumed` / `enqueueHubRoot` 旁路 | ✅ 成立 | `lead-inbox-queue.ts:656` / `:1579` 确认存在 |
| #3 `toWellFormed()` 编译不过 | ✅ 成立 | `tsconfig.base.json` `target`/`lib` 均为 ES2022 |
| #4 裸 per-row catch 危险 + `onProtocolQuarantine` 不可复用 | ✅ 成立 | `lead-inbox-runtime.ts:115-127` 确为终态化之后的 advisory |
| #5 A 与验收 #7 自相矛盾 | ✅ 成立，是我的错 | seq 56649 的孤立代理项在 `content` 里，按 A 应净化交付而非隔离 |
| #6 C 漏 commdb runtime / 共享 renderer / `2_000` | ✅ 成立 | 已并入 §5 |
| #7 runbook 不可执行 | ✅ 成立 | 已改为仓内脚本 + 绝对路径 + 动态目标集合 |
| #8 验收可在接收方不存在时通过 | ✅ 成立 | 已重写 §8 |
| #9 「4 项互相独立」不准确 | ✅ 成立 | 已改为 A→B→C 单一重启单元 + 回滚矩阵 |

---

## 11b. R2 复核记录

Codex R2 的每条 BLOCKER/HIGH 同样经本 runner 独立查证：

| R2 条目 | 复核结论 | 证据 |
|---------|----------|------|
| #1 §0.3 因果模型错了，`LeadAlertNotifier` 已是 out-of-band | ✅ **成立，我错了** | `LeadAlertNotifier.ts` Step 3 `tryClaimLeadEvent` 只是 claim，Step 5 直接 POST Discord；`delivered_at` 只由 `markLeadEventDelivered` 写 |
| — （本 runner 追加发现，比 R2 更进一步） | `alert_deliveries` **只由 `scripts/lead-alert.sh` 写**，TS notifier 不写 → **拿它查 TS 告警同样是假阴性仪器**；TS 通道发送结果**无任何持久化** | `grep -rn alert_deliveries` 仅命中 `scripts/lead-alert.sh`；`alert_claims` 16/16 齐全 |
| #2 `skipped:'duplicate'` 无法区分四种前态 | ✅ 成立 | `LeadAlertNotifier.ts:794-848` claim 在 POST 之前 |
| #3 两类确定性坏行仍会掉进「继续抛」 | ✅ 成立 | renderer `TypeError`；`reconcileEnqueueConsumed` boolean 混义 |
| #4 quarantine/审计只写了「必须明确」 | ✅ 成立，是我偷懒 | 已在 §3.4 / §4.3 选定具体表与状态机 |
| #5 字段全集不完整 | ✅ 成立 | `routingState` / `disposition` 等已补 |
| #6 fixture 7/8/9 需 discriminated API 才可判定 | ✅ 成立 | 已拆 8a/8b/8c 并改为按类型/状态互斥 |
| #7 `tail.slice(-N)` 漏网 + helper 合同未定 | ✅ 成立 | `hook-payload.ts:253-257`；已选定「C 只做安全截断，repair 留给 A」 |

**两轮下来我自己写错的地方**：Lead 数（14→16）、A 与验收 #7 自相矛盾、以及 §0.3 用 `delivered_at` 当投递证据（连错两次，第二次是用 `alert_deliveries` 查不到当失败证据）。**共同模式都是拿一张不是为这个问题设计的表去回答这个问题** —— 与 issue 里已经点名的 `read_at` 陷阱同一类。

---

## 12. 遗留（建议另开单，不在本单）

1. **`ensureCutover` 的重试语义是一类通病** —— 任何 boot-time 一次性迁移都该区分「可重试」与「这行永远不可能成功」。本单只就地修了这一处。
2. **「告警发出去了没有」缺少持久化收据，是一类系统性缺陷** —— TS 侧 `LeadAlertNotifier` 的 outcome 不落库（`alert_deliveries` 只由 `scripts/lead-alert.sh` 写），导致事后**根本无法复盘**。值得排查还有多少告警通道处于同样状态。
   > ⚠️ 二稿曾把本条写成「告警走被监控的那条通路」，**该结论已被 R2/R3 证据推翻**（notifier 直发 Discord，不经 `lead_inbox`），已更正。
3. **`slice(0,N)` 是全仓性卫生问题** —— 建议加 lint 规则，禁止对不可信文本裸用 `slice(0,N)`。

4. **D — 修 `InboxLoopHealthChecker` 的投递闭环（durable alert outcome + receiver receipt）**：本单**不做**（§0.0）。FLY-1579 原稿的 §7 / §7.1 / §7.2 设计**完整保留在本文**，follow-up 单可以直接照用（已过 Codex R3/R4 收敛）。
   > **为什么值得单独一个单**：本次守卫**检测是好的**——`InboxLoopHealthChecker` 在通路死后 11 分钟准确开火 16 次（`lead_events` seq 57003–57018，`stall_episode_at` 16/16，`alert_claims` 16/16 齐全）。缺的是**发送结果没有任何持久化**（TS 侧 `LeadAlertNotifier` 不写 `alert_deliveries`，那张表只由 `scripts/lead-alert.sh` 写）⇒ **60+ 小时后没有人能回答「当时到底有没有人看见」**。
   > 这正是编号 742 那一类（守卫开火、17 天无人知晓）的复发。

5. **承接单 B — 255 行存量的证据驱动分流 + 解冻**：本单把存量结构性地挡在投递管道之外并**导出成清单**（§1b.8）。承接单负责逐条按证据决定投或不投，并实现解冻（CAS 清冻结集 + 审计）。
   > 硬约束继承：`founder_msg` **禁止自动重投**（§1b 红线 #6）；不变量检查器**是尺子不是执行器**（#7）；补扫**默认 dry-run**（#5）。
   > **不用赶工**：Lead 已逐类核过，伤害面 `founder_msg` **+2/小时且有界（~40 条）、基本静止**；噪音面 +56/小时全是纯遥测 `lead_event`（零 gate、零 question，重放只是吵）。

---

## 13. Codex design review — 最终状态

**APPROVED（5 轮）** · thread `019fbaee-485c-76e3-a24c-72e2c0724b23`

> ⚠️ **APPROVED 之后计划又有实质变更，这部分未经 Codex 复审：**
> - **§1b 存量重播红线**（Lead 指令 `9f7c2f70` / `761c8bc6`）—— 这是一个**全新的设计面**，而且它改变了部署顺序（分流必须先于或同时于隔离生效）
> - §0.1b 影响面改写（Lead 指令 `629464fc` 撤回原触发器结论）
> - 验收新增 10b / 10c
> - 停摆时长 36h → **60+h**、断点距回滚 34h → **58h**（两处都是我的算错，Lead 已把 36h 传给 founder 并已更正 issue）
>
> ⇒ **实施前建议对 §1b 单独走一次 design review** —— 它引入了新的原子性/顺序约束，与已 APPROVED 的 A/B/C 有耦合。

### FLY-1586 的补充 design review — 进行中

上面这条建议是 FLY-1579 的 runner 自己标出来的，**判断正确**。FLY-1586 按它执行：

1. §1b 从「九条红线 + 拆单建议」补写成**实现级设计**（§1b.0 / §1b.4 – §1b.11 全部为本单新增）
2. 补写过程中独立复核代码，**推翻了继承文档里的两处措辞**（§1b.0）
3. 新设计面单独过 Codex design review —— **状态见 §13b，尚未 APPROVED**

> ⚠️ 本单的 review 只针对**新增面**（§1b 与 scope 适配）。A/B/C 的 5 轮 APPROVED **不重跑** —— 那些结论未被本单改动，重跑是空转。

## 13b. FLY-1586 新增面 design review 状态

| 轮次 | 结论 | 报告 |
|---|---|---|
| R1 | **CHANGES REQUESTED** — 2 BLOCKER / 3 HIGH / 3 MEDIUM / 1 LOW | `/tmp/codex-rescue-design-feedback-flywheel-FLY-1586-plan-round1.md` |
| R2 | **CHANGES REQUESTED** — 2 BLOCKER / 4 HIGH / 3 MEDIUM / 2 LOW（R1 状态：3 RESOLVED / 6 PARTIAL / 1 NOT RESOLVED） | `/tmp/codex-rescue-design-feedback-flywheel-FLY-1586-plan-round2.md` |
| R3 | **CHANGES REQUESTED** — 3 BLOCKER / 4 HIGH / 1 MEDIUM / 1 LOW（R2 状态：4 RESOLVED / 5 PARTIAL / 1 NOT RESOLVED） | `/tmp/codex-rescue-design-feedback-flywheel-FLY-1586-plan-round3.md` |

**R3 抓到的真缺陷（复核记录见 §1b.15）**：

- **BLOCKER-1**：**切换期 in-flight handoff**（旁路 G）—— 旧进程可能已经把 stock batch 交给外部 adapter；冻结谓词与 DB trigger 只能挡未来的 claim，**撤不回已发生的 handoff**。⇒ rollout quiescence 必须是安装前硬门。
- **BLOCKER-2**：`listUndeliveredLeadEvents()` 是**全局、LIMIT 10000、无 seq 下界、无 project 过滤**，撑不起「完整快照」。
- **BLOCKER-3**：我引 `db.ts:4381-4383` 当 snowflake **上界**先例 —— 它明说是 **lower bound**，且唯一 helper 还减 1ms。改用 per-thread Discord watermark + BigInt。
- **HIGH-4**（最讽刺的一条）：急切登记若走现有 envelope 路径会 `JSON.parse(payload)` ⇒ **安装器自己先被毒行干掉，A/B 根本没机会跑**。
- **HIGH-5**：`protocol_alert` 把 `error.message` 原样拼进 model 内容，而 `JSON.parse('ship FLY-1569')` 的错误逐字含 `"ship FLY-1569"` ⇒ **旧 malformed 行能把 ship 指令投给 Lead**，直接打穿本单核心目的。

**⚠️ 尚未完全闭合的一项**：R3 HIGH-7（#10c 的真 SQL + install lifecycle baseline 表）。本文档已锁定它的**形状与依赖**，真 SQL 属于实施阶段交付物。**这一项本轮没有关掉，不粉饰。**

**R2 抓到的真缺陷（复核记录见 §1b.14，三条是用真实 SQLite 最小复现跑出来的）**：

- **BLOCKER-1**：激活谓词把**全新库**判成 wedged —— `recordTickStarted()` 在 `ensureCutover` **之前**只写 `last_started_at`，所以全新库首 tick 的 `last_success_at` 必然是 NULL，原谓词必然命中（复现 `fresh_db_wedged=1`）。且 `inert` 不是封闭状态：延迟登记没判 activation，inert 库会长出冻结身份。
- **BLOCKER-2**：insert-or-verify 拿**会变的值**（floors / activation / counts）做恒等断言 ⇒ **正常重启会自撞成永久 wedge**。
- **HIGH-4 / HIGH-5**：又找出**第五、第六条旁路** —— founder ingress 从 Discord 首次拉进 epoch 前的消息；旧 protocol 行终态失败派生 `protocol_alert:*` **model** 行。

**R1 抓到的真缺陷（全部经本 runner 独立复核后采纳，复核记录见 §1b.13 / §1b.14）**：

- **BLOCKER-1 第四旁路**：epoch 在 reconciler **之前**安装，但冻结集只枚举了**当时已物化的 `lead_inbox` 行**。旧 `lead_events`（`seq <= floor`）与「源 question 已存在但尚无 inbox 行」的那些，都会在 epoch **之后**首次物化、拿到**新 seq**、冻结集里没有对应行 ⇒ **照常投出去**。我在 §1b.4 定义了 `legacy_event_seq_floor` 却**从来没写它的消费规则** —— 设计里有个洞。
- **BLOCKER-2 旁路 A 的前提不成立**：resend 候选 root 是 `delivered_at IS NOT NULL`（`db.ts:4748`），而我把安装定义写成「冻结所有**未消费**行」⇒ 这类 root 根本进不了冻结集，子行的 `resend_of` 找不到父 ⇒ 继承落空。F5 用例与安装定义**自相矛盾**。

> ⚠️ 我在 R1 跑之前就把本节预写成「✅ 已执行 / 见 §13b」并挂了一个 **`APPROVED`** —— 而当时 review 还没跑、§13b 还不存在。
> 这正是 [feedback_label_substituting_for_fact] 那一类：**拿「流程标签」冒充「已发生的事实」**。R1 的 LOW-9 把它抓了出来，已改成上面这张真实状态表。

收敛轨迹：R1 5B+4H → R2 4B+3H → R3 3B+3H → R4 2B+2H → **R5 0 blocker**。每轮都在抓真缺陷，不是空转。

评审结果落盘：`.flywheel/runs/0534b206-322d-4b70-a038-b6ca9d564bf5/codex/design-review.json`

### R5 遗留的 implementation notes（实施阶段必须处理）

1. **校正 crash fixture 的时序描述。** 计划 §7.2 已选定“episode row/file durable 在前，mirror latch 在后”，因此“latch commit 后、episode row/file 创建前”在新实现中应当不可达。测试应拆为：
   - 新路径：在 episode row/file 已持久化、`stall_episode_at` mirror 尚未写入时终止，重启后复用同一 active episode、补建 mirror、完成 POST 与 receipt；
   - 旧状态兼容：预置历史遗留的 orphan `stall_episode_at`（无 episode），证明它仅是 observation/mirror，重启无需人工清理即可 materialize 新 episode。

2. **把 terminal fence 做成代码控制流，而非注释约定。** 当前 `LeadAlertNotifier.markEpisodeTerminal()` 捕获错误后返回 `void`，成功及 dead-letter 分支随后仍会 unlink/move（`packages/teamlead/src/LeadAlertNotifier.ts:1128`、`:1176`、`:1243`、`:1315`）。实现应让 terminal persistence 明确返回成功或抛错；只有包含 channel/message ID 的 terminal outcome durable 后才允许删除或移动 intent。对应 migration 需覆盖旧 episode 行缺少 receipt 字段的兼容读取。

3. **所有 lease-facing 聚合必须显式带 domain。** `counts()`、`activeCount()`、pending/list/reconcile 查询、diagnostics 与 readiness 都要过滤 lease domain；负对照需证明 pending/dead-lettered inbox-health episode 不改变现有 lease 健康结论。不要只在写入侧增加 `domain`，却保留全表聚合。

4. **queue-first health 路径不要再依赖 live `alert()` 的 `sent/queued/skipped:duplicate` 结果。** §7.1 中残留的这组表述应在实现 PR 中改为 materializer/drain 的 durable outcome；duplicate 必须回读并推进同一 episode，不能被当作交付进展。B 的 quarantine outbox drain 也应遵守相同原则，或使用持久化 attempt generation。

5. **additive legacy `messageId` 是 API 兼容，不是返回对象“逐字不变”。** 现有测试中存在对 `{ sent: true }` 的 exact equality sentinel；实施前应盘点调用者并更新兼容断言。Discord 响应 JSON 的 message ID 解析应 best-effort，缺失或畸形 JSON 不应把已成功的 HTTP POST 改判为发送失败。

6. **为 raw-JSON fallback 定死 durable audit contract。** 指定持久化位置、stable key、reason 与必要摘要，并让验收 8c 同时断言：无 quarantine marker、消息正常到达 receiving end、fallback audit 可查询。这样“选择不隔离 presentation-shape 异常”仍然可追溯。

7. **保留已约定的低层护栏。** sanitation digest 固定为 SHA-256 over UTF-16LE；三个 enqueue 入口的 exact comparator 覆盖各自全部持久化语义；新 drain 挂在独立于 `LeadInboxLoop` 的既有 lifecycle，并覆盖 boot pass、single-flight、timer cleanup 与 restart recovery；owner-fence/SQLITE_BUSY/probe fixture 必须证明本轮零 marker、下一轮真实成功。

8. **清理两处文案漂移。** §2 的“A — 孤立代理项进不了 `lead_inbox`”仍比 §3.2 的实际保证更宽，应收窄为 authoritative enqueue insert/verify value-drift 防线；验收表 #10/#11 应补齐明确表头。二者不影响已定设计。

## Verdict（⚠️ 这条属于 **FLY-1579**，不是本单）

**APPROVED — ready to implement** —— 这是 **FLY-1579 R5** 对 **§0–§12 主体（A/B/C）** 的结论，逐字保留作为历史记录。

> ⚠️ **它不覆盖 FLY-1586 的新增面。** 本单新增的 §0.0 / §1b.* / §2 / §8 / §9 / §10 / §12.4-12.5 / §13b 的真实评审状态**只看 §13b 那张表**。
> R2 的 LOW-10 抓的就是这里：文档末尾挂一个无条件 `APPROVED`，与 §13b「尚未 APPROVED」直接矛盾。已收窄。
