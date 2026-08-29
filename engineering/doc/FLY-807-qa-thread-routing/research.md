# FLY-807 auto-QA thread 路由错误 — 调研

Issue: FLY-807
日期: 2026-07-03
基于: exploration.md

## 结论先行

**唯一根因**:`packages/edge-worker/src/Blueprint.ts:569`

```ts
const env: EventEnvelope = {
    ...
    labels: hydrated.labels,   // 应为 ctx.issueLabels ?? hydrated.labels
    ...
};
```

`env` 是 `DirectEventSink.emitStarted()` 建 Discord chat thread 时唯一的 label 输
入源(`DirectEventSink.ts:160-215`:`resolveLeadForIssue(projects, env.projectName,
env.labels ?? [])` → `lead.chatChannel` → `ensureChatThread(...)`)。`hydrated.labels`
来自 `PreHydrator.hydrate(node)` 对 `node.id` 做的一次**实时** Linear 查询。

`BlueprintContext.issueLabels` 字段自己的文档(Blueprint.ts:226-230)写明契约:
调用方传了就用调用方的、没传才 fallback 到 `hydrated.labels`。这个契约在同文件里
被**正确实现了两次**——613 行(ponytail 输入)`(ctx.issueLabels ?? hydrated.labels)`,
767-768 行(AgentDispatcher 派发)`ctx.issueLabels ?? hydrated.labels.map(...)`——唯
独在真正驱动 Discord 路由的 569 行**没有实现**,直接写 `hydrated.labels`。

## 为什么只有 QA session 会踩到,主 session 不会

FLY-643(`auto-qa-coordinator.ts` `spawnQa()`)让 QA 跑在一个**独立新建**的
`QA·FLY-XX` Linear issue 上,并特意把父 issue 已知正确的 label 透传:

```ts
// auto-qa-coordinator.ts:468-471
// Parent labels flow for Lead/thread routing; ...
issueLabels: parseIssueLabels(session.issue_labels),
```

这条链路的前半段是通的:`StartRequest.issueLabels` → `run-dispatcher.ts:666`
`ctx.issueLabels = req.issueLabels` → `BlueprintContext.issueLabels`。但 569 行完全
无视它,只认对**刚创建几百毫秒的全新 QA issue**做的实时 label 查询——`createFetchIssue()`
(`packages/teamlead/src/bridge/run-infra.ts`)在 Linear 读取失败时会 fallback 到
`store.getSessionByIssue(id)`,而此刻该 QA session 的 StateStore 行还没写入(upsert
发生在 `hydrate()` **之后**,Blueprint.ts:550 先 hydrate 才 585 emitStarted),fallback
对象里根本没有 `labels` 字段 → `PreHydrator.ts:38` 的 `issue.labels ?? []` 兜底成 `[]`。

`env.labels = []` → `ProjectConfig.ts:750-760` `resolveLeadForIssue` 的 label 匹配循环
命中不到任何 lead → 落到 `return { lead: project.leads[0]!, matchMethod: "general" }`
—— 即项目配置里的默认/第一个 Lead。生产 `flywheel` 项目的 `leads[0]` 正是 CoS(Aunt
Cass,`chatChannel = #flywheel-core`),这就是"不论父 issue 是什么 label,QA thread
全部落到 #core"的完整机制:与父 issue 真实 label 无关,只要 QA 阶段的 `hydrated.labels`
落空,routing 就无条件兜底到同一个默认 Lead。

主 session 对应的 issue 早已存在、label 早已打好很久,`hydrate()` 的实时查询天然稳
定命中,所以"看起来正常"——这掩盖了 `env.labels` 从来没有真正采纳过 `ctx.issueLabels`
的事实;只是正常路径从来没有"issue 刚创建几百毫秒就立刻被读 label"这种时序敏感场
景,QA 路径第一次踩中它。

## 四点诉求逐一核实

1. **路由修正** —— 上述 bug,569 行单行改动即可修复。`channelId` 本身不是硬编码,
   是本该由 `resolveLeadForIssue` 按 label 正确解析、只是解析时输入是空数组。
2. **@founder 可见** —— `ChatThreadCreator._doEnsure()` 无论新建(366-369 行)还是
   复用已存在 thread(255-261 行)都无条件 `addThreadMember(threadId, ctx.ownerUserId,
   botToken)`;`DirectEventSink.emitStarted()` 对 QA 和普通 session **无差别地**传
   `ownerUserId: this.config.discordOwnerUserId`。代码里**没有**任何跳过 founder-add
   的 QA 专属分支——两条路径是同一个函数、同一组参数命名。因此"没加 founder"最可能
   是①的次生症状(路由错了 lead 之后可能撞该 lead bot 在 #core 的权限问题),而非独
   立 bug。team-lead 确认 Annie 之前验证过 @founder 机制本身是好的,进一步支持"①修
   好后②自然恢复"的判断。
3. **Lead relay QA 生命周期** —— `AutoQaEffects.postThread()`("🧪 QA 开始"/"✅ ready"
   等消息)传入的 `session` 参数始终是**父 session**(`auto-qa-coordinator.ts` 的
   `spawnQa(session, sha)` 里的 `session`),其 `resolveThread()` 用父 session 已知正
   确的 `issue_labels` 解析 —— 这条路径从来没有踩到 569 行的 bug,本来就工作正常,
   不需要改动。
4. **挪走存量** —— Discord API 的 thread `parent_id` 创建后不可变更,没有"迁移 thread
   到别的 channel"的官方能力,代码里也确实没有对应函数。现成的清理机制是 FLY-369
   引入的 backlog 端点 `POST /api/chat-threads/archive`(`tools.ts:938` 起,
   `done-thread-archiver.ts` 顶部注释明确说是给这种存量清理场景准备的手动能力)——
   只能把错误 thread 归档(从侧栏消失),不能"搬家"。

## FLY-270 dual-thread bug 是否相关

不是同一个问题:FLY-270 修的是"手动 API 路径(`/chat-threads/create`/`send`)里
issueId(UUID) vs issueIdentifier 不一致导致同一逻辑 issue 建出两条 thread 记录"的
去重问题。本 bug 发生在**自动**路径(`DirectEventSink.emitStarted`),QA issue 的
`issue_id` 本身是稳定一致的 UUID,不存在 key 形式分裂;两者只是共享同一张
`chat_threads` 表和 `UNIQUE(issue_id, channel_id)` 索引——该索引在本 bug 场景下反而
是"卡死错误路由"的帮凶:一旦第一次落进 `#core`,后续对同一 QA issue 的所有
postThread/stampIssueStage 都会查到并复用这条错误行,不会自愈。

## 修复方向

`Blueprint.ts:569` 改为 `labels: ctx.issueLabels ?? hydrated.labels,`,与同文件 613
行、767-768 行保持一致。单行、低风险,现成测试模式可以照抄
(`Blueprint.test.ts` 里已有 "copies ctx.runnerModel into the session_started
envelope" 这类断言 `emitStarted` 调用参数的测试,可以照葫芦画瓢加一个断言
`env.labels` 优先采纳 `ctx.issueLabels` 的回归测试)。
