# FLY-1380 种 work-kind 模板(只建不迁) — 探索

Issue: FLY-1380 (https://linear.app/geoforge3d/issue/FLY-1380/dagbuild-种-work-kind-binding1396-prd-落地-派发按活的类型选模板不再一律-tpl-eng-heavy)
日期: 2026-07-22
基于: 无(上游权威 = `product/doc/FLY-1396-dag-tier-binding/prd.md` + `fly1385-addendum.md`,均已 merge)

---

## 1. 本单是什么、不是什么

FLY-1396 PRD 定了「派发按活的类型(work-kind)选模板」的产品形状;引擎面(开关、taskCategory 校验、exact-row enforcement、route 收据、tier 管道、`retired_at` eligibility seam)已由 **FLY-1407 全部落地并 merge**(`e79d7daf`,在本分支历史内)。

**本单 = PRD §6 第 1 步「只建不迁」**:把 work-kind 映射表(§3.2)需要的 5 套模板 identity **创建 + 发布(dormant)**,同时保证:

1. **不写任何 live category binding** —— binding 统一留给 post-1407 的一次性 cutover(带 activation gate,另单);
2. **warm/重启不得写新 binding audit row**(`ensureDefaultWorkflowBindings` 的默认集保持 legacy 原样);
3. 补上 FLY-1407 D9a 移交过来的 **retire 写入面**(谁在何时置 `retired_at` —— 本单建机制,cutover 后才执行)。

**明确不做**:不写 binding、不动 per-project `pipeline.work_kind` 开关、不翻 `FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES`、不改 selection/runs-route 的任何引擎行为、不动 `.flywheel/agents/` 下的 pm-executor / prototype-executor(§5.3 label 语义压在 founder 门后,那是 cutover 原子单元的第三件)。

## 2. 现状(生产实测,2026-07-22)

- 生产 env:`FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1`(DAG 派发**已开**,本 runner 自身就是一个 v1 DAG design 节点);`FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES` **未设 = off**。
- 生产 DB(`~/.flywheel/teamlead.db` 只读副本实查):
  - `workflow_template`:**只有 6 个 v1 模板**(tpl_eng_heavy/light/trivial + 3 个 `_land_v1` 变体),零 v2 模板 —— v2 seed 被 generalized flag 在 import 处挡掉(skip + store 层 throw 双保险)。
  - `workflow_category_binding`:6 个项目各**恰一行** `* → tpl_eng_heavy`(`system:bundled-default`)。
  - `retired_at` 列已存在(FLY-1407),全 NULL;`workflow_route_decision` / `workflow_route_reminder_outbox` 表已建。
  - `workflow_run`:25 条 tpl_eng_heavy + 27 条空 template_id(legacy),land 变体零使用。
- binding 的唯一写入者 = `ensureDefaultWorkflowBindings`(`workflow-template.ts:1337`),守卫 =「项目已有任何 binding 就跳过」→ 生产 6 项目全部有行 → **当前 warm 已经不写行**;新项目才会种 legacy 3 行(`*`/`light`/`trivial`)。
- cutover 执行器(一次性迁移 binding 的工具)**尚不存在** —— `bindWorkflowCategory` 在产品代码里只有这一个 caller。

## 3. 设计空间与取舍

### D1:merged `tpl_eng` 用 schema v1 还是 v2?

**定案:v1。**

- FLY-1407 D1 明写「`work_kind && !dag`:category=code 走 **v1 DAG 入口**」—— 引擎侧已按 code→v1 设计;
- v1 的 design/implement/qa 类型节点带着全部现有机制(three-stage 派发、handoff、land 变体、我现在跑的这条流水线);
- v1 manifest **已支持 `tier_presets`**(`workflow-template.ts:665` 验证),tier 管道(`req.body.tier` → selection 应用 preset,`workflow-template-selection.ts:222-235`)对 v1/v2 一视同仁;
- v1 seed 不受 generalized flag 挡,import 即发布,dormant 语义最干净。

被否:v2 版工程模板 —— 引擎对 code 类别的入口按 v1 建,v2 化没有收益、多一层 flag 依赖。

### D2:三档合并怎么用 tier_presets 表达(逐字节复现三套旧 seed)

三套旧 eng seed **拓扑完全相同**(design→implement→qa→founder_gate + qa_retry loop max 3),只差每节点 vendor/model/effort —— 实测差异:

| 节点 | trivial | light | heavy |
|---|---|---|---|
| design | codex/gpt-5.6-sol | codex/gpt-5.6-sol | claude/claude-fable-5 |
| implement | codex/gpt-5.6-sol(无 effort) | codex/gpt-5.6-sol(无 effort) | codex/gpt-5.6-sol **xhigh** |
| qa | claude/claude-fable-5 | claude/claude-opus-4-8 | claude/claude-opus-4-8 |

关键约束:`applyWorkflowOverride` 只能**设置** effort,不能**清除** effort。⇒ **base manifest 取「无 effort 的公共底座」**(design=claude/fable、implement=codex/无 effort、qa=claude/opus),heavy preset 只加 `implement.effort=xhigh`,light/trivial preset 覆盖 design(与 trivial 的 qa)。这样**三个 preset 应用后的最终 manifest 与三套旧 seed 的节点配置逐字节一致**;tier 缺省 = heavy(FLY-1407 D6,selection 里 `input.tier ?? DEFAULT_ENG_TIER`),base 永远不会裸跑。

被否:base=heavy 原样 + light/trivial preset 改 effort —— override 无法把 xhigh 清回「无 effort」,复现不了旧行为。

### D3:designer / prototype 的 §7 流程怎么落进 v2 schema

v2 validator 的硬约束(`workflow-template.ts:1052-1103` 实测):

- **非终点 gate 节点不可表达**(每个非终点节点必须恰一条出边且条件与类型绑定;gate 类型无合法出边条件);
- **loop 只能挂在 qa 节点(qa_fail)与 review 节点(review_fail→直接上游)**;`founder_feedback_kickback` 只在 **v1 land 变体**的 approval gate 上可用;
- **loop 必须有限次数**(正整数 max_iterations),开放循环不可表达;
- 每个非终点节点**恰一条出边**,无条件分支。

⇒ §7 里「founder 中途确认方向」「开放的细节打磨循环」在 DAG 图层面**不可表达**(要表达就得给 v2 移植 approval-gate 引擎机制 = 引擎工程,超出「只建」)。

**定案:founder 交互收进节点内,DAG 只表达可审计的骨架。**

- `tpl_product_designer`(v2):`design_iterate`(generic,产 output)→ `review`(review_fail 回 design_iterate,max 3)→ `founder_gate`。
  低保真 → founder 确认方向 → 开放细节循环 → hi-fi **全部发生在 `design_iterate` 节点会话内**,由专用 executor(`agents/designer-executor.md`)驱动:方向确认走现成的 `flywheel-comm gate question`(阻塞门,FLY-217 generic-executor BRAINSTORM GATE 同款机制,经 Lead relay 到 founder);「她没回不等于默认定稿」由 executor 合同写死(gate 超时不得当批准)。review_fail 回到 `design_iterate` = §7 的「回到低保真那步」(节点重跑从最便宜一步起)。
- `tpl_product_prototype`(v2):`build`(generic,产 output)→ `review`(review_fail 回 build,**max 2** = §7「修 ≤2 轮」)→ `founder_gate`。
  「不许让 founder 试跑不起来的东西」由两层兜:executor 合同要求 build 节点自证能跑才算完成;review 节点独立验证「一条命令能跑」。「能做 / 不能做都是合法终态」映射到 founder gate 的现有动作面:approve = 能做(交工程产品化),reject/shelve + 理由 = 不能做 —— 模板层不新造终态语义。

**诚实边界**:founder 中途交互在 DAG 观测面上是「节点内事件」而不是独立节点;§7 的开放循环终止条件(founder 显式「定了」)靠 executor 合同 + gate 机制保证,不靠图结构。若未来要图层面表达,需另立引擎单把 v1-land 的 approval-gate 机制移植到 v2 —— 本单不做,也不需要:§7 获批的是**流程合同**(行为),不是图形状。

被否的替代:
- (a) 给 v2 加 mid-flow approval gate —— 引擎工程(dispatcher/StateStore/actions 全要动),违反「只建不迁」的边界,且 1396 PRD §8-A 没有给本单这个授权;
- (b) 拆成两个 generic 节点(lofi → hifi)—— v2 无条件分支,review_fail 只能回直接上游 hifi,表达不了「回低保真」,反而违反 §7;
- (c) 复用 `.flywheel/agents/engineering/product-designer-executor.md`(FLY-880 的 Mode A/B PM agent)—— 那是 label 路由的 legacy 单 session 角色,合同(共创五铁律)与 DAG 节点的 bounded 语义不匹配,且它是 flywheel 项目私有文件,global 模板引用不到别的项目。

### D4:v2 模板在生产怎么「发布但 dormant」

现状:v2 seed 在 import 处被 generalized flag 双重挡(`importBundledWorkflowSeeds` skip + `importWorkflowTemplateSeed` throw)⇒ 生产永远装不上,per-project preflight(5 kind 目标全部已发布)永远过不了,cutover 死锁。

**定案:解除 import 层的 flag 门(两处),selection/entry 的 flag 门一概不动。**

- 「安装+发布」只写 `workflow_template` / `_revision` / `_publication` / `_audit(seed_import)` 四张模板表,**不碰 binding** —— 对路由是惰性的:fresh selection 无 binding 到不了它们,generalized flag off 时 v2 candidate 在 selection 层照样 409(FLY-1407 加固过),`templateId` 直选同理被挡;
- import 内容哈希幂等:首次部署重启装一次(每模板一组行 + 一条 seed_import 审计),之后 warm 全部 `unchanged` 零写入;
- 这正是 §6 第 1 步「发布 ≠ 绑定」的机制化:发布满足 preflight 的「target 已发布」检查,绑定被 activation gate 锁住。

被否:留 flag 门、另开一条显式「安装命令」—— 多一个控制面,且新机器 / QA slot 不能自愈;§5.5 第 5 例(假控制面)教训是控制面越少越真越好。**注意**:这不是「重启静默激活」—— §5.5-2 禁的是 binding audit row;模板表的 seed_import 是「创建+发布」这个已批准动作本身,且只发生一次。

### D5:`tpl_generic` 与旧库存怎么处置(替换不是新增)

**定案:**

- 新 seed `tpl_generic.yaml` = tpl_ops_light 的单节点 manifest(generic execute → founder_gate),**新 identity**;
- **从 bundle 列表移除 `tpl_ops_light.yaml` + `tpl_research_light.yaml` 并删除文件** —— 两者生产从未安装(v2 被挡),移除后生产**永远不会出现**这两个注定退休的 identity;已在 flag-on 环境装过的(QA slot)留在 DB,随 §3.3 retire 时序处理;
- 旧 eng 三件(heavy/light/trivial)+ 3 个 land 变体 seed **原样保留** —— 生产在用(wildcard→tpl_eng_heavy 是现行路径 + 回滚防线),retire 是 cutover 成功之后的另一步。

### D6:tpl_eng 要不要 land 变体孪生

**定案:要,`tpl_eng_land_v1`**(同 base + approval_gate/land 节点 + 同 tier_presets)。理由:FLY-1375 的 land 流程按「每个 eng 模板一个 `_land_v1` 孪生」建的;若 merged tpl_eng 没有孪生,cutover 把 code 绑到 tpl_eng 后,land 选项只剩注定退休的旧 identity,库存不自洽。这是对 PRD §3.2 字面清单的一个**加项**(PRD 未提 land 变体),在 plan 里显式标出交 design review 把关。

### D7:retire 写入面(FLY-1407 D9a 的移交)

**定案:只建 store 层机制,不建入口、不执行。**

`StateStore.retireWorkflowTemplate({templateId, actor, reason})`:

- fail-closed 守卫:模板必须存在;**任何项目的任何 binding 行(exact 或 `*`)引用该模板 ⇒ 拒绝**(§3.3「零 live refs 复查」的机器化);
- 幂等:已 retired ⇒ no-op(返回状态,不重写审计);
- 成功:置 `retired_at` + `workflow_template_audit` 行(action `template_retire`,detail 含 reason);
- **不做 unretire** —— retire 只发生在「cutover 成功 + 零 live refs」之后,误操作场景由 founder-gated 迁移工具兜(enforce simplicity);
- 消费方:post-cutover 的 retire 步骤(cutover 单负责接线);active pinned run 天然免疫(recovery candidate-free,`retired_at` 只挡 fresh selection,FLY-1407 已实现该读侧)。

### D8:seeder 默认集与 dormancy 守卫

**定案:`DEFAULT_ENGINEERING_WORKFLOW_BINDINGS` 一个字节不动**(仍是 `*`/`light`/`trivial` → 旧三件)。work-kind 五类**永不进 boot 默认集** —— 加一条**哨兵测试**:断言默认集与 work-kind 词表(`WORK_KIND_CATEGORIES`)交集为空 + 断言「已有 binding 的项目 warm 零写入」(fixture 用生产形状:项目已有恰一行 `*→tpl_eng_heavy`)。这把 §5.5-2「重启静默激活」变成结构上写不出来的东西。

## 4. 交付物清单(exploration 层面)

1. 5+1 个新 seed YAML:`tpl_eng` / `tpl_eng_land_v1` / `tpl_product_designer` / `tpl_product_prototype` / `tpl_generic`(+ `tpl_product_v1` 已在 bundle,内容不动);
2. bundle 列表更新(移除 ops_light/research_light,追加新五个);
3. import 层 flag 门解除(两处);
4. 2 个新 shipped executor:`agents/designer-executor.md` / `agents/prototype-executor.md`(<40k 字符,`readAgent` 截断线);
5. `StateStore.retireWorkflowTemplate` + 审计;
6. 哨兵/回归测试(默认集 dormancy、import 幂等、preset 逐字节复现、新 manifest 过 validator、retire 守卫)。

## 5. 开放问题(交 research/plan 收口)

- `isGeneralizedTemplatesEnabled` 的全部 caller 盘点(确认解除 import 门不影响 selection/entry 门);
- `loadBundledWorkflowSeeds` 顺序有无持久化消费者(移除两个条目是否安全);
- v2 generic 节点 `agent_file` 按 `canonicalRoot`(**目标项目 repo 根**)解析(`workflow-run-snapshot.ts:99-120`)⇒ designer/prototype executor 文件必须存在于**每个要 cutover 的项目 repo**;本单先落 flywheel repo(`agents/`),per-project 铺设写进 cutover preflight 的合同 —— 落点与措辞在 plan 里定;
- designer/prototype 节点的 vendor/model 选型(§7 说「节点/vendor/model 留工程设计」)。
