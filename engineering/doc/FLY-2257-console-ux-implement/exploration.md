# FLY-2257 管理台 UX 落地 — 探索

Issue: FLY-2257 (https://linear.app/geoforge3d/issue/FLY-2257/管理台ux-fly-2071-实现-dag模板统一框尺寸花名册sourcelink链接删项目面板flag语义化删governance)
日期: 2026-09-03
基于: 无(上游权威是 FLY-2071 分支上的 `engineering/doc/FLY-2071-management-console-ux-review/product-definition.md`)

## 1. 这单是什么

FLY-2071 由 Honey Lemon 收口成产品定义,founder 2026-09-02 拍板「finalize → 开工给 Tadashi」。
founder 同日明确:**原型只是 mockup,「真的改前端」是之后的单** —— 本单就是那个单。

权威是 `product-definition.md`(以下简称「定义文档」);参考实现是分支 `flywheel-FLY-2071` 上的
`packages/teamlead/src/bridge/console-next-html.ts`(commit `c79090583`),可改可弃。

## 2. 审计:现状与参考实现的差距

### 2.1 生产管理台 `/`(`packages/teamlead/src/bridge/fleet-console-html.ts`,531 行)

| 区域 | 现状 | 定义文档要什么 |
|---|---|---|
| DAG 模板 tab | 上半是「角色卡」网格(每张卡一个「查看 GitHub」链接,用 `role.sourceLink`);下半每个模板一张卡,节点用 `dag-step` 文字块横排,每个节点一行模型下拉 | 产品/工程**切换**、节点框统一尺寸的 SVG 图、不裁切不横滚、删「跑过 N 次」 |
| 花名册 | 没有独立花名册;角色卡里有链接 | 每项可点,链接**只**来自 `sourceLink` |
| 项目面板 | 生产没有(那是原型 V1/V2 里加的第二个控件) | 删除 |
| Feature Flags 页 | 按 `flag.category` 分组(`feature` / `kill_switch` 两组),每行裸开关 | 一个列表、一个概念;每行一句「开 = 什么意思」;删 `governance_gate` |

### 2.2 参考实现(原型)已经做到的

原型是 `fleet-console-html.ts` 的整份复制(1155 行),用 `FLY2071_LAYOUT=v2` 切到 founder 选定的布局。
定义文档的效果**全部**已在原型里:分类从 node.type 推(`sideOf`)、全局统一尺寸(`nodeMetrics` / `maxChainLen` 看全部模板)、
换行不缩小(`NODE_MIN=76`)、花名册用 `sourceLink`(`icCard`)、项目面板已删(commit `421004a8f`)、
「跑过 N 次」已从 `.ts` 里删掉(只剩原型 `server.mjs` 的 `/api/console-next/usage` 路由)、单一 Flag 列表 + `flagReading()` 语义句。

**原型没做、留给本单的**:删 `governance_gate`;「打开代表什么」的真解(原型仍靠 `/_disabled$/` 猜)。

### 2.3 🔴 原型里只读 mock 才掩盖住的三处,落地时必须纠正

1. **原型 V2 的模板卡没有节点模型下拉。** `squadCard()` 只画头 + 图;生产 `/` 的每个 DAG 节点有一行
   `modelControl(node.dispatch,"workflow",…)`,那是管理台唯一的 DAG 写路径(stage → apply)。
   原型把 `post()` 换成拒绝写入,所以没人发现少了。**落地必须保留每节点模型行**,否则是功能回退。
2. **原型多开了两个读接口** `/api/console-next/templates`、`/api/console-next/flagmeta`。
   生产管理台的合同是「一个读边界(versioned snapshot)+ 一个写边界」,且
   `fleet-console-html.test.ts` 有一条「只用 aggregate read 与 unified write 端点」的断言。
   ⇒ 页面需要的新数据(节点 type / gate / land / loop、flag 的 polarity / default / valueKind / 语义)**并进 snapshot**,不加旁路口。
3. **原型的 `/console-next` 路由本身是 mock 脚手架。** 若并行挂上生产,就是「同一份状态的第二个页面」——
   正是 founder 删项目面板的理由。⇒ 不落 `/console-next`,直接改 `/`。

### 2.4 后端已经有的、可以直接用的

- `ManagementRoleView.sourceLink`(`management-topology-source.ts` 的 `githubSourceLink()`):
  由 `projectRepo` + `agent_file` 相对路径生成,含路径安全检查;不安全或仓库格式无效时 `link=null` + `error`。
  实测 live snapshot:6 个项目 25 个角色 **25/25 都有链接**。
- `ManagementDagView.nodes[]` 已用 `workflowNodeDisplayLabel()` 给出后端中文名(`设计(工程)` / `实现` / `QA 验证` …),
  但**过滤掉了** gate 与 engine 节点,且不带 `type`、不带 loop。
- registry(`packages/config/src/feature-flags/registry.ts`)每条 spec 有 `polarity` / `default` / `valueKind` / `category`;
  live 21 个 flag:8 个 `kill_switch`、13 个 `feature`、**0 个 `governance_gate`**。
- 分类规则按真数据核过(`~/.flywheel/teamlead.db` 最新 revision):
  `tpl_code`(design/implement/qa/gate/land,5 节点)与 `tpl_simple_code`(4 节点)归工程;
  `tpl_design` / `tpl_prd` / `tpl_prototype` / `tpl_generic_menu` 的执行节点都是 `generic` ⇒ 归产品。
  ⚠️ 「通用」模板因此落在产品栏 —— 这是定义文档的规则「否则 ⇒ 产品」的直接结果,founder 在 18982 上看到的就是这样;本单照做,不改规则。
- 最长链路 = 5(`tpl_code`);全部模板取最长后所有卡同一尺寸。

### 2.5 `governance_gate` 的全部落点(删机制的清单)

代码:`registry.ts`(`FlagCategory` 联合类型 + 头注释)、`store-policy.ts`(两处:store 资格 + project-store 作者校验)、
`direct-toggle.ts`(`isDirectToggleMetadata`)、`feature-flag-render.ts`(label / definition / legend / class / effectSentence / card class,6 处)、
`management-existing-writers.ts`(`registryPolicyReason`)、`resolve.ts`(`FlagView.category` 类型随之收窄)。
测试:`feature-flags-registry.test.ts`(2 处)、`feature-flags-store-policy.test.ts`(3 处)、
`feature-flags-direct-toggle.test.ts`(1 处)、`feature-flag-render.test.ts`(2 处)。
文档:`doc/engineer/implementation/flag-authoring-runbook.md`(flag 约定文档,补规矩的地方)、
`packages/teamlead/lead-rules-base/default-enable-policy.md`(讲的是「不要自动打开治理门」,规矩仍成立,不动)。

## 3. 设计决定(已用非阻塞 ask 报 Lead,答案到了再改)

| # | 决定 | 为什么 |
|---|---|---|
| D1 | **改生产 `/`**,不挂 `/console-next` | 见 2.3;一份状态一个页面 |
| D2 | 页面新数据**并进 snapshot**:`ManagementDagView.graph`(全部节点含 gate/land、type、loop)、`ManagementFlagView` 增 `polarity/default/valueKind/onMeans`,去掉 `category` | 一个读边界;既有断言;不留没人读的镜像字段 |
| D3 | **registry 加纯展示字段 `onMeans: "enables" \| "disables"`**(bool flag 必填),加守卫测试「名字以 `_disabled` 结尾 ⇒ `disables`」 | 定义文档 4.4:真解 = registry 自带「打开代表什么」;守卫把「今天不错是运气」变成 CI 断言 |
| D4 | `feature` / `kill_switch` 两个 category 值**先留在 registry**,界面与 snapshot 不再读;只删 `governance_gate` | 定义文档「后端类型的收敛由你定」;零 registry 搬迁风险;手机版 flag report 页不在本单 |
| D5 | 分类规则(design/implement/qa ⇒ 工程)留在前端,但 `ENG_NODE_TYPES` **一个常量**同时驱动 `sideOf()` 与页面上印出来的规则文案 | 规则要印在页面上;代码与文案同源才不会漂 |
| D6 | 每个模板卡保留每节点模型行(生产现有 `dag-row` + `modelControl`) | 见 2.3 第 1 条 |

## 4. 硬不变量怎么证(写进 plan 的验收)

1. **21 个 flag 值零变化**:改前改后各读一次 `/api/fleet/snapshot`,把 `flags[].name → global.current + projectOverrides[].value.current`
   投影成 JSON 逐字 diff 为空;registry 层 `polarity` / `default` 不动(`resolve.ts` 与 codec 测试原样全绿)。
2. **框尺寸取样范围 = 全部模板 + 全部 tab**:纯函数 `nodeMetrics(maxChain, width)` 单测「产品 tab 与工程 tab 得到同一个 NW」;
   真浏览器证据量 `.dag-chip` 宽高集合在两个 tab 下都是单元素集合。
3. **冷路径**:直接开在 1024 / 1280 / 1440,全程不改窗口,`resize` 事件计数报 0,每个 `.dag-scroll` `scrollWidth <= clientWidth`。
4. **链接来源**:静态断言页面 JS 不含 `github.com/` 拼接、不含角色→URL 映射;happy-dom 测试:`sourceLink=null` 的角色渲染为不可点 + 说明。
5. **不猜名字**:静态断言页面 JS 不含 `_disabled`。

## 5. 不在本单(HL 明确 + 本轮补充)

- plan.md 的 S1–S5 结构性问题(节点↔手册连不上、面板选择空间比模板大、模板挂在项目下、21 个开关 0 个可改、flag 说明是工程语言)。
- FLY-2071 plan.md 第 6 条(左侧项目栏重复的分组标题)—— 不在四个改动区里;已问 Lead。
- 窄屏 reflow(FLY-1038 §4 非目标);但「打开就被裁」是 bug,属于本单(见 4.3)。
- 头像;`/console-next` 路由;原型的 `prototype/` 目录与 `server.mjs`(留在 FLY-2071 分支)。
- 手机版 Feature Flag report 页(`feature-flag-report-html.ts`)的 feature / kill_switch 措辞收敛。

## 6. 开放问题(非阻塞,已发 Lead,问题 id `b5c55672-817d-4961-a1c4-a107e8fd8e3c`)

1. D1 落地面是否同意(改 `/`,保留模型行)。
2. D3 registry 加 `onMeans` 是否同意。
3. D4 是否要本单顺手把 registry 的 `category` 整体删掉。
4. plan.md 第 6 条是否不带。
