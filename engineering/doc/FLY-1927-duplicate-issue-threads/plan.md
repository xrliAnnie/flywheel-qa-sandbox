# FLY-1927 新建 issue 开出多个 thread — 实施计划

Issue: FLY-1927 (https://linear.app/geoforge3d/issue/FLY-1927/bugthread-新建-issue-会开出多个-thread至少一个不对18671925-实证-实际工作-thread-与登记正主脱节)
日期: 2026-08-20
基于: research.md

> **修订记录**
> - **R1**(5 HIGH / 3 MEDIUM / 1 LOW,全采纳):最大一处推翻 —— 原方案把「未确认」行写进 `chat_threads`,会打破 20 多个既有读者的契约。改为独立待确认表。
> - **R2**(3 HIGH / 3 MEDIUM / 1 LOW,全采纳):架构过关,但状态迁移不够原子/不够耐久 —— 「尽力归档后就删锚点」会在另一条分支上重造同一个 bug;claim/提升/删除必须事务化且带 root 围栏;「根消息 404」只能证明**将来**开不出 thread,不能证明**过去**没开出来。
> - **R3**(2 HIGH / 1 MEDIUM,全采纳):claim 只对待确认表设围栏不够,还必须对**正主**设围栏(锚点被提升退休后,槽位腾空会让迟到的 claim 者误判自己是胜者);条件提升必须按**物理行**判断,否则会回归掉既有的「thread 404 后重建」(墓碑行仍占唯一索引槽)。
> - **R9**:**APPROVED**(无阻塞项)。非阻塞注释已折入 R21:两个 mutant 各对应一个 guard —— 逐字用 `markChatThreadMissing(expectedId)` 实现时 (b) 红;按 `(issue, channel)` 更新但漏 canonical-id guard 时 (a) 红。
> - **R8**(1 MEDIUM / 1 LOW,全采纳;Codex 判定「整体设计已无已知状态机 blocker」):① `tombstoneSameIdCanonical` 的双围栏必须有**失配 no-op 的 RED 用例**(否则把它误写成既有 `markChatThreadMissing` 的单条件 UPDATE 形态,现有矩阵仍全绿)⇒ 新增 R21 直接 StateStore 用例;② §2.5b 胜者交接、§2.6 围栏摘要、§5 实施步骤同步新加的 project/tombstone 信息。
> - **R7**(1 HIGH / 1 MEDIUM / 1 LOW,全采纳):① same-id `pending_root_gone` 只留 pending 会让人工放弃后 `/send` 的 existing 快路对着 live-but-missing 正主永久发 404 ⇒ 判定 root-gone 的**同一时刻**,事务化地把 same-id 正主打上 `discord_missing_at` 墓碑(围栏 = 正主==p 且 pending.root==p),锚点保留:迟到的 start 仍能经墓碑替换重新提升;人工放弃 pending 后正主已不可见,下一次 `/send` 自然进 ensure 从 ① 干净重建;② 「把 project 来源写回正主」与 `chat_threads` 零 schema 变更冲突 ⇒ 采推荐解:`project_name` 只活在 pending 生命周期内(用于 winner-token 解析),`already_same` 只更新 `lead_id`;③ claim 签名/胜者交接/row 5b 措辞把 project 维度贯穿。
> - **R6**(1 HIGH / 2 MEDIUM,全采纳):① `(leadId, channelId)` 不是全局身份 —— 同一 `agentId` 可合法出现在多个 project(`bootstrap-generator.test.ts:796-825` 钉住的受支持场景),全局扫描会静默拿第一个 ⇒ pending 行持久化 `project_name`,resolver 钉成 project-scoped `(projectName, leadId, channelId) → token`,歧义/缺失显式走声明的 fallback;② own-key same-id 登记后 canonical 的 `lead_id` 可能是 caller 而非锚点 owner ⇒ `already_same` 在**同一事务**内先把正主 `lead_id` 改回锚点 owner 再删锚点(R7 收窄:不写 project 来源进正主),R19c(b)/R20b 断言收敛后的 owner;③ 改动清单三处与正文矛盾(promotion 返回种数、`/send` reconcile 失败措辞、§2.10「契约不变」)写死。
> - **R5**(3 HIGH / 1 MEDIUM / 1 LOW,全采纳):① 同 id 共存 + 探针 `absent` 会把 `/send` 永久楔住(`/send` 对正主从不跑 validator)⇒ 同 id 分支改为**完整走 0️⃣ 步的恢复路径**(absent+root present → 对同一 msgId 重试②;root 404 → 不发、502 `pending_root_gone`);② **收回 R4 的「一频道一 bot」断言** —— 源码反证:`chat-thread-routes.test.ts:44-68` 两个 Lead 共享 `ch-100` 不同 token,archive/done-archiver 本来就按 thread 的 `lead_id` 解析 token ⇒ 胜者锚点的探针/重试/归档按**锚点行 owner** 解析 token(注入 `(leadId, channelId) → token` 可选 resolver,败者删自己的根消息仍用 caller token);③ 登记没围住 pending root 的全局所有权,能把别的 issue 的恢复锚点登成自己的正主 ⇒ `root_message_id` 全局 UNIQUE + 登记事务内查 foreign live pending root → 409;promote 撞 `thread_id` 主键返回类型化 `thread_taken`;④ `pending_root_gone` 的 HTTP 合同钉死(附加字段,不破坏既有形状);⑤ 测试矩阵残留旧设计措辞与错误行号,更正。
> - **R4**(4 HIGH / 2 MEDIUM / 2 LOW,全采纳;Codex thread 随主机 panic 丢失后新开,对照当前源码逐字核过):① `/register` 的 delete-first 覆盖能在提升提交**之后**把刚提升的正主删成无锚孤儿 ⇒ 登记改为条件事务,**不同活正主存在即 409、不再覆盖**(生产零调用方依赖覆盖语义,已核);② 正主 id == 锚点 id 时不能无条件删锚点(正主本身可能来自 fail-open 校验)⇒ 同 id 分支也走严格三态探针;③ `/send` 见到正主就跳过 ensure ⇒ 共存态可能永远没有恢复入口 ⇒ `/send` 的 existing 分支加一个无副作用快路的 `reconcilePendingForCanonical`;④ 三重 negative probe 不是线性化证明 ⇒ **删掉自动重锚**,根消息明确 404 也保留锚点、带类型错误响亮失败、放弃是人工动作;⑤ 恢复操作的 token 钉死为调用方 token(channel↔lead 由 `validateChatThreadParams` 强制 1:1,同频道只有一个 bot);⑥ 第 ② 步一切非 2xx 统一处理;⑦ 新表只在 `migrate()` 里一处 `CREATE TABLE IF NOT EXISTS`;⑧ 源码路径更正。

---

## 1. 要修的那一句话

`createChatThread()` 把「我不知道远端做成没有」写成了「失败了」。

修法不是让它更少地不知道(调大超时),而是**让它不再需要知道** —— 把建 thread 变成可以安全重放的操作:重放多少次,最终都只存在一条 thread。

支点是 research §2 已在生产上实测坐实的不变量:

> **thread id 恒等于根消息 id。一条消息最多挂一条 thread。**
> ⇒ 「那条 thread 建成了没有」有确定性答案,而钥匙(根消息 id)在第 1 步结束时就已到手。

**所以只要在第 1 步成功后立刻把根消息 id 落盘,后面无论怎么超时、Bridge 重启多少次,都能确定性地找回来。**

---

## 2. 设计

### 2.1 现在的流程(坏的)

```
[一个 5 秒计时器罩住全部]
  ①  POST /channels/{ch}/messages                  → msgId
  ②  POST /channels/{ch}/messages/{msgId}/threads  → threadId
  ③  upsertChatThread(threadId, …)
超时 → 返回 {created:false, error:"timeout"},msgId 被丢弃,登记表零写入
     → 下一次 ensure 查不到 → 从 ① 重来 → 多一条 thread
```

### 2.2 锚点存哪里 —— R1 推翻了原方案

原方案:把「未确认」的行直接写进 `chat_threads`(加一个 `create_confirmed_at` 列)。**这是错的。**

`chat_threads` 的行在整个代码库里的含义是「这里有一条**能用**的 Discord thread」,读者远比我以为的多:

- **`/api/chat-threads/send` 是硬断裂**:见到行就**故意跳过** `ensureChatThread`,直接往 `/channels/{那个 id}/messages` 发(`tools.ts:838-900`)⇒ 临时行让它绕过恢复,直接 502/404。
- `resolveChatThreadId()` 把 id 喂给 `HeartbeatService` / `DirectEventSink` / `actions.ts` / `question-admission.ts` / `gate-poller.ts` 的事件负载。
- 十余处直接对这个 id 发消息/改名/置顶/读 reaction 的写者。其中 ready-to-close 通知是 claim-first,**一次性名额会被永久消耗**。
- 归档路径(`done-thread-archiver` / `terminal-thread-archive` / `/chat-threads/archive`)会把它当归档候选;404 触发 `markChatThreadMissing`,**把恢复锚点本身抹掉**。
- `getUnarchivedIssueChatThreads` / `listDisplayReconcileCandidates` / `getAllChatThreadIds` / `getChatThreadByThreadId` 会把它带进后台任务、语音作用域、reply-guard 绑定。

外加:`ALTER TABLE ADD COLUMN` 会让**全部 1050 条存量行**新列为 `NULL` —— 恰好是「未确认」哨兵值,升级后第一次启动全部 issue 一起进恢复分支。

⇒ **改为独立待确认表,只有 `ChatThreadCreator` 读它。既有读者一行不改,爆炸半径为零,不需要任何数据回填。** 它多加一张表,但**改动面更小** —— 简单性看爆炸半径,不看行数。

### 2.3 主流程

```
0️⃣  chat_threads 有这个 (issue, channel) 的正主吗?
      有  → 现状行为完全不变(validateThreadExists → 复用 / 失效则往下)
            若同时有待确认行 → 进 §2.5 的「共存状态机」,不再无脑清理
      没有 → 看待确认表
              有锚点 → 三态确认探针(§2.4)
                        confirmed → 提升(§2.6)
                        absent    → 再探根消息(§2.4 的消息探针):
                                      present → 跳 ②,用同一个 msgId 重试。绝不重发根消息
                                      404     → 本次失败,错误类型 pending_root_gone,锚点保留(§2.7)
                                      transient / denied → 本次失败,锚点保留
                        transient / denied → 本次失败,锚点原样留着(§2.7)
              没锚点 → 从 ① 开始

①  POST /channels/{ch}/messages   [本步独立计时]  → msgId
      ↓ 立刻
   claimPendingChatThread(issue, channel, msgId, leadId, projectName)   [单事务,同时对正主设围栏 §2.5b;projectName 缺失按 §2.6 声明的 fallback 处理]
      claimed            → 用我的 msgId 继续
      existing_pending   → 有界删除(§2.8)清掉我刚发的根消息,
                           改用**胜者行**的 root_message_id + lead_id + project_name 继续
      canonical_present  → 已有活正主。清掉我的根消息,走正常复用路径
      后两种情况**绝不用我的 msgId 去开 thread**(不变量在这里,不在删除成功与否)

②  POST /messages/{msgId}/threads [本步独立计时]
      2xx                    → 提升(§2.6)
      其他一切(abort / 网络 / 408 / 429 / 4xx / 5xx)
                             → 锚点原样保留;带 root 围栏写 last_error / last_attempt_at;
                               **绝不重发根消息**;随后做**一次**三态探针(§2.4)裁决:
                                 confirmed → 提升;其余 → 本次返回失败
                               (不按错误码分流:4xx 也可能是「thread 已存在」,5xx/429 也可能已经建成)
```

**第 ② 步的响应 id 一律忽略、以根消息 id 为准**;若响应里的 id 与根消息 id 不同 ⇒ fail-loud(违反 research §2 的不变量,说明前提坏了,不能静默继续)。

### 2.4 确认探针必须三态 —— 不能复用 `validateThreadExists`

现有 `validateThreadExists`(`thread-validator.ts`)**不能用**:

- 它对**一切非 404**(429 / 5xx / 超时 / 网络错误)返回 `true` ⇒ 一次 429 就把没建成的 thread 误判为已建成、提升成正主。
- 它在 404 时调 `markChatThreadMissing()`。而「thread 还没开」本来就是 404 ⇒ 错误副作用。

新增**只给待确认路径用**的分类探针,`GET /channels/{rootMessageId}`,**无任何副作用**:

| 结果 | 判据 |
|---|---|
| `confirmed` | HTTP 200 **且** 是 thread 类型 **且** `parent_id` == 预期频道 |
| `absent` | 明确 404,或 200 但对象形状不符 |
| `transient` | 超时 / 网络 / 408 / 429 / 5xx |
| `denied` | 401 / 403 |

**根消息探针**(`GET /channels/{ch}/messages/{msgId}`,§2.7 用)**同样分类**,绝不把 transient 折叠成「没了」。

形状可参照 `packages/teamlead/src/bridge/roundtable/RoundtableThreadManager.ts` 里的私有分类器(同一条 id 恒等不变量),**但不能照抄**:它把 401/403 归成 `absent`,而本计划要求单独的 `denied`(denied 绝不能触发任何重建/退休动作);`bridge/roundtable/ensure-thread-from-message.ts` 里的 `confirmThreadExists` 是布尔型,同样不适用。布尔版 `validateThreadExists` 保持不动,继续服务已确认行。

### 2.5 正主与锚点共存的状态机(R2 HIGH-1)

原方案写「共存时尽力归档锚点指向的 thread,然后清掉锚点」。**这会在另一条分支上重造同一个 bug**:归档可能返回超时/429/5xx/denied,清掉锚点就丢了唯一的恢复钥匙。

具体竞态:Creator A 的 `POST …/threads` 还在飞;`/register` 装上了正主 `c`;Creator B 看到 `c + p`,在 A 的请求落地前探测 `p` 得到 404,删掉锚点;随后 A 的请求落地建出 `p`。结果:正主 `c` + 孤儿 `p`。

**改为明确的三分支,锚点的退休必须是「已确认完成」才发生**:

| 情形 | 动作 |
|---|---|
| 正主 id **==** 锚点 root id | **不能无条件删锚点**(R4 HIGH-2),也**不能在 `absent` 时装作没事**(R5 HIGH-1:`/send` 对正主从不跑 validator,`tools.ts:838-897` backfill 后直接 POST;若正主来自 fail-open 校验而 thread 实际没建成,「保留锚点、照常返回」= 每次 `/send` 都往不存在的 channel 发 404,永远进不了恢复)。⇒ 同 id 分支**完整走 0️⃣ 步同款恢复**:`confirmed` → 删锚点(`already_same`,绝不归档这个 id);`absent` → 探根消息:present → **对同一 msgId 重试第 ② 步**,成功即 `already_same` 收敛;根消息明确 404 → 失败,`pending_root_gone`,**且在同一时刻用带围栏的单事务把这条 same-id 正主打上 `discord_missing_at` 墓碑**(R7 HIGH-1;新原语 `tombstoneSameIdCanonical(issue, channel, expectedId)`,条件 = 活正主 == expectedId **且** 锚点 root == expectedId,二者任一不符则 no-op —— 分类探针本身仍零副作用,副作用只在这个显式状态迁移里)。锚点**保留**:迟到的 start 若真出现,下次探针 `confirmed` 仍可按墓碑替换规则重新提升 `p`;人工带围栏删掉锚点后,正主已对读者不可见,下一次 `/send` 查不到行、自然走 `ensureChatThread` 从 ① 干净重建 —— 没有这一步,人工放弃只删 pending,`getChatThreadByIssue`(`StateStore.ts:9760-9786`)仍返回 live 的 `p`,`/send` 的 existing 快路(R20(vii) 零探针)会对不存在的 thread 永久发 404(`/send` 此时**不得**再向这个已证不存在的 canonical 发送,直接 502);`transient` / `denied` → 锚点保留,本次对正主照常发送(发送自身的 404 会响亮失败,不静默) |
| 正主 id **!=** 锚点 root id,探针 `confirmed` | 归档它;**只有 Discord 确认 archived / already-archived 之后才删锚点**。归档失败(transient/denied/任何非确认)⇒ **保留锚点**,下次 ensure 再清 |
| 正主 id **!=** 锚点 root id,探针 `absent` / `transient` / `denied` | **不开它,也不删它。** 可能有请求还在飞。一直保留,直到「确认存在且已归档」,或由人工按 §2.7 带围栏放弃 |

### 2.5b claim 必须同时对正主设围栏(R3 HIGH-1)

只对待确认表做 `INSERT … ON CONFLICT DO NOTHING` **不够**。两个具体调度仍会多建一条 thread:

1. 某次 ensure 看到没有正主,去发根消息(await 中);`/register` 装上正主 `c`;ensure 回来发现待确认表是空的,claim 了自己的 `p`,然后**从 `p` 开了 thread**。
2. Creator A claim → 开 thread → 提升成正主 `a` → 删掉待确认行;Creator B 早就发了根消息 `b` 但 claim 慢了一步,现在往**刚被腾空**的槽里插 `b`,然后开它。

两种情况下,后来的提升都会报 `canonical_conflict` —— **但那时重复 thread 已经建出来了**。根因:待确认表的唯一性,在胜者行被提升退休之后就不再能识别「我是败者」。

⇒ **`claimPendingChatThread` 做成对正主也有感知的单事务**,插入前先读同 `(issue, channel)` 的 `chat_threads` 活行:

| 返回 | 语义 | 调用方动作 |
|---|---|---|
| `canonical_present` | 已有活正主 | **不插入待确认行**。有界删掉自己刚发的根消息,把返回的正主行走正常的校验/复用路径。**绝不开 thread** |
| `existing_pending` | 已有别人的锚点 | 有界删掉自己的根消息,改用胜者的 root + lead_id + project_name |
| `claimed` | 既无活正主、也无锚点 | 用自己的 root 继续第 ② 步 |

### 2.5c 登记路径不得反向覆盖正主(R4 HIGH-1)

当前 `validateAndRegisterChatThread()`(`packages/teamlead/src/bridge/chat-thread-register.ts:162-208`)先**异步**做 Discord 校验,最后**无条件**调 delete-first 的 `upsertChatThread()`。可实现的反例:

```
/register(c) 开始,等 Discord GET   →   Creator 把锚点 p 提升为正主(同事务删锚点)
    →   /register 恢复,upsert(c) 的 delete-first 把正主 p 删掉
    ⇒ Discord 上 p 活着、登记表里没有 p、锚点也没了 —— 原 bug 原样重造
```

§4 的 R11b 只保护了「`/register` 先提交、提升后开始」这一个顺序;反过来的顺序没人管。`/api/runs/start` 也复用这个 helper(`runs-route.ts:1843`),且**不传 `botToken`**,所以不能只在 HTTP `/register` 路由上修。

⇒ **登记改为 StateStore 里的条件事务** `registerChatThreadConditional(threadId, channelId, issueId, leadId)`:

| 情形(事务内重读) | 结果 |
|---|---|
| 无活正主,或只有墓碑行 | 写入(墓碑同事务替换)⇒ `ok` |
| 活正主 == threadId | 幂等 ⇒ `ok` |
| 活正主 != threadId | **409 `canonical_exists`**(body 带当前正主 id)。**不覆盖、不删** |
| threadId 已映射到别的 issue | 409(既有第 5 步语义不变) |
| threadId 是**别的 (issue, channel)** 的活 pending root(R5 HIGH-3) | **409 `pending_root_conflict`**。Discord snowflake 是全局身份,一条 root 只能属于一个 issue 的恢复;没有这道围栏,`/register(p, issue=B)` 能偷走 A 的锚点 —— 随后 A 的 reconcile 探到 confirmed 会把 **B 的正主**归档掉 |
| threadId 是**同一个 (issue, channel)** 自己的 pending root | 允许 ⇒ `ok`(形成正主==锚点共存,由 §2.5 同 id 分支收敛) |

配套(同属 R5 HIGH-3):`pending_chat_thread_creations.root_message_id` 加**全局 `UNIQUE` 索引**(表达 snowflake 的全局身份;PK 仍是 `(issue_id, channel_id)`);`promotePendingChatThread` 在目标 `thread_id` 已被**另一条物理正主行**占用(`chat_threads` 的 PK 是 `thread_id`,`StateStore.ts:3360`)时返回类型化 `thread_taken`,不把 UNIQUE 异常漏上去 —— 调用方保留锚点、响亮失败。这道围栏的保护持续到锚点被(确认归档后)带围栏删除为止:每次登记事务内**现读** pending 表,不依赖缓存。

**覆盖语义被删除**,理由:(a) 它正是「一 issue 多 thread」的又一条制造路径(被覆盖的旧正主从此无人认领);(b) 生产**没有调用方依赖它** —— `lead-rules-base/`、`flywheel-comm` 对 `chat-threads/register` 零引用,`/api/runs/start` 的 `chatThreadId` 在代码库里只有读者没有生产者(`bootstrap-generator.ts` 等只读),`chat-thread-register.test.ts` 也只断言幂等重登与跨 issue 409,**没有覆盖用例**;(c) 「一 issue 一 thread」本来就是 FLY-892 定下的不变量,repoint 与之矛盾。原第 6 步的 "Overriding …" warn 一并删除。

`upsertChatThread` 本身仍一字不改,只是登记路径不再直接调它。

### 2.5d `/send` 的 existing 分支必须给共存态一个恢复入口(R4 HIGH-3)

`tools.ts:838-858`:`/api/chat-threads/send` 一旦查到正主行就**故意跳过** `ensureChatThread()`,只 backfill 名字后直接发。于是「正主 `c` + 锚点 `p`」这个最需要清理的状态(恰好来自 §2.5c 的竞态或 Creator 崩溃窗口),不会因为后续任何 Lead `/send` 进入 §2.5;若之后再没有新的 `session_started` / `/create`,活着的 `p` 会无限期留在侧栏 —— 违反验收的「只有一条可见 thread」。

⇒ `ChatThreadCreator` 暴露 `reconcilePendingForCanonical(ctx, canonicalThreadId)`:

- **快路**:待确认表查不到 ⇒ 立即返回,只多一次本地 SELECT,不发任何 Discord 请求、不改 HTTP 形状。
- 查得到 ⇒ 跑 §2.5 状态机(同一段代码,不另写一份)。结果对 `/send` 的影响(R5 HIGH-1 钉死):
  - 状态机把 thread 修好或确认存在(含同 id `absent`+root present 重试②成功)⇒ 照常发送;
  - 同 id 且 `pending_root_gone`(thread absent + 根消息明确 404)⇒ **跳过发送**,502 带类型化错误 —— 往一个已证不存在的 channel 发消息不是「照常」,是把恢复信号丢进 404;
  - 其余失败(transient / denied / 归档失败等)⇒ 只记日志,照常发送(正主若真不存在,发送自身的 404 已是响亮失败)。

`/send` 的 existing 分支在 `backfillThreadName` 旁边调用它。`tools.ts` 进改动清单。DirectEventSink 的路径本来就走 `ensureChatThread` 的 0️⃣ 步,已覆盖。

### 2.6 提升必须事务化 + root 围栏(R2 HIGH-2)

「先 check 再 upsert」在两个 SQLite 连接之间不是条件写:`/register` 可以在 check 与 upsert 之间插入正主,而 `upsertChatThread` 的 delete-first 会把刚注册的正主删掉。

⇒ 提升做成 **StateStore 里的单个事务** `promotePendingChatThread(issueId, channelId, expectedRootId)`,内部重读正主与锚点,返回类型化结果:

| 返回 | 语义 |
|---|---|
| `promoted` | 正主原本不存在(或只有墓碑,见下)⇒ 写入正主 + 删锚点 |
| `already_same` | 正主已存在且 == 我 ⇒ **同一事务内先把正主的 `lead_id` 更新为锚点行的 owner,再删锚点**(R6 MEDIUM-2;R7 MEDIUM-2:只更新 `lead_id` —— `chat_threads` 没有也不加 `project_name` 列,project 来源**只活在 pending 生命周期内**供 winner-token 解析,正主收敛后由既有 archive resolver 继续从 session/request 拿 projectName:own-key same-id 登记可能把 caller 的 `lead_id` 写进正主 —— 共享频道里 caller 可以是 gamma 而锚点 owner 是 alpha;锚点一删,archive 路径就会按错误 provenance 解析 token)|
| `canonical_conflict` | 正主存在但 != 我 ⇒ **不写、不删**,交给 §2.5 的耐久归档路径 |
| `claim_lost` | 锚点的 `root_message_id` 已不是 `expectedRootId` ⇒ 什么都不做,调用方重读 |
| `thread_taken` | 目标 `thread_id` 已被另一条物理正主行(别的 issue)占用(R5 HIGH-3)⇒ 不写、不删锚点,调用方响亮失败 |

**必须按物理行判断,不能按可见行(R3 HIGH-2)。** `getChatThreadByIssue` 过滤 `discord_missing_at IS NULL`(`StateStore.ts:9772`),而 `markChatThreadMissing` **只 UPDATE、不删行**(`:9843`)—— 墓碑行仍然占着 `idx_chat_threads_issue_channel` 这个唯一索引槽。现有的「thread 在 Discord 被删掉后重建」之所以能工作,靠的正是 `upsertChatThread` 的 delete-first。

如果 `promotePendingChatThread` 按「可见行不存在就 INSERT」来写,会撞唯一约束或被误报成冲突 ⇒ **回归掉一个有测试覆盖的既有行为**(`ChatThreadCreator.test.ts` 的 "recreates thread when existing one returns 404"、`StateStore.test.ts` 的 "can create new thread after marking old one missing")。

⇒ 事务内部扫**该键的全部物理行**:

- `discord_missing_at IS NULL` 的活行 → `already_same` 或 `canonical_conflict`
- `discord_missing_at IS NOT NULL` 的墓碑行 → **可在同一事务内删除/替换**,再插入 expected root(仍受 root 围栏约束)

**`upsertChatThread` 本身一字不改。**

**所有变更操作一律带 root 围栏**:`recordPendingChatThreadAttempt` / 删除 / 放弃都必须 `WHERE root_message_id = ?`,并返回 CAS 是否命中;`tombstoneSameIdCanonical` 是**双**围栏(正主==expected **且** 锚点 root==expected,任一失配 no-op)—— 它与既有 `markChatThreadMissing`(`StateStore.ts:9841-9852`,单条件按 thread_id UPDATE)形态不同,不能复用。否则有 ABA:A 证明旧 root `p` 没了、删除并 claim 新 root `a`;B 随后无围栏 `deletePending(issue, channel)` 把 `a` 删掉 ⇒ 两条分支各开一条 thread。

`claimPendingChatThread` 的 `INSERT … ON CONFLICT DO NOTHING` **加胜者回读**也必须在**同一个事务**里。

**归属权与 token(R4 MEDIUM-5 → R5 HIGH-2 修正)**:

- 提升时写入正主的 `lead_id` 取**胜者锚点行**里持久化的那个,不用败者上下文的 `ctx.leadId`(保持与「锚点是谁发的」一致,便于事后取证)。
- **R4 的「一频道一 bot」断言被 R5 推翻,收回**:`validateChatThreadParams` 只验证正向 `lead.chatChannel == channelId`,不保证反向唯一;`chat-thread-routes.test.ts:44-68` 明确有 `lead-alpha` / `lead-gamma` 共享 `ch-100` 且 token 不同;archive 路由(`tools.ts:1023-1027, 1120-1128`)与 `done-thread-archiver.ts:812-842` 的 `resolveBotTokenForThread` 本来就按 thread 记录的 `lead_id` 解析 token —— 共享频道 / 换 Lead 是既有现实,不是假想。
- ⇒ **对胜者锚点的操作(探针 / 第 ② 步重试 / 归档)按锚点行的 owner 解析 token**,且 owner 身份必须带 project 维度(R6 HIGH-1:同一 `agentId` 可合法出现在多个 project —— `ProjectConfig.ts:625-631` 唯一化的是 `${projectName}-${agentId}` 而非 `agentId`,`bootstrap-generator.test.ts:796-825` 明确钉住这个受支持场景;`(leadId, channelId)` 全局扫描在两个 project 配同 agentId 同 channel 不同 token 时会静默拿第一个):
  - 锚点行持久化 **`project_name`**(claim 时从 `ctx.projectName` 写入;`ChatThreadContext` 加可选 `projectName?: string`,三条入口都有现成来源 —— `/send`/`/create` 的请求校验本就带 projectName,`DirectEventSink` 有 `env.projectName`)。
  - `ChatThreadCreator` 构造器加**可选** `resolveLeadToken?: (projectName: string, leadId: string, channelId: string) => string | undefined`(不传 = 现状,既有测试零改动);composition 在 `plugin.ts:5219` 与 `run-infra.ts:947` 注入:先按 `projectName` 选 project,再在该 project 内找 `lead.agentId == leadId && lead.chatChannel == channelId` —— 与 `resolveBotTokenForThread`(`done-thread-archiver.ts:812-842`)同构的两段式解析。
  - resolver 未注入、锚点行缺 `project_name`(如 ctx 没传)、或查不到 ⇒ **显式回落 `ctx.botToken`**(声明的 fallback,不是数组第一项冒充 owner)。
- **败者删除自己刚发的根消息仍用 caller token**(那条消息就是 caller 的 bot 发的,身份天然正确)。

### 2.7 锚点永不自动丢弃 —— 根消息没了也只响亮失败(R2 HIGH-3 → R4 HIGH-4 收紧)

R2 把「根消息 404 ⇒ 可以重来」收紧成「thread absent → 根消息明确 404 → thread 再 absent」的三重证明。R4 指出**这仍不是证明**:Discord 官方只保证「thread id == 源消息 id、一条消息最多一条 thread」,**没有**保证 Start Thread、message GET、channel GET 之间的线性化/读后写一致性。一个已被 Discord 接受、但在我们两次 negative probe 之间都还不可见的 start 请求,理论上仍可能在第二次 `absent` 之后落地;此时删掉旧锚点去新建根消息,就丢掉了旧 root 的唯一恢复钥匙 —— §2.5 自己都承认「probe 404 之后请求仍可落地」,多读一次并不能关上这个窗口。

⇒ **删掉自动重锚。**

| 探针结果(thread) | 根消息探针 | 动作 |
|---|---|---|
| `confirmed` | — | 提升(或有正主时进 §2.5) |
| `absent` | `present` | 对**同一条**根消息重试第 ② 步 |
| `absent` | 明确 `404` | **保留锚点**,本次返回失败,错误类型 `pending_root_gone` |
| `absent` | `transient` / `denied` | 保留锚点,返回失败 |
| `transient` / `denied` | — | 保留锚点,返回失败 |

**类型化错误的合同(R5 MEDIUM-4,钉死)**:`ChatThreadResult` 增加两个**可选**字段 `errorCode?: string`(稳定机器可读,如 `"pending_root_gone"`)与 `rootMessageId?: string`;`error` 仍是人读 string(§2.10 的三字段语义不变,新增字段纯附加)。`/create` 与 `/send` 的**错误**响应把这两个字段附加进既有 `{ error }` body(`tools.ts:879-883` 现状只有 `error`);健康路径响应零变化,R16 仍按健康路径逐字断言。R8 / R13 / R20 断言**完整的 HTTP 错误 body**(status + error + errorCode + rootMessageId),不只断言内部 result「有类型」—— 人工放弃靠这个 body 拿 root id。

**放弃锚点是人工动作**,且只有一个入口:已有的带 root 围栏的 `deletePendingChatThread(issue, channel, expectedRootId)` 原语。不加 HTTP 端点、不加 CLI 子命令;运维手册(实现 PR 里的 `doc/engineer/implementation/` 一页)给出一行只读核对 + 一行带围栏的 `sqlite3` 删除。进入这条路的前提是**有人手工删了一条没有 thread 的根消息**(Bridge 自己只删败者自己的根消息,绝不删胜者的,见 §2.8),对称地由人来收尾是合理的;失败是响亮的(每次 `/send` 都 502 且带类型),不会静默。

**没有重试计数器、没有过期时间。** 内存计数器重启即失忆,而「计数到了就丢」正是会重造 bug 的做法。`last_error` / `last_attempt_at` **持久化在表里**,只用于取证。

这一条比 R2 版本**少一段代码、少两个测试用例**(R8 的三重证明与「两次探针之间出现」变体),换来的是不再依赖一条 Discord 没承诺过的顺序保证。

### 2.8 败者删除必须有界,且不影响正确性(R2 MEDIUM-4)

现有 `deleteDiscordMessageInChannel()`(`discord-utils.ts:247`)**没有任何超时/AbortSignal** —— 直接 await 它可能把共享的 ensure/inflight promise 无限期挂住。

⇒ 用**有界**删除(自带 AbortController)。`204` / `404` 视为已清理;`超时 / 网络 / 403 / 429 / 5xx` 记日志后**立刻带着胜者锚点继续**。

**正确性不依赖删除成功** —— 不变量是「败者分支绝不用自己的 id 调第 ② 步」。删除只是清垃圾。最坏残留:一条没有 thread 的根消息,**绝不是一条多余的 thread**。

### 2.9 计时器分段

`createChatThread` 拆成两个独立步骤,**每步各自一个 AbortController,数字仍是 5 秒不动**。

- 现在:第 ① 步花 4.5 秒,第 ② 步只剩 0.5 秒 —— 几乎注定失败。
- 之后:两步各有完整预算。

**代价**:最坏 5s → 10s,`session_started` 会等。可接受 —— 幂等之后慢一次只是慢一次。

⚠️ **不调大 5 这个数字。** load 88 下 abort 常来自**事件循环被饿死**而非网络慢(research §3.4)—— 响应可能早躺在 socket 缓冲区没人读。改成 15 只是让计时器晚一点在同样饿死的循环里触发。**唯一稳的解法是可重放。**

### 2.10 `created` 的语义(R2 MEDIUM-5;R6 MEDIUM-3 修正表述)

`ChatThreadResult` 的**完整**契约(附加式扩展):`{created, threadId?, rootMessageId?, error?, errorCode?}` —— 原三字段的**语义**与健康路径响应逐字不变,`errorCode` / `rootMessageId` 是纯附加的可选字段(§2.7 的类型化错误合同)。「不变」限定为原字段语义与健康响应,不是字段集合。`created` 语义钉死:

- `created: true` —— **仅当本次逻辑 ensure 亲自完成了 start-from-message**。
- `created: false` —— 复用既有正主 / 探针认领了已存在的 thread / 并发调用方先提升了。

R2 / R3 / R10 / R13 都要断言这个值。

### 2.11 崩溃语义(明说,不藏)

Discord 的 POST 和 SQLite 写**不可能**同事务。三个窗口:

| 崩溃点 | 后果 | 可恢复? |
|---|---|---|
| 根消息已被接受、msgId 未落盘 | 频道多一条**没有 thread 的根消息**;下次从 ① 重来 | **不可约减**。只多一条消息,**绝不多一条 thread** |
| 锚点已落盘、thread 未建 | 下次 ensure 用同一 msgId 重试 ② | 是 |
| thread 已建、未提升 | 下次 ensure 探针确认后提升 | 是 |
| 正主已写、锚点未删 | 下次 ensure 进 §2.5 状态机(`already_same` 分支)干净收敛 | 是 |

**惰性恢复,不加开机对账、不加定时任务。** 前提两条:①待确认行对所有既有读者不可见;②每条面向用户的发送都会经过恢复入口 —— 没有正主时 `/send` 调 `ensureChatThread`(0️⃣ 步);**有正主时** `/send` 的 existing 分支调 `reconcilePendingForCanonical`(§2.5d,R4 修正:原文「查不到正主就会 ensure」只覆盖了一半,共存态此前没有入口)。

**残留**:某 issue 若从此再无任何 `ensure`,锚点会一直挂着。它对所有读者不可见,除占一行无任何影响。**明确接受,不为它加巡检。**

---

## 3. 改动清单

| # | 文件 | 改什么 | 规模 |
|---|---|---|---|
| 1 | `packages/teamlead/src/StateStore.ts` | 新表 `pending_chat_thread_creations(issue_id, channel_id, root_message_id, lead_id, project_name, created_at, last_attempt_at, last_error, PRIMARY KEY(issue_id, channel_id), UNIQUE(root_message_id))`;**只在 `migrate()` 里一处 `CREATE TABLE IF NOT EXISTS`**(`StateStore.create()` 每次打开都跑 `migrate()`:create 定义在 `StateStore.ts:~1600`,`migrate()` 定义在 `:2696`,`:1979` 是 corruption-recovery 的再调用 —— R5 更正定位;全新 side table 靠它同时服务新库与旧库,**不再另加显式 migration helper** —— 那些 `migrateChatThreads*` 只用于给既有表补列,R4 LOW-7)。schema 含 `project_name` 列(R6 HIGH-1)与 `root_message_id` 全局 `UNIQUE` 索引(R5 HIGH-3)。事务化 + root 围栏的原语:`claimPendingChatThread`(单事务 INSERT…DO NOTHING + 胜者回读 + 正主围栏)、`promotePendingChatThread`(单事务,**5 种**类型化返回:`promoted` / `already_same` / `canonical_conflict` / `claim_lost` / `thread_taken`,按物理行处理墓碑,`already_same` 同事务改正主 owner)、`getPendingChatThread`、`recordPendingChatThreadAttempt(…, expectedRootId)`、`deletePendingChatThread(…, expectedRootId)`、**`tombstoneSameIdCanonical(issue, channel, expectedId)`**(R7 HIGH-1,条件墓碑化,正主==锚点 root==expectedId 才动,否则 no-op);**新增** `registerChatThreadConditional(threadId, channelId, issueId, leadId)`(§2.5c,不同活正主 ⇒ `canonical_exists`)。**`chat_threads` 表结构与 `upsertChatThread` 一字不改** | 中 |
| 2 | `packages/teamlead/src/bridge/thread-validator.ts` | **新增**无副作用三态 `classifyThreadExistence()` 与 `classifyMessageExistence()`。既有布尔 `validateThreadExists` 一字不改 | 小 |
| 3 | `packages/teamlead/src/bridge/discord-utils.ts` | 给删除加**有界**变体(AbortController),或给 `deleteDiscordMessageInChannel` 加可选 `timeoutMs`(不传 = 现状行为,保持字节兼容) | 小 |
| 4 | `packages/teamlead/src/bridge/chat-thread-utils.ts` | 拆出 `postThreadRootMessage()` + `startThreadFromMessage()`,各自独立计时。**`createChatThread` 组合版改为内部/测试专用**(R2 LOW-7:生产仅 `ChatThreadCreator` 一个调用方,留着是给未来调用方的地雷),并在第 ② 步结果不明时**把 root id 一并返回**,让调用方不可能静默丢锚 | 中 |
| 5 | `packages/teamlead/src/bridge/ChatThreadCreator.ts` | `_doEnsure` 按 §2.3–§2.10 重写;**新增** `reconcilePendingForCanonical(ctx, canonicalThreadId)`(§2.5d,与 0️⃣ 步共用同一段状态机);构造器加**可选** `resolveLeadToken` seam;`ChatThreadContext` 加可选 `projectName?: string`(三条入口传入,§2.6) | 中 |
| 5b | `packages/teamlead/src/bridge/plugin.ts:5219` + `bridge/run-infra.ts:947` | 构造 `ChatThreadCreator` 时注入 `resolveLeadToken`:**先按锚点行的 `projectName` 选 project,再在该 project 内匹配 `agentId + chatChannel`**(R7 LOW-3,两段式,不做全局扫描) | 小 |
| 6 | `packages/teamlead/src/bridge/chat-thread-register.ts` | 第 6–7 步改为调 `registerChatThreadConditional`;删除 "Overriding …" warn;`ok:false, status:409, error` 形状沿用既有 | 小 |
| 7 | `packages/teamlead/src/bridge/tools.ts` | `/api/chat-threads/send` existing 分支在 `backfillThreadName` 旁加 `reconcilePendingForCanonical`:**除 `pending_root_gone` 外**失败只记日志、照常发送;`pending_root_gone` ⇒ **跳过发送**,返回 typed 502(§2.5d / R20(v));健康路径 HTTP 形状不变,错误 body 附加 `errorCode` / `rootMessageId` | 小 |

**不新增**:常驻巡检、定时任务、告警类型、feature flag、环境变量、HTTP 端点、CLI 子命令。(R4 曾写「不加 resolver / 不改构造器」,R5 HIGH-2 以共享频道的源码反证推翻 —— 改为**可选** resolver seam,不传 = 现状。)
**`chat_threads` 零 schema 变更、零数据回填、零读者改动。**

> **存量孤儿清理不在本 PR 内**(R2 MEDIUM-6)。它是独立的 Phase B:另开 issue、独立评审、独立 PR,**不 gate 也不搭车**本次生产修复。本 PR 到「代码 + 测试 + 独立 QA」为止。现状记账:活跃孤儿 4 条(FLY-1597 / FLY-1640 / FLY-1867 / FLY-1925),归档孤儿 62 条。

---

## 4. TDD

RED → GREEN → REFACTOR。经 `fetchImpl` 测试缝注入,不打真 Discord;超时用**注入的短预算 / 假计时器**,不用真 4.9 秒 —— load 88 的机器上真计时器必然 flaky。

**先修 fixture**:现有 `packages/teamlead/src/__tests__/ChatThreadCreator.test.ts` 用 `msg-123` / `thread-abc` 两个不同 id,与 id 恒等不变量矛盾。改成相同 id;实现**忽略第 ② 步响应里的 id、一律用根消息 id**,若响应 id 不同则 fail-loud。该文件已有的 "thread creation from message fails"(第 ② 步 500)用例保留,但断言改为 R6c 的语义。

`packages/teamlead/src/__tests__/fly1927-thread-create-idempotency.test.ts`

| 用例 | 构造 | 断言 |
|---|---|---|
| R1 **重现** | ①成功→msgId;②abort | 待确认表**必须有一行**且 `root_message_id === msgId`(旧代码零行 ⇒ 红) |
| R2 **重放不多建** | 接 R1,再 ensure,探针 `confirmed` | 全程**只发生一次** `POST /messages`;正主 === msgId;`created === false` |
| R3 **②真没成** | 接 R1,探针 `absent` | 重试 `POST /messages/{msgId}/threads`,**不是** `POST /messages`;成功后 `created === true` |
| R4 **两步各自计时** | ①耗尽预算后成功(注入短预算) | ②仍拿到完整预算(旧代码此处必 abort ⇒ 红) |
| R5 **4xx 退回探针** | ②返回 400;探针 `confirmed` | 判为已建成并提升,不重建 |
| R6 **transient 不误判** | 探针 429 / 5xx / 超时 | **不提升**;锚点保留;`last_error` 落盘(用旧 fail-open validator 这里必绿 ⇒ 反证必须换探针) |
| R6c **② 一切非 2xx 同一条路**(R4 MEDIUM-6) | ② 分别返回 408 / 429 / 500(探针 `absent`) | 三种都:锚点保留、`last_error` 带围栏落盘、**`POST /messages` 计数不变**、恰好一次探针、本次返回失败 |
| R7 **denied 不重锚** | ②持续 403 | 永不重发根消息,调多少次都不 |
| R8 **根消息没了也不重锚**(R4 HIGH-4) | thread `absent` → 根消息明确 404 | **不删锚点、不重发根消息**;返回失败且错误类型 `pending_root_gone`;再调一次仍相同;只有带正确 root 的 `deletePendingChatThread` 之后,下一次 ensure 才从 ① 重来 |
| R8b **根消息探针 transient** | 根消息 GET 超时 / 429 | 不当作「没了」,锚点保留 |
| R9 **锚点跨重启存活** | 文件型 DB;R1 后新建 StateStore + Creator | 仍认领同一 msgId,不重发根消息 |
| R10 **CAS 竞态** | **两个独立打开、指向同一文件**的 StateStore + 两个 Creator 同时 ensure | 只有一个胜者;败者删自己的根消息、改用胜者锚点;**只产生一条 thread**;`created` 只有一方为 true。变体:败者删除超时 / 403 / 5xx —— 均不影响结论 |
| R10b **ABA 围栏** | 人工按 §2.7 对旧 root `p` 做带围栏放弃(StateStore 级 `deletePendingChatThread(…, p)`),随后新一轮 ensure claim 了新 root `a`;并发的 B 仍拿旧 root `p` 去删 | B 的删除**不命中**(围栏),新锚点 `a` 存活。(R5 LOW-5:原措辞「A 重锚」已随自动重锚一起删除,这里明确是人工放弃后的正常重建) |
| R11 **共存状态机** | (a) 正主 == 锚点且探针 `confirmed` (a′) 正主 == 锚点但探针 429 / 5xx / 超时 / 403(R4 HIGH-2) (b) 正主 != 锚点且探针 confirmed 但**归档超时/429** (c) 正主 != 锚点且探针 absent | (a) 删锚点不归档;(a′) **锚点保留**,正主照常返回;(b) **锚点保留**待下次;(c) 不开不删 |
| R11b **提升前正主已就位** | `/register` 在 `promotePendingChatThread()` **开始之前**提交(better-sqlite3 是同步事务,「读与写之间」在同一事件循环内不是可实现的调度点 —— R3 MEDIUM-3) | 返回 `canonical_conflict`;**既有正主未被删除** |
| R11c **墓碑不挡重建** | 已有 `discord_missing_at IS NOT NULL` 的墓碑行 | promote 返回 `promoted`,墓碑在同事务内被替换;**并保留两条既有测试**(端到端 `ChatThreadCreator.test.ts:283` + CRUD `:1477`,fixture 改成 root/thread id 相同) |
| R11d **SQLITE_BUSY 不被混淆** | 跨连接锁竞争 | 显式作为 busy/超时处理,**不得**被当成 `canonical_conflict` |
| R18 **claim 对正主设围栏**(R3 HIGH-1) | (a) 根消息 POST 之后、claim 之前 `/register` 提交正主 (b) B 的 claim 发生在 A 已提升并删掉锚点**之后** | 两种调度下 B **都绝不调用 start-from-message**;claim 分别返回 `canonical_present` / `canonical_present`;B 有界删掉自己的根消息 |
| R19 **登记不得反向覆盖**(R4 HIGH-1) | `/register(c)` 的 Discord 校验先开始(注入挂起的 fetch);Creator 把锚点 `p` 提升为正主并提交;再让 `/register` 的校验返回 | `/register` 得 409 `canonical_exists`(body 带 `p`);正主仍是 `p`;`p` 仍被登记表持有。同样覆盖 `/api/runs/start` 带 `chatThreadId` 的路径(不传 botToken) |
| R19b **登记的正常路径不回归** | 无正主 / 只有墓碑 / 同 id 重登 | 分别 `ok` / `ok`(墓碑同事务替换)/ `ok` 幂等;跨 issue 仍 409;既有 `chat-thread-register.test.ts` 全绿 |
| R19c **登记不得偷 foreign pending root**(R5 HIGH-3) | (a) A 持有活锚点 `p`,`/register(p, issue=B)` (b) 同 key 自己的 `p` 登记 (c) promote 目标撞另一 issue 的物理正主行 | (a) 409 `pending_root_conflict`,A 的锚点原样;(b) `ok`,形成共存,同 id 分支后续收敛,**收敛后断言 `canonical.lead_id === pending.lead_id`(而非 caller)**;(c) `promotePendingChatThread` 返回 `thread_taken`,锚点保留、无 UNIQUE 异常泄漏 |
| R20 **`/send` 共存态有恢复入口**(R4 HIGH-3 + R5 HIGH-1) | 有正主 + 锚点,调 `/api/chat-threads/send` | **异 id**(`c != p`):(i) 探针 `confirmed` ⇒ 归档 `p`、删锚点,消息仍发到 `c`;(ii) `transient` ⇒ 锚点保留,消息仍发到 `c`。**同 id**(`c == p`):(iii) `confirmed` ⇒ 删锚点、发送成功;(iv) `absent`+root present ⇒ **只重试②**(不重发根消息),成功后发送成功;(v) `absent`+root 明确 404 ⇒ **不发送**,502 body 含 `errorCode: "pending_root_gone"` + `rootMessageId`,且正主被条件墓碑化(对正常读者不可见)而锚点保留;(v-b) 接 (v) 再次 `/send` ⇒ 仍 502 typed、零消息发出;(v-c) 接 (v) 人工带围栏删锚点后 `/send` ⇒ 走 `ensureChatThread` 从第 ① 步干净重建,恰一条新 thread;(v-d) 接 (v) 若旧 `p` 在放弃前迟到出现 ⇒ 下次探针 `confirmed`,经墓碑替换重新提升 **同一个** `p`,不另发根消息;(vi) `transient` ⇒ 锚点保留,照常尝试发送。**无锚点**:(vii) **零 Discord 探针请求**,请求序列与改动前逐字一致 |
| R21 **tombstone 双围栏失配 no-op**(R8 MEDIUM-1,直接 StateStore 级) | 调用前布置三种物理状态:(a) 锚点 root==expected 但活正主已是别的 id;(b) 正主==expected 但锚点已删/root 已变;(c) 两者都不匹配 | 三种都 **no-op**:正主行(含别的 id 的新正主)逐字段不变、`discord_missing_at` 不被写、锚点(若在)原样、别的 root 的 pending 不受影响;对照组:双匹配时**只** tombstone 正主、锚点保留。(mutant→RED 对应关系,R9 注释:逐字实现成 `markChatThreadMissing(expectedId)` ⇒ (b) 红;按 `(issue, channel)` 更新但漏 canonical-id guard ⇒ (a) 红 —— 两个 guard 各有一个 mutant 盯着) |
| R20b **共享频道 token 按 owner 解析**(R5 HIGH-2 + R6 HIGH-1) | 两个 Lead 共享同一 channel(fixture 同 `chat-thread-routes.test.ts:44-68`),锚点 owner 是 lead-alpha,caller 是 lead-gamma | 对锚点的探针/②重试/归档请求携带 **alpha** 的 token(注入 resolver 断言);败者删自己根消息用 **gamma** 的 token;resolver 未注入时回落 caller token(现状兼容);收敛后 `canonical.lead_id === 锚点 owner`。**跨 project 变体**:两个 project 配同 `agentId` + 同 channel + 不同 token,必须取**锚点行 `project_name` 那个 project** 的 token |
| R12 **待确认对所有读者不可见** | 有锚点,`chat_threads` 空 | `getChatThreadByIssue` / `getChatThreadByThreadId` / `getAllChatThreadIds` / `getUnarchivedIssueChatThreads` / `listDisplayReconcileCandidates` / `listDisplaySweepActiveIssues` **全部查不到** |
| R13 **`/send` 加入恢复而非 502** | 有锚点时调 `/api/chat-threads/send` | 走 `ensureChatThread` → 认领 → 发送成功 |
| R14 **落盘失败不留垃圾** | claim 抛错 | 第 ② 步**从未被调用**;异常上抛 |
| R15 **既有并发不回归** | 同 key 两个 ensure 同进程 | 只发一次 `POST /messages` |
| R16 **健康路径兼容** | 全程无超时 | Discord **请求序列 / URL / body / 顺序**与改动前逐字一致,HTTP 响应形状一致(兼容性定义为**外部请求与响应形状**,不是 DB 字节 —— 新表本就是新增) |
| R17 **migration** | 打开不含新表的旧库文件;再开第二次 | 建表成功;第二次幂等;`chat_threads` 存量行**一行未动** |

**已有测试不许回归**:`packages/teamlead/src/__tests__/ChatThreadCreator.test.ts`(R5 更正引用:`:283` 的 "recreates thread when existing one returns 404" 是**端到端** 404 重建流程;`:1477` 的 "can create new thread after marking old one missing" 是 StateStore 级 CRUD —— 两条都要保住,分别引用)、`ChatThreadCreator.attach-pin.test.ts`、`chat-thread-routes.test.ts`、`bridge/__tests__/chat-thread-register.test.ts`、`phase-chat-threads.test.ts`、`fly892-legacy-phase-thread-sweep.test.ts`、`StateStore.test.ts`。

**全仓硬门**(FLY-224/248 教训):`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`。

---

## 5. 实施顺序

1. RED:读者隔离(R12)+ migration(R17)+ 重启(R9)
2. 待确认表 + 事务化 root 围栏原语(claim / promote / attempt / delete / conditional-tombstone)
3. 三态探针(thread + 消息)+ 拆分两步 REST + 有界删除
4. `ChatThreadCreator`:认领 / 重试 / 提升 / 共存状态机 / `reconcilePendingForCanonical`
5. `chat-thread-register.ts` 条件登记(R19 / R19b)+ `/send` existing 分支接入(R20)+ `/create` 竞态测试(R13、R10、R10b、R11b)
6. 定向测试 + 全仓三门
7. 529 隔离房真 Discord E2E

---

## 6. 验收

| 验收项 | 怎么证 |
|---|---|
| 新建 issue 全流程只产生一条 thread | 529 隔离房真机:注入 issue → dispatch → session_started → Lead 通报,数该 issue 的 thread 数 == 1 |
| **超时也只产生一条**(本修复的核心) | 529 房故意让第 ② 步 abort,再让流程继续:thread 数仍 == 1,正主 == 那唯一一条 |
| 事件与 founder 对话落在同一条 | session_started 事件、stage 更新、Lead 通报三者目标 thread id 相同 |
| 登记正主 == founder 实际所见 | 该 issue 在 Discord 侧栏只有一条可见 thread |
| 生产零回归 | R16 兼容用例 + R17 migration 用例 + 全仓三门 |

**独立 QA**:本单改生产 Bridge 代码,必须过独立 QA 节点,且必须在 529 隔离房跑真 Discord E2E —— 尤其「注入超时后仍只有一条」,mock 测不能替代。

---

## 7. 风险与取舍

| 风险 | 处置 |
|---|---|
| 新增一张表 | `chat_threads` 零 schema 变更、零回填、既有读者一行不改 ⇒ **爆炸半径比原方案小**。不设 flag(Annie 铁律) |
| 跨进程竞态时败者多发一条根消息 | 有界删除尽力清掉。**正确性不依赖删除成功**(§2.8)。最坏留一条无 thread 的消息,**绝不多一条 thread** |
| 更强的 CAS(发消息前先占位)未采用 | 会引入「占位后崩溃 ⇒ NULL 锚点永久堵路」的新楔子,需要接管/过期机制。**性价比不值**,记账不做。Codex 也认同这个取舍 |
| Discord `enforce_nonce` 可折叠并发根消息 | **本次不用**:它会改动健康路径的请求体,且有同作者/重锚约束,需要单独的真 API spike。记账为后续可选项 |
| 待确认行永不确认(含根消息被人手工删掉) | 对所有读者不可见,只占一行。`ensure` 响亮返回失败(Lead 拿 502,带 `pending_root_gone` 等类型),不静默多建;放弃是带围栏的人工动作(§2.7) |
| `/register` 不再能覆盖既有活正主 | 生产零调用方依赖(§2.5c 已核:lead-rules-base / flywheel-comm 零引用,`runs/start` 的 `chatThreadId` 无生产者);409 带当前正主 id,调用方能看见 |
| 最坏耗时 5s → 10s | 已摆明(§2.9) |
| 重复 `POST …/threads` 的确切错误码未实测 | 设计**刻意不依赖它** —— 第 ② 步一切非 2xx 一律退回三态探针裁决。错误码实测放实现阶段的 529 房 |
| Discord 跨资源读后写一致性无官方承诺 | 设计**不依赖它**:去掉了唯一依赖它的自动重锚(§2.7);所有退休/重建动作只在 `confirmed` 之后发生 |

---

## 8. 明确不做

- ❌ **只调大超时数字** —— load 88 下 abort 常来自事件循环饿死,调数字不改性质。
- ❌ **常驻孤儿巡检 / 开机对账 / 新告警** —— 加报警器不是修结构;惰性恢复已足够(§2.11)。
- ❌ **按 thread 名字模糊匹配找回** —— 有 id 恒等这条硬不变量就不需要猜。
- ❌ **靠重试计数丢弃锚点** —— 那正是会重造 bug 的做法(§2.7)。
- ❌ **自动重锚(根消息 404 后自动新建根消息)** —— 依赖 Discord 没承诺过的顺序保证;删掉,改为响亮失败 + 人工放弃(§2.7)。
- ❌ **`/register` 覆盖既有活正主** —— 又一条制造孤儿的路,且生产无人用(§2.5c)。
- ❌ **存量孤儿清理** —— 另开 issue、独立 PR,不 gate 也不搭车本次修复。
- ❌ **顺手修 `resolvedIssueId` 回落隐患**(research §5.1)—— 真实但不是本次成因,单开一单。
- ❌ **追查 08-20 主机为何变慢** —— 修复不应依赖延迟消失。

---

## 9. 给 founder 的一句话结论

**这不是前两天引入的 bug。** 它从 2026-04-13 就在代码里,归档区能翻出 7 月以来 62 条同类残留。昨晚之所以突然显形,是因为连着建了很多 issue —— 这条路昨晚每建 10 次坏 5 次,平时一天只建十几次,撞不上就看不见。

修完之后,建 thread 会变成「重放多少次都只有一条」,和网络快慢、机器忙闲彻底脱钩。
