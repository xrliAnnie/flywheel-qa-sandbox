# FLY-1140 动态 DAG 协作编排 — 探索(co-eval 第 1 轮记录)

Issue: FLY-1140 (https://linear.app/geoforge3d/issue/FLY-1140/动态-dag-协作编排operating-model-roles-as-ics-静态动态进化-双维评估)
日期: 2026-07-10
基于: 无(上游 = Deep Research `/tmp/dr2-dynamic-orchestration-verbatim.md` + issue 正文)

> **当前 canonical = `co-eval-r3.html`(第 3 轮,核心化简);r1/r2 已作废(git rm,历史可查)。**
> 本文件是 co-eval 的**可复用文本记录**,供后续轮次续接。research/plan 待 Annie 在 r3 确认核心后收进 PRD。
>
> - r1(发散):DR mechanism 摊开给 Annie 圈 → steer「太抽象」+ 锁核心轴。
> - r2(收敛+具体):每块画图+真示例;轴变「已定=Lead 派发」;评估 open。→ Annie 发现张力:轴 与 A(DACI)+B(目标卡)重叠,问「都需要吗?」。
> - r3(核心化简):化成【一个核心=Lead 讨论组 DAG;A/B 是这次讨论的产出,非并列仪式】;A=决策权按任务现定(PM 非必选);B=记录+复盘整条流程画死(每步谁负责);阶梯锁定;C/D 押后,E+评估下轮展开(含「延迟失败难追溯」难题)。

## 1. DR 的核心一句

**「编排」≠「拆活」。** 成熟人类组织把编排当成一套*会自己学习的派活系统*在设计:
理清归属 → 按需组队 → 保住高信任稳定核心 → 留出探索空间 → 每次结果喂回下一次派活。

DR 给的骨架:让系统转起来的不是某一个框架,而是 **5 层机制叠在一起** ——
① 归属(决策权)· ② 运行时协调 · ③ 派活 · ④ 评估 · ⑤ 回流。

## 2. DR mechanism → 我们现状 → 可借(co-eval 卡片对应)

| # | DR mechanism(人类/成熟系统) | 我们现状(静态 three-session)差在哪 | 可借做法 |
|---|---|---|---|
| A | **决策权覆盖层**(RACI/DACI):不写全流程,只定谁拍板/执行/咨询/知会;一件事一个拍板人 | 角色间是固定「谁交给谁」链,无「谁拍板/往哪升」层;图一重组易乱 | 每块角色积木自带决策权卡(拍板什么/要谁批/卡住找谁);接现有 Lead→founder 升级线 |
| B | **brief→huddle→debrief + 每单一张「今日目标卡/call sheet」**(医院/AHRQ Daily Goals) | 拿计划一路跑到底;无中途碰头改图;无喂回评估的复盘 | 每 issue 一张今日目标卡(下步目标/负责角色/交接点/兜底);关键点允许改图;收尾复盘喂给评估 |
| C | **swarm(围上来)**(PagerDuty IC+SME / Salesforce / MS 客服) | runner 卡住只能串行升级(runner→Lead→Annie);无「围上来」 | 给含糊/跨域/反复失败的活设 swarm 触发器:动态拉「解题+验证+领域专家」一起上 |
| D1 | **挑谁干 = 技能+空闲+负载+靠谱度**(咨询 staffing / GitHub review 轮转·负载均衡·跳过 busy) | 派活只看「标签→角色」,不看负载/胜率 | 派活看技能标签+当前负载+过往在类似子任务胜率;验证/review 也自动派 |
| D2 | **exploit vs explore**(March;关键路径用信得过的、低风险边灰度试挑战者;AI 能便宜地平行跑多个世界) | 永远跑同一角色版本;无挑战者/影子/探索预算→无法越跑越好 | 明规则:关键路径用信得过版本,低风险边留探索预算灰度试新版本;喂养个人评估 |
| E | **稳定核心+灵活挂载/熟人预算**(创伤团队 transactive memory;军队警告别乱重组) | 无「哪些角色组合配得好」概念,每次当全新组合 | 记「熟人预算」:哪些组合跑得顺;保稳定核心只在边缘重组 → 即第二维「DAG 组合评估」原料 |
| F | **两维评估 + 回流**:个人=校准会+能力档,AI 上 360=多独立评审模型+人校准;组合=评 composition+协作面(Project Aristotle);评估结果喂回派活,保留「谁跟谁配得好」的关系数据 | 无系统评估;FLY-1045 有学习回路框但两维+回流未落 | 个人维=给 role-version 打分(多评审+人校准+能力档);组合维=给 DAG 组合打分;都喂回派活;复用 LangSmith/Braintrust 现成 eval,不自己造 |

**AI-native 优势(DR 强调):** worker 天然可版本化(model+prompt+tools+cost/latency+skill tag+eval trace);
workflow 本就是图(Prefect 动态 task / LangGraph);eval 能离线/在线/两两/持续跑 → exploit-explore 可**工程化**(canary/影子/pairwise),人类组织做不到的地方我们能。

## 3. ⭐ 核心设计轴(待 co-create)—— 动态 DAG 谁编排?

轴两端:**领导派(HL+Tadashi 组织)** ↔ **IC 自认领(积木自己接单)**。

**DR 的答案不是二选一,是「混合」:** Google/美军/麦肯锡/德勤都有内部劳动力市场,共同做法 =
**关键路径领导派(要产出/靠谱)+ 低风险/探索性活放开自认领(要动力/少错配)+ 明确探索预算。**
→ 真问题不是「选哪端」,而是「**混合线画在哪**」。这条留给 Annie 画。

- 领导派端 ↔ Annie 阶段 1(Cass 从 Epic 提事 → HL+Tadashi 定具体事)
- 自认领端 ↔ FLY-1045 自发发现/自提 + FLY-1022 层级 runner 树
- 混合(DR 荐)↔ Annie 阶段 2(事定好后谁组图)

## 4. 拼图现状(一大半已在建 / 在收敛)

| 拼图块 | 对应 issue | 状态 |
|---|---|---|
| IC 角色(积木) | PM·Prototype(FLY-1089)· Designer(FLY-1059)· 架构/工程/QA(现 three-session) | 已 ship |
| DAG 编排 | FLY-1020(任务类别→DAG 模板)+ FLY-353(编排引擎) | 在飞;静态模板=现状 |
| 进化阶梯 | FLY-1045 四级(现在→半自动→自动接单→探索层自提) | 在建 |
| 两维评估 | FLY-1045 学习回路 + role-version 打分 | 在建 |
| PM 验收 | FLY-830(验收 gate,打回某步) | 愿景;暂不在 HL build 范围 |

**进化阶梯 × Annie 阶段:** 阶段 1 = 「现在」这级;阶段 2 = 「半自动」这级(谁编排 = §3 那条轴)。

**真正要 co-create 的两件事(其余拼图块已在路上):**
1. §3 混合线画在哪(决定阶段 2 形态);
2. 骨架里最缺的 **②运行时协调 + ⑤评估回流** 先补哪块。

## 5. 下一步(等 Annie 圈完 r1)

- 有定见的块 → 按她的收;想「我来发挥」的块 → 下一轮给更具体的 2-3 个方案。
- 收敛后 → research.md(选定方向的机制调研)→ plan.md(可建的设计)→ Codex design review → 拆 build issue(编排引擎/eval build = Tadashi;串 FLY-1020/1089/1059/1045/353/1022/830)。
