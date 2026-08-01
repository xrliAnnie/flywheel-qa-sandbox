# FLY-1586 拆出的两张 follow-up 单（待建，草案）

Issue: FLY-1586 (https://linear.app/geoforge3d/issue/FLY-1586/p0承接-1579-修复-lead-收件循环全舰队停摆-毒行隔离-截断修复-存量冻结只投新增)
日期: 2026-08-01
基于: plan.md §9 部署纪律第 4 条、§12.4、§12.5

---

## 为什么这份是草案而不是已建好的单

plan §9 第 4 条把「D 与承接单 B 必须已经是真实的 Linear issue，带 owner / priority /
验收标准，并在本 PR 里链接」列为**发布前硬门**。核过 Linear（FLY team，近 2 天 + 近 4 天两轮
查询）：**两张单都还不存在。**

我没有自己建，两个理由：

1. **在这套系统里建单是有副作用的动作。** 带 `code` / `backend` 标签的新 issue 会被 CoS
   自动 triage、可能真的派出一个 Runner。派不派、派给谁，是 Lead 的资源决定，不是我的。
2. **门要的是「带 owner」。** 我建一张没有 owner 的单并不能关掉这道门，只会多一条记录。

所以这份写到「可以直接复制建单」的程度，owner / priority 由 Tadashi 定。

> ⚠️ 这道门存在的理由本身就值得写下来：
> **「拆 scope」如果只留下文档段落而没有交付 authority，就会退化成又一个没人负责的遗留。**
> 本次事故本身——守卫开火 16 次、70+ 小时无人知晓——就是这种退化的产物。

---

## 单 1 — 承接单 B：255 行存量的证据驱动分流 + 解冻

**建议标题**：`[承接 1586] Lead 收件箱存量分流与解冻 — 逐条按证据决定投或不投`

**为什么需要它**：FLY-1586 把存量**结构性地**挡在投递管道之外（seq 水位线冻结），
代价是**本单没有解冻能力**。被冻住的合法消息要一直等到这张单，不是短暂 backpressure。

**范围**
- 读 FLY-1586 导出的冻结清单（`listFrozenStock()`，plan §1b.8）
- 逐条按证据判定：这条指令是否**已经被执行过**
- 实现解冻：per-row CAS 写 `unfrozen_at` + `unfreeze_evidence`（列已建，本单只留桩）
- FLY-1579 §6 点名的「可救 4 条 + tidal-echo 3 条」属于存量，归这张单

**已经就位的硬护栏（不要拆）**
- 解冻 API 对 `source='founder_reply'` **无条件拒绝**，必须走带 founder 证据的独立路径（配了负向测试）
- FLY-1586 只提供 dry-run，**不提供** `--apply` / `--deliver`；真投递的 flag 属于这张单

**验收标准**
1. 冻结清单可完整导出，条数与 `lead_inbox_freeze_install` 水位线一致
2. 每条解冻都留下 `unfreeze_evidence`，且**幂等**（重跑不重复投递）
3. `founder_reply` 走独立路径，负向测试证明普通解冻路径拒绝它
4. 变异判据：把证据校验去掉 → 必须有测试变红，且红的是「重播了一条已执行指令」而不是别的

**已知边界（FLY-1586 诚实交出来的）**
冻结**不覆盖**「已投递但未处理」的 resend root（它们 `delivered_at IS NOT NULL`，
按定义不是被扣住的存量）。这类行若开着 receipt foundation 仍可能派生提醒子行。
**那是提醒，不是新指令**，风险形状远低于 founder 重播——但要在这张单里处理。

---

## 单 2 — D：隔离告警的投递闭环（把「没人被 ping」补成「有人真收到」）

**建议标题**：`[承接 1586] 隔离告警接上真实投递 — pending_alert 不能停在表里没人看`

**为什么需要它**：FLY-1586 做了隔离告警的**状态机 + drain + dead-letter**，但
`quarantineAlertSink` 在生产上**只接了一个会抛异常的占位**——设计上刻意不做成 no-op，
因为 no-op 会把告警标记成已接受然后丢掉。

现状诚实说：告警会以 `pending_alert` **durable 停在表里**，可查、可重试、不丢，
**但没有人会被 ping。** 这比之前好（之前 state 只是个死标签），**但它不是「运维会收到通知」。**

**范围**
- 把 sink 接到 `LeadAlertNotifier` 那条 direct Discord 路
- 复用 FLY-1586 已加的 `legacy_row_quarantined` 告警类型
  （`{owner:"founder_direct", arc:"none_escalate"}`，已进 `ticket-owner-map` 的 `founder_direct` 集合）

**两条不能破的约束（FLY-1586 设计评审 R3 定的，不要重新讨论）**
1. **告警绝不走 `lead_inbox`。** 一条「收件箱堵了」的告警如果经收件箱投递，
   就卡在它正在报告的那个东西里面。**这个循环正是原事故 70+ 小时无人知晓的原因。**
2. **sink 故障绝不让 `ensureCutover` 失败。** 把 boot admission 押在 Discord 可用性上，
   只是把全舰队 wedge 换个触发器。结清该行的是 **marker**，不是 alert。

**验收标准**
1. 真机 E2E：注入一条会被隔离的行 → **Discord 上真的出现告警**（不是「表里有 pending 行」）
2. Discord 挂掉时：`ensureCutover` 仍然成功，告警留在 pending 可重试
3. 到重试上限转 `dead_lettered`，且**仍可查**（可见且红，不是被抹掉）
4. 变异判据：把 sink 换成 no-op → 必须有测试变红。
   （这条是重点：no-op 会让告警"成功"消失，而这恰恰是最难发现的失败形态）

---

## 建单时要填的（我不能替 Tadashi 决定的）

| 字段 | 单 1（承接 B） | 单 2（D） |
|------|--------------|----------|
| owner | **待定** | **待定** |
| priority | 建议 High——存量里有合法消息在等 | 建议 High——告警不通=下次故障还是没人知道 |
| project | Flywheel | Flywheel |
| team | FLY | FLY |

建好后把两个 issue 链接补进 PR #744，这道发布前硬门才算关上。
