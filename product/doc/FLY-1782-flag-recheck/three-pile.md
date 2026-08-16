# FLY-1782 · 三堆切分(按「删掉之后固化成哪个值」)

**日期**: 2026-08-15
**依据**: Annie 2026-08-15 裁决 —— 「如果它一直 enable 且没问题,我们就保持 enable,把 disable 那条线删掉」
**判据**: 两列机器事实 —— **当前生效值** vs **默认值**。①②的分界线就是这两列相不相等。

> ⚠️ **这份是识别,不是建议删。**「95%」是 Annie 对结果的预期,不是判据。
> 每一条的归堆只由那两列决定;要不要真删是执行单的事,而且逐条仍需确认。

---

## 0. 切分结果

| 堆 | 含义 | 条数 |
|---|---|---|
| **①** | 删了**零行为变化**(当前生效值 == 默认值) | **111** |
| **②** | 删了**会改变行为**(当前生效值 ≠ 默认值) | **11** |
| **?** | 机器判不了,要人定 | **2** |

①里还要再分,因为它们不能混进同一批执行:

| ① 的子堆 | 条数 | 为什么要分开 |
|---|---|---|
| 普通布尔 | **36** | 真正可以批量走的那批 |
| **安全关键 / kill switch / 治理门** | **60** | 即使删也要单独走,不混批量(HL 硬要求) |
| 数值 / 枚举旋钮 | **15** | 删它 = 把常量写死,和「删开关」不是同一件事(见 §3) |

---

## 1. ② 删了会改变行为(11 条 —— 这堆每条都要跟她讲清楚)

Annie 原话:「你确实需要跟我讲一下,我需要理解它到底是怎么样的情况。」
所以这堆**不是清单让她猜**,每条都要写「现在什么样 / 删了变成什么样 / 谁会感觉到」。下表先给机器事实,人话稿等对齐后再写。

| 开关 | 类型 | 默认 | 现在 | 类别 |
|---|---|---|---|---|
| `cmux_linked_view` | bool | true | false | kill_switch |
| `lead_cross_dept_channel_ids` | value | "" | 1512578695468941333 | feature |
| `founder_consent_decision_mode` | enum | "off" | audit_only | governance_gate |
| `qa_auto` | bool | false | geoforge3d=false, joycon-typeless=false, personal-assistant=false, growth=false, | feature |
| `doc_flow` | bool | false | geoforge3d=false, joycon-typeless=true, personal-assistant=false, growth=false,  | feature |
| `skill_framework_mode` | enum | "superpowers" | split | feature |
| `workflow_template_dispatch` | bool | false | true | feature |
| `workflow_gate_carrier` | bool | false | true | feature |
| `workflow_generalized_templates` | bool | false | true | feature |
| `workflow_claims_write` | bool | false | true | feature |
| `workflow_claims_read` | bool | false | true | feature |

**其中已经有结论、不必再问她的:**

- 五个 DAG 开关(`workflow_template_dispatch` / `workflow_generalized_templates` / `workflow_claims_write` / `workflow_claims_read` / `workflow_gate_carrier`)
  —— **HL 已拦下**。她那句「好像也没有在用」对它们不成立:今天 22 个 run / 31 个 claim 全跑在上面,关掉 = 整条派工链停摆。
- `cmux_linked_view` —— 她说「关掉删了算了」,**但它现在就是关的(=0),默认是开**。
  ⇒ **删掉 = 回到默认 = 变成开**,和她的本意相反。**这条是「删 ≠ 关」最干净的例子。**

## 2. ? 机器判不了的 2 条

| 开关 | 为什么判不了 |
|---|---|
| `lead_core_mention_gated` | 值由 launcher 按 projects.json 拓扑现算,不在 .env 里 —— 要跑一次 core-room-gate-cli 才知道每个 Lead 的实际值 |
| `ponytail` | 项目层 dormant(注册了但 run-infra 明确不加载)。它是 Annie-exception,删不删要她定 |

---

## 3. 🔴 一个会决定「<20」能不能达成的口径问题(要 Annie 定)

**124 条里有 20 条不是 on/off 开关**,是数值/枚举旋钮(超时、次数、天数、路径、模式枚举):

- `liveness_activity_window_ms`
- `ship_ready_remind_ms`
- `deferred_approval_ttl_ms`
- `founder_notify_retry_max`
- `founder_reply_retry_max`
- `founder_reply_deadletter_age_ms`
- `issue_display_sweep_ticks`
- `ship_gate_grace_ms`
- `merge_reconcile_window_days`
- `ship_gate_card_grace_ms`
- `reports_ttl_days`
- `ghost_guard_wait_ms`
- `done_thread_reconcile_interval_min`
- `done_thread_reconcile_max_per_run`
- `delivery_secret_path`

