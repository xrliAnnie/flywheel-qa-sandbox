# FLY-2913 逐角色 keep/remove 清单（role-v1）
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-26
基于: plan.md §二.2、§七；required-capabilities.md；weekly-tool-use.md

代码事实源：`packages/config/src/runner-prefix-profiles.ts`（`RUNNER_PREFIX_PROFILES_V1` / `RUNNER_PREFIX_REQUIRED_SKILLS`）。本文件是 PR 用的原因说明，不是第二份配置。

## 机制与原则

- **只列移除项**：清单外的一切（含今后新装的技能/agent/规则）照旧加载，不会因“没登记”被静默删掉。
- 三种按启动下发的控制，全部进同一个 `--settings`，排在 skill arm、opt-in、memory、hooks 和 Discord 强制 deny 之前：
  - 技能：`skillOverrides: {<精确名>: "off"}`（CLI 2.1.283 schema 已核：on / name-only / user-invocable-only / off；该键在按键合并集合里，用户已有的 off 项不被覆盖）。
  - 子代理：`permissions.deny: ["Agent(<精确名>)"]`。
  - 规则：`claudeMdExcludes: ["$HOME/.claude/rules/<文件>"]`（绝对路径 glob；managed 规则按官方语义不可排除，本单也不尝试）。
- **永远保留**：pinned 角色 frontmatter 的 `skills`（编译时并入保留集），以及下表“合同必需”技能；模块测试保证两者不在移除清单。
- **不动**：内置工具（不发 `--tools`）、MCP server（不发 strict MCP）、skill arm 插件、Lead/Codex 配置、共享 `~/.claude` 文件、HOME、认证、模型、权限模式、`--allowed-tools`。
  - 内置工具不裁：探针里 System tools 仅 782（已加载部分），其余是 deferred 名册；裁剪收益小、缺工具风险高。
  - MCP 不裁：xiaohongshu 16 个工具全部 deferred（未进已加载前缀）；strict MCP 与插件 MCP 的交互未验证前不引入。

## 预估节省（diagnostic-estimate，待 529 实测）

数据取自 `evidence/t1-context-probe.json` 的逐项 token；**前提是每种控制在当前 CLI 真的把该项移出前缀**，这正是 529 控制测试要证伪/证实的，未证实前不得当交付数。移除项名字与该探针清单 100% 精确匹配（无未匹配项）。

| 角色 | 技能 数/token | 子代理 数/token | 规则 数/token | 合计预估 |
|---|---:|---:|---:|---:|
| design | 60 / 5,442 | 30 / 4,701 | 6 / 1,868 | ~12.0K |
| implement | 61 / 5,334 | 31 / 5,267 | 6 / 1,868 | ~12.5K |
| qa | 64 / 5,733 | 31 / 5,267 | 8 / 3,469 | ~14.5K |
| review-design | 77 / 6,947 | 31 / 5,267 | 9 / 4,340 | ~16.6K |
| review-code | 76 / 6,663 | 31 / 5,267 | 9 / 4,340 | ~16.3K |

探针总量参考：技能 9,133、子代理 8,839、用户规则 5,491（另有项目 CLAUDE.md 等必留项）。

## 移除分组与原因

