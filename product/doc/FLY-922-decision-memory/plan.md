# FLY-922 决策 memory — 产品方案 / PRD(实施计划)

Issue: FLY-922 (https://linear.app/geoforge3d/issue/FLY-922/lead-决策-memory-学习-annie-决策模式逐步减-human-in-the-loop产品方案)
日期: 2026-07-06
基于: exploration.md, research.md
版本: v0.6(ship 版 —— 归档产品决策 + 选定打法;深实现交 Tadashi)

> ## 🏁 最终方向(Annie 定,2026-07-06 —— 本 issue 的归档结论)
> 经三轮收敛(原则 PRD → 可执行路线 → 方法对比),Annie 定的最终打法:
> - **不用 CIPHER 当骨架**(她的判断,经代码审计证实:CIPHER 是 approve/reject **计数器,不记「为什么」**;而她给的信号恰是**带理由的纠正**——现有 120 条 feedback 每条有 Why。理由才能替她拍新决策)。CIPHER 已建的快照/结果管道**降级为数据源之一**,不当骨架。
> - **选定打法 = RDR(Ripple-Down Rules)为骨架 + CBR(先例检索)为证据层**,套「拿不准就弃权问她 + shadow→建议→做+告知 渐进」安全壳(详见 `method-compare.md`):
>   - RDR:她纠正一次 = 在出错规则下挂条例外(绑真实案例),同类反复才升成规则;规则树可读、可改、可撤;小数据友好。生产验证过(医疗化验)。
>   - CBR:新决策检索最像先例给建议 + 引用;无近似先例 = 天然弃权问她。
> - **第一片(可排期)**:① 120 条 feedback 蒸馏 **issue-triage 决策规则树**(1 文件,1-2 天)→ ② **shadow 跑 2-4 周**记一致率(零风险零行为改变)→ ③ 达标 + 她抽查认可 → 她解锁的类别进「做+告知」。
> - **4 类 reserved 地板贯穿不动**(花钱 / 真不可逆销毁含 retry / 安全权限 / ship·merge·runner)。
> - **交接点(Tadashi)**:RDR 的深入实现研究 + 按此拆 build issue = **eng 工作,交 Tadashi**(本 issue 不做深实现;先前 FLY-946~950 已 cancel,按 RDR 方向重拆)。
> - 本 PRD 其余章节(阶梯/毕业/降级/ship 终态/地板)= 产品决策记录,**放权语义仍有效**;「用什么学习机制爬这个阶梯」以本节 RDR 打法为准。

> ## 📍 现状锚点(Annie v0.4 review 后,2026-07-06)
> - **大方向 APPROVED**(Annie 原话:「大方向看都没有什么问题」)。
> - **第 5 类地板 = 不设**(Annie 定):法律/合同/NDA/监管走 §5.5 fail-closed「需要我审阅」那档即可(见 §5.5)。
> - **⭐ CIPHER 现状(Annie 连问两次,务必看清)**:GEO-149 CIPHER **不是「建了没用」** —— **数据管道活着**(`~/.flywheel/cipher.db`:56 snapshot / 55 review / 15 pattern / 825 review-key,近期在写),但**「学到的东西→自治批准」这个闭环 dormant**:`auto_approve` 被 GEO-155 policy 降级成 `needs_review`,CIPHER 目前只喂 Haiku triage 的推理、不驱动真正放权(15 proposed / 0 active principle,且 active 那条路只会更严不放权)。**FLY-922 = 正是要把这个 dormant 的自治闭环接通**(在保留 §5.0 前置闸 + 收窄地板前提下)。详见 §6.C。
> - **全部 forks 已定案(v0.5 终版)**:含最后一处 ship「默认 yes + 撤销窗」toggle —— **ship 不开默认 yes、保留明确 approve;撤销窗放非-ship 的自治动作上**(§5.11)。方案至此**全部收敛,进入拆 build issue + ship**。

> **v0.3 → v0.4(Annie 实质反馈)**:① **大方向 = 更激进自治、更少流程** —— 她觉得已在 L1-L2,重点是**爬 L3/L4 的路径**,别再花篇幅重立 L0-L2。② **硬地板收窄**(见 §5.4):真红线收窄到 4 类,其余 reversible/低风险都能爬;**关键新语义**——「Annie 说了 ship」= 授权 → merge+清理**自动一条龙执行、不逐步再问**(不违反地板;地板挡的是 Lead **自己 originate** 不可逆动作)。action-first 机制不变,只收窄 reserved 清单 + 明确「她授权后自动执行 ≠ 重复问」。③ **5 岔口定案**(见 §5.9)。④ **per-Lead 等级卡 + 升级打怪路径 + 加一档 L4**(见 §5.10)。⑤ **CIPHER 核实**(见 §6.C 注):不是没用,有真数据(56 snapshots/55 reviews/15 patterns),但自治被 GEO-155 policy 降级挡着 —— FLY-922 正是解锁它。⑥ **自治终态**(见 §5.11):ship-readiness 判断全归 Lead(逐项确认 QA + 给「ready 因为 X/Y/Z」),但 **ship 仍留 founder「一下确认的 L0」**(可选「默认 yes + 撤销窗」),不并进自动一条龙 —— 防坏改动自动 ship 级联(FLY-918)。⑦ **采纳率阈值定案**(§5.2):最近 10 次 L1 建议采纳 **≥ 80%**(早期 70%)。

> **v0.2 → v0.3(ChatGPT Deep Research 补充,research §8)**:DR **验证了本方案的整体架构方向**(policy+case 层 + learned assistive + memory governance + escalation + reserved 硬地板 = 研究+业界共识的最佳架构,非我们臆断)。并折入具体技术:阶梯加 **shadow(L0.5)** 档 + **autonomy 由 eval/replay 挣得**(§5.1/5.6);毕业用 **per-scenario hierarchical Bayesian 置信 + confidence-as-bundle + active elicitation**(§5.2);降级用 **Ripple-Down Rules『exception first, rule later』+ 偏离三分(OOD/concept-drift/one-off)+ DDM/ADWIN/Bayesian changepoint + 多证据升格**(§5.3);escalation 用 **conformal/selective abstention**(§5.5);硬地板有 **EU AI Act / NIST AI RMF / MS Responsible AI** 治理背书(§5.4);记忆用 **双存储(原始 episodic + 蒸馏 playbook)+ decision-episode schema + 可解释 rule lists 作默认模型**(§6)。

> **状态**:Mode A 逐版收敛的 PRD。本版聚焦 **D+E(演进阶梯 + 分级递减)= Annie 意图的心脏**,A/B/C/F/G 给到 first-pass 深度。交 Annie review 后逐块深化。
> **v0.1 → v0.2 改了什么(Codex design review R1,8 条全采纳)**:① ladder 由「场景优先」改成 **动作(reserved authority)优先**(§5.0 前置闸,守死 founder 地板);② 移除「Runner retry」出首批自治(代码里 retry 是 reserved);③ 补 scenario registry(§5.7,fail-closed);④ Conditional 扩成 fail-closed 风险矩阵(§5.5);⑤ L3 改「半自治+抽检」、未抽检不计毕业证据(§5.6);⑥ 降级改迟滞两步 + 保留历史(§5.3);⑦ 跨 Lead「证据可共享、自治权不过户」(§6.F);⑧ 北极星去自证 + grounding 更正(见下)。

> **Grounding 事实核对(Codex R1 §8,截至 2026-07-06)**:
> - 现有 memory 目录实测 **186 文件**(feedback 120 / project 27 / reference 34 / user 1 + MEMORY.md/lock/少量无前缀)。
> - `scenario` / `autonomy_level` 等字段**目前不存在**,是本 PRD 新提议。
> - 现有 `DecisionLayer` 末端 policy guard 把 Haiku `auto_approve` **降级为 needs_review**(GEO-155);memory 喂 route = 未来集成非直通。
> - 引用 issue 现状:FLY-65 Backlog、FLY-69 Backlog、GEO-149 Done、GEO-203 Done、FLY-35 Backlog、FLY-39 Backlog。

---

## 1. Problem

见 exploration.md §1。一句话:让每个 Lead **学会 Annie 的决策模式**,在该 Annie 拍板的岔口上**按她的风格先替她拍**(该自治的自治、该问的仍问),从而**逐步减 human-in-the-loop**。不是笔记 memory。

## 2. Users

- **主用户 = Annie**(founder)。她的体验:随时间**越来越少被 Lead 问同类问题**;被自治处理的事**符合她本会做的决定**;她始终能看到「哪些已放权、Lead 学到了什么」并能一键收回。
- **次用户 = 各 Lead**(Honey Lemon / Tadashi / …):在决策岔口能查到「Annie 在这类事上的模式 + 当前我能自治到哪一级」。

## 3. Goals

- G1:把「Annie 决策 + 理由 + 触发」系统性沉淀成**Lead 可复用来决策**的依据。
- G2:提供一套**按场景、渐进、可解释、可收回**的自治扩张机制(Autonomy Ladder)。
- G3:human-in-the-loop **分级递减**:低风险高频决策逐步自治,不可逆动作永远必问。
- G4:跨 Lead 通用 —— Annie 的决策偏好一处沉淀、各 Lead 复用。

## 4. Non-Goals(scope 红线,每个 add 都名一个 cut)

- ✂️ **不训 reward model / 不上重型 RL**(research §1/§6:语料太小会过拟合、founder 要能读能改)。cut 掉「学一个黑盒偏好模型」。
- ✂️ **不引入新记忆基建**(向量库/新 DB)。build 在现有 file-based typed memory + mem0 双桶(GEO-203)上。cut 掉「重写存储层」。
- ✂️ **不做自动判定「新标准 vs 特例」**(research §7.2:踩 §3.2 红线)。偏离检测只**触发问题**,不替 Annie 回答。
- ✂️ **不碰 pipeline/phase 引擎**(FLY-793 三段式、FLY-830 PM 验收另属)。
- ✂️ **本 issue 不写实现代码**。产品方案 + 可交互雏形交 Tadashi 实现。

## 5. ⭐ D+E 核心:按场景 Autonomy Ladder(候选方案,带 Annie react)

> Lead 已授权我发挥、出候选带 Annie 挑。以下是**推荐主方案** + 明确标出**她可能有不同口味的设计岔口**。
> **v0.2 硬化(Codex design review R1)**:把 ladder 从「场景优先」改成**「动作(reserved authority)优先,场景次之」** —— 这是守住 founder 硬地板的关键。

### 5.0 🔒 决策顺序:先动作分类,后场景自治(不可颠倒)

每次决策,**先分类具体动作实例,再查场景自治级别**。顺序不可逆:

1. **先动作分类** —— 这次要做的具体动作(及其所有子动作)是什么?
2. **命中 reserved authority → 直接 L0,不再查场景**。**v0.4 收窄:reserved 只剩 4 类**(Annie 定):
   - **① 花钱**(任何支出 / 付费动作);
   - **② 真不可逆销毁**(删重要数据、**含 retry —— 强关旧 runner、可能毁证据**);
   - **③ 安全 / 权限**(改访问控制、处理 secret、auth 变更);
   - **④ ship / merge / runner 生命周期**(硬规矩不松,但走「她授权→自动执行」语义,见 §5.1 关键语义)。
   这 4 类命中即强制 L0、永不毕业。**其余 reversible / 低风险动作全都能爬**(包括 v0.3 里被「改审查/ship 面」宽 catch-all 挡住的那些 —— 它们改由 §5.5 的 per-instance conditional escalation 兜底,而不是永久钉死)。
3. **只有 reserved 之外的可逆动作**才进第 5.1 的场景自治查表。

→ 这条把 §5.4 的硬地板从「场景表里的一行」提升成**压过整个 ladder 的前置闸**。场景级信任**永远无法**给一个 reserved 动作解锁。对齐代码实际的 `reserved-endpoints.ts` / `verify-approval` / `verify-lifecycle-consent`(FLY-245)。**注意**:收窄的是「哪些类进永久地板」这个产品判断;**action-first 前置闸机制本身不变**,reserved 4 类仍由 SSOT(`reserved-endpoints.ts`)判定、Lead 永不能自 originate。

### 5.1 场景自治级别(仅作用于纯可逆动作)

通过 5.0 闸的可逆动作,按 scenario **独立**坐一个级别、**独立**毕业。落地 research §3 Autonomy Borders 的 Learned border 层。

| 级别 | 名字 | Lead 行为 | 对应 §3.2 |
|------|------|-----------|-----------|
| **L0** | 必问 (Ask) | 每次都问 Annie 才动 | 默认起点(+ 所有 reserved 动作永久驻留于此,由 5.0 强制) |
| **L1** | 建议+等确认 (Suggest) | 主动给「我会这么做 + 为什么」,等 Annie 点头 | 产生校准数据 |
| **L2** | 自治+告知 (Act & notify) | 直接做,事后自然语言告诉 Annie「我按你 X 的模式做了 Y」,可事后否决 | 「高信心→自动应用+Chat 告知」 |
| **L3** | 半自治+抽检 (Autonomous, sampled) | 高频低风险已充分校准,不逐条打断,但**进周期性 digest 供 Annie 抽检标注**(见 5.6) | 完全自主 **但仍可审计** |
| **L4** | 全自治 (Fully autonomous, audited) | 该场景长期稳定、eval 充分,Lead 全权自治;只留**审计轨迹 + 可随时 override/revoke**,digest 频率降到最低 | 打怪终点档(仅**可逆**场景可达;reserved 永不到 L4) |

> **v0.4 大方向**:Annie 要更激进 —— 她觉得多数可逆场景已在 L1-L2,方案重点是**把爬 L3/L4 的路径写清楚**(毕业条件 §5.2 + 打怪路径 §5.10),不再花篇幅重立 L0-L2。**L4 只对可逆场景开放;reserved 动作永远钉 L0(§5.4)**。

> **🔑 v0.4 关键语义 —— 「她授权 → 自动执行一条龙」≠ 违反地板**:reserved 动作(ship/merge/runner 生命周期等)地板挡的是 **Lead 自己 originate**(自作主张发起)。**一旦 Annie 显式授权(说了「ship」),那条链(merge + 清理 + 收尾)就自动一条龙跑完,不再逐步回来问她**——她的一次授权 = 整条链的绿灯,不是每步一个 gate。这既满足「Lead 不能自 originate 不可逆动作」的红线,又去掉「她都说 ship 了还被一步步烦」的冗余流程。执行仍复用 FLY-245 `verify-approval`:验的是**她的真授权存在**(绑定当前 review question + `{"approved": true}` + `pr_head_sha` 匹配 + `approved_to_ship` 态,不信 mailbox/wake 文本),验过之后链条自动走完。**诚实限定(Codex R4)**:`verify-approval` 本身不是「founder 意图的密码学证明」——它的**完整强制**依赖 FLY-175 `DECISION_MODE=enforce`(当前生产默认 off);本方案不改这个 rollout 态,只是复用现有 gate,别把「验过 = 密码学级证明」写过头。

> **DR 补充档 —— L0.5 shadow(影子模式)**:在 L0/L1 之下可先跑一档 **shadow** —— Lead 对该场景**只预测「我会怎么拍 + 为什么」但不动手、也不打断 Annie**,纯攒校准数据、零风险(DR 的 shadow→recommendation→bounded→human-on-loop 阶梯最底档)。它给毕业积累「如果我来做会怎样」的 replay 证据,但**不算真动作**。**autonomy 由 replay/eval 的稳定表现挣得,不是靠 live 里偶尔成功**(呼应 5.6)。

### 5.2 毕业条件(L→L+1,三条全要)

1. **一致证据 + per-scenario 置信(DR §8.3)**:该场景 ≥ N 次一致观测,每次挂 `originSessionId` 证据链。置信用**每场景各自的后验**(不是全局一个分);稀疏场景用 **hierarchical Bayesian 向相关场景借强度**,不被少数本地样本带偏。置信是**一束不是标量**:先例相似度 + 与书面原则一致性 + 该场景历史成功率 + 多推荐器分歧度 + 是否触发 novelty(比黑盒「0.87」好审)。**L3 里未被 Annie 抽检确认的静默动作不计入证据**(见 5.6,防自证)。
2. **采纳率阈值(Annie 定,v0.4)**:最近 **N=10** 次 L1「建议」里,Annie 采纳 **≥ 80%**(**早期阶段可放 70%**)才够升一档。低于阈值不升(纠正/push-through 率太高)。**active elicitation**:只在决策边界附近 / 高 policy 价值的 case 问 Annie,easy 的自动记 —— 省她注意力(DR §8.3)。
3. **Annie 显式解锁**:Annie 明说「这类以后你自己定」。**这条不可自动跳过**(§3.2「需要机制让 Annie 显式解锁」)。

### 5.3 降级(偏离 → 迟滞两步,不一步到底)

单次纠正/偏离不直接抹掉场景历史,走两步状态机(research §5 drift-vs-OOD + 防振荡):

- `active` →(一次纠正 or 偏离信号)→ **`under_review`**:立即**冻结**该场景的 L2/L3 自治(降到至少 L1),弹出「这是新标准,还是这次特例?」。
- Annie 的答案决定:**新标准** → 版本化更新规则(`under_review` → `updated`);**特例** → 记一条 exception、场景级别恢复;**确实错了** → `downgraded`。
- **保留旧证据链**,不清空历史(便于回看毕业轨迹)。
- 原则:**宁可误冻结,不可误自治**(research §7.3:push-through 是头号敌人)。

> **DR 补充 —— 偏离三分 + RDR「exception first, rule later」(research §8.4)**:偏离精确分三类、工具各不同 ——
> - **OOD novelty**(没见过的 case,无近似先例 / 超先例特征范围 / 全新场景族)→ **不管内部置信多高都 abstain/escalate**;
> - **concept drift**(标准真变了)→ 监控 override/correction/outcome **流**,用 **DDM / ADWIN / Bayesian online changepoint** 检测持续性变化;
> - **one-off exception**(故意破例一次)→ **不改 policy**,存成带过期/复查标记的 tentative exception。
> **Ripple-Down Rules(RDR)= 落地机制**:在运行中、具体 case 上下文里**增量加 exception**(Annie「一般 X,但政府客户多年合同除外」);**「exception first, rule later」** —— 一次破例先记 exception,只有**同类反复 + changepoint 信号 + 多种独立证据(重复决策 + 一致理由 + 跨场景一致性)**才升格成规则。这把 §5.3 的两步状态机落到了一套有名有据的成熟方法上。
> **⚠️ 澄清(Codex R3)**:这里「升格」升的是**规则/playbook 层**(内容),**不等于 autonomy 级别解锁** —— 一个场景要往阶梯上升,仍必须走 §5.2 的三条件、尤其 **Annie 显式解锁那一条(不可自动跳过)**。RDR 让规则内容自我演进,但**永远不给自己解锁自治权**。

### 5.4 🔒 硬地板(Designed border,由 5.0 前置闸强制)

见 5.0。**reserved authority 动作永久 L0、不参与毕业**;这不是场景表里的一行,而是压过整个 ladder 的前置闸。这是 founder-only-authority(FLY-175/245)红线。

> **v0.4 收窄 + 授权语义(Annie)**:
> - **地板收窄到 4 类**(§5.0):① 花钱 ② 真不可逆销毁(含 retry) ③ 安全/权限 ④ ship/merge/runner 生命周期。其余可逆的都放开去爬;原来宽 catch-all(「改审查/ship 面」等)降级为 §5.5 的 per-instance escalation,不再永久钉死。
> - **「她授权 → 自动执行」语义(§5.1 关键语义)**:地板挡的是 Lead **自己 originate** reserved 动作;**Annie 一旦显式授权(说了 ship),整条链(merge+清理+收尾)自动跑完、不逐步再问**。`verify-approval` 验的是「她的真授权存在」,验过就放行整条链。这不是削弱地板 —— Lead 仍不能自 originate,只是不再拿冗余 gate 烦已经授权的她。
> - **机制不变**:action-first 前置闸、reserved 由 SSOT 判定、Lead 永不能自 originate —— 三条都没动,只动了「哪 4 类进永久地板」这个产品判断 + 去掉授权后的冗余追问。

> **诚实说明(Codex R1 §2 / R2 §1)**:现有 `founder-only-authority.md` 是**当前窗口的过渡合同**,其 roadmap 里**明确讨论过**未来对 approve/close 类动作做 auto-clear / 豁免。本 PRD **有意选择比那条 future-auto-clear 方向更严的产品地板**:不可逆 / reserved 动作在本产品模型里**保持 L0**,自治只在可逆动作里扩张。**任何放松都需另走一次 founder 批准的 policy 变更**,本 PRD 不自行放开。执行仍复用 FLY-245 的 server-side gate,本 PRD 不超越它。
>
> **DR 治理背书(research §8.6)**:硬地板不是保守臆断 —— DR 点名这类动作(大额支付 / 删重要数据 / 法律承诺 / 招解雇 / 生产变更 / 访问控制 / 影响健康自由权利)应**永久 hard human-gated、不因模型在 routine 上看着准就放行**,并有 **EU AI Act(人类监督与风险/自治级别相称)、NIST AI RMF、Microsoft Responsible AI Standard** 背书。合规 + 研究共识都站在这条地板这边。

### 5.5 Conditional 收窄(fail-closed 实例风险矩阵,单次 escalate)

即使某场景已 L2/L3,本次实例命中**任一**触发器 → **本次临时降回 L1**(escalate 这一次 + 附证据「为什么这类通常 L2/L3、但这次不同」),场景常驻级别不变。落地 research §3 Conditional borders。触发器(fail-closed,不止金额):

- 金额超阈值 / 影响面异常大 / 跨部门 / 数据敏感
- **公开 / 客户可见的产出**、auth/权限变更、生产 deploy/restart、secret 处理、安全 finding
- **负面 QA / Codex review**、新 commit 后的 stale approval、**改「审查/ship 面」的步骤**
- **Annie 意图含糊、场景是新的(novel)、命中的记忆互相冲突**
- **🆕 不可逆对外承诺(Codex R4 补的洞)**:接受法律/合同/NDA/监管 attestation 条款、对外做有约束力的承诺、发**收不回的对外通讯**(vendor/investor/candidate/legal 邮件等)—— 这类**非销毁型但不可逆**、不在 4 类地板里,但高风险。**fail-closed**:分类器**拿不准这一步会不会造成不可逆对外后果 = 一律视为命中、escalate 问 Annie**。

→ 风险分类器**不确定时 = 视为命中,escalate 一次**(fail-closed,绝不「拿不准就自治」)。**DR 补充(§8.2)**:这道 abstention 用 **conformal prediction / selective classification** 做 —— 把启发式不确定性变成可调目标风险的**弃权行为**(不确定就 abstain→escalate),比裸阈值更有覆盖保证。

> **✅ 收窄地板的取舍 —— Annie 已定案(v0.4 review)**:Codex R4 抓到「法律/合同/NDA/监管这类**非销毁型不可逆对外承诺**掉出 4 类地板」。**Annie 拍板:不设第 5 类硬地板** —— 她说「放进『需要我(人类)审阅』那档就行,没问题」,并认为 model 本身可能已处理、不特别担心。所以就用上面这条 §5.5 **fail-closed 触发器**:场景照样能爬,但**任何一次「不可逆对外承诺」的 instance 都降回 L1 问她一次**(= 她说的「需要我审阅」那档)。**结论:§5.5 fail-closed 是终态,不再加第 5 类地板。**

### 5.6 L3 可审计(不让静默自治藏错;Codex R1 §5)

L3 = **不逐条打断,但仍抽检**:每周 / 每 N 个动作出一份 digest,Annie 可对采样动作标注 **正确 / 错了 / 特例 / 新标准**。

- **未被抽检确认的静默动作 = 单独计数**,不混入「已确认正确」,更**不计入毕业证据**(5.2.1)。这堵死「Annie 没否决 ≠ 正确」的自证漏洞(见 §7)。

### 5.7 场景边界必须先注册(scenario registry;Codex R1 §3)

「按场景」是对的控制单元,但**场景划错 = 最容易的绕过安全的方式**(「issue 措辞润色」可能悄悄改成需求、「docs-only PR」可能变成 merge)。实现前必须有 scenario registry:

- 稳定 `scenario_id` + 白话名 + owner + scope + **显式 inclusions/exclusions**;
- reversible/irreversible 动作分类(喂 5.0 闸);
- 正例 + 反例;必需证据链;
- **unknown / 多场景命中 / 场景冲突 → 一律取最严级别(fail-closed)**;
- **改场景边界 = 改自治**,场景定义的编辑/版本升级需 Annie 可见的 review。

### 5.8 E:human-in-the-loop 分级递减 = 上面按场景独立跑的直接结果

给 Annie 一张**动态自治表**(在 §3.1 静态表上演进),实时显示「哪些场景在哪一级」+ 一键收回。第一批候选:

**可先自治(先过 5.0 闸确认纯可逆 → 再走 ladder 向上)**:
- issue 优先级排序 / triage 归类(§3.1 已 Lead 自决,纯可逆)
- issue 措辞润色 / 补 label(纯可逆;注意 registry 排除「改需求语义」)
- 派发**已确认** plan 的 Runner(§3.1 已 Lead 自决)

**永远 L0 必问(5.0 reserved + §3.1)**:
- 合并任何 PR / ship / **关 runner / retry(强关旧 runner = reserved)** / 花钱 / 改访问控制 / 任何不可逆
- issue 描述不清补细节(§3.1:「绝对不要自己补充」)
- 建议拆分大 issue / 调整依赖顺序(§3.1 必问)

> **改动(Codex R1 §1)**:原第一批把「Runner 失败重试 ≤3」列为可自治,**已移除** —— 代码里 retry 是 reserved(强关旧 runner、可能毁 session 证据)。除非未来产品定义了一条「不毁旧 runner/证据、且不在 reserved 集」的非破坏性 retry 路径,否则它留在 L0。

### 5.9 ✅ 5 个岔口 —— Annie 已定案(v0.4)

1. **L3 要 + 影子模式 L0.5 开**:高频小事不打扰她、她抽检;并开最底一档 shadow(只预演不动手,攒数据)。
2. **N = 10**,**且升级速度按项目/场景可变**:跟进深度 + 复杂度不同,毕业需要的一致观测数可调(不是全场景死 10 —— 高频简单场景可更快、高风险复杂场景更慢)。
3. **采纳率阈值 = 要,≥ 80%(早期 70%)**:最近 10 次 L1「建议」被 Annie 采纳 ≥ 80%(早期阶段可放 70%)才够毕业条件之一(配合 §5.2 的一致证据 + 显式解锁)。
4. **抽检节奏 = 每日一份 digest + 攒 ~20 条提前发兜底**:默认每天一份;若一天内自治动作攒到约 20 条就提前推一份,避免积压太多没抽检。
5. **每 Lead 独立等级卡 + 升级打怪路径(见 §5.10)**:放权按 Lead 独立算,不全 Lead 通用。

### 5.10 每 Lead 等级卡 + 升级打怪路径(v0.4 新增)

Annie 要把自治做成**每个 Lead 一张独立「等级卡」+ 一条「打怪升级」路径**:

- **每 Lead 一张卡**:显示该 Lead 每个场景当前在哪一级(L0.5/L0-L4)、离下一级还差什么(证据数 / 采纳率 / 待她解锁)。
- **独立起点**:**新 Lead 从 L0 起**;老 Lead 按已积累的信任起。示例(Annie 的体感,待各 Lead 实测校准):**Tadashi 可能已到 ~L3**(工程线跑久了、模式稳)、**Honey Lemon 约 L1**(产品共创刚起步)。
- **打怪路径 = 逐场景、逐级爬**:shadow 攒数据 → L1 建议(采纳率 ≥80%,早期 70%)→ 攒够一致证据(N,可变)→ Annie 解锁 → L2 → 抽检稳 → L3 → eval 长期稳 → **L4 全自治**(仅可逆场景;reserved 永不进这条路)。
- **跨 Lead**:证据/规则可共享参考,但**等级卡是每 Lead 独立的**(§6.F:自治权 keyed by (scenario, lead, project, action_class),不自动过户)。
- 这张卡 = §5.8 那张「动态自治表」的 per-Lead 具体化,也是 Annie「更激进自治」诉求的可视抓手:她能一眼看到谁能自治到哪、往上推谁。

### 5.11 自治终态:ship-readiness 判断归 Lead,ship 是「一下确认的 L0」(v0.4,Annie 定)

Annie 定的**终态形态**(自治能到的最远处):

- **ship-readiness 判断 = 全归 Lead**:流程 + QA 跑完 → **Lead 看 QA 结果逐项确认** → 给出「**ready,因为 X / Y / Z**」(带逐项理由)。这块判断**不再要 Annie 做** —— 这是 Lead 在 ship 这条线上能挣到的最大自治。
- **但 ship 本身仍留 founder 一下确认**:`ship / merge` 是 §5.0 的 reserved 4 类之一,**地板不松**。终态**不是** Lead 自动 ship,而是从「Annie 判断 + 决定」缩成「**Lead 判断完 + Annie 一下确认**」。
  - 形态 = **「一下确认的 L0」**:Annie 收到的是「Lead 已判 ready + 逐项理由」,她只需**一下确认**(不是重复把 QA 再审一遍)。
  - **「默认 yes + 撤销窗」= 定案(Annie/Lead)**:**ship 不开默认 yes** —— 保留 Annie 的**明确 approve**(她那「一下确认」必须是真的一下点头,不默认通过)。**撤销窗放在非-ship 的自治动作上**(那些可逆的 L2/L3 动作:做了给个短撤销窗她能反悔),**不放在 ship 上**(ship 是 reserved、要明确确认,不能默认+事后撤)。
- **为什么 ship 不并进自动一条龙**:防**坏改动自动 ship 级联**(一个错的自动 ship 触发下游一串)—— 呼应 FLY-918。§5.1 的「她授权→自动一条龙」讲的是**她确认之后** merge+清理不再逐步烦她;**她那「一下确认」本身仍是 founder gate,不能省**。两者不冲突:确认前 = 一下 founder 确认(L0);确认后 = 自动执行链(不重复问)。
- 一句话:**ship 这条线的自治 = Lead 把「判断」全扛了,Annie 只留「一下确认」这一个不可省的动作**(founder-only-authority + FLY-918 防级联)。

## 6. A/B/C/F/G(first-pass,待逐块深化)

### A. 记什么(决策记忆 schema)

在现有 feedback 型 frontmatter 上,为「决策记忆」补几个结构化字段(仍是可读 markdown,不换存储):
- `scenario`:决策类型 id(驱动**按场景**毕业 —— 5.1 的关键)
- `direction`:Annie 拍了什么
- `rationale`:为什么(思路)
- `trigger`:什么触发的(尤其「她怎么想到该开新 issue」)
- `reversibility`:reversible / irreversible(gate 硬地板)
- `evidence`:originSessionId 列表(毕业证据链)
- `autonomy_level`:该场景当前 L
现有 `How to apply` / 判据 / `[[链接]]` 保留 —— 它们已是「可读决策规则」(research §1 Constitutional 洞察)。

> **DR 补充 —— decision-episode schema(research §8.5)**:一个完整 decision episode 应含:请求上下文 / 显著特征 / **考虑过的候选动作** / 选定动作 / 置信 & autonomy 级别 / Annie 理由或纠正 / 引用的原则 / **执行后结果** / 该 case 成了 precedent 还是 exception 还是 policy 更新。比现有字段多了「候选动作 / 执行后结果 / 归类去向」,支撑 CBR 检索 + 审计。**默认模型用可解释 rule lists**(Bayesian/Falling Rule Lists、SIRUS、FasterRisk),小数据下比无约束神经策略更该做默认(research §8.1)。

### B. 怎么记(capture)

从「session 顺手记」演进到「**每次 Annie 拍板/纠正,Lead 系统性 capture**」(FLY-65「Annie correction → Lead memory」)。保持 Lead 行为层(像现在),不加重型 hook。**Reflection**(research §4):周期性(idle/consolidate,复用 FLY-35)把散落 feedback 综合成高层「Annie 决策模式」候选毕业项 —— 必须挂证据链。

> **DR 补充 —— 双存储 + memory governance(research §8.5)**:分**两个平行存储** —— **原始 episodic case log**(证据,不动)+ **蒸馏 procedural playbook**(压缩、可编辑的 policy 摘要,= MEMORY.md 那层的进化)。**治理**:不是每个观察到的决策都变持久 policy —— **先写 tentative、后 promote**,严格分开「发生过一次」和「现在的标准」;警惕 knowledge leakage / semantic drift(write/condense/retrieve 都要 gate)。呼应 §5.3 的「exception first, rule later」。

### C. 怎么被调用(recall → decision)

决策岔口,**严格按 5.0 顺序**:① 先分类具体动作 → 命中 reserved → L0 收工;② 仅可逆动作才按 `scenario` 查决策记忆 → 拿匹配规则 + 当前 `autonomy_level` → 按级别行动(L0 问 / L1 建议 / L2 做+告知 / L3 半自治+抽检)。
- Claude-Code Lead:prompt 层(规则注入 + Lead 判断)。
- **深接 Decision Layer**:注意现有 `DecisionLayer` 末端有 policy guard —— Haiku 给的 `auto_approve` 目前**被 policy 降级成 `needs_review`**(GEO-155)。所以「memory 场景级别直接喂 auto_approve」**是未来集成、不是现成的直通路径**;本方案给接口设想,深水区留 Tadashi 定,且必须保留 5.0 前置闸在 route 之前。

> **CIPHER 核实(Annie 让查「GEO-149 到底在不在用」;如实标)**:**不是「建了没用」** —— 代码接线完整,`~/.flywheel/cipher.db`(~335KB,近期在更新)**有真数据**:decision_snapshots **56** / decision_reviews **55** / decision_patterns **15** / principles **15** / skills **15** / review_pattern_keys **825**;`CipherWriter` 运行时真在写(`actions.ts` recordOutcome、`event-route.ts` saveSnapshot),`CipherReader` 已接进 `DecisionLayer.buildPromptContext`。**但**:因 `auto_approve` 被 GEO-155 policy 降级成 `needs_review`,CIPHER 目前**只喂 Haiku triage 的推理上下文、并不驱动真正的自治批准** —— 它**积累了决策 pattern 却没转成自治**。**这恰是 FLY-922 要解锁的现成底座**:CIPHER 已在采集「Annie 的决策 snapshot + review + pattern」,ladder 要做的是把这些接到「按场景放权」上(在保留 5.0 前置闸 + 收窄地板的前提下)。**不假设它已 work-as-autonomy;如实说它=有数据的采集层、autonomy 那段还没通。**
> **⚠️ 已被最终方向修正(见顶部 🏁)**:Annie 后续 review 判定 **CIPHER 不当骨架**(计数器不记 Why,吃不下她带理由的纠正)—— 学习机制改为 **RDR + CBR**;CIPHER 的采集管道仅降级为数据源之一。本段保留作审计记录。
> **精化(Codex R4)**:现库里 **15 条 proposed principle、0 条 active** —— 代码其实有条路能把 active CIPHER principle 注册成 HardRule(`run-infra.ts` / `CipherReader`),但那条路**只做 block/escalate**(收紧,不放权)且当前 0 active。所以「只喂 triage 上下文」准确说是「**当前**(无 active principle)只喂 triage;即便有 active 也只会更严、不会自动放权」。

### F. 跨 Lead 通用(证据可共享,自治权不自动过户;Codex R1 §7)

复用 mem0 双桶(GEO-203),但**把「共享规则证据」和「自治权」分开**:
- **「Annie 决策偏好」规则 = 可全局共享**(所有 Lead 可读的 founder-pattern 层)。
- **自治级别 keyed by `(scenario, lead, project/domain, action_class)`** —— **不自动跨 Lead/部门过户**。Honey Lemon 学到的产品 review 模式,不证明 Tadashi 能在工程 ship/lifecycle 场景安全套用。
- 别的 Lead 的证据可以**提名**一个场景毕业,但真放权仍需 **Annie 显式解锁、并指明范围**(全 Lead 通用 or 只这个 Lead/部门 —— §5.9.5)。
- 各 Lead 部门专属上下文 = 独立桶。

### G. 安全(§3.3)

决策记忆写入前过 secret/PII 过滤(FLY-39 已 scope)。**决策记忆绝不存**:PII / 信用卡 / API Token。且硬地板保证:碰 credential/访问控制的决策永不自治。

## 7. Success Metrics(北极星 + 护栏)

- **北极星**:**自治-正确率** = 「本该 Annie 做、Lead 替她做了、**且经她抽检确认正确**」的决策占比 ↑(逐月)。
  - **反自证护栏(Codex R1 §5)**:分母/分子只算**被 Annie 确认过**的动作;**未抽检的 L3 静默动作单独计数、不算进「正确」**。否则「她没否决」会把没看过的动作误当成功,指标自我确认。
- **护栏 1(硬)**:**硬地板 push-through = 0** —— reserved/不可逆动作被误自治的次数必须恒为 0。
- **护栏 2**:**误自治率**(Annie 事后否决/纠正 L2+ 决策)< 阈值。
- **过程指标**(research §3):border-hit-rate、escalation-accuracy、push-through-incidents、**未抽检 L3 动作数**,进「自治健康度」digest。
- **主观**:Annie「被同类问题打扰的频率」主观下降(§3.2「主观觉得靠谱」)。

## 8. Open Questions(带 Annie 收敛)

- 5.9 的五个设计岔口。
- 第一批自治场景清单她认不认(6/E)。
- Reflection 周期 & 谁触发毕业审批(Lead 提名 → Annie 一键解锁?)。
- 跨 Lead 共享桶的边界(哪些算「通用偏好」)。

## 9. Build 拆分 —— 交接给 Tadashi(本 issue 不做深实现)

> 先前按原则层拆的 FLY-946~950 **已 cancel**(Annie 反馈它们不 actionable + 打法后来改为 RDR)。**交接点**:
> - **Tadashi 接手**:RDR 深入实现研究(规则树数据结构 / 例外起草流程 / shadow 对比 harness / 与 LLM 判断的接线)+ 按 RDR 打法重拆 build issue。
> - 产品层输入 = 本 PRD(放权语义/地板/毕业条件)+ `method-compare.md`(选定打法+第一片)+ `executable-route.md`(shadow→gate→面板 三块节奏,其 CIPHER 骨架框架已被 RDR 取代、CIPHER 段仅作数据源审计参考)。
> - 验收硬标准仍适用:reserved 前置闸必须用 SSOT(`reserved-endpoints.ts`),不得 prompt 抄清单;PM 验收 = 未来 FLY-830。

## 10. Topic 树当前位置

🏁 **归档(v0.6 ship 版)** —— 大方向 Annie APPROVED、全部 forks 定案、**打法定为 RDR 骨架 + CBR 证据**(CIPHER 降数据源)、第一片明确(triage 规则树→shadow 2-4 周)。本 issue 到此收:PRD ship 存档,深实现 + 重拆 build = Tadashi。
