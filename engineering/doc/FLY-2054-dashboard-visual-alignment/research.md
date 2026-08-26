# FLY-2054 管理台视觉回归 — 调研
Issue: FLY-2054 (https://linear.app/geoforge3d/issue/FLY-2054/dashboard视觉-管理台视觉回归原型逐屏-side-by-side-对齐-fly-1038-prototype-观感founder-8)
日期: 2026-08-25
基于: exploration.md

## 1. 调研结论

无需换框架或改变 API。生产 renderer 已有正确的 source-driven 数据与交互边界，问题集中在三层：

1. CSS/design tokens 与 FLY-1038 prototype 不同；
2. presentationGroups 被当成“可重复画 project 的分区”，而 prototype 的 Infra 是按 Lead 聚合的虚拟组；
3. DAG projection 误把 `execution:"engine"` 的 land 节点当成需要 model binding 的 agent 节点。

最小且完整的实现面是 `fleet-console-html.ts` + 其 UI tests，以及 `management-dag-source.ts` + source test。management contract、snapshot provider、writers、routes 均不需要改。

## 2. 原型 design token 与生产映射

| 视觉层 | FLY-1038 prototype | 当前生产 | 采用值/结构 |
|---|---|---|---|
| 页面背景 | `#eef0f4` | `#f5f5f7` | `#eef0f4` |
| window frame | 白底、1px `#e4e6ec`、14px radius、双层轻 shadow | 无外框，直接占满 viewport | viewport 内 18px margin；frame 占剩余高度，保留满高语义 |
| chrome | `#f6f6f8` + 三个 11px 交通灯 | 无 | 加纯装饰 header，标注 localhost 管理台；不展示 source revision |
| app sidebar | 158px `#f7f8fb` + 右边线 | 210px `#15233d` | 158px 浅侧栏；active 用 `#ecebfb/#5646d6` |
| project rail | 210px | 280px | 210px，紧凑 8–9px item |
| detail padding | 16px 19px | 24px 28px | 16px 19px |
| typography | 12–15px 主体、mono 辅助、1.32rem 项目名 | 15px card/24px h1 | 贴近 prototype；hash/source path 不占主层 |
| cards | 行式 Lead、模板卡、cron row、flag group | 通用大 card/grid | 仍由同一 renderer 生成，但按内容类型收敛密度；保留 semantic status |
| focal color | indigo `#5646d6` | system blue `#1267d6` | indigo；红/橙/绿只用于错误/风险/状态 |

窗口 chrome 是视觉信息，不是系统状态。`sourceHealth` 继续显示真实 source 计数，但放进 chrome 右侧轻量 pill，避免占用深色侧栏底部。

## 3. 长选择器调研

当前 `.three{grid-template-columns:1fr 1.4fr 1fr}` 在约 280px 卡片中只给 provider/model 各约 70/98px。原型固定 150/170/96px，因此 `Anthropic` 与 `Opus 5 (1M)` 在生产被截断。

采用：

```css
.three {
  display:grid;
  grid-template-columns:minmax(132px,.9fr) minmax(170px,1.2fr) minmax(96px,.65fr);
}
```

并让承载模型控件的行/卡片最小宽度覆盖三列总和；在不足宽度时整组换成单列，而不是缩窄 `<select>`。测试不能只搜文案，要读取 CSS contract 并用 DOM fixture 断言每一列的 class/最小宽度。

## 4. Infra 组呈现

`buildTopologyView()` 已正确输出：

- 普通 project view（含全部 Leads、DAG、Cron）；
- derived presentation group（`id=infra`、`leadIds=[flywheel/<infra lead>]`、`projectIds=[project/flywheel]`）。

错误只在 `renderProjectList()`：它对每个 group 的 `projectIds` 画 project button，所以同一个 flywheel 出现在 `flywheel` 与 `Infra` 两节。

Renderer 应建立 `leadsById` 与全部 `derivedLeadIds`，derived group 画一个 `data-group="infra"` 的 `Infra` item，badge 为 group lead 数；普通 group 才画 project buttons。点击 derived group 后：

- 标题 `Infra`；
- subtitle `N 个 Lead · 按 dept 归组`；
- 仅 render group lead model rows；
- 明示“这些仍是原 project 的 Lead；Infra 只是 dept 聚合，不是独立项目”；
- 不显示 project Runner default、DAG、Cron tabs。

ordinary project 的 model rows 与 Lead count 排除 `derivedLeadIds`，所以 infra Leads 不会在 flywheel 与 Infra 两处重复。derived group 的搜索 key 是自身 label，不继承成员 project 名。`其他` fallback 只把 ordinary groups 的 projectIds 视为已归组，保证“全员 infra”的 project 仍可访问其 Runner/DAG/Cron。这些都利用 snapshot 已有事实，不创建第二份 inventory，也不改 SSOT contract。

## 5. FLY-2052 的精确过滤条件

`WorkflowManifestNode` 已有 `execution?: "engine"`。validator 对 gate/land engine node 明确要求无 agent/model 字段；`workflow-run-snapshot.ts` 也在多个位置把 `gate`/`land` 从 agent dispatch 中排除。生产 seed 的 land fixture 是：

```ts
{ id: "land", type: "land", execution: "engine" }
```

gate 节点合法地没有 `execution` 字段，所以 management projection 的正确 predicate 是 `node.type !== "gate" && node.execution !== "engine"`：保留 gate 特例，同时精确排除 land 等 engine-owned 节点。阴性对照必须使用仓库已有合法 `tpl_eng_heavy_land_v1`，证明 land 不生成 model target 且不让 DAG error；阳性对照使用 validator 可接受、但 agent node 缺 `vendor/model` 的 manifest，DAG error 仍包含 `has no model binding`。

## 6. 测试与证据矩阵

| 验收项 | RED/GREEN 自动证据 | 浏览器证据 |
|---|---|---|
| 浅色 mac-window 侧栏 | frame/chrome token + `getComputedStyle(.side/.nav-button.active)`，禁止旧 `--nav:#15233d` | prototype/production 同 viewport overview |
| 长下拉不截字 | CSS contract + fixture 中 `Anthropic`/`Opus 5 (1M)` option；列最小宽度 | 模型 tab 选中长值 screenshot + computed font 的 offscreen textWidth ≤ content box（预留原生箭头），不用 select scrollWidth |
| 页头降噪 | DOM subtitle 不含 `revision`/`file:`，含 Lead/DAG/Cron stats | 每个 project 页头 screenshot |
| Infra 不重复 | DOM fixture 含同 project 的 normal + derived group；断言 flywheel 一次、Infra 一次、点击后只见 infra Leads | sidebar + Infra detail screenshot |
| 卡片/间距/字号 | HTML/CSS prototype token contract；screen matrix 防遗漏 | 模型、DAG、Cron、Feature Flags 各一张与 prototype side-by-side |
| FLY-2052 | DAG unit fixture：land 阴性、缺模型 role 阳性 | DAG tab 无六卡全红；构造真缺模型 fixture 仍红 |
| §6 四约束 | 现有 management provider/writer suites + `scripts/qa-fly-1262-management-dashboard.mjs` | network endpoint/read-only snapshot 抽查；QA phase 负责独立真浏览器重验 |

## 7. 浏览器执行方法

浏览器能力是 execution-context 相关事实：reviewer session 实测有 ProofShot/Playwright，本 runner 的当前 tool surface 没暴露同名 callable connector，但本机有 Google Chrome 151。实现阶段必须重新探测并记录时间与 exact probe：若本 runner 能调用 ProofShot/Claude-in-Chrome/Playwright，就优先使用；否则使用 loopback fixture server + system Chrome CDP 输出固定 viewport screenshots，并读取像素图。不能仅凭 `~/.claude/skills/proofshot` 文件存在或另一 session 的连接状态声称本 session 已覆盖。独立 QA/Founder 终验仍由 DAG 后续节点按任务要求执行，作者不把本地 screenshot 代替 founder verdict。

Bridge/9920 监听状态会变化，不作为方案前提；无论当时 live Bridge 是否在线，作者视觉验证都启动本 worktree 的隔离只读 fixture，不碰 live config/plist/launchctl。

## 8. 风险与控制

- **CSS 大改掩盖交互回归**：保持 DOM data attributes 与 endpoint JS 不变，先跑现有 DOM interactions。
- **derived group lead 查找错误**：按 stable `lead.id` 索引；找不到的 id 不编造，显示可诊断 empty。
- **把 revision 从 UI 移除误伤 CAS**：只删 `renderDetail()` subtitle 文案，不改 DTO 或 draft `observedRevision`。
- **FLY-2052 过度过滤**：共同过滤 `node.type !== "gate" && node.execution !== "engine"`；阳性测试要求 validator 可接受的 agent node 缺模型继续红。
- **全仓测试压主机**：先 targeted，再 build/lint；package suite 按项目既定命令运行并记录主机资源/外部 flake，不用窄检查冒充全量。
