# FLY-922 决策 memory — 可执行路线(不是原则,是「下一步具体做什么」)

Issue: FLY-922 (https://linear.app/geoforge3d/issue/FLY-922)
日期: 2026-07-06
基于: plan.md v0.5(原则层)+ 本轮深审 CIPHER 代码 + 业界具体实现调研
状态: v1(部分被取代)—— 回应 Annie「v0.5 不 actionable」的反馈,把原则落成一条能动手的路线

> **⚠️ 最终方向已调整(Annie 定,见 plan.md 顶部 🏁 + method-compare.md)**:本文档「以 CIPHER 为骨架接通」的框架**被 RDR + CBR 打法取代**(CIPHER 是计数器不记 Why,降级为数据源之一)。**仍有效的部分**:§1 CIPHER 代码审计(事实记录)、§2 业界具体系统、§3 的 **shadow → gate+unlock → 面板/digest 三块节奏**(套在 RDR 上同样适用)。交接 Tadashi 时以 method-compare 的打法 + 本文的节奏为输入。

---

## 0. 为什么重写:Annie 的反馈

v0.5 是**一堆对的原则**(自治阶梯 / 分级 / 破例先记 / per-scenario 置信 …),但**没落成一条能动手的路线** —— 看完不知道「下一步具体建什么」。本文档修这个:**先建哪块 → 用什么现成代码/技术 → 什么顺序 → 每步产出啥 → 怎么验证**。

## 1. 最大的发现:引擎已经建好了(CIPHER),我们一直以为要从零做

深读 `packages/edge-worker/src/cipher/` 后确认 —— **FLY-922 原则里最难的那套「决策记忆 + per-scenario 置信 + 成熟度阶梯」,CIPHER 已经实现了、且在生产里有真数据**。不是要新建,是要**接通**。

CIPHER 现在**已经有**的(代码级事实):

| 原则(v0.5 说要做的) | CIPHER 里已有的实现 |
|---|---|
| 「按场景」 | `extractDimensions()` → `generatePatternKeys()` —— 从一次决策抽维度、生成**层级 pattern-key**(= scenario),带 fallback 借强度(`getFallbackOrder`) |
| 「per-scenario Bayesian 置信」 | `posteriorMean()` = Beta-Binomial 贝叶斯平滑(带 `prior_strength` prior)+ `wilsonLowerBound()` = 90% Wilson 下界(小样本保守,正是防过拟合) |
| 「毕业阶梯 / N 次」 | `maturityLevel()`:exploratory(<10)→ tentative(<20)→ established(<50)→ trusted(≥50)—— **就是按样本数的毕业档** |
| 「决策 + 结果记录」 | `decision_snapshots`(56)+ `decision_reviews`(55)+ `decision_patterns`(15)+ `CipherWriter.recordOutcome/saveSnapshot` 运行时在写 |
| 「三分结果」 | `classifyOutcome()`:fast_approve(≤300s)/ approve_after_review / reject_or_block |
| 「可读规则」 | `cipher_principles`(15 proposed / 0 active);active 会注册成 HardRule(`loadActivePrinciples`) |

**CIPHER 缺的、也就是 FLY-922 真正要建的那一小段**:

1. **它只「建议」不「driver」**:`buildPromptContext()` 产出的是一段 **prompt 文本**,喂给 Haiku triage 当参考 —— 不直接决定 route。
2. **它唯一影响的那个决策(PR auto_approve)本身是地板动作**:`DecisionLayer` 末端有条 policy guard 把**所有** `auto_approve` 强降 `needs_review`(GEO-155)。而 PR 合并批准 = ship/merge = FLY-922 收窄 4 类地板里的 reserved,**本就该 founder-gated** —— 所以这条降级是对的,不该动它。
3. **结论**:CIPHER 目前把整套置信/成熟度机器用在了一个**永远该问 founder 的地板动作**上 → 看起来「学了一堆没用」。**真正的解锁 = 把这套已验证的机器,从「PR 批准(地板)」扩到「可逆决策类型」上,并把高置信的那些接到真自治执行。**

## 2. 业界怎么落地的(具体系统 + 具体机制,直接映射 CIPHER)

### 2.0 三个「同形状的已 ship 系统」(Annie 要的具体方案,不是模式名)

**① 欺诈/风控 decisioning 平台(Sift / SEON / Oscilar 等)—— 和我们形状最像的成熟品类**。它们的标准架构就四段,每段都有明确机制:
1. **接入+富化**:每笔交易实时拉齐身份/行为/交易/第三方信号(= 我们的 `extractDimensions`);
2. **风险评分**:规则加权 + ML 给 0-100 分(= 我们的 wilsonLower 置信);
3. **三档阈值决策执行**:低分**自动批** / 中间分**进人工审核队列**(analyst 逐条看)/ 高分**自动拒**;阈值可配、按品类各调(= 我们的 L2 自动+告知 / L1 建议排队等 Annie / L0);
4. **反馈回灌**:每个 Approve/Review/Decline 的**结果**流回模型持续重训,监控指标掉了自动触发更新(= CIPHER `recordOutcome` 已在做的事)。
→ **拿来主义结论**:银行界用这套架构每天自动放行了绝大多数交易、只把中间地带交给人 —— 我们要做的是同一台机器,只是「交易」换成「Lead 的小决策」、「analyst 队列」换成「问 Annie」。

**② Claude Code 自己的权限系统 —— 我们天天在用的、同形状的已 ship 实现**:per(工具+命令 pattern)的 allowlist;每次问「允许一次 / 总是允许」——用户点几次「总是允许」= **对这个 pattern 显式解锁**,之后同类不再问;`/learn-permissions` 会**扫使用日志、把反复人工批准的 pattern 聚合成建议规则**让用户一键采纳;规则随时可删(收回)。→ 这就是「按场景解锁 + 从历史批准里蒸馏规则 + 可撤销」的完整闭环,已在生产、我们自己每天在体验。

**③ AI code review 工具的对照组**:GitHub Copilot code review 收 accept/dismiss + 👍👎 信号但**还不做 per-team 学习**;竞品 **CodeRabbit 做了「learnable preferences」**——从团队的反馈里学偏好、review 越用越贴团队口味。→ 说明「agent 从 principal 反馈学偏好」已是市场上真实出货的能力,不是研究概念。

### 2.1 模式层映射(和 CIPHER 现成原语一一对应)

| 业界具体做法 | 映射到我们 |
|---|---|
| **confidence-threshold auto-execute**:conf ≥ 阈值 → 自动执行;否则 → 人审(典型分档 ≥0.90 auto / 0.75-0.90 review / <0.75 reject) | CIPHER 的 `wilsonLower` + Annie 定的 **≥0.80** 阈值,直接就是这个 gate |
| **change-approval 分档**(真实工单系统):>0.75 auto / 0.5-0.75 auto+notify / 0.25-0.5 manual / <0.25 reject | = CIPHER `classifyOutcome` 的 fast/review/reject 三分 + 我们的 L2(做+告知)/L1(建议)/L0(问) |
| **三种 approval 模式**:pre-execution approval / post-execution review / **escalation triggers**(平时自动、遇 sensitive/irreversible/low-conf 才停) | escalation triggers = 我们的 §5.0 reserved 前置闸 + §5.5 conditional |
| **graduated autonomy**(实测:新用户 20% auto → 750+ session 40% auto) | = maturity 阶梯随样本累积升档 |
| **Wilson score 排序**(小票数不过度排名) | = CIPHER 用 `wilsonLower` 而非裸 rate,小样本保守 |
| Salesforce「Agent Coding Maturity Curve」9 阶 | = 我们的 shadow→L0→…→L4,业界已有成熟先例 |

→ **不用发明**:我们要做的正是业界验证过的 confidence-tier + escalation-trigger 自动化,而且**大半原语 CIPHER 已经有了**。

## 3. 可执行路线(分块,每块:做什么 / 用什么 / 产出 / 验证 / 给 Tadashi 的 eng 点)

> 顺序原则:先接通「一个可逆决策 + 一条真自治」跑通闭环(证明这套能 work、Annie 能看到真效果),再逐块加宽。**每块都是能独立 ship 的小增量**,不是一次性大工程。

### Block 1 —— 接通一个可逆决策的「shadow」闭环(先不放权,先证明它学得像)
- **做什么**:选**一个**高频可逆决策类型(建议:**issue triage 的优先级/label 归类**——纯可逆、CIPHER 维度好抽)。让 Lead 每次做这个决策时,把它当 CIPHER pattern 记一笔(dimension → pattern-key → Lead 的选择 vs Annie 事后是否改)。**先只跑 shadow**:Lead 照旧做,系统在背后记「如果按 CIPHER 学到的会怎么归类」+ 算 wilsonLower/maturity,但**不改变任何行为**。
- **用什么(现成)**:`extractDimensions`/`generatePatternKeys`/`CipherWriter` 已有;扩 `SnapshotInputDto` 支持这个决策类型的维度。
- **产出**:一张「这个决策类型的 CIPHER 学习曲线」——每个 pattern-key 的 approve/total、wilsonLower、maturity。Annie/Lead 能看到「它学到 X% 准了」。
- **验证**:拿历史 triage 决策 replay,对比 CIPHER 预测 vs 实际;看 wilsonLower 随样本上升;**0 行为改变**(纯 shadow,零风险)。
- **给 Tadashi 的 eng 点**:`SnapshotInputDto` 扩维度 + 一个非-PR 决策类型的 record 路径;不碰 DecisionLayer 的 PR route。

### Block 2 —— 加「置信-tier gate + founder unlock」,让那**一个**决策真自治(可逆才放)
- **做什么**:给 Block 1 那个决策类型加一道 gate(业界 confidence-tier 模式):**若 action-first 判定可逆(非 reserved 4 类)且 CIPHER maturity ≥ trusted 且 wilsonLower ≥ 0.80 且 Annie 显式 unlock 了这个 pattern → 自动执行 + 告知(L2)**;0.80 以下 or 未 unlock → 建议等确认(L1)。
- **用什么(现成)**:CIPHER `wilsonLower`/`maturityLevel` 直接用;新增一张极小的 `pattern_unlock`(pattern-key → founder unlocked bool + scope)。**复用 §5.0 reserved 前置闸**(reserved-endpoints SSOT)——这个决策类型若碰 reserved 直接 L0,gate 根本不触发。
- **产出**:那**一个**决策类型,对「已成熟 + 高置信 + Annie 解锁」的 pattern **真的自治执行了**,Annie 少被问这类。她能一键 revoke。
- **验证**:真机放一个 unlock 的 pattern,观察它自治执行 + 进 digest;注入一个 reserved-触碰 case 确认被前置闸挡回 L0;Annie revoke 后立即回 L1。
- **给 Tadashi 的 eng 点**:`pattern_unlock` 表 + gate 函数(在那个决策类型的执行点,不在 PR route);**必须**在 gate 前跑 reserved-SSOT 检查。

### Block 3 —— founder 面板:等级卡 + 一键 unlock/revoke + 每日 digest
- **做什么**:把 CIPHER 每个 pattern 的 maturity/wilsonLower + unlock 状态做成 Annie 能看的**等级卡**(per-Lead);她在这里 unlock/revoke;L2 自治动作进**每日 digest**(§5.6:她标 对/错/特例)。标错 → 那个 pattern 冻结回 L1(复用 CIPHER 的 reject 计数,wilsonLower 自然掉)。
- **用什么(现成)**:CIPHER 统计 + 现有 HTML 报告交付(publish-report);digest 复用现有通知。
- **产出**:Annie 有一个「谁能自治到哪 + 一键收放」的真界面 + 每天一份可抽检的自治动作单。
- **验证**:Annie 在面板 unlock 一个 pattern → Block 2 那个决策对它自治;她在 digest 标一个「错」→ 该 pattern 掉回 L1。
- **给 Tadashi 的 eng 点**:读 cipher.db 的只读面板路由 + `pattern_unlock` 写;digest 生成 job。

### Block 4+ —— 逐个加宽可逆决策类型 + 偏离检测细化
- 用 Block 1-3 同一套模式(record→shadow→gate→unlock→digest),**一次加一个可逆决策类型**;每加一个都独立可 ship、可验证。
- 偏离检测(concept-drift vs one-off)先用 CIPHER 现成的 reject 计数 + maturity 掉档兜底,DDM/changepoint 等更细的留后续。

### 永远不进这条路(硬边界,贯穿所有 Block)
- reserved 4 类(花钱 / 真不可逆销毁含 retry / 安全权限 / **ship·merge·runner 生命周期**)—— action-first 前置闸挡在每个 gate 之前,永远 L0/founder-gated。PR auto_approve 保持 GEO-155 降级不动。

## 4. 一句话路线

**CIPHER 已经把「学 Annie 决策 + 算 per-scenario 置信 + 分成熟度」这台机器造好了,只是空转在一个该问 founder 的地板动作上。FLY-922 = 挑一个可逆的高频小决策,用业界验证过的 confidence-tier gate 把这台机器接到真执行上(Block 1 shadow → Block 2 gate+unlock → Block 3 面板/digest),跑通一个闭环,再一个一个加宽。** 每一步都能独立 ship、能验证、Annie 能看到真效果。

## 5. 给 Tadashi 的纯 eng 清单(实现细节,产品层不替他定)
- `SnapshotInputDto` / `extractDimensions` 扩到非-PR 决策类型的维度抽取。
- 非-PR 决策类型的 record 路径(不复用 PR 的 event-route saveSnapshot,还是新开,待定)。
- `pattern_unlock` 表 schema + 与 `verify-*` / founder-consent 的关系(unlock 是不是也走 founder gate?建议是)。
- gate 函数插桩点:在那个决策类型的执行处,reserved-SSOT 检查在前。
- cipher.db 只读面板的进程边界(edge-worker 只读 vs bridge 读)。