**问题**:删掉一个数值旋钮 = **把那个常量写死进代码**。这和 Annie 说的「把 disable 那条线删掉」不是同一个动作 —— **旋钮没有「另一条分支」可删,它只有一个值。**

**为什么这条决定成败**:**非布尔的正好 20 条,等于她给的整个目标预算。**

- 如果「<20」**包含**这些旋钮 ⇒ 布尔开关必须几乎清零,连 kill switch 都不能留
- 如果「<20」**只算 on/off 开关** ⇒ 旋钮按配置项另算,目标现实得多

**我不替她定这个。** 建议 HL 问一句:「那些超时/次数/路径这种数值配置,算不算在『不超过 20 个 flag』里?」

---

## 4. ③ 真要留的 —— 我的候选(严格按她给的两条口子)

她给的判据只有两条:**真正还在测的** / **本来就需要保留多种选择的**。

### 4.1 真正还在测的(删了等于把实验掐了)

| 开关 | 依据 |
|---|---|
| `skill_framework_mode` | 四臂实验正在跑(现值 split),FLY-1609 的 D 臂刚加 |
| `skill_framework_split_participation` | 上面那个实验的逐项目退出杠杆,成对存在 |
| `workflow_turn_divergence_alerts` | 注册表原文:默认关=影子模式,「先观察影子记录再决定开不开」。8-11 才加,观察期未满 |

### 4.2 本来就需要多种选择的

| 开关 | 依据 |
|---|---|
| `founder_consent_decision_mode` | 三段式 rollout 的模式枚举(off/audit_only/enforce),生产实际值 audit_only = 第 1 阶,第三档还没走 |
| `founder_ux_gate` | 逐项目枚举,六个项目可以不同 |
| `issue_gate_supersede_mode` | 枚举(enforce/observe/0),observe 是排障档 |
| `qa_auto` | 逐项目,**六个项目里只有 flywheel 开** —— 项目之间本来就该不同 |
| `doc_flow` | 逐项目,**3 开 3 关** —— 同上 |

### 4.3 她本轮亲口要留的

| 开关 | 她的原话 |
|---|---|
| `publish_broker` | 留着,以后要 enable |
| `xiaohongshu_learning` | 留着,值得专门排期 |
| `proofshot` | 「这个 enable,我们来开始用吧」⇒ **不是留着不动,是要开** —— 见下面注意事项 |

### 4.4 应急逃生口 / QA 缝(删了就没有 break-glass 了)

| 开关 | 依据 |
|---|---|
| `comm_bypass_bridge` | 应急绕过 founder-consent 直写 ship 门 |
| `lead_lease_bypass` | 应急绕过 Lead 身份租约 |
| `founder_attribution_gate` | =0 是 QA 房专用 |
| `voice_qa_presence_override` | QA-only seam,生产永不置位 |

**小计:15 条**(不含 §3 那 20 个旋钮)。

### ⚠️ `proofshot` 的注意事项(她说要开,但不能只开一半)

她说「这个 enable,我们来开始用吧」。但本轮体检查到:**所有 Lead 的 `lead_chrome_enabled` 都是 false**。
ProofShot 依赖浏览器链路 ⇒ **只开 proofshot 而不开 Lead 侧的 Chrome 能力,它跑不起来。**
⇒ 这是「她的指令要落地还缺一步」,执行前必须跟她说清楚,不能默默只开一半。

---

## 5. 历史裁决对齐(她点名要的考古)

| 来源 | 状态 | 能不能当权威 |
|---|---|---|
| **FLY-1136**(85 条 + 互动 HTML) | **PR #546 已 CLOSED,从没合进 main**;分支 flywheel-FLY-1136 @ dc62daac | ❌ **只能当考古**:它的裁决是「当时的建议」,不是「已生效的决定」 |
| **FLY-1413**(62 条补审) | 在主仓 product/doc/FLY-1413-flag-audit-increment/ | ✅ 已入库 |

### 5.1 ⭐ 最有价值的发现:她说得对,一个月前问的就是这个问题

FLY-1136 的桶就是按**今天这个问法**切的:

> bucketSuggest:**"1"=删空壳 · "2"=enable 后删 · "3"=留 · "4"=改 flag 系统**

**"2" = enable 后删,逐字就是 Annie 今天说的「一直 enable 且没问题 ⇒ 保持 enable,把 disable 那条线删掉」。**

