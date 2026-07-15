# FLY-1279 runner park 在门口无人知会 — QA 验证报告

Issue: FLY-1279
日期: 2026-07-15
基于: plan.md（实施计划 v2）、PR #606

## 结论

**PASS** — 验收标准达成，founder 升级链路有真机铁证（真发 Discord + API 读回）。

2 条已收口发现（§4）+ 明确的覆盖边界（§5）。RE-TEST 抓到并已闭合一条 HIGH（§7 held-review silent-hole），另补一条 plan V2 验收腿的真机重放（§8 clean-retry）。

> 本报告经 Codex 独立审查（xhigh，delta @ `e7412201d`），**CHANGES REQUESTED，0 HIGH**。
> 它抓到我 **S6 断言恒真** 和 **报告夸大真机覆盖** 两条真问题——都已修（§6）。
> 本文是修正后的版本。

## 1. 验证范围与方法

被验对象 = 本分支已提交的实现（PR #606）。QA 不重新实现。

产品代码主体改动量以 **implement 阶段收尾的 head `5f2b284fc3`** 为准：`origin/main...5f2b284fc3`
= **74 文件 / +6621 / -197**。QA 阶段随后增加 E2E 脚本和本报告；最终收口阶段依据 F1
补了 founder-facing `park:*` 人话映射及回归测试。每次提交都会让 `origin/main...HEAD` 的总数变化，
故不在此追滚动数字（Codex R2 LOW-3）。

| 层 | 做法 |
|----|------|
| 单元 | 本 PR 相关 10 个测试文件聚焦跑 |
| 真机 E2E | `scripts/qa-fly-1279-park-notify-e2e.mjs`：真 StateStore + 真 park-watch + 真 notifyLeadFirst + 真 reconcile + 真 founder pager → **真发 Discord** → **从 API 读回** |
| 对照 | origin/main worktree 对照，区分「本 PR 回归」与「本机环境失败」 |

真机段是必须的：单元测试 `park-watch.test.ts` 的 `notify` 是 stub，**只证明了检测逻辑，没证明消息真能送到 Lead / founder** —— 而后者才是 1279 的全部意义。

## 2. 测试结果

### 2.1 真机 E2E — 25/25 PASS

`TMPDIR=/tmp node --import tsx scripts/qa-fly-1279-park-notify-e2e.mjs` → exit 0

| 场景 | 断言 | 结果 |
|------|------|------|
| S0 | 隔离 529 频道可达（否则后续 PASS 全是空的） | PASS |
| S1 | park 在 founder 审批门 → Lead 收到（durable lead_event） | PASS |
| S1 | Lead 通知带 issueId + 门类型 + PR 号 | PASS |
| S1 | Lead 结构化通知带 `waited_ms`，render 后直接显示等待时长 | PASS |
| S1 | N2 宽限期内 founder **不**被打扰 | PASS |
| S2 | Lead N2 内没 present → founder 被升级 | PASS |
| S2 | **founder page 真的落进 Discord**（API 读回，msg id 实证） | PASS |
| S2 | page 真 @ 到 founder（断言 **Discord 自己解析的 `mentions[]`**，非我方文本自证） | PASS |
| S2 | page 说清哪个 runner park 了 | PASS |
| S2 | founder page 用人话解释 park，不泄露内部 `park:*` kind | PASS |
| S3 | 健康 QA hold → Lead 收到 | PASS |
| S3 | 健康 QA hold → founder **永不**被升级（lead_only 抑制） | PASS |
| **S3-MUT** | **突变：拆掉 lead_only 守卫后确实升级（0→1）→ S3 非空过** | PASS |
| S4 | goal 自标 blocked → Lead 收到（1254/1251 形态） | PASS |
| S4 | Lead N2 内没 present → blocked goal 升级 founder | PASS |
| S4 | blocked founder page 真落 Discord + 真 mention + 人话文案 | PASS |
| S5 | 重复 tick 不重复通知活 episode（不刷屏） | PASS |
| S7 | **独立 QA session 死掉 → implement 的 hold 暴露为 orphaned**（1238 形态） | PASS |
| S6 | 两个同 kind park → **各自进入 individual pager**，不被 fleet 聚合吞掉 | PASS |
| **S6-MUT** | **突变：拆掉 page_no_fleet 后确实聚合，且聚合 payload 含这对的 target → S6 非空过** | PASS |
| S8 | held review 无 codex row → Lead 收到、founder 不被误叫（silent-hole guard） | PASS |
| S9 | 独立 QA 死亡无裁决 → 重试入队（retry_pending），implement 不静默卡死 | PASS |
| S9 | 干净重试拉起 → 新 QA exec 运行（implement 的 QA 又活了） | PASS |
| **S9-MUT** | **突变：第二次死 → exhausted 而非再次 retry_pending → 重试有界，非无限循环** | PASS |

