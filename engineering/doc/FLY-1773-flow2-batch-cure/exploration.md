# FLY-1773 Flow 2(Batch 通道)三件治病 — 探索

Issue: FLY-1773 (https://linear.app/geoforge3d/issue/FLY-1773/机制-flow-2batch-通道治病三件真送达才盖章-未读不占位-读者可判活-两条规则终稿的主刀单)
日期: 2026-08-14
基于: 无

## 0. 背景与两条规则终稿

8-14 讨论定稿(founder 拍板):全系统消息收敛为两条通道 ——

- **收件人是 Lead → 一律 Flow 2(Batch)**:攒 10 条 / 30s(FLY-1751 定稿)+ 租约 + 整批签收
- **收件人是 Runner → 一律 Flow 1(即时直投 + 唤醒)**

本单只治 Flow 2 的三个病,病根即 8-13 founder 消息堵死事故(FLY-1751 定性)。Flow 1 本单不动。

## 1. 病理(代码审计结论,均有精确位点)

### 病 1:传输 notify 写出即盖 `delivered_at`(两处同病)

「delivered」在全系统被消费为「收件人已收到」,但它的写点是**传输面**:

- **Flow 2 批路径**:`packages/flywheel-comm/src/mailbox-queue.ts:1239`
  `recordBatchDelivered` 在 transport adapter 返回 receipt(= 文本写进了 Lead 的 pane / SendMessage 返回 ok)后就落 `delivered_at`。Lead 模型是否真读入,无从得知。
- **FLY-109 push 路径**:`packages/inbox-mcp/src/delivery.ts:49-50` → `db.ts:3581-3589`
  `notify()`(一条 MCP notification)成功即调 `markInstructionDelivered`,现实现把行置 `LEASED + claim_expires_at=now`;而 `mailbox_message_projection` 的 `delivered_at` 是派生列(`mailbox-schema.ts:145-148`:LEASED→claim_expires_at / ACKED→acked_at),于是 notify 一成功 projection 的 delivered_at 立即非空 —— 行为上等价于旧「notify 即盖章」。

**后果**:凡读 delivered_at 的地方(占位计数、审计、巡检)都把「传输成功」误当「送达」。这正是 8-13 事故里「系统认为都送到了、founder 实际什么都没看到」的语义根源。

### 病 2:未读的批占 in-flight 位 → 占满即停投(堵死机理)

`packages/flywheel-comm/src/mailbox-queue.ts:1058-1068`(`claimQueueBatch` 的 lead 分支):

```sql
SELECT COUNT(DISTINCT batch_id) FROM mailbox
 WHERE to_agent=? AND recipient_kind='lead' AND carrier='inbox'
   AND state='LEASED' AND delivered_at IS NOT NULL
   AND claim_expires_at > ? AND batch_id IS NOT NULL
-- count >= inflightMaxBatches (默认 3) → return [] → 本 tick 一条不投
```

叠加病 1(delivered_at = 传输成功即盖)与 `ackLeaseMs` 默认 30 分钟(`mailbox-queue-config.ts:16`),机理为:

1. Lead 忙 / 没 ack → 3 批「已传输未签收」各占位 30 分钟
2. in-flight = 3 → claim 直接返回空 → **founder 新消息 QUEUED 里躺着,轮不到投**
3. 30 分钟 lease 过期 → reconcile 重投 → 又占位……循环;`leaseRetryMax=3` 用尽后整批 DEAD
4. 投递 header 明写「once 3 batches are unacked, no further batch will be delivered」(`lead-inbox-loop.ts:433`)—— 把「传输背压」和「收件人已读」两个概念焊死在一起,堵死是**设计使然**

优先级救不了:founder Discord 消息 priority=1(`discord-chat-ingest.ts:107,123`),但 cap 检查发生在任何 claim 之前,直接短路。

### 病 3:Lead 批的判活面缺失 —— 对着死人重投 N 次

`packages/flywheel-comm/src/mailbox-queue.ts:1477-1481`(`reconcileExpiredLeases` 过期批处理):

```ts
const recipientState =
    input.recipientKind === "runner"
        ? input.recipientState(batch.to_agent)
        : "alive";          // ← Lead 批被硬编码为「活着」
```

判活回调**只对 runner 生效**;Lead 侧调用方(`lead-inbox-loop.ts:247`)也只传 `() => "alive"`,且 `maxTerminalRows: 0`(QUEUED 终态扫描对 Lead 关闭)。收件人死了/换代了,Bridge 只会按「活人没 ack」处理:重投 3 次 → DEAD。

已有的换代语义:`recipient_reborn`(`mailbox-queue.ts:298-326`,`adoptInflightForRecipientOnConnection`)—— 但它只由**收件人自己**出生时触发(launcher / FLY-1751 的 SessionStart hook 跑 `flywheel-comm adopt-inflight`)。Bridge 侧(投递方)全程无判活能力。

## 2. 三件的设计选项与取舍

### 病 1:真送达才盖章

| 选项 | 内容 | 取舍 |
|------|------|------|
| **A(选定)** | mailbox 新增真列 `notified_at`(传输证据);`delivered_at` 只在收件人 ack(整批签收 / instruction ack)时落 | 传输证据与送达证据分离,单一真相;reconcile 里「从未传输过→冻结重发」的判断(现读 `delivered_at IS NULL`,`mailbox-queue.ts:1511`)有诚实的新家 |
| B | 不加列,占位/审计读点直接改读 `acked_at` | 不成立:`frozenResend` 需要「传输从未成功」信号来区分冻结重发 vs lease 重试,删掉传输时间戳这个区分就没了 |
| C | 沿用 push 路径现状的编码术(state+claim_expires_at 派生) | 拒绝:魔法编码,传输态和 ack lease 语义纠缠,已经在 push 路径造成「注释说 delivered_at、实现是 LEASED」的漂移 |

**「真实接收」的操作定义**:收件人可归因的读证据 = ack(Flow 2 批:`flywheel_inbox_ack_batch` / codex `ack_batch` → `ackBatchByRecipient`;push instruction:`flywheel_inbox_ack` → `ackInstructionRead`)。Flow 2 是推送通道,Lead 没有独立的「读了但没签收」信号 —— ack 就是读证据,所以 `delivered_at` 与 `acked_at` 同刻落(语义上 delivered ⇔ 收件人确认读入)。

### 病 2:未读不占位

| 选项 | 内容 | 取舍 |
|------|------|------|
| **A(选定)** | in-flight 计数条件从「`delivered_at IS NOT NULL`(已传输未签收)」改为「`notified_at IS NULL`(传输从未成功、还在重试)」—— cap 退化为**纯传输背压** | 忙只影响何时读,永不堵死能否投(founder 拍板语义);transport 坏死时仍有背压,不会无限开新批灌 pane |
| B | cap 保留,founder / 高优先级 bypass | 拒绝:founder 拍的是「按收件人定 flow,零例外」;bypass 是例外规则,且其他消息照堵 |
| C | 完全删 cap | 拒绝:transport 不可用时每 tick 开新批,重试流量无界、FIFO 保序被破坏 |

**修后的流控靠什么**:每 tick 至多 claim 一批、每批 ≤10 条 / 30s 并箱横界 / 4MB;未 ack 批的重投由 ack lease(30 分钟)+ `leaseRetryMax` 节流。这里的 30s 是成员选择窗口,**不是投递限速器**:活跃 Lead 最坏可每个 1s tick 收一个新批。该上界比旧文档估计更高,但本单接受「有界小批持续投递 + 死信闸」,因为 founder 已裁定未读不得重新成为投递阻塞条件。
**连带修正**:投递 header 的「once 3 batches are unacked, no further batch will be delivered」文案必须换(该行为不复存在,留着就是骗模型);`countDeliverable`(nudge/活跃判断)语义核对。

### 病 3:读者可判活

| 选项 | 内容 | 取舍 |
|------|------|------|
| **A(选定)** | reconcile 的 lead 分支接**真实判活回调**,两级:① registry 层 —— Lead 不在配置(projects.json 投影)里 = `terminal_or_missing` → DEAD(`recipient_terminal`)+ 死信;② 进程层 —— v2 lease store 的 pid+start tuple 探针(`lead-lease.ts:307/325` 已有 `processAliveWithStart` / `processTupleStateWithStart`)dead / sensor_error → 按 `unknown` 语义 hold(跳过,不重投、不涨 retry,批留在过期 LEASED 下轮再看) | 复用两个已有判活源,零新状态、零新表;「dead」不等于 terminal —— v2 载体下 launchd KeepAlive 秒级拉回,dead 是暂态,重投给死 pane 只会白烧 lease_retry(这正是「对着死人重投 N 次」的病) |
| B | mailbox 行记 generation,Bridge 检测换代主动 requeue | 拒绝:与 FLY-1708/1751 的 adopt-inflight(SessionStart hook,收件人出生自报)形成双权威;加列加机制,违反「修结构别加报警器」 |

**换代(reborn)责任分工不变**:收件人新代出生 → adopt-inflight 把 in-flight 批 requeue(`recipient_reborn`)—— 既有机制;Bridge 侧只补「判活 → 不对死人重投」,不做第二套换代检测。复活路径:Lead 回来 → 判活恢复 alive → 过期批照常 lease-retry 重投;或新代 adopt 直接 requeue,两条路都收敛。

## 3. Flow 1 边界(零回归红线)

`claimQueueBatch` / `recordBatchDelivered` / `reconcileExpiredLeases` 是 lead/runner 共享函数:

- runner 的 in-flight 子查询(`mailbox-queue.ts:1078-1084`)保持 `delivered_at` 条件**字节不动**
- `recordBatchDelivered` 对 runner 行保持照旧写 `delivered_at`(同时写 `notified_at`,两者同刻,旧读点零变化);lead 行只写 `notified_at`
- reconcile 的 `frozenResend` 判断统一改读 `notified_at` —— 对 runner 行为等价(runner 行两列同刻)
- runner 判活 / 死信 / adopt 路径不碰

## 4. 验收形态(可证伪,来自 issue)

1. **复刻 8-13 事故**:3 批在途未读(LEASED + notified,未 ack)+ founder 新消息 enqueue → 断言下一 tick 新消息照常成批投出,不被 cap 拦截
2. **真送达语义**:notify/transport receipt 成功但收件人未 ack → `delivered_at` 不落(仅 `notified_at`);ack 后 `delivered_at` 落
3. **判活**:收件人 terminal(registry 无此 Lead)→ 批 DEAD(`recipient_terminal`)+ 死信,零重投;收件人进程 dead(registry 有)→ hold,复活后恢复投递
4. **阴性对照**:正常收发/整批签收/死信闸(`lease_expired_unacked` / `recipient_terminal`)/幂等(duplicate ack、ack_late_noop)/Flow 1 runner 全路径 —— 零回归
