# FLY-2141 Epic 残余扫描 — 探索
Issue: FLY-2141 (https://linear.app/geoforge3d/issue/FLY-2141/2108b-epic-残余扫描巡检钟上补回头看-epic-还剩什么-空位拉活)
日期: 2026-09-03
基于: 无(上游输入 = `product/doc/FLY-1969-auto-scheduling-operating-model/prd.md` v2.4 R3;已合入 main 的 FLY-2140 `fd5ac60c9` 与 FLY-2144 `4555e82bc`;Epic FLY-2108 五张子单的分工表)

> 世界标记:分支 `flywheel-FLY-2141` 基于 main `e85eec9a8`(2026-09-03)。生产 Bridge 当前 build `31da17817`:**含** FLY-2144,**不含** FLY-2140(`git merge-base --is-ancestor` 逐个核过)。本单是设计节点:不写实现代码、不派 C/D、不合并、不部署。

## 0. 本单是什么

Epic FLY-2108「Lead 拿到一份 Epic 页面之后,自己把它推到完」拆成五张子单,本单是 **B**:

| 子单 | 覆盖 PRD | 一句话 | 状态(2026-09-03) |
|---|---|---|---|
| A · FLY-2140 | R1 + R5 静态半边 | Epic 页面装什么、首版怎么生成 | ✅ 已合入 main(`fd5ac60c9`),⚠️ 未进生产 build |
| **B · FLY-2141(本单)** | **R3** | **巡检钟上补「回头看 Epic 还剩什么」+ 空位拉活** | 设计中 |
| C · FLY-2142 | R2 | 依赖账本:初始批次 + 三类动态更新 | 未开(`engineering/doc/` 无文件夹) |
| D · FLY-2143 | R5 动态半边 + R6 | 页面活化:事件+扫描双路更新,过期自报 | 未开 |
| E · FLY-2144 | R4 + R8 | 派发判断的容量输入;dag-resolver 退役 | ✅ 已合入 main 且已进生产 build |

**PRD R3 要做的事(原文)**:

```
到点扫一遍 → 这个 Epic 还剩什么没做 · 现在有没有空位 → 有空位就按 dependency 拉一件出来
```

**本单的三条硬合同**(issue 正文,逐条回读 PRD ✅):

1. **§1.2**:巡检和「放新活」共用**同一次检查**——一次扫描出一份事实,两个判断读同一份。⚠️ §8-1 她还没拍这个办法 ⇒ **实现别锁死**(下文 §5 解释「不锁死」具体指什么)。
2. **「放新活频率」是独立参数**;但今天巡检频率已可调(`interval_minutes`,project/global 两级,clamp 10–1440)⇒ **⛔ 不加新 flag**;⚠️ 无 per-需求级 ⇒ **分层调频 = 新需求(§8-3),不在本单**。
3. **⛔ 不是从零造编排系统**:patrol-tick 已在扫 session/runs/attempts/rework/land/gates,缺的只是「还没开始的那些」。

---

## 1. 先把词钉住(她的话优先)

| 她 / PRD 用的词 | 本文用 | 指什么 |
|---|---|---|
| 「回头看 Epic 还剩什么」 | **还剩什么** | 范围内没做完的子单集合,以及其中**现在就能开始**的那几张 |
| 「空位」 | **空位** | Lead 判断「还能不能再放一件」所需的读数;⚠️ **PRD §8-3 开着**:「10 个满载」那个 10 从哪来没定 ⇒ 本单**不算位子数**,只给读数 |
| 「拉一件出来」 | **拉活** | Lead 对一张 ready 子单执行 `POST /api/runs/start`(FLY-1436 合同,必带 `taskCategory`) |
| 「巡检钟」 | **巡检钟 / tick** | `patrol-tick.ts` 每个 Lead 每 `interval_minutes` 一次的 `[patrol_tick]` 邮件 |
| 「Epic 页面」 | **Epic 页面** | FLY-2140 的 `EpicPage` 文档;其 `ready_items`(规则 `ready.v1`)**已获 founder 2026-09-03 裁定** |

⛔ 本文不造新名词。代码里的字段名(`epic`、`residual`)只在 §6 的机器合同出现,不进 founder 面。

---

## 2. 已核事实(全部本单自己复核,非转述)

### 2.1 巡检钟今天怎么跳(`packages/teamlead/src/bridge/patrol-tick.ts`)

| 事实 | 位置 | 对本单的意义 |
|---|---|---|
| 60 秒 rider 上跑 `runLeadPatrolTickPass`;每个 (project, Lead) 按 **确定性相位** `patrolTickOffsetMs(leadId)` 落在自己那一分钟 | L92–113、`gate-poller.ts:139` | 「到点」已经有钟,⛔ 不加第二个 timer |
| 名册 = `getPatrolRosterSessions(project)` = status ∈ {running, ship_parked, awaiting_review, approved_to_ship, pending, design_done} 的 sessions,再按 `resolveLeadForIssue(labels)` 分给各 Lead | L186–215;`StateStore.ts:9135` | 名册里**只有已经起了 session 的 issue**——「还没开始的」结构上进不来,这就是 PRD §1 那个「真零」 |
| **`roster.length === 0` ⇒ 该 Lead 这一轮直接 `continue`,不发 tick** | L222–226 | ⚠️ 「空位最多」的时刻正是名册为空的时刻;FLY-2144 §9 把它记为「既有行为,本单不改」——**留给了 B** |
| 去重/补发靠上一条 tick 的 mailbox settlement,相位锚在墙钟网格 | L240–320 | 新增字段不动这套逻辑 |
| 容量快照 `capacityOnce()` **惰性、一个 pass 只采一次**,失败 ⇒ `undefined` ⇒ payload 无 `capacity` 键 | L176–186、L369 | 「同一 pass 内共享一份事实」的既有模式,本单照抄 |
| payload = `{event_type, execution_id, issue_id:"", project_name, roster, loops?, capacity?, generated_at, scheduled_at}` | L371–381;`hook-payload.ts:16–59` | 加一个可选键 `epic?`,缺席 ⇒ **逐字节不变** |
| 渲染 `formatPatrolTick`:首行「巡检时间到」→ 容量三行 → 🔴 摘要 → 名册 | `hook-payload.ts:878–1010` | 新块插在容量之后、名册之前 |

**生产实况(2026-09-04 03:44Z,`~/.flywheel/teamlead.db` 只读)**:24 小时内 `flywheel-eng-lead` 收 22 条、`flywheel-product-lead` 24 条 tick;最新一条 payload 键 = 上表九个;`roster` 14、`loops` 8、`capacity.runners = {running:13, parked:4}`。⇒ 钟在跳,容量已在正文里。

### 2.2 FLY-2140 已经给了什么(main `fd5ac60c9`,`packages/teamlead/src/epic-page/*` + `bridge/epic-page-route.ts` + `bridge/linear-epic-query.ts`)

| 事实 | 位置 | 对本单的意义 |
|---|---|---|
| 范围 `scope.v1` = 绑定 team 内 **state.type=started 且有子单的顶层父单**的完整子树,必含标题带「日常」的常驻父单,过滤 backlog 子单;零 active 父单 / 缺日常 ⇒ `ActiveScopeNotFoundError`(fail loud) | `linear-epic-query.ts:175–182, 246–252` | **「这个 Epic 还剩什么」的「范围」已由 founder 定(2140 plan §11.4)**,本单不重定 |
| `ready.v1` = 范围内 ∧ 非 backlog ∧ 非 completed/canceled ∧ 每条 `blocked_by` 的 blocker 都 `completed`;按 priority(0 最后)再 identifier 排序;**已获 founder 裁定** | `rules.ts:19–43`;2140 plan §11.5 | **PRD §8-2「哪些算还没做、可以往外放」在 2140 里已被她拍了** ⇒ 本单直接读 `ready_items`,⛔ 不再造第二套规则 |
| `EpicPage.generator.trigger: "manual" \| "event" \| "scan"` —— **`scan` 这个值已经预留** | `model.ts:118–121`;`StateStore.ts:1925` | 本单就是那个 `scan` 触发者 |
| 生成 = `fetchLinearActiveScopeSnapshot` + 每张子单 `readEpicItemFacts`(≤5 组 sqlite 投影)+ `generateEpicPage` + `assertEpicPage` + 写 `epic_page` **渲染回执**(只记来源与时间,⛔ 禁存 ready/排序;保留 20 版) | `epic-page-route.ts:141–170`;`StateStore.ts:9290–9330` | 一次生成 5–30 张子单约 7–40ms(2140 implementation-notes);Linear 每请求 `x-complexity`≈104,小时预算 3,000,000(2140 research §2.4) |
| 出口:`POST /api/epic-page/generate {projectName, format: json\|md\|html}`(master token);CLI `flywheel-comm epic-page show --format md`(需 `TEAMLEAD_API_TOKEN`) | `epic-page-route.ts:112–190`;`commands/epic-page.ts:100–150` | Lead 在 tick 之外自己看「还剩什么」的出口**已经存在** |
| 页面里的每条子单都带 `labels`(为 `founder-review`) | `linear-epic-query.ts:339` | 归属:`resolveLeadForIssue(projects, project, labels)` 同一把尺子可以给**还没开始的** issue 分 Lead |
| 显示标签单一来源 `labels.ts`(`section.ready` = 「现在可以开始的」) | `epic-page/labels.ts` | tick 正文用词**复用**这份标签,不另起一套词 |

### 2.3 FLY-2144 已经给了什么(main `4555e82bc`,已进生产)

| 事实 | 位置 | 对本单的意义 |
|---|---|---|
| `capacity` 三行:内存/负载/手刹/暂停/**在跑 N · 停车 M**/五账号额度;「判断输入,不是闸门」 | `hook-payload.ts:754–870`;生产正文见 §2.1 | **「现在有没有空位」的读数已经在 tick 里**;本单只需让 Lead 把它和「还剩什么」放在同一段里读 |
| Lead 规则 `department-lead-rules.md` §0「Capacity input before dispatch」:巡检轮读 tick 三行;轮外 `GET /api/capacity`;不引用超过一个巡检周期的快照 | `department-lead-rules.md:144–163` | 拉活规则的「两种时刻、两个出口」模板 |
| **明确留给 B**:「⛔ 不改 `runner-patrol-rules.md`([2108·B] 的文件;它日后把「拉活」落在巡检轮时,自然会引用这三行)」;§9「名册为空的 Lead 收不到 patrol_tick(既有行为,本单不改)…tick 出口不覆盖『空闲起步』场景」 | 2144 plan §3.7、§9 | 本单要动的 Lead 规则文件与要补的场景 |
| 渲染反注入:数值经范围校验;token 经精确 allowlist;整段退化为一行 `容量=⚠️ 账面不可读(...)`,不抛 | `hook-payload.ts` + 2144 plan B10/B11 | 新块的反注入合同**照抄**这套形状 |

### 2.4 Lead 怎么「拉一件出来」(既有,本单不改)

`POST /api/runs/start` body `{"issueId","projectName","leadId","taskCategory"}`(`department-lead-rules.md:197–235`;`runs-route.ts:1118+`)。Bridge 侧:需 `LINEAR_API_KEY`;部门范围由服务端判;同 issue 已有 active session ⇒ 409。**`taskCategory` 是 Lead 的语义判断**(code / simple_code / prd / …),不能由 Bridge 猜 ⇒ 这一条本身就否决了「Bridge 自动派单」(见 §4 选项 A)。

### 2.5 ⚠️ 一个会让整条链空转的部署事实

`~/.flywheel/projects.json` 六个项目的 `linear` 绑定**全是 `null`**(FLY-371 容忍形状,`ProjectConfig.ts:294–303`)。`epic-page-route.ts:60–63` 在 binding 缺席时返回 **404 `project_unbound`**。⇒ **FLY-2140 合入生产后,在今天的配置下一次都生成不了**;本单复用同一条读取,同样受制。生产 `epic_page` 表仍是 2140 之前的旧 schema(无 `receipt` 列),与「2140 未进 build」一致。

⇒ 这是 **ops 前置**,不是代码:flywheel 项目需要 `linear: { team: "FLY", project: "Flywheel" }`(值以 Lead 确认为准)。已作为非阻塞问题发 Lead(question `ebc08d59`,2026-09-04);本单的设计对「绑定缺席」的处置见 §6.4。

---

## 3. 问题拆成三件,并分清「事实」与「判断」

PRD R4 定了主语:**容量从闸门变成 Lead 的判断输入,由他自己拍**。同一口径套到 R3 的三步上:

| R3 的一步 | 是事实还是判断 | 谁出 | 来源 |
|---|---|---|---|
| ① 这个 Epic **还剩什么**没做 | **事实** | Bridge 在巡检那一次扫出来 | `ready.v1` + 范围计数(§2.2) |
| ② 现在**有没有空位** | 读数是事实,**「够不够」是判断** | 读数 Bridge 已给(容量三行);判断归 Lead | FLY-2144;§8-3 开着 |
| ③ 有空位就**按 dependency 拉一件** | **动作 = Lead 的判断**(选哪张、什么 taskCategory) | Lead | `POST /api/runs/start` |

⇒ **本单的新增面只有 ①**:把「还剩什么」变成巡检那一次的一份事实,和容量三行并排放进同一封 tick;②③ 由 Lead 规则说清怎么读、怎么做。这正好落在 §1.2「一次扫描出一份事实,两个判断读同一份」上:**巡检判断**(名册核对)和**放新活判断**(读 ①+② 然后决定 ③)读的是同一封 tick 里同一时刻采的东西。

---

## 4. 选项与取舍(反面照写)

| 选项 | 内容 | 判定 | 为什么 |
|---|---|---|---|
| **A · Bridge 自动派单** | 扫到 ready 且 `running < N` ⇒ Bridge 直接 `runs/start` | ⛔ **否** | PRD R4 明写「⛔ 不再要求系统自动拒绝+排队」,决定权归 Lead;`taskCategory` 是 Lead 的语义判断(§2.4);§8-3「N 从哪来」没定;失控风险(一轮拉满)不可逆 |
| **B · 单独一口「Epic 钟」** | 新 timer/新 interval 专门扫 Epic | ⛔ **否** | 违反 §1.2(两次扫描 ⇒ 两边数对不上,她点名的坏处);违反「零新定时器」纪律(FLY-169/172,2144 plan 沿用);§8-3 分层调频明确不在本单 |
| **C · 巡检 payload 加一块「还剩什么」事实** ✅ | 同一 pass 内、每个 due 的 tick 用 2140 的生成器算一次,把 `ready_items` 归属本 Lead 的子集 + 范围计数放进 `payload.epic`;渲染成几行,与容量三行相邻;Lead 规则写清怎么读、怎么拉 | ✅ **选** | 严格落在 §1.2;复用 founder 已裁的 `ready.v1`,零第二套规则;缺席 ⇒ 字节不变,回滚 = revert;两个出口(tick / `epic-page show`)与 2144 同构 |
| **D · 只改 Lead 规则** | 不动 Bridge,规则让 Lead 每轮自己跑 `epic-page show` 再决定 | ⚠️ **不选,但保留为降级说明** | 每个 Lead 各扫一次 ⇒ 与 tick 不是同一次检查(违反 §1.2);名册为空的 Lead 根本收不到 tick,也就没有「每轮」;但当 binding 缺席时,规则里必须告诉 Lead「这一格没有,去 Linear 看」——这是 D 的残留用途 |

### 4.1 选 C 之后还有三个内部取舍

| 取舍 | 选 | 弃 | 为什么 |
|---|---|---|---|
| **归属**:ready 子单按什么分给 Lead | `resolveLeadForIssue(projects, project, item.labels)`(与名册同一把尺子) | 全部 ready 都发给每个 Lead | 两个 Lead 同项目(eng/product)各自只该看到自己那份;没有 label 命中的落到第一个 Lead(`matchMethod: "general"`,既有语义),正文第三行写「归你(按 Lead 归属规则)」,没命中 label 而落到默认 Lead 的子单逐项标 `general`;默认 Lead 不能派单时它不归任何人,只进「未命中 Lead label」计数 |
| **正文里放多少** | 每 Lead 最多 5 张 ready 的 **identifier + priority**,加范围计数;超出写 `(+k more,见 epic-page show)` | 标题、验收、依赖全文 | Linear 标题是**外部自由文本**,进 Lead 提示词就是注入面;2144 的 allowlist 文法(`^[A-Za-z0-9._-]{1,64}$`)恰好容得下 issue identifier,容不下标题——这是设计,不是省事。标题去 `epic-page show`(HTML 转义在那一层已做) |
| **名册为空时** | 名册空 **但** 范围内有归他的未完成项 ⇒ 也发 tick;名册空且范围也空 ⇒ 不发;**正文首段必须写明触发原因**(「名册为空,但 Epic 范围内还有 N 件归你」) | 保持「名册空不发」 | 这是「空闲起步」唯一能收到信号的路;只多这一种情况,不会给闲置项目制造小时级噪音(范围空 ⇒ 静默;binding 缺席 ⇒ 静默)。**Lead 2026-09-04 批准(question `ebc08d59`)**,钉三条:只多这一种情况;正文写明为什么被触发(否则收件人会以为名册统计坏了);⛔ 不新增任何独立提醒/告警通道,复用现有 tick |

---

## 5. 「实现别锁死」具体指什么(§8-1 她还没拍)

§8-1 = 「一次扫描出一份事实,两个判断各读各的」这个**办法**她没拍。她若日后否掉,最可能的形状是「放新活要单独一口钟 / 单独一次检查」。为让那一天不用重写,本单守四条:

1. **事实块与判断分离**:`payload.epic` 只装事实(计数、ready 子集、观测时间、来源),⛔ 不装「建议拉 X」「空位 N 个」这类判断词。渲染文本零判断词(沿用 2144 B10 的禁词表)。
2. **生成器不认识巡检**:项目级的 materialize(取 Linear 快照 → 读账本 → 生成 Epic 页面文档)不认识 Lead、不认识 tick;Lead 级的 summarize 只收「那份文档 + 我是哪个 Lead + 这轮为什么被触发」这三样切片上下文,返回摘要;`patrol-tick.ts` 只是它们的一个调用者。第二个出口 `epic-page show` 与它共享的是 materialize/生成器那一层(见 research §3)。⇒ 将来若要「单独一口钟」,只是再加一个调用者。
3. **不写任何 Bridge 侧的「上次拉活时间 / 拉活间隔」状态**。放新活频率今天 = 巡检频率(§8-3);Lead 侧的节奏靠 Lead 自己判,不在 Bridge 落账。
4. **payload 键可选、缺席字节不变**:关掉它 = 不注入 deps,或 revert;不需要 flag。

---

## 6. 设计轮廓(细节在 research.md)

### 6.1 一封 tick 变成什么样(示意,⚠️ 数字是编的)

```
[patrol_tick] 巡检时间到。
容量(Bridge 采样 · 判断输入,不是闸门;快照 2026-09-04T03:44:37.175Z):
- 内存 free 59%(memory_pressure,参考线<15%)| 负载 …| 在跑 13 · 停车 4
- 额度 …
还剩什么(Bridge 按 Linear 扫 · 规则 ready.v1 已获 founder 裁定 · 判断输入,不是派单;Linear 观测 2026-09-04T03:44:36.020Z;生成 2026-09-04T03:44:37.401Z;范围=3 个 active 父单):
- 范围内 27 张未完成:现在可以开始的 6(已剔除账面在跑)· 等前置的 12 · 账面在跑的 9 · 未命中 Lead label 0
- 现在可以开始且归你(按 Lead 归属规则)5 张:FLY-2142(P2) FLY-2143(P2) FLY-2310(P3) FLY-2311(P3) FLY-2299(P4,general)(+1 more,见 flywheel-comm epic-page show --format md)
按 Bridge 的账,你名下有 14 个未终结 runner(此名册是待核声明,不是结论):
…
```

三行事实,零判断词。「空位」不出现在 Bridge 正文里——它是 Lead 读「在跑 13 · 停车 4」+「现在可以开始的 6」之后自己下的判断(§3)。

名册为空而被触发时,首行之后多一行说明触发原因(Lead 裁定,§11):

```
[patrol_tick] 巡检时间到。
(本轮由 Epic 范围触发:你名下账面没有未终结 runner,但范围内还有 5 件归你。)
容量(…)
还剩什么(…)
按 Bridge 的账,你名下有 0 个未终结 runner(此名册是待核声明,不是结论):
```

### 6.2 机器合同(`payload.epic`,可选键)

```
epic?: {
  schemaVersion: 1;
  generatedAt: ISO;            // 生成器 now
  linearObservedAt: ISO;       // snapshot.fetchedAt
  roots: number;               // active 父单数
  remaining: number;           // 范围内 state.type ∉ {completed, canceled}
  ready: number;               // ready_items.length(全项目)
  blocked: number;             // remaining − ready − running
  running: number;             // ledger_live_count > 0 的子单数(账面)
  readyForLead: Array<{ identifier: string; priority: number; ownership: "label" | "general" }>;  // 归本 Lead,≤5,顺序 = ready_items 顺序
  readyForLeadTotal: number;
  remainingForLead: number;    // 归本 Lead 的未完成数(名册空触发的判据)
  generalCount: number;        // 没命中任何已配置 Lead label 的未完成数
  rule: "ready.v1";
  trigger: "roster" | "scope";
  kind: "available";
}
// 或 { kind: "unavailable"; token: <精确 allowlist 单个 token,见 research §3>; trigger; generatedAt: ISO | null; linearObservedAt: ISO | null }
```

`kind: "unavailable"` 时没有任何计数字段;两个时间只在「失败发生在生成之后」时才有真值,⛔ 不用当前时刻冒充 Linear 观测时间(与 capacity 同一 fail-soft 精神,形状按 Codex R2 收紧为判别联合)。

### 6.3 一个 pass 里发生什么(新增部分加粗)

```mermaid
flowchart TD
  A[60s rider: runLeadPatrolTickPass] --> B[project 循环:名册 + interval]
  B --> C{Lead 循环:到点了吗}
  C -- 没到 --> Z[continue]
  C -- 到点 --> D{名册非空?}
  D -- 是 --> E[采容量 capacityOnce]
  D -- 否 --> F[**算还剩什么 epicOnce(project)**]
  F --> G{**归本 Lead 的 remaining>0?**}
  G -- 否 --> Z2[**记 slot 已看过,不发**]
  G -- 是 --> E
  E --> H[**算还剩什么 epicOnce(project)(若尚未算)**]
  H --> I[组 payload:roster · loops · capacity · **epic**]
  I --> J[appendLeadEvent + enqueue]
  J --> K[Lead 邮箱:formatPatrolTick 渲染]
  K --> L{Lead 判断:读『现在可以开始的』+『在跑/停车』}
  L -- 有位且有活 --> M[Lead: POST /api/runs/start 一张]
  L -- 否 --> N[Lead: 巡检其余步骤照旧]
```

`epicOnce(project)` 与 `capacityOnce()` 同构:一个 pass 内每个项目最多算一次;失败 ⇒ `unavailable`,⛔ 不进 Lead failure 路径、不阻断 tick。

### 6.4 失败与缺席矩阵

| 情形 | `payload.epic` | tick 正文 | 备注 |
|---|---|---|---|
| 项目 `linear` 绑定缺席/null | **键缺席** | **逐字节不变** | 启动时每项目 `console.warn` 一行;不 fail Bridge;§2.5 的 ops 前置 |
| Bridge 无 `linearApiKey` | 键缺席 | 字节不变 | 同上 |
| Linear 超时/5xx(`LinearUpstreamError`) | `kind:"unavailable"`,`token:"transient: linear_unavailable"`,两个时间 `null` | 一行 `还剩什么=?(transient: linear_unavailable)` | 不重试(下一轮自然再扫) |
| 零 active 父单 / 缺日常筐(`ActiveScopeNotFoundError`) | `kind:"unavailable"`,`token:"structural: active_scope_not_found"` | 一行 `?` | 对没有 Epic 的项目这是**常态**;名册空 ⇒ 不发 tick |
| 范围 >500 / 分页截断 | `kind:"unavailable"`,`token:"structural: scope_too_large"` / `"structural: scope_snapshot_truncated"` | 一行 `?` | 与 2140 route 的 422 同源 |
| 某未完成子单的 `session` 格读失败 | `kind:"unavailable"`,`token:"transient: session_ledger_unreadable"`,两个时间保留真值 | 一行 `?` | 读不到「它是否在跑」就说不出「已剔除账面在跑」,⛔ 不把未知当空闲(Codex R1 HIGH-2 后收紧);其它五格读失败不影响 |
| 生成器抛(schema 断言失败) | `kind:"unavailable"`,`token:"structural: epic_page_invalid"` | 一行 `?` | fail-soft,记 log |
| 渲染收到非法 shape / 非 allowlist token | 整段退化为**固定常量**一行 `还剩什么=⚠️ 账面不可读(invalid_epic_residual)`,无触发说明行 | 一行 | 与 2144 B11 同形;⛔ 不透传任何输入值 |

### 6.5 写不写 `epic_page` 回执

**写**,`trigger: "scan"`。理由:回执表的唯一用途是给 D(FLY-2143)留「这张页面多旧」的地基(2140 plan §11.5);每次巡检扫描落一条 `scan` 回执,D 拿到的正是「上一次扫描什么时候」。它是既有写路径的既有副作用(route 每次生成也写),⛔ 不新增表、不存计算结果(回执守卫 `COMPUTED_ORDER_FIELD` 会拒)。保留 20 版的既有裁剪足够(24 tick/天 × 2 Lead ⇒ 每项目每 pass 一条,一天 ~24 条)。

⚠️ 若 Lead 认为「D 还没开工,B 不该替它落地基」,退回「不写回执」只删一行调用,不改结构。

---

## 7. Lead 规则怎么改(文本合同,细节在 research §7)

- **文件**:`packages/teamlead/lead-rules-base/runner-patrol-rules.md`(2144 明确留给 B)新增小节「**§0.x 回头看 Epic 还剩什么,有位就拉一件(FLY-2141)**」;`department-lead-rules.md` §0 容量小节**加一句交叉引用**,不复制正文。
- **内容四条**(与 2144 §0 同构):
  1. 两种时刻、两个出口:巡检轮读 tick 里「还剩什么」三行(那一轮扫的);轮外或该格 `?` 时 `flywheel-comm epic-page show --format md`(同一生成器的另一次采样,各带时间,⛔ 不自称同一份)。
  2. 拉活是 Lead 的动作:读「现在可以开始且归你」+ 容量三行,自己拍拉几张;拉 = `POST /api/runs/start`,`taskCategory` 按 FLY-1436 自己判;`409` = 已有人在跑,不是错。
  3. 这三行是 Bridge 按 Linear 扫的读数(不是转述),核验 = 看两个时间戳新鲜度;⛔ 不引用超过一个巡检周期的读数;`?` 的格不得当事实。
  4. tick 仍是纯闹钟;「还剩什么」不替代任何一步 runner 核验;巡检报告的六个 STEP + STEP DWELL 合同不变(⛔ 不改 `lead-patrol-snapshot.sh`)。
- **合同测试**:与 `fly2144-capacity-rule.test.ts` 同形——用真实 bundle 装配断言锚句在 dept bundle、不在 cos bundle。

---

## 8. 与兄弟单的关系(谁依赖谁)

| 单 | 关系 | 说明 |
|---|---|---|
| A · 2140 | **本单依赖它**(已合入) | 复用 `fetchLinearActiveScopeSnapshot`、`generateEpicPage`、`ready.v1`、`labels.ts`、回执写入;⛔ 不改 `epic-page/*` 的规则与模型 |
| E · 2144 | **本单依赖它**(已合入) | 容量三行是「空位」读数;渲染/反注入/规则文本全部同构;它明确把 `runner-patrol-rules.md` 与「名册为空」场景留给本单 |
| C · 2142 | **无代码依赖** | 2140 §11.4 定了 Linear `blocked_by` 是唯一持久化的先后关系;C 的三类更新若落在 Linear relation 上,本单的扫描**自动**读到;若 C 另建账本,C 需改 `ready.v1` 的输入,本单不预留接口 |
| D · 2143 | **本单给 D 留地基** | 每次扫描落 `scan` 回执(§6.5);D 的「扫描路」= 读本单已在跳的 tick;D 的「事件路」与本单无关 |

---

## 9. 非目标(⛔ 逐条)

- 不自动派单、不排队、不算「位子数」(§8-3 开着);
- 不加 flag、不加 timer、不加 config 键、不加 `flywheel-comm` 子命令、不加 HTTP 路由;
- 不改 `ready.v1` / `scope.v1` / `EpicPage` 模型 / `epic_page` 表结构;
- 不改 `lead-patrol-snapshot.sh` 与六个 STEP 报告合同;
- 不改 `tryAdmit()` / `runs/start` 准入;
- 不做多项目 quota 统管(PRD §6);不做分层调频(§8-3);
- 不改 `~/.flywheel/projects.json`(ops 前置,列清单,由 Lead 执行);
- 不把 Linear 标题/正文渲染进 tick(注入面)。

---

## 10. Founder 决策点(进 HTML;⛔ 不阻塞实施)

| # | 问题(用她的话) | 本单的默认 | 若她反对 |
|---|---|---|---|
| 1 | **§8-1**「一次扫描出一份事实,两个判断各读各的」这个办法,你认不认? | 认(Lead 2026-08-28 已定);本单按它做,并按 §5 四条不锁死 | 拆成两口钟 = 再加一个调用者,不重写 |
| 2 | **§8-3** 怎么算「位子空出来了」?tick 里给的是「在跑 13 · 停车 4」和「现在可以开始 6」,**多少算满由 Lead 自己判**,可以吗? | 可以;不写死 N | 若她要一个 N:那是 Lead 规则里的一句话,或 E 的后续,不是本单代码 |
| 3 | 名册为空的 Lead,只要 Epic 里还有归他的活,**要不要也收到这封巡检邮件**? | 要(否则空闲起步永远没信号) | 退回既有行为,Lead 规则改写为「自己去看」 |
| 4 | 正文只给 issue 号和优先级,**标题不进邮件**(标题去页面看),可以吗? | 可以(注入面) | 加标题需先过一道转义+长度合同,是新的反注入面 |

## 11. Lead 裁定(question `ebc08d59`,2026-09-04,已答)

| 项 | Lead 裁定(要点转述,非逐字) | 落点 |
|---|---|---|
| 生产 `linear` 绑定全 null | Lead 核实为真:「造好了但从没通电」。**补绑定是 ops 动作,归 Lead**,并要验证真的生效;本单写进 plan 前置清单,⛔ 不替 Lead 改 `projects.json` | plan §rollout |
| (1) 绑定缺席时的行为 | **按本单设计**:tick 正文逐字节不变 + Bridge 启动时每项目告警**一行**、**不 fail**。三个限定都不放宽;⛔ 不许变成每 tick 都喊(那是新增告警层,禁) | §6.4;research §5 |
| (2) 名册空但范围有活 ⇒ 也发 tick | **批准**;只多这一种情况;正文必须写明触发原因;⛔ 不新增独立提醒/告警通道 | §4.1;§6.1;research §6 |

Lead 采纳的论证:「空位最多恰恰是名册为空的时候」—— 既有行为在这一点上是反的。
