# FLY-2152 判决投递与巡检闭环 — QA 报告

Issue: FLY-2152 (https://linear.app/geoforge3d/issue/FLY-2152/巡检缺口-判决层不在巡检清单verdict-落库但无人推送静默压单2139-三小时无人动)
日期: 2026-08-29(第一轮 FAIL) / 2026-08-30(第二轮复验)
基于: plan.md

| 轮次 | 头 | 判决 |
|---|---|---|
| attempt 1 | `850a2983b` | **FAIL** — BLOCKER-1(见下) |
| attempt 2 | `b7f94af5c` | **PASS** — BLOCKER-1 已修复并真机复验 |

下文「第一轮」记录 FAIL 的完整定位;「第二轮」记录修复验证。

## 第一轮(attempt 1,head 850a2983b)— FAIL

### 结论一句话

三条产品要求(巡检第六维度 / Bridge 主动投递 / QA 节点合同)在代码层都实现了，
定向单测与巡检 shell harness 全绿，变异测试证明尺子有效。但**真机 529 房 E2E 暴露一个
P0 回归**：每一条被接受的 workflow verdict claim 都会把 owning Lead 的**整个 inbox 投递
循环永久卡死**，比本单要修的「一条判决静默压单」严重得多。

---

### BLOCKER-1 · 判决 claim 让 owning Lead 的整个信箱永久停投

**严重度: P0 / 阻断合入。**

#### 现象(真机观测)

529 房 slot 2(真 Bridge 跑候选 head，真 Lead `flywheel-test-2`)：
一条真 credential 认证的 `qa-result` 经真 HTTP `/api/workflow/decision` 提交后 —

- claim 落库成功、`workflow_claim_recorded` lead event 落库成功、渲染文案进入真 Lead 的
  CommDB mailbox —— **本单的正向目标达成**；
- 但紧接着 Bridge 每 tick 抛：
  `Lead inbox tick failed { leadId: 'flywheel-test-2', error: 'mailbox identity conflict: lead_event:flywheel-test-2:workflow_claim:1' }`
  —— 观测期内 **272 次且持续增长**；
- 该 Lead 的 mailbox 里**所有**消息(包括这条 claim，以及排在它后面的 `patrol_tick`)
  一律停在 `state=QUEUED`，`delivered_at` 恒为 NULL；
- 因为 `delivered_at` 永不推进，redrive 每 tick 都会再抛一次 —— **自锁，不会自愈**。

### 根因(源码链条，已定位到行)

`enqueueLeadEvent()`(`packages/teamlead/src/bridge/lead-event-queue.ts:44`)把
`envelope.priority ?? 2` 写进 mailbox 的 `insert_projection_hash`
(`packages/flywheel-comm/src/mailbox-queue.ts:510,536`)。同一条 journal row 的两条生产投递路径
优先级不一致：

| 路径 | 位置 | priority |
|---|---|---|
| commit 时直投 | `bridge/workflow-decision-routes.ts` `enqueueCommittedWorkflowClaim()` → `leadEventEnvelopeFromJournalRow(row, 1)` | **1** |
| 每 tick redrive | `bridge/lead-inbox-runtime.ts:339` `admit()` → `leadEventEnvelopeFromJournalRow(row, 2)` | **2** |

两者的 `deliveryId` 相同(都来自同一 `lead_events` row)，projection hash 不同 ⇒
第二次入队抛 `mailbox identity conflict`。而 `admit()` 是 `LeadInboxLoop` 每个 tick 的
**第一步**，抛出即整个 tick 中止，投递段根本执行不到。

真机数据佐证(`mailbox` 表)：

```
seq|id                                            |priority|state
1  |lead_event:...:patrol_tick:...:after-genesis  |2       |DEAD
2  |lead_event:flywheel-test-2:workflow_claim:1   |1       |QUEUED   ← 直投写下的 1
3  |lead_event:...:patrol_tick:...:after-1        |2       |QUEUED   ← 被它堵在后面
```

#### 影响面

- 触发条件：任意被接受的 runner claim(`qa_verdict` / `review_verdict`，即每个 DAG 的
  qa 与 code_review 节点)，且该 Lead 已注册 runtime。**正常路径，不是边角。**
- 后果：该 Lead 之后**收不到任何 inbox 消息** —— 巡检 tick、gate 提问、ship 审批、
  runner 提问全部停投。
- 与本单目标相反：新的巡检第六维度会把它报成 `CLAIM_DELIVERY_PENDING`，读起来像
  「机制在工作，等一下就好」，实际上那个 Lead 已经完全失联。

#### 为什么单测没抓到

两条路径从未在同一个真 `MailboxQueue` 上被一起跑过：
- `lead-inbox-runtime.test.ts` 按 plan 的要求刻意**让 direct enqueue 缺席**再验 redrive；
- `workflow-decision-routes.test.ts` 把 `enqueueLeadEvent` 打成 `vi.fn()` spy。

缝隙正好落在两者交汇处。

#### 已附回归测试

`packages/teamlead/src/bridge/__tests__/fly2152-claim-enqueue-priority.test.ts`
—— 用**真 route + 真 StateStore + 真 MailboxQueue**：先取 route 实际交给 registry 的 envelope
入队，再按 `admit()` 的原样表达式做 redrive，断言不抛。

- 候选 head 上：**RED**，报同一句 `mailbox identity conflict`；
- 把 route 的 `leadEventEnvelopeFromJournalRow(row, 1)` 改成 `(row, 2)` 后：**GREEN**。

(该一行改动仅用于验证，已还原，未提交产品代码。)

#### 建议修法

让直投与 redrive 使用同一优先级 —— 直投处去掉 `1`(即用与 redrive 相同的默认 2)，
或两处统一常量。修完请让上面的回归测试留在套件里。

---

### 第一轮已通过的验证

| 项 | 结果 |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm -r build` | exit 0 |
| 定向套件(StateStore.workflow-admission / workflow-decision-routes / lead-inbox-runtime / commdb-lead-runtime / mailbox-lead-runtime / fly369-patrol-rule) | 151 passed |
| `scripts/__tests__/lead-patrol-snapshot.test.sh` | 199 passed, 0 failed |
| `Blueprint.fly859-qa-phase-prompt.test.ts` | 9 passed |
| `flywheel-edge-worker` 全量 | 1294 passed / 5 skipped |
| CI on `8fe7a6f`(Quick Gate / Unit light+heavy / teamlead 1-3 of 3 / NPM payload) | success |

### 变异测试(证明尺子能区分，不是空过绿)

| 变异 | 结果 |
|---|---|
| StateStore 不写 lead event | `StateStore.workflow-admission` 3 失败 ✔ |
| route 不调 `enqueueCommittedWorkflowClaim` | `workflow-decision-routes` 1 失败 ✔ |
| 巡检 claim 查询指向不存在的 Lead | shell harness 4 失败(MISSING / PENDING / OWNER_MISMATCH / 计数) ✔ |
| Blueprint 去掉 Lead report 半段 | `Blueprint.fly859` 5 失败 ✔ |

#### 第一轮真机 529 已确认的正向行为

真 Bridge(候选 dist，`buildSha` 与 head 内容一致)+ 真 Lead `flywheel-test-2`：

- `POST /api/workflow/decision` → HTTP 200，claim 1 落库(`qa_verdict/qa_failed`)；
- `lead_events` 写出 `workflow_claim_recorded` / `event_id=workflow_claim:1` / `lead_id=flywheel-test-2`，
  payload 含 claim id、decision kind、predicate、issued_at、run/node/attempt；
- `formatWorkflowClaimRecorded()` 渲染文案完整进入真 Lead 的 CommDB mailbox。

也就是说：**「判决落库即主动推给 Lead」这条主链路本身是通的**，卡在最后一跳的队列身份冲突上。

---

### 第一轮 honest boundary(第二轮已补齐大部分,见下)

- **N-to-N 双 Lead 未跑**。529 的 slot 3/4 当时被另一个在跑的 campaign 占用，只剩 slot 2，
  只能起单 Lead 房。`CLAIM_DELIVERY_OWNER_MISMATCH` 这一维只有 shell fixture 覆盖，
  没有真机双 Lead 证据。
- **Discord 频道内的可见性未观测**。Lead 的 inbox 循环被 BLOCKER-1 卡死，消息压根没到
  Lead 手上，所以「Lead 在 Discord 说了什么」这一跳这次无从观测。修完 BLOCKER-1 需要补。
- **巡检第六维度只在 shell fixture 上验过**，没有在真机 529 DB 上跑一遍 `lead-patrol-snapshot.sh`
  看它把这条真 claim 报成 `CLAIM_DELIVERY_PENDING`。
- **本机 teamlead 全量套件 13 文件 / 49 用例失败**，全部集中在 tmux / socket / 真进程类
  集成测试(`fly1674-opus46-real-tmux`、`tmux-environment-scrub`、`CodexLeadInboxSocket` 等)，
  与本 PR 触及面无关；同一 head 的 CI teamlead 1-3 of 3 全绿，故归因为本机环境
  (长 TMPDIR + 并行运行的 QA slot tmux server)，不作为阻断项。未逐条复现确认。
- **`pnpm test:packages:run` 未跑到 teamlead/edge-worker**：它在 `flywheel-comm` 处
  3 条 5s 超时后中止(FLY 已知形状)。单独复跑那 3 条全绿(负载抖动)，teamlead 与
  edge-worker 已分别单独运行，结果如上。

---

## 第二轮(attempt 2,head `b7f94af5ca28b26444331deb59ca77feac54a7c0`)— PASS

### 修复评估

`31d85078f fix(teamlead): keep claim redrive identity stable` 比我建议的最小修法更稳,两层:

1. **消除分歧源**：抽出 `REDRIVABLE_LEAD_EVENT_PRIORITY = 2`
   (`legacy-lead-event-reconciler.ts`),三个入队点统一引用 ——
   `workflow-decision-routes.ts`(直投)、`lead-inbox-runtime.ts`(redrive)、
   `workflow-replacement-lead-event.ts`。优先级不再可能漂移。
2. **纵深防御**：redrive 循环改为 per-row `try/catch`，单条毒 row 只记
   `[lead-inbox-runtime] lead event redrive failed` 结构化 warning，不再中止整个 tick。
   非 `workflow_claim_recorded` 的事件类型仍 rethrow(保持既有行为，不扩大改动面)。

### 真机 529 双 Lead N-to-N(本轮补齐了第一轮的最大缺口)

一个真 Bridge(port 19872,`/health` 的 `buildSha` = `b7f94af5c`，与验证头逐字节相同)
+ **两个真 Lead**(`flywheel-test-2` 主 slot、`flywheel-test-4` extra-lead,dept `eng`)
= 真 N-to-N 拓扑。两条真 credential 认证的 verdict 经真 HTTP `/api/workflow/decision` 提交。

**12/12 断言全过**：

| 断言 | 结果 |
|---|---|
| 两条 verdict 均 HTTP 200 落库 | PASS(claim 1 → test-2,claim 2 → test-4) |
| `lead_events` 归属到正确的 owning Lead | PASS |
| **`delivered_at` 正常推进**(第一轮的 BLOCKER-1) | PASS,两条均 `2026-08-30 17:51:32` |
| mailbox row 只发给 owning Lead | PASS |
| claim 未泄漏进另一个 Lead 的信箱 | PASS(双向各 0) |
| bridge.log 新增 `mailbox identity conflict` | **0**(第一轮是 272 且持续增长) |
| bridge.log `Lead inbox tick failed` | **0** |

投递后两条 mailbox row 均由真 Lead 置为 **`ACKED`**(17:52:56 / 17:53:03)——
不是「进了队列」，是真 Lead 消费掉了。

### Discord 真机可见性(第一轮因信箱卡死无法观测,本轮补齐)

两个真 Lead 在**各自** Discord 频道主动播报了判决，全程没有任何 runner 提醒它们:

- `flywheel-test-2` @ 17:52:52 →
  `[FLY2152R2A] ❌ QA 判决:qa_failed(已落库) / Run: ... Node: qa attempt 1 | Claim #1 (qa_verdict → qa_failed) / 下一步:按 DAG 返工回路...`
- `flywheel-test-4` @ 17:52:35 →
  `[FLY2152R2B] 🔴 QA 判决：qa_failed(run ... / node qa attempt 1 / claim 2,17:51:32 落库)。引擎应按 DAG 返工路由接力...`

**这就是 founder 那句质问的正面回答**：判决一落库，owning Lead 自己就知道了，
并且已经在推进返工——不依赖 runner 记不记得推那一条。

### 真机巡检第六维度(第一轮只有 shell fixture,本轮跑了真脚本真数据)

用隔离 `FLYWHEEL_STATE_DIR` + 真 `FLYWHEEL_STATE_DB_PATH` 指向 slot DB，
跑真 `scripts/lead-patrol-snapshot.sh`:

- 报告仍**恰好六步**(`STEP 1`–`STEP 6`,无 STEP 7);
- **已投递的两条 claim 都没有被报**(正确的负例);
- 把 claim 2 的 `delivered_at` 置回 NULL 后重跑，Step 4 精确点火:
  `CLAIM_DELIVERY_PENDING issue=FLY2152R2B claim=2 decision=qa_verdict predicate=qa_failed issued=2026-08-30 17:51:32 node=qa attempt=1 exec=fly2152r2-qa-...`
  —— claim 字段齐全，**无 evidence / summary 泄漏**，且只出现在 owning Lead 名下;
- owner 归属不完整时输出的聚合 `CLAIM_ATTRIBUTION_INCOMPLETE reason=owner_missing count=2`
  **没有压掉**同步的 `DEAD_LETTER_PENDING` —— plan 要求的独立 guard 在真数据上成立。

### 第二轮变异测试(证明新护栏也是真尺子)

| 变异 | 结果 |
|---|---|
| 把直投改回 `leadEventEnvelopeFromJournalRow(row, 1)` | `fly2152-claim-enqueue-priority` 失败 ✔ |
| 去掉 redrive 的 per-row 隔离(恒 rethrow) | `lead-inbox-runtime` FLY-2152 隔离用例失败 ✔ |

### 第二轮门禁

| 项 | 结果 |
|---|---|
| `pnpm lint` | exit 0 |
| `pnpm -r build` | exit 0 |
| 定向套件(含我的回归测试 + 实现方新增的隔离测试) | 154 passed / 7 files |
| `scripts/__tests__/lead-patrol-snapshot.test.sh` | 224 passed, 0 failed |
| `flywheel-edge-worker` 全量 | 1265 passed / 5 skipped |

### 第二轮 honest boundary

- **`CLAIM_DELIVERY_PENDING` 的真机点火用了 DB 层回退 `delivered_at`**，不是真的把
  Lead 进程打死。原因:`launchctl bootout` 被 FLY-913 部署护栏硬拦(它分不清 QA slot
  Lead 与生产 Lead),我没有绕过护栏。因此「Lead 进程真死 → 投递真失败 → PENDING」
  这条完整因果链只验到了后半段;前半段(投递失败会让 `delivered_at` 保持 NULL)是
  第一轮真机自然发生过的,两段合起来覆盖,但不是同一次运行里连起来的。
- **`CLAIM_DELIVERY_MISSING` 与 `CLAIM_DELIVERY_OWNER_MISMATCH` 仍只有 shell fixture
  覆盖**,没有真机数据。MISSING 按设计是「同事务原子不变量被破坏」的 canary,真机上
  无法自然构造。
- **两个 Lead 都回退到频道顶层发言**,因为 slot 的
  `/api/chat-threads/send` 返回 404 `Chat threads not enabled`。这是 529 slot 的配置
  (需 `TEST_REPLY_BY_ISSUE=1`),不是本 PR 的行为;issue thread 内的呈现未观测。
- **本机 teamlead 全量套件未在第二轮重跑**(第一轮 13 个 tmux/socket 类文件失败已归因
  本机环境)。以同头 CI 的 teamlead 1-3 of 3 为准。
- 巡检第六维度的**长期噪音特性未评估**:一条永久投不出去的 claim 会每 tick 复现一条
  warning 且每次巡检都报一次 PENDING,是否需要收敛/降噪留给后续观察。
