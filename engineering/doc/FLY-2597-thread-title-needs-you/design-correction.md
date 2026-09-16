# FLY-2597 设计修正 1:Epic 级状态只在固定页看,「纯记录」回帖不进 Discord thread
Issue: FLY-2597 (https://linear.app/geoforge3d/issue/FLY-2597/founder-视图单一真相-thread-title-加要你答状态founder-需回复时机器点亮founder-回帖即熄-epic)
日期: 2026-09-15
基于: plan.md(已过 design gate,blob `f0e967bf`;本文件是附录,不改动已批准的 plan 正文)

**触发**:Lead 指令 `[lead-instruction 8faf718f-a04c-4cff-abac-77fe861138ba]`(22:45Z,founder 反馈):epic-intake(FLY-2557)要求 Lead 在每个 Epic 根 thread 回收件凭证并交 messageId,结果 6 个安静的 Epic thread 被顶到 founder 列表顶端,founder 问「这些是什么、为什么开」。要求:Epic 级状态只在固定页看,不进/不顶起 Discord thread;二选一 (a) 凭证不依赖 Discord 消息,(b) 保留回帖但 resolve 后引擎自动归档;同样适用于其它「纯记录」回帖。

## 1. 现状(实核)

- `packages/teamlead/src/bridge/epic-intake-result.ts::epicIntakeResultSchema`:`threadId`、`messageId` 为**必填**(17–20 位 snowflake),三种 outcome 一律要求。
- `epic-intake-route.ts::/resolve`:服务端 `deps.observe(row, evidence)` 读回该 Discord 消息(`message {id, channelId, authorId}` + `leadBotUserId` + `canonicalThreadId`),`validateEpicIntakeEvidence` 核「消息在 canonical thread 里且作者是本 Lead 的 bot」。⇒ **凭证的本体就是那条 Discord 回帖**,这正是把安静 Epic thread 顶起来的原因。
- `runner-patrol-rules.md §0.11` 第 2 步「backfill=true … 回一行 thread」、第 5 步「在 `[EPIC-ID]` canonical thread 回『拆成 N 张…』并保存 messageId」——两处都是纯记录回帖。
- Epic 固定页已在每张 Epic 卡的标题行渲染 `epicIntakeStatus()`(render-html.ts:441),即「收件/拆解到哪一步」founder 在固定页本来就看得到。
- Discord 行为:向 thread 发任何消息都会把它顶到列表顶端并标未读;归档只能事后移出列表,顶起与未读已经发生;既有归档语义(FLY-369)明确绑定「真正收尾」且 Discord 会在下一条消息时自动解档,还有 reopen 补偿。

## 2. 决定:选 (a),凭证改为 Bridge 持久记录;(b) 否决

| | (a) 凭证不依赖 Discord 消息 | (b) 保留回帖 + resolve 后自动归档 |
|---|---|---|
| founder 视图 | 安静 Epic 不再被顶起、不再有未读 | 顶起与未读先发生,再消失——founder 仍会看到一次「为什么开」 |
| 与 FLY-369 归档语义 | 无冲突 | 冲突:归档被定义为「真正收尾」;Epic 根 thread 后续子单拆解/派发还要用,自动解档再归档来回抖 |
| 通用到「其它纯记录回帖」 | 通用:规则一条「纯记录不进 thread」 | 不通用:活着的 issue thread 不能因一条 ACK 就归档 |
| 审计 | resolve 已由 `TEAMLEAD_API_TOKEN` + `ownsLead` 双重核身份;证据 JSON 持久在 `epic_intakes.result_json`,再加 `receipt` 字段记「谁/何时/怎么核」 | 不变 |
| 实现量 | schema 两字段改可选 + 观察分支 + 规则文本 | 归档钩子 + 抖动防护 + 例外表 |

**(a) 的具体形状**

1. `epicIntakeResultSchema`:`threadId`/`messageId` 改为**可选**;`.refine`:`outcome === "needs_founder"` 时二者必填(那条消息本身要 founder 答,见第 3 点)。`complete`/`superseded` 可以不带。
2. `/resolve` 服务端观察:无 `messageId` 时跳过 Discord 消息读取,`observed.message = null`;`validateEpicIntakeEvidence` 对 null 消息只核 active/directChildIds/canonicalThread。存储时在 `result_json` 追加服务端写入的 `receipt: { kind: "bridge_record" | "discord_message", leadId, verifiedAt, messageId? }`(请求体里出现该键 → 400,防伪造)。
3. `needs_founder` 走本单主线:Lead 用 `POST /api/chat-threads/send` + `founderAsk`(excerpt = founderQuestion)把问题发进 Epic 根 thread,`messageId` 就是那条;于是这条 thread 被顶起是**正当的**——标题同时亮 `🔔要你答`,固定页「现在要你看」同源出现,founder 回帖后同一套机器熄灭。安静的 Epic 永远不会被顶。
4. 规则(`runner-patrol-rules.md §0.11`):第 2 步删「回一行 thread」;第 5 步改为「complete/superseded 不回帖,凭证即 resolve 本身;needs_founder 用 send+founderAsk 回帖并把 messageId 交给 resolve」。新增通用条款(放 `department-lead-rules.md` 与 `runner-patrol-rules.md` 各一句):**纯记录类回帖——收件凭证、ACK 回执、机器已持久记录且固定页/标题已可见的状态转述——不进 Discord thread;Epic 级状态只在固定页看。** `legacy-token-savings/` 副本同步。
5. CLI `flywheel-comm epic-intake resolve` 的本地证据文件校验与 schema 同步(可省略两字段)。

**不改的(边界)**:FLY-369 的 Runner 生命周期转述(`[REPORT]` runner-stop 等)发生在有活 Runner 的 issue thread 上,不是安静 thread,且不在本指令「纯记录」定义内——维持;若 Lead 认为也该收,追加一条规则即可,不需要改代码。

## 3. 纳入 plan 的增量(作为 C11,不改已批准正文的编号)

- **C11 Epic 收件凭证去 Discord 化**
  - `epic-intake-result.ts` schema 与 `validateEpicIntakeEvidence`;`epic-intake-route.ts` 观察分支与 `receipt` 服务端字段;`flywheel-comm/src/commands/epic-intake.ts` 本地校验。
  - 测试:schema 接受无 thread/message 的 complete/superseded;拒绝无 message 的 needs_founder;请求体含 `receipt` → 400;route 无 messageId 时不调用 Discord(mock fetch 零调用)且落库 `receipt.kind="bridge_record"`;有 messageId 时行为字节不变(既有用例不动)。
  - 规则 diff:§0.11 两处 + 通用条款两处 + legacy 副本。
- 验收映射追加:「安静 Epic 不被顶起」= 真机:529 台架对一个无子单 Epic 跑 `epic-intake resolve` complete 且不带 messageId → Discord REST 读该 thread 最后消息 id 不变、`last_message_id` 不变;固定页 Epic 卡 `epicIntakeStatus` 变化。
- 迁移/回滚:schema 放宽向后兼容(旧证据仍合法);回滚 = revert,已存的 `bridge_record` 凭证保留可读。

## 4. 对本单主设计的影响

无冲突,反而闭环:needs_founder 是「要你答」的第四个天然来源(仍走条件 3 的 founderAsk,不新增 kind)。`FOUNDER_ATTENTION_KINDS` 不变。
