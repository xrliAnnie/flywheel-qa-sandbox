# FLY-2140 Epic 页面内容模型与首版生成 — 探索
Issue: FLY-2140 (https://linear.app/geoforge3d/issue/FLY-2140/2108a-epic-页面内容模型-首版生成每格带出处与时间戳)
日期: 2026-09-02
基于: 无(上游输入 = `product/doc/FLY-1969-auto-scheduling-operating-model/prd.md` v2.4,commit `2ad4cc491`;Epic FLY-2108 及其五张子单;Lead 2026-09-03 02:37Z 对本单三条取舍的裁定)

> 世界标记:[main] = 本分支 `flywheel-FLY-2140` 头 `63154c214` = `origin/main`,工作区干净;[prd] = prd.md v2.4 @ `2ad4cc491`;[linear] = Linear API 直读,as-of **2026-09-03T02:37:07Z**(本单亲手用 `LINEAR_API_KEY` 查的,不是转述)。
> 成色:✅ = 本单亲手核过原件(文件+行号或命令输出);📖 = 引自上游文档、未复核;⬜ = 未知,进 research 或留白;🔶 = 本单的建议/默认值,可被推翻。

---

## 0. 本单是什么

Epic FLY-2108「Lead 拿到一份 Epic 页面之后,自己把它推到完」被拆成五张子单,本单是 **A**:

| 子单 | 覆盖 PRD | 一句话 |
|---|---|---|
| **A · FLY-2140(本单)** | **R1 + R5 的静态半边** | 定义 Epic 页面**装什么**(内容模型),并从拆完的 Epic **生成首版** |
| B · FLY-2141 | R3 | 巡检钟上补「回头看 Epic 还剩什么」+ 空位拉活 |
| C · FLY-2142 | R2 | 依赖账本:初始批次 + 三类动态更新(减法不许丢) |
| D · FLY-2143 | R5 动态半边 + R6 | 页面活化:事件+扫描双路更新,过期自报;卡住上页可见 |
| E · FLY-2144 | R4 + R8 | 派发判断的容量输入;附 dag-resolver 退役 |

**本单必须回答的四件(R1,prd.md L200-205 ✅)**:要做的事有哪些 / 它们的先后(批次)/ 每件做完算什么样 / 这个 Epic 里她点过名必须回来找她的那几件。

**本单的静态约束(R5,prd.md L299-305 ✅)**:每一格都有出处(⛔ 不许有只存在于页面里的事实)+ 每格能说出自己是什么时候的。

**验收(R1 判据,prd.md L189-191 ✅,可证伪)**:页面建好后,Lead 不问「现在该做哪件」能连续推进到整个 Epic 做完;中途还要问 = 不合格。

**硬边界**:⛔ 不写死谁要用谁不用(prd.md L170);⛔ 不加新 flag(L176);通用主语 = 任意 Lead + 任意 Epic 页面(L70)。本单是设计节点:不写实现代码、不派 B–E、不合并、不部署。

---

## 1. 先把「页面」这个词钉住

她的原话(prd.md L185):「我们只要**定义好这个 epic 的 HTML**,然后告诉 lead 去 follow 这个 epic HTML,他就知道该怎么做。」
她另一句(prd.md L457):Epic 页面和活的状态页「**我猜是一个东西**」。

⇒ **一份页面,两个读者**:Lead 读它决定下一步(机器可读要够用),她读它一眼看进展(HTML 要够直观)。
⇒ 两个读者读的必须是**同一份文档的两种渲染**,不是两份各自维护的东西 —— 否则就是她点名的那个坏处(prd.md L294「multiple sources of truth」)。

本单把这份文档叫 **EpicPage 文档**(机器形态,JSON),它的两种渲染叫 **Lead 视图**(Markdown/JSON,给 Lead 的 CLI)与 **founder 视图**(HTML)。三者共用一套字段与显示标签(§4)。

---

## 2. 已核事实

### 2.1 PRD 里直接约束本单的句子(原文指针,✅ 逐条回读过)

| 约束 | 出处 | 对本单的含义 |
|---|---|---|
| 四件必答 + 「不回答会怎样」 | prd.md L200-205 | 四件事 = 内容模型的四个必填面;每一面缺了都要**显式**缺,不许静默省略 |
| 「哪些是必须回来找她的」⛔ 不是通用规则,是**这一份页面的内容** | L207-208 | 它是每个 Epic 自己的一组条目,来源必须在 Epic 里,不是写在代码里的判断 |
| 每一格都有出处;过期要说出来;两条更新路径都要在 | L301-305 | 前两条本单落;第三条归 D |
| ⛔ 本节不写页面用什么技术做、数据怎么存 | L307 | 技术与存储是**本单**的判断(Epic 描述也写明「PRD 故意没写死,由 Tadashi 判」) |
| R1 定页面里写什么,R5 定页面凭什么不过期,同一份页面 | L309 | 内容模型与出处/时间戳是**同一张表的列**,不是两个模块 |
| 没有读者的存储,损坏在结构上不可能被发现 ⇒ 页面必须能说出自己多旧 | L426 | 每格带 `observed_at`;页头带 `generated_at` |
| §8 三条开放问题 ⛔ 都不许被当成已定 | L442-446 | 其中 **§8-2「哪些算还没做、可以往外放」** 与 **§8-3「怎么算一件事做完了」** 直接碰到本单的两个推导格 ⇒ 这两格必须以**带编号的默认规则**出现,页面上写明规则号,⛔ 不得伪装成已定义 |
| 她立的常设要求:每一节都要能就地留言 | decisions.md L638-647 | 只约束本单交给她看的**设计 HTML**;Epic 页面 founder 视图 v1 是只读快照(D 再谈) |

### 2.2 Epic FLY-2108 的现状([linear] ✅)

| 事实 | 值 |
|---|---|
| 子单 | 5 张(A–E),状态全部 `backlog`,标签只有 `Flywheel`,priority 全为 0(未设) |
| 依赖关系 | **第一次抓取(02:2x Z)五张子单零 `relations`**,D「依赖 A + B」只写在正文里;本单向 Lead 提出后,Lead 于 **02:35:24–02:35:38Z** 在 Linear 登记:2140 blocks 2141/2142/2143,2141 blocks 2143,2142 blocks 2143 |
| 由此推出的批次(见 §3.2 规则) | 第 1 批:A(2140)、E(2144);第 2 批:B(2141)、C(2142);第 3 批:D(2143) |
| 团队标签集 | FLY 团队 25 个标签里**没有**任何「找 founder」语义的标签(`*`, `Flywheel`, `claude`, `codex`, `qa`, `docs`…) |

📌 「第一次零关系、第二次有关系」这个过程本身就是本单最重要的一条证据:**依赖真实存在于人的脑子和正文里,而不在结构化字段里,是常态**。页面若从正文推断依赖,就是在制造「只存在于页面里的事实」;页面如实显示「未登记」,人才会去把它登记到唯一真相里。Lead 裁定同意(§8)。

### 2.3 Linear 的 blocks 关系方向(✅ 用真数据核过,这条决定批次算得对不对)

对「A blocks B」,Linear API 给出:
- `A.relations` 含 `{type:"blocks", relatedIssue:B}`;
- `B.inverseRelations` 含 `{type:"blocks", issue:A}`。

实测 FLY-2143:`inverseRelations` = blocks ← 2140 / 2141 / 2142 ⇒ **「谁挡着我」要读 `inverseRelations`**。

代码里两种读法并存:
- `packages/edge-worker/src/PromptBuilder.ts:1313-1360` `fetchBlockingIssues()` 读 `inverseRelations` ✅ 与 API 语义一致;
- `packages/dag-resolver/src/LinearGraphBuilder.ts:32-36` 把 `relations` 里 type=blocks 的 `relatedIssue` 当 `blockedBy` ⚠️ **方向是反的**(它拿到的是「我挡着谁」)。dag-resolver 已由 E(R8)排定退役,本单**不修它、不复用它**,只记这条以免实现时抄错。

### 2.4 代码里「Epic」今天是什么都没有(✅)

`grep -rli epic packages --include='*.ts'`(排除 node_modules/dist/测试)= **0 命中,整个 packages 树**(PRD §1 只量了 `bridge/`,本单扩到全树,结论相同)。⇒ 内容模型、生成器、存储、渲染、CLI 全部是新增面;但**它们读的每一个事实源都已经存在**(下表)。

### 2.5 能当出处的事实源(✅ 逐个核过表结构/函数)

| 事实源 | 在哪 | 能给页面什么 | 自带时间戳 |
|---|---|---|---|
| Linear Epic + 子单 | Bridge 持有 `LINEAR_API_KEY`(`plugin.ts:3339-3396`),`bridge/linear-query.ts` 有 GraphQL 直查但**不含 children/relations** | 标题、描述、状态(name/type)、URL、priority、labels、parent/children、blocks 关系 | `updatedAt`(issue 与 relation 各自有) |
| `sessions`(StateStore) | `StateStore.ts` 建表 | 该 issue 最近一个执行体:status、session_role、branch、worktree、last_error、workflow_node_id | `started_at` / `last_activity_at` / `terminal_at` |
| `workflow_run` / `workflow_run_node` | 同上 | 活跃 run(active/held)、current_node_id、template id/rev、节点 attempt 状态、execution_id | `created_at` / `started_at` / `ended_at` |
| `workflow_gate_holder` / `workflow_carrier_delivery` | 同上(`listOpenGateAuthorities`) | 开着的门 | 行内 |
| `land_operation` | 同上 | PR 号、落地状态、当前步 | 行内 |
| `linear_state_observations` | 同上 | Bridge 上次观察到的 Linear 状态 | `observed_at` |
| 节点显示标签 | `workflow-display-labels.ts` `workflowNodeDisplayLabel(templateId,node)` | 「设计(工程)/实现/QA 验证」等中文标签,**唯一来源**,本单不另造 | — |

### 2.6 页面能放哪(✅)

| 载体 | 事实 | 判 |
|---|---|---|
| 托管报告(`publish-report` → `/api/reports/publish`) | **create-only**,每次发布铸新的不可猜 URL;**7 天过期**(`DEFAULT_RETENTION_MAX_AGE_MS`);512KB 上限;每次发布全集重部署 | 只能做**快照**,做不了「活页面」 |
| 项目仓库文件 | 仓库铁律:不直接 push main,一切走 PR | 每次更新都要一个 PR ⇒ 活页面不可行;但**本单交给她看的设计 HTML**仍按 DOC-FLOW 进仓库 |
| Bridge StateStore(`~/.flywheel/teamlead.db`,native better-sqlite3 + WAL,`save()` 已是 no-op —— FLY-663 注释 ✅ `StateStore.ts:328-346,2408-2415`) | Bridge 已是所有执行事实的持有者;新表是 additive;写入在 `db.transaction()` 内即持久 | **权威副本放这里**;Bridge 出 JSON/HTML;D 的事件/扫描更新也在这里落 |
| Bridge HTTP 路由 | `/api/runs` 用 `tokenAuthMiddleware(config.apiToken, geminiAgentToken)`(`plugin.ts:4213-4222`);报告路由分 master/ingest 两层凭据 | 新路由沿用 master token 中间件;loopback,founder 打不开 ⇒ founder 视图靠快照 |

### 2.7 HTML 生成的既有做法(✅)

- 转义:`bridge/xhs-review-html.ts:24` 导出 `escapeHtml()`(5 个危险字符);`feature-flag-report-html.ts` 是服务端拼 HTML 的既有样板。
- 托管页 CSP:`report-registry.ts` 注入 `default-src 'none'`,只有 `<script nonce="__CSP_NONCE__">` 才放行脚本。Epic 页面 founder 视图 v1 **不需要脚本**(只读),不用 nonce。
- 样式:`~/.claude/rules/html-report-style.md` 的 Apple-light。

---

## 3. 四件事各从哪来(本单的核心判断)

每一件都用同一把尺子量:**这个事实如果不在页面上,它还在哪?** 答不出来 = 只存在于页面里 = ⛔。

### 3.1 要做的事有哪些

| 候选来源 | 判 |
|---|---|
| Linear:Epic 的 `children`(排除 archived) | ✅ **唯一来源**。子单就是「要做的事」;新加一张子单 = 多一件事;取消一张 = 「不需要做的」(R2 的减法)自动体现 |
| Epic 描述正文里的列表 | ⛔ 正文是给人读的;从正文抽条目 = 页面自造事实 |
| PRD 的 R1–R8 表 | ⛔ 那是 FLY-1969 这一个 Epic 的特例;通用主语不能依赖它 |

页面显示:每张子单一行(标识、标题、Linear 状态、URL),另加「不做了」分组(state.type = canceled);已归档的子单不读也不计数,页头写明「不含已归档」。嵌套的孙单 v1 不展开,只显示 `child_count`(诚实边界)。

### 3.2 它们的先后(批次)

| 候选来源 | 判 |
|---|---|
| Linear 子单之间的 **blocks** 关系 | ✅ **v1 唯一来源**(Lead 已裁)。既有模型(PromptBuilder 就在读它),Lead 本来就在 Linear 上拆单;删掉一条关系 = 依赖减法,天然满足 R2「减法不许丢」 |
| Linear `sortOrder` / `priority` | 只做**同批内**排序,不当依赖 |
| 正文里的「依赖:[2108·A] + [2108·B]」 | ⛔ 不解析(§2.2 的教训);页面显示「0 条依赖登记」让人去登记 |
| C 单的依赖账本 | 🔶 C 若另建账本,页面把该格的 `provenance.kind` 换成账本即可;**内容模型不变**。本单不替 C 定账本长什么样 |

**批次规则 `batch.v1`(🔶 默认规则,页面上写明规则号)**:
- 只看 Epic 内部兄弟之间的 blocks;Epic 外部的阻塞单单独列在「Epic 外的前置」格里,并参与「能不能开始」的判断;
- `state.type ∈ {completed, canceled}` 的阻塞者视为已解除(取消 = 不需要做 = 减法);
- 批次号 = 0 条未解除的兄弟阻塞 ⇒ 第 1 批;否则 = 1 + max(阻塞者批次);
- 出现环 ⇒ 该格 `missing`,原因写出环上的单号(⛔ 不猜一个顺序);
- 同批内按 priority(1 紧急 → 4 低;0 未设排最后)再按单号。

对 FLY-2108 实算(§2.2):A、E 第 1 批;B、C 第 2 批;D 第 3 批。**A 做完之前 B/C 不能开始**这一点现在是 Linear 里的事实,不是本单文档里的事实。

### 3.3 每件做完算什么样

| 候选来源 | 判 |
|---|---|
| Linear 状态 `state.type = completed` | ✅ **「做完」的事实来源**。Flywheel 的终态链(land → Linear Done)已在跑,页面只读结果 |
| 子单描述里的验收段 | ✅ **原文引用**,只认标题匹配 `验收 / Acceptance / Definition of Done / DoD` 的那一节,逐字引、带 `updatedAt`;没有这一节 ⇒ 该格显式 `missing: no_acceptance_section`(这正是「他不知道什么时候可以往下一件走」的提前告警) |
| 页面自己总结一句「做完 = …」 | ⛔ 自造事实 |
| 「位子空出来了怎么算」 | ⛔ 不碰 —— 那是 prd.md §8-3 与 E 单的容量输入 |

规则号 `done.v1`。页面上这一格的标题固定为「做完算什么样」,值 = Linear 状态 + 验收原文(或显式缺)。

### 3.4 她点过名必须回来找她的那几件

| 候选来源 | 判 |
|---|---|
| 子单上的 Linear 标签 `founder-review` | ✅ **v1 唯一来源**(Lead 已裁)。结构化、可查、Lead 一次性建标签;通用主语成立(任意 Lead 给任意 Epic 的子单打标签) |
| Epic 描述里某个固定小节 | ⛔ 解析正文;且两套机制 = 镜像词汇 |
| PRD §8 那三条开放问题 | 它们不是 issue ⇒ Lead 若要它们上页,建成带标签的子单(Lead 已裁);页面不去读 PRD |
| workflow 模板里的 `founder_review` 门 | 那是「流程会走到她面前」的机制,不是「这个 Epic 里她点过名的事」;⛔ 不混 |

规则号 `founder.v1`。**标签不存在或零命中时,页面必须明示「0 件」,不隐藏这一格**(Lead 的硬约束)。标签由 Lead 创建并写进 plan 的运维说明,⛔ 不做成配置开关。

### 3.5 页面还应该回答但 PRD 没单列的一格:「现在可以开始的」

R1 验收说的是「不问现在该做哪件」。四件事齐了,Lead 仍要自己把它们拼成「所以现在做哪件」。这一步能确定地推出来,就应该由页面推,并**标明是推导**:

规则 `next.v1`(🔶,页面写明「§8-2 未定,本规则是默认值」):`state.type ∈ {backlog, unstarted, triage}` ∧ 所有阻塞者(兄弟 + Epic 外)已解除 ∧ 没有非终态执行体(sessions)⇒ 进入「现在可以开始的」,按批次、priority、单号排序。

它是 **derived 格**:出处 = 它读的那些格的路径 + 规则号。B 单(空位拉活)读这一格再叠加容量判断;本单不做拉活。

---

## 4. R5 静态约束怎么落:「格」(Cell)模型

页面上**每一个值**都是一个格:

```
Cell<T> = {
  value: T | null,
  provenance: Provenance,      // 从哪来
  observed_at: ISO-8601,       // 我们什么时候读到它
  source_updated_at?: ISO,     // 来源自己说它什么时候变的(Linear updatedAt / StateStore 行时间)
  missing?: { reason: string } // 没值时必须说为什么;⛔ 不许静默省略这一格
}
Provenance =
  | { kind: "linear",     entity: "issue"|"relation"|"label"|"children", id, field?, url? }
  | { kind: "statestore", table, key }
  | { kind: "derived",    rule: "batch.v1"|"next.v1"|"founder.v1"|"done.v1", from: string[] }  // from = 文档内格路径
```

- 页头 `generated_at` + `generator.version` + `trigger`(v1 只有 `manual`;`event`/`scan` 留给 D);
- 「说不出自己多旧」在结构上不可能:没有 `observed_at` 的格通不过 schema 守卫(plan 里是一条测试);
- 「过期自报」(D)= 用 `observed_at` 与当前时间算年龄,本单只保证每格都有可算的时间。

**为什么不用 Linear 的 `updatedAt` 代替 `observed_at`**:两者回答不同问题 —— 前者是「这件事上次变是什么时候」,后者是「我们上次看它是什么时候」。她要的是后者(prd.md L302「我这一格是什么时候的」)。两个都留。

---

## 5. 页面放哪、长什么样:三个选项与取舍

| 选项 | 好处 | 代价 | 判 |
|---|---|---|---|
| **A 仓库文件**(`engineering/doc/<epic>/epic.md`) | git 历史 = 免费版本与出处;随项目走 | 每次更新一个 PR;Bridge 往项目仓写文件是新一类副作用;D 的事件更新无处落 | ⛔ 作为活页面否决;设计 HTML 仍进仓库 |
| **B StateStore 新表 + Bridge 出 JSON/HTML**(生成即存一版) | Bridge 已持有全部执行事实与 Linear 钥匙;additive 表;D 的双路更新就是「再生成一版」;快照可随时 publish | 页面是事实的**投影副本** —— 这正是她点名的坏处,靠 §4 的格模型正面回答(每格出处 + 时间) | ✅ **采纳**(Lead 2026-09-03 已裁) |
| **C 只按需计算、不存** | 没有第二副本 | 来源不可达时说不出「上次是什么」;没有历史;D 的「更新」没有对象;给她看的快照仍要物化 | ⛔ 单独否决;但**生成本身是按需的**,B 已包含它 |

**采纳形态**:`epic_page` 表(project, epic 唯一标识, version 单调, generated_at, trigger, document JSON, digest),保留每 Epic 最近 N 版;Bridge 路由 `POST /api/epic-page/generate`、`GET /api/epic-page/:project/:epic`(JSON)、`…/html`;flywheel-comm 子命令 `epic-page generate|show|render`。细节进 research/plan。

**通用主语**:生成器只收 `(projectName, epicIdentifier)`,不读 Lead 身份、不读部门;项目名必须是 Bridge 配置里的 `projectName`(与报告路由同一校验),⛔ 不在代码里出现任何具体 Lead 或 Epic。

---

## 6. 与兄弟单的接口(本单给什么、不给什么)

| 单 | 本单给它的 | 本单**不**做的 |
|---|---|---|
| B(残余扫描) | `items[].state` / `blocked_by` / `next_candidates`(规则 `next.v1`) | 不扫、不拉活、不碰巡检钟 |
| C(依赖账本) | `blocked_by` 格的 `provenance` 是可替换的;内容模型不因来源变 | 不定义账本;不实现「三类更新」 |
| D(活化) | `observed_at` 可算年龄;`trigger` 预留 `event`/`scan`;`items[].execution` 里的 `status`/`last_error` 可判「卡住」;`signals: []` 预留位 | 不做事件订阅、不做扫描重生成、不做过期告警、不做 R6 上页 |
| E(容量输入) | 无 | 页面 v1 不显示 quota / memory |

---

## 7. 验收怎么证伪

**演练(对 FLY-2108 本身,plan 里是一条集成测试 + 一次真数据手工演练)**:
1. 生成首版 ⇒ 「现在可以开始的」= A、E;「先后」= 三批;「回来找她的」= 0 件(标签尚未打)。
2. 模拟 A 完成(Linear → Done)再生成 ⇒ 可开始的 = B、C、(E 若未开始);
3. 模拟 B、C 完成 ⇒ 可开始的 = D;
4. 模拟 D 完成 ⇒ 可开始的 = 空,且所有子单终态 ⇒ Epic 做完。
每一步,一个**只读页面、不知道任何上下文**的读者都能说出下一件;任何一步说不出 = 不合格。

**完备性守卫(单元测试)**:遍历文档每一格,断言 provenance 合法、`observed_at` 可解析、derived 的 `from` 路径都存在、每张子单四个面要么有值要么 `missing` 带原因。

**反例(负向测试)**:Linear 整体不可达 ⇒ **不写入任何版本**(fail-closed,⛔ 不产出一页全是 missing 的「页面」);单个 StateStore 查询失败 ⇒ 只那一格 missing,页面照出;环形依赖 ⇒ 批次格 missing 并点名环。

**诚实边界**:页面保证「四件事要么有答案、要么明确指出答案缺在 Linear 的哪里」;它**不能**保证 Lead 不会因为别的原因想找她(比如方向变了,R7)—— 那不是页面的事。

---

## 8. 已裁定与假设

**Lead 裁定(2026-09-03 02:37Z,ask `94d2d56a`,✅ 原文要点)**:Q1 同意 StateStore 新表为权威副本,Bridge 出 JSON/HTML,founder 快照用 publish-report(7 天过期已知,活页面留给 2143);Q2 同意唯一来源 = Linear blocks 关系,零关系时如实显示「未登记依赖」,不从正文推断,2143 的依赖由 Lead 在 Linear 登记(已登记,见 §2.2);Q3 同意 `founder-review` 标签为 v1 来源,标签不存在或零命中时页面必须明示「0 件」,标签由 Lead 一次性创建并写进设计文档的运维说明。硬约束不变:⛔ 不写死具体 Lead/Epic,⛔ 页面里不许有没有出处的事实,不加开关。

**本单的假设(可被推翻)**:
1. 「Epic」= 任何有 children 的 Linear issue;不要求特定标签或标题格式。
2. 首版生成由 Lead 手动触发(CLI/API);自动触发归 D。
3. 「做完」以 Linear `state.type = completed` 为准,不另定义;`canceled` = 不做了(减法)。
4. 一层子单;孙单只计数不展开。
5. 页面 founder 视图 v1 只读,无脚本;每节留言的要求只作用于本单交付她的设计 HTML。

---

## 9. 当前位置

```
FLY-2140 —— Epic 页面:内容模型 + 首版生成
├─ A. 页面是什么、给谁读           ✅ 一份文档两种渲染(§1)
├─ B. 四件事各从哪来               ✅ Linear children / blocks / state+验收原文 / founder-review 标签(§3)
├─ C. 出处与时间怎么落             ✅ Cell 模型(§4)
├─ D. 放哪                         ✅ StateStore + Bridge 路由,快照走 publish-report(§5,Lead 已裁)
├─ E. 与 B/C/D/E 的接口            ✅ §6
├─ F. 验收怎么证伪                 ✅ §7
└─ G. 合同与实施序                 → research.md / plan.md
```
