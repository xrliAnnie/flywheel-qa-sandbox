# FLY-1709 archive-once 死角与 no-op 假成功 — 探索

Issue: FLY-1709 (https://linear.app/geoforge3d/issue/FLY-1709/archive-once-死角agent-在归档-thread-发言后永远关不上-no-op-返回伪装成-archivedtrue)
日期: 2026-08-12
基于: 无

## 1. 问题陈述

Honey Lemon 2026-08-11 亲手复现、Annie 当晚连催的现象:一个 issue 的 Discord chat thread 一旦被归档过一次,之后被 bot 自己的发言弹开(Discord 对归档 thread 的新消息会自动 unarchive),就**永远关不上了**——所有调用方再调 `POST /api/chat-threads/archive` 都拿到 `archived:true, reason:already_archived, attempts:0`,看起来成功,实际什么都没做。

同晚出现的新标本(FLY-1680 thread,Annie 直接撞上):已收官、已按 founder 指令归档的 thread,被自动状态贴(issue-display 同步器)往里 POST 消息弹开,消息内容还渲染成「🔴受阻 [G]」——而那只是账面清理的 run terminate(PR #806 早已 merge),不是真受阻。

## 2. 缺陷分解(共 4 个修点)

审计后把 issue 描述的「两个缺陷 + 新标本两个修点」归纳为 4 个正交缺陷:

| # | 缺陷 | 位置 | 性质 |
|---|------|------|------|
| ① | archive-once 守卫分辨不出「谁重开的」——`archived_at` 一旦置上永不 re-PATCH,bot 自己弹开的 thread 也享受「founder 手动重开不抢」保护 | `done-thread-archiver.ts:107-128`(sink 守卫)+ `tools.ts:1119-1129`(endpoint 前置短路) | 守卫语义过宽 → 永久死角 |
| ② | no-op 返回值伪装成功——endpoint 前置短路直接回 `archived:true`,sink 守卫内部是 `archived:false` 但也标 `already_archived`;两处都没验证 Discord 真实归档状态 | `tools.ts:1121-1127` | 「什么都没做」与「已完成」不可区分 → agent 向 founder 报错话 |
| ③ | 自动状态贴无视归档状态往归档 thread 里 POST 消息(pin 状态机的 post 分支),把 thread 弹开 | `issue-display-refresher.ts` 三个 face 的写路径(经 `ChatThreadCreator` pin 状态机 `postAndPinAttach`) | 自动写手成为重开源 |
| ④ | `terminated` 一律渲染成 🔴受阻——已收官 issue 的账面清理 terminate 与真废弃不区分 | `issue-display.ts` `MAIN_BLOCKED_STATUSES` / `PHASE_BLOCKED_STATUSES` | 终态映射失真 → 误导 founder 追问 |

①+② 是死角本体;③ 是把死角触发出来的自动重开源;④ 是弹开后显示的内容也是错的。四个都修,死角才真正收敛。

## 3. 根因链(FLY-1680 标本复原)

```
run terminate(账面清理,PR 已 merge)
  → session 状态 terminated → issue-display 刷新触发
  → derivePhaseDisplayState/deriveIssueTitleBadge: terminated ∈ BLOCKED → 🔴受阻   【缺陷④】
  → 刷新器不查 archived_at,照常写三个 face                                        【缺陷③】
  → pin 状态机需要 POST 新消息(或 edit 404 后 repost)
  → Discord: 对归档 thread POST 消息 = 自动 unarchive → thread 弹开
  → founder 看见已收官 thread 弹开 + 「🔴受阻 [G]」→ 误导追问
  → 任何人再调 archive endpoint → archived_at 已置 → no-op 短路               【缺陷①】
  → 返回 archived:true 伪装成功                                                【缺陷②】
  → 永远关不上
```

FLY-1699/1688(product 频道)与 eng 频道 5 例(1671/1614/1693/1697/1701)是同一条链的变体:重开源不是状态贴而是 agent 的收尾发言(经 Lead relay,bot 身份),死角部分完全相同。

## 4. 设计选项与取舍

### 4.1 缺陷①:reopener 判定放在哪、怎么判

**放哪**:sink(`archiveThreadAndRecord`)。它是「The ONE place」——endpoint、close cascade、6h reconcile sweep、terminal 定向归档、post-ship 路径全部路过,且已有 per-thread 串行锁。endpoint 的前置短路(tools.ts:1119)直接删除,判定收口到 sink 一处。

**怎么判**(`archived_at` 已置时):
1. 先 GET thread 元数据(`thread_metadata.archived`):
   - Discord 说仍归档 → 诚实 no-op:`archived:true, reason:already_archived`(此时 already_archived 是**验证过的真话**);
   - Discord 说已打开 → 进入 reopener 分类。
2. reopener 分类:取 `archived_at` 之后的 thread 消息(`GET /channels/{id}/messages?after=<由 archived_at 合成的 snowflake>`):
   - **存在任何人类(非 bot)消息 → 不抢**:`archived:false, reason:founder_reopened`(诚实 no-op);
   - **全部是 bot 消息 → 允许 re-archive**:走正常 PATCH,成功后刷新 `archived_at`;
   - **分类失败(HTTP 错/超页上限)→ fail 向不抢**:`archived:false, reason:reopen_check_failed`。

**与 issue 原文的一处偏差(需 review 把关)**:issue 写的是「最新发言者是 bot ⇒ 允许 re-archive」。我们选了更保守的「archived_at 之后**存在任何**人类消息 ⇒ 不抢」。理由:latest-speaker 规则下,founder 重开聊了几句、随后任何一条 bot 消息(如 Lead relay 回复)落在最后,下一次归档尝试就会当着 founder 的面把她重开的 thread 关掉——这恰恰是「不抢」语义要禁止的。any-human 规则严格更偏向 founder,且对本 issue 的全部实证案例(bot-only 重开链)判定结果与 latest-speaker 一致。代价:founder 参与过的重开 thread 永远不会被自动关(需她本人或 Lead 手动)——这正是「founder 手动重开不抢语义一个字不改」的自然延伸。

### 4.2 缺陷②:诚实返回的口径

`archived` 字段的合同改为:**`archived:true` 当且仅当 Discord 侧验证过(本次 PATCH 成功,或 GET 确认仍归档)**。no-op 分支必须带可区分的 reason(`already_archived` 只留给验证过的场景;新增 `founder_reopened` / `reopen_check_failed`)。这与 FLY-1689「拒绝执行必须留响亮痕迹」同一条原则。audit 事件同步带上真实 outcome。

### 4.3 缺陷③:状态贴闸门

`IssueDisplayRefresher.refreshOnce` 取到 thread 行后,`archived_at` 已置 → **跳过全部三个 face 的 Discord 写**,并落 fingerprint(否则 sweep 每 tick 重试到永远)。legacy 逃生口路径(`stampStageEmojiForSession` / `pinRunnerAttachForSession`,`FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 时启用)加同款闸。

issue 给的另一选项「或发到主频道」被否:把已收官 issue 的状态噪音改投主频道只是换个地方打扰 founder,信息在 Linear 本来就有;「归档即静默」才符合「收官」语义。

**必要配套(审计发现,不加会引入回归)**:全仓**没有任何路径清除 `archived_at`**(`upsertChatThread` 的 ON CONFLICT 不碰它)。若只加闸门,归档过的 issue 一旦 rework(新 run 复用同一 thread),显示将被永久冻结,且缺陷① 的 any-human 规则会让该 thread 落入「永久不抢」陷阱(founder 在上一轮聊过的消息一直算数)。修法:**run-start 注册 thread 时(`upsertChatThread` upsert 命中)清 `archived_at`**——新 run = thread 重新进入活跃生命周期,归档账本随之重置。这是缺陷①③ 共同的生命周期闭环,不是 scope 蔓延。

### 4.4 缺陷④:「废弃」vs「收官后清账」

新增派生输入 `issueConcluded`(收官证据,三选一即真):
- `hasFinalizationCompletedForIssue(issueId)`(land_operation.finalization_completed_at / post_ship_finalization_completed 事件);
- 该 issue 存在 status ∈ {completed, merged} 的 session 行(小查询,不加表);
- thread `archived_at` 已置(归档过 = 收官过,FLY-1680 即此形态)。

映射修改**只动 `terminated`**:`terminated && issueConcluded` → main badge 渲染 ✅completed、phase state 渲染 done;`failed` / `blocked` / `rejected` 一律不变(真废弃、真受阻必须还是红的)。`terminated && !issueConcluded`(真放弃)也保持 🔴受阻不变。

## 5. 明确不做(边界)

- 不加新表、不加新 env flag、不加周期任务:6h reconcile sweep 与 terminal 定向归档**不扩**到 `archived_at` 已置的 thread(避免无界 Discord 探测增长)。bot 重开的 thread 靠下一次归档触发(endpoint / close / reap / agent 的 post-then-archive 自然序列)收敛——观察到的实证序列恰是「发完最后一条 → 调 archive」,修后这一调用就真正 re-archive,即收敛。
- 「founder 手动重开不抢」语义一个字不改(见 4.1,只会更保守)。
- 不动 Lead 主动通信路径(/send、gate relay 等):Lead 有意往归档 thread 发消息把它弹开,是 Discord「重新使用」的正常语义,不属于「自动状态贴」。
- 不动 milestone-report-policy 的「⛔受阻」词表(那是给 milestone 报告用的,与 thread 终态映射无关)。

## 6. 锁定方向

四个修点按 4.1–4.4 落:sink 收口 reopener 判定 + 全链诚实返回 + 刷新器归档闸(含 run-start 清 `archived_at` 配套)+ terminated 收官映射。零新表、零新 flag、零新周期负载。
