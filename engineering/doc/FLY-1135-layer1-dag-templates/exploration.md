# FLY-1135 低层 DAG 模板引擎 — 探索

Issue: FLY-1135 (https://linear.app/geoforge3d/issue/FLY-1135/build-layer-1-per-task-category-dag-templates-fly-1020-prd-eng)
日期: 2026-07-13
基于: 无

> 状态:**进行中(brainstorm relay loop)**。本文档是设计阶段的活记录:每轮 Annie 反馈(经 Tadashi
> relay)都折进来;收敛后产出 research.md + plan.md 走 Codex design review。

---

## 1. 任务定向(必读 — Lead 直令覆盖 issue 描述的默认流程)

Issue 描述 = FLY-1020 PRD 的 build 伞单。但 Linear 上有 **Tadashi 2026-07-13 直令(comment 14324902,
Annie 拍板「可以开 1135」后下发)**,把设计范围重构成:

1. **第 0 步(先行):Deep research** — 业界 multi-agent 编排 / DAG 设计调研(LangGraph / Temporal /
   Airflow / Prefect / Dagster / AutoGen / CrewAI / OpenAI+Anthropic 官方模式 / 生产级 agent-pipeline)。
   四个焦点:(a) 图=数据还是代码,各家怎么选 (b) 节点交接的凭证/契约怎么做、怎么过期
   (c) 静态图与运行时改图怎么共存 (d) 失败/重试/人审节点怎么表达。产出对比表 + 每家可借鉴机制。
   Annie 原话:「multi-agent 的编排其实已经是很多人做过的东西了,如果谁做得比较好的话,我们可以直接
   去参考,不需要完全由自己去思考这个 system design 要怎么做。」
2. **第一章:边的契约** — 吸收 FLY-1204+FLY-1221 重设计:「**谁有权声明一个事实(QA 通过/批准),
   声明什么时候过期**」,fail-closed。验收线 = origin/fly-1204-split 上的
   REDESIGN-ACCEPTANCE.fly1204-ship-gate.test.ts(故意红的测试,变绿 = 重设计完成)。
   1204/1221 将来靠「现有流水线迁到新契约」关单。
3. **第二章:静态 DAG = 配置数据** — 图=声明式清单,引擎只执行数据;三段式迁成模板 #1;
   改流程 = 改配置不发 PR。模板保持 **LIGHT / 默认 / 可覆盖**(Annie 红线)。
4. **明确不做**:高层编排(FLY-1043,推后期)、花名册(FLY-1141,最后)、动态(静态先跑一段时间
   验证后 Annie 再定)。

工作方式:brainstorm slide 从 [FLY-1043] thread 转场到本单 thread 继续 —— v3 起在这里迭代
(起点 = v2 + Annie 全部反馈);设计收敛(她点头)后才进 plan → Codex design review → 切子单。
**在 brainstorm 收敛之前,不写任何模板/引擎代码。**

## 2. Annie 的输入(逐字,2026-07-13,经 Tadashi relay)

对 v2 slide 九张卡的表态:

| 卡 | 表态 | 关键原话 |
|---|---|---|
| 0️⃣ 1224+1225 跨厂商三段式 | 认可 | — |
| 1️⃣ 泛化换模型 | 认可 | — |
| 2️⃣ 边的契约 | 认可 | 问 1204/1221 重设计与 1135/1141 是否重合 → Tadashi 答「并进 1135 当第一章」,她接受 |
| 3️⃣ 静态=配置数据 | 接受(拍板做法 1) | 「我也觉得静态是一个要做对姿势的部分,所以我们可能需要做 deep research,去看看其他人是怎么设计 DAG 的」 |
| 4️⃣ 高层编排 | 推后期 | 「它对静态底层 DAG 其实没有影响,对吧?那这个东西可以放在比较后期的时候再去做」 |
| 5️⃣ 动态 | 推迟决策 | 「我们需要把静态先跑一段时间,看看它跑的是不是足够好,再决定要不要做动态。我们现在的目标是要把静态做得足够好」 |
| Q1 契约先行 | (取舍随 1043 推后而消失) | — |
| Q2 三段式大修 | = 2️⃣+3️⃣ | 「之前的三段式,我理解是我们 hardcode 写了一个三段式,但是我是想直接把它转成这个 DAG。那以后管它什么三段式、四段式还是两段式,只要我们这个 DAG 设计得足够好,都是可以很灵活地接入进去的」 |
| Q3 花名册 | 最后 | 「这个不是重要的东西,暂时可以排在最后」 |

另两条相关拍板(别处,设计时当不变量):

- **① 1224 与 1135 的关系**:FLY-1224 解放节点属性 **{vendor → model → effort}**,FLY-1135 解放图结构;
  **1224 的数据模型原样成为模板里节点的字段**。
- **② 跨厂商审稿规则**(进 1224,但模板设计时记为不变量):**作者厂商 ≠ 审稿厂商,双向;
  同厂商自审在门校验层硬拒**。

### 2.1 Annie 实时增量(2026-07-13 18:25–18:35Z,经 Tadashi relay;v3 审阅中)

1. **Deep Research 定义纠正(18:25Z)**:step-0 的调研 = **ChatGPT Deep Research 产品本尊**,
   不是自己跑多路 web 调研。原话:「就是我说的 Deep Research,你是要用那个 ChatGPT 的 Deep
   Research,不是说你自己去跑一个 Deep Research」。→ 已按 deep-research skill 开跑
   (conversation 6a55301c);4 路 sweep 降级为 DR 提问备料。
2. **调研章 = 两份结合(18:33Z)**:「你把 ChatGPT 做的 Deep Research 和他自己做的 Deep Research
   做一个结合,给我出一个可互动的 HTML」→ v4 调研章:两边一致 = 高置信共识;有出入/单边覆盖 =
   明确摆出(哪边说的、为什么可能不同);引用可点。
3. **homerail 先行研究是 (c) 焦点的已验证锚点(18:35Z)**:FLY-1020 PRD §5.5 有 HL firsthand
   读码对照表(issue 里 inject/fork/profile 三个运行时能力即从它借);FLY-353/1022/1005 亦有提及
   (FLY-1005 §73 验证过其 Manager/hub 架构)。v4 的「静态与运行时改图共存」小节以它为锚,
   与 DR/sweep 的 LangGraph、Temporal patching 等并排。
4. **回环是第一等构件(18:35Z,设计硬要求)**:她的原话:「我们现在所谓的静态……它也不是完全按照
   这个顺序去跑的。我们不是也会出现 Implement 做了、QA 测出问题,然后 Implement 还要再改,从而
   run in the loop 的情况吗?」→ ① 模板语言原生表达回环:带条件回头边(QA FAIL → implement)+
   显式出环条件(PASS)+ 轮数上限 + **超限升级动作**(escalate 给 Lead/founder);今天硬编码的
   QA-FAIL→fix→re-QA belt/epoch 迁成这条声明式回头边(昨晚 bug 高发地,声明化即修复的一部分)。
   ② **「静态」的精确定义 = 结构+规则事先声明(含回环),路径运行时按结果走 —— 结构静态、路径
   动态**,要在 v4 里讲给她。③ 业界章对齐 cycles-first(LangGraph 显式带环)vs strict-DAG
   (Airflow 类无环、表达不了打回)两派,我们选带环派的论证放明面。④ 模板 #1 示意 YAML 必须画出
   回头边,不许三节点一条直线。

### 2.2 Annie 对 v4 的 paste-back(2026-07-13,经 Tadashi relay f3788859)

**已定(进设计,不再讨论)**:
- **Q1 = A**:单次派发覆盖权 Lead 全权(能力仍永不可覆盖)。
- **Q2 = 首批三个模板**:工程三段式 + product 模板 + 裸单 session(她原话:这些就是我们
  actively 在用的东西)。product 模板形态参照 FLY-1038 dashboard PRD 反映的现状
  (~45 轮逐屏共创 → PRD → prototype → 交付 build task;单文件角色、无代码 QA),
  HL 的 product 侧输入随后由 Tadashi 转来,v5 等它到了再发。

**她的三个新设计问题(v5 必须回答;④ 与 ① 合并)**:
1. **图数据存哪**:「你是要做一个 Database,还是要怎么样去做?这个数据的点和边都存在哪里呢?」
   → 存储设计:DB vs repo 文件、版本怎么钉、谁有写权限(Airflow serialized-DAG-to-metadata-DB 先例)。
2. **运行时动态状态的记录**:「目前跑到哪个点了、在哪个边交接了,这一部分也需要做记录」
   → run-ledger 设计(现有 sessions/three_stage_turn 是雏形)。
3. **Dashboard 联动 + 热部署**:「我今天在 Dashboard 上把某个节点的模型从 Claude 改成 GPT 之后,
   系统可以直接 Deploy 生效,而不需要我们去搞一堆重启」→ 工程事实:今天配置 boot 时载入
   (1224 kill-switch 的重启坑);**manifest 住 DB + 引擎每次派发时读 ⇒ 热生效免费** ——
   这本身就是「图=数据库数据」的强论据;版本语义按 DR 共识(改=新 revision,在跑 run 钉旧版)。
4. 第一章凭证的存储(记录表、谁写、怎么过期)与 ① 合并讲,别让她猜术语。

**FLY-1038 dashboard PRD 的同构印证**(product/doc/FLY-1038-unified-management-dashboard/prd.md):
§6 SSOT 硬要求(前端直读干净后端 SSOT、回路里零 LM 手工汇总、后端新增自动出现、写回=统一提交流
落盘)⇒ 模板/注册表住 DB = Dashboard 的 DAG tab 直读直写同一 SSOT;§5.2 三级级联(公司→型号→
effort)= {vendor, model, effort} 字段的 UI 形态;§5.3 每个 DAG stage 模型可改 = 写新 revision。

### 2.3 收敛记录(v5/v6 → lgtm)

- **v5**(msg 1526308868475322379):存储三问设计 + HL 三块输入(run-ledger 展示合同 /
  编辑三级矩阵 / product v1)。Annie 反馈:要一节「数据库长什么样」实物示例
  (「你是不是得给我一个 DB 的 example 让我去看呢?」)。
- **v6**(msg 1526310646210367538):加 🗄️ 实物示例节 —— 现状参照两行真实数据
  (messages + codex_review_record)+ 模板表 + 版本表前后两行(Dashboard 改模型演示)+
  run_42 完整流水(回环 + 终点闸在数据里的样子)+ 折叠 DDL。
- **✅ 2026-07-13 Annie 验收**(经 Tadashi relay cf94340a 的回复):
  「**lgtm 那 1135 这条就要开始做了吗?**」—— 设计收敛,进 Codex design review。
  六版迭代 · 一次 ChatGPT DR(7m/21 引用)· Annie×HL×eng 三方收敛。

## 3. 现状地图(2026-07-13,核过码;行号以当前 main 为准)

### 3.1 spec 底座:FLY-1020 PRD(Codex APPROVED,6 轮)

`engineering/doc/FLY-1020-workflow-templates/prd.md` 已给出:三层架构(YAML 形状 / 节点类型注册表 /
Markdown 不动)、`generic` 节点(agent.md 参数化、物理安全性质:frontmatter 在派发路径 inert)、
物化 workflow snapshot(§7)、workflow-aware ship gate(§8)、Gate A(substrate)→ Gate B(行为迁移)
交付顺序、sentinel S1-S16。**本设计不重写 PRD,只在其上叠加直令的两章重构 + 业界调研修正。**

### 3.2 三段式硬编码面(PRD §2.2/§2.3b 已审计,本轮复核仍成立)

- `three-stage-phases.ts`:类型+固定序列+`isThreeStagePhaseRole`+`resolveCompletionSessionRole`+
  `nextPhase`+badge —— 六职责单文件,是「hardcode 三段式」的单一真相源。
- `design|implement|qa` 贯穿 8 个生产面(role 枚举/查询/反查/展示/TURN recovery/completion sinks/
  ship 收尾/retry+启动对账);**未知 role 静默归一成 main = 数据损坏陷阱**(任何 node-id 落库必须
  fail-closed)。

### 3.3 边的契约的两个结构性洞(fly-1204-split 红测的机器定义)

红测不变量:**ship 的 head 必须有「对着这个 head」通过的 QA**。今天做不到,因为:

1. **`qa_required` 是写一次快照**(StateStore `WHERE qa_required IS NULL`,本轮核实 :4082),
   head 会动:对 H1 写下的 0(豁免)在 QA FAIL、head 前进到 H2 之后**改不回来**;
   `evaluateQaShipGate` 把 0 读成直接放行 → 对 QA 从没见过的 head 放行。单向门装不下会过期的事实。
2. **QA verdict 是 runner 自声明**:`qa-result.ts` 的 `prHeadSha`「Defaults to git HEAD」
   (QA runner 自己的 HEAD),所有 runner 共享一个 ingest bearer,CLI 把 `--exec-id` 和 `--pr-head`
   都交给调用方 → 任何 runner 可为任何 head 声明 PASS。意见箱,不是门。

**founder-approval 侧同病**(FLY-1221,本轮核实在 main 原样成立):`founderApprovalHoldGuard`
自述「EVERY founder approval source」,实际只有 plugin.ts 一处真调用;`actions.ts approveExecution`
零 hold 检查;`voice-routes.ts:108` 与 `founder-ship-approval-handler.ts:174` 是**描述保护的注释,
不是保护** —— 两段替 guard 站岗的文字。

### 3.4 fly-1204-split parked 分支(未挂 PR,~10 commits / 4255 行)

昨晚 implement runner 在爆炸半径内做过的**部分**边契约动作,已从 #571 拆出、停在分支上:
PR-head ownership 决定 Codex gate(去 role allowlist)/ retry admission 按 worktree 不按 role 标签 /
qa 段拥有自己的 PR head / ship 豁免站在 EVIDENCE 上不站 marker / 红色验收测试。
**设计输入,不是既成事实** —— 第一章要决定:哪些原样吸收、哪些按新契约重做。

### 3.5 引擎落点的四个环境事实(前任 FLY-1043 runner 审计,经 Lead 转达)

1. **dispatch 双入口**:PhaseOrchestrator / auto-QA 直调 `RunDispatcher.start`,绕过
   `/api/runs/start` 的 DepartmentRegistry+admission 边界 → 引擎接入点必须选 HTTP 边界才白拿
   dept-scope 校验。
2. **没有持久派发队列**(仅内存 inflight + sessions 表)。
3. `DagNode` 生产面只用 `node.id`(dag-resolver 收缩迁移极小)。
4. 可复用底座:fleet_pressure_hold / xhs-scheduler / FounderConsentEvaluator。

## 4. 设计方向骨架(v3 slide 的骨架,随 relay loop 收敛)

- **第一章 · 边的契约**:每条边 = 一个「声明」(claim):谁签发(issuer,绑定节点身份而非共享
  bearer)· 对什么签发(subject = 内容寻址,git head SHA / 产物 hash)· 何时失效(subject 变更即
  失效 + 显式过期)· 谁核验(服务端,在**使用时**核验而非声明时)· 失效默认不放行(fail-closed)。
  founder 批准与 QA PASS 是同一契约的两个实例。红测变绿 = 章验收。
- **第二章 · 静态 DAG = 配置数据**:FLY-1020 三层架构承接;节点字段吸收 1224 的
  {vendor, model, effort};跨厂商审稿不变量进模板门校验;三段式迁成模板 #1(行为逐字等价 sentinel);
  N 段式 = 改清单不改代码(Annie Q2 的原话诉求)。
- **业界怎么做**(deep research 进行中,4 路并行):LangGraph/AutoGen/CrewAI · Temporal/durable
  execution · Airflow/Prefect/Dagster · OpenAI+Anthropic 官方模式 + n8n/Dify(graph-as-data 生产系统)
  + GitHub required checks / SLSA attestation(「授权者对内容签发的可过期声明」业界标准形)。

## 5. 开放问题(随 relay loop 更新)

1. deep research 四路结论 → 对比表 + 可借鉴机制(待研究 agent 返回,折进 research.md + v3 业界章)。
2. 第一章对 fly-1204-split 存量 commits 的取舍(吸收 vs 重做)。
3. 子单切分形态(设计收敛后 Tadashi 定;Gate A/B 顺序约束来自 PRD §14)。
4. v3 slide 待 Annie 的真开放问题清单(尽量少 —— 已定项标 ✅ 不再要表态)。