| 分组 | 成员 | 作用角色 | 原因 |
|---|---|---|---|
| 个人工具技能 | codex-image, gemini-image, gemini-video, notion, video-watch, writing-engine, xiaohongshu-learning, deep-research, computer-bootstrap, cleanup, codex-relogin, gws, learn-permissions, loop-codex | 全部 | 媒体/个人助理/账号运维；工程角色合同不含，七天零调用。codex-relogin 属 infra 救援，runner 不应自行切号/重登。 |
| Lead 专属动作 | create-issue, ship-pr, spin, flywheel-land, setup-discord-lead, setup-flywheel-hooks, orchestrator, retro, peer-review, gemini-code-review, gemini-design-review | 全部 | runner 禁止 ship/派单/建单；评审只走注入的 Codex/Claude 跨家族路由。 |
| PM 战略 | defining-product-vision, dogfooding, prioritizing-roadmap, working-backwards | 全部 | 属 PM 节点（pm.md），工程模板不使用。 |
| brainstorm 依赖的 PM 技能 | problem-definition, competitive-analysis, scoping-cutting | 除 design 外 | `brainstorm.md:230` 对产品/UI 任务引用，design 保留。 |
| Harness 自配置 | keybindings-help, update-config, schedule, fewer-permission-prompts, workflow-authoring, init | 全部 | runner 不改 Claude Code 配置、不建定时任务或工作流。 |
| 同步文档技能 | docs, docx, pptx, xlsx, pdf, import-memory, morning, google-workspace, skill-creator | 全部 | claude.ai 同步的办公类技能，工程角色不用。 |
| 离栈插件技能 | everything-claude-code: go-build/go-review/go-test/golang-patterns/golang-testing/clickhouse-io/postgres-patterns/instinct-export/instinct-import/instinct-status/evolve/skill-create/continuous-learning/continuous-learning-v2 | 全部 | Go/ClickHouse/Postgres 不在本栈（SQLite/TS）；插件自学习不属任务。 |
| 评审者非写作技能 | brainstorm, research, write-plan, implement, mermaid, codex, codex-design-review, codex-code-review, proofshot, chrome-repair, founder-html-delivery, dataviz, run, simplify, compound | review-* | 评审者只判定现有计划/diff，不写作、不交付、不改作者文件。 |
| 角色附加 | simplify, code-review（design）；simplify, code-review, codex（qa）；code-review（review-design） | 见列 | 该角色合同无代码自审/Codex CLI 调用。 |
| Lead / QA slot 子代理 | anna-interviewer-lead, belle-lead, claude-infra-bot-lead, cos-lead, flywheel-cos-lead, flywheel-eng-lead, flywheel-product-lead, flywheel-test-1..4/6, joycon-lead, mufasa-lead, ops-lead, product-lead, rafiki-lead, reflection-lead, sub-lead, tidal-echo-content-lead, tidal-echo-cos-lead | 全部 | Lead 身份永远不是 runner 的子代理。 |
| 离域人格子代理 | Content-Writer, Data-Engineer, Data-Scientist, Mobile-Developer, Orchestrator, Product-Manager, everything-claude-code:go-build-resolver / go-reviewer / database-reviewer | 全部 | 七天 subagent_type 统计零调用且不在本栈。 |
| UX-Designer | UX-Designer | 除 design 外 | design 可能把 UI 稿转规格，保留。 |
| 个人规则 | video-generation.md, image-generation.md, summarize-toolchain.md, deep-research.md, gemini-cli.md, gog.md | 全部 | 个人工具链说明，工程角色不适用。 |
| Codex 作者规则 | codex-multi-account.md, codex-review.md | qa, review-* | 只约束开 PR/写 plan 后触发 Codex 评审、切 Codex 号的作者；QA/评审者不做这些。 |
| HTML 报告规范 | html-report-style.md | review-* | 评审只输出结构化 verdict JSON。 |

## 明确保留（含低频必需能力）

- 七天实际调用：Skill `claude-api`（五角色各 1 次）、`onboarding`、`codex-code-review`、`codex-design-review`、`codex:rescue`、`codex:codex-cli-runtime`、`superpowers:systematic-debugging`；子代理 `Explore`、`general-purpose`、`Bar-Raiser`、`codex:codex-rescue`、`fork`；Context7、Playwright、Claude-in-Chrome 工具。
- 合同必需（`RUNNER_PREFIX_REQUIRED_SKILLS`）：design — onboarding/brainstorm/research/write-plan/codex-design-review/founder-html-delivery/mermaid/claude-api；implement — onboarding/implement/codex-code-review/codex:rescue/codex:codex-cli-runtime/proofshot/simplify/code-review/security-review/everything-claude-code:security-review/claude-api；qa — onboarding/proofshot/research/chrome-repair/founder-html-delivery/dataviz/claude-api；review-design — claude-api/security-review；review-code — claude-api/code-review/security-review/everything-claude-code:security-review。
- 规则：context7.md、git-workflow.md 五角色全留；项目/`~/Dev` CLAUDE.md、auto memory、managed 规则不在控制范围。
- skill arm 与插件：superpowers / matt / codex / context7 / playwright / security-guidance 插件不改；arm 决定的插件开关照旧合并在 profile 之后。
- 工程角色的 everything-claude-code 保留组件：code-reviewer、planner、security-reviewer、tdd-guide、architect、build-error-resolver 等子代理及 tdd/e2e/plan/coding-standards 等技能。

## 待 529 证实（未证实前不宣称节省）

1. `skillOverrides: off` 对 **插件技能**（everything-claude-code:*）和 **claude.ai 同步技能**（docs/docx 等）是否生效；若不生效，这部分预估作废，插件部分转用已实现的离线选定组件副本编译器。
2. `permissions.deny Agent(name)` 是否把子代理描述移出前缀（官方只保证不能调用）；若只挡调用不删描述，子代理这列预估作废。
3. `claudeMdExcludes` 经 `--settings` 下发时是否生效。
4. 每个保留的必需技能真调用成功；被移除技能调用得到 `skillOverrides` 错误；用户原有 off 技能仍为 off。
