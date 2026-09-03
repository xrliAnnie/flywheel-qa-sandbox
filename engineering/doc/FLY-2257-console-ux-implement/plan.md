# FLY-2257 管理台 UX 落地 — 实施计划

Issue: FLY-2257 (https://linear.app/geoforge3d/issue/FLY-2257/管理台ux-fly-2071-实现-dag模板统一框尺寸花名册sourcelink链接删项目面板flag语义化删governance)
日期: 2026-09-03
基于: research.md

## 0. 一句话

把 FLY-2071 定义文档的四个改动区落进**生产管理台 `/`**(`fleet-console-html.ts`),数据全部走既有的 snapshot 读边界;
registry 新增纯展示字段 `onMeans`,删除 `governance_gate` 机制并把规矩写进 flag 约定文档;
21 个 flag 的值 / polarity / default / 解析路径零变化。

Lead 已裁定(2026-09-03,问题 `b5c55672`):落生产 `/` 不并行 `/console-next`;`onMeans` 由 registry 提供、守卫要有变异体阳性对照;
registry 的 `category` 整体删与 FLY-2071 plan 第 6 条**本单不做**(§8 有承接);不加任何开关 / 旋钮;语义化后不得再出现要人猜的「打开 = ?」文案。

## 1. 边界

- **改**:`packages/config/src/feature-flags/{registry,store-policy,direct-toggle,resolve}.ts`、
  `packages/teamlead/src/bridge/{management-console-contract,management-dag-source,management-existing-writers,feature-flag-render,fleet-console-html}.ts`、
  对应测试、`doc/engineer/implementation/flag-authoring-runbook.md`、本文件夹 `evidence/`。
- **不改**:`workflow-template.ts`(manifest 合同)、`management-topology-source.ts`(`sourceLink` 生成)、flag store / codec / 解析、写路径 `stage/apply`、
  `feature-flag-report-html.ts` 的措辞(只随 `governance_gate` 删除少两处分支)、`plugin.ts` 路由表(不新增路由;main 上没有 `/console-next`,无老路可删)。
- **不做**:见 §8。

## 2. 稳定标识与显示标签(前端 DOM 合同)

| 东西 | 稳定标识(测试与脚本用) | 显示标签(可改文案) |
|---|---|---|
| 模板分类段 | `button.seg-b[data-kind="engineering"\|"product"]` | 工程 / 产品 |
| 模板卡 | `article.squad[data-template="<templateId>"]` | `dag.title` |
| 节点框 | `.dag-chip[data-node="<templateId>/<nodeId>"][data-node-type="<type>"]` | `graph.nodes[].name` |
| 花名册项 | `.ic[data-role="<role.id>"]`,可点时是 `a.ic-link[href]` | `role.name` + 文件名 |
| flag 行 | `article.flag-row[data-flag="<flag.name>"]`,语义句 `.flag-read[data-tone]` | 7 句模板(§4.3) |
| 分类规则说明 | `.lay-note[data-rule="eng-node-types"]` | 由常量 `ENG_NODE_TYPES` 拼出 |

## 3. Chunk 划分(每个 chunk 可独立 commit、独立回退)

### C1 registry:`onMeans` + 删 `governance_gate` + 规矩进文档

**文件**:`registry.ts`、`store-policy.ts`、`direct-toggle.ts`、`resolve.ts`(仅类型收窄 + 透传)、`feature-flag-render.ts`、`management-existing-writers.ts`、
`flag-authoring-runbook.md`、4 个 config 测试 + `feature-flag-render.test.ts`。

1. `FeatureFlagSpec` 新增:
   ```ts
   /** FLY-2257: what `true` means for a bool flag. Projected for display only; never affects effective-value resolution. */
   onMeans?: "enables" | "disables";
   ```
   21 条取值:`cmux_watcher_rebuild_disabled`、`cmux_rebind_disabled` ⇒ `"disables"`;
   其余 16 个 bool ⇒ `"enables"`;`summary_absorption_cadence_ms`、`node_dwell_threshold_hours`、`skill_framework_mode` 不填。
2. 新增纯谓词(同 `validateKeepFieldContract` 形状)并导出:
   ```ts
   export function validateOnMeansContract(spec: FeatureFlagSpec): string[]
   // bool 必填;非 bool 不得填;name 以 _disabled 结尾 ⇒ 必须是 "disables"
   ```
   **测试三件套**(`feature-flags-registry.test.ts`):① 真表 21 条全部 `[]`;② **变异体阳性对照**:把 `cmux_rebind_disabled` 复制一份改成 `"enables"` ⇒ 返回含 `_disabled` 字样的违规;
   把 `alert_system` 复制一份删掉 `onMeans` ⇒ 违规;把 `skill_framework_mode` 复制一份填 `"enables"` ⇒ 违规。任一对照不红,守卫不算存在(Lead 原话)。
3. `FlagCategory = "feature" | "kill_switch"`;删除 §research-4 表里全部 `governance_gate` 分支与对应测试;`registry.ts` 头注释改指 runbook 新小节。
4. `resolve.ts` `resolveFlag()` 的 `base` 增加 `polarity: spec.polarity, onMeans: spec.onMeans`;`FlagView` 接口增这两个字段(`polarity: FlagPolarity; onMeans?: "enables" | "disables"`)。
   两处手写 `FlagView` 的 fixture 在本 chunk 同步补字段,C1 自身要能过 tsc:`packages/config/src/__tests__/feature-flags-scan.test.ts`、`packages/teamlead/src/bridge/__tests__/flag-retirement-scan.test.ts`。
5. runbook 新增小节(原文,一字不少):
   > ## 治理性策略不是 flag
   > **治理性策略不做成 flag,写死在代码里,要改走 PR。** `governance_gate` 类别已于 FLY-2257 删除;凡是「打开就限制或阻断 pipeline」的东西(founder 同意门、合入门、写权限门)不进 registry,不进 store,不出现在管理台。
6. 值不变量在 C1 层的证据:改前(main)与改后各跑一次 `node -e` 把 `FEATURE_FLAGS.map(f=>[f.name,f.default,f.polarity,f.valueKind,f.scope,f.source])` 打成 JSON,diff 为空;
   `packages/config` 既有的值解析断言(codec / `resolveEnvEffective` / store 优先级 / drift)**一条不改、全部绿**,只允许新增投影 / 合同断言;
   `resolve.ts` 的**有效值解析逻辑零改动**:`resolveFlag()` 可执行部分只多两条投影赋值(`polarity` / `onMeans`),其余 diff 只在 `FlagView` 接口声明(与可能的类型 import);`store-policy.ts` 只少 governance 分支。

### C2 snapshot 合同:DAG 图形状 + flag 语义字段

**文件**:`management-console-contract.ts`、`management-dag-source.ts`、`management-existing-writers.ts`、
`management-console-contract.test.ts`、`management-console-snapshot.test.ts`、`management-dag-source` 相关测试、`management-existing-writers` 相关测试。

1. 合同新增(全部为**只读投影**,没有 `ManagedValue`,不进 `targetIndex`):
   ```ts
   export interface ManagementDagGraphNode { id: string; name: string; type: WorkflowNodeType; execution: "agent" | "gate" | "engine"; }
   export interface ManagementDagGraphEdge { id: string; from: string; to: string; }          // 普通边,端点是 node id
   export interface ManagementDagGraphLoop { id: string; from: string; to: string; maxIterations: number | null; }  // 回环,端点是 node id
   export interface ManagementDagGraph { nodes: ManagementDagGraphNode[]; edges: ManagementDagGraphEdge[]; loops: ManagementDagGraphLoop[]; }
   // ManagementDagView 新增: graph: ManagementDagGraph | null   (manifest 解析失败时 null,error 照旧)
   // 🔴 id 命名空间(唯一一条规则,处处照用):graph.nodes[].id、edges[].from/to、loops[].from/to 全部是【裸 manifest node id】(如 "implement");
   //    既有的可写 nodes[].id 仍是 "<templateId>/<nodeId>";页面对齐两者用 dag.templateId + "/" + graph.nodes[].id,DOM 的 data-node 也这么派生。
   // ManagementFlagView: 删 category;新增 polarity: FlagPolarity; default: boolean | string; valueKind: FlagValueKind; onMeans: "enables" | "disables" | null
   // MANAGEMENT_SCHEMA_VERSION: 1 → 2(合同形状变了:删了一个字段、加了必填字段)。生产侧 `assertManagementSnapshot()` 只认当前版本(它是【生产者侧】自检,在 buildManagementSnapshot 里跑);
   // 浏览器侧现在没有版本核对 ⇒ 页面 JS 加一行:snapshot.schemaVersion !== <期望值> 就显示「管理台已更新,请刷新页面」并不渲染。
   // 期望值由 getFleetConsoleHtml() 在生成 HTML 时从 MANAGEMENT_SCHEMA_VERSION 注入,不再手写第二个版本字面量。
   // ⚠️ 它保护的是【新页面遇到旧/回滚后端】;部署前就开着的旧 tab 跑的是旧 JS,里面没有这行,保护不到 —— 见 C2.4 的实测与 §4.4。
   ```
   **画图模型(明说,不靠数组顺序)**:节点在画布上的**位置**按 `graph.nodes` 的 manifest 顺序排(每行 `perRow` 个,换行);
   **连线**只按 `edges` / `loops` 画:`dagGraph` 先建 `id → {x,y}` 映射,每条 edge 从 `from` 框右缘画到 `to` 框左缘(同一行)或从底缘到顶缘(跨行),
   loop 从 `from` 底缘绕到 `to` 底缘;端点在映射里找不到 ⇒ 该线不画并在卡上印「有 1 条连线端点读不到」。
   ⛔ 不再像原型那样「相邻数组元素之间连线」—— manifest 校验不要求节点数组是拓扑序,那样会给合法 manifest 画出错的执行路径。
2. `management-dag-source.ts` `projectDag()`:`nodes`(可写的调度节点)**保持原过滤**;另从同一份 `manifest` 生成 `graph`:
   全部节点按 manifest 顺序,`name = workflowNodeDisplayLabel(templateId, node)`,`execution = type==="gate" ? "gate" : node.execution==="engine" ? "engine" : "agent"`,
   `edges` 逐条映射 `{id,from,to}`,`loops` 逐条映射 `max_iterations ?? null`(端点都是 manifest 的 node id 字符串)。`errorDag()` 给 `graph: null`。
   `MANAGEMENT_SCHEMA_VERSION` 改为 `2 as const`;类型 `ManagementSnapshotV1` 改名为版本中立的 `ManagementSnapshot`(消费者:`management-console-snapshot.ts`、`fleet-console.ts`、`fleet-console-model.ts` 的 `VersionedConsoleSnapshot` 别名);
   测试逐处改 2:`fleet-console.test.ts:120`、`fleet-routes-mount.test.ts:240`、`management-console-contract.test.ts`(两处 fixture)、`management-console-dom.test.ts:55`、`management-console-snapshot.test.ts:118`;
   新增「`schemaVersion:1` 与 `:3` 的快照都被 `assertManagementSnapshot()` 拒绝」与「页面收到 `schemaVersion:1` / `:3` 时显示请刷新且不渲染任何项目」(dom 测试,两个方向都测)。
   **旧读者实测(Lead 2026-09-03 要求 ③)**:实现节点用 `git show main:packages/teamlead/src/bridge/fleet-console-html.ts` 取旧页面,在 happy-dom 里喂 v2 fixture,把它实际做了什么记进 `evidence/README.md`
   (预期不是报错:旧 `renderFlags` 按 `flag.category` 分组,v2 没有这个字段 ⇒ 全部 flag 落到标题为 `undefined` 的一组 —— 看得见的退化,不是静默正确;若实测是别的形状,照实记)。
   结论句只许写实测到的那种,不许写「旧读者会报错」。
3. `management-existing-writers.ts` flag 视图:去 `category`,透传 `polarity/default/valueKind`,`onMeans: view.onMeans ?? null`。
4. 测试:合同测试的 fixture 去 `category` 加四字段;dag-source 测试断言 `graph.nodes` 含 gate 与 land、`nodes` 不含;
   `graph.edges` 与 manifest `edges` 逐条相等;`graph.loops[0].maxIterations === null`(schema 2)与 `=== 3`(schema 1 fixture);
   **节点数组非拓扑序**的 fixture(把 `land` 放在数组第 0 位)⇒ `graph.nodes` 保持 manifest 顺序、`edges` 仍指向正确端点;manifest 解析失败 ⇒ `graph:null` 且 `error` 非空。

5. 负向守卫:`grep -c "category" management-console-contract.ts` 在 `ManagementFlagView` 区段为 0(用测试 `expect(view).not.toHaveProperty("category")`)。

### C3 页面纯函数(进 `MANAGEMENT_CONSOLE_STATE_JS`,可在 node 里 eval 单测)

**文件**:`fleet-console-html.ts`(STATE_JS 段)、`management-console-ui-contract.test.ts`。

```js
var ENG_NODE_TYPES=["design","implement","qa"];
function templateKind(graph){ /* 任一节点 type ∈ ENG_NODE_TYPES ⇒ "engineering";否则(含 graph 为 null,读不到形状)⇒ "product",卡上另印「读不到形状」 */ }
function maxChainLen(dags){ /* 全部 dag 的 graph.nodes.length 最大值,graph null 不计,最小 1 */ }
function nodeMetrics(maxChain,availW){ /* NODE_MIN=76 NODE_MAX=118 GAP_RATIO=.28 GPAD=12;放得下 ⇒ {NW,GAP,perRow:maxChain};放不下 ⇒ NW=NODE_MIN 并按宽度算 perRow(换行) */ }
function flagReading(flag,current){ /* 见 §4.3;返回 {state,text,tone,tail} */ }
```
单测用例:
- `templateKind`:`tpl_code` 形状 ⇒ engineering;`generic+gate+land` ⇒ product;`null` ⇒ product(读不到就当产品,并在页面上标「读不到形状」)。
- `nodeMetrics`:同一 `(maxChain=5,W=900)` 反复调用得同一 `NW`;`W=1200` ⇒ `NW=118`(封顶);
  换行阈值按公式算:`(W-24)/(5+0.28*4) >= 76 ⇔ W >= 489.12`,所以 `W=490` ⇒ `NW=76`(floor)且 `perRow=5`,`W=480` ⇒ `NW=76` 且 `perRow<5`(换行不缩小),`W=500` ⇒ `NW=77` 单行;两侧各取一档做边界用例;
  **跨 tab 不变量**:两个 tab 各自的卡集合(产品最长 3、工程最长 5)传入的是 `maxChainLen(全部 dags)=5`,断言两侧 `NW` 相等 —— 这条测试专门把「只看当前 tab」这种实现写成红。
- `flagReading`:7 句逐句等于 §4.3 表;`onMeans=null` 且 bool ⇒ `tone="unknown"` 且文案是「这条 flag 没有登记「打开代表什么」(registry 缺项),这里不猜。」;
  `current===null` ⇒ state「未知」、文案「这个 flag 当前读不到值。」、tone unknown,且**优先于** `onMeans=null` 分支(两者同时成立时报「读不到值」);draft 值变化时句子跟着变(传入的是 `effective()`)。

### C4 页面 DAG tab:花名册 + 产品/工程切换 + 统一框尺寸 SVG + 保留模型行

**文件**:`fleet-console-html.ts`(CSS + APP 段)、`management-console-dom.test.ts`、`fleet-console-html.test.ts`。

1. CSS:从原型 `c79090583` 的 100–205 行搬 `.dag-chip*` `.dag-graphwrap` `.lay` `.lay-v2` `.side-box` `.side-h` `.ic-col` `.ic*` `.seg*` `.stack` `.squad*` `.lay-note`;
   **不搬** `.lay-v1` `.ic-strip` `.prow` `.pn` `.pc`,也**不搬** `.squad:after` / `.squad.fits:after`(原型那层右缘白色渐变遮罩靠一个从未被设置的 `fits` 状态关闭,会把最后一个节点盖住而几何断言全绿);
   `.lay .dag-scroll{overflow-x:hidden}` 保留(定义文档 1.4:是断言不是遮丑,配 C6 的不裁切证据)。
2. `renderDagPanel(project)` 改为:`layNote()` + `<div class="lay lay-v2"><aside>rosterBox</aside><div>columns</div></div>`。
   - `rosterBox`:`project.roles` 逐项 `icCard`;`roleHref` 只接受 `https://github.com/` 前缀的 `role.sourceLink`,否则渲染 `<div class="ic" data-role=… title="后端没有给这个角色可验证的仓库链接">` 并把 `role.error`(若有)印在项内;**页面 JS 里不出现 `github.com/` 字符串拼接、不出现角色→URL 表**。
   - `columns`:`kindTab` 状态(默认 `product`);`splitByKind` 用 `templateKind(dag.graph)`;每侧计数印在段按钮上;空侧印「这一类下没有模板」。
   - `squadCard(dag,k,M)`:头 + `dag-scroll > dagGraph(cardKey, dag.graph, M)`(`cardKey` = 清洗后的 `dag.id` + 渲染序号) + **每个 `dag.nodes[]` 一行 `dag-row` + `modelControl(node.dispatch,"workflow",…)`**(生产现有行为,原型 V2 漏掉的);`graph:null` 时退回现有 `dag-flow` 文字块 + 「读不到这个模板的完整形状」。
   - `dagGraph(cardKey, graph, M)`:搬原型 597–660 行的布局与画法,但连线改按 §C2 的画图模型(`id → 坐标` 映射 + `edges` / `loops`);节点框 `left/top/width/height` 全由 `M` 给;
     SVG `marker id` = `dm-` + `dag.id` 经 `[^A-Za-z0-9_-]` → `_` 清洗 + `-<渲染序号>`(同一模板可被同一项目下多个 task_category 绑定,`templateId` 不唯一);取色按 `node.type`(原型第 2 条),gate/land 用固定浅色。
   - `layNote()`:文案由 `ENG_NODE_TYPES.join(" / ")` 拼出 ⇒ 规则与代码同源。
3. 重排钩子:`renderDetail()` 末尾量 `.dag-scroll.clientWidth`,与 `_availW` 不同则重排**一次**(`_relayouting` 防自激);`window.resize` 去抖 80ms 后 `_availW=0; renderDetail()`。
   `detail` 的 click 委托新增 `[data-kind]` 切换。
4. 删除 `renderRoles()` 与 `.role-card` 相关 CSS(被花名册替代;链接校验逻辑在 `roleHref` 里只有一份)。
5. dom 测试(happy-dom):
   - 花名册:fixture 两个角色,一个 `sourceLink="https://github.com/o/r/blob/main/.flywheel/agents/x.md"` ⇒ `a.ic-link[href]` 逐字相等且 `rel="noopener noreferrer"`;一个 `sourceLink=null,error="…"` ⇒ 无 `href`、`title` 含「没有给」、项内印 error。
   - 分类:fixture 产品 2 + 工程 2(含 5 节点 `tpl_code` 形状)⇒ 默认产品侧 2 张卡,点 `[data-kind="engineering"]` 后 2 张;段按钮计数 2 / 2。
   - 模板卡仍含 `select[data-model-part]`(每个可写节点 3 个)—— **写路径回归守卫**。
   - `graph:null` 的 dag 退回文字块并印「读不到」。
   - 同一模板被绑两次的 fixture(两个 `dag.id` 同 `templateId`)⇒ 两张卡、两个不同的 `marker id`。
   - 节点数组非拓扑序的 fixture ⇒ 连线数 = `edges.length + loops.length`,且每条线的端点属性(`data-from` / `data-to`)与 fixture 一致。
   - **投影 → DOM 端到端**(不只手写 DOM fixture):经**已导出的** `readManagementDags({reader, projectNames})`(不为测试导出私有的 `projectDag`)配一个内存 reader,对一份真 manifest fixture(`tpl_code` 形状:4 条 edge + 2 条 loop)产出 `ManagementDagView`,直接喂给页面 ⇒
     每条 edge / loop 端点都在 `id → 坐标` 映射里命中,卡上**没有**「端点读不到」提示,连线元素数 = 6 —— 这一条测的是【源 → DOM 的集成】。
     **同一测试里再做两次变异,但变的是投影之后的只读 `graph` DTO,不是 manifest**(manifest 里删边或指向不存在的节点会被 `validateWorkflowManifest()` 拒掉,`projectDag()` 会退成 `graph:null`,那就测不到渲染器了):
     克隆上面那份 `ManagementDagView`,删掉 `graph.edges` 中一条 ⇒ 连线数 = 5;另克隆一份把一条 edge 的 `to` 改成不存在的 id ⇒ 连线数 = 5 且出现「有 1 条连线端点读不到」—— 这两条测的是【渲染器的合同与兜底】,断言随 DTO 变,证明它量的不是常数。
     另在 dag-source 测试里保留一条:非法 manifest(边指向未知节点)⇒ `graph:null` 且 `error` 非空 —— 这才是投影层对坏数据的真实行为。
6. html 静态测试(`fleet-console-html.test.ts`)新增负向守卫:HTML 不含 `/api/console-next`、`FLY2071_LAYOUT`、`_disabled`、`跑过`、`governance`、`"https://github.com/"+`、`renderRoles(`、`role-link`(旧角色卡路径已删);含 `data-kind="engineering"`、`ENG_NODE_TYPES`、`lay-note`;
   dom 测试再加一条:角色只出现在 `.side-box` 花名册容器里(`document.querySelectorAll("[data-role]")` 的每个元素都有 `.side-box` 祖先)。

### C5 页面 Flags:一个列表、每行一句人话

**文件**:`fleet-console-html.ts`、`management-console-dom.test.ts`。

1. `renderFlags()`:不再按 `category` 分组;按 `name` 排序一个 `section.flag-group`;表头四列「开关名 / 它现在是什么状态 / 全局值 · 能不能在这里改 / 项目覆盖」;
   行内 `flagReading(flag, effective(flag.global))` ⇒ `.flag-read[data-tone]` + `.flag-tail`(维持默认 / 已偏离默认)+ `.help`(registry description 原文);
   「改不了」原因走原型的 `lockKind` 图例(含「没认出这条原因」/「系统没有给原因」两种兜底);覆盖折叠 `[data-ov-flag]`。
2. **CSS 迁移(本 chunk 自己的,不靠 C4)**:删掉现有三列 `.flag-columns,.flag-row{grid-template-columns:minmax(240px,.82fr) minmax(0,1.55fr) 74px}` 与 `.flag-columns*`;
   从原型 191–205 行搬四列 `.flag-head,.flag-row{grid-template-columns:224px minmax(0,1fr) 232px 116px}` 及 `.flag-sum` `.flag-legend` `.fl-*` `.flag-read` `.flag-tail` `.flag-rw` `.lock-chip` `.why-tip` `.wt-*` `.ov-pill` `.ov-body` `.ov-hint` `.ov-none` `.flag-ovs`;
   原型的 `.flag-read.changed` / `.flag-read.unknown` 两条**改成属性选择器** `.flag-read[data-tone="changed"]` / `.flag-read[data-tone="unknown"]`,DOM 只发 `data-tone`(与 §2 的稳定标识一致,不再有 class 与属性两套);
   静态测试断言 HTML 同时含选择器 `.flag-read[data-tone="changed"]` 与发射串 `data-tone="'+rd.tone+'"`;dom 测试用 `element.matches('.flag-read[data-tone="changed"]')` 证明规则真能命中。
   `@media(max-width:780px)` 里把 `.flag-columns{display:none}` 改为 `.flag-head{display:none}`,`.flag-row{grid-template-columns:1fr}` 保留。
   静态测试断言 `.flag-head,.flag-row` 共用同一条 grid 声明、旧的 `.flag-columns` 不再出现;C6 截图要看 Flags 页表头与行对齐。
3. **不加任何新控件**:开关仍是既有 `renderFlagValue()`(可写才可点);语义句只是读。
4. dom 测试:fixture 覆盖 §4.3 全部情形各 1 条(`disables` 开/关、`enables+default_on` 开/关、`enables+opt_in` 开/关、非 bool、`onMeans=null`、`current=null`)⇒ 每行 `.flag-read` 文案逐字等表;
   页面没有 `.flag-group-title` 印 `feature` / `kill_switch`;`onMeans=null` 与 `current=null` 行 `data-tone="unknown"`;
   toggle 一个可写 flag 后同一行的 `.flag-read` 文案切换(草稿驱动);**写路径回归**:现有「toggle 后 drafts 里出现该 targetId、stage 请求体含它」的用例保持通过。

### C6 证据 harness + QA 尺子

**文件**:`engineering/doc/FLY-2257-console-ux-implement/evidence/{harness.mjs,capture.mjs,README.md}`、`evidence/flag-values-baseline-2026-09-03.json`(已放,改前基线,sha256 `f6c2cfd6…96ba`)。

1. `harness.mjs`:照 FLY-2054 形状,loopback 端口 `18857`,`/` 发 `getFleetConsoleHtml()`,`/api/fleet/snapshot` 内存 fixture:
   产品 3 卡(3 节点)+ 工程 2 卡(5 / 4 节点)+ **1 张 9 节点阳性卡**(最坏偏差:必须换行)、角色 3 个(1 个 `sourceLink=null`)、
   flag 21 条(2 `disables`、16 `enables`、3 非 bool,polarity/default 与 registry 相同)。
2. `capture.mjs`(CDP):对每档 `[1024,1280,1440]`:**新开 target 直接落到该宽度**(冷路径),注入 `resize` 计数器,
   依次点 `[data-kind="product"]` / `[data-kind="engineering"]`,再点 `[data-nav="flags"]` 并断言 `#flagsPage` 有 `active` 且 `.flag-head` 的 `getBoundingClientRect().width > 0`(display:none 下所有几何都是 0,会假绿),采:`resizeCount`、全部 `.dag-chip` 宽高集合、每个 `.dag-scroll` 的 `scrollWidth/clientWidth`、
   每个 `.dag-chip.right` 与所属 `.squad.right`、9 节点卡的行数、`a.ic-link[href]` 列表、每行 `.flag-read` 文案;写 `metrics.json` + 每档三张 PNG(产品 / 工程 / Flags),共 9 张。
   **自证(Lead 2026-09-03 要求)**:`capture.mjs --self-check` 模式在**不点** `[data-nav="flags"]` 的隐藏态直接跑同一组 Flags 几何断言,**必须**以非零退出并打印「hidden-page assertions correctly failed」;README 里两种模式的输出都要贴。隐藏态断言不红 = 断言没修好,capture 整体判失败。
   **硬断言(任一不满足 capture 非零退出)**:`resizeCount===0`;两个 tab 合并后 chip 宽高集合大小 `===1`;所有 `scrollWidth<=clientWidth`;chip right ≤ squad right(容差 1);
   9 节点卡 `rows>1` 且其 chip 尺寸与其它卡相同;`href` 与 fixture 逐字相等;null 项无 `href`;
   静态断言页面 CSS 不含 `.squad:after`(`pointer-events:none` 的遮罩用 `elementFromPoint` 抓不到,不用它);「看得见」的证据是 A11 的截图人眼核对;Flags 页(已激活)`.flag-head` 与首行各列 `left` 相等(容差 1)且各列宽 > 0。
3. 生产值不变量(QA 节点在**同一个 Bridge**上跑,改前一次、改后一次):
   ```bash
   curl -s --max-time 60 http://127.0.0.1:9876/api/fleet/snapshot | node -e '
   let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
   const out=j.flags.map(f=>({name:f.name,global:f.global.current,overrides:f.projectOverrides.map(o=>[o.projectName,o.value.current])})).sort((a,b)=>a.name<b.name?-1:1);
   console.log(JSON.stringify(out,null,1));});' > flag-values-after.json
   diff evidence/flag-values-baseline-2026-09-03.json flag-values-after.json && echo SAME
   ```
   设计节点已在改前跑过一次:21 条,输出即基线文件。⚠️ 基线是 2026-09-03 的活值;若期间有人真改了某个 flag,diff 会红 —— 那是**信号不是噪音**,QA 要去查是谁改的,不能把基线重录了了事。
4. README 记录:命令、Chrome 路径 env、每条硬断言对应定义文档哪一条(§5.1 / §5.2 / §5.3 / §1.4)与 process-log 哪一节(13 / 14 / 15 / 18)。

## 4. 关键设计细节

### 4.1 为什么数据并进 snapshot 而不是加路由
管理台合同是「一个读边界 + 一个写边界」,`fleet-console-html.test.ts` 已断言页面只用 `/api/fleet/snapshot` 与 `changes/*`。
加旁路口 = 第二个读边界 + 第二份缓存一致性问题。`graph` 与 flag 语义都是 snapshot 已有 provider 手里的数据,只是没投影出来。

### 4.2 `graph` 与 `nodes` 并存的理由
`nodes[]` 是**可写**目标(带 `ManagedValue`、进 `targetIndex`、参与 stage/apply);`graph.nodes[]` 是**只读**画图数据(含 gate / land)。
合并成一个会让 gate / land 带一个假的 `dispatch`,或让写路径去过滤画图节点 —— 两边都更差。
`nodes[].id` 保持既有的 `<templateId>/<nodeId>`;`graph.*` 里一律是裸 manifest id(见 C2 的命名空间规则);页面按 `dag.templateId + "/" + graph.nodes[].id` 把可写行对到图节点。

### 4.3 flag 语义句(唯一一份文案,进 STATE_JS)

| onMeans | polarity | current | state | text | tone |
|---|---|---|---|---|---|
| disables | 任意 | true | 开 | 这是一个【停用开关】,现在已经打开 —— 它管的那件事已经被停掉了。 | changed |
| disables | 任意 | false | 关 | 这是一个【停用开关】,现在没有打开 —— 它管的那件事照常在跑。 | normal |
| enables | default_on | true | 开 | 这个功能正常运行中(默认就是开着的)。 | normal |
| enables | default_on | false | 关 | 这个功能已经被关掉了 —— 默认是开着的,现在被关了。 | changed |
| enables | opt_in | true | 开 | 这个功能已经启用 —— 默认是关着的,现在打开了。 | changed |
| enables | opt_in | false | 关 | 这个功能没有启用(默认就是关着的)。 | normal |
| —(非 bool) | — | X | X | 当前取值 X(默认 Y)。这不是开关,是一个数值/枚举。 | X===Y ? normal : changed |
| null(bool) | — | — | 读不到 | 这条 flag 没有登记「打开代表什么」(registry 缺项),这里不猜。 | unknown |

尾标:`current === default` ⇒ 「维持默认」,否则「已偏离默认(默认 开/关/X)」。
`current === null`(未设置 / 读不到)⇒ state「未知」、text「这个 flag 当前读不到值。」、tone unknown。

### 4.4 迁移与回滚边界
- 无数据迁移:registry 字段是纯新增;snapshot 合同升到 v2(加必填字段、删 `category`)。生产者侧 `assertManagementSnapshot()` 对错版本 fail-loud;页面与 Bridge 同一 PR 同一二进制;
  唯一的跨版本读者是「部署前就开着的旧浏览器 tab」:它跑的旧 JS 没有版本核对,行为以 C2.4 的实测为准(预期是 Flags 分组标题变成 `undefined` 这种看得见的退化);新页面遇到旧 / 回滚后端则会提示刷新。`category` 只有页面与测试 fixture 读。
- 回滚 = revert 这一个 PR;`.env` / SQLite flag store / `teamlead.db` 一个字节不动。
- `snapshotRevision` 会因 registry digest 变化而变 —— 这是元数据,C6.3 的验法只比值。

### 4.5 安全
- 所有后端字符串仍走 `esc()`;`href` 只接受 `https://github.com/` 前缀的 `sourceLink`,其余不进属性;`target="_blank" rel="noopener noreferrer"`。
- 没有新写路由、没有新 POST;flag 语义与 DAG 形状都是只读投影。
- 页面仍是单 `<script>`、零外部依赖(`fleet-console-html.test.ts` 禁词表不变)。

## 5. 顺序与提交

C1 → C2 → C3 → C4 → C5 → C6,每个 chunk 一个 commit(`feat(FLY-2257): …` / `test(FLY-2257): …`),C1 与 C2 各自能独立过 `pnpm -r build && pnpm --filter flywheel-config test && pnpm --filter flywheel-teamlead test -- management fleet-console feature-flag`。
本 worktree 没有 `node_modules`,实现先 `pnpm install --frozen-lockfile`。

## 6. 验收(实现节点交付时逐条给证据)

| # | 断言 | 证据 |
|---|---|---|
| A1 | 21 个 flag 值零变化 | C6.3 diff 输出 `SAME`(QA 在生产 Bridge 上跑;实现节点在本地 built Bridge 上跑一次) |
| A2 | polarity / default / 解析路径零变化 | C1.6 的 registry 元组 diff 为空;既有值解析断言零改动且全绿;`resolveFlag()` 可执行部分只多两条投影赋值 |
| A3 | 框尺寸全局一致(跨卡 + 跨 tab) | C3 单测 + C6 `metrics.json` chip 尺寸集合大小 1 |
| A4 | 冷路径不裁切 | C6 `resizeCount=0` 且 `scrollWidth<=clientWidth`,三档宽度 |
| A5 | 最坏偏差可见且不缩 | C6 9 节点卡 `rows>1`、NW 同其它卡 |
| A6 | 链接只来自 `sourceLink` | C4 dom 测试 + html 负向守卫 + C6 href 逐字比对 |
| A7 | 不按名字猜语义 | html 不含 `_disabled`;C1 守卫三件套(含变异体阳性对照)红绿都跑给看 |
| A8 | `governance_gate` 机制已删、规矩已补 | `grep -rn governance_gate packages/ --include='*.ts'` 为 0;runbook 含原句 |
| A9 | 写路径不回退 | C4 dom 测试:模板卡内 `select[data-model-part]` 数 = 可写节点 × 3;stage/apply 相关既有测试全绿 |
| A10 | 一个读边界 | `fleet-console-html.test.ts`「只用 aggregate read 端点」绿;html 不含 `/api/console-next` |
| A11 | 视觉产物真看过 | C6 九张 PNG(3 档宽度 × 产品 / 工程 / Flags)由实现 / QA 用 Read 看过并在 PR 里附缩略(不是只报字节);遮罩类问题只能靠这一条抓,几何断言抓不到 |

## 7. 风险

| 风险 | 处理 |
|---|---|
| CSS 搬运漏项导致 chip 叠字 / 溢出 | C6 硬断言 chip right ≤ squad right;A11 真看图 |
| `happy-dom` 量不到宽度 ⇒ `_availW=0` 走 `NODE_MAX` 单行 | dom 测试只验结构;尺寸走 C3 纯函数 + C6 真浏览器,两者分工写进 README |
| `graph` 让 snapshot 变大 | 6 项目 × 6 模板 × ≤5 节点,可忽略;不做 |
| `onMeans` 忘填新 flag | C1 守卫在 CI 变红;页面兜底句明说「registry 缺项」,不猜 |
| 基线文件与 QA 时的活值不同 | 见 C6.3 ⚠️:先查谁改的,再决定 |

## 8. 决定不做(不是遗漏)与承接

| 项 | 决定 | 承接 |
|---|---|---|
| registry `category`(feature / kill_switch)整体删除 | 本单不做(Lead 2026-09-03 裁定);界面与 snapshot 已不读它 | Lead 另开单,挂 FLY-2071 后续;范围 = registry 21 条去字段 + `feature-flag-render.ts` 措辞收敛 + 手机版 report 页 |
| FLY-2071 plan.md 第 6 条(项目栏重复分组大写标题) | 本单不做(不在四个改动区) | 同上,另开单或并入下一批管理台 polish |
| FLY-2071 plan.md 第 4 条「模板绑定」小标(`bindTag`) | 本单不做(不在四个改动区) | 同上 |
| S1–S5 结构性问题 | 不做 | Honey Lemon 带回 founder 单独定 |
| 「通用」模板落在产品栏 | 照定义文档规则(否则 ⇒ 产品),不改 | 若 founder 看后不认可,改的是分类规则 = 产品问题,回 HL |
| 窄屏 reflow(<1024) | 非目标 | — |
| 原型分支 `flywheel-FLY-2071` 的合并去留 | 与本单无关;本单分支基于 `main` | HL / Lead |
