# FLY-2054 管理台视觉回归 — 探索
Issue: FLY-2054 (https://linear.app/geoforge3d/issue/FLY-2054/dashboard视觉-管理台视觉回归原型逐屏-side-by-side-对齐-fly-1038-prototype-观感founder-8)
日期: 2026-08-25
基于: 无

## 1. 目标与边界

Founder 已明确授权把生产管理台的观感拉回 `product/doc/FLY-1038-unified-management-dashboard/prototype/dashboard.html`。本单只改视觉与浏览器渲染层，同时吸收 FLY-2052 的 DAG 错误呈现修复；不改 management snapshot 的 SSOT 聚合、统一 stage/apply 写回、级联选择语义或提交行为。

验收不是“CSS 更好看”，而是原型与生产逐屏 side-by-side：实例页每个 tab、Feature Flags 页、侧栏、长选项和异常状态都必须核对。

## 2. 当前实现审计

### 2.1 生产渲染面

- `packages/teamlead/src/bridge/fleet-console-html.ts` 是单文件 HTML/CSS/JS 渲染器，所有数据来自 `/api/fleet/snapshot`，所有写入仍走 `/api/fleet/changes/stage` → `/api/fleet/changes/apply`。
- 现有 UI 测试覆盖页面互斥、级联交互、cron、统一确认 modal，但没有覆盖 prototype 视觉 token、长选项最小宽度、页头噪音或 derived group 的呈现语义。
- `scripts/qa-fly-1262-management-dashboard.mjs` 与 management contract/provider/writer 测试是 PRD §6 四条硬约束的回归证据，必须保持绿。

### 2.2 六条差距的机制

| 差距 | 当前机制 | 目标形态 |
|---|---|---|
| 侧栏气质 | `.side` 使用 `#15233d` 深色实心栏，210px，无窗口 chrome | 原型的浅色 mac-window：灰白底、细分隔线、交通灯 chrome、克制紫色定位态 |
| 下拉截字 | `.three` 为 `1fr 1.4fr 1fr`，卡片最小 280px，三列共同挤压 | provider/model/effort 使用明确 min-width，`Anthropic`、`Opus 5 (1M)` 完整可见；窄卡片可换行而非截半 |
| 页头噪音 | `renderDetail()` 显示 `真源 revision file:<64-char sha>` | 项目名 + Lead/DAG/Cron 统计；revision 仍留在 DTO/CAS，不在视觉主层显示 |
| Infra 重复 | topology 让 infra Lead 的 `presentationGroup=infra`，同一 flywheel projectId 同时进入 `flywheel` 与 `infra` 两组；renderer 两边都画 project button | derived Infra 作为按 `leadIds` 形成的虚拟 Lead 视图，只显示一次 `Infra` 项，不复制 `flywheel` 项目 |
| 密度与层次 | 大卡片 + 低信息密度、默认蓝色、过宽主侧栏 | 原型的 158/210px 双栏、12–15px 紧凑节奏、分组行/模板卡/flag group 层次和 indigo 单一焦点色 |
| FLY-2052 红字 | `management-dag-source.ts` 只过滤 `gate`；任一无 `vendor/model` 的非 gate 节点让整张 DAG 变成 error | `engine` 执行节点与 `gate` 一样不是模型绑定面，不渲染模型控件；真正需要模型的 role 节点缺绑定仍整张 DAG 报错 |

## 3. 明确假设

1. `PresentationGroupView.derived === true` 且存在 `leadIds` 表示展示层虚拟 Lead 组；生产 SSOT 不需要新增实体或改 contract。
2. Infra 组点击后只展示该组 `leadIds` 对应的 Lead 模型；不显示 flywheel 的 Runner default、DAG、Cron，因为这些属于 project，而非 department group。
3. Workflow manifest 的 `role` 节点是模型执行面；`gate` 与 `engine` 是引擎控制/执行节点，不要求模型。若未来新增其他 node type，默认继续 fail-loud，而不是泛化成“无模型都忽略”。
4. revision 只从页头移除，不从 snapshot、target source revision、stale-source 检查或确认 modal 中删除。
5. 交互 DOM 属性、endpoint、draft map 和事件处理保持不变；为视觉结构新增 wrapper/class 可以接受，但不得改变写入语义。

## 4. 方案选择

### 方案 A：只换颜色与宽度

风险是 Infra 仍重复、DAG 仍误报，卡片/flags 密度仍偏离；无法核销六条。

### 方案 B：照抄原型整页 HTML

原型含手工 `PROJECTS`/`VENDORS`/`FLAG_GROUPS` 数据，会破坏 PRD §6；不可采用。

### 方案 C：保留生产数据/交互，以原型设计 token 与布局重做 renderer

采用该方案。CSS 与无状态 render helper 对齐原型；derived group 在 client projection 中变为虚拟视图；DAG source 只做 FLY-2052 的精确 node-type 过滤。这样视觉形态回归，同时 SSOT 与写回边界不动。

## 5. 验证形状

- RED：HTML/DOM contract 先断言 light window chrome、长 select min-width、无 revision subtitle、Infra 虚拟组不重复。
- RED：DAG source fixture 同时放入 `engine` 无模型节点与 `role` 无模型节点，分别证明阴性不误报、阳性仍 fail-loud。
- GREEN：最小 renderer/CSS 与精确 node filter。
- 自动回归：targeted vitest、FLY-1262 §6 acceptance script、全仓 lint/build/package tests（按主机负载纪律分批）。
- 视觉回归：同 viewport、同页面状态截取 prototype 与生产 fixture；逐屏 side-by-side 核销实例/模型、DAG、Cron、Feature Flags、长选项、Infra 与真正错误态。

