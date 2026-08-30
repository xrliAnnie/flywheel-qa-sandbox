# FLY-127 部门范围启动守卫 — 探索
Issue: FLY-127 (https://linear.app/geoforge3d/issue/FLY-127/lead-spawns-runner-for-tasks-not-assigned-to-its-department)
日期: 2026-08-30
基于: 无

## 问题复述

2026-05-05 的事故里，Annie 把 GEO-366、GEO-101 指给 Oliver（ops），把 GEO-371 指给 Peter（product），但 Peter 也为两个 ops issue 启动了 Runner。正确不变量是：Lead 发起的新 Runner 必须同时携带自己的身份，并且该身份必须与 Linear issue 的唯一 department label 对应；不属于本部门的 Lead 不得进入 dispatcher。

## 当前仓库事实

本 worktree 基于较新的 `origin/main`，已经包含 FLY-127 的原始三层修复：

1. `cos-lead-rules.md` 要求 CoS 按 Lead 拆分启动指令。
2. `department-lead-rules.md` 定义 Action Gate、被动跨部门消息静默和 Bridge 拒绝后的单行诊断。
3. `claude-lead.sh` 把这些规则注入 department Lead。
4. `DepartmentRegistry.isLeadInScope()` 按项目、Lead 和 department label 判定权限。
5. `POST /api/runs/start` 在 `StartDispatcher.start()` 前执行 registry 校验。
6. 现有测试分别覆盖 Peter→Ops 拒绝与 Oliver→Ops 放行。

设计复核发现原实现仍有一个真实绕过：`leadId` 是可选字段。调用方省略它时，Bridge 会先从 issue label 自动解析 canonical Lead，再拿解析出的 Lead 与同一 label 做 scope check。于是任何观察到 Ops issue 的 Lead 都可以省略身份，让 Bridge 把请求当作 Oliver 的请求并启动 Runner。这正是“调用者身份”与“issue 所有者”混为一谈。

## 必须覆盖的内建调用方

- 普通 Claude Lead 的生成身份已经要求 `/api/runs/start` body 携带自己的 `leadId`。
- Gemini `dispatch_runner` 当前把模型参数原样发给 Bridge；模型 schema 没有 `leadId`，因此它必然走省略路径。应由 session binding 在服务端附加 `projectName` 与 `leadId`，不能让模型自报身份。
- `scripts/inject-linear-issue.sh` 是受信 QA 入口，但当前也省略 `leadId`。应从 slot 配置的 `botName`（部署时就是 slot `agentId`）读取并显式发送。
- xiaohongshu scheduler 已显式发送配置中的 `leadId`，无需修改。

## 边界与残余风险

- 本任务保护的是 public `/api/runs/start` 的“Lead 发起一个新 issue run”边界。retry、phase handoff、auto-QA 从已经授权并持久化的 session 继续工作，不是新的任意 issue admission；它们依赖 session owner/role checks，而不是重新调用 `DepartmentRegistry`。
- Bridge 目前使用共享 API token，`leadId` 仍是声明身份而不是每 Lead 独立认证。强认证能防恶意伪装；本任务针对事故中的误路由/省略身份，要求所有内建调用方绑定真实 Lead 身份并在 route fail-closed。独立 per-Lead credential 属于后续安全设计，不在本 issue 内扩张。
- 角色指令明确禁止改 `CLAUDE.md`。验收中的“CLAUDE.md / docs”走 docs 分支：更新运行时 `department-lead-rules.md`，并用 milestone 固化交付摘要。
- 无 UI/rendered surface；不需要 proofshot。验证面是 HTTP、Gemini tool binding、QA shell payload、dispatcher 调用和规则 bundle。

## 设计结论

采用四个最小增量：

1. scope enforcement 开启时，`/api/runs/start` 缺少或空白 `leadId` 直接返回机读 `403 DEPT_SCOPE_REJECT / lead_identity_required`，不得自动解析 owner；flag 关闭时保留 FLY-80 auto-resolve 作为回滚。
2. Gemini `dispatch_runner` 从 `SessionBinding` 附加并覆盖 `projectName`、`leadId`，把身份移出模型输入面。
3. test-slot 注入脚本从 slot `botName` 读取 `leadId`，用 `jq --arg` 构造转义安全的 JSON payload。
4. 规则文档明确每次 start 必须发送自己的 `leadId`，并增加 `lead_identity_required` 的不重试诊断。

所有行为变更逐项执行 RED→GREEN；同一 Ops issue 的 Peter 403 + Oliver 200 + dispatcher 恰好一次作为最终 acceptance regression。
