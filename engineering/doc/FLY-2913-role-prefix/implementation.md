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

## 房间就绪前的套件准备（2026-09-26 UTC）

已新增计划要求的 `packages/qa-framework/suites/fly-2913-role-prefix.md`，明确五角色、三组同条件配对、实际消费者、必要能力/低频依赖、控制测试、回退及退出判据。只读核对发现 `scripts/lib/qa-generalized-e2e-lib.mjs:657` 的通用 start builder 固定 implement=codex，不能直接当 Claude implement 验收；套件因此明确用独立串行的 Claude 作者/Codex 作者任务组覆盖原有两方向评审，并保留现有家族与阶段门禁。

这只是 T5 的套件文档准备，尚无专项真实模型 driver 或任何角色成功回执，不上调 T1–T6 完成计数。已核对计划引用、五角色标识与 diff whitespace；纯 Markdown 变化未新增测试或运行全包测试。当前 Lead 尚未回 room-info，装房仍由其沙箱外载体执行。

## Pinned 身份解析基础（2026-09-26 UTC）

新增 `packages/teamlead/src/workflow-prefix-context.ts`，供后续真实采样及 T3/T4 接线共用；当前尚无生产调用者。只接收服务端持久 run、精确 nodeId 和可选预期 snapshot digest，调用现有完整 `parseWorkflowRunSnapshot` 校验器。只有持久 template 为 `tpl_code` / `tpl_simple_code` 才生成 engineering provenance；phase 取已校验节点 type，不猜 displayName/nodeId/标题。保持 schema 1/2/3 兼容；旧快照无 agent 时返回 null，不读当前磁盘补造义务；schema 2/3 的角色正文和摘要直接来自 pinned agent。

不符的 template revision/id、snapshot digest、缺失节点及损坏 snapshot 明确拒绝，错误仅给固定码，不回显原文。输出只含 workflow 身份、nodeId、phase 和 pinned agent，不携带任意 row 元数据或 permissions。未改 API payload、snapshot schema、数据库、Lead、Codex、启动 argv 或默认开关。

测试先修正夹具以符合真实 manifest 的独立 QA/角色/handbook 合同；这些构建失败没有计作功能红测。有效夹具下空实现有 10 个功能断言失败，再实现最小解析器，单文件及 owning package `vitest related` 各 14 tests 通过；related 仅命中新测试，没有跑全包。消费者全路径/文件名/父目录及 `.js` import spelling 搜索逐项记录在 `evidence/prefix-context-consumer-sweep.json`。`pnpm --workspace-concurrency=2 --filter "flywheel-teamlead..." build` 与 `pnpm lint` 均 exit 0（lint 25 条既有 warning）。`pnpm --workspace-concurrency=1 --filter "...flywheel-teamlead" typecheck` 的 teamlead 和 voice-codex 均 exit 0；命令、源码及日志摘要见 `evidence/prefix-context-checks.json`。

这只是 T3 的身份解析基础，不能据此标记 T3 接线完成；T1 真角色加载盘点、T2 最终编译器/控制、实际启动消费及五角色验收仍缺。

## 2026-09-26 — 混合插件副本编译基础

新增 `packages/claude-runner/src/runner-prefix-plugin.ts`，把已审计的完整文件清单、精确组件选择、required 组件及显式资产依赖转成现有私有产物复制器的输入。支持当前已核对的标准 skills/commands/agents 布局；保留原插件名、版本及非组件 manifest 字段，保留 hooks、MCP 文件、许可证、选定技能内的脚本及全部非组件资产。生成的 manifest 只列选定组件；未选组件和 cache `.in_use` 不进入副本。缺 required、缺资产/依赖、悬空 manifest 引用、未知布局和路径越界均拒绝，不把不支持的布局伪装为优化成功。

复制器增加仅限 `.claude-plugin/plugin.json` 的生成内容通道，同时校验原文件 SHA、生成文件 SHA，并拒绝改变插件身份、hooks 等非组件 metadata；技能、hook 和脚本正文仍只能原样复制。stamp 不保存生成内容，只保存哈希；生成内容变化不能通过旧 stamp 校验。旧的无转换输入保留原 stamp 格式和复制语义。

本批仍为离线编译能力：调用方必须提供经审计的完整文件/依赖清单，它不自动推断脚本引用，不选择最终五角色清单，不执行插件或修改共享安装。真实 namespace、hook 次数和 CLI 组件加载控制仍须在 Lead 提供的 529 房验证；T2 未完成，T3/T4 尚未接线。

