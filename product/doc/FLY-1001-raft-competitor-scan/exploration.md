# FLY-1001 Raft 竞品分析 — 探索(理解 + 假设 + 三轴口径)

Issue: FLY-1001 (https://linear.app/geoforge3d/issue/FLY-1001/raft-竞品分析-raft-vs-flywheel-差异化-competitor-scan-round-3)
日期: 2026-07-08
基于: 无(本 issue 起点);上游 context = FLY-999 / FLY-1000(Cass Raft profile)+ FLY-909 competitor-scan + FLY-911 定位

---

## 这个任务是什么(一句话)

Annie 2026-07-08 发现新竞品 **Raft(raft.build,前身 slock)**,直觉是「Kimi 打不过、又一个竞品」。任务 = 对 Raft 做 competitor-scan **round-3**,**折进 FLY-909**(Raft 进对比表 + 三轴差异化每轴标「vs Raft 成不成立」),像当初处理 Matrix 那样。**诚实,不美化。**

**不是**「Raft 长啥样」(Cass 扒了 profile),**是**三个分析问题:
1. Raft vs Flywheel —— 到底威胁到哪(功能/定位/客户重叠、哪里正面撞车)。
2. 压测 Cass 的判断「护城河不在编排引擎、在下游(跑在自己真实产品上 + 复利 + founder 判断)」—— 用证据核:Raft 把编排层产品化了,这条下游护城河多硬、Raft 能不能/有没有在做。
3. 对 FLY-911 定位(非技术 OPC operator / always-on + 记忆 + Push)的影响 —— 动摇没有、要不要调。

## 我读了什么(context 来源)

- **FLY-1001 / FLY-999 issue 正文** = Cass 扒的 Raft profile:频道协作平台、常驻带记忆 agent、本机 daemon、channels/threads/tasks/@提及、创始人分布式共识出身 + 前 Kimi、工程博客(『报数』stale-snapshot / 版本检查 / 暂存草稿 / Dmail)。
- **FLY-909**:competitor-scan.md(横切表 A + 差异化章节)、matrix-deepdive.md(独立深挖模板)、competitor-deepdives.md(逐家对比矩阵)。
- **FLY-911**:定位收敛 v1(最先专攻的客户群 = 非技术 OPC operator;真差异 = 协调 + Push;供应商中立已降为「未来原则」;引擎层无护城河已认)。
- **有界核实(1 轮 WebFetch/WebSearch,只锁定分析枢轴,不重复 Cass 的 raw-dig)**:raft.build 首页 + docs welcome + 创始人推文。锁定了「目标客户 / 产品形态 / 部署形态 / runtime 后端 / 定价」这几个决定分析走向的事实(详见 research.md)。

## 核实出来、改变分析走向的两条硬事实(⚠️ 提前 flag)

1. **Raft 是 runtime-agnostic(Claude / Codex / Hermes / more)** —— 它是**第三方**、正在做**供应商中立**。→ 我们把「供应商中立 = 第一方厂商结构上不会做」当差异(FLY-909 §⑥.4 / FLY-911 支柱④),对 Cowork/Codex 成立,**对 Raft 不成立**。好在 FLY-911 已把这条降为「未来原则」。
2. **Raft 有复利/记忆机制**("what one agent figures out, the next one builds on" + 持久记忆 + agent 互相 hand-off/review)。→ 我们的「复利/记忆」在**机制层面**被 Raft 匹配,不是干净护城河。

→ 初判(待 research 坐实):**Raft 是目前找到最贴、最该警惕的竞品**(比 Matrix 的桌面小人、比 Cowork 的桌面知识工作更贴我们的 chat-teammate 形态),且**在引擎/机制层比我们强**(创始人分布式共识 + 前 Kimi + 已产品化 version-check/staged-draft,正是我们还在打的 FLY-574 那类坑)。**这恰恰坐实 Cass「护城河不在引擎」的判断** —— 因为 Raft 证明引擎守不住。

## 关键假设(surface,别默默填)

- **A1**:Cass「勿重复 raw-dig」= 别重做 profile;不禁我为「分析枢轴」做有界核实。我做了 1 轮(目标客户/形态),因为整个威胁分析压在「Raft 瞄技术团队还是非技术 operator」上,不能假设。
- **A2**:「三轴差异化」= 沿任务点名的**下游护城河三条**逐轴压测 vs Raft,并对齐 FLY-911 的真差异框:
  - **轴 1 — 领域/下游**:替非技术 operator **建并养一个真软件产品/系统**(跑在你自己真实业务上、长期维护)。
  - **轴 2 — 被协调的常驻组织 + 复利**:always-on + 记忆 + 跨项目复用 + **管理层(Leads/CoS 分诊)+ Push**,不是你在房间里当 PM。
  - **轴 3 — done-for-you 给非技术 operator + founder 判断留两头**:替他做(他自己拼不出)+ 人只做判断/验收。
  - 每轴结论:**成立 / 部分成立 / 不成立 vs Raft**,诚实标。
- **A3**:交付**折进 FLY-909**(新 raft-deepdive.md + 编辑 competitor-scan.md 加 round-3 Raft 段 + 横切表 A 加行)。**FLY-911 只出「影响评估 + 建议」,不擅自改定位**(定位在 911 跟 Annie 拍)。
- **A4**:『报数』/version-check/staged-draft/Dmail 的「可抄工程解法」= **FLY-999 的 scope(Cass/eng)**,本 issue 只把它当「Raft 引擎领先」的证据引用,不做完整可抄清单。

## 过程口径(按风险分档)

纯分析/文档、无代码、可逆(分支 + PR review)。按 doc tier = full 出 exploration / research / plan 三份过程文档 + 交付。**真正的把关点 = brainstorm gate(确认理解方向)+ approve gate(Honey Lemon/Annie 读结论)**;codex design-review 是给可 build 的工程 plan 的,对「改几个 markdown 的 edit-plan」价值低 —— 倾向 brainstorm 确认后直接写 + PR + code review,把重量放在**分析质量**而非流程仪式(会在 brainstorm gate 里说明,Lead 可否决)。

## 待 Lead / Annie 确认(brainstorm gate 里问)

1. 三轴口径(A2)对不对?还是要沿 matrix-deepdive 的「领域 + 界面 + 可信度」老三轴?
2. FLY-911 只出「影响评估 + 建议」不擅改定位(A3),对不对?
3. 过程口径:brainstorm 确认后直接写交付,跳 codex design-review(纯 prose 分析),对不对?