> S6 的精确边界（Codex R2 LOW-2）：该臂证明的是两个 episode **分别进入 individual pager**、
> 没被聚合——**不是**它们都落进了 Discord（这两个没有 chat-thread 绑定，实际返回 `no_chat_thread`）。
> 「真的落进 Discord」的证据是 **S2**，不是 S6。

**S2 真机铁证** — 从 Discord API 读回的真实文案（`mentions[]` 实测含 founder id）：

```
🤖[自动] <@1138…306> 🚨 FLY-qa1279…approval [Watchdog] Runner 正在等待 founder 审批
(target=qa1279…approval)。owner Lead(flywheel-eng-lead)已在 11 分钟前收到通知,至今无处置 → 升级给你。
```

最终收口重演从 Discord API 读回审批门消息 `1527048703419093132`，并同时断言原始
`park:awaiting_review` 不在 founder-facing 文案中。

**S4 blocked 真机铁证**：Discord API 读回消息 `1527048705406926909`；文案为
`Runner 已因无法继续而暂停`，不含 `park:blocked`，且 `mentions[]` 实测包含 founder id。

**两条 MUT 是这份报告的骨架**。抑制类断言（「不该发的别发」）在任何写错的 harness 里都恒真。
突变对照把守卫拆掉、看它是否真的会发，才证明 PASS 有意义。S6-MUT 第一版**没能杀死测试**
（fleet 窗口默认 1h，被假时钟挤出去了），说明当时 S6 确实是空过 —— 修好窗口后 MUT 才真正触发。

### 2.2 单元测试 — 本 PR 相关模块 277/277 PASS（最终 main 汇合 + S8 后）

park-watch / lead-event-delivery(+migration) / delivery-secret / auto-qa-coordinator /
detection-escalation(+reconcile) / gate-poller-qa-reconcile / phase-orchestrator /
StateStore.auto-qa-record → **10 文件 277 测试全绿**（此前 QA head 为 259；合入最新 main、R3、F2 与 S8 回归后用例增加）。

F1 的 `detection-escalation-sinks` 与集中式 hold 的 `review-held` 定向套件另为
**29/29 + 21/21 PASS**；合计 12 文件 **327/327 PASS**。

### 2.3 全量套件 — 本机负载主导，不作为判据；CI 绿是判据

本机 load average **23–29**。全量跑失败数在 42–49 之间**随负载漂移**。归因：

| 失败 | 数量 | 真因 | 证据强度 |
|------|------|------|----------|
| `codex-lead-runtime` | 22 | runner 的 TMPDIR 落在 `~/.flywheel` 下，被 full-access 重叠校验**正确**拒绝 | **确证**：`TMPDIR=/tmp` → 114/114 PASS（Codex 独立复现） |
| `run-dispatcher` | 9 | runner env 注入 `FLYWHEEL_RUNNER_BACKEND=codex`，测试断言 claude-tmux 默认路径 | **确证**：unset → 39/39 PASS；**origin/main 对照同样 9 失败**（Codex 独立复现） |
| 其余（real-tmux / real-git / preflight / close-runner / post-ship） | ~11 | 高负载 5s 超时 | **较弱**：抽样 main 对照（`createLeadRuntime-preflight` 两侧各跑 3 次，均随机过/败；`worktree-quarantine` 两侧同败），未逐文件留日志 |

诚实结论：前两类是确证的环境问题，**与本 PR 无关**。第三类我只做了抽样对照——
它们全部落在**本 PR 未触碰的文件**里且在 main 上同样 flaky，所以我判定为环境噪声，
但**没有逐文件的铁证**，不宜说成绝对的「无一回归」（Codex LOW-2 的批评成立）。

