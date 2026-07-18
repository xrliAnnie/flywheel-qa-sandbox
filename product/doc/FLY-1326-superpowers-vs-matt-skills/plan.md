# FLY-1326 三臂方案(喂 FLY-1299)+ 采纳路径

Issue: FLY-1326 (https://linear.app/geoforge3d/issue/FLY-1326/research-mattpocockskills-能否取代-superpowers-系统减重盘点-依赖-blast-radius)
日期: 2026-07-17
基于: research.md

> 把 research.md 的三方案写成 **FLY-1299 A/B 的可执行候选臂**。**不下「该换」结论** —— Annie + 数据定。
> **v2(Codex R1 后)**:臂 (b) 的定义**钉死**(v1 允许多种安装形态 = 不唯一,测不出);
> 三个指标改成**可观测定义**(v1 的「累计 output token」看不见 input 侧的注入 = 测不到减重)。

---

## 0. 决策框架

三选一,不是 yes/no。共用同一把尺(FLY-1260 框架):同一批 issue、同一 rubric、盲评。

- **(a) 现状** = 留 Superpowers(1,778 tok/session 常驻 + 强制)。
- **(b) 换 Matt** = 卸 Superpowers,装 mattpocock/skills(420 tok/session,无强制)。
- **(c) 都不装** = 卸 Superpowers,不引第三方(0 tok/session),靠自有 rules/gate + 模型判断力。

**三臂最**核心**的差别 = 要不要那层「强制」、以及为它付多少 token**(这是给 Annie 的一句话版)。
⚠️ 但**不是唯一差别**(v3 更正):换臂还会改变 skill **正文、触发措辞、副作用**(写操作 / 派子代理 /
等真人)、**产物形态**(Matt 的 `to-spec`/`to-tickets` 会往 issue tracker **发布**东西)。
臂定义必须把这些一并钉死,见 §2。

## 1. 三个硬指标(v2 起:可观测定义)

| 指标 | v2 定义(可观测) | 怎么量 |
|---|---|---|
| **① 完成率** | 在**固定预算内**(时间 / token / 返工轮数上限)达到「可 ship」的比例。**必须有预算封顶** —— 否则无限返工后达标也算成功,指标失真 | 盲评 rubric 判达标;分母 = 同一批 issue |
| **② 成本(含减重)** | **四类 token 分开记**:`input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `output`(v1 只算 output = **看不见** 1,370 tok 的 input 注入 = 测不到减重)。⚠️ **不能等权相加** —— 四类费率不同;若报「成本」须**按各自费率换算 USD**。另**单列**每 session hook payload 的 bytes/token proxy | 每请求 usage 字段 + hook payload 实测 |
| **③ 纪律违规率** | 分母 = **eligible opportunities**(该守纪律的时机数),分子 = 违规数;**从事件轨迹判定**(如 red-before-green 的测试提交序、验证命令是否真跑),**不能只靠最终盲评**(成品看不出有没有跳过 TDD) | session 事件轨迹 + git 提交序 + 工具调用记录 |

**③ 是本决策的胜负手** —— 它直接测「拆掉强制层之后还守不守规矩」。

## 2. 三臂详设

### 臂 (a) — 现状(基线)

- **改什么**:不改。Superpowers 5.1.0,`generic-executor.md` 99-204 原样。
- **待检验假设(不是结论)**:**H1** ③ 违规率最低(有强制);**H2** ② 成本最高(1,778 tok/session
  + 可能的框架冗余轮次);① = 基线。⚠️ v2 把这些写成「预期」近似当事实 —— 它们**正是要测的东西**。

### 臂 (b) — 换 Matt(**钉死定义**)

> v1 的问题:同时允许 plugin / skills.sh copy / 后面又说 vendor 子集 = **三种不同的臂**,测出来无法归因。
> v2 全部钉死:

- **commit**:`9603c1cc8118d08bc1b3bf34cf714f62178dea3b`(v1.2.0)。
- **安装形态**:**skills.sh 可编辑 copy / vendor 进 FLY-216 库**(**不用 plugin managed bundle**)。
  **理由(硬约束)**:plugin 形态不可改 frontmatter ⇒ 13 个 user-invoked skill 对 headless runner
  **永远不可达**,其中就有 `to-spec`/`to-tickets`/`wayfinder` —— 而 `writing-plans` 只能靠它们。
- **skill 子集(钉死,不是全 22 个)**:`tdd`、`code-review`、`grilling`、`diagnosing-bugs`
  (这 4 个本就 model-invoked ✅)+ `to-spec`、`to-tickets`(**vendor 时把 frontmatter 的
  `disable-model-invocation: true` 去掉,翻成 model-invoked**,以补 `writing-plans` 的缺口)。
  **每一个 frontmatter 改动都必须在臂定义里写死并 diff 留档。**
- **prompt(两个文件,都要冻结全文/diff 进臂定义)**:
  - `agents/generic-executor.md` 99-204,四步流改指上述子集;**三条 Flywheel override 不变**
    (A→BRAINSTORM GATE、B→doc-flow、C→简单档跳文件),headless-Runner 通则不变;
  - **`.flywheel/agents/engineering/designer-executor.md`(:68/:141)**:裸名 `brainstorming` 改指
    Matt 的 **`grilling`**(唯一 model 可达近义物;语义从「探索意图」偏向「盘问施压」,差异记录进臂定义)。
  - **不许只写「大概改成 Matt 的」/「同步改」** —— 两个文件的完整版本都冻结,否则不同实现 = 不同实验臂。
- **必须审计**(vendor 前):这 6 个 skill 的 invocation、**写操作**、**是否派子代理**、
  **是否 human-wait**(Matt 的 skill 假定有真人在终端 —— 与我们 headless 冲突的必须改掉或不收)。
- **待检验假设**:**H3** ② 显著低于 (a);**H4** ① 与 (a) 持平;**H5** ③ 是核心悬念 —— 没了强制注入,
  model-invoked description 触发在**我们 headless 环境**下够不够强(**UNKNOWN**)。
  ⚠️ 「-1,358 tok/session」是**原版 9-skill catalog** 算的;本臂只 vendor **6 个**且要改 frontmatter
  ⇒ **该数字对本臂作废**,须在 frontmatter/description 冻结后**重测 rendered payload**。

### 臂 (c) — 都不装

- **改什么**:卸 Superpowers,不引第三方。`generic-executor.md` 99-204 改成**纯 Flywheel 自有机器**
  (BRAINSTORM GATE → `/write-plan` → flywheel-tdd → Codex code review gate)—— 这些**本就存在**
  (research.md 矩阵②列已证)。同样**全文进臂定义**。
- **待检验假设**:**H6** ② 最低(-1,778 tok/session,proxy 级);**H7** ③ 最考验模型判断力 + 我们
  gate 的硬度 —— **这就是 FLY-1260 命题的直接实验**。若 (c) 的 ①③ 不输 (a) ⇒ 框架税可整段省掉。

## 3. A/B 执行建议(交 FLY-1299)

> **Annie 2026-07-17 拍板(#flywheel-product,co-eval)**:**三臂一起测** —— 不分阶段。
> A(现状)对照 B(换 Matt)对照 C(都不装),**同一次 evaluation** 一起跑,看谁效果好;
> 并**给 B、C 装 feature flag**,之后按数据灵活选用/回滚。原话:「同时试 B 和 C…做一次 evaluation…
> 甚至给他们装不同的 feature flag,之后灵活地选用不同的方案」。⇒ 覆盖下面 v3 写的「先 a vs c 分阶段」。

- **三臂同批同尺**(Annie 定):A/B/C 用**同一批 issue、同一 rubric、盲评**,一次评完。
- ⚠️ **A vs C 不是单变量 ablation**(v5 更正 —— v2-v4 一直误称「直接 ablation、差的就是 Superpowers」):
  C 相对 A **同时**改了 generic 四步流、designer、以及 skill 可见性(拆掉整个 Superpowers 层)。
  所以 A/C 是**端到端策略对照**(有强制框架 vs 纯自有 gate),**不能把效果差异单归因给那个 hook**。
  想单独归因 hook 那一个变量,得另设一臂「只关 hook、其余不动」——本单不做,标 U7 留给 1299。
- **feature flag 覆盖面(硬要求)—— 分两层,缺一层 B/C 就被污染**:
  - **① prompt/模板层**(research.md §blast-radius 的每处活跃耦合都要参数化):
    1. `agents/generic-executor.md` 99–204 —— 三臂各自的 prompt 版本;
    2. **`.flywheel/agents/engineering/designer-executor.md`(:68/:141 裸名 `brainstorming`)** ——
       **B/C 臂必须同步改**,否则 generic 走了 Matt/裸模型、designer 还在调 Superpowers = 臂内不一致。
       **B/C 各自要改成什么,必须在臂定义里冻结全文/diff**(见 §2 附录):**B** = designer 的
       `brainstorming` 改指 Matt 的 `grilling`(唯一 model 可达的近义物,语义偏差要记录);
       **C** = 改指我们自有的 BRAINSTORM GATE / `product-brainstorming`。**不许只写「同步改」** ——
       不冻结版本 = 不同实现变成不同实验臂,无法归因(Codex R5 明确点名)。
    3. **generalized-workflow 模板(3 文件 / 4 node)评测期间 flag 固定 OFF** —— 否则 workflow 的
       prompt 改动混进对照,污染结果。
  - **② session-launch / 插件可见性层**(Codex R5 抓出的关键漏层 —— 光切 prompt flag 不够):
    Superpowers 的 hook + catalog 是**插件 SessionStart 注入**,Matt 是**机器级 FLY-216 分发** ——
    这两样**不受 prompt flag 控制**。所以每臂必须**新开 session**且钉死插件/skill 可见性:
    **A** = SessionStart 前 Superpowers hook+catalog 启用;**B** = 禁用 Superpowers、只暴露冻结的
    6 个 Matt skill;**C** = Superpowers 与全机分发的 Matt skill **都不可见**。
    **否则 B/C 的 hook / catalog / 成本测量全是脏的**(会把 A 的 1,778 tok 算进 B/C)。
- **抽样(必须明确)**:
  - **同一基线快照**(隔离环境)+ **随机化顺序** + **每臂新 session**(见 ②);
  - **明确 dispatch 路径**:主样本**强制 `agentName:"generic"`**(直读被改写的 prompt);
    ⚠️ **多数部门角色(engineer/qa/pm…)不读那个 shipped prompt** —— 但 **designer 例外**(它裸名调
    `brainstorming`),所以 **designer 路径要单独分层测量**(它是唯一「真部门角色 × 直接耦合」的样本,
    最能反映卸载/替换对真实 dispatch 的影响);再加一层「Flywheel unmatched issue」真实 fallback 样本。

## 4. 若采纳 Matt —— 落地路径(只写路径,不执行)

- **来源**:community 个人 repo,**MIT**(v3 更正:v2 写「无再授权风险」**过强** —— MIT 允许修改/
  再分发,**但要求保留版权与许可声明**;**本单未做法律审查**);仍须**安全审查** → 走 **FLY-216 flywheel-skills**
  既有 vendor 流程(审查 → vendor → launchd skills-sync 分发,无需重启 Bridge)。
  **不直接 `/plugin install` 生产**(且 plugin 形态有 §2 的 invocation 死结)。
- **只 vendor §2 钉死的 6 个子集**,不必全收 —— 继续减重。
- **改动点**:`generic-executor.md`(shipped 四步流)**+ `designer-executor.md`(裸名 `brainstorming`)**——
  ⚠️ v5 更正:v4 这里写「generic 是唯一提示词改动点」**是错的**(与 §3 要求 B/C 同步改 designer 冲突)。
  「唯一」只对 **shipped 四步流本身**成立,不对整个 change-set 成立。doc-flow / gate / ship 全走 Flywheel
  自有机器,**不交控给 Matt 的编排/收尾 skill**(与现 scope note 一致)。

## 5. 交接

- **交付**:`exploration.md` + `research.md`(核心 intel)+ 本 `plan.md` → 交 Lead HL。
- **HL 产 + 投** co-eval HTML(single-owner);runner 不碰 founder-facing。
- **喂给** FLY-1299。

## 6. Open questions(UNKNOWN,留给 FLY-1299 / Annie)

- **U1**:精确日注入总量 = session churn(restart/compact/clear 频率)+ **有多少 Lead 真活跃**依赖 →
  **UNKNOWN**,需 session telemetry。research.md 只给了「若 15 个各冷启一次 ≈ 26,670 tok」的**情景值
  (scenario value)—— 不是下界**(活跃度 UNKNOWN 时真实下界是 0)。
- **U2(臂 b 核心悬念)**:Matt 的 model-invoked description 触发,在**我们 headless runner 环境**下的
  真实 auto-invoke 率 = **未实测**。
- **U3**:各 skill **真实 runtime 使用率**(矩阵③列只证静态接线)= **UNKNOWN**,需 session telemetry。
  注意 `using-superpowers` 的全局强制会让模型去调**未接线**的 skill ⇒「未接进 ≠ 没在用」。
- **U4**:`to-spec`/`to-tickets` 翻成 model-invoked 后行为是否仍正确(它们的正文假定有真人交互)= 未验。
- **U6(catalog 数字的坐实)**:408 / 420 / 「微亏 12 tok」全是**源码字段拼出的 proxy**,不是
  Claude Code **真实渲染**进 prompt 的 payload。要坐实须在隔离 baseline 下分别启动
  Superpowers / 原版 Matt plugin / 最终 6-skill vendor 臂,抓真实 `/context` 或 usage delta。
  **本单做不了**(铁律:零生产变更、不装 Matt)⇒ 归 FLY-1299。**12 tok 级的差在坐实前无可信度。**
- **U7(单变量归因)**:A/C 是**端到端策略对照**(多变量:generic + designer + skill 可见性一起变),
  **不能把效果差异单归因给那个 hook**。想单独测「就那 1,370 tok hook 值不值」,需另设一臂
  「只关 Superpowers hook、prompt/skill 其余全不动」—— 本单不做,留给 FLY-1299。
- **U5**:Matt `/setup-matt-pocock-skills`(问 issue tracker / triage 标签 / docs 落点)与我们
  doc-flow / Linear 约定的整合成本 = 未评。

## 7. 附:实质更正记录(Codex code review 抓出)

### v1 → v2(R1)

1. **「Matt 每 session 0 token」= overclaim** → 真实 420 tok(catalog metadata)。**净省来自 hook,catalog 微亏。**
2. **「Flywheel 自己的仓走不到 shipped generic」= 假** → `labels: []` 永不匹配 + 无 `default_agent`
   ⇒ Flywheel unmatched issue **会**落到 generic-executor.md;另漏了 `dispatchByName("generic")` 路径。
   (根因:我把 config 里名为 `general` 的键 + 注释当成了行为 = 「拿标签冒充事实」。)
3. **矩阵把 Matt 的 user-invoked skill 当等价物** → 13 个 user-invoked 对 headless runner 不可达;
   `writing-plans` 实为 ❌ 无对应物。
4. **③ 列「我们实际用不用」→「静态接线」**:prompt 引用不证明 runtime invoke。
5. **舰队「15 个 Lead 都在消费 hook」= 从注册数推断** → 降级为「15 个已**注册**」+ 标 UNKNOWN。

### v2 → v3(R2)

6. **「26,670 = 下界」= 错** → 活跃度 UNKNOWN 时真实下界是 **0**;26,670 是**情景值**。
   「真实日耗是数倍到十几倍」**完全未证,已删**。(这是我**第二次**把推断写成实测,记在这里。)
7. **catalog 数字(408/420/微亏 12)= 源码字段拼的 proxy**,非 Claude Code 真实渲染 payload
   ⇒ 12 tok 级差**无可信度**;坐实方法 + 为何本单做不了 → U6。
8. **1,778 = context-epoch footprint proxy ≠ session 账单** ⇒ 指标② 改四类 token 分记 + 按各自费率。
9. **臂 (b) 只 vendor 6 个且改 frontmatter** ⇒ 420 / 1,358 / 12 **对本臂作废**,须冻结后重测。
10. **矩阵越界表述已收**:删「两边都不需要/不影响决策」「唯一真正丢的是强制」(第③列证不了)。
11. **plan 的三处 overclaim 已收**:「三臂只差强制层」(加限定)、「(a) vs (c) 零第三方依赖」
    (→ 对 Superpowers 层的 **ablation**)、「MIT 无再授权风险」(→ MIT 要求保留版权/许可声明,
    **未做法律审查**)。
12. **所有「预期」→ 待检验假设 H1–H7**(它们正是 A/B 要测的东西,不是成本画像里的既定结论)。