⇒ 所以**问错问题的是本轮(FLY-1782),不是历史那轮。**
FLY-1136 一个月前问的就是对的问题;本轮我按「这个开关现在的状态对不对」去审,才得出「116 条留着不动」。**她推翻得有道理。**

### 5.2 历史裁决今天还剩多少

FLY-1136 有裁决的 52 条里,**今天仍在 registry 的只有 32 条**(其余随功能一起删了)。这 32 条当年的分布:**留 29 · enable 后删 1 · unknown 2**。

⚠️ **那 29 条「留」里,绝大多数正是 §3 说的数值旋钮和治理门。**
也就是说:**照搬 FLY-1136 的「留」名单,光这一份就 29 条,已经超过 Annie 今天给的 <20。**
⇒ 本轮必须比一个月前**更狠**,而狠的空间主要就在 §3 那个口径问题上。

---

---

## 7. FLY-1413 的历史裁决对齐(补完 §5)

FLY-1413 当年 62 条逐条裁决,**今天仍在 registry 的 39 条**,当年分布:
**动态化 17 · 留 21 · unknown 1**。

### 7.1 「动态化」那 17 条:这个桶今天**已经不存在了**

当年的第三个选项是「动态化」(改成免重启可切)。今天它**不是一个选项**了:

- 它的归属单 **FLY-1405 已于 2026-08-15 取消**,范围并进 FLY-1778;
- 更要紧的是:Annie 今天的问题是「**还需不需要作为开关存在**」——
  **动态化的前提是「它继续作为开关存在」**,所以对一条本该删掉的开关,动态化是个不成立的答案。

⇒ 这 17 条**必须按新问题重判**,不能沿用。它们今天全部落在 ①(删了零行为变化),
除了 `claude_account_identity_check` 和 `issue_gate_supersede_mode` 需要单独看。

### 7.2 ⚠️ 「留」那 21 条:当年的「留」是**用错的那个问题**判出来的,不能直接继承

这条很重要,因为它正是 HL 自认的那个错的历史版本:

> FLY-1413 的「留」= **「现在就已经是想要的样子」** —— 判的是**状态对不对**。
> Annie 今天要的「留」= **「真正还在测的 / 真正需要多种选择的」** —— 判的是**还需不需要存在**。

**两个「留」不是同一个词。** 所以那 21 条不能当既有结论搬过来,必须按新判据重判。

重判之后:**21 条老「留」里只有 4 条进得了我的 ③** ——
`skill_framework_mode` · `skill_framework_split_participation` · `lead_lease_bypass` · `voice_qa_presence_override`。
其余 17 条(含 `quota_daemon_wake` · `review_severity_policy_killswitch` ·
`ship_ready_notify` · `land_node` · `design_html_gate` · `ship_ci_guard` 等)
当年判「留」的理由都是「它现在这个状态是对的」,**而那正好不是这一轮的问题**。

⇒ 这就是「本轮必须比一个月前更狠」的具体数字:**老「留」21 → 新「留」4**。

---

## 8. 🔴 一处我要更正的数字(我之前给过 HL 两次,口径写窄了)

我之前报过:「**108 条在历史审计集合内,只有 16 条是从没审过的新增**」。
**这句话本身没错,但它的意思比读起来的小 —— 我没交代边界,容易被读成更大的断言。**

| 口径 | 数 | 它真正的意思 |
|---|---|---|
| 我之前说的「108 条」 | 108 | 今天的名字 ∈(FLY-1136 当时的 registry 全表 103 ∪ FLY-1413 增量 62)⇒ **「当时它已经存在」** |
| **本轮真正要用的** | **71** | **能捞回一条写下来的逐条裁决** |

差额 **37 条** = 当时确实在 registry 里,但那两份产出**没有逐条写它**
(FLY-1136 的 flags-data 只写了 52 条,不是全部 85/103 条)。

⇒ **对 HL 排活的影响是实的**:不是「108 条捞回 + 16 条新活」,而是
**71 条捞回重判 + 53 条完全新判**。新活的量是原估计的三倍多。

53 条捞不回裁决的完整名单在 `history-map.json` 里(值为 null 的那些)。

---

---

## 9. 下一步(等 HL 对齐后再做)

1. HL 把 §3 的口径问题问 Annie(旋钮算不算在 20 里)
2. 对齐 ③ 名单
3. ② 那 11 条逐条写「现在什么样 / 删了变成什么样 / 谁会感觉到」的人话稿
4. **最后才做整体 review 的 HTML** —— HL 明确要求:先对齐三堆,别又出九版
