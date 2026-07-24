# FLY-1412 开新 flag 必须带退役条件 + 建清理单 — 调研

Issue: FLY-1412 (https://linear.app/geoforge3d/issue/FLY-1412/flag治理治源头-开新-flag-必须同步带退役条件-建清理单-创建时强制不靠人记)
日期: 2026-07-22
基于: exploration.md(同文件夹)+ product/doc/FLY-1091-feature-flag-policy/research.md(上游政策调研)

---

## 0. 边界(诚实交代)

- FLY-1091 的 research 已经把**「flag 该不该开 / 在哪管 / 何时删」的正典**查完了(Fowler 四分类、toggle 债五条纪律、Unleash 生命周期、LaunchDarkly、配置六级进阶)。**本文不重复**,只在它上面往前钻一层。
- 本文只回答 FLY-1412 特有的那个窄问题:**「出生那一刻」怎么强制,以及清理单怎么自动生出来。**
- 所有事实带链接;我没能核实的写在 §6。

---

## 1. 上游已确立的结论(一句话继承,不重述)

FLY-1091 research §2 从 Fowler 原文摘出的五条纪律里,有**两条**正好就是 FLY-1412 的两个诉求:

| Fowler 原文纪律 | 对应 FLY-1412 |
|---|---|
| ③ 给 flag 加**到期日**(expiration dates) | 诉求 1:必须声明退役条件 |
| ② 一引入 release toggle,就**立刻在 backlog 里加一条「删除它」的任务** | 诉求 2:自动同步建清理单 |
| ④ **time bomb**:过期还在就让测试失败,甚至拒绝启动应用 | 「强制」的具体手段(topic B) |

→ **FLY-1412 不是发明新东西,是把业界正典里早就写着的两条落到我们的出生那一刻。**
FLY-1091 当时的结论是「这五条我们一条都没落地」——本单负责落其中两条。

---

## 2. 核心参考:Uber Piranha(跟本单形态最像的真实系统)

Piranha 是 Uber 开源的、**自动删除过期 flag 代码**的工具([Uber Blog](https://www.uber.com/en-US/blog/piranha/)、[ICSE-SEIP 2020 论文](https://dl.acm.org/doi/10.1145/3377813.3381350))。

**它的完整闭环(逐条,对照我们)**:

| Piranha 的做法 | 我们对应的位置 |
|---|---|
| 输入三样:**flag 名 + 期望的最终行为 + flag 作者** | 我们的 registry 有 name,**没有作者、没有期望最终行为** ← 缺口 |
| 内部流水线**每周跑一次**,向 flag 管理系统查「陈旧 flag」 | 我们有 Bridge、有定时机制,**没有陈旧判定** ← 缺口 |
| 陈旧的定义 = 在 flag 管理系统里**超过 8 周没被改动** | 我们连「上次改动时间」都没记 ← 缺口 |
| 自动生成一份**删除代码的 diff**,**指派给这个 flag 的作者** | 我们有 Bridge 自动建 Linear issue 的先例 ← 可复用 |
| 另有一个提醒机器人 **PiranhaaTidy**,定期在还没处理的清理任务上加提醒 | 我们有 Discord Lead 提醒机制 ← 可复用 |
| 战果:清掉约 **2000 个**陈旧 flag;平均生成一份 diff **不到 3 分钟** | — |

**对本单最重要的两条启示**:

1. **「作者」是自动清理能跑起来的前提。** Piranha 的 diff 必须指派给人,否则它就是一份没人认领的自动垃圾。
   → 我们的退役条件里**大概率需要一个 owner 字段**(topic A3 要问 Annie 的正是这个)。
   我们的情况有个简化:**owner 几乎总是「开这个 flag 的那张 FLY 单」**,不是某个人。
2. **Piranha 的判定是「陈旧」(N 周没动),不是「到期日」。** 它其实**没有**在创建时强制声明死期 ——
   它是**事后**用时间信号推断。FLY-1412 要做的比 Piranha 更靠前一步(**出生时**就声明),
   这在业界更少见,但更彻底 —— 因为「N 周没动」对我们不成立(Annie 在 FLY-1091 §12.4 已指出:
   她一个人干活,日历静默 ≠ 没在用)。**这条论证支持 Annie 的方向是对的。**

---

## 3. 「创建时强制声明」在业界怎么做

### 3.1 LaunchDarkly:temporary / permanent 是**创建时的必选项**

([LaunchDarkly Docs — 技术债](https://launchdarkly.com/docs/guides/flags/technical-debt)、[Flag lifecycle settings](https://launchdarkly.com/docs/home/flags/flag-lifecycle-settings))

- 建 flag 时必须选 **temporary(临时)还是 permanent(永久)**:
  - temporary = 功能全量上线后就该删的(实验、放量、测试、发布)。
  - permanent = 常规运维/架构的一部分,建的时候就不打算删。
- **陈旧(stale)的定义只对 temporary 成立**:temporary + 未删未归档 + 创建满 30 天 + 状态是 inactive 或 launched 满 7 天。
- **官方明确警告**:不要为了躲开陈旧检测而把 temporary 改成 permanent —— 该归档就归档。

> **对我们 topic A2(「永久开关」逃生口)的直接答案**:
> 业界的答案不是「禁止永久」,而是「永久是一个**合法但要交代理由**的类别,
> 且系统必须能看出有人在用它当逃生口」。LaunchDarkly 靠的是把这句话写进文档 + 让 permanent 数量可见。
> 我们可以做得更硬(比如永久必须写一句为什么永久、且永久 flag 单独列一张榜)。

### 3.2 「创建守卫」(creation guardrails)是个已确立的模式

多篇治理实践把这个叫 creation guardrail:
**CI 检查 / API 校验直接拒绝缺少必填元数据(如 expiry_date)的 flag**,
实现方式是 webhook 校验或 pre-commit hook([Split — Managing Feature Flag Retirement](https://www.split.io/blog/managing-feature-flag-retirement-and-technical-debt/)、
[Feature Flag Governance: Lifecycle Best Practices](https://beefed.ai/en/feature-flag-governance-lifecycle-best-practices))。

→ **这正是 FLY-1412 的形状,而且我们已经有那条 CI 车道**(exploration §2:漂移守卫 + **29** 条注册表断言都在 CI 里跑)。
差别只是:别人要额外搭 webhook,我们只要**在已有的类型和已有的断言里加一格**。

### 3.3 Time bomb:让过期变成「响的」而不是「静的」

Fowler 原文(FLY-1091 research §2 已引):
> 有的团队做「定时炸弹」:flag 过了到期日还在,就让**测试失败**,甚至**拒绝启动应用**。

治理实践里的说法是:time bomb 把**沉默的债**变成**吵闹的、可执行的失败**。

**分档(给 topic B 的选项空间)**,由软到硬:
1. 报告里列出来(纯可见性,今天的 flag 报告已有雏形)
2. 到期自动建一张清理单(= issue 的诉求 2)
3. 到期后 CI 打**警告**(不挂)
4. 到期后 CI **挂**(= 真 time bomb,不删就发不了别的车)
5. 拒绝启动应用(业界有人做,对我们过于激进 —— 会把 Annie 自己的生产 Bridge 打死)

→ 我的初判:**创建时用第 4 档硬门(没填就编译/CI 不过),到期后用第 2 档 + 第 3 档**,
第 5 档不要。理由:创建时硬是零代价的(那一刻人就在改这个文件);
到期时硬会在 Annie 最不需要的时候(她在赶别的活)拦住她。**这条留给 Round 3 跟她评。**

---

## 4. 我们的独特约束(业界方案不能照抄的地方)

| 约束 | 后果 |
|---|---|
| **一人公司 + AI 写代码**。「作者」不是人,是一张 FLY 单 / 一个 Runner。 | owner 字段应该记 **issue id**,不是人名。Piranha「指派给作者」→ 我们「链回那张单」。 |
| **日历静默 ≠ 没在用**(Annie,FLY-1091 §12.4)。她一个人、周末不干活。 | 不能照抄 Unleash 的「2 天没命中就清」和 Piranha 的「8 周没动就陈旧」。**必须是出生时声明的显式条件**,不是事后时间推断。→ **再次支持 Annie 的方向。** |
| **退役一个 flag 是真工程改造**,不是删一行(exploration §4:代码 gate 和注册表必须同步删,FLY-1243 被迫分四类变换)。 | 清理单不是官僚主义,它对应真实工作量。但也意味着**一 flag 一单会淹掉 Linear**(148 个的规模)→ topic C2 要认真评批量。 |
| **flag 增长 ~37.5/周;出口 19 个,但 0 个来自常规机制**(重算后,见 prd.md §1.1)。 | 任何「靠人事后核」的方案都已经被证伪了 —— 19 个删除里 14 个来自**同一天**的一次性人肉审计(FLY-1136),5 个是做别的活时顺手删的。**审计有效,但从没变成常规。** |
| **我们的 flag 大部分是 default_on kill switch(105/148 默认开、64/148 kill switch)。** | ⚠️ **本行的推论已被推翻,见 prd.md §5.2.1** —— registry 里有确凿反例(`watchdog_blocked` 等长期安全门)。保留原文只为留痕。原推论:这一类**按定义就是临时的**:修复稳定后应固化成默认行为、删开关。→ 「临时/永久」这个分类**可以由已有的 category + polarity 自动推断**,不必让人再填一遍。这是我们比 LaunchDarkly 省的地方。 |

---

## 5. 候选设计空间(只列空间,不下 verdict —— verdict 归 Annie co-eval)

### 5.1 退役条件的三种形态(topic A1)

| 形态 | 长什么样 | 代价 |
|---|---|---|
| **甲 · 日历到期日** | `expiresAt: "2026-08-15"` | 最简单、可自动判定;但会逼人瞎填一个日期(Annie 的真实节奏不按日历走) |
| **乙 · 事件条件(枚举)** | `retire: "fix_stabilized"` / `"rollout_complete"` / `"permanent"` | 贴合真实意图;但「稳定了没」需要人判断 → 到期判定不能全自动 |
| **丙 · 甲+乙组合** | 枚举条件 + 一个兜底复核日期 | 覆盖最全;字段最多、最啰嗦 |

### 5.2 清理单的两种时机(topic C1)

| | 出生即建单 | 到期才建单 |
|---|---|---|
| 好处 | 完全不靠定时任务;单子和 flag 同生 | Linear 不会被 148 张单淹 |
| 代价 | 148 张待办单立刻涌进 Linear | 需要一个定时扫描器(新基建) |
| 业界 | Fowler 纪律② | Uber Piranha(周跑) |

### 5.3 落点的三个候选(topic D1)

| 候选 | 成本 | 我的初判 |
|---|---|---|
| **挂已有 registry 类型 + CI 断言** | 加一个必填字段 + 一条断言 | ✅ 推荐 —— 零新基建,当天可落 |
| 并进 FLY-872 的钩子 | 872 还在 Backlog 没开工;且它是**读侧**渲染 | ❌ 不可用且不同点 |
| 独立拦截层 | 新建一层 | ❌ 已有拦截层,重复造 |

---

## 6. 未能核实 / 存疑

- LaunchDarkly 是否**强制** maintainer 字段:官方 lifecycle-settings 页面没写,别处也没找到确证 → **UNKNOWN**,不当事实用。
- Piranha 是否有「创建时声明」的配套(它公开的部分只有事后陈旧判定)→ **未找到**,按「没有」处理。
- 我们 registry 里那 9 个 `retiring` 字段的实际语义是否统一 → 需要逐条看,留到 plan 阶段(不影响 Round 1/2)。

---

## 参考

- Pete Hodgson, *Feature Toggles (aka Feature Flags)* — https://martinfowler.com/articles/feature-toggles.html
- Uber Engineering, *Introducing Piranha* — https://www.uber.com/en-US/blog/piranha/
- Ramanathan et al., *Piranha: Reducing Feature Flag Debt at Uber* (ICSE-SEIP 2020) — https://dl.acm.org/doi/10.1145/3377813.3381350
- LaunchDarkly, *Reducing technical debt from feature flags* — https://launchdarkly.com/docs/guides/flags/technical-debt
- LaunchDarkly, *Flag lifecycle settings* — https://launchdarkly.com/docs/home/flags/flag-lifecycle-settings
- Split, *Managing Feature Flag Retirement and Technical Debt* — https://www.split.io/blog/managing-feature-flag-retirement-and-technical-debt/
- *Feature Flag Governance: Lifecycle Best Practices* — https://beefed.ai/en/feature-flag-governance-lifecycle-best-practices
- 上游:`product/doc/FLY-1091-feature-flag-policy/research.md`(Fowler 五条纪律、Unleash 生命周期、配置六级进阶)
