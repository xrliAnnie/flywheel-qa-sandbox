# FLY-1927 新建 issue 开出多个 thread — 设计修正
Issue: FLY-1927 (https://linear.app/geoforge3d/issue/FLY-1927/bugthread-新建-issue-会开出多个-thread至少一个不对18671925-实证-实际工作-thread-与登记正主脱节)
日期: 2026-08-20
基于: plan.md

---

## 1. Founder 修正原话（逐字）

> 「起码我之前很少遇到这个问题,大概是从昨天晚上才开始遇到的。感觉要不然是它一直存在、只在某些极端情况下会出现,要不然就是最近改了什么导致的。如果是因为最近改了什么,那我更倾向于去把那个 bug 修好,而不是在这里又加很多层防护机制」

> 「就是你这个再加一个什么恢复小票,就已经给我感觉我们已经在 overcomplicating things 了」

本修正废弃 `plan.md` 里的 `pending_chat_thread_creations`「恢复小票」设计。后续实现和验收以本文为准；原 `plan.md` 保留，作为为什么发生这次收敛的审计记录。

## 2. 第一步：最近 48 小时回归归因

### 2.1 审计范围

沿真实调用链检查：

- `packages/teamlead/src/DirectEventSink.ts`
- `packages/teamlead/src/bridge/tools.ts`
- `packages/teamlead/src/bridge/ChatThreadCreator.ts`
- `packages/teamlead/src/bridge/chat-thread-utils.ts`
- `packages/teamlead/src/StateStore.ts`

并用 `git log -G` 搜索 `createChatThread`、`/api/chat-threads/create|send|register`、`start-thread`、`thread_name`、`upsertChatThread`。

### 2.2 结果

没有找到昨晚引入的 thread 创建/登记代码回归。

- 健康窗口运行头 `2df1fd06b` 到故障窗口运行头 `f8f2176e2`，上述五条生产路径的 `git diff` **为空**。
- 最近 48 小时命中这些大文件的提交中，`2df1fd06b` 只删除 `founder_ux_gate` 和默认关闭的 poller；没有改 `DirectEventSink.ensureChatThread`、`ChatThreadCreator.ensureChatThread`、两步 Discord REST 或 `chat_threads` 写入。
- `0742c4248` 只修测试里的全局 `fetch` stub 清理；其余窗口内提交为 CI、文档、日志 janitor、ship/review 路径。
- 两步 REST 共用一个 5 秒计时器、第二步失败后丢失已取得的根消息 ID，从 `8a804ef5e`（2026-04-13，FLY-91）起就存在。

因此 founder 给出的两个可能里，证据支持第一种：**缺陷一直存在，只在 Discord 响应不确定或主机极端饱和时显形；昨晚密集触发让低频缺陷集中暴露。** 不把没有证据的“最近代码回归”写成结论，也不新增与根因无关的巡检器。

## 3. 收敛后的最小修复

只修两步创建丢失所有权这一条根因，不建新 side table，不加 daemon、patrol、feature flag 或清理 endpoint。

1. **拆开两步超时。** 发根消息与从消息开 thread 各有独立 5 秒预算。第一步成功后，返回值始终保留 `rootMessageId`；第二步失败也不能把它丢掉。
2. **直接占现有正主。** Discord 保证 `threadId == rootMessageId`。拿到根消息 ID 后，立刻用现有 `chat_threads` 做 `(issue, channel)` 原子条件登记；这行就是正主，不再创建另一张“待恢复”表。
3. **只有 CAS 胜者能开 thread。** 并发调用都可能先发出根消息，但只有登记成功者可以调用 start-from-message；败者不得开自己的 thread，并尽力删除自己的根消息。
4. **只重试同一根消息。** start 返回失败/超时后，按 `rootMessageId` 精确探测 thread；已存在就采用，明确不存在且根消息仍在就只对同一根消息重试一次。任何路径都不得另发一条根消息。
5. **响亮失败，人工放弃。** 若登记正主对应的 thread 不存在且根消息也不存在，返回带 `threadId/rootMessageId` 的 typed 502，保留正主行，禁止自动重建。操作员核对精确三元组后，才可把该行 `discord_missing_at` 标记为非空；下一次调用才允许新建。
6. **堵住登记覆盖。** `/api/chat-threads/register` 的 Discord 校验完成后也走同一条件写，不能覆盖创建者已经占到的正主。

## 4. 删除与保留

| 项目 | 决定 |
|---|---|
| `pending_chat_thread_creations` side table / “恢复小票” | **废弃** |
| pending→canonical promotion、owner token resolver、coexistence reconciler | **废弃** |
| 两步独立 timeout、保留根消息 ID | 保留 |
| 现有 `chat_threads` 原子正主 CAS | 保留，替代恢复小票 |
| start 后精确 probe、同根消息重试 | 保留 |
| 败者根消息 best-effort 清理 | 保留 |
| 根消息丢失时 typed loud failure | 保留 |
| fenced 人工放弃 | 保留 |

## 5. 修正后的回归验收

- 第二步超时但 Discord 已建成：采用 `rootMessageId` 对应的 thread，`chat_threads` 正主一致，不再发第二条根消息。
- 第二步明确失败且 thread 不存在：只重试同一 `rootMessageId`。
- 两个独立 `StateStore`/Creator 竞争：只有 CAS 胜者调用 start；败者不产生 thread。
- 已有正主时 `/register` 不能覆盖。
- 正主 thread 与根消息都 404：响亮失败，重复调用不发新根消息；人工 fenced 放弃后才允许重建。
- 现有健康创建与复用响应形状保持兼容。
