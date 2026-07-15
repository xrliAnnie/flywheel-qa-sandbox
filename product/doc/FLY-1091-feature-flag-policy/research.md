# FLY-1091 Feature flag 该怎么定 / 怎么管 — 调研

Issue: FLY-1091 (https://linear.app/geoforge3d/issue/FLY-1091/feature-flag-该怎么定-怎么管-research-设计我们的-flow小团队不-over-engineering)
日期: 2026-07-09
基于: exploration.md(同文件夹)

---

## 0. 研究方法与边界(诚实交代)

- **本文是 research,不下 verdict、不写 PRD。** 目标是把业界怎么用 feature flag 忠实报出来,给 Annie 的 co-eval 提供事实底座。方向性结论(我们该怎么做)留给 explainer HTML 里跟她一起定。
- **关于 deep research 工具**:正式的 ChatGPT Deep Research(`deep-research` skill)需要一个已配对的 headed Chrome,当前扩展没连上,**用不了。我没有去试、也没有假装跑过。** 本文改用 WebSearch / WebFetch 直接读一手源(Fowler/Hodgson 那篇正典、各家官方文档、SEC 文件)。如果 Annie 之后想要一份正式的 ChatGPT DR 报告,等浏览器连上再单独跑。
- **每条结论都带出处 URL。** 核不到的地方明确标 `未能核实 / UNKNOWN`,不拿记忆填。
- 引用尽量给英文原文 + 中文转述,避免转译走样。

---

## 1. Toggle 四分类 + 两个维度(正典)

来源:Pete Hodgson,《Feature Toggles (aka Feature Flags)》,发表在 Martin Fowler 站上——这是业界公认的正典。
https://martinfowler.com/articles/feature-toggles.html

这篇文章最核心的贡献:**flag 不是一种东西,而是四种寿命和动态性完全不同的东西**,而混淆它们是几乎所有 flag 债的根源。它用两个维度来区分:

> "Feature toggles can be categorized across two major dimensions: **how long the feature toggle will live** and **how dynamic the toggling decision must be**."
> (按两个维度分类:这个 flag 会活多久、以及切换决策要多动态。)

### 1.1 Release Toggle(发布开关)

- **定义**:"allow incomplete and un-tested codepaths to be shipped to production as latent code which may never be turned on."(让未完成、未测试的代码路径作为「潜伏代码」被发到生产,可能永远不打开。)
- **寿命**:"should generally not stick around much longer than **a week or two**."(一般不该活过一两周。)
- **动态性**:"typically **very static**. Every toggling decision for a given release version will be the same."(非常静态,同一个发布版本里每次判断都一样。)

### 1.2 Experiment Toggle(实验开关)

- **定义**:做 A/B / 多变量测试。"Each user … is placed into a cohort and at runtime the Toggle Router will consistently send a given user down one codepath or the other, based upon which cohort they are in."(把每个用户分进一个 cohort,运行时按 cohort 一致地路由。)
- **寿命**:"needs to remain in place … long enough to generate **statistically significant results**. Depending on traffic patterns that might mean a lifetime of hours or weeks."(要活到攒够统计显著性,取决于流量,几小时到几周。)
- **动态性**:"highly dynamic - each incoming request is likely on behalf of a different user."(高度动态,每个请求可能是不同用户。)
- **⚠️ 对我们**:这一类的存在前提是「有足够多的用户 + 流量 + 统计功效」。**Annie 一个用户、零流量 → 这一类对我们直接不成立**(不是「暂时不用」,是数学上没意义)。

### 1.3 Ops Toggle(运维开关 / kill switch)

- **定义**:"used to control operational aspects of our system's behavior … so that system operators can **disable or degrade that feature quickly** in production if needed."(运维用来在生产里快速关掉/降级某功能。)
- **寿命**:"relatively short-lived - once confidence is gained … the flag should be retired. However it's not uncommon for systems to have a small number of **long-lived 'Kill Switches.'**"(通常短命,信心建立后就退役;但保留少量长寿 kill switch 很常见。)
- **动态性**:"need to be re-configured **extremely quickly** - needing to roll out a new release in order to flip an Ops Toggle is unlikely to make an Operations person happy."(要能极快切换,靠重新发布来翻它会让运维抓狂。)

### 1.4 Permissioning Toggle(权限开关)

- **定义**:"used to change the features or product experience that certain users receive … a set of 'premium' features which we only toggle on for our paying customers."(按用户/付费层级给不同人不同功能。)
- **寿命**:"may be **very-long lived** … at the scale of **multiple years**."(可能活很多年。)
- **动态性**:"always be **per-request** … a very dynamic toggle."(总是按请求判断,非常动态。)
- **⚠️ 对我们**:我们只有 founder 一个人,没有付费层级、没有多用户权限分层 → **这一类目前用不上**。

### 1.5 一张表看懂(寿命 × 动态性)

| 类别 | 寿命 | 动态性 | 对 Flywheel(零流量、单用户) |
|---|---|---|---|
| **Release** | 一两周(短) | 静态 | ✅ **成立** —— 为了把未完成的活安全合进 trunk |
| **Experiment** | 数小时~数周 | 高度动态 | ❌ **不成立** —— 没流量就没统计意义 |
| **Ops / kill switch** | 短命,少数长寿 | 要极快切换 | ✅ **成立** —— 风险子系统的紧急开关 |
| **Permission** | 数年(长) | 按请求 | ❌ **暂不成立** —— 只有一个用户,无权限分层 |

> 这张表**印证了 Lead 的工作假设**:对我们真正有用的只有 **Release + Ops** 两类。但要强调——这是「哪类 flag 适用」,不等于「每个 feature 都要加 flag」。见 §7、§8。

---

## 2. 生命周期与「Toggle 债」(本 issue 的核心)

Fowler 那篇专门有一节 "Managing the carrying cost of Feature Toggles"(管理 flag 的持有成本),这是整篇里跟我们最相关的部分。逐条引原文:

**① flag 是有持有成本的库存**
> "Savvy teams view their Feature Toggles as **inventory which comes with a carrying cost** and seek to keep that inventory as low as possible."
> (聪明的团队把 flag 当成「有持有成本的库存」,想方设法让库存尽量低。)

**② 创建 flag 时就把「删除任务」放进 backlog**
> "Some teams have a rule of **always adding a toggle removal task onto the team's backlog** whenever a Release Toggle is first introduced."
> (一引入 release toggle,就立刻在 backlog 里加一条「删除它」的任务。)

**③ 给 flag 加到期日**
> "Other teams put **'expiration dates'** on their toggles."

**④ Time bomb —— 过期就让测试/启动失败(治长寿 flag 最硬的一招)**
> "Some go as far as creating **'time bombs'** which will **fail a test (or even refuse to start an application!)** if a feature flag is still around after its expiration date."
> (有的团队做「定时炸弹」:flag 过了到期日还在,就让测试失败,甚至拒绝启动应用。)

**⑤ 给库存设硬上限(Lean 思路)**
> "We can also apply a Lean approach … placing a **limit on the number of feature flags** a system is allowed to have at any one time. Once that limit is reached if someone wants to add a new toggle they will first need to do the work to **remove an existing flag**."
> (给系统同时存在的 flag 数量设上限;到顶了想加新的,必须先删一个旧的。)

**⚠️ 直接对照我们的审计**:exploration §2.6 里我实测——registry 一周内 flag 从 40 → 77(env),**从未删过一个**。上面这五条业界纪律,**我们一条都没有落地**:没有 owner、没有到期日、没有 time bomb、没有库存上限、没有「建 flag 即建删除任务」。我们有的只是一个 CI drift 守卫,它强制你**登记**,却不强制你**打开或删除**。

---

## 3. Toggle 配置放在哪(六级进阶)

Fowler 给了一条从简到繁的进阶路径,并明确了选择原则:

1. **Hardcoded**(改代码注释/`#ifdef`)—— 只适合「靠重新部署来改 flag」的场景。
2. **Parameterized**(命令行参数 / 环境变量)—— "changes … require either a re-deploy or at the very least a **process restart**."(改一次要重新部署,或至少重启进程。)← **这正是我们 `.env` 的形态,也正是 exploration §2.5 里 D 类病「设了 =1 但没重启还是睡着」的来源。**
3. **配置文件** —— 改文件即可,但通常仍需重新部署。
4. **App DB + 管理 UI** —— 集中存储,常配一个给运维/PM 用的后台界面。
5. **分布式配置**(Zookeeper / etcd / Consul)—— 可动态改、集群自动感知。
6. **专用 flag 管理服务**(LaunchDarkly 等)。

**选择原则(原文)**:
> "Managing toggle configuration via **source control and re-deployments is preferable**, if the nature of the feature flag allows it."
> (只要 flag 的性质允许,用「源码管理 + 重新部署」来管配置是更可取的。)

> 这条对我们很重要:业界正典并**不**默认推荐上重型服务;能用「代码 + 重新部署」管的就别上服务。我们的 registry(TS 声明式 + `.env`)正好落在 2~3 级之间,是**符合正典推荐方向**的形态——问题不在「层级太低要升级」,而在「这一层缺生命周期纪律」。

---

## 4. Trunk-Based Development 里 flag 扮演什么角色

来源:https://trunkbaseddevelopment.com/feature-flags/ +(§1 Fowler)

**为什么需要 release flag**:它让你把**未完成的活**直接合进 trunk,同时 trunk 随时可发布——从而避免长命分支的合并痛苦。Fowler 原文:
> Release Toggles "allow in-progress features to be checked into a shared integration branch (e.g. master or trunk) while still allowing that branch to be deployed to production at any time."

这也是 Continuous Delivery 那句名言的实现方式:
> "the most common way to implement … **'separating [feature] release from [code] deployment.'**"(把「功能发布」和「代码部署」分开。)

**但同一页也给了最直白的警告**(这正是我们的病):
> "Flags get put into codebases over time and **often get forgotten** as development teams pivot towards new business deliverables."
> (flag 随时间被塞进代码库,团队转向新活后**经常被遗忘**。)

建议的补救节奏:
> "Try to get the business to allow the **remediation of flags (and the code they apply to) a month after the release**."(争取在发布一个月后就清理掉 flag 和它对应的代码。)

Brad Appleton 的话(页面引用):
> "The thing I do not like about feature-toggles/flags is when they end up **NOT being short-lived as intended**."(我唯一不喜欢 flag 的地方,就是它们最后没能像设计的那样短命。)

页面还引了 1992 年的经典警告 "#ifdef considered harmful",提醒不要滥用条件编译式的开关。

> **一句话**:flag 在 trunk-based development 里是「安全合入未完成的活」的手段——但它的价值**内建了一个前提:用完就删**。不删,它就从「安全手段」退化成「隐藏的技术债」。

---

## 5. 集中管理形态对比(自建 vs 各家产品)

按「核心价值 / 有没有生命周期治理 / 成本 / 假设你有什么」四栏对比。

### 5.1 自建 registry(= 我们现在的形态)

- **核心价值**:单一真相 + 类型安全 + CI drift 守卫。零外部依赖、零成本、配置随代码走。
- **生命周期治理**:**取决于你自己写**。我们目前**没有**(见 §2 对照)。
- **成本**:0。
- **假设**:小团队、配置能随代码/重新部署走、不需要运行时动态下发。← **正好是我们。**

### 5.2 LaunchDarkly(重型商业标杆)

来源:https://launchdarkly.com/pricing/ 、https://launchdarkly.com/docs/home/releases/flag-health 、https://launchdarkly.com/docs/guides/flags/technical-debt 、https://launchdarkly.com/docs/home/flags/manage/flag-cleanup-vega

- **核心价值**:运行时动态下发(按用户/百分比/segment)、多环境、团队权限、审计、实验平台。**这些是配置文件给不了的。**
- **生命周期治理(做得最成熟)**:
  - **stale flag 明确定义**:一个 flag 同时满足「标记为 temporary + 未删未归档 + 创建满 30 天 + 处于 inactive/launched 状态满 7 天」→ 判为 stale。
  - **Flag health / code references**:追踪哪些 flag 还在代码里被引用。
  - **Vega**:自动化清理工具,自动做安全检查 + 改代码删 stale flag。
  - ⚠️ **但 flag 生命周期/清理工具是 Enterprise 套餐才有的**(据 Growthbook 的对比文,未在官方定价页逐字核实 → 标 **部分核实**)。
- **成本**:per-seat 定价;Developer 免费档(无限 seat/flag,但 5 service connections、1000 client-side MAU 上限);「10 个 seat ≈ $1,200+/年」(来自第三方对比文,非官方逐字 → **部分核实**)。
- **假设**:多环境、多工程师、**真实用户流量**、要百分比放量。← **我们三样都没有。**

### 5.3 Unleash(开源可自托管,生命周期模型最清晰)

来源:https://docs.getunleash.io/concepts/feature-flags 、https://www.getunleash.io/blog/feature-lifecycle-management

- **核心价值**:开源可自托管、activation strategies、**一套命名清晰的生命周期模型**。
- **生命周期治理(值得直接借鉴的样板)**:五个命名阶段 **Define → Develop → Production → Cleanup → Archived**,由**真实使用指标**驱动自动流转:
  - **Define**:flag 建了,但任何环境都还没测到指标 → 卡在这说明 pre-prod 集成有问题。
  - **Develop**:在非生产(或生产但关闭)环境测到了指标。
  - **Production**:在生产被真实使用。
  - **Cleanup**:**连续 ≥2 天没测到任何生产使用指标 → 大概率可以归档了**。
  - **Cleanup 里 7 天没用 → 自动挂上「建议归档」标记**。
  - **Archived**:归档;若复活,重新走一遍 Define。
- **成本**:开源自托管免费;托管/企业版付费(具体价 **未能核实**)。
- **假设**:仍偏向「有多环境 + 有真实使用指标可采集」。它的自动流转**依赖「能采到生产使用指标」**——这一点对我们**部分成立**:我们能知道一个 flag 的 readSite 有没有被执行,但没有 Unleash 那种现成的 metrics 管道。

> **关键借鉴**:Unleash 证明了「用**使用指标**而不是「人的记性」来判断一个 flag 该不该清理」是可行且已产品化的。它的「2 天没用→cleanup、7 天没用→建议归档」是一个具体、可抄的阈值样板。

### 5.4 Flagsmith / Flipt(轻量开源自托管)

来源:https://www.flipt.io/ 、https://github.com/Flagsmith/flagsmith 、https://flagshark.com/blog/open-source-feature-flag-tools-compared-2026/

- **Flipt**:Go 写的、**Git-native**(v2 把 flag 状态存进 Git 仓库、去掉了数据库依赖),YAML/JSON 声明式、**GitOps** 风格、自带 UI、**约 15 分钟就能起**。最适合「想要 Git 原生、低占用、不想管数据库」的小团队。targeting 能力不如 Unleash 复杂。
- **Flagsmith**:开源 + 开放核心(open-core);**自托管需要 PostgreSQL**,较重;高级治理/SSO 在付费企业版;偏合规/治理场景。
- **成本**:自托管开源部分免费;企业功能付费(具体价 **未能核实**)。

> Flipt 的 **GitOps / 声明式 / 无数据库**形态,和我们「registry 随代码走」的哲学最接近。它是一个「如果我们真要换外部工具、又不想 over-engineering」时**唯一值得看一眼**的参照——但它解决的主要是「运行时不重启改 flag」,而这不是我们的痛点。

### 5.5 OpenFeature(CNCF 标准,不是后端)

来源:https://openfeature.dev/ 、https://www.cncf.io/blog/2023/12/19/openfeature-becomes-a-cncf-incubating-project/

- **它是什么**:一个 **vendor-neutral 的 API / SDK 规范**(CNCF 孵化项目),**不是一个 flag 后端**。你的代码只依赖 OpenFeature SDK,后端通过「provider」插进来 → 避免在代码层被某家厂商锁定。
- **对我们**:它解决的是「将来不想被 LaunchDarkly 锁死」的问题。我们既不用外部厂商、也没有换厂商的打算 → **现在用不上**;但它是一个「如果哪天真要接外部工具,先套一层 OpenFeature 抽象」的**未来选项**,值得知道它存在。

### 5.6 GrowthBook / PostHog(实验优先,一句话带过)

这两家是 experiment-first(A/B 平台顺带做 flag)。**实验对我们不成立(§1.2)→ 直接跳过。**

---

## 6. 反面:flag 的成本,以及「加多了」的真实危害

Annie 的直觉(「flag 太多了」)有扎实的业界背书。三个角度:

### 6.1 组合爆炸

Fowler 明确点出:每加一个 flag,理论代码路径就翻倍。N 个 flag = 2^N 条路径的测试组合。这也是「flag 是有持有成本的库存」这句话背后的硬道理。这是**支持「别默认加 flag」的第一性论据**。

### 6.2 Knight Capital(2012,$440M)—— 严谨复述,不当传说讲

这是业界最常被引用的「stale flag + 死代码」灾难。**我特意核过 SEC 与 Wikipedia,避免以讹传讹**,准确形态如下:

来源:https://en.wikipedia.org/wiki/Knight_Capital_Group 、SEC 8-K https://www.sec.gov/Archives/edgar/data/0001060749/000119312512513607/d457296dex21.htm

- 有一段叫 **Power Peg** 的老代码,自 **2003 年起就不再在生产使用**,但**没有被删除**,留在代码库里当「休眠脚手架」。
- **2005 年,一个 flag 位被「重新利用」(repurposed)**:新功能 RLP 复用了当年 Power Peg 用的那个 flag 值,**假设 Power Peg 永不会再被调用**。
- 2012-08-01 部署新 RLP 代码时,**8 台服务器只部署了 7 台**;第 8 台跑的还是旧代码。
- 当那个 flag 被打开,第 8 台上**沉睡的 Power Peg 代码被激活**,45 分钟内发出数百万笔子订单,**税前亏损 $440M**,公司几近破产。

**准确的教训(不是「feature flag 会害死你」这种传说版)**:真正的杀手是**三件事叠加**——① 一个被**重新利用**的 flag(语义漂移),② **没有被删除的死代码**,③ **不完整的部署**。这三件我们都能对号入座:我们从不删 flag(§2.6)、我们靠「设了 =1 但没重启」制造状态漂移(exploration §2.5 D 类)。**它给我们的不是「别用 flag」,而是「flag 的语义漂移 + 死代码不删 = 定时炸弹」。**

### 6.3 长寿 flag = 隐藏的永久复杂度

多篇实践文一致:老的、被遗忘的 flag 一直漂在代码库里,技术债只增不减;"if you don't have the right systems, these flags will cause more harm than good."(没有配套系统,flag 弊大于利。)

---

## 7. 小团队 / 单用户场景:该砍掉什么(证据驱动)

来源:DevCycle、Medium 多篇小团队实践、LaunchDarkly/Flagsmith 科普文(见文末 Sources)

业界对「小团队/solo 要不要用 flag」的共识是**有条件的**,不是非黑即白:

**该砍掉的**:
- **实验 / A/B / 百分比放量**——零流量下数学上没意义(§1.2)。
- **权限分层 flag**——单用户用不上(§1.4)。
- **运行时动态下发服务**(LaunchDarkly/分布式配置)——其核心价值(不重启改 flag、多环境、团队权限)我们三样都不需要。"A **two-minute redeploy cycle** might make the complexity investment not worthwhile **unless you frequently need to toggle features off without redeploying**."(如果你两分钟就能重新部署,那么上一套 flag 服务的复杂度多半不划算——除非你经常需要「不重新部署就关功能」。)

**该保留的**:
- **Release toggle**——把未完成的活安全合进 trunk。但注意:"even a solo developer can use a **simple boolean flag**"——一个简单布尔就够,不需要平台。
- **Ops / kill switch**——风险子系统的紧急开关(尤其是那种「出事要马上能关、但重新部署来不及」的)。

**最关键的一条共识(直接回应 Annie 的痛点)**:
> "Feature flags aren't inherently overkill … but they **only add value if you'll actually maintain them**."(flag 本身不算过度设计……但它**只有在你真的会维护它时才有价值**。)
> "Don't use feature flags if … **old, forgotten flags keep floating in your codebase** while technical debt increases."(如果老的、被遗忘的 flag 一直漂着让技术债累积,那就别用。)

> **对我们的映射(陈述事实,不下结论)**:业界不说「小团队别用 flag」,它说「**小团队用 flag 的前提是有清理纪律;没有纪律,flag 对小团队的伤害比大团队更大**」——因为大团队还有专人和工具兜底,小团队没有。而 exploration 的审计正好证明:**我们有 flag、没纪律。** 这个 gap 是本 issue 要 co-eval 的方向。

---

## 8. 关键术语表(让 Annie 和团队用同一套词)

| 术语 | 含义 | 出处 |
|---|---|---|
| **Toggle debt / carrying cost(旗帜债 / 持有成本)** | flag 是有维护成本的库存,越多越贵 | Fowler |
| **Stale flag(过期/失活 flag)** | 满足「临时 + 建了 30 天 + 7 天没活动」等条件的可清理 flag | LaunchDarkly |
| **Time bomb(定时炸弹)** | 过了到期日还在就让测试失败/拒绝启动的机制 | Fowler |
| **Zombie / forgotten flag(僵尸 flag)** | 用完没删、一直漂在代码库里的 flag | Trunk-based dev |
| **Dark launch(暗发布)** | 新代码在生产跑但不暴露输出,用来观察/对比 | 业界通用(未在本轮逐字核实,标 **部分核实**) |
| **Branch by abstraction(按抽象分支)** | 用抽象层而非 Git 分支来隔离未完成改动,常与 release flag 搭配 | Fowler 提及(本轮未深挖,标 **部分核实**) |
| **Separating release from deployment(发布与部署分离)** | 代码部署 ≠ 功能发布;flag 是实现手段 | Fowler / CD |

---

## 9. 把业界框架映射回我们的审计(连接,不下 verdict)

这一节只做「业界的框架 ↔ 我们审计出的事实」的对应,**不给方案**(方案在 explainer 里跟 Annie 一起定)。

| Annie 的痛点 | 业界怎么框它 | 我们审计到的事实 |
|---|---|---|
| flag 太多、不知道哪个开 | carrying cost / 库存上限 | 一周 40→77,从没删过(§2.6);手机报告早已上线但 83 行 on/off 是噪音(exploration §2.4) |
| 做完忘了开 | separating release from deployment;release flag「用完即删」 | merge 当完成,enable 靠偶发人工 window(exploration §2.7);FLY-929 睡 2 天、auto-QA 数周没触发 |
| 该定一条「做完就开」的逻辑 | Unleash 生命周期用**使用指标**自动判 cleanup | 我们 registry 记了「值」不记「意图」,分不清「故意关」vs「忘了开」(exploration §2.4) |
| 每个 feature 都加吗 | 四分类:只有 Release+Ops 对我们成立;且「只在会维护时才加」 | 我们把加 flag 当默认动作(236/1532 commit) |

---

## 10. 留给 explainer / co-eval 的三个问题(只列「业界给的候选空间」,推荐留给 explainer)

> 按 Lead 要求,推荐意见放进 explainer HTML,不在 research 里下结论。这里只把每个问题「业界存在哪些做法」摆出来。

**Q1「每个新 feature 都要加 flag 吗?」的候选空间**
- (i) 默认都加(业界大团队 + 有平台时的默认);
- (ii) 默认不加,只在「要合入未完成的活 / 有风险要 kill switch / 有环境差异」时加;
- (iii) 按改动能否在一次 PR 内安全落地来分。

**Q2「在哪统一管理?」的候选空间**
- (i) 留在自建 registry,只加生命周期字段(零成本、随代码走);
- (ii) 上开源自托管(Unleash / Flipt);
- (iii) 上商业服务(LaunchDarkly)。
- 业界正典对小团队/能重新部署的场景,**倾向 (i)**(§3 那句 "source control and re-deployments is preferable")。

**Q3「什么时候开 / 关?」的候选空间**
- 开:(i) 做完验证过就开;(ii) release flag 开完即删;
- 判「该开却没开」:(i) 靠人记(我们试过,失败);(ii) 靠**使用指标**自动判(Unleash 样板);(iii) 靠**到期日 + time bomb**(Fowler 样板)。
- 关/删:(i) 到期日;(ii) 使用指标 N 天无活动;(iii) 库存上限倒逼。

---

## 11. UNKNOWN / 未能核实清单(诚实边界)

- LaunchDarkly「flag 生命周期/清理工具仅 Enterprise」+「10 seat ≈ $1200/年」——来自第三方对比文,**未在官方定价页逐字核实**。
- Unleash / Flagsmith / Flipt 的托管/企业版**具体价格**——未核实。
- Uber **Piranha**(自动删 stale flag 代码的工具)——本轮**未能拉到一手论文/博客核实**,只知其存在;若要写进方案需补查。
- Dark launch / branch by abstraction 的精确定义——本轮只做到「提及」,**未深挖**。
- 正式 ChatGPT Deep Research——**工具不可用,未跑**(见 §0)。

---

---

## 12. 【round-3 追加】动态 flag / 不重启机制(Annie 最重的痛点)

Annie round-3 核心诉求:**改一个 flag 现在整个项目要重启,不可接受。要的是 Dashboard 上改 → 运行时大家直接读到新值、不重启。**

### 12.1 先现查:我们现在到底能不能不重启改 flag(verified,不凭记忆)

读了 `packages/teamlead/src/bridge/flag-toggle.ts`(FLY-709 P2 的 apply core)。结论:

> **我们已经有一条「不重启」的路 —— 但只覆盖 10 个 flag。**

- flag-toggle.ts 的事务:`direct`-toggleable(每个 read site 都是 `call_time`、非治理门)的 flag,可以 **先写 `.env`、再原地改运行中 Bridge 的 `process.env`** → 下一次 call-time 读就是新值,**不重启**。
- toggleability 分布(实测):**`direct` 10 个(已经能不重启切)· `conversational` 51 个(要重启/不能活切)· `readonly` 22 个**。
- **为什么另外 73 个要重启**:它们是 **Bridge 启动时读**(`bridge_boot`)或**在闭包/const 里被 boot 时捕获**的 → 值在进程启动那一刻就定死了,改 `.env` 不重启不生效。

**→ 所以 Annie 要的「重写 flag 这块」,准确说是:把 flag 从「boot 时读一次/硬编码捕获」改成「每次决策点从一个运行时可改的地方读最新值」。** 这不是推倒重来,是把现有那条只覆盖 10 个的 call-time 路,扩到该动态的那些 flag 上。

### 12.2 三种「运行时动态读、不重启」的机制(给 Annie 挑)

对照 Fowler 的配置进阶(§3:config file → app DB → 分布式配置 → flag 服务),落到我们的规模:

**A. Store/DB-backed 运行时读(最轻,复用现有 Bridge)**
- flag 值存 Bridge 自己的一个 store(SQLite/StateStore 或一张小表);代码在**决策点**读 store(call-time),不在 boot 捕获。
- Dashboard(FLY-1038)写这个 store → 下次读就生效,不重启。
- 本质 = 把现有 flag-toggle.ts 的「in-proc 改 process.env」升级成「读一个持久 store」,并把 boot-read 的 flag 改成 call-time-read。
- 成本:最低(无新服务、无新依赖);要做的活是把该动态的 flag 的读法改成 call-time + 建一张 store 表 + Dashboard 接。

**B. 自托管 Unleash 服务 + SDK(最重、功能最全;Q2 她点名问)**
- 读了 Unleash SDK 机制(官方文档):SDK 把所有 flag **缓存在内存**,后台**每隔一段时间 poll** 中心服务(`refreshInterval` 默认 **15000ms**),本地评估极快;还会把最后已知状态**持久化到本地文件**,服务短暂挂了也能用最后状态继续跑。**不重启、不重部署**。自托管、云托管都支持。
- 对我们:能不重启 + 有现成 UI + 生命周期/使用指标一整套。但代价是**多跑一个服务 + 引入一个新体系** —— 对一个单用户小团队,是 §5 说的「它的多环境/团队权限/百分比放量价值我们用不上」那套 over-engineering 的风险。
- 成本:高(新服务、运维、迁移);换来的是「不用自己造生命周期/使用指标那套」。

**C. Per-project `config.yaml` + 文件监听(中等;扩已经做对的 5 个)**
- 我们那 5 个做对的 flag(qa_auto 等)已经是「每项目 config.yaml、运行时读」。给它加**文件监听(watch/mtime)**,改了 config.yaml 下次读就生效、不重启。
- Dashboard 写 config.yaml(或经 PR)→ 生效。天然每项目一份,直接接上 §6 的「FlyView 先跑通再推别项目」。
- 成本:中(扩现有 ConfigLoader + 加 watch + Dashboard 写文件/PR);不引新服务。

### 12.3 自助 toggle(Q3:Annie 要能自己在 Dashboard 按项目开关)

- **(i) Dashboard 直接写 store/config**(立即生效):最顺手,点一下就改。风险:绕过 code review、要 Dashboard 侧鉴权(我们已有 loopback+confirmToken 的 fleet 鉴权原语)。
- **(ii) PR-based / GitOps**(Dashboard 开一个改 config 的 PR,merge 才生效):Flipt 的 GitOps 模型(flag 状态存 Git、声明式 YAML)。可审计、有 history,但慢一拍(要 merge)。
- **(iii) 混合**:低风险 flag 走 (i) 立即;碰 merge/ship/治理的走 (ii) 留痕。

### 12.4 清理判定:用「用量」不是「日历时间」(Annie §6 改)

- Unleash 用的是**真实使用指标**:连续 2 天没生产使用 → cleanup、7 天 → 建议归档。
- **Annie 的修正对**:她一个人、周末不干活,「2 天没命中」≠「没用到」。→ 判定要基于**实际命中/调用信号 + 更长的窗口**,不是纯日历天数。「开着但明确没被任何代码路径命中过」才是真该清的信号。
- 我们能采到的信号:flag 的 readSite 有没有被执行(命中计数)。这比日历时间准。



- Pete Hodgson, *Feature Toggles (aka Feature Flags)* — https://martinfowler.com/articles/feature-toggles.html
- Trunk-Based Development, *Feature Flags* — https://trunkbaseddevelopment.com/feature-flags/
- Unleash, *Feature flags / lifecycle* — https://docs.getunleash.io/concepts/feature-flags 、https://www.getunleash.io/blog/feature-lifecycle-management
- LaunchDarkly — https://launchdarkly.com/pricing/ 、https://launchdarkly.com/docs/home/releases/flag-health 、https://launchdarkly.com/docs/guides/flags/technical-debt 、https://launchdarkly.com/docs/home/flags/manage/flag-cleanup-vega
- Flipt — https://www.flipt.io/ ; Flagsmith — https://github.com/Flagsmith/flagsmith ; 开源对比 — https://flagshark.com/blog/open-source-feature-flag-tools-compared-2026/
- OpenFeature (CNCF) — https://openfeature.dev/ 、https://www.cncf.io/blog/2023/12/19/openfeature-becomes-a-cncf-incubating-project/
- Knight Capital — https://en.wikipedia.org/wiki/Knight_Capital_Group 、SEC 8-K https://www.sec.gov/Archives/edgar/data/0001060749/000119312512513607/d457296dex21.htm
- 小团队实践 — https://devcycle.com/blog/feature-flagging-for-smaller-engineering-teams 、https://medium.com/@joseph.goins/why-i-use-feature-flags-even-in-small-saas-projects-9bdc025985f0
