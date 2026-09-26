# FLY-2913 逐角色精简固定前缀 — 探索
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913/token8-给-claude-runner-评审-qa-各配精简固定前缀逐角色只加载真正用到的工具插件mcp-与规则)
日期: 2026-09-26
基于: 无

> 当前有效范围（2026-09-26 founder 返工）：只把前缀选择从全局 FlagStore 移到 DAG 模板版本。下文原设计与旧裁定保留作历史；以 plan.md §九及 design-correction.md 为当前实施合同。role-v1 内容与已验能力不重做；旧 APPROVED 不覆盖本次修订。

## 目标与阶段边界

降低 Claude implement、design、QA 和跨家族评审每次请求重复携带的固定说明，同时保持各角色完成实际任务所需能力。Lead 的配置完全排除。本文是 design 阶段产物；实现、改后 token 实测及 529 代表任务由后续节点按本计划交付，不能把设计评审通过称作这些验收已通过。

## 需求与事实边界

任务引用 FLY-2904：Claude 8.7–9.1 万、Codex 2.4–3.1 万 token，以及 33.7 亿最小上下文超额；这些是问题输入，尚须查原始测量的口径与角色覆盖。固定前缀不能用完整会话输入 token 或历史最小输入无条件代替。过去七天未调用不代表能力不需要：角色合同、失败恢复、浏览器及文档查询有低频必要路径。

## 当前代码已确认

- `packages/config/src/runner-mcp-profile.ts` 已有 runner slim 配置及 `full-mcp`、`no-chrome`、QA Playwright 正向启用例外。
- 历史 FLY-812 曾因对所有非 QA 关闭 Chrome 导致研究、夜间业务和视频任务回归。FLY-2913 必须逐能力证明能删除，不能照搬“非 QA 无浏览器”。
- `packages/claude-runner/src/TmuxAdapter.ts` 将插件开关并入一个 `--settings`，同时写入非 Lead Discord 禁用、角色 memory 和生命周期 hooks；新配置不能覆盖这些约束。
- `packages/teamlead/src/bridge/claude-review-runner.ts` 是独立 Claude 评审启动路径；只修改普通 runner 不覆盖评审。

## 方案比较与选择

| 方案 | 取舍 | 结论 |
|---|---|---|
| 全机删插件与规则 | 省 token 但污染 Lead，也破坏低频任务 | 拒绝 |
| 仅调 allowedTools | 可能只改变免审批权限，不减少模型看到的说明 | 拒绝作为节省依据 |
| 每角色固定、可审计配置，任务所需能力在启动前并入 | 重用现有启动入口，逐角色盘点与真实任务验收，开关回旧配置 | 选择 |
| 每轮动态增删工具 | 缓存与续跑难以比较，权限和恢复复杂 | 本单不做 |

## 待完成研究

追踪新建/重试/恢复路径与技能、规则真实发现机制；取得 FLY-2904 原始证据及过去七天调用聚合；定义等口径测量、保留清单、回退和 529 验收。无原始测量的格子标未测，不补估算值。


## 2026-09-26 返工探索：选择跟着节点版本走

founder 07:56 PDT 提出应给 DAG 节点文件做版本控制，系统指向新版，回归时指回旧版；07:57 对 Lead 方案答「改」。本轮 design TURN epoch=13，基线 PR #1361 / 2022d92d07e618beb142b20416ebde7ad862abd8。

选择现有 workflow_template_revision 为唯一版本载体。每个 run 起跑时保存模板、节点和说明的快照，此后重试/后续节点/评审沿同一快照取值。全局 FlagStore、env、每次启动查当前模板均拒绝：它们会使同一 run 跨版本。不给共享节点 Markdown 加一个会被全机即时读取的开关。

保持非插件技能 name-only、claudeMdExcludes、0600 settings、低层限制合并、角色能力清单和跨家族路由。Lead/Codex 执行配置保持原样。新工作限于节点字段、发布/回退、消费来源、可查询凭据及针对性验收。

发现需明确的两个接口：现有 rollback 是复制旧内容为新 revision，需修正为受管指针回退；Claude 评审可能服务 Codex 作者，需独立的评审前缀声明，不能只给 Claude 作者打标。已以问题 ba1e9928-1291-4124-bf9e-2c6d2b9813fd 告知 Lead，非阻断。
