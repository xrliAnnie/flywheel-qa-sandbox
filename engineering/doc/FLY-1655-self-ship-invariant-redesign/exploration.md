# FLY-1655 self-ship 按不变量重设计 — 探索

Issue: FLY-1655 (https://linear.app/geoforge3d/issue/FLY-1655/founder-直令唯一单-self-ship-修了又坏-n-真根因每次修复只覆盖上一次事故的状态签名要按不变量重设计)
日期: 2026-08-08
基于: 无(本文件夹首篇;上游为 issue 正文与 FLY-1625 深究单)

## 1. 问题是什么

self-ship(runner 完成开发 → QA → founder 在卡片上批准 → runner 自己 merge + 收尾归档)这条链"修了 10+ 次没修好"。founder 直令:不再开新单,查清真根因,一个单修完。

founder 当场质疑后已确认的核心判断(issue 更正区):**修复确实每次都做了,但每条修复只覆盖上一次事故的精确状态签名**。下一次故障换一个形状,上一次的修复就完全打不到。于是每次都能拿出"我们修了"的证据,而每次都真的没覆盖住。

## 2. 本单探索的真问题

> 为什么每条修复都只覆盖一个状态快照?怎么改成按不变量(invariant)而非按快照设计?

"不变量"指:系统在任何时刻都必须成立的一致性约束(如"runner_ship gate 存在 ⇒ 必须存在未作废的 ship-target 绑定行")。"状态快照"指:某次具体事故发生时各字段的精确取值组合(如 `state='materializing' ∧ materialization_stage='question_intent' ∧ carrier_binding_state='unbound'`)。

按快照设计的修复/杠杆,只在系统恰好长成那个形状时有效;按不变量设计的修复,回答的是"此刻哪条不变量被破坏了、如何对齐",对任何形状都有判定力。

## 3. 事故家族全景(2026-08-05 ~ 08-07 三夜)

| 实例 | 症状 | 一句话机制(取证后) |
|---|---|---|
| A | FLY-1648 走完全流程,verify-approval 返 `ship_target_binding_unavailable` | 账面(`workflow_ship_target_binding`)与现实(PR/head/worktree 全就绪)脱钩:**写入侧在当时部署的旧二进制里根本不存在**,读取侧 fail-closed;升级后的新码只修新 gate、不对账旧 gate |
| B | founder 的批准认不到 + Lead 的转交把门消费掉 | `handle-receipt --action relay` 是一个**没有 founder-gate 语义的 founder-gate 写原语**:同一 commit 里两个兄弟路径都拒 `approve_to_ship`,relay 漏了;写入 response child + `terminal_disposed` 后,门永久离开 founder 候选集,三道独立的墙挡住一切恢复 |
| C | 关一个 runner,引擎 4 分钟补派 2 个(FLY-1650 已交付) | execute 收尾 500 ⇒ 事务回滚零痕迹 ⇒ 工单永远 active ⇒ dead-execution 补位看"活工单无活执行体"就重派;判"已交付"用的是状态字面量(`session.status==='completed'`)而非交付事实 |
| A′(杠杆) | `/gate-carrier-rebind` 对当晚的 gate 返回"不适用" | 杠杆 18 项前置中 3 项(`unbound ∧ materializing ∧ question_intent`)是 FLY-1441 事故的形状拓片;当晚 gate 是 `bound ∧ awaiting_review ∧ completed`,且 `bound→unbound` 在全代码库没有写路径 |
| A″(凭据) | FLY-1649 QA 跑 2 小时,判决 409 `credential_expired`,正文救不回 | founder 定案"钥匙不过期"只落了一半:FLY-1638 把 v2 路径 qa 窗放到 360 分钟,但 legacy 路径硬编码 30min/2h **没改**——又一次照上次事故的签名点修 |

## 4. 元根因(两层)

### 4.1 机制层:账本在写入端"尽力而为",在读取端"fail-closed"

反复出现的同一结构:

- 授权材料(binding/credential/response)在**某个瞬间、某组条件下试写一次**;失败静默(`catch { return false }`、`console.warn`、条件不满足直接跳过),不告警、不重试、不留 skip 痕迹。
- 消费端(verify-approval / head-authority / response-guard)**严格 fail-closed**:缺一行就 409,不解释缺的原因。
- 两端之间**没有任何对账**:没有"读时缺行→当场从冗余数据补齐"、没有周期 reconcile、升级部署也不回填存量。

结果:分歧在写入时静默产生,在(可能很多小时后的)读取时爆炸,爆炸信息不含成因,操作员只能读码反推,然后手改库——而手改库会触发第二层机制(archive sweep 按"有 response child 即可删"把整个 family 删掉)毁账。

### 4.2 流程层:修复按事故签名成形

- 三条操作员杠杆(FLY-1244 / FLY-1441)都诞生于"自己被卡住的那一夜",前置条件是当夜事故的形状拓片。
- FLY-1638 修 `incoherent_ship_bundle`,只修了引爆它的 tpl_generic 形状(改判定不改 seed),QA 凭据窗只改了 v2 路径。
- FLY-1648 修热循环,只接线在 merge 后 gate 收尾一个表面,execute 节点收尾的同类 500 完全不覆盖。
- 深究单(FLY-1625)以"修复方向候选"结单被判 Done,候选不变成代码。

## 5. 设计方向(供 research/plan 展开)

1. **把"账实一致"改成读取时可自愈的不变量**:消费端缺授权材料时,若冗余源(`workflow_node_pr_binding` / carrier session)可完整推导,当场补齐并留审计;不可推导才拒绝,且拒绝必须带"缺什么、为什么缺、哪条杠杆能修"。
2. **杠杆按不变量重写**:对齐杠杆回答"哪条不变量被破坏"而非"你是否长成我见过的样子";把快照条件(B2/B3/B4/B15)剥离,保留真不变量(carrier 指向最新 attempt、head 一致、run 可变更);错误信息逐条报差异。
3. **每个 gate 写原语必须带 gate 语义**:relay 补上与兄弟路径相同的 `approve_to_ship` 拒绝;founder 批准信号的静默丢弃点全部补告警。
4. **收尾失败必须有出口**:execute completion 的 500 族照抄 rework delivery 的"5 次退避→needs_lead→告警"形状;dead-exec 补位判"已交付"用交付事实(merge/receipt)而非状态字面量。
5. **凭据"钥匙不过期"落完另一半**:legacy 路径对齐 v2 窗;fail-close marker 存回正文并建读取方。

## 6. 不做什么(边界)

- 不重写 workflow 引擎/DAG 模型本身;所有修复在现有表结构与机制内做加法或对齐。
- 不动 founder-only-authority 合同:merge 仍 founder-gated,不引入任何自动批准。
- FLY-1436 两条 RESERVED 红线、`workflow_v2` DAG 引擎硬红线不碰。
