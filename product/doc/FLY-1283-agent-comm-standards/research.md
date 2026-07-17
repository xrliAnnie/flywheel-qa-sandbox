# FLY-1283 Agent-to-Agent 通信标准 — 调研

Issue: FLY-1283 (https://linear.app/geoforge3d/issue/FLY-1283/research-agent-to-agent-通信标准调研-google-a2a-mcp-业界-agent-消息模式-vs-我们的)
日期: 2026-07-16
基于: exploration.md

---

## 0. 证据等级说明(先说尺子,再说结论)

| 等级 | 含义 | 本文用在哪 |
|---|---|---|
| **A — 一手 spec 原文** | 我把 spec/proto 拉到本地,自己 grep + 读上下文,**带阳性对照验尺子** | §1 A2A、§2 MCP |
| **B — 一手源码/仓库** | 官方 GitHub 源码、release、npm registry | §3 框架、§4 组件 |
| **C — 交叉验证** | ChatGPT Deep Research(7min/38引用/353搜索) | 仅作**印证**,不作唯一来源 |

**为什么这么严**:Lead 钉的纪律 —— 涉及送达保证语义的每一条必须回原文核,「别给 A2A 安一个它没有的 durable-delivery 语义」。

**这条纪律当场抓到两个错**(见 §1.4)。

---

## 1. Google A2A —— 一手 spec 核实(证据等级 A)

**版本锚点**:冻结的 spec 文件头自述 `Latest Released Version 1.0.0`;**当前 release 为 v1.0.1**(本文提及 v1.0.1 处均指后者 —— Codex R2 #8 要求区分)。
**取材**:`a2aproject/A2A@main` → `docs/specification.md`(3610 行)+ `specification/a2a.proto`(35844 B,数据模型的**权威**来源 —— spec 的表是 `{{ proto_to_table() }}` 宏从 proto 生成的)。

### 1.1 尺子先验(阳性对照)

负向断言(「spec 没写 X」)必须先证明 grep 没坏,否则「返回 0」可能只是尺子坏了。

| 阳性对照词 | 命中 | 判定 |
|---|---|---|
| `TaskState` | 6 | ✅ |
| `idempotent` | 6 | ✅ |
| `ordering` | 5 | ✅ |
| `MUST` | 162 | ✅ |

→ 尺子是好的,下面的 0 是**真 0**。

### 1.2 送达保证词汇扫描结果

| 词 | 命中 |
|---|---|
| `durable` / `durability` | **0** |
| `dead letter` / `dead-letter` | **0** |
| `redeliver` / `re-deliver` | **0** |
| `exactly-once` / `exactly once` | **0** |
| `retries` | **0** |
| `queue` | **0** |
| `at least once` | 1 |
| `acknowledg*` | 2 |
| `retry` | 3 |
| `backoff` | 2 |
| `persist` | 5 |

### 1.3 🔴 决定性证据 —— spec 亲口否认自己是可靠投递机制

**spec §3.4(Messages),原文第 762 行,一字不差:**

> **"Messages MUST NOT be considered a reliable delivery mechanism for critical information."**

同节配套两条(第 760 / 764 行):

> "not all Messages are guaranteed to be persisted in the Task history … The agent is responsible to determine which Messages are persisted"
>
> "Agents MAY choose to persist all Messages … However, **clients MUST NOT rely on this behavior unless negotiated out-of-band**."

**这一条直接回答 4a**:你**无法**「采用 A2A」来获得送达保证 —— **不是因为 spec 忘了写,而是因为 spec 明文让你别指望它**。这比「spec 对送达保证沉默」强得多:沉默还能自己补,明确的免责声明是设计意图。

### 1.4 非零命中必须精确读 —— 两个被抓到的错

> ⚠️ 这一节是纪律①的产出。**若不回原文核,这份研究会带着事实错误交付。**

**错误 1 —— WebFetch 的小模型摘要**说 spec 对 at-least-once「完全沉默」。**错。**
**错误 2 —— ChatGPT DR 自己**也说「no normative language … at-least-once」。**同样漏了。**

**真相**:spec 第 882 行有一整节叫 **Server Guarantees**:

```
884: - Agents MUST attempt delivery at least once for each configured webhook
885: - Agents MAY implement retry logic with exponential backoff for failed deliveries
886: - Agents SHOULD include a reasonable timeout for webhook requests (10-30 seconds)
887: - Agents MAY stop attempting delivery after a configured number of consecutive failures
```

**但精确读完,它不是 at-least-once 投递语义:**

| 表面 | 精确含义 |
|---|---|
| `MUST attempt delivery at least once` | 是 **webhook 推送的「尝试」义务** —— 尝试一次即履约。不是「保证送达」。 |
| `MAY implement retry` | 重试是 **MAY**,不是 MUST → 不重试也合规 |
| `MAY stop attempting after N failures` | **可以直接放弃** → 不是 at-least-once |
| 第 877 行 `Clients MUST respond with HTTP 2xx to acknowledge receipt` | 有 ACK,但只是 **HTTP 状态码层**,**没有配套的持久化/重投义务** |
| 第 495 行 `Send Message operations MAY be idempotent` | **MAY** —— 不是保证层 |

**A2A 在传输可靠性维度上,已核到的硬保证只有 active stream 内的事件顺序**(第 683 行):
> "All implementations **MUST** deliver events in the order they were generated."

> ⚠️ 原写「唯一的硬保证」—— 按字面不成立(spec 全文有 **162 处 MUST**)。此处限定为**传输可靠性维度**,且是 **active stream 内的 ordering**,**不含断线后的消息补送**(spec:762 明说断线重连的 streaming client 可能漏掉 status message)。

→ **结论**:在传输可靠性这一维度上,A2A 提供的是「(active stream 内的)顺序保证」,不是「送达保证」。两者不能混。

### 1.5 数据模型(proto 权威)—— 4b 的决定性证据

```protobuf
message Message {
  string message_id = 1  [REQUIRED];
  string context_id = 2;
  string task_id = 3;
  Role   role = 4        [REQUIRED];
  repeated Part parts = 5 [REQUIRED];
  google.protobuf.Struct metadata = 6;   // ← free-form
  repeated string extensions = 7;
  repeated string reference_task_ids = 8;
}

enum Role {
  ROLE_UNSPECIFIED = 0;
  ROLE_USER  = 1;   // client → server
  ROLE_AGENT = 2;   // server → client
}
```

**`Role` 只有 USER / AGENT。**

> ⚠️ **本节曾有一处范畴错误,已被 Codex design review R1 抓出并更正(见 §2.7)。**
> **错误版本**说:「Role 只有两方,所以装不下我们的 founder/lead/runner 三方 → A2A 结构上装不下我们」。
> **这是错的。** proto 注释原文:*"Defines the **sender of a message** in A2A protocol communication"* —— `ROLE_USER` = "The message is from the **client to the server**",`ROLE_AGENT` = "from the **server to the client**"。
> **`Role` 表达的是本次 wire interaction 的方向,不是全局业务身份。** 它本来就不该装业务身份。

**正确的读法:**

- A2A 把 Client 定义为 *"An application or agent that initiates requests to an A2A Server **on behalf of a user or another system**"*(spec:135)→ **一个边缘 adapter 完全可以把整个 Flywheel 暴露成一个 A2A server/client**,founder/lead/runner 留在内部,**根本不需要上互操作 wire**。
- `Part.data` 可携带结构化 JSON(proto:221-242);Message 支持声明 **extension**,spec §4.6 明写 extension 可加入 strongly typed context/progress。
- → **所以「A2A 结构上装不下我们」不成立。** 真实结论是**成本/收益**问题,不是**可能性**问题(见 plan.md §3.2)。

**仍然成立的部分**:我们内部持久化字段(`relay_state` / `sender_lease_key` / `writer_pid` / `checkpoint` …)确实在 A2A 里没有对应概念 —— **但它们本来就不需要跨 wire**,这不构成反对 wrap 的理由。

### 1.6 但要公平 —— A2A 的 Task 生命周期**形状**贴我们(仅限形状)

不能一边倒。A2A 的 **Task**(不是 Message)模型跟我们的 runner 生命周期**形状相似**:

```
TASK_STATE_SUBMITTED / WORKING / COMPLETED / FAILED / CANCELED / REJECTED
TASK_STATE_INPUT_REQUIRED   ← proto:200 "requires additional user input to proceed. This is an interrupted state"
TASK_STATE_AUTH_REQUIRED    ← proto:206 "authentication is required to proceed. This is an interrupted state"
```

> ⚠️ **本节曾把「形状相似」写成「分别对应」,已被 Codex R1 抓出并收窄(见 §2.7)。**

| A2A 状态 | 形状上像我们的什么 | ⚠️ 但**不是**语义对应 |
|---|---|---|
| `INPUT_REQUIRED` | brainstorm 门 / question 门 | A2A 只说「需要更多 **user input**」;**触发条件、授权主体、审计、恢复语义全是我们的上层治理**,A2A state 不提供 |
| `AUTH_REQUIRED` | ~~founder 审批门~~ | 🔴 **误读**。proto 原文是 "**authentication** is required" = **认证**(有没有凭据),**不是 authorization/审批**(该不该放行这个高风险动作)。两者不是一回事 |
| `SUBMITTED → WORKING → COMPLETED` | Lead 派 issue → runner 干 → 开 PR | 形状像;语义无冲突 |

**Codex 指出的内部矛盾(成立)**:若 A2A 真有 founder-审批语义,论文 §2.6 就不会把 A2A 的 **G5 人类升级判为 Absent**。我原来的写法与自己引用的证据打架。

→ **公平且准确的说法**:A2A 的 Task 抽象与「Lead 委派一个 issue 给 Runner」**形状同构**,且两者都能表达「任务被外部输入中断」。**这有认知价值(说明这个形状是通用的),但不能读成 A2A 已经提供了我们的审批语义 —— 它没有。**

### 1.7 AgentCard —— A2A 对 4c 真正值钱的东西

```
name / description / supported_interfaces / provider / version
capabilities / security_requirements
default_input_modes / default_output_modes
skills            ← 能力广告
signatures        ← v1.0 新增:签名的 Agent Card
```

→ A2A 最扎实的贡献是**发现(discovery)+ 签名的能力广告 + 安全声明**,**不是**消息投递。这是 4c 的正确落点,与 4a 无关。

---

## 2. MCP —— 一手 spec 核实(证据等级 A)

**取材**:`modelcontextprotocol/modelcontextprotocol@main` → `docs/specification/draft/{index,architecture}.mdx` + `docs/extensions/tasks/overview.mdx`。

### 2.1 官方 scope 原文 —— 边界在哪

> "MCP is an open protocol that enables seamless integration between **LLM applications and external data sources and tools**."

通信三方是:
- **Hosts**: LLM applications that initiate connections
- **Clients**: Connectors within the host application
- **Servers**: Services that provide context and capabilities

且 spec 自己说灵感来自 **LSP**(Language Server Protocol)—— 即**编辑器↔语言服务**那种 client/server 形状。

**扫描结果**(阳性对照 `tool`=14 / `client`=43 / `server`=53 → 尺子好):

| 词 | 命中 |
|---|---|
| `agent-to-agent` / `agent to agent` | **0** |
| `dead-letter` / `redeliver` / `at-least-once` / `exactly-once` / `retry` / `queue` / `persist` | **0** |

→ **MCP 的设计 scope 里根本没有 agent↔agent 这个概念。** 边界很清楚:MCP 是 **agent↔tool/resource**。

### 2.2 唯一的 `durable` 命中 —— MCP Tasks 扩展(必须查,不能因为是扩展就跳过)

`durable` 命中 1 次,指向 **Tasks 扩展**:

> "MCP Tasks let servers return a **durable handle** instead of blocking, so clients can poll for progress … and retrieve the final result after reconnecting."
>
> "**Crash resilience.** A task ID is a durable handle. If the client disconnects or restarts, it can resume polling with the same ID."

状态枚举:`working` / `input_required` / `completed` / `failed` / `cancelled`。

**但要精确说三点:**
1. **它是 experimental** —— 原文:"The Tasks extension is specified in the **experimental**-ext-tasks repository",走 extension negotiation 协商。
2. **它是「长任务句柄 + 客户端轮询」**,不是 agent 间消息总线的送达保证。持久的是**任务句柄**,让客户端断线后能回来轮询;不是「消息投递给对方」。
3. Tasks 扩展内 `dead-letter` / `redeliver` / `at-least-once` / `exactly-once` / `retry` 命中 **全 0**(阳性对照 `task`=69 / `poll`=15 → 尺子好)。

**另一个 `acknowledg` 命中**是 `notifications/subscriptions/acknowledged` —— **订阅确认**,不是消息投递 ACK。别混。

### 2.3 有意思的收敛(观察,不是建议)

MCP Tasks 的状态机(`working`/`input_required`/`completed`/`failed`/`cancelled`)**几乎就是 A2A 的 TaskState**。两个协议在「长任务句柄」这个抽象上独立收敛到同一形状 —— 说明这个抽象是真实需求。但**两者都没有**因此获得消息总线的送达保证。

→ **这恰恰印证 §5.1 的分层论证:「长任务句柄」和「可靠投递」是两个不同的问题,协议层解决了前者,没碰后者。**

---

## 2.5 A2A 生态成熟度 —— 「150+ 组织」经得起查吗?(证据等级 B,live `gh api`)

这一节直接决定 **4c**。**press release 是「关于宣称的数据」,不是生产使用的证据** —— 按这个标准查。

### 2.5.1 治理与自托管(核实为真)

- **License**: Apache-2.0(spec + 全部 SDK),Linux Foundation 项目(2025-06 起)。
- **谁控制**:`GOVERNANCE.md` 原文 —— TSC **恰好 8 个公司任命席**(Google / Microsoft / Cisco / AWS / Salesforce / ServiceNow / SAP / IBM),明写是 "Startup Phase" 章程,各公司自行任免自己的席位,新组织进入需 TSC 多数票。→ **是企业联盟,不是社区精英制;但确实多厂商,不是 Google 独控。**
- **正在发生**:A2A 正被并入 **AAIF**(Agentic AI Foundation,2025-12 成立,与 MCP / goose / AGENTS.md 同一屋檐;白金成员含 Anthropic / OpenAI / Google / Microsoft / AWS)。`aaif/project-proposals#37` 已核:AAIF TC 已批准 A2A 为 Growth Stage 项目,**理事会投票尚未完成,issue 今天仍开着**。→ **MCP 与 A2A 在向同一个基金会收敛。**
- 🟢 **零 Google 云依赖 —— 核实为真**:读 `a2a-python/pyproject.toml`,`google-api-core` / `googleapis-common-protos` 是 **Google 发布的 protobuf/gRPC 工具库,不是云服务**;无任何 GCP 账号/端点/凭据。服务端是普通 Starlette/FastAPI,存储走 SQLAlchemy(SQLite/PG/MySQL)。**完全可本机自托管。**

### 2.5.2 🔴 SDK:官方宣称「5 个生产级语言」—— 按字面说法**是假的**

| SDK | 最新 release | 近 30 天 commit | 判定 |
|---|---|---|---|
| a2a-python | v1.1.1 (2026-07-16) | 5 | ✅ 真·生产级 |
| a2a-java | v1.1.0.Final (2026-06-29) | 29 | ✅ 最活跃(IBM/Red Hat) |
| a2a-go | v2.3.1 (2026-05-13) | 8 | ✅ 维护中 |
| a2a-js | v0.3.14 stable / **v1.0.0-beta.0** | 3 | ⚠️ **对 spec v1.0 的支持仍在 beta** |
| a2a-dotnet | **v1.0.0-preview2** (2026-04-09) | **0**(最后 commit 2026-06-09) | 🔴 **preview 且近乎停滞** |

→ Python/Java/Go 名副其实;**.NET 是停滞的 preview,JS 的 spec-1.0 线是 beta**。2026-04 新闻稿的「5 production-ready SDKs」**按字面不成立**。

### 2.5.3 🔴 「150+ 组织」= logo 数,不是生产部署数

- 直接读 [LF 新闻稿原文](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year):它宣称 "active production deployments across multiple industries",但**具名的生产部署方 = 零个**,只列了行业门类。
- 每个被点名的组织,要么是**把 A2A 集成进自己在卖的产品**的云厂商(Azure AI Foundry / Copilot Studio / Bedrock AgentCore / Gemini Enterprise),要么是框架(LangGraph / CrewAI)。→ **供给侧证据充分;需求侧(真实跨组织流量)缺乏可公开核验的证据。**
  > ⚠️ 「缺乏可核验证据」≠「不存在」。
- **从业者实况**([Ask HN: Is anyone using the A2A protocol?](https://news.ycombinator.com/item?id=48582679),~2026-06):有两条「在公司里用,像 agent 版微服务」;一条大厂内部人:**"not a single use case I witnessed used A2A in the final product"**;数条「试过,回去用 agent-behind-MCP 了,觉得过度复杂」。
- **下载量对比**:MCP ~**257M** vs A2A ~**10.9M** 累计 SDK 下载(≈ **25 倍**)。
- **公开 agent population**:社区 [A2A Registry](https://a2aregistry.org/) 列了 **~15 个** 活 agent。⚠️ 但**一个社区 registry 不能穷尽所有公开 A2A 服务** —— 这是「该 registry 规模很小」,不是「公开世界只有 15 个」。

### 2.5.4 已发表的批评(真·技术来源)

- **arXiv:2602.11327**(2026-02,加拿大网络安全研究所系):威胁建模 MCP/A2A/Agora/ANP。**A2A 具体问题**:未强制 token 过期上限(泄露 token 可重用)、scope 过粗(权限提升)、agent-card 声明**无 issuer-bound provenance**。身份强度排序:ANP(DIDs)> A2A > MCP(最差);Agora 最不成熟(假设世界是合作、非对抗的)。
- **arXiv:2606.31498** —— **本研究的 headline,单列 §2.6 详述(证据等级 A:我自己抽 PDF 原文 + 评分表)**。
- **arXiv:2606.05043**(Strabo):A2A 的**任务状态机是用散文描述的,约束含糊** —— 与 spec repo **222 个 open issue** 吻合。
- Palo Alto Networks 的 A2A 风险分析:agent-card 欺骗 / 命名 / 发现信任攻击。

### 2.5.5 竞品协议:基本已经出清

| 协议 | 背后 | 核实状态 | 生产使用 | 送达保证 |
|---|---|---|---|---|
| **ACP**(IBM/BeeAI) | IBM Research | 🔴 **作为独立协议已死** —— 2025-08 官方并入 A2A | n/a | n/a |
| **AGNTCY**(Cisco) | Cisco + Dell/Google/Oracle/Red Hat | **从对手转为 A2A 补充**。自家 `acp-spec` 已死(最后 push 2025-05)。活的是 **SLIM**(Rust 传输层,alpha `v2.0.0-alpha.5`,日更) | 厂商宣称 Webex/Swisscom,**外部无法核实** | 🟢 **本表唯一认真做送达保证的**(会话层可靠投递 + MLS 群加密)—— **但仍是 alpha** |
| **ANP** | Gaowei Chang + 中文开源社区 | 活着但小:1.3k star,60 天 21 commit | **无可见生产** | E2EE 消息规范存在,投递语义未经验证 |
| **Coral** | 创业公司 + Solana 代币(**市值 ~$2M**) | 244 star,零星活动 | **无可核实生产** —— 微市值加密 agent 市场,不是标准竞争者 | 链上支付结算,非消息保证 |
| **Agora** | Oxford (arXiv:2410.11905) | 🔴 **作为软件已休眠** —— 最后 push **2025-03** | 无 | 无 |

### 2.5.6 收敛问题的诚实回答

- **标准层面:真的在向 MCP + A2A 收敛。** 证据(非感觉):IBM 把 ACP 并入 A2A;Cisco 放弃自家 connect-protocol、转为 A2A/MCP 基础设施并拿下 A2A TSC 席位;A2A 正在加入 AAIF 与 MCP 同屋。ANP 作为 W3C/去中心化的异类存活,其余**要么死、要么休眠、要么是代币**。
- **使用层面:可核验的采用证据集中在 logo 与 SDK 集成,不是跨组织流量。** 新闻稿里的生产宣称**均无具名**;社区 registry 上可发现的 A2A agent ≈ 15 个。
  > ⚠️ 下载量差(MCP ~25×)是**弱信号,不可直接横比**(见 §2.5.3);HN 上「回去用 agent-behind-MCP」是**轶事**。**两者都不足以支撑「从业者反复选择 MCP 而非 A2A」这个全称命题** —— 已按此收窄。

### 2.5.7 🔴 4c 的直接答案:未发现 Flywheel 当前已知的具名对接方

**本次调研未发现 Flywheel 的任何具名外部对接方。** 可公开核验的证据:社区注册表规模很小(~15 agent);LF 新闻稿细读之下**未具名任何生产部署方**;**所见样本**中的 A2A 使用含**企业内部**形态(一家公司内部把自己的 agent 连起来)。
> ⚠️ 这是**样本观察,不能推断总体分布** —— 我们没有 A2A 使用的普查数据。
> ⚠️ **证明标准(Codex R2)**:以上是「**可公开核验的跨组织证据薄弱**」,**不是**「跨组织联邦从未兑现」或「真实使用全部是企业内部」—— 后两者是全称命题,我们的证据(一个 registry + 一份新闻稿 + 一条 HN 轶事)撑不起。**不采用只需要前者。**

→ **没有已证明的紧迫性。** 现在采用买到的是**标准对齐期权**,**不是任何当下已知的互操作伙伴**。
  > ⚠️ 「A2A 不会死」是**无法保证的预测**(LF + 8 席 TSC 只说明**近期被放弃的风险看起来较低**)。
→ **且 A2A 不带送达保证 → 它不改善 4a 的可靠性维度**(edge adapter 是叠加、不删除内部保证;跨边界要同等保证仍须另加实现)。这层唯一认真的工作(AGNTCY SLIM)仍是 alpha。

---

## 2.6 🔴 HEADLINE —— 治理层:被评估的五个协议都没有,而这正是我们建的那层

**证据等级 A(我自己抽 PDF + 读评分表原文,未经转手)。**

> ⚠️ **这条我坚持自己一手核**,因为它是整份研究的主线 —— 转手别人的转述就是「拿标签冒充事实」。
> **核的过程又抓到小模型第二个错**:WebFetch 摘要说这篇论文「没有提供明确评级 / 没有评分表」。**错。** 论文有完整的 Table III gap matrix,逐协议逐维度分 Supported/Partial/Absent。我 `pdftotext` 抽出来才看到。(第一个错见 §1.4。)

### 2.6.1 论文身份(一手)

- **标题**:*Governance Gaps in Agent Interoperability Protocols: What MCP, A2A, and ACP Cannot Express*
- **作者**:Richard Kang, Yudho Diponegoro / **arXiv:2606.31498**,submitted 2026-06-30
- **方法**:六维治理需求分类法 —— `membership` / `deliberation` / `voting` / `dissent preservation` / `human escalation` / `audit/replay`,逐条对照 spec,分 **Supported / Partial / Absent**。

### 2.6.2 🔴 Table III 原文 —— Governance Gap Matrix

```
 Protocol       G1 Membership  G2 Deliberation  G3 Voting  G4 Dissent  G5 Human Esc.  G6 Audit  Coverage
 MCP v1.1          Absent          Absent        Absent      Absent       Absent       Partial    1/12
 A2A v1.0.1        Partial         Absent        Absent      Absent       Absent       Absent     1/12
 ACP               Partial         Partial       Absent      Absent       Absent       Absent     2/12
 ANP               Absent          Absent        Absent      Absent       Absent       Absent     0/12
 ERC-8004          Partial         Absent        Absent      Absent       Absent       Partial    2/12
```
> 计分:Supported = 2/2,Partial = 1/2,Absent = 0/2,每协议每维度;满分 12(6 维 × 2 分)。

**A2A v1.0.1 的治理得分 = 1/12。`G5 人类升级` = Absent。`G6 审计` = Absent。**

论文 Fig.1 原文:
> "Layer 4 (governance: membership, deliberation, voting, dissent, escalation, audit) is **universally absent**."

结论原文:
> "agent community governance constitutes a **missing architectural layer above** current interoperability standards, **not a missing feature within them**."

### 2.6.3 🔴 两句几乎在描述我们建的东西(逐字)

**A2A 的 G5 判定原文:**
> "**Absent.** No protocol mechanism for escalating to human authority. Task delegation can target a human-backed agent, but this is **routing, not governance escalation with trigger conditions**."

→ 「**带触发条件的治理升级**」正是 FLY-1279 park-watch 阶梯在做的事。论文说**没有协议有这个**。

> ⚠️ **本条的自家事实原写错了(Codex R2 #7 抓出,我复核代码确认)。** 我把 FLY-1279 **plan 文档里提案的**状态名和时序当成了**落地实现** —— 又一次「拿标签(设计稿)冒充事实(代码)」。
> **真实实现(`packages/teamlead/src/StateStore.ts:524-533` 核实):**
> `NEW → LEAD_NOTIFIED → (ACKED | ESCALATED) → RESOLVED`,另有 `CLEARING` 可 TTL rebound 回 `NEW`。**不是**我原写的 `OBSERVED→LEAD_NOTIFIED→FOUNDER_PAGED→CLEARED`。
> **真实阈值(`packages/teamlead/src/bridge/park-watch.ts:107,183` 核实):** N1 与 N2 **默认都是 10 分钟**,且均可由 `FLYWHEEL_PARK_N1_MS` / `FLYWHEEL_PARK_N2_MS` 覆盖。**不是**我原写的「10min → Lead;+30min → founder」。
> **仍然成立的是**:确实存在「按可配置的时间阈值把停滞升级给 Lead、再升级给 founder」的机制 —— 这才是与论文 G5 对照的 load-bearing 事实。

**MCP 的 G5 判定原文:**
> "**Absent.** MCP's Elicitation feature (protocol version 2025-06-18) allows servers to request human input during tool execution, but this is **user-input solicitation, not governance escalation**. There is no protocol-level mechanism for **routing community decisions to human authority based on confidence thresholds or risk assessment**."

→ 「**按置信阈值/风险评估把决定路由给人类权威**」= 逐字描述了 FLY-175 Track 2 的 `FounderConsentEvaluator`(Haiku + per-action-type 阈值 + `founder_consent_audit` 审计表)。论文说**没有协议有这个**。

### 2.6.4 ⚠️ 对我们自己用同一把尺(Lead 要求 —— 这段是防吹的)

**这不能被读成「我们比标准强」。** 精确的说法:

| 维度 | 论文对 A2A/MCP 的判定 | **我们的诚实自评** |
|---|---|---|
| G5 人类升级 | Absent(两者) | ✅ **有** —— 但因为我们**为自己的形状建的**,不是通用件 |
| G6 审计/重放 | A2A Absent / MCP Partial | 🟡 **部分** —— 有 append-only 授权审计 + `founder_consent_audit`,但没做过完整重放 |
| G1 成员资格 | A2A Partial | 🟡 有 config 里的 agent 注册,谈不上协议级 |
| G2 审议 / G3 投票 / G4 异议 | 全 Absent | ❌ **我们也没有 —— 而且不需要**:我们不是投票社区,Annie 是单一权威 |

**必须同时说清的自我限制:**
1. 🔴 **我们的送达层从未跑过跨机器。** 它在**单机、1 个常驻进程**的场景下够用且验过(25/25 QA)—— **不能宣称它是「比 A2A 强的通用件」**。它没被那样测过。
2. 🔴 **我们不是在做标准。** 我们建的是**自己这一台机器上的治理**;论文说的是**通用协议缺这层**。两件事只是**恰好指向同一个空缺**,不等于我们填上了它。
3. 🔴 **这个空缺不是永久的 —— 而且论文预测它可能在 6–12 个月内收窄。**

   > ⚠️ **我原来把这一条写反了 —— Codex design review R1 抓出,核实后确认是我的错(见 §2.7)。**
   > 我原写「论文认为治理属于 **structural gap**(需新架构层),不太可能被下个版本补掉」。**错。**

   **论文 §V.A 原文(`gov.txt:286-294`):**
   > "**Extensible via A2A**: A2A's extension mechanism explicitly supports 'new data, requirements, RPC methods, and state machines'. Governance primitives (G1–G6) **could theoretically be defined as A2A extensions**. The key observation: **no one has done so.** After 6+ months of A2A being publicly available with an active extension ecosystem, **zero governance extensions have been proposed or implemented**."

   🟡 **但论文这句「zero proposed」不能当作无条件的仓库事实直接引用 —— 一手反查发现一个 candidate counterexample(Codex R2 #3 提出,我自己核实)。**

   ```
   $ gh api repos/a2aproject/A2A/issues/1628 --jq '{number,title,state,created_at}'
     {"number":1628,
      "title":"trust.signals[] extension: consolidated signal type specification",
      "state":"open",
      "created_at":"2026-03-13T11:37:17Z"}
   $ gh api repos/a2aproject/A2A/issues/1628 --jq '.body' | grep -c governance_attestation
     6
   ```

   A2A **官方仓库**的 open issue **#1628**(2026-03-13 提出,**早于论文 2026-06-30 的提交日**)提出 `trust.signals[]` AgentCard extension,明确包含 **`governance_attestation`**(prospective authorization、declared scope + evaluator verdict)。

   **精确表述(既不照抄论文,也不矫枉过正成「论文错了」):**
   - ✅ **#1628 没有进入 core 规范**,且**不覆盖 G5 human escalation** → **推不翻 Table III 对已发布 core 的判定**。
   - 🟡 **它是对论文那句「zero proposed」的 *literal / 无条件措辞* 的 apparent counterexample** —— 但它是否满足论文的 community-governance G1–G6 分类,**需按论文 criteria 逐条映射才能判定**,**不能仅凭名字里有 governance 就下结论**。本文**未做**这一步 criteria-level adjudication。
   - 🔴 **因此本文的结论是方法论层面的**:**不能把论文的「zero」当作独立的仓库事实直接引用**。**这不等于论文按其自身 taxonomy 的分类结论有误** —— 那需要另做功课。

   > ⚠️ **方法论教训**:论文的断言也只是**论文的断言**,不能因为它是论文就跳过一手仓库反查。

   → **"Structurally awkward" 论文是说给 MCP 的,不是 A2A。** 对 A2A,治理是 **extensible**。

   **论文 §V.B 原文(`gov.txt:333-340`):**
   > "At the observed evolution velocity, we estimate the governance gap **could narrow significantly within 6–12 months** through protocol extensions, **particularly via A2A's extension mechanism**."

   **修正后的准确表述:**

**A2A v1.0.1 core 的治理现状(最终表述,research 与 plan 一致):**
- Table III 实测:**G1 Membership = Partial;G2/G3/G4/G5/G6 = Absent;合计 1/12**。
- **尚无已接受/发布、且实质覆盖本文相关 `G5 human escalation` 或 `G6 audit/replay` 语义的 extension。**
- 官方 repo 有一个 trust / governance-attestation proposal(**#1628** —— **open issue proposal;无关联 PR/branch;未接受、未发布**;2026-03-13;含 `governance_attestation`),**内容主要是 AgentCard trust / prospective authorization,不覆盖 G5**。
- → **「core / 已发布规范无完整治理层」成立;论文那句无条件的 *proposal-zero* **未获独立确认**(见下方限定)。**

   - ✅ **今天**:上述 core 判定成立。
   - ⚠️ **但**:论文认为 A2A extension **是可行的补齐路径**,并给出 **6–12 个月**的乐观估计。**该估计尚未被任何已发布的 governance extension 兑现** —— 它是预测,不是事实。
   - → **所以「标准里没有这层」是一个有时限的当下观察,不是永久护城河。** 重估触发条件应精确为「**出现被接受/发布、且实质覆盖 `G5 human escalation` 或 `G6 audit/replay` 的 extension**」(已加入 plan.md §3.3 触发条件 #4)。

   **论文自述的 limitations 也要带上**(`gov.txt:373-383`):其分类含判断成分;**只评规范本身,不评在其之上能构建的系统**。→ 即:论文没说「用 A2A 建不出治理」,只说「A2A 的已发布规范里**没有完整治理层**」(`G1 Partial`;`G5`/`G6` **Absent**)。

### 2.6.5 这条对 Annie 的真实意义

她最初的问题是「有没有什么可以直接拿来用的」。这条把问题反过来了:

> **我们真正贵的那层(founder 审批门 + 升级阶梯 + 审计),不是重复造轮子 —— 按论文的六维治理分类,它所评估的五个协议(MCP / A2A / ACP / ANP / ERC-8004)的**已发布规范**在 `G5 人类升级` 上**全部为 Absent**。A2A 合计 1/12。**
> ⚠️ **范围限定**:这是**论文评估的那五个协议**,不是「所有互操作标准」—— 我们没有做过全体协议的普查。

**但配套的诚实话是**:这不是因为我们聪明,而是因为**标准解决的是「不同公司的 agent 怎么互相发现和说话」,我们解决的是「一个人怎么在她睡觉时仍然掌控她的 agent 舰队」。不同问题,所以答案不同。**

⚠️ **而且这层「标准里没有」是有保质期的**:论文认为治理原语**可以**定义为 A2A extension,并预测 **6–12 个月**内缺口可能显著收窄(§2.6.4 第 3 条)。**今天成立,不代表永远成立。**

---

## 2.7 证据审计表 —— 本文被更正过的 claim

**为什么留这一节**:本文的方法论是「回一手核实」,**同一把尺必须能量到本文自己**。

**范围**:本表记录**会改变结论或论证力度的主要更正**,**不是全部更正的穷尽清单**(措辞收窄、定名调整、限定词补齐等未逐条列入)。完整修订史见 review artifact。

**这是审计表,不是 review 对话归档。** 完整 review 记录在 `/tmp/codex-rescue-design-feedback-flywheel-FLY-1283-plan-round{1..5}.md`。

| 旧 claim | 最终 claim | 一手证据 | 防复发检查 |
|---|---|---|---|
| A2A `Role` 只有两方 → **结构上**装不下我们的三方模型 | `Role` 是 **wire 交互方向**,非业务身份;edge adapter 可把整个 Flywheel 暴露为一个 A2A server,内部字段不上 wire。**不做 wrapper 的理由是成本/收益,不是不可能** | `a2a.proto:244` "Defines the **sender of a message**";`a2a-spec.md:135` "on behalf of a user or **another system**" | 引用枚举前先读其**注释定义**,不按名字推语义 |
| 论文判治理为 **structural gap** → 不太可能被补上 | 论文对 **A2A** 判 **Extensible**(对 **MCP** 才判 structurally awkward),并预测 **6–12 个月**可能收窄 | `gov.txt:286-294`(§V.A)、`gov.txt:333-340`(§V.B) | 引用论文结论前**先读它定义术语的那一节** |
| 论文称「**zero** governance extensions proposed」(当独立事实引用) | **core/已发布规范无完整治理层**成立;论文那句无条件的 *proposal-zero* **未获独立确认** —— 官方 **#1628**(open issue proposal,无关联 PR/branch,未接受未发布;2026-03-13;含 `governance_attestation`;不覆盖 G5)是对该 literal 措辞的 **candidate counterexample**。**是否落入论文 G1–G6 分类需 criteria 级判定,本文未做,故不据此判论文 taxonomy 结论有误** | `gh api repos/a2aproject/A2A/issues/1628`(state=open,created 2026-03-13,`governance_attestation` ×6) | 论文的**经验性断言**(数量/现状)必须**回一手仓库反查**,不能因其是论文而豁免 |
| durable+ACK+redeliver+DLQ「**约 200 行**,已写完验过」→ 迁移**按定义**负期望 | 实现**横跨多模块**,量级远超此数;25/25 QA **只证明清单内场景**,不等于跨进程崩溃/重启/跨机器已验证。→ **当前单机形状下迁移不划算**(不是「按定义负期望」) | `git show --numstat 8f6b330b1` → packages/ 下 **+6191 行 / 72 文件**;`lead-event-delivery.ts` = 466 行 | 转写任何数字前**自己跑一遍计数命令**,并把口径写进文档 |
| park-watch 状态机 `OBSERVED→LEAD_NOTIFIED→FOUNDER_PAGED→CLEARED`;「10min→Lead,**+30min**→founder」 | `NEW → LEAD_NOTIFIED → (ACKED \| ESCALATED) → RESOLVED`(+`CLEARING` TTL rebound);**N1/N2 默认均 10 分钟且均可 env 覆盖**。**仍成立**:存在「按可配置阈值升级给 Lead 再给 founder」的机制 | `StateStore.ts:524-533`;`park-watch.ts:107,183` | 描述自家实现**读代码**,不读同 issue 的**设计稿** |
| `AUTH_REQUIRED` ≈ founder 审批门 | `AUTH_REQUIRED` = **authentication**(认证),**非 authorization/审批**。仅 `INPUT_REQUIRED` 与我们的门**形状同构**,非语义对应 | `a2a.proto:200,206` | 映射语义前读原文定义;**自检与已引证据是否打架**(若 A2A 真有审批语义,G5 就不会是 Absent) |
| 生态中**不存在**跨组织对象;「收益为零」;采用 A2A 是「净退步」 | **未发现 Flywheel 的当前已知具名对接方** → 直接互操作收益**未被证明**、不足以支付成本。edge adapter 是**叠加**不删除内部保证 → A2A **不改善** 4a 可靠性维度(非「让我们变差」) | LF 新闻稿未具名部署方;registry ~15 agent(**不穷尽**公开服务);下载量**不可直接横比**;HN 是**轶事** | **未能验证 ≠ 不存在**。结论只用它需要的最低证明标准 |
| AgentCard `signatures` = 可抄的跨组织信任 | signature **只证明持钥者签过**;key 信任 / 组织绑定 / 轮换 / 撤销**都不在字段里** | `a2a.proto` AgentCard;A2A 威胁建模(arXiv:2602.11327:agent-card 无 issuer-bound provenance) | 区分**数据完整性**与**身份信任** |
| §2.7 自称「已修」 | 前一版只在**出错处**加了更正框,旧结论仍留在**后半段总结/判定/行动表** —— 同一 memo 对同一证据给出互斥结论 | Codex R2/R3 逐行指出 | **按 claim 全局扫描 + 人工看语境**,不只看命中数;修完 **re-grep 验归零**(命中只允许存在于明确标注的勘误区) |

### 根因(一句话)

以上每一条都是同一件事:**把「关于事物的描述」当成了「事物本身」** —— 论文结论的措辞 ≠ 论文的定义;子调研的转述 ≠ 仓库的计数;设计稿的状态名 ≠ 落地的代码;「我已修」的声称 ≠ 文档的实际状态。

**本文在 §1.4 因回一手核而抓到 DR 与 WebFetch 小模型各一处错。上表说明:同一纪律必须施加于本文自己的每一句转述。**

---

## 3. 业界 agent 消息语义盘点(证据等级 B — 真·源码级)

**方法**:真 clone 仓库读源码,不看博客/营销页。核实 commit(2026-07):
`openai-agents-python@697a46c4` · `swarm@6af0b4ca` · `langgraph@49ae27c2` · `autogen@027ecf0a` · `agent-framework@f4e49958` · `crewAI@5dba2ef6`

**要回答的唯一问题**:agent A 给 agent B 发消息时,机械上到底发生了什么,有没有任何持久性?

### 3.1 逐框架结论

| 框架 | 「消息」物理上是什么 | Durable | ACK | 自动重投 | DLQ |
|---|---|---|---|---|---|
| **OpenAI Agents SDK / Swarm** | 🔴 **一行局部变量赋值** | ❌ | ❌ | ❌ | ❌ |
| **LangGraph** | 进程内对象写进特殊 channel | 🟡 **仅状态快照** | ❌ | ❌ | ❌ |
| **AutoGen (core)** | 单进程 `asyncio.Queue` 上的信封 | ❌ | 🟡 仅 RPC 语义 | ❌ | ❌ |
| **MS Agent Framework** | 进程内 dict + superstep | 🟡 快照(含未投递消息) | ❌ | ❌ | ❌ |
| **CrewAI** | 🔴 **同进程同步方法调用** | ❌ | ❌ | ❌ | ❌ |

### 3.2 OpenAI Agents SDK —— handoff 就是换个变量

`src/agents/run.py:1018-1030`:
```python
elif isinstance(turn_result.next_step, NextStepHandoff):
    current_agent = turn_result.next_step.new_agent
    continue
```
`NextStepHandoff` 就是 `class NextStepHandoff: new_agent: Agent[Any]`(`run_steps.py:155`)。

→ **根本没有「发消息」这回事。** agent B 拿到的就是同一个内存里的对话 item 列表当作下一次模型输入。「handoff」= **谁拥有这个 loop** 的一次局部变量重赋值。Swarm 更粗:`active_agent = partial_response.agent`(`core.py:221`),**什么都不持久化**。

`Session` 有持久化,但 protocol 自己写明是**只存对话历史**("Session stores conversation history",`memory/session.py:14-19`);grep 确认 `memory/` 里**零**处引用 `RunState`/current-agent。→ **持久的是内容,不是投递。**

### 3.3 🔴 LangGraph —— 关键区分:checkpointer 不是送达保证

这是本节最重要的一条,也是最容易被营销话术混淆的一条。

**事实**:配了 checkpointer + `durability="sync"|"async"` 后,每个 task 的写入(含 TASKS channel 上的 `Send` 包)会经 `checkpointer.put_writes` 持久化(`pregel/_loop.py:415-494`),落进真表(`checkpoint_writes` / `writes`)。

**但这是「状态快照 + 客户端主动重放」,不是「持久化投递」:**

| 问 | 答(源码) |
|---|---|
| 有 ACK 吗? | ❌ **没有 ACK 协议**。功能上的近似是重放时跳过已完成的 task —— `_runner.py:746` 注释原文 `# if it already ran, return the result`(用存下的 writes 伪造一个已完成 future)。**那是 checkpoint 记账,不是接收方确认。** |
| 崩溃后会自动重投吗? | ❌ **没有任何东西会自己重投。** 进程死在 superstep 中间,pending 的 `Send` 就躺在 checkpoint 表里,**直到有客户端拿同一个 `thread_id` 显式重新调用 graph**。 |
| 重放语义? | `interrupt()` 文档原文:"The graph resumes from the start of the node, **re-executing** all logic"(`types.py:824`)→ **节点 at-least-once 重执行**,节点内非幂等副作用会重复。 |
| DLQ? | ❌ 全仓 grep 无。毒消息让整个 run 失败,checkpoint 保住 thread 可恢复,但**没有任何东西隔离这条消息**。 |
| 默认档安全吗? | `durability="async"` 明写是"persisted **asynchronously while the next step executes**"(`types.py:87-93`)→ **崩溃会丢最后一步的 writes**。 |

→ **README 的 "infrastructure for durable execution" 只在「workflow 可重放」意义上成立。没有 broker、没有 ACK、没有自动重投;恢复 = 客户端发起的重放。**

### 3.4 AutoGen —— 分布式运行时直接把消息丢掉

- **已进维护模式**:README 原文 CAUTION —— "AutoGen is now in maintenance mode... New users should start with Microsoft Agent Framework"。
- 核心是单进程 `asyncio.Queue`(`_single_threaded_agent_runtime.py:257`)。`save_state()` 只存 **agent** 状态,且自己承认 "This method does not currently save the subscription state";**在途消息从不保存**。
- 🔴 **gRPC 分布式运行时**:目标未注册时**直接丢消息**:
  ```python
  logger.error(f"Agent {request.target.type} not found, failed to deliver message.")
  return
  ```
  (`_worker_runtime_host_servicer.py:236-242`)。**无持久化、无重投、无 DLQ。** 客户端里还留着 `# TODO: catch exceptions and reconnect`(`_worker_runtime.py:282`)。

### 3.5 MS Agent Framework —— 唯一真持久的路是外包给 Azure

- 核心 workflow 引擎:`InProcRunnerContext.send_message` → `self._messages[...].append(message)`(内存 dict)。
- 有 checkpoint,且**确实包含未投递消息**(`WorkflowCheckpoint.messages`,`_checkpoint.py:79`),但**只在 superstep 边界写**(`_runner.py:168`)→ superstep 中间崩溃全丢,重启重跑该 superstep。ACK/自动重投/DLQ 全无。
- 🔴 **唯一真正 durable 的路径**是 `agent_framework_durabletask` —— 把 agent 托管到微软的 **Durable Task**(外部事件溯源编排服务)。**那份 durability 来自外部的 Durable Task hub,不是 MAF 自己的消息总线。**
  > (Durable Task 内部本轮**未追踪**,该层仅 verified-from-docs —— 明确标注。)

### 3.6 CrewAI —— 失败被静默转成一个字符串

`base_agent_tools.py:46-124`:委派 = **同进程同步方法调用**(字符串匹配 coworker 角色名 → 构造 `Task` → `return selected_agent.execute_task(...)`)。「消息」= 任务描述字符串,「回复」= 返回值。

🔴 **失败处理比「没有」更糟**:
```python
except Exception as e:
    return I18N_DEFAULT.errors("agent_tool_execution_error").format(...)
```
→ **崩掉的委派变成一句错误英文,当作 tool 结果回给委派方 LLM**,指望模型自己注意到并重试。

### 3.7 🔴 §3 的总结论

**五类被调查框架(六个项目)没有一个有「带 ACK/重投/DLQ 的持久化 agent 间消息通道」。一个都没有。**

最强的两个(LangGraph checkpointer / MAF checkpoint)是 **workflow 状态快照 + 客户端发起重放** —— 恢复 = 「有人重新调用时,从上个快照重跑这一步」,节点 at-least-once 重执行、副作用不去重。**这与 broker 式持久化投递(先持久化再投递 / 消费者 ACK / 自动重投 / DLQ)是根本不同的保证,没有一个框架提供后者。**

### 3.8 ⚠️ 对我们自己用同一把尺(Lead 要求)

子调研的收尾原话是:「Flywheel 的 `flywheel-comm` mailbox dual-write + CommDB 审计已实现 persist-before-wake,比这些框架原生提供的投递持久性都强」。

**这句话要按精确边界收下,不能扩大:**

| ✅ 可以说 | ❌ 不能说 |
|---|---|
| 在**「agent 间消息是否先落库再唤醒」**这个具体问题上,我们的 persist-before-wake 确实比「局部变量赋值」(OpenAI)/「同步方法调用」(CrewAI)/「丢消息 + logger.error」(AutoGen gRPC)更强 | ❌「我们的总线比这些框架强」—— 它们解决的是**编排**,我们解决的是**跨进程 agent 生命周期**,可比性有限 |
| 这些框架**没有**我们的升级阶梯/死 agent 检测/clean-retry | ❌「我们是更好的通用件」—— **我们的送达层从未跑过跨机器**,没被那样测过 |
| LangGraph 的 checkpointer 与我们的 durable queue **不是同一种保证** | ❌ 把 LangGraph 说成「没有持久化」—— 它有,只是**是另一种**(状态快照,非投递) |

---

---

## 4. 开源「agent mailbox / agent bus」组件(证据等级 B)

**问题**:有没有现成的能**直接采用**,替掉我们手搓的这层?

### 4.1 类别 A:agent 专用的持久化消息组件

🔴 **诚实结论:没有一个是生产级、可直接采用的持久化 agent mailbox。**

| 候选 | 是什么 | 运行成本 | 四要素(durable/ACK/redeliver/DLQ) | 2026 维护? | 判定 |
|---|---|---|---|---|---|
| **AMQ** (avivsinai/agent-message-queue) | Maildir 风格本地 agent 总线 | **零守护进程**(纯文件系统) | 四要素基本齐 | 是,v0.43.1 (2026-07-14) | **wrong-shape** — 71 star / 单维护者 / 自述「for local development, not distributed production」。拿它换掉我们验过的 SQLite 总线 = 平移,不是升级 |
| **A2A** | 互操作**协议规范** | N/A(规范;传输还得自己建) | **不强制任何一项** | 是,v1.0.1 (2026-05-28) | **wrong-shape** — 是 wire protocol 不是 mailbox |
| **AGNTCY SLIM** (Cisco/LF) | agent 协议的 gRPC 传输层 | **独立 SLIM node + controller 进程** | 传输可靠性;非 mailbox 契约 | 是 | **wrong-shape + overkill** |
| **AMP** (agentmessaging/protocol) | 「给 agent 的 email 地址」协议 | 规范 + CLI;provider "coming soon" | 规范声称有队列;**无可见实现** | 勉强 — v0.1.2 **draft**,28 star | **wrong-shape** — 接近 vaporware |
| **AutoGen / MS Agent Framework** | 微软多 agent 框架 | 框架 | 内存态运行时;**持久化外包给 Azure Durable Task(云服务)** | AutoGen 已进 **maintenance mode**,被 Agent Framework 1.0 取代 (2026-04) | **wrong-shape** |

🔴 **最有说服力的一条:连微软都把持久化外包给 Azure Durable Task。**
业界批评见 Diagrid《Still Not Durable: How Microsoft Agent Framework and Strands Agents Repeat the Same Mistake》。

→ **在本次调查的这几个框架/协议里,持久化投递都是留给实现者或外包给云服务的。** 我们手搓不是异类。
> ⚠️ 「人人手搓 = 行业现状」是**基于五类框架 + 七个协议的归纳**,不是全行业普查 —— 按证据强度只能说「在已调查范围内,无一例外」。

### 4.2 类别 B:通用持久化基础件

**关键列是「运行成本」——我们的约束是:一台机器、无 ops 团队、每加一个 daemon 就是一个凌晨 3 点没人重启的崩溃点。**

| 候选 | 运行成本 | 四要素 | 2026 维护 | License | 判定 |
|---|---|---|---|---|---|
| **Temporal** | **服务集群 + 持久化 DB + workers**(多 daemon) | 全 ✓ | 是 v1.31.x | MIT | **overkill** — 无 ops 团队的凌晨传呼机 |
| **Restate** | **+1 常驻服务**(单二进制) | 全 ✓ | 是 v1.7.2 | 🔴 **BSL 1.1 —— 不是开源**(4 年后转 Apache-2.0) | **overkill** + license 陷阱 |
| **NATS JetStream** | **独立 nats-server daemon** | durable/ACK/redeliver ✓,DLQ 自己搞 | 是 v2.14.3 | Apache-2.0 | **overkill** — daemon 里最不坏的,但仍是新增故障点 |
| **Redis Streams / BullMQ** | **Redis daemon** | ✓,DLQ 自己搞 | 是 | 三重许可 / MIT | **overkill** |
| **pgmq / pg-boss / River / Graphile** | **Postgres daemon** | 基本齐 | 是(pg-boss v12.26.0 很活跃) | 各异 | **wrong-shape** — 要求把 SQLite 换成 Postgres |
| **DBOS Transact TS** | 进程内库 **但要 Postgres** | ✓ | 是 v4.23 | MIT | **wrong-shape** — 架构对(库、无 daemon),数据库错 |
| **Absurd** | 一个 SQL 文件 + 薄 SDK,**为 agent 而建** | checkpoint/retry/resume ✓ | 是 v0.4.0 | Apache-2.0 | **wrong-shape today**(Postgres-only;SQLite 移植只是 Simon Willison 的 PoC)—— 但**哲学上最接近我们**,值得偷思路 |
| **Oban** | Elixir;**有 SQLite3 引擎** | ✓ | 是 v2.23.0 | Apache-2.0 | **wrong-shape**(Elixir)—— 但**证明「进程内 SQLite 队列」这个形状是正当的** |
| **Node 的 SQLite 队列库**(better-queue / sqliteq / workmatic) | **零 daemon(同形状!)** | 各异 | 🔴 better-queue **2022 年就死了**;sqliteq **2026-03 才生**,2 个 release,单维护者 | MIT | **形状对、成色不够** — 每个维护中的同形状库都比我们现有的更年轻、更没验过 |

### 4.3 🔴 判定:没有任何候选值得替换

论证(四条,基于证据):

1. **所有成熟选项都让我们的运行形状变差。** 要么 **+1 常驻 daemon**(NATS/Redis/Temporal/Restate/Hatchet),要么 **把 SQLite 换成 Postgres**(pgmq/pg-boss/DBOS/Absurd)—— 而 Postgres 也是 daemon,只是穿了数据库的皮。我们现在是 **1 个常驻进程(Bridge)+ 0 个服务器**。**没有一个候选能保住这个形状。**
2. **唯一同形状的(Node 进程内 SQLite 队列库)更年轻、更少验证。** 维护中的都是几个月大 + 单维护者;流行的那个 2022 年就死了。拿它们换掉已通过 FLY-1279 QA 清单的实现,**收益不明而风险明确**。
3. **现成队列给不了我们真正贵的那部分。** 它们提供 durable+ACK+redeliver+DLQ;**给不了**的是**升级阶梯状态机、死 agent 检测、clean-retry 语义** —— 那是领域逻辑,采用任何队列后都得**在它上面重新实现一遍** → 采用 = **换掉通用的那部分、保留要自己写的那部分,再附赠一次迁移**。
   > (行数口径见 plan.md §3.1:FLY-1279 单提交在 `packages/` 下 +6191 行/72 文件;**不存在「约 200 行」这回事**。)
4. **类别 A 证明我们没错过任何班车。** agent 基础设施界收敛到的协议(A2A)**明文把持久化留给实现者**,而认真的框架(MS Agent Framework)**把它外包给云服务**。**本次调查未发现一个我们正在偏离的「agent mailbox 标准」。**(未发现 ≠ 不存在。)

**未来重估的触发条件**(不是现在行动的建议):若 Flywheel 真的走向**多机**或**跨组织联邦**,首选重估 **pg-boss**(Node 原生、四要素齐、MIT、很活跃)或 **NATS JetStream**(单二进制 broker、Apache-2.0)。**都不值得预先采用。**

**可以白拿的思路**:Absurd 的设计(把持久化逻辑下沉进 SQL、薄 SDK、agent-loop 当单步 workflow)和 goqite 的 visibility-timeout schema,若将来要做 checkpoint 式长任务,可直接translate 到我们的 better-sqlite3 层。

---

## 5. 架构判断

### 5.1 送达保证是不是 wire format 能解决的问题?

**不是。而且这不是我的意见 —— 是 spec 自己说的。**

论证链(每一环都有原文):

1. A2A **明文免责**:「Messages MUST NOT be considered a reliable delivery mechanism for critical information」(§1.3)。
2. A2A **在断线投递这个问题上**已核到的硬保证只有 **active stream 的事件顺序**,不是**消息补送**(§1.4)。(spec 全文有 162 处 MUST,「唯一硬保证」按字面不成立 —— 此处限定为传输可靠性维度。)
3. A2A 的 push 「Server Guarantees」只到**尝试**义务,重试是 MAY、放弃也是 MAY(§1.4)。
4. MCP 的 scope 里**没有 agent↔agent**;其 `durable` 只存在于 **experimental** 的 Tasks 扩展,且是**任务句柄**不是消息投递(§2)。
5. 两个协议在「长任务句柄」上独立收敛,**但都没碰可靠投递**(§2.3)。
6. 业界:协议把持久化留给实现者,框架外包给云服务(§4.1)。

→ **送达保证是队列/传输/持久化层的性质,不是 wire format 的性质。** wire format 规定「消息长什么样」;送达保证规定「消息没送到时系统怎么办」—— 后者需要**状态 + 时间 + 重试驱动**,一个信封格式里装不下这些。

**这正是我们进场假设 2 的内容 —— 被 spec 原文证实,且比假设更强**(我们假设「spec 没写」,实际是「spec 明确免责」)。

### 5.2 A2A 值得偷的东西(公平面,不能只有否定)

| A2A 的东西 | 对我们的价值 | 落点 |
|---|---|---|
| **Task 生命周期**(`INPUT_REQUIRED` 这个 interrupted state) | 🟡 **形状上印证了我们的门设计** —— 一个跨 150+ 组织的标准独立收敛到「任务会被中断等外部输入」,说明这个**形状**是通用的 | 认知价值,非代码 |
| **AgentCard**(discovery + `signatures` + `skills` + `security_requirements`) | 🟢 **若真走跨组织,这是该抄的部分** | 4c |
| **Message / Role 模型** | 🟡 **结构上可承载**(§1.5:`Role` 是 wire 方向;内部字段本就不上 wire)—— 但**没有当前已知对接方,收益未被证明** | — |
| **送达保证** | 🔴 **它没有**(§1.3) | — |

> ⚠️ **表中已剔除 `AUTH_REQUIRED`**(见 §1.6):它原文是 **authentication**(认证),**不是 founder 审批(授权)**;把它算进来会与论文 G5=Absent 的判定打架。

---

## 6. 明确标注:未能从一手来源核实的

- ChatGPT DR 全文(38 引用)**未取到** —— 报告渲染在跨域 iframe,↓ 导出菜单吃不了合成点击。已按 Lead 判断**不动 Annie 的手**(边际价值只剩广度,且我的一手来源路线质量更高)。DR 的**执行摘要**已从截图读到,与我的独立 grep 结论一致,**仅作交叉印证**。
- Temporal / Redis 的 release 日期:子调研报告页面解析部分乱码,已标注。
- Redis license:未能从 release 页完整核实。
- AGNTCY SLIM 的 durability 语义细节:未能详细核实。
