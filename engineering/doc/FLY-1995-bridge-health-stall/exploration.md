# FLY-1995 Bridge 低负载准周期不可用 — 探索

Issue: FLY-1995 (https://linear.app/geoforge3d/issue/FLY-1995/容量bug症状-生产-bridge-低负载下准周期不可用623percent-墙钟-health-答不进-1s最大-26-29s进程-cpu)
日期: 2026-08-22
基于: 无(上游为 FLY-1986 压测采样证据,见 issue 正文)

---

## 1. 症状回顾(照 issue,不重述细节)

- 低负载(load 5.3–11.2)下约 **62.3% 墙钟时间 /health 答不进 1s**,单次最大 26.3s;发作时 Bridge 进程 CPU ~98%。
- 恢复期 /health 1–50ms、CPU ~25%。n=1 完整发作;强关联非受控因果;烧核工作未指认(macOS `sample` 抓不出 JIT 帧)。
- GatePoller 对 46 个 orphan qid 无界重扫,立单时 286,531 行日志(候选病灶,未证实是烧核者)。

**本单是症状单,不预设根因。** 以下是本节点(design)在 2026-08-22 18:2x–18:4x UTC 对生产环境做的**只读**审计,全部命令可复跑。

## 2. 本节点新证据(只读审计,均带取证方式)

### E1. /health 处理器本身很便宜 ⇒ 延迟 = 事件循环排队

`packages/teamlead/src/bridge/plugin.ts:1784` — /health 只做 `store.getActiveSessions()`(sessions 表 7MB / 2,425 行,有索引)+ `getAdmissionPause()` + 内存态 liveness manifest。没有任何重查询。
⇒ 10–26s 的 /health 延迟不是处理器慢,是**请求在单线程事件循环里排队**。机制归因(什么占住了循环)仍待仪表,但「排队」这一层已由代码结构确认。

旁证:`BridgeEventLoopGuard`(`bridge/BridgeEventLoopGuard.ts:36`)的挂死自杀阈值是 **60s**——26s 级发作恰好全程低于它,所以 Bridge 不会被 KeepAlive 重启,发作对现有看门狗完全隐身。

### E2. GatePoller orphan 重扫:机制确认 + 仍在线性涨

- GatePoller 每 **3s** tick 一次(`plugin.ts:8384` `pollIntervalMs: 3_000`)。
- 每 tick × 每 (project, lead):`CommDB.openReadonly()` 开一次 comm 库拉全部 pending questions(`gate-poller.ts:1390-1409`)。
- 每个 pending question **先**做一次 `store.getSession(question.from_agent)`(better-sqlite3 同步查询,`gate-poller.ts:813`),查无 session 才判 orphan → `console.warn` 一行 + `continue`(`gate-poller.ts:818-822`)。**没有任何缓存、没有终态、没有日志去重** —— 同一个 qid 每 3s 重复整套动作。
- 生产复核(2026-08-22 18:27 UTC):`grep -c "orphan question" /tmp/flywheel-bridge.log` = **308,421 行**(立单时 286,531,数小时内 +2.2 万,线性涨确认);distinct qid 仍 = **46**;日志文件已 60MB。
- orphan 来源:`from_agent=voice-honeylemon-fly1911`(voice agent,从未在 StateStore 有 session)。comm 库现存 **42 条 open** 的该 agent runner_question(见 E3 取证 SQL)。

**为什么永不清理(根因确认)**:mailbox 迁移(FLY-1645/1572)后,`CommDB.getPendingQuestions`(`packages/flywheel-comm/src/db.ts:2616`)的谓词是「无 response 子行 AND `relay_state != 'terminal_disposed'`」——**已不再按 `expires_at` 过滤**(gate-poller.ts:1312 的旧注释与现实相反)。orphan question 永远没人写 response、没人 dispose ⇒ 每 tick 都回来。现有的 `evictTerminalGateQuestion`(FLY-307)只处理 gate_question(checkpoint != null),且第一行就拒绝 runner_question(FLY-161 边界)——对这 42 条(checkpoint == null)完全没有出口。

**量级判断(诚实边界)**:46 × (1 次索引查询 + 1 行日志) / 3s ≈ 每秒 15 次小查询 + 15 行同步日志写。这**不足以**解释 10–26s / 98% CPU 的发作 —— orphan 重扫是独立危害(日志无界涨、无谓 churn),按 issue 原判「候选病灶,未证实是烧核者」,本审计进一步降级为「几乎肯定不是烧核者,但必须收口」。

### E3. 生产 pending question 面(只读 SQL)

```sql
-- sqlite3 "file:$HOME/.flywheel/comm/flywheel/comm.db?mode=ro"
SELECT from_agent, checkpoint IS NOT NULL AS is_gate, relay_state, count(*)
FROM mailbox_message_projection q
WHERE type='question' AND relay_state != 'terminal_disposed'
  AND NOT EXISTS (SELECT 1 FROM mailbox_message_projection r
                  WHERE r.parent_id = q.id AND r.type='response')
GROUP BY from_agent, is_gate;
```

结果(2026-08-22):voice-honeylemon-fly1911 **42 条 open**;另有多个 runner exec 各挂 28/66/88/**220** 条 `relay_state='protected'` 的 pending runner_question。⇒ 每 3s tick 实际扫描的 pending 面是 **400+ 条**(每条一次 getSession),orphan 只是其中打日志的那部分。整个「pending 面只增不减」是同一个结构性问题的两张脸。

### E4. teamlead.db 已 1.77GB;93.7% 是单一事件类型的历史风暴残留

- `~/.flywheel/teamlead.db` = **1,770,455,040 bytes**。dbstat 分解:`session_events` 表 798MB + 它的 4 个索引 ≈569MB ⇒ **session_events 一族 ≈1.37GB,占整库 ~77%**。
- `session_events` 共 **2,814,940 行**,其中 `event_type='issue_thread_infra_notify_skipped'` = **2,638,046 行(93.7%)**。
- 该风暴的时间窗:**2026-08-01 22:36 → 2026-08-05 03:09**(≈76 小时,平均 **9.2 行/秒**持续写入),此后已停(写入方 `founder-thread-notifier.ts:831,840` 的 skip 审计,skip 原因 no_chat_thread / no_bot_token)。**残留从未清理。**
- 残留高度集中:`execution_id='geoforge3d:product-lead'` 一个键下 **2,534,480 行**,且 `issue_id='unknown'` 同样 2,534,480 行。

### E5. 全量物化陷阱:任何读路径撞上残留 = 秒级到十秒级同步阻塞

- FLY-663 把 StateStore 迁到 better-sqlite3(原生、**同步**)。兼容层 `CompatStatement.step()`(`StateStore.ts:271-281`)第一次 step 就执行 `stmt.all()` —— **无论调用方要几行,全部匹配行一次性物化成 JS 对象**。
- `getEventsByExecution()` / `getEventsByType()`(`StateStore.ts:6223/6255`)是 `SELECT *`(含 payload)+ 逐行 `JSON.parse`。调用面横跨周期性代码:gate-poller(3 处)、pane-loss-reconcile、workflow-gate-card-lifecycle、auto-qa-coordinator、post-ship-finalization、zombie-gate-hygiene、workflow-engine-dispatcher、voice-routes 等。
- **计时探针(只读,本机)**:裸 sqlite3 CLI 扫 `execution_id='geoforge3d:product-lead'` 全部 payload 页(135MB / 253 万行)= **~3.7s**。Node 侧再叠加 253 万次行对象构造 + JSON.parse + GC ⇒ **10–30s 量级完全可达**,与观测到的 10.7/14.1/19.0/26.3s 同数量级。
- **诚实边界**:尚未指认哪条生产路径以 `'geoforge3d:product-lead'`(或其他撞残留的键)为参数被周期性调用 —— grep 未找到构造该复合 id 作为 executionId 传入读路径的代码点。所以这是**强候选机制,不是定案**:数量级吻合、方向吻合、但缺「发作瞬间栈上是谁」的直接证据。这正是验收第 1 条要仪表的原因。

### E6. 候选机制清单(分级)

| 假设 | 证据强度 | 判断 |
|------|----------|------|
| H1: 周期性同步 StateStore 读撞 2.6M 残留(全量物化 + JSON.parse + GC) | 数量级吻合(E5),但调用点未指认 | **强候选** |
| H2: 其他同步重活(sync child_process / 大 JSON / GC 风暴 / 别的全表扫) | 未证伪;98% CPU 排除了纯 IO 等待型阻塞 | 候选 |
| H3: GatePoller orphan 重扫本身 | 量级差 2-3 个数量级(E2) | 几乎排除(但独立危害成立) |

准周期性(~62% 墙钟)与 GatePoller 众多 20-tick(60s)节奏的 rider(patrol / reconcile / display / QA / disposition receipt,`gate-poller.ts:700-772`)+ HeartbeatService 周期在时间形态上兼容:多个 60s 级周期任务中的一两个各烧 10–26s 即可造出 ~60% 占空比。同样:**形态兼容 ≠ 归因**。

## 3. 设计方向(三支柱)

1. **支柱 A — 归因仪表(验收 1、3)**:事件循环延迟检测 + 发作触发保留的进程内 CPU profile(V8 inspector 采样线程独立于事件循环,能抓同步阻塞的栈)+ rider 计时账(确定性「谁在发作窗口里跑过、跑了多久」)。指标经 /api 暴露 = FLY-1986 的测量面。
- **支柱 B — orphan 终态(验收 2)**:session-less question 过 grace window 后走 `terminal_disposed` 终态 + 审计事件 + 每 qid 只日志一次;日志行数停止线性涨。
- **支柱 C — 残留收口(本审计新发现,E4/E5)**:一次性 operator-gated 清理手术(dry-run 默认、备份、精确账)+ notify-skip 写入方限频,把 1.37GB 的读放大面拆掉。C 无论 H1 是否定案都独立成立(与 issue 对 GatePoller 积压「即使不是烧核者也该收口」同一精神)。

## 4. 明确不做

- 不改 FLY-1971 阈值(验收 4:等本单仪表结论)。
- 不动 FLY-1986 的压测方案本身,只提供其自变量(事件循环占用)的测量面。
- 不在本单里"顺手"优化 CompatStatement 全物化语义(FLY-663 的 67 个调用点字节兼容契约,动它是独立大手术;本单只消灭它撞上的 2.6M 残留 + 用仪表证明谁在撞)。