判据不是本机全量，而是：①CI（干净环境）Build & Test **pass**（ship head `f572ebcda` 实测绿）②隔离跑 12 文件 **327/327**（本轮我亲跑）③真机 E2E **25/25**。

## 6b. RE-TEST 抓到并闭合的 HIGH（held-review silent-hole）

三段式 RE-TEST 循环里，implement 阶段一个**未经要求**的 commit（`77bac3383`「suppress held review park pages」）把 1279 要治的病重新放回来了 —— 我判 FAIL 并证死：

- **形态**：session 停在 founder 审批门、有合法 PR head，但 `codex_review_record` 行不存在（defect ④ QA-role record drop）→ `reviewHoldReason()='codex_pending'` → park-watch 抑制 park:awaiting_review → 静默；FLY-863 stuck-hold watcher 的查询是 `WHERE status='pending' AND hold_notified_at IS NOT NULL`，**要求行存在**，覆盖不到「行不存在」→ 两边都不管 = 零通知永远。
- **实测铁证**（隔离 store，阈值放到 0 最宽松）：`no codex row → codex_pending → park-watch []  | stuck-watcher rows=0`。
- **修复（Lead 裁定的 (c) 方向）**：新增 `park:review_hold` kind（进 `LEAD_ONLY_PARK_KINDS`，founder 被抑制、Lead 仍被通知），6 个 `ReviewHoldReason` 值各配一条中文人话 notice（`Record<ReviewHoldReason,…>` 类型编译期强制全覆盖，我逐一核对 6/6 一一对应）。
- **核实（同一隔离复现，修后）**：`no codex row → codex_pending → park-watch ["park:review_hold"]` —— Lead 被通知、founder 未被误叫。
- **S8 守卫**：harness 新增 S8（裸 session 走抑制路径，断言有人被通知）。修前 RED（SILENT），修后 GREEN（`leadTold=true founderPaged=false`）。**从此这个洞不可能再靠夹具变绿** —— 上次它能瞒过全绿 E2E，正因所有场景预塞了 approved 记录、跳过抑制路径。

## 6c. S9 — clean-retry 真机重放（plan V2 验收腿；Lead 加验，规格 R2：必须驱动真 AutoQaCoordinator）

S7 只证「QA 死亡被检测到」；S9 补上「协调器真的会救」。Lead 的 R2 规格明确：**不能只翻 StateStore 字段**，必须**驱动真 `AutoQaCoordinator.sweepOrphanedQaRecords()` 穿过 spawn 边界**，证明真的发起了一次 fresh QA 拉起。

- 构造**真 `AutoQaCoordinator`**，唯一的假件是**边界端点（记录式，非 mock 逻辑）**：`startDispatcher.start`（记录每次拉起 = spawn 断言点）+ `effects.*`（记录告警/线程等）。中间的死亡检测、retry claim、`canLaunchRecovery`、有界计数器全是真协调器 + 真 StateStore。
- **① 真 sweep 驱动**：seed「implement 停审批门 + auto_qa_record running + qa_issue_id + QA session status=failed」→ `await coord.sweepOrphanedQaRecords()`。
- **② spawn 边界真被打到**：`startCalls.length === 1`，record 从 retry_pending 走到 running（新 successor exec）。协调器真实告警实测：`auto-QA …qa1 died without a verdict …; automatic retry queued (1/1). Founder remains held.`（founder 保持 held，Lead 收到告警）。
- **③ 第二次死 → exhausted**（S9-MUT，有界性）：successor QA 在下一次 sweep 被判死 → record `stuck`（exhausted），**且无二次 spawn**（`startCalls` 仍 === 1）。不是无限循环。

## 3. 对照验收标准（issue §验收）

**证据分级**：🟢 真机 E2E 实证 / 🟡 单元测试覆盖（无真机段）