红绿证据：生成 manifest 最初 2 个行为测试失败；插件编译空实现 17 失败/1 通过；新增 metadata 保护 3 失败。最终两份相关测试共 70 通过，`vitest related` 同样只命中这 70 项；受影响包及依赖 build、四个依赖方 typecheck 和 lint 结果见 `evidence/plugin-checks.json`。消费者检索逐匹配处置见 `evidence/plugin-consumer-sweep.json`。这些结果不构成五角色 token 表、真实任务、回退、完整 CI 或交卷证据。

## 2026-09-26 — 开关改走 FlagStore（Lead 裁定）

接续 e8f649ec 的 WIP `f3c280e89`（未重写）。`runner_prefix_profile` 登记为 bridge_global store 枚举（`legacy|role-v1`，默认且唯一回退 legacy），照 `runner_memory_mode`：registry + 宽松 enum codec（非法值解析为 legacy，符合 enum codec 合同）+ 具名 wrapper `storeRunnerPrefixProfile`。选择器改收 store 原始行，不再读 env；env 名只作首次建行的引导种子元数据。读点：`run-infra.ts createRunInfraDispatcher`（每次新启动读一次）与 `plugin.ts startBridge`（评审每轮启动读一次）。Lead/Codex 不读；无新 exemption；不默认启用。

红绿：选择器改签名 21 项失败 → 转绿；registry 计数/founder copy/登记形状与 drift 读点清单 3 项失败 → 转绿；flag-store live-observe 2 项与 dispatcher 11 项失败 → 转绿；Lead 点名的 `feature-flags-drift` 2 个失败转绿。负控：删掉 `startBridge` 的 store 读取，drift 的 readSite 代码证据检查即红，已还原。

## 2026-09-26 — T3 角色编译与 runner 启动接线

`packages/config/src/runner-prefix-profiles.ts`：五角色 v1 **移除清单**（技能 `skillOverrides:off`、子代理 `permissions.deny Agent(name)`、用户规则 `claudeMdExcludes`），清单外全部照旧加载；pinned 角色 frontmatter 技能与合同必需技能永远保留（编译时并集 + 模块测试）。纯函数编译器输出一个 settings 源、profileDigest（绑定 role/taskSet/pinned workflow/nodeId/arm/清单）与不含正文/路径/凭据的 stamp。计划写的 JSON 数据文件改为 TS 常量模块（类型检查与构建更简单），语义不变。v1 不发 `--tools`、不用 strict MCP：内置已加载工具仅 782 token、xiaohongshu MCP 全为 deferred，收益小风险高，逐项理由见 `role-capabilities.md`。

Blueprint 在 skill arm 解析后、worktree 副作用前编译（仅 claude-tmux）；TmuxAdapter 把 profile 作为**第一个** `--settings` 源（arm/opt-in/memory/hooks/Discord 强制 deny 依次覆盖其后），并先原子写 `~/.flywheel/runner-state/<exec>/prefix-profile.json`（0700 目录/0600 文件，含 executionId/activationId/sessionId）；写不成则整次启动回落 legacy 并告警。验证工作流执行的 executionId 来自 admission 预铸值，runtime 行先于派发存在；非工作流启动查不到 → legacy。

红绿：编译器模块缺失 → 18 项转绿；TmuxAdapter 3 项失败 → 转绿，另补“runner-state 父路径是文件”回归（修复前 temp 清理会抛出中断启动）；Blueprint 2 项失败 → 转绿。TmuxAdapter 全文件 190/191、Blueprint 27 文件 342 项通过。

## 2026-09-26 — T4 跨家族评审接线

`review-prefix-profile.ts`：角色只取持久 `job.review_type`，engineering 身份只取作者 execution 的 pinned run；作者自己的 skills 不并入评审者保留集；legacy/未设置时不读任何 provenance。coordinator 在**每次评审启动**（首轮、同 session 续轮、新 session 回退）现读 store 现编译；解析抛错只记日志并以 legacy 评审，绝不跳过评审或产生 verdict。`claude-review-runner` 把 profile 合并进唯一 `--settings`（强制 deny 仍最后），按评审 session 写 0600 stamp（含 requestId/sessionId/resume），写失败则该轮 legacy。land-content-review 固定 review-code 走同一解析器。Codex 反向评审（Claude 作者调用 codex-code-review 等）不受影响：design/implement 保留全部 Codex 技能与规则。

## 已知未实现 / 偏差（须在 PR 披露）

