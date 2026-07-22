# FLY-1407 binding-migration 引擎面落地 — 探索
Issue: FLY-1407 (https://linear.app/geoforge3d/issue/FLY-1407/enginebinding-migration-1396-addendum-引擎面落地v2-入口三件套keylessflag-offauth)
日期: 2026-07-21
基于: 无(上游为跨文件夹契约:`product/doc/FLY-1396-dag-tier-binding/fly1385-addendum.md`(唯一权威)+ 同文件夹 `prd.md`)

---

## 1. 本单是什么(授权链对账)

FLY-1396 PRD 把「交引擎实现的 runtime 契约」写成独立 addendum 文件(五条 ①-⑤)。FLY-1385 原计划承接,但收官时 Lead 裁定(FLY-1385 Linear comment `fcf6dd77`,2026-07-21 13:24 PDT):

> addendum 中 **v2 入口三件套 + 6(d) 已在 FLY-1385 W8 设计并实现**(R6 APPROVED @ 5cebd21bb,已 ship main=3fbcbb9a);仍待设计的增量 = **三条 runtime 契约**(① override idempotency 生命周期 / ② taskCategory 输入合同 / ③ direct templateId sentinel+metrics 排除)+ §8-D 四拍(cutover 程序)。三条契约**于 binding 迁移阶段承接设计** —— 本单就是那张单。

⚠️ **issue 标题里的「v2 入口三件套 + 6(d)」因此不是重做**,而是:**对已 ship 的 W8 做逐条契约对账**(addendum 定稿晚于 W8 设计,可能有 W8 没覆盖的条款)+ 把真正的增量(①②③ + derive/tier/provenance)设计出来。验收明令「addendum 逐条契约 → 实现+测试映射表,不许静默 descope」,所以映射表必须覆盖 addendum **全部**条款,每条标:已 ship(带代码证据)/ 本单实现 / 明确出去(带具名接收方)。

**与 FLY-1380 的关系**:本单 blocks FLY-1380(种 binding)。rollout 链(PRD §6):1380 只建模板不迁 → **本单引擎面** → 迁 binding(带回归 fixture)→ 开 flag(cutover,founder-gated)。

## 2. 已 ship 的 W8(main=3fbcbb9a,证据已核)

| 面 | 代码证据 | 状态 |
|---|---|---|
| **keyless 面**:v2 candidate + flag on + 无显式 key ⇒ 合成 `wf2-auto-${uuid}` | `runs-route.ts:1344-1355` | ✅ ship |
| **flag-off 面**:主 flag off ⇒ resolver 返 null,v2 与 v1 同等回落 incumbent 政策(字节等同 legacy) | `workflow-template-selection.ts:131-138`、`runs-route.ts:1106-1110,1196-1201` | ✅ ship |
| **auth 面**:fresh-main v2 维持 master-only(不放宽) | `workflow-template-selection.ts:148-150`、recovery `:360-362` | ✅ ship |
| **6(d) 短路**:fresh main + `no-three-stage` ⇒ candidate-free、selection=null、零 run/reservation,先于任何 v2 selection/materialization | `runs-route.ts:1100-1104,1106-1118,1362-1363` | ✅ ship |
| **短路前置 fail-closed 守卫**:active engine-owned run 在场 ⇒ 不得起 legacy(分类 → recovery/hold/拒) | `runs-route.ts:920-1083` | ✅ ship |
| **entry_kind='workflow_v2' 持久标记** + unmarked 存量 v2 兼容分类 | `runs-route.ts:964-971,1386`、StateStore `entry_kind` 列 | ✅ ship |

⚠️ 但 W8 的 6(d) 读的是 **issue label**(`normalizedIssueLabels.includes(NO_THREE_STAGE_LABEL)`)—— 这在 cutover 前是对的(§5.6 不继承只在开关 on 后生效);开关语义是本单的活。

## 3. 缺口清单(本单要设计的,逐条核过代码)

### G1 · per-project cutover 开关不存在
「v2-routed ≡ work-kind cutover 开关已开」的那个开关(addendum ②/④.3)代码里没有。现有先例:`PipelineConfig.dag`(`packages/config/src/types.ts:304-343`,per-project、canonical root、每次 dispatch 现读)。判定必须发生在 candidate/binding lookup **之前**(addendum ② 判定时点)。

### G2 · taskCategory 零校验、absent 落通配
- `runs-route.ts:1086-1096`:非 string **静默当 absent**(addendum 点名要在开关 on 时改 4xx);
- `workflow-template-selection.ts:41`:`trim() || "*"` —— absent/空白 → 通配兜底。开关 on 后 v2-routed 域内这是被禁的(required-param gate:absent ⇒ 拒绝派发);
- 词表(`prd|designer|prototype|code|research`)代码里不存在;canonicalize(大小写/空白)不存在;
- 校验/lint/验收共用同一张表(addendum ②.3)⇒ 词表要有唯一定义点。

### G3 · exact-row enforcement 不存在
`StateStore.getWorkflowCategoryBinding`(`:13378-13385`)对 exact miss **自动回 `*`**,调用方无法区分 exact 命中 vs wildcard 回退。开关 on + category 路径:缺 exact row 必须 fail-loud 不物化(§4.4a);开关 on 时 `*` 不得被 fresh selection 消费(§9 验收 5b)。

### G4 · provenance 第二轴(category_source)不存在
现有 `selection_source = lead|binding|default`(模板来源轴)保留原义;**新轴 `category_source = task_category|template_override`** 无处记录:
- `workflow_run` 表(StateStore:12330-12346)无 task_category / category_source 列;
- pinned snapshot(`workflow-run-snapshot.ts`)不含 category/source/tier;
- selection digest 已含 category(`workflow-template-selection.ts:165-174`)但不含 category_source/tier。

### G5 · 回显不存在
generalized 200/202(`runs-route.ts:1757-1768,1806-1815`)与 legacy 200(`:2040-2049`)都不含「本次 work-kind 是什么 + 来自哪」。addendum ②.4:必须回显给派它的人,仅 audit 不算。

### G6 · (sent_category, 部门建议值) 对无持久化
`owningDept` 在 `runs-route.ts:852` 解析后只送 dispatcher,selection/snapshot 不记(addendum ②.4a 点名)。部门→建议值映射(`product→prd`,`engineering→code`)服务端也不存在 —— 它**不进路由语义**,但**要进持久记录**供聚合。

### G7 · 6(d) 的 override 路径与 route-decision 可见性不存在
- `routingOverrides` 字段(§5.6 输入合同:allowlist 单值 `no-three-stage`,只在 master fresh-main 收)代码里不存在(grep 零命中);
- no-three-stage bypass 生效时**无任何 route-decision 记录**(legacy 路径连 run 行都没有 —— 这是产品明令的:零 run/reservation);addendum ①.1 要求 legacy 与 v2 两条路径都可观察;
- 行为冲突 lint(本次显式 override × 本次显式 taskCategory 冲突 → 要求确认)不存在;
- inert label(残留 no-three-stage,开关 on 域)不阻断不确认、至多记 documentation intent —— 现在 label 直接生效(cutover 前正确,需挂开关)。

### G8 · tier plumbing 不存在
- `applyWorkflowOverride`(`workflow-template.ts:990-1035`)只接受 model/effort/skip、**强制 vendor 兼容不能切 vendor**;而 §3.4 的三档 preset 跨 vendor(design 节点 trivial=codex vs heavy=claude)⇒ 现有 override 表达不了;
- selection 调 materialize 时不传 override;tier 无输入口、无默认档、不进 digest/snapshot。

### G9 · 派发面(三个)
- Claude Lead rules:全文零 taskCategory(cutover 前置,§8-D ②拍);
- Gemini `dispatch_runner`:schema 无 taskCategory(`gemini-agent/src/tools/schemas.ts:66-98`;docTier 是 enum 写法先例、不借其 optional);
- Codex Lead:不派 Runner,不涉及。
⚠️ 时序发现:Gemini schema 一改 required,Gemini Lead 会**立即对所有项目**开始传 category —— 在 DAG-enrolled v1 项目上会改变 live 路由(exact 命中 light/trivial)。⇒ 派发面改动属 cutover 窗口,不进本单引擎 PR(映射表具名)。

## 4. 设计空间(每个「(c) 谁定」决策点的选项与倾向)

| # | 决策点 | 选项 | 倾向(理由) |
|---|---|---|---|
| D1 | 开关落点 | (a) `pipeline.work_kind` config 键(镜像 `dag`) (b) StateStore per-project flag (c) env 列表 | **(a)**:per-project 天然、dispatch-time 现读免重启、回滚=revert 一行、与 dag/three_stage 同族审计路径;(b) 多一套控制面,违背 §5.5「控制面必须真」的最小化;(c) 不 per-project |
| D2 | route-decision receipt 形态(addendum ①) | (a) 新 append-only 表 `workflow_route_decision`,legacy+v2 两路都写 (b) 塞 session_params (c) 只扩 workflow_run | **(a)**:legacy bypass 无 run 行(产品明令),(c) 覆盖不了;(b) 不可聚合、且 session 晚于 decision 存在;(a) 同时解决 G5 回显源、G6 聚合对、①.1 双路可观察 |
| D3 | bypass 的幂等语义(addendum ①) | (a) 接受 legacy 单-active-session 语义 + 独立 receipt (b) 给 bypass 造 generalized idempotency | **(a)**:①.5 明令 bypass 不存在 pinned snapshot;造 key 记账会把 no-three-stage 拖进 v2 selection(①.4 禁);receipt 提供可见性,active-session 守卫提供防双开 |
| D4 | ① 的 reason/selectedBy | reason 必填自由文本 vs 固定机器 reason | **固定机器 reason**(`dispatch_override:no-three-stage`);selectedBy=leadId(与 selection 同源)。自由文本必填会逼 Lead 编话,信息量为零 |
| D5 | tier vendor path(§3.4 二选一,§11 Open 明确交本设计拍) | (a) 各档同 vendor 预置 (b) 扩 override 受校验 vendor+model 原子覆盖 | **(b)**:§3.4 preset 表本身跨 vendor,(a) 表达不了产品已定的档位 |
| D6 | tier 默认档 | 缺省=heavy vs 必填 | **缺省=heavy**(等价今天 `*→tpl_eng_heavy` 的事实行为;required gate 只管 work-kind,PRD 未把 tier 纳入硬门) |
| D7 | 回显落点(addendum ②(c)) | HTTP 响应体 / Lead 回执文本 / 两者 | **HTTP 响应体**(200 与 202 同构,generalized 已有 dagAuthority 附加回显先例)+ receipt 持久;Lead 侧文本由 rules 指令转述(cutover 窗) |
| D8 | 错误码形态(addendum ②(c)) | 复用 GENERALIZED_WORKFLOW_REJECTED vs 专用稳定码 | **专用稳定码族**(docTier 的 `INVALID_DOC_TIER` FLY-127 machine-only 先例):`INVALID_TASK_CATEGORY` / `WORK_KIND_REQUIRED` / `WORK_KIND_BINDING_MISSING` / `INVALID_ROUTING_OVERRIDE` / `ROUTING_CONFLICT_CONFIRM_REQUIRED` |

## 5. 明确出去的(映射表将具名,不静默 descope)

- **④.2 cutover owner / activation-gate 迁移**:FLY-1380 + cutover 单(本单只保证:引擎在开关 off 时对 dormant binding 零消费;seeder 纪律属 1380)。
- **④.1 回归 fixture**:场景「dormant v2 binding 在场 + 开关 off ⇒ 旧行为」—— 开关生于本单 ⇒ **fixture 本单先落**(迁移 PR 前置自然满足);迁移 PR 复跑。
- **⑤ prompt 资产翻转时序 + §8-D 四拍**:cutover 程序,founder-gated(pm/prototype-executor.md 改动待 Annie 点头);本单引擎侧唯一交集 = 开关语义让「翻转前全旧态」成立。
- **G9 派发面**(Claude rules ②拍 / Gemini schema required enum):cutover 窗交付物。
- **§5.2.4 per-project 上线检查(5 kind+* preflight)**:cutover 前置工具,属迁移包;本单提供 exact-row 查询能力即可。

## 6. Open questions(带进 research/plan)

1. 开关 on 时 legacy 响应体加回显字段是否破坏既有消费者?(初判:legacy off 域字节不动;on 域是新世界,加字段安全)
2. `workflow_route_decision` 写入时点:decision 时(launch 前)写、launch 后补 execution_id,还是 launch 后一次写?(crash 窗口与「先起 Runner 再 200」时点的诚实性)
3. tier 输入口字段名(`tier` vs `engTier`)与「模板无 preset 却传 tier」的处置(初判:4xx,§5.5 显式输入不静默吞)。
4. 冲突 lint 的「要求确认」形态:同请求重发带确认字段,还是 4xx+提示后 Lead 改参重发?(初判:稳定 4xx `ROUTING_CONFLICT_CONFIRM_REQUIRED` + 重发时去掉冲突一方 = 「显式确认」;不做会话态确认协议)