| 验收标准 | 状态 | 证据 |
|----------|------|------|
| runner park 在 founder 审批门 → Lead N 分钟内收到；再 N 分钟没 present → founder 收到 | 🟢 | S1 + S2（真 Discord 读回 + `mentions[]` 实证） |
| QA session 死掉 → 告警 | 🟢 | S7（真机：QA session 死 → `park:qa_hold_orphaned` 通知 Lead） |
| QA 死 → **自动 clean-retry，implement 不再永等** | 🟡 | auto-qa-coordinator 单测（253 行新增）+ `run-dispatcher.ts` 的 `qaContext ? null : resume`（修掉 recovery 被翻成 shared-branch takeover —— 正是 1238 里 `worktree_takeover_failed` 的死法）。**真机未重演一次完整的 clean-retry 重启**。 |
| goal 自标 blocked → **Lead** 被通知 | 🟢 | S4 |
| goal 自标 blocked → **founder** 兜底 | 🟢 | S4（真 Discord 读回 + `mentions[]` + 人话文案） |
| 真机重演 → 不再有「3-4 小时无人知」 | 🟢 | S1→S2 就是 1254/1238 形态的重演：10min Lead → 10min founder，闭环 |

（初版报告把「QA 死亡检测」整条打了 🟢 并引用 S3 —— 但 S3 测的是 `qa_hold_healthy`，
不是死亡检测。这是拿标签冒充事实，Codex 抓出来了。现已补 S7 真测死亡路径，
并把仍未真机验的部分诚实降级为 🟡。）

## 4. 发现

**F1 · founder 面文案对 park kind 没有人话映射 — 已收口**

`detection-escalation-sinks.ts` 的 `describeKind()` 没有 `park:*` 分支，走 default 兜底 →
founder 读到 **`检测到异常(park:awaiting_review)`** 这种生硬 kind 串（见 §2.1 真机文案）。

- 收口：`describeKind` 为 founder 会遇到的 `park:*` 类型增加中文人话映射，并保留未知 park 的人话兜底。
- 回归：table-driven 单测覆盖 6 个关键 kind；真机 S2 从 Discord API 读回新文案并断言内部 kind 不泄露。
- 结果：最终真机 E2E 从 18 条扩为 **19/19 PASS**。

**F2 · 「等待时长」不是 payload 字段 — 已收口**

issue §要做1 要求通知带「issueId、门类型、PR、等待时长」。最终收口在 park notice
写入 `waited_ms = max(0, notifyAt - firstDetectedAt)`，并由两个 Lead runtime 共用的
`formatDetectionEscalation()` 渲染为人类可读 `Waited: <duration>`。S1 真机实测 payload
`waited_ms=10799864`，单测钉住 49 秒计算和 10 分钟 render 两端。

## 5. 覆盖边界（诚实声明）

真机 E2E **没有**覆盖：

- `park:gate_row_missing` / `park:gate_unreachable`（FLY-1262/1264 形态）——需要 CommDB gate fixture，留给单元套件；本脚本显式 `setReviewBinding(questionId: null)` 把审批门 park 信号隔离出来。
- **auto-QA 的 clean-retry 重启本身**（见 §3 🟡）——只验了「死亡被检测到」，没验「重启后跑起来」。
- Lead **transport** 本身（mailbox 打断式注入 / Codex instruction）——FLY-142/168 基建，有自己的真机 E2E；本脚本断言的是 `notifyLeadFirst` 写下的 durable `lead_events` 账本（投递台账），不是最后一跳。
- D1 送达保证的 ACK/重投/死信全状态机——`lead-event-delivery.test.ts` 覆盖（本次跑绿），未做真机重启段。

## 6. Codex 独立审查（delta @ `e7412201d`，xhigh）

**CHANGES REQUESTED，0 HIGH。** 全部采纳并已修：

