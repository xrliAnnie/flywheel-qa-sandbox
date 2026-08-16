# FLY-1782 · 当前权威计数(每次裁决进来就重算这一页)

**更新于**: 2026-08-15 · **口径**: 已并入 HL 全部裁决 + 我的 `qa_auto` 查实结果

---

## 1. 三堆(主判据:当前生效值 vs 真默认值)

| 堆 | 数 | 变动来源 |
|---|---|---|
| ① 删了零行为变化 | **112** | 111 + `qa_auto`(registry 默认写反,实际六项目全开) |
| ② 删了会改变行为 | **10** | 11 − `qa_auto` |
| ? 机器判不了 | **2** | `lead_core_mention_gated` / `ponytail` |
| **合计** | **124** | ✅ |

## 2. 那 20 条非布尔的归宿(Annie 换了判据:**「这件事定下来了没有」**)

| 处置 | 数 | 说明 |
|---|---|---|
| 焊死(直接处理) | **14** | 全是 value 型且没人设过;且 toggle 是 readonly ⇒ 「留着能热调」这个好处**根本不存在** |
| **搬**(不是删) | **2** | `delivery_secret_path` · `lead_cross_dept_channel_ids` —— 配置数据,焊死反而更糟 |
| 真留成 flag | **2** | `founder_consent_decision_mode` · `skill_framework_mode` |
| 进 HTML 问她 | **2** | `issue_gate_supersede_mode` · `founder_ux_gate` |

⇒ **净效果 20 → 4**(2 留 + 2 问她)。

## 3. 「最终留几个」的当前账(会随剩下三个答案变动)

| 分类 | 数 | 明细 |
|---|---|---|
| **已定:留** | **7** | `skill_framework_split_participation` · `workflow_turn_divergence_alerts` · `publish_broker` · `xiaohongshu_learning` · `founder_attribution_gate` · `founder_consent_decision_mode` · `skill_framework_mode` |
| ~~等 Annie:第三判据~~ **已定:留** | **6** | 守 ship 路的急停开关 —— **Annie 答「留」**(2026-08-15,HL 转达)⇒ 第三判据成立,这 6 条进「留」 |
| 等 **Annie**:进 HTML 问 | **2** | `issue_gate_supersede_mode` · `founder_ux_gate` |
| 等 **Tadashi** | **2** | `lead_lease_bypass` · `voice_qa_presence_override` |
| 待定 | **1** | `doc_flow` —— 要么给出「为什么某项目永远不该开」,要么进 ② 按 enable-then-delete |
| **区间** | **7 ~ 12**(不含 break-glass) | 全不留 = 7;全留 = 12。**加 break-glass 6 ⇒ 13 ~ 18,两端都 < 20。** |

> 🔴 **一处对账更正(2026-08-15,HL 写页面时问的那个数)**
> HL 按文件算成「留 14 / 含 break-glass 20」,**不对**。差在他引用的 `①11` 是我**早期**的留用名单,
> 而 **HL 自己后来的裁决把其中 6 条移走了**:
> `comm_bypass_bridge`(裁「转删」)· `founder_ux_gate` + `issue_gate_supersede_mode`(移去「问她」)·
> `lead_lease_bypass` + `voice_qa_presence_override`(等 Tadashi)· `proofshot`(执行项,不是「留着不动」);
> `doc_flow` 他自己也判过待定。
> ⇒ 正确是 **已定 7 / 上限 12**,加 break-glass ⇒ **13 ~ 18**。
> ⚠️ **这个更正让结论更强、不是更弱**:20 是压线,**13~18 是有余量** ——
> 所以「留 break-glass 会不会超标」的答案是「**无论其余怎么定都不会**」。

**执行项(不是留)**:`proofshot` —— 她说「开」,由 HL 去问要不要连浏览器能力一起开。
**从留改为删**:`comm_bypass_bridge`(Tadashi 建议删,HL 倾向同意)· `qa_auto`(不是逐项目差异,六项目实际全开)。

## 4. 变动记录(谁改了什么)

| 改动 | 来源 |
|---|---|
| `qa_auto` ② → ①,且不算「需要多选」 | **我**查实 registry 默认写反(`resolveAutoQaPolicy` 是权威) |
| `founder_ux_gate` 从「留」→「问她」 | **我**查实它当前不生效(全舰 killswitch 未设,四处短路) |
| `founder_attribution_gate` 4.4 → 4.2,理由换成「每天在生效 + 生产开/测试房关 = 真多选」 | **HL** |
| `comm_bypass_bridge` 留 → 删 | **HL / Tadashi** |
| `ponytail` 「不知道」→「她说过不开(FLY-615)」 | **HL** |
| `founder_consent_decision_mode` 第 0 阶 → **第 1 阶** | **HL** 核 .env:150 |

---

## 4. Annie 的最终裁决(2026-08-15,全部收齐)

| 条目 | 她的裁决 | 影响 |
|---|---|---|
| 六条守 ship 路的急停开关 | **留** | 最终落在 **13~18**,始终 < 20 —— 有余量,不是压线 |
| 签字门开关(`founder_ux_gate_killswitch`) | **删** —— 原话「删掉就可以了」 | 固化成「门不在」;`founder_ux_gate` 枚举一并删(今天不生效) |
| 频道 id / 文件路径 | **可以**(同意「搬」) | 记「搬」不是「删」,不进 95% 分母 |
| `doc_flow` 三开三关 | **铺完然后删** | ⇒ 六个项目全部开启过程文档,然后删掉这个 flag。**它从「待定」变成「① 删 + 固化成开」** |
| `runner_autocontinue`(①b) | **仍然删** | 她知道这等于「决定不试了」,仍选删。规则丙已满足 |
| 其余未留回复的 | **视为同意我的选择** | 她的原话:「我所有没有留回复的,就代表我同意你的选择」 |

**⇒ FLY-1782 的裁决部分到此全部收齐,没有任何一条还在等她。**

剩余未落定的两条(不在她手上):
- `lead_lease_bypass` / `voice_qa_presence_override` —— 等 Tadashi 取证(⚠️ 审计账本损坏,只能给代码面证据,给不出「从没被用过」)
- `workflow_turn_divergence_alerts` 的观察期到期日 —— 等 Tadashi

她另外提出、已单独立单不占本单的:
- **FLY-1804** —— 全局 QA 门 / CI 证据门能否被 DAG 节点与 `:cool` 流程取代(她的架构论点,查实后成立)

*本节由 flywheel-product-lead 直接记入(runner 停在 82% 保上下文);数字仍以本页 §3 为准。*


---

## 6. 🔴 最终落点(2026-08-15,Annie 已答第三判据)

**Annie 对那 6 条守 ship 路的急停开关答「留」** ⇒ 第三条判据(「坏了之后还有没有退路」)**成立并被采纳**。

⇒ **最终留 = 13 ~ 18**(已定 7 + break-glass 6 = 13 打底;其余待答项若全留则 18)。
⇒ **两端都 < 20,目标达成。**

剩余仍在动的只有:`issue_gate_supersede_mode`(HL 已让它随第三判据同题走 ⇒ **随「留」一起留**)、
`lead_lease_bypass` / `voice_qa_presence_override`(等 Tadashi)、`doc_flow`(待定)。
