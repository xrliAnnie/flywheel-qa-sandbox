# FLY-1498 门与派发模型 — 探索

Issue: FLY-1498 (https://linear.app/geoforge3d/issue/FLY-1498/v2批次2-门与派发模型-节点自带完成合同-ship-只验通用三条-派发器只认-dag)
日期: 2026-07-27
基于: 无(本 issue 首篇;上游=doc/engineer/plan/v2/design-FINAL-v2.md)

## 1. 问题陈述(founder 直令还原)

Annie(2026-07-27):"ship gate need to be very generic... codex code review is a hard gate for implement session, not really a ship gate... We really need to think through a generic issue dispatcher/ship process, not design this for a specific scenario"

触发实例:FLY-1497 的 ship 被"QA 会话没有 Codex 代码评审记录"挡住——那个会话干的是 QA、改动只有测试;同理纯 PRD 单(PR 里只有 .md)也会被要求代码评审。

**根因(一句话)**:门按**流程节点名**(design/implement/qa 这些身份标签)一刀切,而不是按**这次改动的内容**判定该欠什么证据。这是 MEMORY 里"拿标签冒充事实"失效模式在门系统里的结构化翻版:节点叫什么 ≠ 节点干了什么。

## 2. 设计要求(issue 原文五条,不可妥协)

1. **每个节点自带"完成合同"**:节点完成时,由它自己把「合同满足」的证据与完成状态写进**同一条事务记录**(v2 核心:动作与证据同事务,消灭"补记录"环节)。
2. **合同由该节点实际产出物派生**:产品代码→跨族代码评审;只有文档→文档评审或免;只有测试→测试评审。不由节点叫什么名字决定。
3. **ship 不是带评审要求的节点,是一个动作**。前置条件只有三条通用项:①founder 批准且绑当前 head ②DAG 全节点终态成功 ③head 未漂移。**ship 绝不重新过问"有没有代码评审"**。
4. **派发器不认识三段式**,只认 DAG:每 issue 自有形状(1/2/N 节点任意连接),每类节点声明自己的合同;三段式只是最常见 DAG,非特权形状。
5. 推论验收:PRD 单(无产品代码节点)ship 一路畅通;QA 单的合同是 verdict 非代码评审;**零按场景写的特例**。

## 3. v2 上下文(本节要并入的宿主)

- 宿主文档:`doc/engineer/plan/v2/design-FINAL-v2.md`(Codex R13 APPROVED)。本节须并入该稿并过 Codex 评审(同标准)。
- 现有 §1.4-1.5 只有一句"同前版(exact-head 绑定,founder-only ship)"——gates 的实质定义停留在 design-chain v1:
  - `gates(id, task_id, attempt_generation, kind, subject_digest/head_sha, state, opened_at, resolved_at, resolver_capability_id)`;P9 语义:批准绑精确 head,resolution 永不由 transcript 文本推断。
  - kernel 必须拒绝清单里已有"ship gate 未满足",但"ship gate 由什么构成"未展开——**这正是本单要填的洞**。
  - 产品红线 3 条:单 worktree 单写者 / 批准绑 head / CI 红不 ship。
- design-FINAL-v2 §0 前提条款已埋钩子:"每 issue 的 task 数量与形状由该 issue 的 DAG 定义,三段式只是例子,机制不得隐式绑定三段式"——本单是把这条前提落成机制。
- 相关既有机制(FLY-1497 已落地 kernel):17 张表、BEGIN IMMEDIATE 单写 kernel、CAS/generation fence、attempts 每 task 至多一 active、terminal 规则(terminal task→rework_of successor)。
- scenarios-all.md 的机制判定表方法论(先枚举场景,再判机制)是本单反 over-reaction 检查的模板。

## 4. 现状盘点(v1 病灶,代码摸底实证)

> 两路 very-thorough 摸底已完成;完整 file:line 台账收进 research.md,此处只留结论级事实。

### 4.1 挡住 FLY-1497 的确切机制
- `packages/flywheel-comm/src/commands/verify-approval.ts:589-601`(FLY-827 hard gate,step 8):只看 (project, issue, `__main__`, **当前 head**) 上有无一条 approved/skipped 且跨族的 `codex_review_record`——**与会话改了什么完全无关**。
- FLY-1497 形态:QA 性质会话推了新 commit → head 变 → 新 head 无 record → `codex_review_not_approved`。Blueprint prompt(`Blueprint.ts:2334` HEAD DISCIPLINE)明写了这个假设:推了就得重跑评审。
- **codex 门零内容分支**:没有 docs-only/test-only/规模豁免;仅有 3 个 bypass(env kill-switch `FLYWHEEL_CODEX_HARD_GATE=0` / Linear label `codex-skip` / skipped record)。全代码库按「改动内容」分支的只有 2 处(`ship-relevant-diff.ts` docs-only 分类,只喂 QA hold 轴;auto-qa-policy labels),都不触碰 codex 门。

### 4.2 按节点名硬编码的规模
- **114 处** `=== "design"|"implement"|"qa"` 字面量比较;28 个关键分支点已台账化(research.md)。最典型:
  - `codex-gate.ts:50-53` `isReviewableRole = main||implement`——qa/design role 完全不进评审门;qa-role 会话的 codex verdict **无法被记录**(`auto-qa-coordinator.ts:969` 直接丢弃)——这正是 FLY-1497 死锁的结构成因:它想补评审都没有入口。
  - `ship-eligibility.ts:170` SQL 字面量 `AND b.node_id = 'qa'`;`:295` durable QA 判别式=`session_role==="qa" && chat_thread_role==="qa"`。
  - 三段式心脏:`three-stage-phases.ts:248` `nextPhase()` 线性推进 + `phase-orchestrator.ts:580-583` `HANDOFF_STATUS={design:"design_done", implement:"awaiting_review"}`(节点名→完成状态硬表)。
  - manifest 校验层仍三段式特权:`workflow-template.ts:449`(v1 恰一 QA 节点)、`:1073-1077`(v2 有 code-writing 节点⇒必须恰一 QA)、`:636-645/:1116-1131`(出边条件按 type 硬映射)。

### 4.3 已铺好的声明式半成品(设计的现实锚点)
- `packages/config/src/node-type-registry.ts:17-32`:`WorkflowNodeCapabilities` 12 个 capability 字段——「节点声明自己合同」的雏形;`workflow-run-snapshot.ts:150-172` gate-carrier 判定是纯 capability 正确范式("Node ids and template ids are intentionally irrelevant")。
- `manifest.ship_claims` 词表(v1: `qa_passed|founder_approved`;v2 +`design_review_approved`)——**缺 `code_review_approved`**,所以 codex 门只能留在 legacy role 硬编码侧。
- FLY-1135 plan:loop 边=一等构件(`loop_when/exit_when/max_iterations/on_limit`);精确命名=「结构静态、路径动态」的**带声明式回边的有向图**(非严格 DAG)。
- verify-approval 9 步清单里,QA 轴在外层 `evaluateShipEligibility`(A 轴)与 merge approval(B 轴)分立,两 kill-switch 独立;codex 门是「双份镜像实现」(Bridge `codex-gate.ts` + CLI 内联 SQL),唯一共享 `review-family.ts`。

### 4.4 v2-kernel(FLY-1497 已 merge)给本设计留的空槽
- `packages/v2-kernel/` 纯地基零接线;**tasks 表无任何 node/phase 字段**——DAG 形状完全靠 `task_dependencies` 表达,schema 层已 DAG-agnostic。
- `task_dependencies.condition`(0001:27)是边条件空槽:**无枚举约束、无禁环触发器**(对比 command_dependencies 两者都有)。
- `gates.kind` 自由文本无 CHECK;`gates(id, task_id, attempt_generation, kind, subject_digest, state CHECK('open','approved','rejected','expired'), opened_at, resolved_at, resolver_capability_id)`。
- kernel 合同已定:`Kernel.write` BEGIN IMMEDIATE 单写入口 + `tx.cas`(changes≠expected 整体回滚)+ `tx.requireIdentity`(generation fence)+ 1s 事务预算闸;FENCE 谓词模板族四条。**本单要定的正是:task_dependencies.condition 语义、gates.kind 词表、完成事务的合同谓词。**

## 5. 设计主张(brainstorm 输出,待 research 验证)

### 5.1 完成合同 = 两部分之并
```
node contract = 声明性交付物(node kind 作为数据声明) ∪ 派生性评审义务(由该 attempt 实际 diff 内容派生)
```
- **声明性交付物**:每类节点(作为 DAG 模板里的数据,不是引擎代码分支)声明它完成时必须交出什么:qa 节点→verdict 证据;design 节点→设计工件+设计评审;implement 节点→PR/commit span。引擎统一读合同数据统一执行,**引擎里零 per-kind 分支**。
- **派生性评审义务**:完成提案时,对该节点实际产出的 diff(base_sha..head_sha)做**确定性分类**(路径规则):product_code→跨族代码评审;test_code→测试评审;docs→免(默认)。与节点叫什么无关——QA 节点改了产品代码照样欠代码评审;implement 节点只改文档就不欠。

### 5.2 完成事务(消灭补记录)
- 完成提案携带:head_sha + 产出物清单(diff 分类结果,带 digest)+ 证据引用(评审 verdict 事件 id 等)。
- kernel 单 IMMEDIATE 事务:校验证据齐且每条绑 exact head → 写 attempt terminal + 完成事件(含合同满足清单)→ commit。证据不齐=整体拒绝,**不存在"先完成后补记录"的中间态**。
- 事务内只做谓词校验(短事务纪律);diff 分类在事务外确定性计算,以 head 绑定 + digest 防陈旧。

### 5.3 ship = 动作,三条通用前置
1. founder 批准 gate resolved 且绑当前 head(P9 原语义);
2. issue DAG 全节点终态成功;
3. head 未漂移(= 当前 head == 最后一个完成节点记录的 head)。
- **充分性论证(设计核心)**:每节点完成记录 (base_sha, head_sha) 跨度,kernel 在完成事务里校验 base == 上一个已记录 tip(链条连续,无缝隙)。于是 ②+③ ⇒ 分支上每个 commit 都被某个已完成节点的合同覆盖过 ⇒ ship 无需也不得重新过问任何评审。评审证据在生产它的节点处消费完毕。
- CI 红不 ship 红线不变,但归位:它是 merge 执行机(branch protection/deploy workflow)对任何 PR 的世界性约束,属于 ship 动作的执行协议,不是对流程历史的重新审问。

### 5.4 派发器只认 DAG
- 派发 = 读 task_dependencies,挑依赖满足且未终态的 task,spawn attempt(经 outbox command)。零三段式认知。
- 三段式退位为一张普通 DAG 模板(建 issue 时实例化的数据);PRD 单=单文档节点模板;QA 单=单 qa 节点模板。模板是数据,引擎不认识模板名。

## 6. 反 over-reaction 审计(每机制答:哪个场景需要它)

| 机制 | 需要它的已枚举场景 | 根治为何不够 |
|---|---|---|
| diff 确定性分类器 | FLY-1497(QA 会话只加测试被索要代码评审)、PRD 单(纯 .md) | 不按内容分类就只能按节点名——正是病根 |
| 节点合同数据化 | QA 单要 verdict(场景表 D 类)、design 节点要设计评审 | 不数据化就得在引擎里写 per-kind 分支=换个地方硬编码 |
| 证据绑 exact head | FLY-921/945 真实事故(head 漂移后旧批准/旧评审失效) | P9 原语义,非新增 |
| (base,head) 跨度链条连续 | FLY-945 head discipline 事故(评审后又推 commit) | 没有它,ship 三条件不充分,评审可被绕过 |
| 完成与证据同事务 | issue 要求 1(v2 核心);FLY-208 补记录类事故 | 分两步就永远存在"完成了没记上"窗口 |

**供 founder 砍的保护性机制(单列)**:docs→文档评审(默认按"免"设计,砍=保持免);test_code→独立测试评审档(可砍成并入跨族代码评审或免);其余无——上表五条均有事故/场景支撑。

## 7. 开放问题(带到 research/plan)

1. diff 分类规则表的具体形状(路径 glob→class)与未知路径的 fail-closed 归类(默认=product_code,最严档)。
2. "跨族"的机器定义:评审者 vendor 族 ≠ 作者 vendor 族;证据行需带 reviewer_family 字段。
3. 并行分支(B5)下 (base,head) 链条的形状:同 worktree 单写者 ⇒ 每 worktree 一条线性链;跨 worktree 节点如何汇合(merge 节点的 span 定义)。
4. 节点零 diff(纯判断节点,如 qa 只出 verdict 不改文件)的 span 表示:base==head 的空跨度,链条仍连续。
5. 与 FLY-1497 kernel 既有 17 表的落点:合同/证据用现有 gates+events 表达还是需要新列(倾向:不加表——gates.kind 定词表、task_dependencies.condition 定语义、tasks.payload 或 kind 承载节点合同声明;research 里对 schema 核实)。
6. 三段式回边(qa_fail→implement 循环)在纯 task_dependencies 模型里的表达:FLY-1135 已裁定 loop 边=一等构件、「结构静态路径动态」;v2 场景表 B2/B3 用「同 task 新 attempt」表达返工——两者如何统一(倾向:回边不是新 task,是既有 task 的新 attempt,condition 语义里定义 re-arm)。
7. `manifest.ship_claims` 与「ship 只验三条」的关系:claims 账本是 v1 过渡机制还是并入 v2(倾向:v2 里三条通用项就是全部,claims 由节点完成合同在完成时销掉,ship 不再读 claims 集合)。