| 级别 | 问题 | 处置 |
|------|------|------|
| MEDIUM-1 | **S6 断言恒真**：每 kind 只 1 条 pageable，fleetThreshold=2 永不可达，policy 改错也照过（Codex 实测反事实 `pages=3, fleet=0, s6_predicate=true`） | 重构：每臂各用**一对全新** parked runner（reconcile 只吃 LEAD_NOTIFIED，复用旧 episode 也没用）+ 放宽 fleet 窗口越过假时钟 skew + 加 **S6-MUT**（现在真能杀死测试） |
| MEDIUM-2 | founder ping 断言**自证**（只查自己配的 id 出现在文本里）；fallback id 还与真 id 不符 | 改断言 Discord 返回的 `mentions[].id`；**去掉 fallback**，`DISCORD_OWNER_USER_ID` 缺失即 fail-closed |
| MEDIUM-3 | **报告夸大真机覆盖**：S3 只测健康 hold 不 page，没造 QA death / orphaned / clean-retry；S4 只到 Lead 没到 founder | 补 **S7** 真测 QA 死亡 → orphaned；验收表改为 🟢/🟡 分级，未真机验的诚实降级（§3） |
| MEDIUM-4 | 等待时长没被验证，且 HookPayload 根本没这字段 | 记为 **F2**（§4）+ S1 加一条钉住缺口的断言 |
| LOW-1 | `upsertSession()` 不持久化 `review_question_id`/`pr_head_sha`，场景描述不实 | 改用 `setReviewBinding()` |
| LOW-2 | §2.3 剩余 ~11 个超时无逐文件对照，不能绝对声称「无一回归」 | §2.3 加证据分级，措辞改为抽样对照 + 明说证据较弱 |
| LOW-3 | 报告 diff 统计过期 | 改为固定引用 implement 收尾 head `5f2b284fc3` 的 **74/+6621**（产品代码真实增量），不再追随每次 QA 提交漂移的滚动数字 |

**Codex 确认通过的部分**：所有调用的方法/字段真实存在、无 optional-chaining 静默跳过；
隔离成立（临时目录 + 唯一外部写入固定在 529 测试频道）；S3-MUT 是有效的同路径突变控制；
`TEST_BOT_TOKEN_1` 未被打印或写入日志。

### R2（delta @ `2872db9ff`，xhigh）— **APPROVED，0 HIGH / 0 MEDIUM**

Codex 复跑了反事实，独立确认修好了：

- **S6 已非空过**：正常策略 `fleet delta=0 / individual attempts=2`；把 `page_no_fleet` 改成 `page` 后 S6 明确变红（`fleet delta=1 / attempts=0`）。
- **S7 确实走死亡路径**：持久状态 `auto_qa_record.status=running` + 绑定的 QA session `status=failed` → 真发 `park:qa_hold_orphaned`；把 QA session 改回 `running` 则发 `qa_hold_healthy`。
- founder id 缺失时实测 exit 2，fail-closed。
- 报告的 🟡 分级「现在诚实，没有再冒充真机覆盖」。

R2 的 3 条 LOW 也已修：

| 级别 | 问题 | 处置 |
|------|------|------|
| LOW-1 | S6-MUT 的第二对 pair **并未独立承载证据**：S6 正常臂的两次 page 因 `no_chat_thread` 失败，行仍留在 LEAD_NOTIFIED，删掉 `fleetmut` 整对后脚本仍 18/18 —— 突变其实是被第一对的残留行触发的，注释里「每臂独立、消费一次」不成立 | fleetSink 改为记录 `targets`；S6-MUT 现在断言聚合 payload **含 `fleetmut` 的 target**（实测 targets 含 `fleetmut1/2`），第二对才真正承载证据；注释改为陈述实测行为（page 失败 ⇒ 行不被消费） |
| LOW-2 | 报告「各自单独升级」强于证据（两次实际是 `no_chat_thread`，没落 Discord） | 改为「各自进入 individual pager」+ 明说 S2 才是落地证据（§2.1 引注） |
| LOW-3 | diff 统计仍在漂 + 时钟说明写反（`Date.now()+3h` 是**领先**真实时间，不是「之前」） | 统计改为固定引用 implement head；时钟措辞改为「领先」 |

**注**：Codex 两轮都**没能把 review 发到 GitHub**（GitHub App 写入被拒 + `gh api` fallback 连不上
`api.github.com`），所以 PR #606 上看不到它的评论。以上是它 stdout 的本地权威结论，逐条誊录。

### R3（delta @ `276d81d4f`，cross-family）— **CHANGES REQUESTED，1 MEDIUM**

