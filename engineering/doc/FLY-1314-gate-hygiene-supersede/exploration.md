# FLY-1314 gate 卫生:auto-supersede + 单活跃 gate 不变式 — 探索
Issue: FLY-1314 (https://linear.app/geoforge3d/issue/FLY-1314/infra-gate-卫生head-变更后旧-gate-不自动-supersede-同-issue-多-gate-并存-founder)
日期: 2026-07-16
基于: 无

## 1. 问题定义

2026-07-16 一晚三个活案,同一根因的三种表现:

| 案 | 现场 | 表现 |
|---|---|---|
| FLY-1309 | issue 同时挂 3 个 open gate(implement approve `8b79b7d8` + QA approve `f0edf64e` + 陈旧 review gate `b5099f9e`,后者早被后续轮 APPROVED 取代但永远 pending) | Annie 回单字母「a」→ `founder_reply_ambiguous`(matching≥2 拒猜)→ 只能人工 relay + Lead 代执行 merge。stale gate 还把 implement 的 `complete --route blocked` 卡死(pending-gate 守卫拒绝) |
| FLY-1182(运行事故,非该单内容) | re-review 换 head 后旧 gate `15fe316e` 没自动 supersede | runner 停下来做 gate bookkeeping,浪费一轮 |
| FLY-1307(运行事故) | QA docs commit 移动 head 后旧 approve gate `e4f9aa95` 悬空 | 需 Lead 手工作废 + 重开 |

**根因**:gate 生命周期没有「替代关系」。新一轮 review/approve gate 开出时,同 issue 同类型的旧 gate 不会被标 superseded;founder 回复绑定候选集把所有 pending question 全量算入;terminal 路由把 pending 旧 gate 当阻塞条件。

issue 评论区另有四条同晚素材(#3/#4/#5/#6),Tadashi 在 brainstorm gate 裁定「不许静默掉,plan 逐条声明 in/out + 归属」——见 §5。

## 2. 代码审计:现有机制到底覆盖到哪

审计结论(细节及行号见 research.md):

1. **supersede 原语已存在,触发面太窄。** `retireShipGate`(FLY-1041)与 `retireQuestionGuarded`(FLY-1099)都是双保险 retire(只动 unanswered,置 `expires_at=now` + `terminal_disposed`,留行审计)。但触发点只有:
   - `event-route.ts` `retireSupersededShipGate` — **同一 session** 的 review-binding 换绑时 retire 旧 qid;
   - `gate-poller.ts` `maybeSweepSupersededShipGate` — 同样以 **session.review_question_id** 为键的兜底 sweeper;
   - zombie-gate-hygiene(FLY-1099 §5)— 只处理 **session 已死** 的 gate;
   - mergedGateGuard(FLY-1238)— 只处理 **PR 已 merge** 的 ship gate。
   → **跨 execution、跨轮次、gate-type 级的 supersede 完全缺席。**
2. **review gate 是结构性孤儿。** `review_design`/`review_code` 被 FLY-1257 刻意豁免于 finalizeSession / zombie-hygiene / GatePoller eviction(它由 cross-family reviewer 应答,必须活过 author session)。豁免正确,但**没有任何机制在新一轮 review 注册后收掉旧轮 pending gate** → FLY-1309 的 `b5099f9e` 永远 pending。
3. **founder 绑定候选集不分语义。** `founderReplyDeliverPass` 用 `getPendingQuestions(lead)` 全量,只排 `kind='report'`(FLY-1041 Chunk 9)。review gate 本来就不由 founder 应答,却照样抬高歧义分母(`matching.length >= 2` 即 ambiguous)。
4. **前置三单都把这个洞显式 defer 了。** FLY-1041 RC-1(多 awaiting_review session / 多 gate per issue = 已知风险未修)、FLY-1099(narrow_multi 归因增强点名为「1041 家族续集」不做)、FLY-1251 §5.4(run 级 single-active 键控 defer 给 FLY-1211 伞下子单)。FLY-1314 正是补这个空档的单。

## 3. 方案空间

### 3.1 触发点放哪(决策 b)

| 选项 | 优点 | 缺点 |
|---|---|---|
| A. gate CLI 开门时原子 retire(insertQuestion 事务内) | 单一出生点,不变式强 | CLI 写不了 StateStore 审计;覆盖不了 crash 后遗留;改动辐射到所有 runner |
| **B. Bridge sweeper 每 tick 收敛(选定)** | 审计写权在 Bridge;覆盖 crash/手工 gate 全形态;CLI 零改动 | 新旧 gate 并存窗口≈一个 poll tick |
| C. 双写(A+B) | 最严 | 复杂度不成比例 |

选 B。代价明确:worst case = founder 消息在并存窗口撞进来歧义一次,下 tick 收敛(founder 消息本有 15s ship-grace / 10min 通用 grace,窗口远小于 grace)。

### 3.2 supersede 语义

- **键**:(issue, gate-family)。gate-family 只覆盖三个**非阻塞长命族**:`approve_to_ship` / `review_design` / `review_code`。
- **规则**:newest-wins——同键存在**更新的 gate(pending 或已 answered 均算 supersessor)** → 更老的 pending gate retire。
  - 「answered 也算 supersessor」是 FLY-1309 形态的命门:`b5099f9e` 正是被后续轮已 APPROVED 的 gate 取代,只比 pending 会漏掉它(Tadashi 确认)。
- **排序**:`created_at` 只有 1s 分辨率(FLY-191 已知坑),同 DB 内用 `rowid` 破同秒(messages 非 WITHOUT ROWID,rowid 单调=插入序)。
- **阻塞族明确不动**:`brainstorm` / `question` 是 blocking gate,runner 在原地 poll `getResponse`;retire 它会把活着的 runner 钉死到 timeout。它们由 gate 自身的 timeout/resolve 机制自清洁(Tadashi 确认)。

### 3.3 跨 execution 生效(决策 a)

QA/re-review 开新 gate 即 supersede implement 的旧 gate。被 superseded 的 session 停在 awaiting_review、其 verify-approval 天然 fail-closed(bound gate 已 retire → 拒绝 ship)——**这条 fail-closed 是承重点,plan 必须写明并加测试**(Tadashi 要求)。不额外 wake 被 superseded 的 session(防双 actor 抢 ship);issue 终态清理照旧收尸。

### 3.4 founder 候选集排除 review gate

`founderReplyDeliverPass` 加 `isReviewGateCheckpoint(q.checkpoint)` 排除,与 `kind==='report'` 排除同款一行式。relayToLead / pending CLI / liveness 语义**刻意不动**(镜像 FLY-1041 Chunk 9 的边界纪律)。

### 3.5 terminal 路由

retire 原语置 `expires_at=now` → 自动掉出 `getPendingGatesByRunner` 谓词 → `complete --route blocked` 的守卫(complete.ts)**零改动**即满足期望 3。

## 4. Brainstorm gate 裁定(Tadashi,2026-07-16)

设计理解确认,三决策全批:
- a) 跨 execution newest-wins ✓;不 wake 被 superseded session = 对;**verify-approval fail-closed 是承重点,plan 写明 + 加测试**。
- b) Bridge sweeper ✓;**plan 注明 worst case = 歧义一次、下 tick 收敛**。
- c) 不依赖 FLY-1251 founder_ship_card(尚未落地)、merged 回收归 FLY-1238 ✓。
- 「answered gate 也算 supersessor」抓得准。blocking 族不动 = 对。回归验收(重演 1309 → matching=1)保持硬项。批准进 plan,照常跨家族设计审。

