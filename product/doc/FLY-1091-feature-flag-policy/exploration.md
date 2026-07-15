# FLY-1091 Feature flag 该怎么定 / 怎么管 — 探索

Issue: FLY-1091 (https://linear.app/geoforge3d/issue/FLY-1091/feature-flag-该怎么定-怎么管-research-设计我们的-flow小团队不-over-engineering)
日期: 2026-07-09
基于: 无(本 issue 的第一份文档)

---

## 1. Annie 的原话与三个问题

> 「现在每次 FlyView(Tadashi 那边)做事情的时候,他都很喜欢加 feature flag。但加了之后,他每次又会忘记打开。」

她要回答的三个问题:

1. 我们每次加一个新 feature,**都应该加 feature flag 吗?**
2. 如果加,**在哪里做统一管理?**
3. **什么时候该打开、什么时候该关闭?**

硬约束两条:

- **做不了灰度 / A-B testing** —— 只有 Annie 一个用户,没有流量。业界「flag 用来做实验」那条路对我们不成立。
- **团队极小** —— 设计必须回答「这么小的团队怎么做才不 over-engineering」。

---

## 2. 审计结论:issue 的起点假设需要修正

Issue 里写「我们已经有一个 registry……所以缺的多半不是 registry,而是生命周期 + 可见性 + 规矩」。

**审计发现:我们拥有的东西比 issue 假设的多得多,而缺的东西比 issue 假设的更具体。** 逐条列证据。

### 2.1 我们已经有的(全部已上线)

| 已有的东西 | 位置 | 落地 issue / 日期 |
|---|---|---|
| 集中式 flag registry(单一真相),83 个 flag | `packages/config/src/feature-flags/registry.ts` | FLY-709,2026-07-02 |
| flag 解析器(算出「当前实际生效值」) | `packages/config/src/feature-flags/resolve.ts` | FLY-709 |
| **CI drift 守卫**(代码里新增 flag 却不登记 → CI 红) | `packages/config/src/__tests__/feature-flags-drift.test.ts` | FLY-709 |
| CLI:`feature-flags report` **和 `feature-flags apply`(能真的切 flag)** | `packages/flywheel-comm/src/commands/feature-flags.ts` | FLY-709 |
| **发到 Annie 手机的 flag 状态报告 + 可勾选生成命令的交互页** | `bridge/feature-flag-report-html.ts`、`?interactive=1` | FLY-709 |
| Bridge HTTP 路由(`/api/fleet/flag-report.html`、`flag/stage`、`flag/apply`) | `bridge/plugin.ts:1168,1288,1301` | FLY-709 |
| **「做完就该打开」的成文规矩** | `packages/teamlead/lead-rules-base/default-enable-policy.md` | FLY-707,2026-06-30 |

两行是关键。

**第一,Annie 想要的那条「做完之后理论上就该把 flag 打开」的规矩,已经白纸黑字写在 Lead 规则里了**,而且写得很好——它区分了两种 flag 写法(`=== "1"` 是默认关的 opt-in;`!== "0"` 是默认开的 kill-switch),还列了「绝不可自动打开」的治理类豁免,甚至点名了三次历史事故(ponytail FLY-615、token channel、auto-QA FLY-579)。

**第二,「哪个开哪个没开根本不知道」这件事,技术上已经有解了。** `flywheel-comm feature-flags report` 会把全部 flag 的当前状态渲染成 HTML、发到 Annie 手机上;`?interactive=1` 那一版每个可切换 flag 还带勾选框,勾完自动生成 `feature-flags apply` 命令给她复制。

那为什么 Annie 还是说「根本不知道」?**因为 83 行无差别的 on/off 不是信息。** 见 §2.4。

drift 守卫这句断言是真的存在的(`feature-flags-drift.test.ts:252`):

```ts
it("no silent new gate: every scanned FLYWHEEL_* is registered or allowlisted")
```

补充一处更刺眼的债:这个 drift 守卫的**豁免名单**里躺着 FLY-927 的三个默认关的 flag,旁边写着一句注释——「等 FLY-928 部署了,考虑把这三个提升为正式注册的 founder flag」。**一个「以后记得做」的承诺,唯一的存放地点是一句代码注释。**

### 2.2 那为什么病还在?—— FLY-929 是最硬的反证

时间线(全部来自 git log,非推测):

| 日期 | 事件 |
|---|---|
| 2026-06-30 | `default-enable-policy.md` 落地(FLY-707)——「做完就要开」成为白纸黑字的规矩 |
| 2026-07-02 | flag registry + CI drift 守卫落地(FLY-709) |
| 2026-07-07 | FLY-929 提交 `0040fed7`,**commit 标题原文**:`feat(FLY-929): notify migration to Claude Infra Bot + account-switch enable surface (dormant, env-keyed)` |
| 2026-07-07 | FLY-929 又提交 `2486c694`:`register FLYWHEEL_NOTIFY_DIGEST_EXPECT in the feature-flag registry (CI drift guard)` |
| 2026-07-08 | PR #490 合并 |
| 2026-07-09 | FLY-1049 才补上 “unified **enable-window** runbook” |

读这张表:

- 规矩落地 **一周后**,FLY-929 依然在 commit 标题里**明说自己是 dormant**。
- 更刺眼的是 `2486c694`:**drift 守卫确实起作用了**——它逼着 FLY-929 把 flag 登记进 registry。登记完了,然后 flag 就一直躺在那儿关着。
- 真正打开它,靠的是**几天后另一个 issue(FLY-1049)写的一份「enable window」人工 runbook**。

> **一句话结论:我们的机器强制你「登记」flag,但没有任何东西强制你「打开」它或「删掉」它。**
> registry 是一本**没有时钟**的目录。规矩是一段**没有执行者**的散文。

(诚实补充:FLY-929 那个能力**现在已经是开着的**——`CLAUDE_INFRA_BOT_TOKEN` 和 `FLYWHEEL_NOTIFY_CHANNEL` 都已在 `~/.flywheel/.env` 里有值。它不是至今还睡着;它是**睡了大约两天,靠一次人工 ceremony 才被叫醒**。这个「merge 到 enable 之间的空窗」才是病,而不是「永远没开」。)

### 2.3 registry 里到底有什么、缺什么

跑脚本实测(`registry.ts`,2026-07-09):

- **83 个 flag**
- 按类别:`feature` 50 / `kill_switch` 27 / `governance_gate` 6
- 按极性:`default_on` 52 / `opt_in` 31
- 按可切换性:`conversational` 51 / `direct` 10 / `readonly` 22

`FeatureFlagSpec` 这个 interface 里有:`name / category / source / scope / envVar / configKey / polarity / valueKind / default / description / readSites / toggleable / directToggleProof? / dormant? / note?`。

**它里面没有的字段**(grep 过,零命中):

- `owner` —— 谁负责这个 flag
- `createdAt` / `addedIn` —— 什么时候加的
- `expiresAt` / `removeBy` —— 什么时候该删
- `issue` —— 因为哪个 issue 加的(**issue 号今天只散落在 `description` 的自由文本里**,如 "FLY-929 P-expect")
- `intent` / `stage` —— **它现在关着,是「故意关的」还是「忘了开」?**

有两个字段**接近**但不够:`dormant?: boolean`(全 registry 只用过一次,给 ponytail)和 `note?: string`(自由文本)。ponytail 那条 note 写的是「`Annie-exception`」——**这是整个 registry 里唯一一处记录了「这是故意关的」的地方,而它是一句人读的中文注释,机器读不懂。**

「flag lifecycle」和「toggle debt」在整个 `doc/` 和 `packages/` 里 **grep 零命中**。

### 2.4 最关键的发现:registry 记录了「值」,却没记录「意图」

把 22 个「布尔型、opt-in、feature 类」的 flag 拿出来,对着生产环境 `~/.flywheel/.env` 实测:

**当前全局开着的(10 个)**:`alert_threads`、`stuck_errorsig`、`pane_multiframe`、`detection_gap_scan`、`auto_repair`、`account_self_heal`、`notify_digest_expect`、`xhs_review`、`roundtable_reply_in_thread`、`roundtable_enabled`

**当前没开的(12 个)**:

| flag | 为什么没开 | 这算问题吗? |
|---|---|---|
| `ponytail` | **Annie 明确说过别开** | ❌ 不是问题 |
| `lead_dry_run` | 调试开关,本来就该关 | ❌ 不是问题 |
| `qa_auto` / `doc_flow` / `proofshot` / `xiaohongshu_learning` | per-project,某些项目开了、某些没开 | ⚠️ 要看项目 |
| `founder_image_approval` | ??? | ❓ **不知道** |
| `lead_pane_readiness` | ??? | ❓ **不知道** |
| `lead_chrome_enabled` | ??? | ❓ **不知道** |
| `lead_core_mention_gated` | ??? | ❓ **不知道** |
| `roundtable_thread_own_bot` | ??? | ❓ **不知道** |
| `runner_autocontinue` | ??? | ❓ **不知道** |

**这张表就是 Annie 的痛点本身。**

「`ponytail` 关着」和「`founder_image_approval` 关着」在 registry 里长得**一模一样**——都是 `polarity: opt_in`,都是 env 里没值。但一个是 Annie 亲口下的决定,另一个大概率是没人记得了。

那条「Annie 说别开 ponytail」的信息,今天**只存在于一份散文规则文件的一个括号里**,不在 registry 里、不在任何机器可读的地方。

**推论,而且这条推论直接决定 FLY-1038 怎么做:**

> 一个把 83 个 flag 连同 on/off 列出来的 dashboard tab,**是噪音,不是信号**。
> 因为它无法区分「故意关的」和「忘了开的」——而这正是 Annie 唯一想知道的事。
> 要让 FLY-1038 那个 tab 有用,**registry 必须先记录意图**。

这条推论有一个强证据:**上面那个「发到手机的 flag 报告」功能其实已经上线了**(§2.1)。Annie 依然说「根本不知道」。所以问题从来不是「没有地方看」,而是「看了也读不出结论」。**再做一个更漂亮的表格,不会解决这个问题。**

### 2.5 「睡着的功能」其实是四种不同的病

Annie 用了一个词「没打开」,但审计发现底下藏着**四种形状完全不同的失败**,修法也完全不同。这个区分很重要,否则会拿一把药治四种病。

| | 病 | 真实案例(全部有据) | 机器能发现吗? |
|---|---|---|---|
| **A** | **建好了、合了、忘了开** | FLY-929 notify 迁移(commit 标题自己写着 `dormant, env-keyed`,睡 2 天);FLY-696 account self-heal(`flag-gated, dormant by default`,睡 5 天);auto-QA FLY-579「上线数周,**一次都没触发过**」 | 能——只要记下「这个 flag 该开却没开」 |
| **B** | **开了,但灯泡是空的** | `founder_image_approval`,registry 原文:「v1 未接生产 evaluator,**即使 =1 也 inert**」 | 能——但要的是「flag 有没有真实生效路径」的证据,不是 on/off |
| **C** | **关着,但没人知道是故意还是忘了** | `ponytail` 是 Annie 亲口说别开(只写在 note 的中文里);`lead_chrome_enabled`、`lead_core_mention_gated`、`roundtable_thread_own_bot`、`lead_pane_readiness`、`runner_autocontinue` —— **不知道** | **今天完全不能**,因为意图没被记录 |
| **D** | **`.env` 里写着 `=1`,但进程没重启 → 还是睡着的** | **此刻正在发生**:`~/.flywheel/.env` 第 110 行原文「以下全部为 Bridge 启动时读取 → **下次重启生效**(重启由 Tadashi 批次执行)」 | 能——registry 已经存了每个 flag 的 `readTiming`,连「需重启」的徽章都渲染出来了。**数据在,没人拿它做判断** |

两处值得停一下。

**B 类**:`founder_image_approval` 是一个**已注册、已进 registry、drift 守卫也满意、但把它打开什么都不会发生**的 flag。它不是「忘了开」,是「开关装好了,灯没接线」。任何只盯着 on/off 的 dashboard 都会把它显示成一个健康的、待启用的功能。

**D 类**:这是最讽刺的一个。`.env` 里 `=1` **不等于**功能活着——很多 flag 是 Bridge 启动时读的。而 registry **早就知道**每个 flag 是不是启动时读的(`readTiming: bridge_boot`),`feature-flag-render.ts` 甚至专门渲染了一个「需重启」的标签。**能判断的数据全都有,只是没有任何东西把「你已经设了 =1」和「但进程还没重启」这两件事合起来告诉任何人。**

而 A~D 这四种状态,在今天的手机报告里**长得都一样**。

**四种病共用一个根因:registry 记录了 flag 的「值」和「读取位置」,却没记录 flag 的「意图」和「时钟」。**

### 2.6 最硬的一个数字:我们从来没有删过一个 flag

自己跑的验证(不是推测):

```bash
git log -p --follow -- packages/config/src/feature-flags/registry.ts | grep -cE '^-[[:space:]]*envVar:'
# → 0
```

**registry 诞生至今,从未有任何一个 flag 被删除过。** 一个 `name:` 行都没被删过。

同期它的增长速度:

| | 2026-07-02(registry 诞生) | 2026-07-09(今天) |
|---|---|---|
| env flag 数 | 40 | **77** |

**一周之内接近翻倍,净删除为零。** 83 个 flag = 77 个 env + 6 个项目 config key。

其他佐证:

- 全仓 1532 个 commit 里,**236 个(约 15%)** 的标题带着 flag / byte-compat / kill-switch / default-off / opt-in / dormant 这几个词之一。「加个 flag 挡一下」已经是这个仓库的**默认动作**。
- 唯一一次看起来像「退役 flag」的操作(FLY-900 退役 founder-UX 门)——**做法是又加了一个 flag 压在旧 flag 上面**。两个至今都还在 registry 里。
- 连废弃的别名都活着:`FLYWHEEL_FOUNDER_CONSENT_ENABLED` 作为「legacy alias」被写进 drift 守卫的豁免名单,而不是被删掉。

这就是业界说的 **toggle debt(旗帜债)**,而我们的债**只进不出**。

### 2.7 一个必须诚实说出口的修正

第二轮审计给了一个比「Tadashi 忘了开」更准确、也更难堪的结论:

> **这不是「忘了」,这是「制度化的推迟」。**

证据链:

- 「ship 的时候默认关着、byte-compat」是**写进流程的房规**,不是某个人的疏忽。
- 真正打开 flag,靠的是**偶发的、人工的「enable window」批处理**——FLY-707(6-30)一次,FLY-1049(7-09)又一次。而这两次 enable window,**都是因为有人恰好去审计了才发生的**。
- 更扎心的:FLY-1049 那批 flag 是 **2026-07-09 打开的——正是 Annie 抱怨的当天**。而它们**此刻依然没有生效**,因为 Bridge 还没重启。

所以 Tadashi 不是记性差。**是这个系统里根本不存在一个「该开了」的信号。** 没有信号,就只能靠人偶尔想起来去翻账本。Annie 感受到的「他总是忘」,其实是「**系统从不提醒任何人**」。

这一条直接决定了方案的形状:**不要去改进人的记性(FLY-707 已经试过写规矩,失败了),要去创造那个信号。**

---

## 3. 病的真名:merge 与 enable 之间的空窗

把 Annie 的抱怨、FLY-929 的时间线、和 registry 的缺字段合起来看,病灶是同一个:

```
代码合了  ─────空窗─────►  能力活了
   ▲                          ▲
GitHub 说 "merged"      没有任何账本记录这一刻
Linear 说 "Done"        没有任何人被提醒
```

这正是 issue 里点到的**账本诚实性**问题的一面,和另外两面同源:

- Linear 的 issue 状态撒谎(活干完了还挂 Backlog)
- Bridge 的 session 表撒谎(48 条「在跑」,真活一半)
- **GitHub 的 PR 合了但 flag 没开 → 能力睡着**

三者共同的形状:**某个账本声称的状态,和世界的真实状态,不一致,而且没有任何机制会发现这个不一致。**

所以 FLY-1091 不只是「flag 管理」。它是「让系统别对 founder 撒谎」的一环。

---

## 4. 我对三个问题的初步理解(待 research 检验,不是结论)

标注清楚:**以下是待验证的方向,不是 verdict。** research.md 的任务是拿业界实践检验/推翻它们。

### Q1「每个 feature 都要加 flag 吗?」

初步方向:**不。而且我们大概率加多了。**

业界给 flag 分四类(Fowler / Hodgson 的经典分类,待 research 核实):release / experiment / ops / permission。

- **experiment(实验)类**:对我们**直接不成立**——一个用户,没有流量,没有统计功效。这条整条砍掉。
- **permission(权限)类**:我们只有 founder 一个人,基本不需要。
- 剩下 **release(发布)** 和 **ops(运维开关)** 两类,才是我们真正会用到的。

而这两类的寿命完全不同:release flag **应该短命并被删掉**;ops kill-switch **可以长期存在**。我们现在 83 个 flag 混在一起,`feature` 50 个 / `kill_switch` 27 个——registry 已经分了类,但**寿命规则没有跟着类别走**。

**待验证的猜想**:对我们这种规模,真正需要 release flag 的情形只有一种——**改动无法在一次 PR 里安全落地**(要么太大、要么要跨仓协调、要么需要能一键回退一个高风险行为)。其余情况,直接合、直接开,才是更省事、更诚实的做法。「加个 flag 保险一点」是一种**看起来负责、实际上把风险推迟到没人记得的时刻**的行为。

### Q2「在哪里做统一管理?」

初步方向:**已经在了 —— `registry.ts`。不要新建系统,不要引入 LaunchDarkly / Unleash / Flagsmith。**

理由:那些工具的核心价值是「运行时按用户/百分比动态下发」+「多环境」+「团队权限」。我们三样都不需要。引入它们就是教科书级的 over-engineering。

**要做的是给现有 registry 加字段,而不是换一个 registry。** 具体加什么,是 research 之后、PRD 之前要和 Annie 敲定的。目前看至少要能回答:谁加的、为什么加、什么时候该开、什么时候该删、**现在关着是故意的吗**。

### Q3「什么时候开、什么时候关?」

初步方向:**「什么时候开」这个问题本身可能就问错了。**

更好的问法是:**默认就是开的,除非你能说出一个「现在必须关着」的理由,而这个理由必须写进 registry 并且带一个到期日。**

也就是把举证责任反过来:今天是「你得记得去开」(所以会忘);应该改成「关着的 flag 必须持续为自己辩护」(所以忘不了——它会自己冒出来喊)。

这和 `default-enable-policy.md` 已经写的规矩是同一个精神。**差别在于:那份文件把它写成了给人读的道德劝说,而它需要变成一条机器会执行的规则。**

至于「什么时候关」(= 删掉),业界叫 **toggle debt / 旗帜债**。我们目前**从没删过 flag**(待 research 侧的 agent 用 git log 确认)。83 个只增不减,这个数字本身就是债在累积的证据。

---

## 5. 硬约束(设计时不可违反)

1. **不做灰度、不做 A/B** —— 一个用户。任何设计里出现「百分比放量」「实验组」就是错的。
2. **不引入第三方 flag SaaS** —— 除非 research 拿出压倒性理由。
3. **不能只靠人的自觉** —— 这是 FLY-707 已经试过并且失败了的路(规矩写了,一周后照样 dormant)。新方案必须有**机器执行的那一环**。
4. **治理类 flag 有豁免** —— `founder_consent`、`founder_ux_gate` 这类「打开 = 收紧管控」的门,绝不能被「默认打开」规则自动打开。`default-enable-policy.md` 已经把这条写对了,必须继承。
5. **不 over-engineering** —— 每加一个字段、每加一道 CI 检查,都要能说清「它挡住了哪一次真实事故」。

---

## 6. 交付边界(本 issue 做什么、不做什么)

**做**:
1. `research.md` —— 业界 feature-flag 实践的调研(**不下 verdict、不写 PRD**)
2. 可交互 explainer HTML(FLY-930 nonce + 逐节留言框)→ 投本 issue thread → 与 Annie co-eval

**不做**:
- 不 ship 代码、不碰 founder-gate
- 不写 PRD(Annie 定方向之后才写)
- 不实现 dashboard tab(那是 FLY-1038)

---

## 7. 留给 Annie 的开放问题(explainer HTML 里逐节问她)

1. 上面 §2.4 那 6 个「不知道为什么关着」的 flag,你要不要现在就当场裁一遍?(这本身就是新机制的第一次演练)
2. 「关着的 flag 必须带一个到期日 + 一句理由,否则 CI 红」—— 这个力度你能接受吗?还是太狠?
3. 「删 flag」这件事,你希望它是自动提醒、还是自动开 issue、还是自动开 PR?
4. FLY-1038 那个 Feature Flag tab,你想在上面看到的**第一眼信息**是什么?是「83 个 flag 的状态」,还是「**有 3 个 flag 过期了 / 有 2 个建完没开**」?

---

## 8. 下一步

→ `research.md`:业界实践调研(toggle 四分类、toggle 债与生命周期、集中管理形态对比、trunk-based development 里 flag 的角色、**小团队/单用户该砍掉什么**)。
