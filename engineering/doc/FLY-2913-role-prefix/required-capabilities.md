# FLY-2913 逐角色必需能力 — 调研
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-25
基于: plan.md、weekly-tool-use.md

这是精简前的保留依据，尚不是最终 keep/remove 清单或逐角色 loaded 验收。T1 真 consumer 基线仍待 529 房；不能把未验证的候选配置默认启用。角色前缀必须同时满足 pinned 角色合同、当前 skill arm、项目义务和实际调用记录；历史零调用不能覆盖合同。

| 角色 | pinned 角色明确的技能 | 额外不能丢的能力及依据 |
|---|---|---|
| design | `brainstorm`、`research`、`write-plan`、`diagram-design`、`codex-design-review` | `.flywheel/agents/nodes/eng_design.md` 要求 onboarding、有效设计评审、founder HTML、TURN/报告/完成路由；保留 Bash、文档写入、资料查询、Mermaid/HTML、浏览器验证和对应交付技能。历史确有 Agent/Monitor/TaskStop/ToolSearch/Playwright 调用。 |
| implement | `implement`、`systematic-debugging`、`frontend-design`、`proofshot`、`codex-code-review` | `.flywheel/agents/nodes/implement.md` 要求 TDD、相关测试、UI 实测、PR 和有效 code review；当前 arm 的 TDD/debug/verification/review 技能不可删。历史 `codex:rescue` 36 次，Context7 和 Playwright 均非零。 |
| qa | `onboarding`、`proofshot`、`research` | `.flywheel/agents/nodes/qa.md` 要求 Claude-in-Chrome、chrome-repair、真实 N-to-N、HTML/GIF/图表、准确 QA receipt；保留读写证据、Bash、等待/停止任务、Chrome/Playwright、founder HTML 交付及所需图形工具。不以 QA 不写产品代码为由删除证据写入工具。 |
| review-design | 持久 `job.review_type=design`；没有可冒造的作者 skills frontmatter | `review-request-coordinator.ts` 的真实评审 prompt 要求读完整计划、检查代码/风险、冻结 plan blob、结构化 verdict。项目 CLAUDE 的 planner/code-reviewer 义务及安全规则仍需核对；保留 Bash/Read/检索/Context7 和必要协作。历史有 Write 4 次，只证明证据操作存在，不授权编辑作者代码。 |
| review-code | 持久 `job.review_type=code`；没有可冒造的作者 skills frontmatter | 真实评审 prompt 要求确切 head、merge-base diff、相关测试、前台等待和最终 JSON；保留这些工具及安全审查能力。历史 Agent/Monitor/ListAgents/TaskStop、WebFetch、Context7 均非零，不能缩成只读文件四件套。 |

`systematic-debugging` 等逻辑能力必须在当前有效 arm 中解析，不能固定把所有会话改到 superpowers。Blueprint 当前按 `skillAssemblyBaseArm` 决定 superpowers/matt/bare，matt 的 readiness fallback 也必须保留；本单不能借精简改变 arm 或模型。

`codex-design-review` / `codex-code-review` 的 companion 依赖，以及 `codex:rescue` 的技能、agent、脚本资产必须一起保留。禁掉 Codex 插件只留下一个同名命令会破坏反向评审。角色 frontmatter 中在旧探针未显示的技能（例如 diagram-design、frontend-design）标为待真 consumer 核对，不能宣称已加载或偷偷从 required 集合删去；已有缺失 fallback 与本次新缺失要分开记录。

## 已核对的加载控制，仍需当前 CLI 实测

- `skillOverrides: off` 可用于非插件技能；插件技能不受该字段控制，混合包要验证选定副本的 namespace、hook 次数和资产闭包。[官方 skills 说明](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings)
- `--tools` 控制内置工具集，`--allowed-tools` 控制免审批；不能把权限 allowlist 当作 token 削减证据。默认工具集还受 CLI 版本影响。[官方 CLI 说明](https://code.claude.com/docs/en/cli-reference)
- `claudeMdExcludes` 匹配绝对文件路径，不能排除 managed 指令；必须对真实路径和链接来源做映射。[官方 memory 说明](https://code.claude.com/docs/en/memory#exclude-specific-claudemd-files)
- 用户级 agent 描述也是前缀成本。当前已查到的官方逐 agent 控制是 `Agent(name)` deny；文档证明可阻止使用，但还未证明诊断清单/实际 prompt 中的描述会消失。不得只凭设置存在就记节省，也不能禁整个 Agent 工具替代必要协作。[官方 subagent 说明](https://code.claude.com/docs/en/sub-agents#disable-specific-subagents)

以上均不是更改共享配置的授权或验收。Lead、HOME、认证、权限模式、原 allowed-tools、managed policy 不变；后续控制探针在受支持的 529 载体执行，逐项证明生效后才写最终 role-v1 清单。

## 传递依赖核对（2026-09-26 UTC）

只保留角色 frontmatter 中的五个名字并不够。以下是对本机实际命令/技能正文的只读核对；它们是保留义务和测量检查项，不是已经加载的证明。

| 入口 | 正文依赖 | profile 处理约束 |
|---|---|---|
| design 的 `brainstorm` | `~/.claude/commands/brainstorm.md:230` 起，产品/UI 任务会使用 `problem-definition`、`competitive-analysis`、`scoping-cutting`，并条件引用 `conducting-user-interviews`、`positioning-messaging`、`evaluating-trade-offs` | `tpl_code` 也可承载 UI/产品工程任务，不能把所有 PM 技能按“非工程”统一排除。未安装的引用单列既有缺项，不能假装已经保留可调用能力。 |
| design / QA 的 `research`、design 的 `write-plan` | user commands 转交 `workflow:research` / `workflow:write-plan`；正文在 `~/.claude/skills/workflow/`，research 调 `Explore` 和 `general-purpose` 子代理 | 旧探针有 command 名，却没有 `workflow:*` 的 advertised 项。必须区分入口、正文文件和实际 Skill 可调用身份，保留资产及必要子代理，再在真实角色验证。 |
| implement 的 `implement` | `~/.claude/commands/implement.md:152` 的 `pr-review-toolkit:review-pr`，安全敏感修改的 `everything-claude-code:security-review`，以及 `simplify` 和 Codex 评审 | 静态快照里 pr-review-toolkit 已安装但 user settings 为 false；这不是本次删减所致，也不能把 false 当 required closure 已满足。真实启动需核其他层是否启用或有合同允许的现存替代。 |
| `codex-design-review` / `codex-code-review` | 两份 command 都从 `openai-codex/codex/*/scripts/codex-companion.mjs` 及其 `lib/` 调用 companion | 必留完整脚本依赖；不能只保留 command 描述。这里没有执行命令中提及的升级/发布操作。 |
| `everything-claude-code` 选定副本 | 当前 plugin.json 的 agents 是逐文件数组，skills/commands 是目录；hooks 指向 `hooks/hooks.json`，多个 hook 引用 `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/` | compiler 不能只删目录却留下悬空 manifest agent 引用。选定副本必须保留 namespace、被选组件、hooks 和完整 scripts/lib 资产，排除运行时 `.in_use`；当前尚未生成或加载副本。 |

优先级仍为当前 pinned 角色和动态 mandate；以上旧命令中与本节点冲突的 merge、ship、全仓测试或额外审批，不进入本单执行动作，也不能借它们扩大角色权限。
