# FLY-2339 有界投递维护 — 独立 QA 验证

Issue: FLY-2339 (https://linear.app/geoforge3d/issue/FLY-2339/引擎urgent-2331-之后-eventloopguard-第二层凶手维护-tick-里同步跑的-delivery)
日期: 2026-09-04
基于: verification.md（实现方自证），本文为独立复验

## 0. 结论

**PASS**。验证头 `d6f6b62b0f4a252ca636b7ae9a4b749bbc6df7a1`（PR #1089，与 `origin/flywheel-FLY-2339` 一致）。
本地工作树多出一条 `03afb8504`，内容只有本 QA 节点自己的 `qa-progress.md`，无代码差异。

急性 62 秒同步块被独立复现（54.678 s 冷 / 39.524 s 热），修复后同一条 SQL 0.469 s；
三段维护的最大同步页从事故值 64,303 ms 降到 ~200 ms；分页不丢不重；真 Discord 529 房间在候选头上
跑通真实投递合同收敛。

## 1. 病根：我自己复现的，不是采信文档

2026-09-04T22:22Z 用 SQLite backup API 取一致性快照：`comm.db` 672 MB、`teamlead.db` 633 MB。
先确认**未修版快照里 5 条新索引一条都不存在**，再在其上跑 `listRunnerDeliveryProjectionRows` 的原 SQL
（强制消费两个相关聚合）：

| 度量 | 未修快照 | 新版打开后的同一份数据 |
|---|---:|---:|
| 整条 projection SQL（冷页缓存） | **54.678 s** | 0.469 s |
| 整条 projection SQL（热页缓存，第 2 次） | **39.524 s** | — |
| `COUNT(DISTINCT batch_id)` 子查询 EQP | `SEARCH a USING INDEX mailbox_batch_lookup (batch_id>?)` | `SEARCH a USING INDEX mailbox_runner_inflight_by_recipient (to_agent=? AND claim_expires_at>?)` |

热态仍要 39.5 s（user 19.7 s + sys 18.5 s），说明这不是冷缓存假象，是真 CPU/IO 成本；
生产 load 一高就跨过 60 s 阈值 —— 与 loop-guard 里 8 条 marker 自杀（6 条 `delivery-contract:watch`、
2 条 `delivery-contract:projector`，stall 61,981–64,303 ms）完全对得上。

## 2. 修复效果：生产快照上的三段实测（本 QA 自建 harness，跑 dist 构建）

跑两遍独立副本：

| 段 | 页数 | 最大同步页 | 完整 drain | 本轮处理量 |
|---|---:|---:|---:|---:|
| projector | 59 | 189.93 / 199.86 ms | 2.248 / 3.107 s | examined 3,652 |
| watch | 2 | 111.18 / 124.69 ms | 0.175 / 0.218 s | observed 108 |
| operations | 1 | 189.90 / 265.19 ms | 0.190 / 0.265 s | examined 39 |

**最长连续同步阻塞：64,303 ms → ~200 ms，约 320 倍。**
新版首次打开生产快照并建全部索引：teamlead migrate 505–553 ms、CommDB open 422–491 ms；
第二次打开（索引已在）49 / 17 ms。一次性升级成本可忽略。

## 3. 事件循环真的喘气了（不是把同一坨同步塞进 Promise）

drain 期间挂一个 5 ms `setInterval` 探针，记录每次触发的超时量：

| 段 | 最大 event-loop lag | 最大同步页 |
|---|---:|---:|
| projector | 195.06 ms | 199.86 ms |
| watch | 122.44 ms | 124.69 ms |
| operations | 260.23 ms | 265.19 ms |

lag 与单页耗时同量级 ⇒ 页间 `setImmediate` 确实把控制权还给了事件循环，定时器在每页之间被调度到。
（第一次跑我自己的探针报出 1,111 ms —— 那是探针基线被前面同步的 505 ms migrate + 422 ms open 污染，
修正基线后重测得上表；不是被测代码的问题。）

## 4. 语义不丢：三项独立检查

**(a) 幂等**：在同一份已收敛副本上再 drain 一遍 —— `minted 0 / advanced 0`，`examined` 仍是 3,652。
分页没有重复做功，也没有漏做。

**(b) 覆盖完整**：独立数出未分页候选量 = mailbox 3,119 + phase 408 + turn 124 = 3,651，
与分页 drain 的 `examined 3,652` 吻合（±1 为快照漂移）。unsettled lane 按设计不计 examined。
watch `observed 108` = 该项目 live attempt 数 = 全库 live attempt 数（108），项目范围收窄没有丢件。

**(c) keyset 对抗性审计（我自己写的 fixture，不是复跑 PR 的测试）**
用真 StateStore + 生产同形的游标形状，跨多页 drain 后逐 id 比对：

| lane | 造的行 | 看到 | 去重后 | 漏读 | 重读 |
|---|---:|---:|---:|---:|---:|
| open undeliverable episode（150 个 root_id × 2 个 family，**故意造重复 root_id**） | 300 | 300 | 300 | **0** | **0** |
| pending hold_resume（内容哈希 id，与 created_at 非单调） | 150 | 150 | 150 | **0** | **0** |
| live delivery attempt | 300 | 300 | 300 | **0** | **0** |

重复 root_id 那一组是关键：朴素的 `root_id >` 游标会在这里跳读，`(root_id, family)` 行值 keyset 不会。
schema 侧也核过支撑：`idx_wda_live_by_root` 与 `idx_wdce_open_by_root` 都是 **UNIQUE** partial index，
两条 keyset 因此都是可靠的。

## 5. 真 Discord N-to-N（529 QA Room，候选头，零生产触碰）

这是 Discord-capable 改动（delivery = Runner↔Lead 中继 + 告警），所以按标准跑了真机 529：

- 先起 2-Lead 战役：`scripts/test-deploy.sh 3 --extra-lead 4:product` —— 单 Bridge + 2 个真 Lead
  （`flywheel-test-3` / `flywheel-test-4`），即 N-to-N 拓扑本身。
- 再起 generalized 房跑真 DAG：`scripts/test-deploy.sh 3 --generalized --stub-runner` +
  `scripts/qa-529-generalized-e2e.mjs 3 --issue FLY-2339`。
  Bridge buildSha `4b98f675`（= 被审头 + 本 QA 的 progress 文档，无代码差）。
  隔离到 `/tmp/flywheel-test-slot-3`，`FLYWHEEL_DELIVERY_SECRET_PATH` 指向 slot 自己的 state，生产未被触碰。

**九步 driver 的 step 1–5 全绿**：durable run authority → design 收口 → implement 带 PR 能力派发 →
rework-reachable ship_parked → **parked implement 不持 gate 时 question gate 投递照常工作**
（这一步本身就是真实 mailbox 投递合同的用例）。

**真 Discord 消息**（真 bot `flywheel-test-3` id `1493075160025272452`，gateway shard ready）：
频道 https://discord.com/channels/1485787271192907816/1493080995862413439

| 时间 (UTC) | 内容摘要 |
|---|---|
| 22:38:43 | 🚀 [FLY-2339] 起跑卡 |
| 22:40:20 | [FLY-2339] 进度更新（带 Linear 链接） |
| 22:41:58 | [FLY-2339] QA 第 1 轮没过 → Runner 已在返工（attempt 2 已推上去） |

**投递合同在候选头上真实收敛**（slot teamlead.db）：

| family | 结果 |
|---|---|
| launch × 4 | 全部 settled |
| mailbox × 1 | minted → sent → received → consumed → settled `source_terminal` |
| turn_wake × 1 | minted → sent → settled `source_terminal` |
| rework × 1 | 仍 live，**没有被提前 settle**（保守正确） |

**部署安全性**：活着的 Bridge 在两个隔离库上都建出了全部 5 条新索引
（`mailbox_runner_inflight_by_recipient` + 4 条 teamlead 索引），**0 次 SQLITE_BUSY**、
**0 次 `maintenance pass failed closed`**，Bridge 连续存活 19 分钟以上（对比事故形态的 6–8 分钟自杀）。

### step 6 超时：已归因，不是本 PR 的锅

driver 停在 step 6（`workflow_rework_delivery` 卡在 `awaiting_receipt`，等不到 `wake_delivered`）。
归因证据三条：

1. 这是**已知未修缺陷 FLY-2208**「QA attempt-1 发 qa-fail 后 session 永不终态,占死 (issue,qa)
   inflight 起跑道」，Linear state = **Backlog**（updatedAt 2026-08-31），至今未修；
2. 仓内 `engineering/doc/FLY-2148-runner-memory-landing/qa-report.md` 记录了**同样的**
   「9 步 driver 只跑到 step 5，step 6 是已知缺陷 FLY-2208,与本 PR 无关」；
3. 现场吻合：QA stub `acb72a53` 在 22:55 仍 parked 且在心跳，正占着跑道；
   `git diff main...HEAD` 里 `workflow_rework_delivery` 只出现在生成的审计表和中文调研正文里，
   **零行 rework 再入/回执代码被改**（`rework_pause_context_changed` 判据在 StateStore.ts:28238，
   不在任何 diff hunk 覆盖范围内）。

## 6. 可执行门

| 门 | 结果 |
|---|---|
| teamlead 触及测试（fork 1/1，5 文件） | **48 passed** |
| flywheel-comm 触及测试（fork 1/1，2 文件） | **12 passed** |
| `pnpm --filter flywheel-comm build` / `--filter flywheel-teamlead build` | pass |
| PR #1089 CI（headSha `d6f6b62b0`） | **14/14 全绿**，run 33923932758 conclusion=success |

## 7. 非阻断观察（报给实现方，不构成 FAIL）

1. **hold_resume 排序从 FIFO 变哈希序**：`listPendingWorkflowHoldResumeOperations(options)` 的
   `ORDER BY` 从 `created_at, operation_id` 改为 `operation_id`。生产的 `hold-resume:` id 是内容哈希，
   实测 6 条 pending 里有 5 条相对次序改变。每条 operation 指向不同 episode，今天无害，
   但这是一处未在文档中点名的 FIFO→哈希序变化。
2. **watch 项目归属判据收窄**：从 JS 侧 `ref.projectName ?? root_id.split(':')[0]` 变成 SQL 的
   `root_id` 前缀区间。若将来有写入方给 `contract_ref_json.projectName` 填了与 root_id 前缀不同的值，
   那条 attempt 会没有任何项目的 watch 观察到。今日无害已证：4,271 条 attempt（含 108 条 live）
   **没有一条**带 `ref.projectName`。
3. **plugin.ts 的 operations abort 路径**：capped stalled scan 放在 `finally` 里，若它自己抛错会
   顶掉原始错误再被外层 catch 打印。只影响日志保真度。

## 8. 诚实边界

- **没有浏览器截图**：Claude-in-Chrome 断连（`list_connected_browsers` = []）。
  `chrome-diagnose.sh` 报 `LOCAL_STATUS=READY`，但 Keychain `mdat=20260904222653Z`、
  CLI 凭据账号 `xrliannie.1@gmail.com` 指向刚发生过账号轮换（chrome-repair 铁律 2 / L2 嫌疑）；
  R4/R5/R6 全部需要 founder 亲手做，本节点不打扰。**替代证据**：用真 test bot token 直接调 Discord
  REST API 取回同一批消息（上表），是真机证据，只是不是浏览器截图。
- **529 drill step 6–9 未跑到**（FLY-2208 占跑道），因此 rework wake 回执 → land/ship 收口这一段
  在本头上未验。风险评估为低：diff 未触碰 rework/回执代码；且这与最近数个 PR 的覆盖面一致。
- **部署后判据按定义尚未满足**：必须在新 build 上线后观察 `~/.flywheel/bridge-loop-guard.log`
  不再新增 `last_sync_op=delivery-contract:*`。当前生产跑的是 `c638ee33`（main，未含本修复），
  已连续 105 分钟没有 stall —— 所以**「上线后没再自杀」这一条单独不具决定性**，
  真正的决定性证据是上面的 54.7s→0.47s 与 64.3s→0.2s。
- **本地没跑全仓 `pnpm test:packages:run`**：本机有会真开 Terminal.app 的 GUI 用例
  （FLY-2314/2327 在处理），全仓证据以 PR #1089 在该确切头上的 14/14 绿 CI 为准。
