# FLY-2913 逐角色精简固定前缀 — 实施记录
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-25
基于: plan.md

## 当前边界

T1 工具批次及七天背景刷新已实现；T1 五角色实际基线尚未完成。T2 离线选择器/文件产物基础实现中，未接生产 consumer；T3–T6 尚未实现。本文件不构成 code review、完整 CI、QA、生产或交卷证据。当前已批准设计门为 `5aec411f-dcf1-4ecf-93ba-71fb9d401763`，服务端重读 effective/raw APPROVED；后续 Lead 的任务来源修订见 plan §六。

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

2026-09-26 UTC 进一步只读核对同一 CLI 二进制：`get_context_usage` 接受 `detail: full|summary`；`/context all` 调用同一分类函数，其返回值明确省略 `systemTools`、`deferredBuiltinTools`、`systemPromptSections`，不是 reader 拼错字段。这些逐项值仍需受控消融，不能写 0。分类器还可能返回独立的 `MCP server instructions`，reader 原先拒绝它；已先观察 fixture 失败 `unrecognized context category`，再只补这一合法固定类别并验证通过。二进制身份、函数位置和局限见 `evidence/cli-diagnostic-capabilities.json`；没有改写二进制、调用模型或把静态检查记作实际加载测量。

T3/T4 接线的只读路径核对另发现三个必须覆盖的入口：`actions.ts` 的显式 retry、`workflow-resume-identity.ts` 的 standby resume、`land-content-review.ts` 的独立 Claude 内容评审。standby resume 故意不带 generalizedExecution，不能为传 prefix 身份而伪造它；要从原 run snapshot 独立恢复身份并验证既有 session stamp。首次入口、engine 后继/replay、retry 均已有经过 parse 的 pinned snapshot；评审可从持久 job.execution_id 关联 run，使用 job.review_type。无需增加 API payload、snapshot schema 或数据库表；现有只解析 modelRouting 的 helper 不能冒充完整 prefix provenance。上述接线尚未实现。

## 未完成事项与外部状态

1. 完成五角色真 consumer 启动、完整 loaded 清单与三组配对采样；先补 hook/工具名 roster/builtin costs 的可归属证据，再决定移除项。
2. 遵照 Lead 从 pinned `tpl_code` / `tpl_simple_code` 派生 engineering，其他来源 legacy；后续节点/retry/reviewer 均需覆盖。
3. 刷新七天背景统计时只读 transcript。origin/main 的 FLY-2904 `census.py` 含 live DB roster，不能直接运行；原 CSV 未入 git，snapshot_owner_unavailable 不阻塞主线。
4. 标准 slot 1 teardown 在 `test-teardown.sh:459` 调 `cmux_process_incarnation` 时受 sandbox 禁止 `ps`，返回 `unable to publish qa_teardown yield claim; no teardown action taken`。问题 `2aa703eb-8850-4f6d-a0b6-3a4154790774` 后由 Lead 在沙箱外运行本 worktree 标准脚本，回执 rc=0、`Slot 1 teardown complete`，证据归档 `~/.flywheel/qa-evidence/slot-1/20260926T051921Z`。没有伪造 incarnation、改 claim/lease 或手杀。Lead 要求后续起/拆房先 ask 由 Lead 或 Claude QA 载体执行，磁盘恢复前暂不起房；Codex 不再直接调用 deploy/teardown。

## 七天刷新与 T2 离线批次（进行中）

`weekly-tool-use.md` 与 `evidence/weekly-*.json` 固定 2026-09-19T05:18:04.661Z 至 2026-09-26T05:18:04.661Z 的明确输入清单、角色判定和聚合：1,907 份 Claude 转写、94,549 次去重调用，其中 54,200 次归属五角色、40,349 次未知。读取过程中不连接 live DB，不输出参数/正文。源转写本身不是文件系统快照；后续重跑可能受源文件编辑影响，限制明确记入 provenance。第一次旧 manifest 结果已丢弃，最终输出逐条核对 sessionId/role 与完成后的 manifest 一致，cutoff 一致。