- **同 session 恢复复用原 stamp** 未实现：恢复启动按 pinned 快照 + 代码内清单 + 当时 store 值重新编译；若期间开关改为 legacy，恢复的会话得到 legacy（与“开关对新启动生效”一致，但不是计划所写的复用原 stamp）。
- 控制是否真正移出前缀（插件/同步技能的 `skillOverrides`、`Agent(name)` deny 是否删描述、`--settings` 下的 `claudeMdExcludes`）尚未在 529 证实；`role-capabilities.md` 的节省数字仅为预估。
- stamp 清理：runner-state 目录目前没有任何既有剪枝（mailbox 哨兵同样常驻），本单未新增清理机制；stamp 约 1KB/次启动，与哨兵同生命周期。
- 设计要求的配置/来源漂移诊断：v1 清单是代码常量、pinned 快照不可变，编译确定性由测试保证；不存在运行期“可变 cache”漂移面，因此没有单独的漂移检测器。

## 2026-09-26 — 同步 main 与合并后验证

合入 origin/main（74d0fc0c1，7 个提交）。冲突 3 处均来自 af729d662 的 runner 测试策略 hook：TmuxAdapter 与 claude-review-runner 按“prefix 为第一个 settings 源 → 原有合并 → 测试策略 hook 追加 PreToolUse”组合；config index 两组导出并存。lockfile 无变化，未重装依赖。

合并后：TmuxAdapter 192/192（首轮在负载 ~150 下 2 项进程退役/review-wait 时序失败，单测与整文件重跑均通过，判定负载抖动）；teamlead 相关 91 + 直接消费者 23 文件 519；config 138 + drift-scan 27；claude-runner 其他适配器 5 文件 202；edge-worker 3 文件 36；`pnpm lint` exit 0（25 既有 warning）；`...flywheel-config` 12 包 typecheck 通过；`flywheel-teamlead...` build 通过。检索与排除理由见 `evidence/session3-consumer-sweep.json`。


## 2026-09-26 — 独立评审（fresh-context 子代理）处置

结论无 HIGH。逐条：

- **MEDIUM 解析器 fail-open → 已修**：`parsePinnedRoleSkills` 支持行内 `[a, b]`、标量 `skills: a`、任意缩进的块列表与行尾注释；`skills` 键存在但无法解析时返回 null，编译器随即跳过全部技能移除（stamp 记 `skillRemovals: skipped-unparsed-pinned-skills`），子代理/规则移除照常。新增用真实 `.flywheel/agents/nodes/{eng_design,implement,qa}.md` 解析的测试。红：新增 3 项及随签名改动的 5 项失败 → 转绿。
- **MEDIUM tmux 命令预算 → 已修**：role-v1 时把完整合并后的 settings 写成 `runner-state/<exec>/claude-settings.<session>.json`（0600），argv 只带路径（CLI `--settings <file-or-json>`）；legacy 仍是原内联 JSON，字节不变。stamp 改为 `prefix-profile.<session>.json`，记录 `settingsFile` 与 `settingsSha256`（顺带处理“陈旧 stamp”LOW：stamp 与实际送给 CLI 的字节绑定、按 session 分文件）。新增 400 个技能条目的大 profile 用例，断言 argv 不含其内容。
- **MEDIUM 插件技能控制可能无效却被记成功 → 部分处理**：驱动汇总新增 `ineffective`/`allControlsEffective`，CLI 输出分开的 capabilityPass 与 controlsEffective；能力安全通过不再被误读为节省已证实。`everything-claude-code:*` 条目暂留，由 529 实测决定：若 `skillOverrides` 对插件技能无效，就从 v1 清单删除这些条目（不让 stamp 夸大），并在 PR 注明。
- **LOW runner 失败即阻断 vs 评审回落 → 统一为回落**：遵照 Lead“legacy 为唯一回退值”，dispatcher 在开关读取失败（`switch-unreadable`）或 pinned provenance 出错（`provenance-error:<code>`）时都以 legacy 启动并记录原因；原“损坏快照拒绝启动”测试改为“回落 legacy + 可见原因”。
- **LOW CLAUDE_CONFIG_DIR → 已修**：编译器改收 `claudeConfigDir`（Blueprint/评审解析用 `CLAUDE_CONFIG_DIR ?? ~/.claude`），规则排除路径跟随实际配置目录。
- **LOW 测试缺口 → 已补**：评审新 session 回退轮的 prefix 重解析测试（覆盖既有路径，非红转绿）；控制驱动按 `类型:文件名` 比对记忆文件，避免一个 CLAUDE.md 掩盖另一个的丢失。
- **LOW QA 移除 codex-multi-account.md → 保留决定**：QA 合同不调用 Codex CLI（frozen-head CI 由 `ci-full` 命令负责），该规则只约束 `codex exec` 与切号；若 529/QA 发现 QA 需要，改回保留。
- **LOW 评审 stamp 在同 session legacy 续轮后可能陈旧 → 记录不修**：评审 stamp 已按 session 分文件并带 `resume`；同 session 回滚到 legacy 的续轮属极端路径，列入已知局限。

