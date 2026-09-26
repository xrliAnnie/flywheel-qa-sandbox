# FLY-2913 逐角色精简固定前缀 — 实施记录
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-25
基于: plan.md

## 当前边界

T1 工具批次已实现；T1 五角色实际基线尚未完成，T2–T6 尚未实现。本文件不构成 code review、完整 CI、QA、生产或交卷证据。当前已批准设计门为 `5aec411f-dcf1-4ecf-93ba-71fb9d401763`，服务端重读 effective/raw APPROVED；后续 Lead 的任务来源修订见 plan §六。

## T1 工具与验证

- `scripts/qa-2913-prefix-inventory.mjs` 读取明确的已归一化采样 manifest，校验身份、同条件配对、所有组件及残差加总；未知量保留 null，不给三组配对不足或有未配对样本的角色判完整。输出 JSON 与逐项 CSV；五角色均覆盖前整体不完整。只是算术/来源/配对验证，不证明声明的 CLI 控制真的生效。
- `summarizeClaudeContextDiagnostic` 读取当前 CLI 诊断，仅输出清单元数据；deferred schema 潜在成本单列，不加进已使用固定前缀。hook additionalContext、工具名 roster 归属、未提供的 built-in 明细继续标未测。
- `scripts/lib/qa-2913-weekly-tools.mjs` 只读显式 transcript manifest，流式读取、按 `(sessionId, assistantMessageId, tool_use_id)` 去重，窗口为 cutoff 前精确 7×24 小时；角色/vendor/主或子会话/评审类型分列。Skill 只保留规范名字。缺失、不可读、损坏、未知、重复和不支持的记录有独立诊断；正文和参数不输出。
- CLI：`node scripts/qa-2913-prefix-inventory.mjs <manifest> <inventory-before-after.json> <role-capabilities.csv>`；七天统计为 `node scripts/qa-2913-prefix-inventory.mjs weekly <transcript-manifest> <cutoff-ISO> <weekly-tool-use.json>`。
- 新的两份 shell 测试已登记到现有 Script Tests 5/5；对应 CI inventory/order 合同同步增加这一项，不增加 job、不请求 full CI。

已观察红测试：缺少 collector；未知逐项 token 未阻止完整；未配对样本未阻止完整；缺少原生诊断 reader；weekly CLI 未接入；损坏 assistant envelope/content 被当作零调用。按失败逐项最小修复并重跑明确测试。内部局部审查不替代最终跨家族 gate。

验证命令（仅相关项）：

```sh
bash scripts/__tests__/qa-2913-prefix-inventory.test.sh
bash scripts/__tests__/qa-2913-weekly-tools.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/ci-structure.test.sh
pnpm lint
```

原新脚本没有既存 TS consumer，未改 TypeScript，因此此批不适用 `vitest related` 或 dependents typecheck。为 529 预备已完成 `pnpm install --frozen-lockfile` 和 `pnpm --filter 'flywheel-teamlead...' --filter 'flywheel-inbox-mcp...' --filter 'flywheel-terminal-mcp...' build`；没有跑全包/全仓测试。根 lint exit 0，存在 25 条既有 warning；两个新增 JS 的单独 Biome 检查无诊断。逐路径排除记录见 `evidence/t1-consumer-sweep.json`，大多数是共同 `scripts/` 目录名引用，不能据此扩大本机测试。

## 529 诊断发现（不是角色验收）

从本 checkout 用 `test-deploy.sh 1 --generalized --no-lead --expect-head fa98ceb3b4ac1c972a0fdf14ca06a1f60c5698b6` 起真实模型模式房。room-info、`/health` 的 buildSha/artifactBuildSha 都为该 SHA；未启动 workflow execution、QA 或模型代表任务。CLI 2.1.283 的 initialize / get_context_usage / mcp_status 均成功。

去敏实测见 `evidence/t1-context-probe.json`：该探针的已知固定类别和为 54,223 diagnostic-estimate tokens，另有 17,878 deferred schema 估值；不能相加称实际前缀。111 个 included skills、46 个 agents、12 个 memory files、16 个 MCP tool 元数据。Playwright 状态 pending，角色 prompt 未注入、模型未按角色固定、hook/roster 未分离，故 fixedPrefixTokens 仍为 null。不能填入五角色 before 表，更不能作为优化或必需能力成功。

诊断未改共享 settings/Lead 配置、HOME、认证或模型配置。slot Bridge 日志有既有 Codex reconcile 对 `.codex` 的 EPERM；没有拿 boot success 声称全宿主零写证明。

## 未完成事项与外部状态

1. 完成五角色真 consumer 启动、完整 loaded 清单与三组配对采样；先补 hook/工具名 roster/builtin costs 的可归属证据，再决定移除项。
2. 遵照 Lead 从 pinned `tpl_code` / `tpl_simple_code` 派生 engineering，其他来源 legacy；后续节点/retry/reviewer 均需覆盖。
3. 刷新七天背景统计时只读 transcript。origin/main 的 FLY-2904 `census.py` 含 live DB roster，不能直接运行；原 CSV 未入 git，snapshot_owner_unavailable 不阻塞主线。
4. 标准 slot 1 teardown 在 `test-teardown.sh:459` 调 `cmux_process_incarnation` 时受 sandbox 禁止 `ps`，返回 `unable to publish qa_teardown yield claim; no teardown action taken`。已向 Lead 注册 `2aa703eb-8850-4f6d-a0b6-3a4154790774` 请求由受监督、具备进程观测权限的载体执行标准拆房；不伪造 incarnation、不改 claim/lease、不手杀。原房仍绑定旧 SHA，提交后不能继续把该房作为当前头验收。

继续：T1 基线与 collector 接线 → T2 编译器/CLI 控制负控 → T3 runner → T4 reviewer → T5 真实任务及回退 → T6 默认启用、最终 code-review、PR、needs_review 完成路由。
