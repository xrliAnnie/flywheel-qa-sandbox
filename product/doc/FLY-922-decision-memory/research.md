# FLY-922 决策 memory — 调研(业界+学界 prior art)

Issue: FLY-922 (https://linear.app/geoforge3d/issue/FLY-922/lead-决策-memory-学习-annie-决策模式逐步减-human-in-the-loop产品方案)
日期: 2026-07-06
基于: exploration.md

> **来源说明**:§1-§7 为 **WebSearch 打底综合**;**§8 = ChatGPT Deep Research 补充**(Annie 亲手把 DR 结果 copy 出来发来,绕过掉线的浏览器扩展)。DR **验证了本方案的设计方向**(见 §8.0),并补入 Ripple-Down Rules、per-scenario Bayesian 置信、conformal abstention、shadow-mode 阶梯、可解释 rule lists、硬 gate 治理框架等具体技术 —— 已折进 plan v3。

---

## 0. 一句话结论

学界+业界已有成熟的四块拼图 —— **偏好/决策学习、渐进式自治(graduated autonomy)、Agent 记忆与反思(reflection)、偏离检测(drift vs OOD)**。对 Flywheel 最关键的洞察:**我们不需要重型 RL,应该走「可读决策规则 + 反思蒸馏 + 按场景毕业」的轻量路线**,因为(a)语料极小(约 120 条),重型 reward model 会过拟合;(b)Annie 要能**读懂并改**这些规则(founder-facing);(c)dogfood 已证明「可读规则」这条路 work。

## 1. 偏好 / 决策学习(如何从人的反馈学决策)

- **RLHF / DPO / Constitutional AI / RLAIF** 是主线。RLHF 训一个中间 reward model 再对齐;**DPO** 跳过 reward model 直接按偏好对调整;高质量偏好集下 DPO 能拿到 80-90% 效果、基建成本极低。
- **对 Flywheel 最有用的是 Constitutional AI 的洞察**:用**人可读的「原则」(principles)**作为偏好信号 —— 原则「易读、易解释、易懂」,可显式把规则写进信号里(纯人标注难做到)。
  → **直接映射**:我们每条 feedback memory 的 `How to apply` **就是一条「Annie 宪法原则」**,从她的纠正里蒸馏出来。这比训 reward model 更适合我们:Annie 能读、能改、能否决。
- **小数据过拟合风险(关键约束)**:约 120 条语料远不够训任何统计模型。学界共识 = 少样本下靠**可读原则 + few-shot**而非拟合。这为「不搞向量相似度玄学、就用可读规则 + Lead 判断」背书。

## 2. 渐进式自治(graduated / sliding / adjustable autonomy)

这是本方案 D+E 的直接学术地基。

- **Sliding / Adjustable autonomy**:自治级别**在执行中动态调**以适配情境;团队成员(人/agent)可主动决定何时把控制权交给别人。
- **随可靠性数据累积而毕业**:workflow 随可靠性数据积累从 human-in-the-loop → **human-on-the-loop** → 全自治;平台让团队**配置 AI-vs-人的决策阈值**并随信心增长调整。
- **不确定性触发求助**:半自治 agent 在**低信心**时求助(用「回报方差」估信心);太少求助→出错、太多求助→压垮人。**知道何时求助本身是核心难题**。
- **真实信任校准数据点**:Claude Code 老用户 auto-approve 超 40%,新用户约 20% —— **信任是可测量、随时间校准的**,不是开关。
- **From-in-the-loop-to-on-the-loop**:业界共识的自治演进方向,正是 Annie 说的「逐步减 human-in-the-loop」。

## 3. 自治边界框架(Autonomy Borders —— 本方案 ladder 的骨架)

来自 "AI Agent Autonomy Borders" / Digital Apprentice(Human-Directed Agentic AI）。**这是 prior art 里跟我们需求最贴合的结构**,直接拿来做 ladder 的三层骨架:

**三类边界(直接映射我们的三层)**:

| 边界类型 | 定义 | 映射到 Flywheel |
|----------|------|----------------|
| **Designed borders** | 部署时硬编码的治理规则,执行中**不变**(固定工具限制、审批要求) | = **founder-only-authority 硬地板**(merge/ship/不可逆,永不解锁) |
| **Conditional borders** | 按运行时情境激活:价值阈值、数据敏感度、异常模式 → **中途收窄自治** | = **按风险/场景闸**(可逆低风险才放,金额/敏感度/异常触发收回) |
| **Learned borders** | 靠反馈回路发展,产生**校准后的信心**(自我评估越来越准) | = **信心累积毕业**(一致观察 N 次 → 该场景升级) |

**边界响应模式**:Stop / **Escalate**(最常见,应优先)/ Push-through(失败模式,= miscalibration 信号)。
**可行设计模式**:① 优先 escalate 而非 stop(保进度 + 产校准数据);② conditional 触发要**显式、可审计**;③ escalation 做成一等能力(富上下文的 handoff 比边界检测更重要);④ 监控三指标:**border-hit-rate / escalation-accuracy / push-through-incidents**。

→ push-through(该问却自己拍了)= 我们最要防的**误自治**;它是可测量的失败信号,应进「自治健康度」看板。

## 4. Agent 记忆与反思(如何把记录变成可复用决策依据)

- **记忆类型学**:working / **episodic**(经历记录)/ semantic(通用知识)/ **procedural**(技能、流程)。
  → 我们的 feedback 型 = episodic(具体决策事件)+ procedural(`How to apply` 规则)混合。
- **Generative Agents(记忆流 + Reflection)**:观察写进 memory stream,按 **recency × importance × relevance** 检索;**Reflection = 周期性回顾近期重要记忆、自问要点、综合出更高层结论**,写回记忆流,越来越抽象。
  → **直接映射**:我们缺的正是这层 Reflection —— 把散落的 feedback 定期综合成「Annie 决策模式」的高层规则(候选毕业项)。`MEMORY.md` 的 consolidate 已有雏形。
- **Reflection grounding(防过拟合的关键)**:反思**必须引用具体 episodic 证据**(指向具体失败/决策实例),否则会「无根据地泛化」。
  → **直接映射**:任何「Annie 决策规则」候选必须挂 `originSessionId` 证据链(≥N 个一致实例)才能升级为自治依据。这也是小数据下的过拟合护栏。
- **MemGPT**:给 agent **自编辑记忆的工具**(add/modify/delete)+ 虚拟内存分页。
  → 我们已有等价物(Write/Edit memory 文件 + MEMORY.md 索引 + consolidate lock)。**不需要引入新记忆基建**,补的是 Reflection→毕业→接决策岔口的逻辑。

## 5. 偏离检测(§3.2「新标准还是特例」的学术基础)

Annie 的「偏离检测:新标准 vs 特例」在学界有精确对应:

- **Out-of-Distribution(OOD)detection**:判断**单个实例**是否显著偏离常态分布 → 对应**「特例 / 一次性」**(one-off outlier)。
- **Concept drift**:决策边界**随时间形变**、需要**重复观测**才确认 → 对应**「新标准」**(systematic change)。
- **RL 里的 novelty detection**:预测状态与实际状态偏离度 → 检测新颖性。

→ **产品含义**:Lead 观察到 Annie 一次反常 = 疑似 OOD(特例);**同类反常重复出现、方向一致** = 疑似 concept drift(新标准)。但两者都**不该自动判定** —— 学界方法只给「疑似」信号,**是新标准还是特例仍应主动问 Annie**(§3.2 原文即如此)。偏离检测的价值是**触发那个问题**,不是替 Annie 回答。

## 6. 对 Flywheel 的取舍(第一/二/三层知识)

- **Layer 1(照搬即可)**:Autonomy Borders 三层结构、Generative-Agents Reflection + grounding、drift-vs-OOD 区分、优先 escalate、监控 border-hit/escalation-accuracy/push-through。
- **Layer 2(验证后用)**:graduated autonomy 的阈值配置化;信心用「一致观测计数」而非概率模型(小数据下更稳)。
- **Layer 3(本问题第一性)**:**不训模型、用可读规则** —— 因为 founder 必须能读能改能否决,且语料太小。这是 Flywheel 相对通用方案的关键偏离:我们的「reward model」是一叠 Annie 能读的 markdown 决策规则,不是一个黑盒权重。dogfood 已证明这条路 work。

## 7. 反直觉结论(给设计的 3 条硬约束)

1. **别搞信心概率分数** —— 小数据下,「一致观测次数 + Annie 主观确认」比任何 0.0-1.0 置信度都靠谱且可解释。
2. **偏离检测只负责触发问题,不负责回答** —— 自动判「新标准 vs 特例」会踩 §3.2 红线;它的产出是一个该问 Annie 的 gate。
3. **push-through 是头号敌人** —— 「该问却自己拍了」比「过度求助」危险得多(尤其碰 founder 硬地板)。宁可 escalate 冗余,也不能误自治不可逆动作。

## 8. DR 补充(ChatGPT Deep Research —— 验证方向 + 补具体技术)

> 标题:「Learning a Principal's Decision Patterns for Safe Delegation to AI Agents」。带引用(RLHF/DPO、Constitutional AI/Sparrow、CIRL、adjustable autonomy、CBR/Reflexion/Voyager/MemGPT/RDR、Bayesian rule lists、drift/novelty、EU AI Act/NIST 等)。

### 8.0 核心结论 —— DR 验证了本方案的架构方向

DR 最强的一条:**不要让一个不透明模型悄悄「学老板」然后接管**。tens~low-hundreds 语料下,稳健设计是**混合控制栈**:
- **principal-facing 层** = 可读 constitution + 可编辑 rule list + exception policy(不是黑盒权重);
- **agent 层** = 提议/排序/检索先例/起草理由/**不确定就 abstain**;
- **memory 层** = 存原始 episode + 蒸馏 policy summary,带 write/read governance;
- **escalation 层** = 用 calibrated abstention + novelty detection + policy conflict 决定动手 vs 升级;
- **governance 层** = 不可逆/高风险动作**硬 human gate**、审计、随时 override/revoke。

→ **这正是 plan.md 已经收敛的形状**(可读规则 not 黑盒 + 按场景 ladder + 接决策岔口 + reserved 硬地板 + 偏离触发问题)。DR 把它从「我们的判断」升级成「研究+业界共识的最佳架构」。以下把 DR 的**具体技术**折进(已进 plan v3)。

### 8.1 可读规则骨架(强化 research §1)
- **Constitutional AI / Sparrow** = 把规范外化成**文本原则**(可发布、可审、可改)—— 印证「feedback memory 的 How-to-apply = Annie 宪法原则」。
- **可解释 rule-learning**:Bayesian Rule Lists / Falling Rule Lists / SIRUS / FasterRisk —— 小数据下比无约束神经策略**更该做默认模型**(短 if-then + 后验不确定性,可编辑)。
- **语言反馈学习**:Annie 的自然语言纠正(「下次客户威胁 churn 就升级」)信息量 > 单纯 yes/no 偏好标签,应作一等训练数据。DPO/偏好学习**只用于窄子技能**(排序选项/措辞理由),不定义治理边界。

### 8.2 阶梯多一档「shadow」+ 学术命名(强化 §5 ladder)
DR 给的渐进式授权阶梯:**shadow(只预测不动手)→ recommendation(每个动作都批)→ bounded delegation(窄白名单内自动)→ human-on-the-loop(routine 自动、其余中断+审计)**。
→ 对应我们的 L0-L3,并提示可在 L1 之下加一档 **shadow(L0.5)**:Lead 先「影子」预测「我会怎么拍 + 为什么」但不动手,纯攒校准数据、零风险。**autonomy 应由 replay/eval 稳定表现挣得,不是靠 live 里偶尔成功**(印证 §5.6:未抽检 L3 不计毕业)。

### 8.3 per-scenario Bayesian 置信 + confidence-as-bundle(强化 §5.2)
- 用**每场景各自的后验置信**(不是全局一个分)—— 折扣审批攒了很多先例、法务例外几乎没有,置信度应各算;**hierarchical Bayesian** 让稀疏场景向相关场景**借强度**,不被少数本地样本带偏。这比「一致观测计数」更精确,仍可解释。
- **置信是一束、不是标量**:先例相似度 + 与书面原则一致性 + 该场景历史成功率 + 多个推荐器的分歧度 + 是否触发 novelty。比黑盒「0.87」好审得多。
- **active elicitation**:只在决策边界附近 / 高 policy 价值的 case 问 Annie,easy 的自动记 —— 省她注意力。

### 8.4 偏离检测三分 + RDR「exception first, rule later」(强化 §5.3)
DR 把偏离精确分三类,工具各不同:
- **OOD novelty**(没见过的 case)→ 绑到 case base / policy coverage:无近似先例 / 超出先例特征范围 / 全新场景族 → **不管内部置信多高都 abstain/escalate**(conformal/selective classification 做 abstention 包装)。
- **concept drift**(标准变了)→ 监控的是 override/correction/accepted/outcome **流**;DDM / ADWIN / **Bayesian online changepoint** 检测持续性 regime 变化。
- **one-off exception**(故意破例一次)→ **不立刻改 policy**:存成**带过期/复查标记的 tentative exception**,规则不动。
- **Ripple-Down Rules(RDR)= 最贴切的机制**:专家在系统**运行中**、在具体 case 上下文里**增量加 exception 规则**(知识获取变知识维护)—— 精确对应 Annie「一般 X,但政府客户多年合同除外」。**「exception first, rule later」**:一次破例先记 exception;只有同类反复出现 + changepoint 信号才**升格成规则**。
- **升格需多种独立证据**:重复的同类决策 + 一致的自然语言理由 + **跨场景一致性**(同逻辑出现在定价/招聘/客服例外 → 更可能是变了的原则而非情境迁就)。

### 8.5 memory:双存储 + decision-episode schema + governance(强化 §6.A/B)
- **两个平行存储**:**原始 episodic case log**(证据)+ **蒸馏 procedural playbook**(压缩、可编辑的 policy 摘要)。
- **decision episode 单元** 应含:请求上下文 / 显著特征 / 考虑过的候选动作 / 选定动作 / 置信 & autonomy 级别 / Annie 理由或纠正 / 引用的原则 / 执行后结果 / 该 case 成了 precedent 还是 exception 还是 policy 更新。→ 直接精化 §6.A 的 schema。
- **CBR(case-based reasoning)** 特别贴合 founder 决策的类比性(「这像三月批的 Acme 续约,但这家有法务风险」),且可解释(能说匹配了哪些 case、差在哪、为何升级)。
- **memory governance**:不是每个观察到的决策都该变持久 policy —— **先写 tentative、后 promote**,分开「发生过一次」和「现在的标准」。警惕 knowledge leakage / semantic drift(需 write/condense/retrieve 治理)。

### 8.6 硬 gate 有外部治理背书(强化 §5.4 硬地板)
DR 明确:某些动作应**永久 hard human-gated** —— 大额支付、删重要数据、法律承诺、招/解雇、生产变更、访问控制变更、影响健康/自由/权利的动作。**不因模型在 routine 上看着准就放行**。背书:**Microsoft Responsible AI Standard**(要求支持知情的人类监督)、**EU AI Act**(人类监督与风险/自治级别相称)、**NIST AI RMF**(治理 AI 风险)。→ 我们的 action-first reserved 硬地板不是保守臆断,是**合规与研究共识**。

### 8.7 折进 plan v3 的清单
Ripple-Down Rules『exception first, rule later』(§5.3)· per-scenario hierarchical Bayesian 置信 + confidence-as-bundle(§5.2)· conformal/selective abstention 做 escalation(§5.5)· 阶梯加 shadow 档 + autonomy 由 eval 挣得(§5.1/5.6)· 可解释 rule lists 作默认模型(§6.A)· 双存储 + decision-episode schema(§6.A/B)· 硬 gate 的 EU AI Act/NIST/MS-RAI 背书(§5.4)· active elicitation 省 founder 注意力(§5.2)。

## Sources

- [Decision Making for Human-in-the-loop Robotic Agents via Uncertainty-Aware RL (arXiv 2303.06710)](https://arxiv.org/abs/2303.06710)
- [Human-in-the-Loop AI: A Systematic Review (MDPI Entropy 28/4/377)](https://www.mdpi.com/1099-4300/28/4/377)
- [The Digital Apprentice: A Framework for Human-Directed Agentic AI Development (arXiv 2606.04321)](https://arxiv.org/pdf/2606.04321)
- [From Human-in-the-Loop to Human-on-the-Loop: Evolving AI Agent Autonomy](https://bytebridge.medium.com/from-human-in-the-loop-to-human-on-the-loop-evolving-ai-agent-autonomy-c0ae62c3bf91)
- [AI Agent Autonomy Borders: When to Escalate to Humans (Agentic Academy)](https://agentic-academy.ai/posts/autonomy-borders/)
- [Sliding Autonomy for Peer-To-Peer Human-Robot Teams (CMU)](https://www.cs.cmu.edu/~mmv/papers/08TR-teams.pdf)
- [A Dynamic Measurement of Agent Autonomy in the Layered Adjustable Autonomy Model (Springer)](https://link.springer.com/content/pdf/10.1007/978-3-319-01787-7_3.pdf)
- [Generative Agents: Memory Stream & Reflection (MemX glossary)](https://memx.app/glossary/generative-agents/)
- [Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers (arXiv 2603.07670)](https://arxiv.org/html/2603.07670v1)
- [Agent Memory Techniques (NirDiamant, GitHub)](https://github.com/NirDiamant/Agent_Memory_Techniques)
- [Concept Drift Detection based on decision distribution (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0950705123006846)
- [Novelty Detection in Reinforcement Learning with World Models (arXiv 2310.08731)](https://arxiv.org/html/2310.08731)
- [RLHF vs Constitutional AI: Key Differences (Learn Prompting)](https://learn-prompting.fr/en/blog/rlhf-constitutional-ai-guide)
- [Beyond Traditional RLHF: DPO, Constitutional AI (Medium)](https://medium.com/foundation-models-deep-dive/beyond-traditional-rlhf-exploring-dpo-constitutional-ai-and-the-future-of-llm-alignment-bc30089644c9)

### §8 DR 补充引用(ChatGPT Deep Research,Annie 亲手导出;原文含 inline citeturn 标记)
- DR 原文存档:`/tmp/fly922-dr-result.txt`(「Learning a Principal's Decision Patterns for Safe Delegation to AI Agents」)。以下为 DR 点名的关键框架/论文(按名索引,inline citeturn token 未解析为 URL):
- Constitutional AI (Anthropic);Sparrow rule-based reward modeling (DeepMind)
- DPO (Direct Preference Optimization);InstructGPT / RLHF
- CIRL (Cooperative Inverse Reinforcement Learning);Few-Shot Preference Learning for HITL RL
- Training Language Models with Language Feedback(语言反馈学习)
- Ripple-Down Rules (RDR);Bayesian Rule Lists;Falling Rule Lists;SIRUS;FasterRisk;Interpretable Decision Sets
- Interpretable Confidence Measures (CBR-based);Bayesian Case Model;hierarchical Bayesian updating
- Selective classification / abstention;Conformal Prediction
- DDM;ADWIN;Bayesian Online Changepoint Detection
- Generative Agents;Reflexion;Voyager;MemGPT(记忆/反思)
- Transfer-of-control strategies (Scerri et al.);Parasuraman-Sheridan-Wickens automation levels
- 治理:Microsoft Responsible AI Standard;EU AI Act(人类监督);NIST AI RMF
- 平台:OpenAI Agents SDK approvals/resumable state;LangGraph interrupts/persistence;Microsoft Copilot Studio AI approvals;Google Vertex AI Agent Builder HITL;Salesforce agentic memory (confidence scoring + read/write gates)
