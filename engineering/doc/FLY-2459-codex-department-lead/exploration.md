# FLY-2459 Codex 部门 Lead — 探索
Issue: FLY-2459 (https://linear.app/geoforge3d/issue/FLY-2459/2441-能派-runner-的部门-lead-跑-codex-后端补-codex-lead-动作面的-startmanage-runner)
日期: 2026-09-10
基于: 无

## 目标与授权

Honey Lemon 保留 `flywheel/flywheel-product-lead` 身份、频道、产品部门与 PRD 派单责任，运行后端改为 `codex-app-server`，模型 Astra，effort high。当前节点只产出经过有效设计评审的实施计划与 founder HTML；真实配置切换、起 runner 和重启由后续阶段在原授权边界内执行。

用户已指定完整调研、设计与 review 工作流；不额外请求 brainstorm 或研究批准。`research` / `write-plan` 技能的文档形状按此任务 DOC-FLOW 覆盖，最终使用明确的 request-review 协议；不更改 doc/VERSION 或旧目录生命周期。

## 当前事实

- 起点 HEAD `d964e9fca`，工作树干净；TURN 为 design epoch 1。
- `action-surface.ts` 的五个 gateway 工具不含 start/list/status/send/respond，注释明确推迟到 FLY-251。
- `fleet-capabilities.ts:isCodexEligible` 排除所有 `canSpawnRunners !== false`；准入规则与 ProjectConfig 跨字段校验需一并审计。
- 管理台 `management-topology-source.ts` 把 backendWritable 固定为 false；仅改前端会留下服务器、持久化与生命周期断点。
- FLY-2445 #1134 已于 2026-09-09T17:17:19Z 合入（gh 当前读取）；仓库含标准 Lead 注册、公共 carrier 与迁移实现。合入事实不证明生产已部署。

## 方案比较

| 路径 | 收益 | 风险/处置 |
|---|---|---|
| 显式 runner 能力 + 现有 gateway/Bridge + 受控手动后端切换 | 复用部门闸、持久调度与现有班车；能完整实现本单允许的手动路径 | 必须精确设计注册、模型、状态、旧进程退出、游标和回滚；作为首选待代码审计 |
| 同时实现管理台跨厂商切换事务 | 管理台可直接发起切换 | 涉及 FLY-264 的持久任务、受管重启与跨厂商会话迁移；除非当前代码已有完整接缝，否则本单不扩成通用切换平台 |
| 给所有 Codex Lead 无条件加 start_runner 或仅改模型名 | 改动少 | 违反显式配置负例；无法证明实际 Codex carrier 与部门身份；拒绝 |

## 要回答的设计问题

1. 哪些 profile 实际使用 gateway？full-access 的 Lead 动作面如何与 write-capable 共用 runner 合同？
2. Bridge start、sessions、send/respond 的真实参数、身份、部门过滤、重试/去重和 founder 保留 checkpoint 是什么？
3. 如何将显式 runner 能力作为配置、工具注册、运行时校验和 Bridge 授权共同事实，默认不改变现有 Lead？
4. 管理台必须呈现实际 backend/model 与 desired/current 的差异；手动切换如何在 cfglock 和班车下稳定持久化、恢复与回滚？
5. 如何证明真实 @ → mailbox → start → issue_delivery，且 403 越部门与未授权动作均无副作用？

## 不变边界

R1/R2/R4、founder 独占 ship/lifecycle 决策、FLY-127 部门闸、标准可见 TUI、单 Lead owner、现有 runner 模板均保持原合同。Astra 的 UI 名与规范模型 ID 必须从现有模型目录解析，不建立别名副本。设计完成不代表 Honey Lemon 已迁移。

## R1 后的设计收敛

能力数据只做独立投影，不改变现有全舰队identityDigest；full-access/TUI延续静态配置闸，不等待per-turn MCP启动广播；窗内迁移止于activated并返回，真实派单/重启复验与成功回执闭合在窗口外。专用residency patrol不覆盖generic Honey Lemon，本单不启用它；生存依靠现有KeepAlive和普通班车。
