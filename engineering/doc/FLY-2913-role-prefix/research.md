# FLY-2913 逐角色精简固定前缀 — 调研
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913/token8-给-claude-runner-评审-qa-各配精简固定前缀逐角色只加载真正用到的工具插件mcp-与规则)
日期: 2026-09-25
基于: exploration.md

## 结论

使用现有 Claude 启动配置链，为 design、implement、QA、review-design、review-code 解析固定的能力配置。保留订阅身份、原 cwd、memory、hooks、skill-framework 和非 Lead 禁令；不创建新 Claude home，不改 Lead。缩减工具可见范围与权限分别处理。需要先完成逐角色实际加载测量，再启用配置；历史上下文代理不替代这一测量。

## 证据与测量口径

原始 FLY-2904 `research.md` W11 明确称 min-context × requests 为代理，含初始任务，不全是可删前缀。原始证据位于同仓另一 checkout 的 `engineering/doc/FLY-2904-token-waste-census/evidence/`；本目录保留脱敏再聚合结果及来源哈希，不复制原始会话正文。

以下历史上下文中位数按**主会话文件**分组，入选请求观察窗为 2026-09-11 22:00Z 至 09-25 22:00Z；但原始 first_ctx/min_ctx 从整个入选 transcript 文件取值，并非只在该窗口内计算；调用记录则严格截取最后七天 [09-18 22:00Z, 09-25 22:00Z)。子代理单列在 JSON 中，不混入主角色数字。

| Claude 角色 | 入选文件首/最小上下文中位数（历史代理） | 7 天请求数 | 有请求的文件数 | 工具结果行数 |
|---|---:|---:|---:|---:|
| implement | 89,976 | 12,020 | 60 | 12,319 |
| eng_design | 87,164 | 1,571 | 15 | 1,765 |
| QA | 91,029.5 | 21,249 | 117 | 20,502 |
| design review | 65,351.5 | 2,232 | 32 | 2,357 |
| code review | 65,767.5 | 12,685 | 137 | 13,278 |

工具结果行不是按 tool_use_id 去重的调用次数，也不证明成功。另有 3,503 个请求仍是 unmapped-worktree，未摊派给角色。CSV 不保留 Skill 的技能名参数，所以只能证明 Skill 被调用，不能据此删某个技能。所有分类及 Bash 子类详见 `evidence/historical-tool-results.json`。

可直接反驳的删除方案：QA Chrome computer 40 行、navigate 20 行、浏览器连接查询 15 行；Playwright navigate 在 implement/design/QA 分别 1/1/3 行；Context7 在 implement/design-review/code-review 分别 3/4/7 行。design 有 publish-report 11 行；design/implement/QA 的 Skill 为 21/74/96 行。因此浏览器、资料查询、技能与发布能力不能一刀切掉。

## 实际入口及消费者

| 文件与锚点 | 已确认行为 | 设计含义 |
|---|---|---|
| `packages/config/src/runner-mcp-profile.ts:94` | Serena 默认关闭；QA/标签正向启用 Playwright；full-mcp、no-chrome | 复用现有优先级与例外 |
| `packages/teamlead/src/bridge/run-dispatcher.ts:1093,1860` | 重试与首次启动分别解析 profile，仅 final claude-tmux | 两入口都要覆盖 |
| `packages/edge-worker/src/Blueprint.ts:2868,3082` | pinned workflowAgentContent；合并 skill-framework 插件选择 | 不从 displayName 推 role，不覆盖当前技能 arm |
| `packages/claude-runner/src/TmuxAdapter.ts:1635,1695,1721` | fresh/resume 同一构建器；allowed-tools；memory/usage/identity hooks | 单个 settings 合并；权限不是 token 控制 |
| `packages/config/src/non-lead-forbidden-plugins.ts:53` | 最终强制两个 Discord plugin false | legacy/full-mcp 也不能绕过 |
| `packages/teamlead/src/bridge/claude-review-runner.ts:118,497` | 独立 print 评审及 reround；洗去 Bridge secret env | 同一 profile 编译器的独立消费者 |
| `packages/teamlead/src/bridge/review-request-coordinator.ts` | review kind、session、request 的持久身份 | reviewer 子类型来自请求，不来自 prompt 文字 |
| `packages/teamlead/src/bridge/land-content-review.ts` | 另一 runClaudeReviewRound 调用者 | 必须显式传 review-code 或明确留 legacy，不可无意缩减 |
| `packages/teamlead/src/bridge/codex-instruction.ts:76,93` | Claude 作者使用 Codex review skill | 作者的评审技能仍属必需能力 |
| `packages/teamlead/src/bridge/event-route.ts:534` | Codex 作者使用请求驱动 Claude reviewer | 两方向分别验收，不更改 Codex 配置 |

