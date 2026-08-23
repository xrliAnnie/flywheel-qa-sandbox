# FLY-2008 plan.md — Claude 对抗评审(Round 1,新鲜上下文驳倒式)

Date: 2026-08-23
Author: Claude (fresh-context adversarial subagent, 7 hard cases mandated)
Status: REFUTED → 全部 findings 已折入 plan(见 plan §7-bis 收敛记录)
定位: 补充评审(Lead 裁定 design gate 以真 Codex 轮为准)

## Verdict
REFUTED — finding #1 (BLOCKER) + #2-#4 (MAJOR) + #5-#9 (MINOR) + #10-#11 (INFO/verified)。

## Findings(摘要;完整推理见 runner transcript)
1. **BLOCKER**: `releaseExpiredLegacyPushClaims` 第二条 SELECT(mailbox-queue.ts:1295-1303,`ORDER BY seq LIMIT ?`)生产 bound 形态 = `SCAN mailbox`(实测 40ms/call,每 enabled tick 无条件,1Hz×14 lead)。三个新索引都治不了它(scratch EQP 验证)。research 的「无罪」判决来自字面量形态探针(坏尺)。→ 已折入 plan A2b(`ORDER BY +seq`,runner 亲核 bound 形态翻 SEARCH)。
2. **MAJOR**: 查询清点漏 `claimQueueBatch` 头查询(今天裸 SCAN+TEMP B-TREE,健康态每 tick;事发窗 profile 因 frozen 探测短路而低估=测量窗偏差);A4 索引落地后意外治好但无守卫。countDeliverable 频率账错(hasLiveSession 短路,主要 idle-lead 30s)。→ plan §5.1 全链 EQP 守卫。
3. **MAJOR**: B1 预算语义自相矛盾(text「填满剩余预算」vs test「独立预算」);「12 条 pending」量错谓词(实测 getPendingQuestions=418 行,含 report 380、review-gate 2,有效 ~36 问/8 会话)。→ plan B1 独立扫描预算定案 + 数字更正。
4. **MAJOR**: B2 提升的是小头;大头 = deliverer 每 thread 经 deps.commDbFactory 默认值开 writer CommDB(founder-reply-deliverer.ts:296,392),每次 open 跑 migrations+purgeExpired,生产 37,549+ 行超 72h retention ACKED ⇒ 每次都有归档写活。→ plan B2 修正(pass 级共享连接经 deps seam 注入 + try/finally)。
5. **MINOR**: A3 覆盖声明过宽——getPendingGatesByRunner 按 from_agent,只得 5,817 行 partial 扫描(~9x 改善,CLI 路径可接受)。→ plan A3 注。
6. **MINOR**: 索引 DDL 确认对存量库 writer-open 重执行(db.ts:1047-1049;openReadonly/maintenance 跳过);但首个付账者可能是 runner CLI 而非 Bridge boot。→ plan §6 风险表。
7. **MINOR**: 新索引写放大有界(1,065 / 5,817 / 12 行),核过无害。
8. **MINOR**: Fix C 让出点安全(per-lead 循环今天已有 await 交错;polling 闩防重入;GatePoller 可变态 poll-only);B2 缓存需 try/finally close。→ plan §5.2-4。
9. **MINOR**: 验收需预注册判读口径:episode 铸造(max_ms)按日计数为判据,span 出现与否不是;「同等 founder 活动密度」无操作定义,慢性病日计数天然可比。→ plan §7-1。
10. **INFO**: H5 时延边界核过:deferred-approval TTL 45min、founder-reply grace 10min、dead-letter 30min、ship-gate grace 15s——全 ≫5min 或在豁免 thread 内;ship 批准走 question-bound(豁免)。
11. **INFO**: A1 拆分等价论证核过(priority NOT NULL、seq 唯一 PK、同一 .immediate() 事务单快照、fence 逐字节相同);claimRunner/reconcileExpiredLeases/dead-letter 扫描留置合理(各有索引)。