## 2026-09-26 — 529 实测推翻 off/deny，改为 name-only + 规则排除（compiler v2）

房：slot 4，head `5c061c862f8f1af88149c2107703ede01c7245a1`（room-info 与 `/health` buildSha=artifactBuildSha 一致），cwd `/tmp/flywheel-test-slot-4/project-slot-4`。探针子进程清洗 `FLYWHEEL_*`/`TEAMLEAD_*`/凭据变量（否则用户级 SessionEnd hook 会拿本 runner 的回调令牌向 Bridge 报告“会话结束”），加 `--no-session-persistence`。探针改为计数并丢弃 SessionStart hook 生命周期帧（CLI 在控制请求前后输出 hook_started/progress/response；此前被判 malformed）。

先单项消融（`evidence/control-ablation.json`），再用首轮真实 API usage（`-p` 固定极短提示，读 input+cache_creation+cache_read）复核，因为 `get_context_usage` 对 skillOverrides 的分类不可靠：
- `skillOverrides: off` 与 `user-invocable-only` 让真实 prompt **增大** 0.9～1.8K；`name-only` 让它减少 4.1～4.5K，且技能仍列出、仍可调用。
- skillOverrides 对插件技能无效；`permissions.deny Agent(name)` 不删描述、不省 token。
- `claudeMdExcludes` 有效（−2.1～2.5K）。组合 name-only + 规则：65,902 vs 基线 72,532/72,976。

据此：技能改为 name-only（仅非插件），删除子代理 deny 与插件技能条目；stamp 改为 `hiddenSkillDescriptions` / `excludedRules`（不再宣称“移除”）；无法解析 pinned 技能时保留全部描述（`skillDescriptions: kept-unparsed-pinned-skills`）。驱动以首轮真实 usage 为主测量、诊断为辅，逐项核验改为“目标技能仍在且变小、规则消失、必需与未列项不变”。这比原计划更保守（不删任何技能），属于基于实测证据的机制修正，已向 Lead 报告。

房内开关：受管 `feature-flags set` 对房 Bridge 返回 401（CLI 不带 bearer）；带房 api-token 走同一 stage 路由返回 404。未继续深挖、未直写 DB；探针测量不依赖房内开关。已请 Lead 用其管理通道设置或确认无需。

## 2026-09-26 — Codex 代码评审 Round 1（PR #1361）处置

三项 MEDIUM 全部修复：
- **下层 skillOverrides 被放宽**：slot 4 原始数据证明 CLI 对 skillOverrides 按键合并（用户级 10 个 off 技能在 15 组 role-v1 中都未重现），但若用户/项目层把清单中的某技能设为 `off` / `user-invocable-only`，per-launch 的 name-only 会把它放宽成可见。新增 `readLowerSkillOverrides`（用户 → 项目 → 项目本地，缺失跳过，不可读/畸形抛错→legacy），编译器对下层更严格的技能不写入 map，stamp 记 `keptLowerRestrictions`。runner 读 `<Claude 配置目录>/settings.json` 与项目 `.claude/settings(.local).json`；评审读用户层与被审 checkout 的项目层（依赖签名增加 `cwd`）。
- **Blueprint 编译异常越过回退边界**：编译（含下层 settings 读取）包进 try/catch，失败以 legacy 启动并记 `[Blueprint] FLY-2913 prefix legacy reason=compile-error:*`；新增“编译失败仍调用 adapter 且不带 profile”测试。
- **探针子进程环境黑名单漏凭据入口**：改为最小白名单（HOME/PATH/USER/LOGNAME/SHELL/LANG/LC_ALL/LC_CTYPE/TERM/TMPDIR/TZ/CLAUDE_CONFIG_DIR + 固定不存在的 marker 目录）；测试覆盖 GOOGLE_APPLICATION_CREDENTIALS/SSH_AUTH_SOCK/AWS_PROFILE/GH_CONFIG_DIR/KUBECONFIG 等。白名单下真实首轮调用仍能鉴权（scratch cwd，44,345 tokens）。

验证：config 52、Blueprint 71、teamlead（review-prefix/coordinator/land/claude-review-runner/dispatcher-prefix）213、驱动 10、探针 31；config/edge-worker/teamlead tsc 通过；相关包构建通过。