review 指出 park-watch 是新增 founder surface，却没有复用集中式 `reviewHoldReason`；因此
`merge_block` / `codex_pending` / QA evidence hold 可能被误写成「等待 founder 审批」，叫醒一个
实际上无法操作的 founder。这个判断与 plan.md §5 的互斥约束一致，已按 TDD 收口：

- RED：`merge_block` + declared park 的 session 实测错误产出 `park:awaiting_review`。
- GREEN：generic awaiting/blocked/declared 分类先服从 `reviewHoldReason`；QA-specific 与 broken-gate
  incident 仍保留，避免吞掉 QA recovery 和 gate-row 故障。
- 真机对照：旧 fixture 因准确变成 held 而从 19/19 降为 8/13；补齐真实 cross-family review-ready
  evidence 后恢复 **19/19**，证明「held 不 page、ready 才 page」两边都成立。

### R4（QA RE-TEST @ `e86f0482e`）— **FAIL，1 HIGH；已收口**

QA 新增不带 codex record 的裸 implement session（S8），复现 `codex_pending` 被完全抑制后
Lead/founder 都无人收到的 silent hole：旧 head 真机为 **21/22，S8 RED**。

收口采用「只压 founder 腿、不压 Lead 腿」：

- `park:review_hold` 加入 `LEAD_ONLY_PARK_KINDS`，held review 仍进入 durable Lead ACK 链，绝不 page founder。
- active QA record 继续优先走现有 QA-specific kind；broken/missing gate 继续优先走 gate incident。
- `ReviewHoldReason` 六个值（merge/codex/QA/evidence/reviewer）由 exhaustive `Record` 各有中文原因与 Lead next step。
- S8 原 fixture 未修改，真机复跑 **22/22 PASS**（`leadTold=true founderPaged=false`）。

## 7. QA 自身的坑（留给下一个人）

本次 harness 迭代中跑出过 **6 个假 FAIL + 2 个假 PASS**，全是我自己的错：

1. **时钟**：StateStore 用 SQL `datetime('now')` 打 `awaiting_review_entered_at` / `started_at`，**覆盖**播种的历史时间戳。假时钟必须**领先**真实时间（`Date.now() + 3h`），否则 episode 年龄为负、什么都不触发——**看起来和产品 bug 一模一样**。`park-watch.test.ts` 早就这么写，是有原因的。
2. **同一个假时钟会把 episode 挤出 fleet 窗口**（默认 1h）→ 聚合永不可达 → S6 恒真。**这是假 PASS，比假 FAIL 危险得多**：只有突变对照能发现。
3. **`?.` 可选调用 = 静默空过**：`store.upsertAutoQaRecord?.()` / `db.insertMessage?.()` 两个方法都不存在，可选链让它们静默跳过。真名是 `claimAutoQaRecord` / `setAutoQaQaExecutionId(parent, **targetPrHeadSha**, qaExecId)`（3 参）。**QA 脚本里不要用 `?.` 调方法。**
4. **payload 字段**：park kind 在 `event.escalation_kind`，不是 `event.kind`。
5. **`chat_threads` 主键是 `thread_id`**：多个 issue 复用同一 thread_id 会互相覆盖。
6. **`upsertSession` 不写 `review_question_id`/`pr_head_sha`**：要用 `setReviewBinding()`。
7. **reconcile 只吃 LEAD_NOTIFIED 行**：已 ESCALATED 的 episode 无法被第二次 reconcile 复用做对照。

这些都写进脚本头部注释了。**通用教训：抑制类断言（「不该发的别发」）必须配突变对照，否则它在坏 harness 里恒真。**

## 8. 复现

```bash
# 真机 E2E（需要 TEST_BOT_TOKEN_1 + DISCORD_OWNER_USER_ID；发到隔离的 529 测试频道，不碰生产）
TMPDIR=/tmp node --import tsx scripts/qa-fly-1279-park-notify-e2e.mjs

# 聚焦单测（必须清掉 runner 注入的 env，否则假失败）
cd packages/teamlead && env -u FLYWHEEL_RUNNER_BACKEND TMPDIR=/tmp \
  ./node_modules/.bin/vitest run src/__tests__/park-watch.test.ts \
  src/bridge/__tests__/auto-qa-coordinator.test.ts  # …等 10 个文件
```
