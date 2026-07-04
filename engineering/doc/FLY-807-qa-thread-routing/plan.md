# FLY-807 auto-QA thread 路由错误 — 实施计划

**Version**: v1(单行修复)
Issue: FLY-807
日期: 2026-07-03
基于: research.md

## 1. 目标 / 验收

- QA thread(以及所有 `session_started` 驱动的 chat thread)按调用方显式传入的
  `ctx.issueLabels` 路由,而不是对刚创建的 issue 做一次可能落空的实时 Linear 查询。
- 字节兼容:未传 `ctx.issueLabels` 的调用点(绝大多数现有主 session)行为不变
  (fallback 到 `hydrated.labels`,与今天完全一致)。
- 回归测试锁死"`ctx.issueLabels` 优先于 `hydrated.labels`"这条契约,防止未来再漂移。

## 2. 改动范围(刻意最小,FLY-807 是单行路由 bug,不做架构改动)

### 2.1 代码

`packages/edge-worker/src/Blueprint.ts:569`

```diff
- labels: hydrated.labels,
+ labels: ctx.issueLabels ?? hydrated.labels,
```

与同文件已有的两处正确实现(613 行 ponytail 输入、767-768 行 AgentDispatcher 派发)
保持一致,不新增抽象、不改函数签名。

### 2.2 测试

`packages/edge-worker/src/__tests__/Blueprint.test.ts` 新增一个 `it`,紧邻已有的
"copies ctx.runnerModel into the session_started envelope" 测试:

- 用 `makeHydrator()`(默认返回的 issue 数据不含 `labels` 字段 → `PreHydrator` 兜底
  `[]`)+ 注入 mock `emitter`。
- `ctx.issueLabels = ["flywheel"]` 跑一次 `blueprint.run(...)`。
- 断言 `emitStarted` 收到的 `env.labels` 是 `["flywheel"]`,不是 `[]`——直接命中
  FLY-807 的回归场景(QA 阶段 `ctx.issueLabels` 有值但 `hydrated.labels` 落空)。
- 再加一个"未传 `ctx.issueLabels` 时仍 fallback 到 `hydrated.labels`"的字节兼容断言
  (用一个有 labels 的 hydrator,不传 ctx.issueLabels,断言 env.labels 等于 hydrated
  的值)。
- 再加一个"`ctx.issueLabels` 显式传空数组 `[]` 时不应该 fallback 到 hydrated.labels"
  的断言(用一个返回 `labels: ["hydrated"]` 的 hydrator,传 `ctx.issueLabels = []`,
  断言 `env.labels` 是 `[]` 而不是 `["hydrated"]`)——锁死 `??`(只在 `undefined`/`null`
  时才 fallback)而非 `||`/`.length` 判断的精确语义,防止未来重构悄悄改坏这条契约
  (Codex design review R1 #3 指出)。

不新增集成测试:`auto-qa-coordinator.ts`/`auto-qa-effects.ts` 里已有的单测(如
`auto-qa-effects.test.ts`)覆盖的是 `session.issue_labels` → `resolveLeadForIssue`
这条消费端逻辑本身没问题(research.md 已核实),本次改动只是让 Blueprint 把已经
正确透传的值真正用上,不需要在那两个文件里加测试。

## 3. 不做的事(scope 边界,对应 team-lead 已确认的范围)

- **不加防御性代码**给 `addThreadMember`(founder 加 member)—— 审计没找到独立
  bug 的证据,①修好后由 QA 在真实环境验证 founder 是否出现;team-lead 确认 Annie
  之前验证过该机制本身是好的。
- **不改** `AutoQaEffects.postThread`/`resolveThread` —— 走的是父 session 已知正确
  的 label,本来就没问题。
- **不写自动化清理脚本**去挪/归档生产环境已堆积在 `#core` 的存量 QA/eng thread ——
  Runner 在隔离 worktree 里没有生产 Bridge/StateStore 访问权限,写一个测不了的脚本
  没有意义。改为在 §4 给出可执行的操作说明,由 team-lead / Annie 在生产环境跑。
- 不改 `resolveLeadForIssue` 的 fallback 语义(fallback 到 `leads[0]` 本身是合理的
  兜底设计,只是喂给它的输入之前是错的)。

## 4. 存量清理操作说明(手动,生产环境执行,非本次代码改动)

前提:①的代码修复 ship 之后,**新建**的 QA thread 会正确路由;下面只处理修复前已
经错误落在 `#flywheel-core` 的 QA/eng thread。

1. 在生产 Bridge 的 StateStore 里找出误路由的 thread,一次性把 archive 端点需要的
   全部字段都取出来(端点实际要求见 `tools.ts:938-983`:`channelId` + `leadId` +
   `projectName` + `issueId`/`issueIdentifier` 其一,不是只传 `threadId`):
   ```sql
   SELECT ct.thread_id, ct.channel_id, ct.issue_id, ct.lead_id,
          s.issue_identifier, s.project_name, ct.created_at
   FROM chat_threads ct
   LEFT JOIN sessions s ON s.issue_id = ct.issue_id
   WHERE ct.channel_id = '<flywheel-core-channel-id>'
   ORDER BY ct.created_at DESC;
   ```
   过滤出 `issue_id` 对应 Linear 里标题以 `QA ·` 开头、或父 issue 带 `Flywheel`
   (非 `Flywheel-Triage`)label 的那些行——这些是本该落到 eng 频道却错落到 core 的。
2. 对每个误路由的行,调用现成的 backlog 归档端点(FLY-369,`tools.ts:945` 起)。
   端点挂在 `TEAMLEAD_API_TOKEN` Bearer auth 后面,请求体是:
   ```
   POST /api/chat-threads/archive
   Authorization: Bearer $TEAMLEAD_API_TOKEN
   {
     "issueId": "<ct.issue_id>",
     "channelId": "<ct.channel_id>",
     "leadId": "<ct.lead_id>",
     "projectName": "<s.project_name>"
   }
   ```
   这会把 thread 标记 `archived_at`(Discord 侧从 founder 侧栏消失),但**不会**把
   它挪到正确频道——Discord 的 thread `parent_id` 创建后不可变更,没有官方"迁移"能
   力。**只有该 issue 未来触发新的 `session_started`(即新起一个 session/role,例如
   retry 或该 issue 再次进入 auto-QA)才会在正确频道新建一条 thread——单纯的
   `stage_changed`(stampStageEmojiForSession)只会去找已存在的 thread 打标题,不
   存在就直接跳过、不会新建**(Codex design review R1 #2 指出,原草稿这里写错了)。
   若某个 issue 归档后短期内不会有新 session_started、但仍需要立刻恢复可见性,操
   作者应手动走现成的 `POST /api/chat-threads/create` 补建,而不是干等 stage_changed。
3. 建议由 team-lead(Tadashi)或 Annie 直接在生产环境执行,不建议写一次性脚本自动
   跑批(存量规模小,肉眼核对 issue label 比脚本猜测更保险,误伤会把仍在追的 thread
   也归档掉)。
   > 操作提醒(Codex design review R2):`sessions.issue_id` 不是唯一约束,一个 issue
   > 可能对应多个 session 行,上面这条 SQL 可能对同一个 `thread_id` 返回重复行。这
   > 不影响正确性——archive 端点本身是幂等的(重复归档同一个已 archived 的 thread
   > 不会报错)——但操作者按 `thread_id` 去重一遍会更干净,或者直接容忍重复调用。
