# FLY-1283 Agent-to-Agent 通信标准 — 结论与建议

Issue: FLY-1283 (https://linear.app/geoforge3d/issue/FLY-1283/research-agent-to-agent-通信标准调研-google-a2a-mcp-业界-agent-消息模式-vs-我们的)
日期: 2026-07-16
基于: exploration.md, research.md

> **本文件是 research 类 issue 的「结论 + 建议」,不是施工计划。** FLY-1283 是纯调研,零产品代码。本文给三个落点各一个明确定论,以及(若将来要动)的触发条件。

---

## 1. Annie 的原问题,一句话回答

> 「有没有什么东西是我们可以直接去操作使用的?」

**没有 —— 而且这不是坏消息。**

三层原因,每层都有一手证据:

1. **想要的东西(送达保证),标准明说它不提供。** A2A spec 第 762 行:*"Messages MUST NOT be considered a reliable delivery mechanism for critical information."*
2. **能直接用的组件,没有一个保得住我们的形状。** 成熟的全部要么 +1 常驻 daemon,要么把 SQLite 换 Postgres(也是 daemon)。同形状的 SQLite 库全部比我们现有的更年轻更没验过。
3. **最贵的那层,标准的已发布规范里没有。** arXiv:2606.31498 Table III:A2A **1/12**(`G1 成员` = Partial,`G5 人类升级` / `G6 审计` = **Absent**)。**⚠️ 这是有保质期的当下观察,不是永久护城河 —— 见 §4.0。**

---

## 2. 完整对比矩阵

### 2.1 协议

| 协议 | 成熟度 | **解决送达保证?** | 采用成本 | 锁定风险 | 可自托管 | 判定 |
|---|---|---|---|---|---|---|
| **A2A v1.0.1** | 规范成熟(LF,Apache-2.0,24.8k★);**SDK 参差**:Python/Java/Go 真生产级,**.NET preview 近乎停滞、JS spec-1.0 仍 beta**(官宣「5 个生产级」按字面不成立) | 🔴 **不 —— spec 明文免责**。传输可靠性维度已核到的硬保证只有 **active stream 内的事件顺序**(不含断线补送);push 的 Server Guarantees 只到「尝试」义务(重试 MAY、放弃 MAY);ACK 仅 HTTP 2xx 层 | 中(需实现协议 + 适配器) | 低(Apache-2.0,多厂商 TSC 8 席) | ✅ **是**(核实:`google-*` 只是 protobuf 工具库,非云服务) | **IGNORE**(4a/4b)/ 见 §3.3(4c) |
| **MCP** | 高(下载量 ~A2A 的 25×) | 🔴 **不 —— 且 scope 根本不含 agent↔agent**(spec 自述灵感来自 LSP;`agent-to-agent` 命中 0)。`durable` 仅存在于 **experimental** Tasks 扩展,且是**任务句柄+轮询**,非消息投递 | — | 低 | ✅ | **IGNORE**(用途不符) |
| **AGNTCY SLIM** | 🔴 **alpha** (`v2.0.0-alpha.5`) | 🟡 **本表唯一认真做这层的**(会话层可靠投递 + MLS 加密) | 高(+SLIM node + controller 进程) | 中 | ✅ | **IGNORE 但留意** —— alpha,且加 daemon |
| **ACP** (IBM) | 🔴 **已死** —— 2025-08 并入 A2A | n/a | — | — | — | **IGNORE** |
| **ANP** | 小(1.3k★);身份最强(DID) | ❌ 投递语义未经验证 | 高 | 中 | ✅ | **IGNORE** |
| **Agora** | 🔴 **休眠**(最后 push 2025-03) | ❌ | — | — | — | **IGNORE** |
| **Coral** | 🔴 微市值代币($2M) | ❌(链上支付,非消息) | — | 🔴 高 | — | **IGNORE** |

### 2.2 框架的 agent 间消息语义(真源码核实)

| 框架 | 「消息」物理上是什么 | Durable | ACK | 重投 | DLQ |
|---|---|---|---|---|---|
| OpenAI Agents SDK / Swarm | **一行局部变量赋值** | ❌ | ❌ | ❌ | ❌ |
| LangGraph | channel 写入 + checkpoint | 🟡 **状态快照,非投递**;恢复=**客户端主动重放** | ❌ | ❌ | ❌ |
| AutoGen | 单进程 `asyncio.Queue`;**gRPC 运行时直接丢消息** | ❌ | 🟡 仅 RPC | ❌ | ❌ |
| MS Agent Framework | 进程内 dict;真 durable 靠 **Azure Durable Task**(外部服务) | 🟡 superstep 边界快照 | ❌ | ❌ | ❌ |
| CrewAI | **同进程同步方法调用**;失败**静默转成字符串** | ❌ | ❌ | ❌ | ❌ |

→ **五类被调查框架(六个项目:OpenAI Agents SDK + Swarm 是两个)没有一个有带 ACK/重投/DLQ 的持久化 agent 间通道。**

### 2.3 可直接采用的组件(能不能替掉我们手搓的?)

| 候选 | 运行成本(**决定性列**) | 四要素 | 判定 |
|---|---|---|---|
| Temporal / Hatchet | 服务集群 + DB + workers | ✅ | **overkill** |
| Restate | +1 常驻服务 | ✅ | **overkill** + 🔴 **BSL 1.1 非开源** |
| NATS JetStream | +1 daemon(单二进制) | ✅(DLQ 自搞) | **overkill**(daemon 里最不坏) |
| Redis Streams / BullMQ | +1 Redis daemon | ✅(DLQ 自搞) | **overkill** |
| pgmq / pg-boss / River / DBOS / Absurd | **要 Postgres**(= daemon 穿数据库的皮) | ✅ | **wrong-shape** |
| Node 进程内 SQLite 队列库 | **零 daemon(唯一同形状)** | 各异 | 🔴 **形状对、成色不够**:better-queue **2022 年死了**;sqliteq **2026-03 才生**、单维护者 |
| **AMQ**(agent 专用) | 零 daemon(Maildir) | ✅ | **wrong-shape** — 71★/单维护者/自述「非生产」 |

---

## 3. 三个落点的定论

### 3.1 4a — 送达保证:**IGNORE(保持自建)**

**定论:不采用任何标准或库。保持 FLY-1279 已建并验过的自建层。**

四条论证:

1. **wire format 层面解决不了。** A2A 明文免责(research.md §1.3);它在传输可靠性维度提供的是 **active stream 内的顺序**,不是**送达**。**送达保证需要「状态 + 时间 + 重试驱动」,一个信封格式装不下。**
2. **所有成熟组件都让形状变差。** 我们现在是 **1 个常驻进程(Bridge)+ 0 个服务器**;没有一个候选保得住 —— 要么 +daemon,要么 +Postgres。约束是「无 ops 团队,每个新 daemon 都是凌晨 3 点没人重启的崩溃点」。
3. **唯一同形状的候选更年轻、更没验过。** sqliteq 2026-03 才生、单维护者;better-queue 2022 年已死。**拿它们换掉已通过 FLY-1279 QA 清单的实现,收益不明而风险明确。**
4. 🔴 **现成队列给不了我们真正贵的那部分。** 它们提供 durable+ACK+redeliver+DLQ;**给不了**的是升级阶梯状态机、死 agent 检测、clean-retry —— 那是领域逻辑,采用任何队列后都得**在它上面重新实现一遍**。→ 采用 = **换掉通用的那部分、保留要自己写的那部分,再附赠一次迁移。**

   > ⚠️ **本条曾写「durable+ACK+redeliver+DLQ 约 200 行、已写完验过 → 迁移按定义负期望值」。Codex R1 抓出、我自己复核后确认:该数字是我从子调研转抄的,从未自己数,且不成立。**
   >
   > **自己数的真实数字(命令可复现):**
   > ```
   > $ git show --numstat --format="" 8f6b330b1 \
   >     | awk '$3 ~ /^packages\//{a+=$1; f++} END{print a, f}'
   >   → 6191 72   (FLY-1279 单个合并提交在 packages/ 下 +6191 行 / 72 个文件)
   > $ wc -l packages/teamlead/src/bridge/lead-event-delivery.ts   → 466
   > ```
   > 即便其中相当部分是测试,**投递层也远不是「~200 行」**。
   >
   > **修正后的诚实表述**:FLY-1279 已实现并通过其 QA 清单,但**实现横跨多个模块**(db.ts / StateStore.ts / park-watch / event-route / auto-qa-coordinator …),**维护面不小**;且 **25/25 QA 只能证明清单内场景,不等于跨进程崩溃、重启、跨机器投递都已验证**。→ 在**当前单机约束下**,迁移收益不足以抵消适配 + 运维成本。**这仍然支持 IGNORE,但理由是「当前形状下不划算」,不是「按定义负期望值」。**

**横向印证**:连微软都把持久化外包给 Azure Durable Task;A2A 明文把它留给实现者。→ **在本次调查的五类框架 + 七个协议范围内,持久化投递无一例外都留给实现者或外包给云服务。我们手搓不是异类。**
> ⚠️ 这是**基于已调查范围的归纳**,不是全行业普查。

### 3.2 4b — 边缘说 A2A:**IGNORE now / trigger-based re-evaluation**

> Lead 的初读是「WRAP-lite」。**我独立核完 proto + 经 Codex 三轮复审后,结论是:方向一致(不实现协议),但 `WRAP-lite` 这个名字名不副实 —— 见下方定名更正。**

**定论:现在不实现 A2A 协议,也不设任何持续性约束。**

> ⚠️ **定名更正(Codex R2 #5,采纳)**:原名「WRAP-lite(保持可映射)」名不副实 —— 既然没有协议、没有代码、也**不设持续 schema 约束**,它实际上只剩「文档里留一张映射草案备查」。继续叫 WRAP-lite 会**重新引入 R1 指出的不可验收承诺**。→ **改名为 `IGNORE now / trigger-based re-evaluation`。**

**当前唯一资产 = 下面那张映射草案(备查,不是承诺、不约束 schema)。** 四个触发条件任一命中(§3.3)时,拿它重评。

**为什么不做完整 wrap —— 理由是成本/收益,不是「不可能」:**

> ⚠️ **本节原来的论证是错的,已被 Codex R1 抓出并重写(详见 research.md §2.7)。**
> 原写:「A2A 的 `Role` 只有 USER/AGENT,装不下我们的三方模型 → **结构上不可能**」。
> **这是范畴错误。** proto 注释原文 *"Defines the **sender of a message**"* —— `Role` 表达的是**本次 wire interaction 的方向**(client→server / server→client),**不是全局业务身份**;它本来就不该装业务身份。而 A2A 把 Client 定义为 *"on behalf of a user or **another system**"* → **一个边缘 adapter 完全可以把整个 Flywheel 暴露成一个 A2A server**,founder/lead/runner/lease/PID/checkpoint **全部留在内部,根本不需要上互操作 wire**。同理,**加一个边缘 adapter ≠ 改 208 个调用者**。

**修正后的真实理由(只剩一条,但它足够):**

🔴 **没有当前已知的具名对接方 → 直接互操作的收益未被证明,不足以支付 adapter + 语义协商 + 运维的成本。**
见 §3.3:本次调研**未发现 Flywheel 的任何具名外部对接方**。
> ⚠️ **注意证明标准(Codex R2 提出,采纳)**:「未发现」**不等于**「对话方不存在」,也不能把标准工具链/未来 option 等潜在收益**精确计为零**。但结论不需要那么强的证明 —— **只需要「当前直接互操作收益未被证明,且不足以抵消已知成本」**。

**如果将来要做,最小语义映射草案(备查,不是承诺):**

> ⚠️ **必须按「边界场景 + 方向」映射,不能按内部 `type` 静态映射(Codex R2 #4,采纳)。**
> 我上一版写「`question`→agent message、`response`→client message」—— 那是**把刚纠正的范畴错误换个形式带了回来**:既然 `Role` 由**边界上的 client/server 方向**决定,同一个内部 type **不能脱离交互方向**决定 A2A Role(client 发起的 question 是 USER message;server 请求澄清才是 AGENT + `INPUT_REQUIRED`;response 两侧都可能发)。

| 边界场景(方向) | A2A |
|---|---|
| 外部 client 发起任务 → Flywheel | `USER` Message(新 Task) |
| Flywheel(server)请求补充/澄清 | `AGENT` Message + `TASK_STATE_INPUT_REQUIRED` |
| 外部 client 补充输入 / 下指令 | `USER` Message |
| Flywheel(server)汇报进展 | `TaskStatus` update |
| `ack_receipt` / lease / PID / `relay_state` / `checkpoint` | **local-only,不上 wire** —— 除非未来的可靠性 contract 明确要求 extension |

**为什么仍值得留这张草案(公平面):**

- A2A 的 **Task 生命周期与我们形状同构**:`INPUT_REQUIRED` 在 proto 里明写是 interrupted state,与我们的 brainstorm 门**形状相似**(都表达「任务被外部输入中断」)。一个跨 150+ 组织的标准独立收敛到这个形状 → **认知价值:这个形状是通用的。**
  > ⚠️ 但**不是语义对应**:`AUTH_REQUIRED` 原文是 "**authentication** is required" = **认证**,**不是 founder 审批(授权)**。触发条件 / 授权主体 / 审计 / 恢复语义全是我们的上层治理,A2A state 不提供 —— 这也正是论文把 A2A 的 **G5 判为 Absent** 的原因(见 §4)。
- 留一张草案的成本 ≈ 0(它只是文档);真要 wrap 才是工程。
  > ⚠️ **验收标准问题(Codex R1 提出 + R2 收紧,均采纳)**:「持续保持 schema 可映射」**没有可验收标准**,会变成一句无人执行的空话。→ **终定:不设任何持续性约束**,当前资产**仅为一张映射草案**;在 §3.3 **四个**触发条件任一命中时拿它重评。**这也是本节改名的原因** —— 叫 WRAP-lite 会暗示存在 schema governance,那是不存在的。

### 3.3 4c — 跨机器/跨公司:**不采用**

**定论:本次调研未发现 Flywheel 的任何具名外部对接方 → 不采用。**

> ⚠️ **本节原来把「我们没找到」写成「生态中不存在」,Codex R1 抓出,采纳更正。**
> **不采用的门槛只需要「Flywheel 今天没有一个已知、具名、要求 A2A 的对接方」—— 不需要证明整个市场为零。** 把「未能验证」写成「不存在」会损伤本文最重要的证据纪律(这正是 research.md §1.4/§2.6 抓别人错的那把尺)。

**站得住的证据(按强度排序):**

- 🟢 **最强、也是唯一必需的一条**:**本次调研未发现 Flywheel 的具名外部对接方。** 没有客户、合作方或外部 agent 要求 A2A。
- 🟢 **可公开核验的跨组织部署证据薄弱**:LF 新闻稿宣称 "active production deployments",但**未具名任何部署方**,只列行业门类。
  > ⚠️ 但:新闻稿不具名 **≠** 具名部署不存在。这是「公开证据薄弱」,不是「不存在」。
- 🟡 **单个社区 registry(a2aregistry.org)规模很小(~15 个 agent)**。
  > ⚠️ 但:一个社区 registry **不能穷尽**所有公开 A2A 服务。
- 🟡 **弱信号**:MCP ~257M vs A2A ~10.9M 下载。
  > ⚠️ **不可直接横比** —— 受协议年龄、包数量、使用场景影响。**不能单独证明从业者在二者间反复选择 MCP。**
- 🟡 **Ask HN(~2026-06)一条大厂内部人观察**:*"not a single use case I witnessed used A2A in the final product."*
  > ⚠️ 一条轶事。**不能据此推出「真实使用全部是企业内部」或「跨组织联邦从未兑现」。**
- 🟢 **且 A2A 不带送达保证** → **它不改善 4a 的可靠性维度**;若未来跨边界需要同等保证,仍须**另加**可靠性 contract/实现。这层唯一认真的工作(AGNTCY SLIM)仍是 alpha。
  > ⚠️ 原写「净退步」不准确(Codex R2):edge adapter 是**叠加在现有 CommDB 之上**,并不会删除内部保证 —— 准确的说法是 **A2A 补不足跨边界可靠性**,不是它会让我们变差。

**公平面(两点):**
- **A2A 近期被放弃的风险看起来较低**(LF + 8 席多厂商 TSC + 正并入 AAIF 与 MCP 同屋)→ 采用买到的是**标准对齐期权**,不是当下伙伴。
  > ⚠️ 但「A2A 不会死」是**无法保证的预测**,不能当事实写。
- **AgentCard(discovery + `skills` + `security_requirements` + `signatures`)是 A2A 真正扎实的贡献** —— 真跨组织那天该借鉴。
  > ⚠️ **但不能只复制字段(Codex R1,采纳)**:`signatures` **只能证明持钥者签过**;**对方是否该信任这个 key、key 与组织/agent 身份如何绑定、如何轮换/撤销** —— 全都不在字段里。**跨组织 discovery 的难点恰恰是 provenance/trust,不是 JSON 里有没有 signature 字段。** 触发跨组织集成时,**必须先定义 issuer/key trust、rotation、revocation、域名/组织绑定**(`jku`/`kid` 策略或额外 PKI)。

**重估触发条件(全部未发生):**
1. Flywheel 真的要跨机器跑 agent(→ 先看 **pg-boss** 或 **NATS JetStream**,**不是 A2A** —— A2A 不解决这个)
2. 出现**具体的、具名的**外部 agent 需要对接
3. 客户/合作方**明确要求** A2A 合规
4. 🆕 **出现被接受/发布、且实质覆盖 `G5 human escalation` 或 `G6 audit/replay` 的 extension** —— 论文预测 6–12 个月内可能出现(§4.0)。**注意:官方 #1628(open issue proposal;无关联 PR/branch;未接受、未发布;不覆盖 G5)不满足此条件,不构成触发。** 若真有覆盖 G5/G6 的 extension 被接受,§4 的判断就要重估。

---

## 4. 🔴 HEADLINE:我们贵的那层,论文评估的那五个协议今天都没有

**arXiv:2606.31498**《Governance Gaps in Agent Interoperability Protocols》(2026-06-30,Kang &amp; Diponegoro),**Table III 原文**:

```
 Protocol       G1 Membership  G2 Deliberation  G3 Voting  G4 Dissent  G5 Human Esc.  G6 Audit  Coverage
 MCP v1.1          Absent          Absent        Absent      Absent       Absent       Partial    1/12
 A2A v1.0.1        Partial         Absent        Absent      Absent       Absent       Absent     1/12
 ANP               Absent          Absent        Absent      Absent       Absent       Absent     0/12
```

论文对 **A2A 的 G5** 判定原话:
> *"**Absent.** No protocol mechanism for escalating to human authority. Task delegation can target a human-backed agent, but this is **routing, not governance escalation with trigger conditions**."*

→ 「**带触发条件的治理升级**」= 逐字描述了 FLY-1279 的 park-watch 阶梯。

论文对 **MCP 的 G5** 判定原话:
> *"...no protocol-level mechanism for **routing community decisions to human authority based on confidence thresholds or risk assessment**."*

→ 逐字描述了 FLY-175 的 `FounderConsentEvaluator`(Haiku + per-action-type 阈值 + 审计表)。

论文结论原文:
> *"agent community governance constitutes a **missing architectural layer above** current interoperability standards, **not a missing feature within them**."*

**这把 Annie 的问题反过来了**:她问「有没有现成的能直接用」;答案是 —— **我们真正贵的那层(founder 审批门 + 升级阶梯 + 审计),在论文评估的五个互操作协议(MCP / A2A / ACP / ANP / ERC-8004)的已发布规范里,**今天**都不存在(`G5 人类升级` 全部 Absent)。**
> ⚠️ **范围限定**:这是**论文评估的那五个协议**,**不是**「所有互操作标准」—— 未做全体普查。且这是**有保质期的当下观察**(§4.0)。

### 🔴 4.0 但这层「没有」是有保质期的 —— 不是永久护城河

> ⚠️ **这一条是 Codex design review R1 抓出的我最严重的错误。原文把论文结论写反了,必须显著更正。**
> 我原写:「论文认为治理属于 **structural gap**(需新架构层)→ 不太可能被 A2A 下个小版本补掉」。**错。**

**论文 §V.A 原文(`gov.txt:286-294`):**
> "**Extensible via A2A**: A2A's extension mechanism explicitly supports 'new data, requirements, RPC methods, and state machines'. Governance primitives (G1–G6) **could theoretically be defined as A2A extensions**. The key observation: **no one has done so.** After 6+ months of A2A being publicly available with an active extension ecosystem, **zero governance extensions have been proposed or implemented**."

→ **"Structurally awkward" 论文是说给 MCP 的,不是 A2A。** 对 A2A,治理是 **extensible**。

**论文 §V.B 原文(`gov.txt:333-340`):**
> "At the observed evolution velocity, we estimate the governance gap **could narrow significantly within 6–12 months** through protocol extensions, **particularly via A2A's extension mechanism**."

**修正后的准确三句话:**
1. ✅ **今天**:

**A2A v1.0.1 core 的治理现状(最终表述,research 与 plan 一致):**
- Table III 实测:**G1 Membership = Partial;G2/G3/G4/G5/G6 = Absent;合计 1/12**。
- **尚无已接受/发布、且实质覆盖本文相关 `G5 human escalation` 或 `G6 audit/replay` 语义的 extension。**
- 官方 repo 有一个 trust / governance-attestation proposal(**#1628** —— **open issue proposal;无关联 PR/branch;未接受、未发布**;2026-03-13;含 `governance_attestation`),**内容主要是 AgentCard trust / prospective authorization,不覆盖 G5**。
- → **「core / 已发布规范无完整治理层」成立;论文那句无条件的 *proposal-zero* **未获独立确认**(见下方限定)。**

   → **「我们建的是标准的已发布规范里没有的那层」今天成立。**
2. ⚠️ **但**:论文认为 A2A extension **是可行的补齐路径**,并给出 **6–12 个月**估计。**这是预测,尚未被任何已发布的 governance extension 兑现。**
3. → **所以这是一个有时限的当下观察,不是永久护城河。** 精确的重估条件见 **§3.3 触发条件 #4**(不在此另写近义句)。

**论文自述的 limitations 也要带上**(`gov.txt:373-383`):分类含判断成分;**只评规范本身,不评在其之上能构建的系统**。→ 论文没说「用 A2A 建不出治理」,只说「A2A 的已发布规范里**没有完整治理层**」(`G1 Partial`;`G5`/`G6` **Absent**)。

### 4.1 ⚠️ 但必须配套的诚实话(同一把尺量自己)

**这不能被读成「我们比标准强」。**

| ✅ 站得住 | ❌ 不能说 |
|---|---|
| 我们**有** G5(带触发条件的人类升级),标准**没有** | ❌「我们的总线比 A2A 强」—— **我们的送达层从未跑过跨机器**,没被那样测过 |
| 我们的差异化(升级阶梯/死 agent 检测/clean-retry)现成队列都不提供 | ❌「我们做了个更好的通用件」—— 我们**没在做标准**,我们在做**自己这一台机器上的治理** |
| G6 审计我们**部分**有(append-only 授权审计 + `founder_consent_audit`) | ❌ 说我们审计完整 —— **没做过完整重放** |
| G2 审议/G3 投票/G4 异议 —— **我们也没有** | ❌ 假装我们覆盖六维 —— 我们不是投票社区,**也不需要** |

**最诚实的一句**:
> 这不是因为我们聪明。**标准解决的是「不同公司的 agent 怎么互相发现和说话」,我们解决的是「一个人怎么在她睡觉时仍然掌控她的 agent 舰队」。不同问题,所以答案不同。**

→ 治理缺口的可补性见 **§4.0**(论文对 A2A 判为 **extensible**,并预测 6–12 个月;当前 core/已发布规范**无完整治理层** —— `G1 Partial`,`G5`/`G6` Absent)。

---

## 5. 建议行动:**零代码改动**

| 落点 | 定论 | 要做的事 |
|---|---|---|
| 4a 送达保证 | **IGNORE** | **无。** 保持 FLY-1279 已验过的自建层 |
| 4b 边缘说 A2A | **IGNORE now / trigger-based re-evaluation** | **无代码,且不设持续性约束。** 唯一资产 = §3.2 的映射草案(备查)。四个触发条件任一命中时重评 |
| 4c 跨机器/跨公司 | **不采用** | **无。** 记住**四个**重估触发条件(§3.3) |

**本 issue 不产生任何 packages/ 代码改动。** 交付 = 三份文档 + 给 Lead 的 founder HTML 素材。

---

## 6. 未能核实的(明确标注)

- ChatGPT DR **全文未取到**(跨域 iframe 吃不了合成点击;composer-inline 兜底也卡住)。按 Lead 判断**不动 founder 的手** —— 边际价值只剩广度,而专项子调研的 live `gh api` 覆盖更好。DR **执行摘要**(截图读到)与独立 grep 结论一致,**仅作交叉印证**。
- **Durable Task 内部**未追踪 → MAF 的 durability 保证仅 verified-from-docs。
- Temporal/Redis 的 release 日期、Redis license:子调研页面解析部分乱码,已标注。
- AGNTCY SLIM 的 durability 语义细节:未详细核实。
- A2A 厂商宣称的生产部署(Cisco Webex / Swisscom 等):**外部无法核实**。
