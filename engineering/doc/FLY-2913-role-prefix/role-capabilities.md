# FLY-2913 逐角色 keep/remove 清单（role-v1）
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-26
基于: plan.md §二.2、§七；required-capabilities.md；weekly-tool-use.md；evidence/control-ablation.json

代码事实源：`packages/config/src/runner-prefix-profiles.ts`（`RUNNER_PREFIX_PROFILES_V1` / `RUNNER_PREFIX_REQUIRED_SKILLS`，compiler v2）。本文件是 PR 用的原因说明，不是第二份配置。

## 实测决定机制（529 slot 4，CLI 2.1.283，首轮真实 API usage）

同 cwd / 模型 / flags，只改 `--settings`，implement 清单：

| 控制 | 首轮 prompt tokens | 相对基线 | 结论 |
|---|---:|---:|---|
| 基线 | 72,532 / 72,976 | — | SessionStart hook 输出交替 |
| `skillOverrides: off`（47 个非插件技能） | 73,844 | **+0.9～1.3K** | 反而更大，弃用 |
| `user-invocable-only`（同 47 个） | 73,844 / 74,288 | +0.9～1.8K | 弃用 |
| **`name-only`（同 47 个）** | **68,428** | **−4.1～4.5K** | 采用：描述隐藏、名字仍列出、仍可调用 |
| `name-only`（14 个插件技能） | 不变 | 0 | 插件技能不受 skillOverrides 控制，移出清单 |
| `permissions.deny Agent(name)`（31 个） | 诊断不变 | 0 | 不删描述，移出方案 |
| **`claudeMdExcludes`（6 条规则）** | **70,450** | **−2.1～2.5K** | 采用 |
| **name-only + 规则排除** | **65,902** | **−6.6～7.1K（约 9.4%）** | v1 组合 |

`get_context_usage` 的诊断对 skillOverrides 不可靠（把隐藏技能的 token 挪进 “System tools”，并把 name-only 报成总量不变），所以验收以首轮真实 usage 为主，诊断只作辅助。原计划的 “off 移除 + Agent deny” 被实测否定；name-only 在能力上更保守（不删任何技能）。

## 机制与原则

- **技能**：`skillOverrides: {<精确名>: "name-only"}`，只作用于**非插件**技能。技能仍在清单里，按名字仍可调用，只是不再展示描述；这是“描述隐藏”，不是移除。
- **规则**：`claudeMdExcludes: ["<Claude 配置目录>/rules/<文件>"]`（配置目录 = `CLAUDE_CONFIG_DIR` 或 `~/.claude`；managed 规则按官方语义不可排除，本单也不尝试）。
- 清单外的一切（含今后新装的技能/规则）照旧带完整描述或文件加载。
- **永远保留完整描述**：pinned 角色 frontmatter 的 `skills`（编译时并集；无法解析时整组技能描述全保留）以及“合同必需”技能；模块测试保证两者不在清单中。
- **不动**：内置工具（不发 `--tools`）、MCP server、子代理、插件（含 skill arm 插件）、Lead/Codex 配置、共享 `~/.claude` 文件、HOME、认证、模型、权限模式、`--allowed-tools`。
  - 内置工具：已加载部分仅 668～782 token，其余是 deferred 名册；裁剪收益小、缺工具风险高。
  - MCP：xiaohongshu 16 个工具全是 deferred。
  - 子代理（诊断 8.8K）与插件技能（everything-claude-code ~1.3K + 子代理 ~1.1K）：当前 CLI 没有按启动生效的逐项控制；整插件停用实测 −2.3～2.8K，但会带走 implement/review 必需组件（security-review、code-reviewer、planner 等），不采用。已有离线“选定组件插件副本”编译器可作后续单处理，v1 不上线。

## 描述隐藏（name-only）分组与原因

| 分组 | 成员 | 作用角色 | 原因 |
|---|---|---|---|
| 个人工具技能 | codex-image, gemini-image, gemini-video, notion, video-watch, writing-engine, xiaohongshu-learning, deep-research, computer-bootstrap, cleanup, codex-relogin, gws, learn-permissions, loop-codex | 全部 | 媒体/个人助理/账号运维，工程角色合同不含，七天零调用 |
| Lead 专属动作 | create-issue, ship-pr, spin, flywheel-land, setup-discord-lead, setup-flywheel-hooks, orchestrator, retro, peer-review, gemini-code-review, gemini-design-review | 全部 | runner 不 ship、不派单、不建单；评审只走注入路由 |
| PM 战略 | defining-product-vision, dogfooding, prioritizing-roadmap, working-backwards | 全部 | 属 PM 节点 |
| brainstorm 依赖的 PM 技能 | problem-definition, competitive-analysis, scoping-cutting | 除 design 外 | `brainstorm.md:230` 在产品/UI 任务中引用，design 保留完整描述 |
| Harness 自配置 | keybindings-help, update-config, schedule, fewer-permission-prompts, workflow-authoring, init | 全部 | runner 不改 Claude Code 配置 |
| 同步文档技能 | docs, docx, pptx, xlsx, pdf, import-memory, morning, google-workspace, skill-creator | 全部 | 办公类，工程角色不用 |
| 评审者非写作技能 | brainstorm, research, write-plan, implement, mermaid, codex, codex-design-review, codex-code-review, proofshot, chrome-repair, founder-html-delivery, dataviz, run, simplify, compound | review-* | 评审者只判定计划/diff，不写作、不交付 |
| 角色附加 | simplify, code-review（design）；simplify, code-review, codex（qa）；code-review（review-design） | 见列 | 该角色合同无代码自审/Codex CLI 调用 |

## 排除的用户规则与原因

| 规则 | 角色 | 原因 |
|---|---|---|
| video-generation.md, image-generation.md, summarize-toolchain.md, deep-research.md, gemini-cli.md, gog.md | 全部 | 个人工具链说明 |
| codex-multi-account.md, codex-review.md | qa, review-* | 只约束开 PR/写 plan 后的 Codex 评审与切号；QA/评审者不做 |
| html-report-style.md | review-* | 评审只输出结构化 verdict JSON |

## 明确保留完整描述（含低频必需能力）

- 七天实际调用：`claude-api`（五角色各 1 次）、`onboarding`、`codex-code-review`、`codex-design-review`、`codex:rescue`、`codex:codex-cli-runtime`、`superpowers:systematic-debugging`；子代理 `Explore`、`general-purpose`、`Bar-Raiser`、`codex:codex-rescue`、`fork`；Context7、Playwright、Claude-in-Chrome。
- 合同必需（`RUNNER_PREFIX_REQUIRED_SKILLS`）：design — onboarding/brainstorm/research/write-plan/codex-design-review/founder-html-delivery/mermaid/claude-api；implement — onboarding/implement/codex-code-review/codex:rescue/codex:codex-cli-runtime/proofshot/simplify/code-review/security-review/everything-claude-code:security-review/claude-api；qa — onboarding/proofshot/research/chrome-repair/founder-html-delivery/dataviz/claude-api；review-design — claude-api/security-review；review-code — claude-api/code-review/security-review/everything-claude-code:security-review。
- 规则：context7.md、git-workflow.md 五角色全留；项目与 `~/Dev` CLAUDE.md、auto memory、managed 规则不在控制范围。

## 五角色 before/after

见 `evidence/role-prefix-controls.json`（五角色 × 3 组交替配对；首轮真实 usage 为主，诊断为辅；逐项核验 name-only 仍列出且变小、规则消失、必需与未列项不变）及 PR 描述中的表。