`runner-prefix-profile.ts` 目前只是没有副作用的选择器，未从包 index 导出、未接启动路径。只接收服务端 pinned run/template/phase 或持久 review type：`tpl_code` / `tpl_simple_code` 可选 role-v1；Lead、Codex、其他 backend、未知 role/来源、legacy 开关及 full-mcp 保持旧配置。只复制 runId/templateId/snapshotDigest，不把任意调用方元数据送入产物。开发默认仍 legacy，最终默认启用属于全部角色验收后的 T6，不能把当前选择器当作已下发精简配置。

`runner-prefix-artifacts.ts` 是文件产物基础：调用方明确给 trusted roots、完整文件闭包、目标相对路径和内容 SHA；独占私有目录内原子发布，恢复核对身份/来源/产物哈希。它尚不选择插件组件、生成 role 配置或启动模型。局部 spec 审查发现 umask 影响实际模式、lstat/open 间权限变化漏验两项，已分别观察红测试并修正：创建后精确 chmod/fchmod；四次 stat 都核 mode/nlink。局部 spec 复核和随后 quality 审查已结束、无余项；不替代正式跨家族 code review。

本批新代码定向验证：config 22 tests、claude-runner 47 tests 通过，均用 owning package 的 `vitest related ... --run` 再验证；四个改动 TS 文件 Biome clean；`pnpm --filter 'flywheel-claude-runner...' build` exit 0；`pnpm lint` exit 0（25 条既有 warning）。消费者查询 12 次、831 个匹配，逐项处置见 `evidence/t2-consumer-sweep.json`。依赖方 typecheck 首轮 11 包通过，voice-codex 因缺少本地 voice-bridge dist 失败；补建 `flywheel-voice-bridge...` 后，voice-codex typecheck exit 0，没有改 voice 源码。命令、源码和日志摘要见 `evidence/t2-offline-checks.json`。

继续：T1 基线与 collector 接线 → T2 编译器/CLI 控制负控 → T3 runner → T4 reviewer → T5 真实任务及回退 → T6 默认启用、最终 code-review、PR、needs_review 完成路由。

## 换号续做：采集器修复（2026-09-26 UTC）

从救援头 `eb1fe9e1d3039a9df0f2171bef76810df354f486` 恢复，当前 TURN 为 implement。重新执行发现 `qa-2913-context-probe.test.sh` 未登记 CI，枚举测试真实失败；probe 同时有 `noAssignInExpressions` 和格式两项 lint error。只在现有 FLY-2913 CI step 登记该测试、将读行循环的赋值移出条件并格式化本文件。

进一步核对当前 CLI `--help` 的 effort 枚举和 `claude-review-runner.ts` 的 `DEFAULT_REVIEW_EFFORT=xhigh`，发现 probe 会在 spawn 前错误拒绝这个有效评审参数。新增保留 xhigh argv 的回归先报 failed/complete 不符，再仅补合法枚举项转绿；未修改模型、effort 或生产启动器。

本批验证：27 项 probe fixtures、prefix inventory、13 项 weekly collector、CI shell suite enumeration（含删除变异负控）、CI structure 及 `required-wall-clock-thresholds.test.ts` 均通过。`pnpm lint` exit 0（25 条既有 warning）。无 TypeScript 源码/API/导出变更，无 owning package build 或 dependent typecheck 新要求；没有全包测试。按三个改动文件的全路径/文件名/父目录完成消费者搜索，逐匹配排除理由见 `evidence/resume-consumer-sweep.json`。

Lead 回答 `1de718ec-43e5-455a-a259-981a1056f082` / `3c36ba2d-b163-4115-9417-ab744eb1e78e`：房间尚未启动，旧头冻结解除，先提交推送这些修复；房间待机器负载稳定由 Lead 在沙箱外按新完整 SHA 起，再回 room-info 和双 SHA。当前没有五角色基线或真实任务回执，T1/T2 未标完成，T3–T6 仍待执行。