旁路 SDK `ClaudeRunner.ts` 的 settingSources/MCP 合并，及 `ClaudeCodeAdapter.ts`、`ClaudeCodeRunner.ts` 是不同消费者。新优化范围限定生产 claude-tmux 和直接 Claude review 子进程；其他 vendor/backend 必须保持旧路径并报告不适用，不能把它们计入节省。

## 现有载体能力与来源

本机 `claude --version` 为 2.1.283。当前官方资料（2026-09-25 查验）：

- [CLI reference](https://code.claude.com/docs/en/cli-reference)：allowed-tools 管免审批，tools 管可用内置工具；strict-mcp-config 配合显式 mcp-config；bare 会同时跳过 hooks、规则与订阅认证，拒绝使用。
- [Skills](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings)：skillOverrides 可按名字隐藏非插件技能；**插件技能不受它控制**，需要切换其插件。只禁 Skill 权限不能证明列表不再注入。
- [Memory](https://code.claude.com/docs/en/memory#exclude-specific-claudemd-files)：claudeMdExcludes 按绝对路径排除规则/CLAUDE.md，managed 指令不可排除。只排盘点并判定无关的文件。

本机 help 另显示 system-prompt-snapshot 默认 on；首轮 system/append prompt 会在续跑中复用，直到 compact。不能仅看到新 argv 就声称续跑前缀改变。

本地 `/Users/xiaorongli/Dev/claude-code` 是标记 `0.0.0-leaked`、2026-03-31 的旧源码，只用于定位原理，不当成 2.1.283 的运行证明。其 `utils/claudemd.ts:547,635,766` 展示规则排除，`utils/secureStorage/macOsKeychainHelpers.ts:29` 展示 config dir 改变 keychain service，说明换 home 有认证风险。当前二进制还需在 529 验证控制确实生效；print 成功不能排除无效 settings 被忽略。

## 固定前缀实测的缺口

当前证据没有每角色完整的 loaded tools/plugins/MCP/skill/rule 清单及各组件 token 数，也没有 slim 后数值。静态安装目录和 enabledPlugins 仅是候选输入，不能标为已加载。plan 的第一交付是冻结实际 inventory；配置候选需据此逐条完成 keep/remove 判定，才能进入默认启用。不得把预算目标或历史代理填入 before/after 表。

## 非目标与约束

不改 Lead、模型、effort、提示缓存机制、权限模式、credentials、生产服务生命周期、图调度或评审 verdict 规则；不把大工具输出优化和频繁唤醒并进本单。本机仅跑命中本改动的测试；所有模型代表任务在 529 隔离房执行。

静态盘点是 bounded 候选采样：未穷举 synced 深层技能、所有祖先/嵌套 CLAUDE、动态加载和 managed 来源；目录深度及范围见脚本。零命中不作实际零加载，T1 必须补齐运行时清单。

## R1 补查：任务技能声明缺口

`Blueprint.ts` 的 workflowCapabilities 并不包含技能。`scripts/meeting-notes-scheduler.ts:525` 和 `scripts/xiaohongshu-scheduler.ts:236` 都通过 runs/start 启动普通 runner，当前 payload 没有能力集合。`lead-capabilities/skill-adapters.ts:58` 明确两种小红书学习是 Runner 工作流。修订计划新增有限 ID 声明及 pinned 传递；所有没声明的来源走可见 legacy，不以 phase 推断为纯工程任务。
