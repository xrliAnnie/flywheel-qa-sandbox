# Research: Token 归属 & 聚合可行性 — FLY-614

**Issue**: FLY-614
**Date**: 2026-06-28
**Source**: `doc/engineer/exploration/new/FLY-614-token-usage-tracking.md`

本文档记录实现前的可行性 spike 结论（已在真实数据上跑通验证），用于支撑 plan。所有结论都有真实数字背书，非凭印象。

---

## 1. 数据源：CC jsonl 日志

位置：`~/.claude/projects/<path-mangled-cwd>/**/*.jsonl`

每条 `type:"assistant"` 记录关键字段：

| 字段 | 用途 |
|------|------|
| `cwd` | **归属主键** —— 真实工作目录路径（subagent 也带父项目 cwd） |
| `gitBranch` | 辅助归属（如 `flywheel-FLY-614`） |
| `timestamp` | 时间窗过滤（ISO8601 UTC） |
| `message.model` | 模型（claude-opus-4-8 / claude-fable-5 / claude-haiku-4-5 / ...） |
| `message.usage` | `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` |
| `requestId` | **去重键**（多次 iteration 共享一个 requestId；fallback 用 `uuid`） |
| `sessionId` | CC 内部会话 UUID |
| `isSidechain` | true = subagent 侧链 |

## 2. 关键结论

### 2.1 cwd 是可靠归属主键（subagent 也准）
- subagent jsonl 在 `<proj>/<uuid>/subagents/agent-*.jsonl`，其行内 `cwd` = 父项目真实路径（实测 `flywheel-FLY-362` 的 subagent 行 cwd 正确）。
- → 按 cwd 聚合能把 subagent token 正确归到父项目/issue，**不丢账**。

### 2.2 自写扫描比 `ccusage session` 更准
- `ccusage session --json` 按「叶子目录名」分组，把所有 subagent 塌进一个项目盲的 `subagents` 桶、workflow 塌进 `wf_*` 桶（合计约 11% / $4k 无法归属到项目）。
- 自写 cwd 扫描总量 **47,982.7M token** vs ccusage grand total **47,976.8M token** → **误差 < 0.01%**，证明自写 parser 既全又准。

### 2.3 成本折算
- ccusage 用 LiteLLM 公开定价折 USD。本项目模型很少（opus / fable / sonnet / haiku 几种），可内置一张小 `model → 单价` 表自算，并以 ccusage 总额做交叉校验。
- USD 仅为「重量代理」（订阅制非真账单）。

## 3. cwd → 分类规则（prototype，需硬化到 ~100% 覆盖）

```
lead-workspace/<x>-lead          → project=(lead), role=lead, who=<x>
Dev/<proj>-<ISSUE>[-<role>]      → project, issue, role(后缀如 -qa；默认 runner)
Dev/<proj>  (主仓 checkout)       → project, role=main
Dev/<proj>/worktrees/<slug>      → 旧 worktree 形态，需单独分支
通用兜底 Dev/<anything>           → 保证覆盖 ~100%（personal-assistant / joycon-typeless / vedic-astro-skills 无 issue 后缀）
```
> 角色后缀目前只见 `-qa`。其余角色（lead/main/runner）从路径形态判定。
> 若决策 B 需要更细的「工序」轴，则需 join StateStore（`sessions.session_role` / `issue_labels` / stage）经 `worktree_path` 关联——成本更高，作为增强。

## 4. 可复用的现有 building blocks（来自 codebase 扫描）

| 用途 | 文件 | 关键符号 |
|------|------|----------|
| 报告发布管线（FLY-203） | `packages/teamlead/src/bridge/reports-route.ts` | `createReportsRouter()` `/api/reports/publish|deliver` |
| 报告注册/Vercel 重部署 | `packages/teamlead/src/bridge/report-registry.ts` | `ReportRegistry.stagePublish/commit/abort` |
| CLI 发布命令 | `packages/flywheel-comm/src/commands/publish-report.ts` | `publishReport()` + proofshot 截图 |
| 聚合-格式化-推送范式 | `packages/teamlead/src/bridge/standup-service.ts` | `aggregateStandup()` `formatStandupReport()` |
| 项目名映射 | `packages/teamlead/src/bridge/linear-scope.ts` | `resolveProjectNameParam()` |
| Session 元数据（join 用） | `packages/teamlead/src/StateStore.ts` | `project_name` `issue_identifier` `session_role` `issue_labels` `worktree_path` `adapter_type` |
| CLI 子命令落点 | `packages/flywheel-comm/src/index.ts` + `src/commands/<name>.ts` | 每个子命令一个文件 |
| 既有但未用的成本列 | `packages/teamlead/src/StateStore.ts:363` | `cost_usd REAL`（仅存储无计算） |

## 5. 风险 / 注意点

- **数据量**：685+ jsonl 文件、12 万+ assistant 轮。全量扫描需注意性能（流式逐行 parse、按时间窗早停、可选 mtime 过滤 / 缓存）。
- **去重**：必须按 requestId 去重，否则 iteration 重复计数。
- **覆盖率**：兜底规则要把「未分类」压到接近 0，否则报告出现大块「unknown」会削弱「看得见」。
- **多机/多账号**：当前只覆盖本机 `~/.claude`；多账号若各自 home 需配置多路径（暂不在范围）。
- **USD ≠ 真账单**：报告需注明是估算重量，避免误读。
