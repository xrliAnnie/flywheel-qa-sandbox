# FLY-1314 gate 卫生:auto-supersede + 单活跃 gate 不变式 — 调研
Issue: FLY-1314 (https://linear.app/geoforge3d/issue/FLY-1314/infra-gate-卫生head-变更后旧-gate-不自动-supersede-同-issue-多-gate-并存-founder)
日期: 2026-07-16
基于: exploration.md

> 行号基于本分支 `flywheel-FLY-1314`(fork 自 main `4f8f8a710`)。

## 1. gate 数据模型(CommDB,per-project better-sqlite3)

- gate = `messages` 行,`type='question'` + `checkpoint` 列(`packages/flywheel-comm/src/db.ts:285` 迁移加列)。checkpoint 取值:`brainstorm` / `question` / `approve_to_ship` / `review_design` / `review_code` / `runner_lifecycle:<action>`。
- **pending 谓词**(全库统一):无 `response` 子行 + `expires_at > now`(protection 模式下为 `relay_state != 'terminal_disposed'`)。见 `getPendingQuestions` (db.ts:1218)、`getPendingGatesByRunner` (db.ts:1240)、`isQuestionPending` (db.ts:805)。
- issue 映射:CommDB `sessions.issue_id` (db.ts:33-42);Bridge 侧 StateStore session 也有 `issue_id` 且终态后**保留行**(CommDB 行会被 `finalizeSession`/`deleteSession` 删除,StateStore 不删)。
- `messages` 非 WITHOUT ROWID → `rowid` 单调 = 同 DB 插入序,可破 `created_at` 的 1s 同秒(FLY-191 已知坑,db.ts:1281-1285 注释明令不要做「latest gate」helper——本设计不选 latest 来绑定,只用全序做 **supersede 的新旧判定**,且同秒回退 fail-open 不 retire)。

## 2. retire 原语(已存在,可直接复用)

| 原语 | 位置 | 守卫 | 效果 |
|---|---|---|---|
| `retireShipGate(qid)` | db.ts:744 | `checkpoint='approve_to_ship'` + unanswered(NOT EXISTS response) | `resolved_at/read_at/expires_at=now` + `relay_state='terminal_disposed'`,留行审计 |
| `retireQuestionGuarded(qid, {expectedFromAgent, requireUnanswered:true})` | db.ts:775 | (id, from_agent) 精确 + unanswered | 同上 |
| `resolveGate(qid, 0)` | db.ts:826 | **无守卫**(无条件 UPDATE)——不用于 supersede | — |

已 answered 的 gate 在两个 guarded 原语下**结构性不可改写**(concurrent response wins)。

## 3. 现有 supersede 触发面(全部同 session 键)

1. **event-route 主路径**(`event-route.ts:1296-1350` `retireSupersededShipGate`):`awaiting_review` 转移成功后,retire `existingSession.review_question_id`(同 execution 旧绑定)。kill-switch `FLYWHEEL_SHIP_GATE_RETIRE=0`。审计 = `ship_gate_superseded` session_event,event_id `ship-gate-superseded-<qid>`(与 sweeper 用 UNIQUE 天然去重)。
2. **GatePoller 兜底 sweeper**(`gate-poller.ts:2249-2309` `maybeSweepSupersededShipGate`,内联在 relay loop `gate-poller.ts:851`):判据 `isSupersededShipGate(question, session, boundQuestion)` 要求绑定 question 的 `created_at` **严格晚于** q(同秒 fail-open,注释明令禁止放宽到 `>=`)。键仍是 `session.review_question_id`。
3. **zombie-gate-hygiene**(`zombie-gate-hygiene.ts`):只处理 CommDB session 行已消失的 gate;Z1(StateStore 终态 → 三段式 intent→guarded→outcome retire)/ Z2(session 活着 → 只告警不动)。**review gate 无条件豁免**(:152,FLY-1257 defect ④)。
4. **mergedGateGuard**(FLY-1238,`plugin.ts:6030-6040` 注入 `merged-gate-guard.ts`):PR 已 MERGED → retire ship gate。与本单互补不重叠。

## 4. review gate 生命周期(为什么会永远 pending)

- 开启:runner `gate review_design|review_code --no-block` → `request-review` 注册(`request-review.ts`;fail-close:未注册成功不许等 gate)。
- 应答:`review-request-coordinator.ts` 把 verdict respond 到 **job 绑定的 question_id**;respond 是 gate-open 条件写(coordinator.ts:1315 注释:concurrent resolveGate/expiry/foreign answer → no-op),所以 **retire 一个旧轮 gate 不会撞坏 coordinator**——旧 job 迟到的 respond 变 no-op。
- 多轮:每轮 = 新 job + 新 questionId(coordinator.ts:668 `round = count + 1`)。**新轮注册时没有任何人收旧轮 pending gate。**
- 三重豁免叠加(全部正确但组合成孤儿):`finalizeSession` 不收(db.ts:2107-2112)、zombie-hygiene 不收(:152)、GatePoller eviction 不收(`gate-poller.ts:1352` path-2)。
- 作者等待方式:no-block + park(Codex 走 gate-marker awaiting_gate;Claude 走 await-codex-gate/park)。被 supersede 的旧轮作者本来就是废弃 lap,现状也是搁浅;不新增伤害(见 plan 风险 R3)。

## 5. founder 回复绑定链(FLY-1099/1041 现状)

- 候选集构建:`gate-poller.ts:2982-3127` `founderReplyDeliverPass` → `db.getPendingQuestions(lead.agentId)` 全量,唯一排除 `q.kind === 'report'`(:3030,FLY-1041 Chunk 9 Fix D);按 issue thread 分组喂给 deliverer。
- 匹配:`founder-reply-deliverer.ts:345-360` — founder 消息 match 所有 `createdAtMs < msgMs` 且仍 pending 的候选。
- 歧义:`processFounderMessage`(:730-751)`nonShip.length > 0 && matching.length >= 2` → `founder_reply_ambiguous` handoff(`gate-poller.ts:3774` `makeAmbiguousHandoff`)。**FLY-1309 正是 2 approve + 1 review = matching 3。**
- ship 归因:`tryFounderShipApproval`(FLY-799/1099)A-2 exactly-one narrowing——多 ship gate 且无 card-reply 收窄 → 不绑。
- WAKE-only 文案:`SHIP_WAKE_TEXT`(deliverer:250-252)=「Annie 在 thread 回复了你的 ship gate:…」——**对任何 matching 的闲聊都这么说**(素材 #5 的误标面;已带「这条不是授权」尾注,但断言「回复了你的 gate」本身是错的)。
- `isReviewGateCheckpoint` 已从 `review-gate-checkpoints.ts` 导出(gate-poller.ts:96 已 import)——Layer 2 排除零新依赖。

## 6. terminal 路由守卫(期望 3 的通路)

`complete.ts:159-187`(FLY-1257 M1-c,Codex runner 即 `FLYWHEEL_GATE_MARKER_DIR` 存在时):`route=blocked` 前查 `getPendingGatesByRunner(execId)`,有 pending 即拒绝。谓词含 `expires_at > now` → **retire 后自动放行,守卫零改动**。Claude runner 无此守卫(无该 env),不受影响。

## 7. 素材 #4(belt)事实

- `three_stage_turn` 表 + `grantTurn`/`getAllTurns`/`deleteTurn`(db.ts:51-57, 1803-1975)。
- `reconcileTurnBelt`(`phase-orchestrator.ts:1990-2068`):holder 终态判定中,**`completed` + role=qa 无条件 spare**(:2007-2009,FLY-921 Codex R1 HIGH——正常管线 post-ship finalization 会删 TURN,reconcile 不该抢)。
- external merge 时:`external-merge-reconcile.ts`(FLY-945 Fix D)只在 path-1/path-2 校验通过时跑 `runPostShipFinalization`;**FLY-1307 现场 = Lead 以 founder-executor 身份 merge、批准未绑 gate → path-2(要求 structured `{approved:true}` founder-attributed + exact head match)不过 → finalization 不跑 → belt 停在 completed-QA holder epoch 8**,Lead 手工 grantTurn 两次绕开。
- 修口:completed-QA spare 条款需要一个「PR 已 MERGED」终局出口(Annie 素材 #4 修法方向 ②)。PR merged 探测已有现成件:`fetchPrMergeInfo` 形态的 gh 探测 + 节流(external-merge-reconcile.ts:38-40,每 project 每 pass 上限、轮转)。

## 8. 素材 #3(spurious RE-TEST)事实

- 重驱路径:`phase-orchestrator.ts` `handlePhaseCompleted` — implement 重复 `needs_review` 完成 → 对 parked QA `wakePhaseRunner({kind:'retest', headSha})`(:1770-1774)并 `grantTurn`(:1763);spawn 分支同构(:1809)。
- 触发键 = 「implement 又完成了一次」,**不核 headSha 是否自上次 QA verdict 后真实前移**;wake 文案声称「implement 推了修复」。FLY-1252 QA(fbe23871)干净排除证据:qa-result 重发(head 不变 7f5c0a9ff,产品 delta 空)→ 立刻再触发 RE-TEST。
- 上次 verdict 的 head:`qa_result` 事件绑 head sha(auto-qa-coordinator 链路,FLY-827/1211 家族);StateStore 有 auto-qa record 与 qa verdict 存储——PR-3 需要的读口是「该 issue 最近一次 QA verdict 绑定的 head」,实现期从 auto-qa-coordinator 的现成 record 取(具体 accessor 由 implement 阶段核定,plan 只锁行为契约)。
- docs-only 判定:`ship-relevant-diff.ts` 已存在(FLY-1251 PR-1 已落),可复用其 server 端 docs-only 判定;fail-closed = 判不出按「有产品 delta」处理(即照常重驱,宁多跑不漏跑)。

## 9. 素材 #6(record 层)事实——OUT 依据

FLY-1307 PR-7.5 现场:implement runner 为 PR #623 @`752d1f842` 注册 cross-family review,注册/查找返回同 issue 旧 PR #617 冻结头 `4cb148363` 的 APPROVED。缺陷在 review **record** lookup 按 issue 匹配、不按 (PR, exact head) 严格键控——这是 FLY-1229「Authority 底座」(materialized subject/严格键控)的正业,与 gate 生命周期(本单)正交。runner fail-closed 纪律(只认 reviewedHeadSha=目标 head)现场已挡住,作为过渡防线。

## 10. 关键交互面清单(plan 的完整性检查表)

设计改动波及/必须不破坏的机制:
1. verify-approval:绑定 gate 被 retire → `getResponse` 无 / pending 否 → **拒绝 ship(fail-closed,承重点)**;
2. FLY-1041 同 session fast-path 与 sweeper:保留,新 sweeper 是超集;event_id 去重前缀共用;
3. zombie-gate-hygiene:与新 sweeper 正交(它管 session 死,新 sweeper 管 issue 内新旧);对 review gate 它豁免、新 sweeper 接管其中「有新轮」的子集;
4. mergedGateGuard:管 merged,新 sweeper 管 superseded,均幂等、UNIQUE event 去重;
5. review-request-coordinator:旧 job 迟到 respond → no-op(§4);
6. 阻塞族 gate(brainstorm/question):候选集、supersede 一律不碰;
7. `getPendingGateByRunner(runnerId, checkpoint)`(db.ts:1259,Bridge respond approve gate 用):retire 后不再返回旧 gate——行为正确化;
8. FLY-560 thread 标题 / GatePoller relay:pending 集合变小,少 relay 死 gate——行为正确化;
9. FLY-921 reconcileTurnBelt 其余分支(failed holder、live probe):PR-2 只加 completed-spare 的 merged 出口,不碰其它分支。
