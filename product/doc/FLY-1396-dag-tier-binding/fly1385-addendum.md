# FLY-1396 交 FLY-1385 的 runtime 契约 — ADDENDUM(可整节抽走的唯一副本)

Issue: FLY-1396 (https://linear.app/geoforge3d/issue/FLY-1396/prdhl-dag-分档-binding-不同类型的单走不同模板不再一律-eng-heavy-highway)
日期: 2026-07-20
基于: prd.md(同文件夹)—— ⚠️ **本文件是这份契约的唯一正文**;prd.md §11.5 只放指针,不再存第二份

---


> **📎 抽用说明**:本节**刻意写成自包含** —— 不含任何「见本 PRD §X」「如前文所述」式的交叉引用,所有产品约束都**就地写全**。整节复制进 FLY-1385 的 design 文档做增量 review 即可,不会断链。
>
> **以下契约交 FLY-1385 设计定夺,产品层约束如下。** 每条给三件:**(a) 两难是什么 · (b) 产品层给的约束边界(不可越) · (c) 谁定**。产品层**只给两难与边界,不给实现**。

**产品形状已在上游收敛**,其中**最重要的一条上位原则请先读**:

> 🔑 **路由判断在派发那一刻做,不读单子上的存量标记。**
> ⚠️ **适用域(先读这句再读下面)**:这条原则在本单**只落到 work-kind 与 `no-three-stage` 两样上**。系统里其它从存量 issue label / 标题读行为的地方 —— `codex-skip`、`no-qa`、`no-vision`、founder-facing UX 的 exempt 与 QA-title 判定,以及 scoped / tokenless / 非-main role 的 legacy start —— **本单一律不动**(**本单不切,且⚠️ 目前无接收方**(本单不切它们的完整边界说明就在这一条里))。**这不是穷举清单**:catch-all 合同是「除 work-kind 与 `no-three-stage` 外,任何其它 stored-label / title 行为读点都不动」,**不得因为某个读点没被列出就认为它该切**。
> **🔑 判据(首要,不是「写得早不早」)**:**看这个信号描述的是「身份」还是「这次的用法」。**
> - 描述**身份**(不随时间变的属性,如归属哪个部门)→ **写在单子上完全正当**,开单时写也没问题;
> - 描述**这次的用法**(这次拿它当什么做)→ **它天生属于派发那一刻**,写在单子上从一开始就是把「一次性的用法」记成了「单子的属性」。
> ⚠️ **「会过期」是症状,不是裁决标准** —— 过期只是把这个错误暴露出来的方式。**标题前缀被否掉,是因为它编码的是用法**,不是单纯因为它创建得早。
> ⇒ **推论**:将来**在开单时写下的 identity 信号明确允许**;**usage 信号则无论更新得多勤、多新,都不行** —— 别以为「只要够新就合法」。
> ⇒ 所以 **work-kind 由派它的 Lead 在派发那一刻显式给**(用已有的 `taskCategory` 字段);**部门标签仍然**决定这单归哪个 Lead(那是身份),这条不动。
> **推论(窄域,别扩大)**:**`no-three-stage` 这一个 label** 在 **master fresh main-role 派发域**内同样**不从 issue 继承** —— 要它生效,派发时显式带上。
> 🔴 **本单只切这一个。** 系统里其它同样读存量 issue label 的行为 —— `codex-skip`、`no-qa`、`no-vision`、founder-facing UX 的 exempt / QA-title 判定,以及 scoped / tokenless / 非-main role 的 legacy start —— **全部保持现状,本单不改**。**不要把这条读成「所有 routing-affecting label 都不继承」** —— 那个宽方案已被明确拒绝,因为本单没有为它们准备派发时的替代输入口。
> 🔴 **这些读点目前没有接收方,而且明确不是 FLY-1393** —— 1393 的 scope 是 flag 真值修复(开关 ↔ 组件接线),**不含存量 label 读点盘点**;这些全是 label 面。**把它们挂到一个错误的接收方上,比明写「没人接」更坏** —— 看起来有人接,实际掉进缝里。将来要统一清理需**另开一张 label-lint 族的单**;在那张单存在之前,**如实按「无接收方」处理**。
> ⚠️ **标题前缀 parser 不做** —— 因为它**编码的是「这次拿它当什么做」**。⚠️ **不要把这条读成「任何开单时写的路由信号都不行」** —— 判据是 identity 还是 usage(见上),**不是写入时间**。

其余已收敛项:work-kind→模板映射 / 三套 flow 合同 / 「只差模型的合并、流程形状不同的分开」判据 / 5 套库存 / rollout 顺序与安全铁律 / 单开关 cutover 及其 runtime set。其中三条仍受 founder gate 约束、批准 pending:三套 flow 合同、`no-three-stage` 语义取 A、**`no-three-stage` 的 issue-label 不继承(仅 master fresh-main 域;不是「所有行为标签不继承」)**。**下面这些是「实现者可能有两种理解」的 runtime 契约,不是产品选择。**

**🔴 量级判断按 Tadashi 的,产品层不重排**:
- **①** 与他已接下的 schema-v2 入口三件套(keyless 合成 / flag-off 行为 / auth 面)**天然同域,他合并考虑,不算新工作面**。
- **②** 他给的是**同样的同域判断**,但⚠️ **那是对这一条的旧版本(标题前缀 grammar truth table)给的** —— 该 parser 现已整段删除,②换成了「已有字段的校验 + 回显」。**量级请他重新给,产品层不代估。**
- **③** 他**没有预设**,一并交他判断。
- **④⑤** 他**未就量级表态**,此处**不代填**。

**产品层不替他估量、不替他排优先级。**

---

**① override 的 idempotency / reservation 生命周期**

- **(a) 两难**:一次派发若因显式行为覆盖而落进 legacy 单 session,它的 start key 就不再形成可比 digest(`runs-route.ts:1144-1173` 只在 generalized 路径把请求送进 resolver)。要么按 legacy 单-active-session 语义去重(代价:不享 generalized idempotency 与 pinned recovery),要么另发一个独立的 route-decision receipt(非 workflow run)。
- **(b) 产品约束(不可越)**:
  1. **override 必须在派发记录里可见**。「不静默」在本 PRD 是**可测结果**,定义为:**本次请求中**非法或互相冲突的**显式**输入,要么**阻止 start 并返回稳定 error code + 幂等一次提醒**,要么**要求显式确认**;**仅写一条没人看的 audit 不算**。合法行为信号生效时也要有 route-decision 记录,且 **legacy 与 schema-v2 两条路径都可观察**。⚠️ **「残留信号」不在这条的作用对象里** —— issue 上残留的 `no-three-stage` 既**不改变本次路由**、也**不阻断、不要求确认**(见本清单 ② 第 5 条);本条只约束**本次请求显式带来的**输入。⚠️ 这**不**意味着系统不读任何存量 label:`codex-skip` 等信号仍按现状从 issue 读取,本单不动。
  2. **不得因 override 产生第二个并行 run**。
  3. **override 只授权「这一次 fresh dispatch」,不跨 replay 存活** —— 后续新的 fresh dispatch 必须重新显式携带。
  4. **不得为了记账把 `no-three-stage` 拖进 schema-v2 selection**。产品已定的短路是:**dispatch-time lint 通过且 `no-three-stage` 被确认有效时,fresh main-role 派发必须在任何 v2 candidate selection / materialization 之前转入 legacy 单 session,不创建 workflow run / reservation。** 任何记账方案都不得让这条短路失效。
  5. 附一条**验收侧的负向约束**:一次成功触发 `no-three-stage` bypass 的 fresh start **根本不会创建 workflow run / reservation**,因此**它不存在 pinned snapshot** —— 验收不得去找一个产品明令不许创建的 run。
- **(c) 谁定**:Tadashi 在 FLY-1385 的设计里定,并写明 `reason` 是必填字段还是固定机器 reason、`selectedBy` 取哪个身份。

---

**② `taskCategory` 的输入合同 + 生效值与建议值的持久化 / 可见性**

> ⚠️ **这一条换过内容,量级判断请重新给**:它原本是「标题前缀 marker 的 grammar truth table」,Tadashi 的「与 schema-v2 入口三件套同域、合并考虑、不算新工作面」是**对那个旧版本**给的。现在标题前缀 parser **已整段删除**(理由:**它编码的是「这次拿它当什么做」,而那天生属于派发那一刻** —— 「几周后会失效」只是这个建模错误暴露出来的症状,不是判据本身),这一条剩下的是**已有字段的校验 + 回显**,比原来小,但**不由产品层替他重估**。

**📋 这一条需要的产品输入,全部就地列在这里(抽走后不必回查任何东西):**

- **CATEGORY 词表(唯一一套)**:`prd` · `designer` · `prototype` · `code` · `research`。**没有第二套「标题前缀词表」** —— 那个 parser 已删除。
- **v2-routed 项目上的有效路径只有两条**:**① `templateId`**(明确豁免硬门 —— 直接指定模板本身就是那一刻的显式路由判断,且 resolver 已强制非空 `selectionReason`),**② 显式 `taskCategory`**。**两条都没有 ⇒ 拒绝派发**,不落任何默认、不落通配。
- **通配 `*` 在 v2-routed 上不是「无 kind 兜底」** —— 它只在**非-v2-routed 的旧路径**上有意义(兼容 / 回滚防线),**不进 v2 的优先级链、也不进 v2 的 provenance 词表**。
- **部门建议值(🔴 只活在指令面/交互文案里,不进服务端语义)**:`product → prd` · `engineering → code`。**在 v2-routed 项目上它绝不会自己生效** —— 缺值就是拒绝,不存在「没人确认时套用」这条路。⚠️ **不要为「确认了建议值」设单独的 provenance 来源**:服务端收到的只有一个 `taskCategory` 字符串,**无法判定**它是独立判断还是接受了建议(Claude Lead 走裸 HTTP,不存在「先展示再确认」的协议)—— 设了就是一个**看起来可观察、实际编出来的**字段。这套取值是**产品层为指令文案选的起点 / 上线假设**,不是已验证的「该部门 modal kind」,**更不是任何意义上的服务端 default**(开关已开的域里不存在 default)。
- 🔴 **required-param gate(本单唯一新增的硬门)**:**v2-routed 项目,派发时既无 `templateId` 也无显式 `taskCategory` → 拒绝派发、稳定 fail-loud,不落任何默认。** 理由:`taskCategory` 与 `agentName` 同构,而 `agentName` **在生产里从来没人传过** ⇒ 留一个「不传就有默认」的可选参数,实际结果不是「偶尔忘」而是「一次都不传」,默认会变成唯一实际生效的路径。
- 🔴 **`v2-routed` 的定义(写死,含糊会毁掉回归 fixture)**:**`v2-routed` ≡ 该项目的 work-kind cutover 开关已打开**。⚠️ **不是**「该项目存在 v2 binding / candidate」—— **dormant 的 v2 binding 在场但开关 off ⇒ 仍算 non-v2**,行为完全不变(这正是迁移回归 fixture 要守住的场景;按「有没有 v2 binding」判断会把那条 fixture 打穿)。**判定必须发生在 candidate / binding lookup 之前**,否则「要不要拒绝」会依赖「查到了什么」。
- 🔴 **作用域边界(别打爆正常派发)**:**只对开关已开的项目生效**;**非-v2-routed(legacy / 未 cutover)项目的派发行为原样不动,不得被这个必填项卡住**。也**不作用于 retry**(retry 复用 pinned snapshot,不重新解析 work-kind)。
- 🔴 **本单新增的所有 `taskCategory` 校验一律挂在同一个开关后面**,不只是「缺值拒绝」:**开关 on** → absent 拒绝、非 string 4xx、词表外 4xx;**开关 off** → **全部保持今天的行为**,包括今天对非 string **静默当 absent** 这一条。⚠️ **不得**因为「校验总是好的」就把新 4xx 提前应用到未切换的项目 —— 那会让 legacy 调用在 cutover 之前就开始报错。
- **适用域(硬边界)**:词表校验 / exact-row enforcement / work-kind 解析**只作用于 master fresh main-role entry**。🔴 **且 exact-row enforcement 只作用于「`taskCategory`→binding」这条路径** —— **`templateId` 路径跳过 binding**,只校验模板 active/published/fresh-eligible + 非空 `selectionReason` + provenance,**审计用的 category / sentinel 不要求 exact binding**(否则硬门豁免又被撤销一半)。**active recovery、非-main role(尤其 QA)、scoped/tokenless legacy start 一律不受影响、不得被改道或拒绝**。
- **三个派发面的现状(决定「回显」落在哪、以及谁需要改)**:① **Claude Lead**(生产主力)直接 `POST /api/runs/start`,body 直通 —— **传输层不用改,但它的 runtime rules 目前一次都没提过 `taskCategory`,必须在开关翻转前更新为「派发时先分类并显式传」**;② **Gemini Lead** 的 `dispatch_runner` 工具 schema 未声明该字段(同 schema 里的 `docTier` 是同款可选 enum 先例),**需加参数**;③ **Codex Lead** 当前**不派 Runner**(其 `start_runner` 不在 gateway 工具面内),本单不涉及。

- **(a) 两难**:`taskCategory` 的边界语义与错误码形态;以及「本次用的 work-kind 及其来源」**回显到哪里**才算被派它的人看见(HTTP 响应体 / Lead 侧回执文本 / 两者)。⚠️ 注意时点:成功路径是**先起 Runner、再发 200**,所以回显天然发生在 launch 之后。
- **(b) 产品约束(不可越)**:
  1. **边界语义写死(⚠️ 全部只在开关 on 时生效)**:缺失 / null / 空白 → **absent** ⇒ **拒绝派发**;大小写差异 → **canonicalize,合法输入,不提示**;**present 但非 string → 稳定 4xx**;**词表外的非空值(含拼错)→ 稳定 4xx**。⚠️ 后两条**是有意改变现状**(今天 `runs-route.ts:926-935` 对非 string 静默当 absent),因此**必须跟着开关走**;**开关 off 时逐字保持现状**。
  2. **不设「阻断要求确认」这一档**:`taskCategory` 是派发那一刻传的,4xx 当场打回给派它的 Lead、当场改掉重派 —— 不需要确认流程。
  3. **校验、lint、验收三处必须共用同一张表**,不许各自实现一份。
  4. 🔴 **解析结果必须回显给派它的人**:本次用的 work-kind **是什么** + 它**来自哪**(v1 的来源词表只有 `task_category` 与 `template_override` 两个)。**仅写进一条没人看的 audit 不算可见** —— 「分类填错了」必须不依赖任何人记得去查就能发现。
  4a. 🔴 **代理指标要真的可算,不能只在派发那一刻「两个值都在」**:route decision 里必须**持久留下可聚合的 `(sent_category, 该项目该部门的建议值)` 对** —— 现有代码把 `owningDept` 传给了 dispatcher,但 **workflow selection / snapshot 并没有记它**,所以「服务端当时都有」**不等于事后算得出**。据此可算「发送值 == 部门建议值」的占比。⚠️ **它不是「走过场率」**(独立判断本来就常落在建议值上),只回答「分类实践是不是已经机械地等同于建议值」;且**必须有具名消费者与查看节奏**,否则就是另一条没人看的 audit。
  4b. 🔴 **post-launch 纠正路径(产品承诺,不可越)**:因为回执发生在 Runner 已启动之后,**产品层只承诺「把发现时间从几周缩短到当场」,不承诺「不会跑一次错流程」、也不承诺「零浪费」**。⚠️ **gate 之后这里的失效是「填了但填错」,不再是「默认落错」**(缺值已被硬门拦下)。分类填错时的纠正路径是 **先终止那个错 run,再重新 fresh dispatch**;过程中**必须始终维持 single-active-run,不得出现两个并行 run**。具体 lifecycle / reservation 形态由实现方定。
  4c. 🔴 **入口侧约束 —— 权威在服务端,不在 schema**:工具 schema 面(Gemini `dispatch_runner`,以及将来 Codex 的 `start_runner`)的 work-kind 应为 **required enum**(借 `docTier` 的 enum 写法,**不借它的 optional**)。**但 schema 的 required 只能约束走该工具的调用方** —— 裸 HTTP、旧自动化、手写请求都绕得过去。
  ⇒ 🔴 **HTTP 字段可以为兼容性继续「语法上 optional」,但服务端行为必须按同一个 per-project 开关分支**:**开关 on ⇒ absent 稳定拒绝**;**开关 off ⇒ 保持旧行为**。**v2 域内绝不存在服务端确定性默认。** ⚠️ 生产主力(Claude Lead)走的正是裸 HTTP —— **若在 HTTP 面留一个服务端默认,这个硬门对生产主力等于不存在**,而那恰恰是它要防的失效形态。
  5. **行为冲突 lint 的输入只能是「本次显式携带的派发覆盖」** —— issue 上残留的 **`no-three-stage`**(master fresh-main 域)**不改变本次路由、不阻断、也不触发任何确认**,至多记录为 documentation intent。⚠️ **仅指这一个 label**:`codex-skip` / `no-qa` / `no-vision` / founder-facing UX 仍按现状从 issue 读取,**本条不是让实现者去切断或忽略它们**。
- **(c) 谁定**:Tadashi 定错误码形态与回显落点。

---

**③ 直接指定 `templateId` 时的 canonical category 与 provenance**

- **(a) 两难**:`templateId` 已明确豁免硬门(它本身就是显式路由判断)。剩下的问题是**此时 category 记什么**:取显式 `taskCategory`(若同请求也传了)算出的审计值,还是取一个 sentinel;以及 metrics 是否要把「有意跨 kind 的 override」算作错配(算 → 指标被正当行为污染;不算 → 需要一个排除口径)。
- **(b) 产品约束(不可越)**:
  0. 🔴 **`templateId` 路径跳过 binding,不受 exact-row enforcement 约束**:只校验模板 **active / published / fresh-eligible** + 非空 `selectionReason` + provenance;**审计用的 category / sentinel 不要求存在 exact binding 行** —— 否则一个合法、已发布、带 reason 的 direct override 会因为**无关的** category 缺行而失败,硬门豁免等于被撤销一半。
  1. `selection_source=lead` **保持原义**,表达的是 template override 这一来源,不得改写成别的含义。
  2. **必填非空 `selectionReason` 不得取消**(现有 resolver 已强制)。
  3. 无论选哪种,**pinned snapshot 里的 category 与 source 必须自洽、可解释** —— 事后有人翻这条记录,要能说清「当时为什么选了这个模板、category 为什么是这个值」。
  4. **显式的坏输入仍要报错**:产品定的次序是**先校验、后按优先级取** —— 即使 `templateId` 会胜出,同请求里非法的 `taskCategory` **仍然报错**,不被静默吞掉。⚠️ **不要用「反正后面有默认值兜底」当理由** —— 在开关已开的域里**根本不存在默认兜底**(缺值直接拒绝)。
- **(c) 谁定**:Tadashi 定。

---

**④ 回归 fixture / cutover owner / 开关 scope 的落地形态**

- **(a) 两难**:回归 fixture 放在哪一层;cutover 由哪个交付物执行;那个控制新旧行为的开关是全局一个还是 per-project 一个。
- **(b) 产品约束(不可越)**:
  1. **回归 fixture 是迁移 PR 的前置,不可后补。** 且**场景必须复现真危险面**:**dormant 的 schema-v2 通用模板 binding 已经在场 + 开关 off,断言此时仍保持旧行为**(每个「只有通配 binding」的项目,keyless legacy start 依然成功)。**不接受复用现有那个 schema-v1 `*→tpl_eng_heavy` 的 fixture** —— 它形式上满足文字,却完全没覆盖本次风险面,是一条空过的绿测。
  2. **cutover 必须有明确 owner,不得沿用会在 ordinary warm path 无条件执行的默认 seeder。** 真实风险:`ensureDefaultWorkflowBindings` 在 Bridge warm 时自动跑(`plugin.ts:3994-4007`),**只改默认列表不够** —— 一重启就会把 live binding 写下去,等于部署静默激活。
  3. **开关必须能 per-project 控制** —— binding 主键是 `(project, category)`,且各项目对三套 flow 合同的 founder 批准进度**不同步**,不能一个全局开关一刀切。
- **(c) 谁定**:Tadashi 定。

---

**⑤ 两个 agent markdown 的翻转时序落地形态**

- **(a) 两难**:`pm-executor.md` / `prototype-executor.md` **不是文档,是 runtime prompt 资产** —— 它们在 `.flywheel/config.yaml:187-215` 注册为 `agent_file`,由 `Blueprint.ts:2170-2221` 在 **Runner spawn 时逐字注入 Agent Role 系统提示词**,且**当前仍在明确要求派发者添加 `no-three-stage`**。开关翻转与这两个文件的内容更新**跨 SQLite / Bridge 代码 / markdown / config 四个面,不可能放进一个数据库事务**。要么做成 dual-compatible 的提示词(新旧语义都不冲突),要么做提示词变体,要么靠部署顺序保证。
- **(b) 产品约束(不可越)**:
  0. 🔴 **cutover 的原子单元是三件,不是两件** —— **① 该次派发对 per-project 开关取到的 runtime 决定 · ② 已备好的 binding 行 · ③ 与该决定一致的 prompt 资产内容/变体**,三件必须在同一次翻转里一致生效。**只有 config 注释才可以翻转后跟进。**
  0b. 🔴 **不得用引擎短路豁免第 ③ 件**:引擎短路 + dispatch-time 权威读**只兜住「路由后果」**(旧 role 指令让 runner 去贴标签,贴了也改不了已派 run 的路由),**兜不住「指令冲突本身」** —— 新 runner 会收到自相矛盾的指挥。**一个收到矛盾指令的 runner 本身就是缺陷**,与它的 run 路由到哪无关。
  1. **属于「翻转后新做出的派发决定」的 fresh Runner,不得收到与已激活的 routing 语义相冲突的 role 指令。** ⚠️ **判据是「它属于哪一次派发决定」,不是「它什么时候出生」** —— 属于翻转前 pinned 决定的 Runner 拿到翻转前的 prompt,**与那个决定自洽、不构成冲突**,是 by design。
  1b. 🔴 **同类风险:被进程「启动时加载」的东西,改了不等于生效。** `department-lead-rules.md` 是 **Lead 会话启动时**加载的 ⇒ 规则更新并 merge 之后,**受影响的 Lead 读到的仍是启动时那份旧规则,直到重启**。
  🔴 **「受影响的 Lead」要写准,别读成「所有 Lead」**:这份 rules **设计上只发给非-CoS 的部门 Lead**(即会派 Runner 的那些)—— ⚠️ **「设计上」不等于「现在如此」,见下面的干净基线那条**。真实判定有**两条臂** —— `FLYWHEEL_LEAD_ROLE = cos` **或** `LEAD_ID = cos-lead`,任一命中即视为 CoS 角色、**不加载这份文件、不在必须重启之列**。⚠️ **阴性对照必须查「该会话实际被喂进去的规则内容」,不能 grep 一个我们从不修改的磁盘文件** —— 那样无论好坏都绿,是一条永久假绿的空对照。
  🔴 **按实际生效的角色判定算,绝不按 Lead 名字猜(有实例支撑的硬要求,不是建议)**:leadId 不是字面 `cos-lead` 的 CoS 只靠 env 那条臂被排除,env 若没设上,它会落进部门 Lead 分支 —— **这不是假设,生产当前就是这个状态**(进程级实证)。**它整段时间行为都正常,所以没人发现:行为对 ≠ 规则接线对。**
  🔴 **而且「更新那份 rules」这一步本身,此前是空的**:`--append-system-prompt-file` 是 **last-one-wins**(哨兵实验 + 反序对照实测),**每个 Lead 实际只装了清单里最后一份** —— 那份 rules 从来没进过任何 Lead 的上下文。⇒ 产品层的前置合同是**有序四拍**:**① launcher 修复(全部 rules 拼接成一份、单 flag 传入)→ ② rules 更新并 merge → ③ 重启 + 【哨兵读回】确认真加载(在拼接文件里植入版本哨兵串,重启后让该会话把它读回来)→ ④ 才允许翻 flag**。⚠️ 少任何一拍就翻 = **修复本身静默失效**,而且**不会有任何一步报错**。
  🔴 **验证等级(最容易漏的一条)**:**argv / 配置 / 文件内容都只是【起点证据】,必要非充分** —— 它们只证明 launcher **想装**,不证明装进去了;**权威证据是【终点取证】:让被验证的那个会话把哨兵串说出来。** ⚠️ 当晚看起来最像铁证的那份 `ps` 活进程参数,正是这么失效的。
  🔴 **③那一拍(重启之后)要一正一负两个对照**(⚠️ ②只是内容 merge,证明不了任何加载):**阳性 = 一个真加载这份 rules 的部门 Lead,从它自己加载的规则里读出那条指令**;**阴性 = CoS 角色的规则里没有这条指令**(它若有 ⇒ cos 排除臂失效)。⚠️ **别拿 CoS 当阳性对照** —— 按设计它不加载这份文件,「读不到」是常态,**一个永远返回阴性的对照不是对照**。
  🔴 **且这对对照只有在【干净基线】上才算数**:cos 排除是**两条臂**(`FLYWHEEL_LEAD_ROLE=cos` 或 `LEAD_ID=cos-lead`),一个 leadId 不是字面 `cos-lead` 且 env 未设的 CoS **两条都不命中** —— 生产当前就是这个状态(进程级实证:launcher **打算**给它装完整部门 Lead 规则包、零 CoS 规则)。⚠️ **但因为 last-one-wins,那些其实一份都没进它的上下文** —— 所以 **launcher 修好之前,这对对照测的是一个「谁都读不到」的世界,分不出好坏**。⇒ **两条前置都满足才谈对照**:**launcher 已修复** + **cos 角色判定基线已修正并重启生效**;在此之前,阴性侧读到什么都属于**预期内的基线故障**,不构成排除臂在 cutover 中失效的证据。 顺序:**补 env → 重启生效 → 确认它读得到 CoS 规则且读不到部门规则 → 才谈正负对照。**
  🔑 **顺带一条硬要求(有实例支撑,不是建议)**:**判断一个角色有没有被排除 / 谁需要重启 / 谁加载了什么,一律按「实际生效的角色判定」算,不得按名字或印象猜** —— 上面那个实例整夜没被发现,正是因为**它的行为一直是对的**。**行为对 ≠ 规则接线对。**
  ⚠️ **但不要把 prompt 资产也塞进这同一次重启来证明** —— **两者的加载生命周期不同**:`department-lead-rules.md` 被**长驻 Lead 会话缓存**,必须重启 Lead;而 **agent prompt 文件是在 fresh execution 时读的**(legacy 路径在 Runner spawn 时读盘;generalized 路径用**已物化**的内容)。⇒ **一次 Lead 重启证明不了 Runner 拿到的 prompt 是对的**;prompt 资产要用**它自己**的生效判据:**翻转后派一个金丝雀 spawn**(或看翻转后第一个真实 runner 注入的 role prompt)。🔴 **第三档:已在跑的 run 用已物化内容拿到旧 prompt,是 by design、不算失效、不用验**(pinned snapshot 免疫,与 cutover 开关同一套语义)。 🔴 **和「翻转后出生的 fresh Runner 不得收到冲突 role 指令」怎么不打架(Codex gate11 #2 抓出的真矛盾,按「决定归属」重述)**:判据**不是「这个 Runner 是什么时候出生的」,而是「它属于哪一次派发决定」**。**已物化的 run** 整套决定(模板 / category / prompt 内容)都是**翻转前**定下并钉住的 —— 它后续再 spawn 出来的 Runner 拿到翻转前的 prompt,**与它所属的那个决定是自洽的,不构成冲突**,这正是 pinned snapshot 免疫的意义。**真正被那条约束管住的,是「翻转后新做出的派发决定」所产生的 Runner** —— 它们必须拿到与已激活语义一致的 prompt。⇒ 所以那条约束的准确表述是:**属于翻转后新决定的 fresh Runner,不得收到与已激活 routing 语义冲突的 role 指令**;属于翻转前 pinned 决定的,照旧、不验、不算失效。⇒ **三档分清:rules 用 Lead 重启验 / prompt 用 fresh spawn 验 / 在跑的 run 不验。****「生效必须被验证」这条原则通用,但「用哪一次重启去验证」必须按每样东西自己的加载时机来定。**
  2. **不得提前单独撤掉这两个文件里的 `no-three-stage` 要求** —— 提前撤 = 产品单上的该 label 立刻失效 → 立刻掉进三段式,正是这条 label 当初要防的事。
  3. **不得用「它是文档所以无所谓」跳过这条** —— 上面的源码事实已经否掉这个前提。
  4. ⚠️ **这两个文件的改动本身还压在 founder 门后**:纪律变更由 Lead 当面带给 Annie,她点头前**这两个文件不动**,cutover 保持 blocked。
- **(c) 谁定**:Tadashi 在 FLY-1385 / FLY-1380 的设计里定实现形态;**改不改这两个文件由 founder 定**。

---