## 5. 四点边界要求(Tadashi 硬要求:逐条声明,不许静默掉)

| # | 素材 | 声明(详见 plan §2) |
|---|---|---|
| ① | 素材 #6:review RECORD 注册/查找按 issue 匹配,旧 head 的 APPROVED 冒充新 PR 凭证 | **OUT** → 归 FLY-1229(授权底座的 (issue, PR, exact head) 严格键控正业);过渡防线 = runner fail-closed 纪律(1307 现场已验证有效) |
| ② | 素材 #3:spurious RE-TEST 触发器 keyed on「收到 qa-result」而非「head 真前移」 | **IN**(PR-3,小闸:retest 重驱前核 head 前移;含 Annie 给的 QA 行为验收基线) |
| ③ | 素材 #4 belt 半边:external merge 后 TURN 不释放 → 僵尸带(Lead 今晚手工 grantTurn 两次) | **IN**(PR-2:FLY-921 reconcileTurnBelt 的 completed-QA-holder 豁免条款加「PR 已 MERGED」终局出口) |
| ④ | FLY-1229 吸收 or sibling | **sibling**:1314 = 即时止血(sweeper 级、零 schema),1229 = 结构性授权平台(run-level barrier / ship_subject / 单一 approval authority)。1229 落地后其 R1/R2 泛化本不变式,1314 sweeper 降级为 defense-in-depth。镜像 FLY-1251「PR-1 止血 vs 平台 defer」先例 |

另:素材 #5(gate 把 thread 闲聊误标「回复你的 ship gate」)——结构面(单活跃 gate + 歧义一律拒 → 误挂面收窄)在 PR-1;WAKE 文案去断言化(不再声称「回复了你的 ship gate」)也在 PR-1;「gate 只接受落进 gate 的应答」的授权收口归 FLY-1229 ①。

## 6. 不变式(目标态)

任意时刻一个 issue 至多 1 个 open `approve_to_ship` + 1 个 open `review_design` + 1 个 open `review_code`(收敛延迟 ≤ 一个 GatePoller tick)→ founder 单字母回复候选集 = 1,可无歧义绑定;superseded gate 不阻塞任何 terminal 路由。
