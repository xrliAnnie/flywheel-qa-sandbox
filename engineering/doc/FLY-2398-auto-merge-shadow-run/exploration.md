# FLY-2398 自动合并影子跑(两周) — 探索
Issue: FLY-2398 (https://linear.app/geoforge3d/issue/FLY-2398/2309b4-自动合并影子跑两周-四条记录线-错判率表一次都不真的自动合并p1-依赖-b1b2b3)
日期: 2026-09-08
基于: 无(上游为 `product/doc/FLY-2309-auto-merge-rollout/build-issues.md` §B4 与 `prd.md` §4–§5;同级 B1/B2/B3 的 plan 见 `engineering/doc/FLY-2395-*` / `FLY-2396-*` / `FLY-2397-*`)

---

## 0. 一句话

**每张 founder ship 卡她一动(批准 / 打回),系统在同一事务里把「如果自动道开着,这张卡会不会被机器直接合掉」冻结成一行只读记录;两周后一条只读 SQL 把这些行算成 N1 / N2 / N3 与三个分母卫生指标。整个过程不改她的动作、不改任何规矩、一次都不真的合并。**

## 1. 问题(spec 原文 → 工程问题)

spec §B4 要四条记录线同时落、100% 覆盖、只读 SQL 可重算、founder 动作变化量 0、报 0 必报全集。
把它翻成工程问题只有三个:

| # | 工程问题 | 为什么它不是「四张表 join 一下」 |
| - | -------- | ------------------------------- |
| P1 | **线①(机器判的类)在报表时刻已经不在了** | `ship_relevant_pr_snapshot` 是**可变**的当前态(同 PR 换 head 就 UPSERT 覆盖;候选失效就 `deleteShipRelevantPrSnapshotsExcept` 整段删,`plugin.ts:5113-5154`)。生产库只读副本实测(2026-09-08 12:23 PT):**19 条 founder 判决里只有 12 条还能在 holder 的 gate session 下找到主 PR 快照,11 条 head 相同**。照「报表时刻 join」做,起跑第一天覆盖率就 < 100%,表天生不作数 |
| P2 | **线②(人判的类)今天没有任何地方可以落** | spec 要「枚举字段不是自由文本」;现有 Lead 写入面只有 `review-ruling`(评审发现的裁定)与 `evidence-run`(QA 强度二台账),都不是「这单属于哪一类」 |
| P3 | **N1 / N2 / N3 的分母、分子、卫生指标要事先钉死到 SQL 级** | PRD §5.2 要求「事先定死,不许事后调」;而「单」「到过 founder 门」「她本人」「打回」每个词都有两种以上落库形状(卡 vs run、`authority` vs `founder_authored`、`rework` vs 操作员重开) |

## 2. 现状审计(全部来自代码或 2026-09-08 只读库副本;条数会漂,看形状)

### 2.1 四条线各自今天的家

| 线 | spec 说落在哪 | 已落地的表 / API(B1–B3) | 可变性 | B4 能不能直接读 |
| -- | ------------- | ----------------------- | ------ | -------------- |
| ① 机器判的类 | 扩展后的分类快照 | `ship_relevant_pr_snapshot`(v2,主 + 声明 PR,键 `(execution_id, repo_slug, pr_number)`)+ 判定核 `resolveRunShipRelevance(store, session, now)`(`bridge/run-ship-relevance.ts:282`) | **可变**:UPSERT / 删除;60 秒时效(`SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS`) | ❌ 报表时刻读不回当时的判定(P1) |
| ② 人判的类 | 新台账,枚举 | **不存在** | — | ❌(P2) |
| ③ 强度二两半 | 新台账,两半各一字段 | `strength_two_evidence_record`(不可变,触发器禁改删)+ 纯函数 `evaluateStrengthTwo(rows)`(`strength-two/judge.ts`,B4 唯一入口,FLY-2397 §4.3) | 只追加 | ✅ 可按 `(run_id, target_repo_identity, head_sha)` 与 `recorded_at ≤ 判决时刻` 只读重算 |
| ④ 她有没有打回 / 是不是她本人 | `workflow_rework_request` + exact-head 绑定 | `workflow_founder_gate_verdict`(不可变;`verdict ∈ {approved, rework}`、`founder_authored 0/1`、绑 `(repo_identity, repo_slug, pr_number, head_sha)`、`question_id` → `workflow_gate_holder`、`rework_request_id` → 原话) | 只追加 | ✅ |

### 2.2 判决写入点(线④的落点 = 线①③冻结的唯一正确时刻)

四个调用点全部经 `StateStore.recordFounderGateVerdictTx`(`StateStore.ts:54286`),且都在**一个已开启的 StateStore 事务内**:

| 调用点 | 路径 | 判决 | 作者事实 |
| ------ | ---- | ---- | -------- |
| `applyWorkflowSourceEvent` founder_approval(`:55147`) | 她在 Discord 卡上 ✅ / 文本批准 | approved | `actor === founder_id_at_capture` |
| `applyWorkflowSourceEvent` founder_feedback(`:54923`) | 她在卡 thread 打回 | rework | 同上 |
| `openOperatorRework`(`:39490`) | Lead / operator 重开返工 | rework | `founder_message` 引用核实才记 1,否则 0 |
| `openPendingCarryoverFounderFeedbackTx`(`:54060`) | carryover 迟到反馈 | rework | 同 gate_response |

`recordFounderGateVerdictTx` 已经拿到 `binding = resolveFounderGateBindingTx(...)`:`questionId / gateNodeId / attempt / repoIdentity / repoSlug / prNumber / headSha`,并且 `workflow_gate_holder.source_execution_id`(= 持卡的 gate session)一条 SELECT 可得。
⇒ **在这一刻、这一事务里,线①的三个输入(`execution_id, pr_number, pr_head_sha`)与线③的三个键(`run_id, repo_identity, head_sha`)全部在手。** 这是 B4 唯一不需要新造键的观察点。

### 2.3 库副本实况(2026-09-08,`sqlite3 ".backup"` 到 scratchpad 后 `?immutable=1` 查)

| 事实 | 数 | 含义 |
| ---- | -- | ---- |
| `workflow_founder_gate_verdict` 行数 | 19(2026-09-07T22:50Z 起) | 线④已在跑;B2 receipt `fly-2396-founder-gate-verdict-v1` applied 09-07T19:01Z |
| 其中 approved / founder_authored=1 | 12 | |
| 其中 rework / founder_authored=1 | 1 | 她本人打回 |
| 其中 rework / founder_authored=0(全部 `kind=operator`) | 6 | Lead 重开返工;`workflow_rework_request.authority='lead'` |
| 判决 → holder → 主 PR 快照仍在 | 12 / 19 | **P1 的实证**;缺的 7 条含 3 条 approved |
| `strength_two_evidence_record` 行数 | **0** | B3 09-07 20:51 PT 合入、Bridge 09-08 19:01Z 重启后台账才上线;**尚无 QA 记过账** |
| `ship_relevant_pr_snapshot` 行数 / docs_only | 15 / **0** | v2 分类器上线以来还没有一张 docs_only 卡到过 founder 门 |
| `ship_relevant_declared_pr` 行数 / run | 2 / 2 | nested 声明入口已被用过 |
| founder_gate 卡量(过去两周) | 6–38 张/天,中位 ~14 张、~12 单/天 | 两周约 150–200 单;回溯口径 docs_only 占 33/245 ≈ 13% ⇒ 预计 N1 分母 **~20–30 单**,与 PRD §2 的「30 个里 0 条」同量级 |

### 2.4 Lead 写入面先例

`flywheel-comm review-ruling` → `POST /review-rulings`(`plugin.ts:2499`,`tokenAuthMiddleware(config.ingestToken)`,CLI 端 `FLYWHEEL_INGEST_TOKEN` + `FLYWHEEL_BRIDGE_URL`),Bridge 端校验 `ruledBy ≤ 64` 特权文本、枚举 `disposition`、定位器互斥,写 `review_finding_ruling`(`protectedAuthority`)。
⇒ 线②照抄这一条通路的**形状**(CLI → 单一 Bridge 路由 → StateStore 事务 → 只追加表),不复用它的表。

### 2.5 Lead 在哪一刻知道「有一张 ship 卡」

`formatGateQuestion`(`bridge/hook-payload.ts:1393`)在 `checkpoint === "approve_to_ship"` 时给 Lead 的事件文本已含 `Question ID`,并明写「relay this gate to the founder. Do NOT run `flywheel-comm respond`」(FLY-2427)。
⇒ 线②的声明命令以 **question_id 为定位器**最自然:Lead 看到的就是它,Bridge 由 `workflow_gate_holder.question_id → run_id` 反查,不让 Lead 手填 run_id。

## 3. 三个方案(P1 怎么解)

| | 方案 | 线①覆盖率 | 一份事实 vs 镜像 | founder 路径风险 | 结论 |
| - | ---- | --------- | --------------- | ---------------- | ---- |
| A | **报表时刻 join**:两周后拿四张表现状 join | 实测 12/19 起步,随 session 清理继续掉 | 最纯(零新表) | 零 | ❌ 违反「覆盖率 100% 否则不作数」,而且错在**乐观方向**(掉的正是完成后被清的卡) |
| B | **给快照表加历史表**(每次 UPSERT/删除前 copy 一行到 `*_history`) | 100% | 镜像整张快照表 | 零(只在 B1 服务层加写) | ❌ 改的是 B1 的写路径(FLY-2395 刚过四轮评审),而且历史表要重放 60 秒时效判定才能得到「判决那一刻的类」—— 等于把判定核再写一遍 |
| **C**(选) | **判决时刻冻结一行观察**:`recordFounderGateVerdictTx` 同事务内,用**同一个判定核**(`resolveRunShipRelevance` + `evaluateStrengthTwo`)算出线①③,连同输入事实(每个候选 PR 的 repo / pr / 期望 head / 快照 head / ship_relevant / version / computed_at)冻结进 `auto_merge_shadow_observation`,主键 = `verdict_id`(1:1) | 100%(与线④同生同灭) | 线①:**这一行就是唯一幸存的事实**(源头本来就会被删);线③:是可被 SQL 重算的投影,SQL 包里附一致性断言(不一致 = 表不作数) | 需要处理:观察写失败**不许**拖垮她的批准 ⇒ SAVEPOINT 隔离(见 §5) | ✅ |

**C 的一个诱惑要拒绝**:把线②(Lead 声明)也冻结进观察行。不行 —— 声明可能在判决之后才补,冻结会把「迟到的声明」永久记成「未声明」。线②只追加、报表时按 `declared_at ≤ 窗口截止` 取每 run 最新一条,并单列「声明晚于判决」的条数(卫生指标,不进分子分母)。

## 4. 线②(人判的类)的形状

- **枚举**(稳定标识 → 显示标签):`pure_docs`→纯文档类、`config_only`→配置类、`single_point_change`→单点修改类、`other_code`→其它代码。
  前三个直接来自 FLY-2261 research §1 的三类候选;`other_code` 兜底。**没有自由文本字段**——连「备注」都不给,给了两周后就有人拿它当分类。
- **定位器** = `question_id`(那张卡);表里同时落 Bridge 反查出的 `run_id`,报表按 run 聚合。
- **只追加**:再声明 = 新行,最新一条生效;不许改删(触发器)。
- **谁能写**:与 `review-ruling` 同一 ingest-token 边界;`declared_by ≤ 64` 特权文本(Lead id),Bridge 不解释它、不用它做任何判定。
- **什么时候提示 Lead**:`formatGateQuestion` 的 approve_to_ship 分支**加一行 Lead-only 提示**(带 question_id 的现成命令)。这是 prompt-promise 边界:不保证 Lead 一定声明 ⇒ 「未声明」条数就是那个诚实指标。**founder 卡文案零改动**(卡是 Bridge 直发 Discord,不经这段文本)。

## 5. 必须事先想清的边界

| 边界 | 定 |
| ---- | -- |
| **观察写入失败** | `SAVEPOINT` 包住观察 INSERT;失败 → `ROLLBACK TO` + `console.warn`,**判决照常提交**。代价:那条判决没有观察行 ⇒ 报表「观察缺失」≥ 1 ⇒ 覆盖率 < 100% ⇒ 表不作数。这正是 PRD §5.2 想要的 fail 方向(宁可表作废,不改她的动作) |
| **重放** | 判决按 `source_event_id` 幂等(同 digest 返回旧行);观察行与判决同事务、同主键,**重放路径不重算、不重写**(它在 `existingRow` 分支之前就返回了) |
| **判决之后才记的强度二行** | 冻结的是 `recorded_at ≤ 判决时刻` 的行集;SQL 一致性断言只比这个子集。晚记的行在报表里单列「判决后补账」条数 |
| **她批准后 head 又动了、又出一张卡** | 每张卡各自一条判决 + 一条观察;run 级聚合时「该 run 任一 docs_only 卡被她本人打回」即进 N1 分子 |
| **机器判 `unknown`** | 不进 N1/N2 分母(不是 docs_only),单列条数与 reason 分布。**不许把 unknown 折进 docs_only 或 ship_relevant** |
| **B1 的两个 bounded fail-open(Lead 2026-09-06 裁定,必须列)** | (i) 声明 PR 的 docs 快照 30s 租约 + 3s poll ≈ 33 秒窗:观察行记每个候选的 `snapshot_age_ms`(判决时刻 − computed_at),SQL 单列「docs_only 且任一声明 PR 快照年龄 > 30s 的卡 = N」,**为 0 也报**;(ii) 1,500/h 预算按进程计、重启归零 —— 影子跑不受影响(预算耗尽 ⇒ unknown ⇒ 不进分母),写进已知限制 |
| **B1 残余 G1(事后发现的 nested PR)** | SQL 单列:docs_only 观察行所属 run 在判决之后出现 `codex_review_record.target_repo_identity <> '__main__'` 且 head 不在冻结候选内的条数 |
| **B3 的 `verified_then_expired`** | `probeRecordLiveness` 会发网络请求,**不进只读 SQL**;报表脚本有 `--probe-record-liveness` 可选开关,输出单独一列并标「非 SQL 可复现」 |
| **N2 的口径** | PRD 写 `authority='founder'`;今天 `openOperatorRework` 写的是 `authority='lead'`(`StateStore.ts:39469`),founder_feedback 路径写 `'founder'`(`:54046`)。N2 = 打回判决 join `workflow_rework_request.authority='founder'`;另单列「全部打回(含 lead / operator)」作最宽上界,**不冒充 N2** |
| **计时起点** | founder 未定(PRD Q1;已 ask Lead,id `70d912cc`)。设计上**不写死**:报表脚本必填 `--window-start/--window-end`;库里 `state_store_migration` receipt `fly-2398-shadow-observation-v1` 给出观察最早可能时刻,早于它的窗口直接拒绝。默认建议:**从观察表上线后首条完整四线记录落库那天起算**(否则前几天覆盖率天然 < 100%) |
| **一次都不真的自动合并** | B4 零合并代码;新表**没有任何 gating reader**(照 `fly2396-no-gating-readers.test.ts` 加同款测试:`auto_merge_shadow_*` 只允许出现在 StateStore、路由、CLI、报表脚本、registry 五处) |

## 6. 非目标

- 不动 `founder-only-authority` / merge 授权契约;不给自动道写一行执行代码。
- 不改 B1/B2/B3 的任何表、任何判定核、任何 review-hold 行为。
- 不做 B5(规矩清单)。
- 不做「配置类 / 单点修改类」的机器判定 —— 线②只是人的标签。
- 不补历史:观察表上线前的 19+ 条判决永远没有观察行,报表按窗口排除并报出条数。

## 7. 待 Lead / founder 的问题

| # | 问题 | 阻塞? |
| - | ---- | ------ |
| Q1 | 两周计时起点(见 §5 末行) | 不阻塞设计与实现;阻塞「两周后交表」的日期 |
| Q2 | 线②提示放 `formatGateQuestion`(代码内、可测)还是只写进 Lead agent 说明(仓外) | 不阻塞;默认前者 |
