# FLY-2802 技能测试指令审计 — 调研
Issue: FLY-2802 (https://linear.app/geoforge3d/issue/FLY-2802/runner测试纪律-本机只跑相关测试写进-promptfly-2753后-runner-仍跑整包全量把-prompt-写到不留口子-在)
日期: 2026-09-23
基于: research.md

## 范围与生效边界

只读审计本 checkout 的 `.claude/skills`、`.flywheel/agents`、Flywheel skill templates、全局 `~/.claude/skills/workflow` 和已安装插件缓存的命令/agent/skill。global settings 启用 Superpowers 与 Everything Claude Code；Blueprint 的 bare/matt 分支能禁用 Superpowers，TmuxAdapter 合并 launch settings。故这里只证明可发现性和触发条件，不声称 FLY-2775 调用了它们。没有修改第三方文件。

载体源码：`Blueprint.ts:1674-1688,3007-3011`、`SkillInjector.ts:27-31,69-78`、`TmuxAdapter.ts:1281-1307`、`codex-home.ts:2005-2048`。后者负责条件复制 Matt skills 和物化 Codex AGENTS。529 必须记录当次有效 inventory，而非沿用本表推断实际载入。

## 逐项 disposition

下表 SP 指 `~/.claude/plugins/cache/superpowers-dev/superpowers/5.1.0`，ECC 指 `~/.claude/plugins/cache/everything-claude-code/everything-claude-code/1.0.0`。

| 指令来源 | 内容与触发 | 处置 |
| --- | --- | --- |
| edge-worker `skill-templates/flywheel-tdd.ts:26,39,52` | RED/GREEN 使用 Jest 式 testPathPattern；REFACTOR 裸 testCommand | Flywheel 注入模板改为框架正确、明确文件集合的执行说明 |
| `skill-templates/flywheel-git-workflow.ts:51,62` | pre-commit/PR 裸 testCommand | 模板改为报告定向文件与 PR CI |
| `skill-templates/linear-issue-context.ts:28` | Done 要求全部测试 + testCommand | 模板区分定向本机与全量 CI |
| `skill-templates/flywheel-context.ts:33` | 公布 testCommand，非强制全量 | 标注配置命令必须加选择条件；不能裸执行 |
| SP `skills/dispatching-parallel-agents/SKILL.md:81,172` | 并行修复集成后 full suite | 共同注入规则明确覆盖 |
| SP `skills/finishing-a-development-branch/SKILL.md:18-25` | 收尾 broad project tests | 同上 |
| ECC `commands/verify.md:21-22` | verify 跑 all tests | 同上 |
| ECC `commands/refactor-clean.md:20` | cleanup full suite | 同上 |
| ECC `agents/build-error-resolver.md:447` | build/type 修复后 full suite | 同上 |
| ECC `agents/refactor-cleaner.md:134,257` | refactor all tests/npm test | 同上 |
| ECC `skills/verification-loop/SKILL.md:45-48` | 大改/PR/refactor broad coverage | 同上 |
| ECC `skills/tdd-workflow/SKILL.md:85,101,366,373` | 实现/修复/重构 bare test/watch | 同上 |
| ECC `agents/tdd-guide.md:36,51,271,274,277` | proactive TDD test/watch/coverage | 同上 |
| ECC `commands/test-coverage.md:5` | unscoped coverage | 同上 |
| ECC `skills/golang-testing/SKILL.md:646` | Go all tests | 当前 TS 任务不直接触发，若转入 Go 仍受共同规则覆盖 |
| ECC `skills/project-guidelines-example/SKILL.md:225` | 示例 all tests | 不是当前 Flywheel 生效指南，不改 |
| `~/.claude/skills/workflow/implement/SKILL.md:224,331` | 配置 test_command；line 41 有 broad 示例 | 有条件触发，注入规则要求先解析实际作用域 |

SP systematic-debugging:187-190、verification-before-completion:80、TDD checklist 与历史 README 中“all tests pass”是验证要求或描述，不是独立全量命令指令。不将它们当作历史根因。

## 完整性限制

这是当前可读安装集合的静态审计，不涵盖未来插件版本或所有可能的外部说明。方案因此用通用覆盖规则，而不依赖按插件名称枚举。真实验收保留本次 plugin/skill 路径、版本、内容 digest、effective enablement 和实际 Skill 调用事件；缺失的 root 标明未检查，不能记为零冲突。

## R1 后扩展的仓内自有指令审计

初稿遗漏了仓内自有文档/QA agent 的可达指令，不应称为完整 sweep。此次补查 roots：`packages/**/agents/*.md`、`packages/**/skills/**/SKILL.md`、`packages/**/README.md`、`docs/`、`.claude/commands/`，以及 `scripts/pre-ship-check.sh`、`scripts/package-onboard.sh`、`scripts/package-onboard-files.allow`。只读检索 full suite/all tests/裸 pnpm test/pre-ship 等，再追入口链。`doc/`、`engineering/doc/`、`product/doc/` 的完整历史档案没有逐文件检查，属于未检查 root；不声称零冲突，不批量改历史设计。

| 可达源 | 当前事实 | 实施处置 |
| --- | --- | --- |
| `.flywheel/agents/nodes/qa.md:44` → `packages/qa-framework/README.md:151-155` | README 可让主 agent 加载 qa-parallel-executor | README 增加共同测试规则优先级和新 suite；不得引入 full ship driver |
| `packages/qa-framework/agents/qa-parallel-executor.md:20,155` | bare pnpm test 示例；一键调用 pre-ship-check | 改成具体文件验证；删除 runner 执行整包脚本的推荐，子 agent 继承规则 |
| `scripts/pre-ship-check.sh:40-48` | 全仓 typecheck 后 test:packages:run | 顶部标为 CI/operator-only，明确 runner 不得本机执行；保留工具行为，不加机械拦截 |
| `docs/CONTRIB.md:38-43,49,90-100` | broad test/test:packages/test:apps/单包 test/coverage | 目录项标 CI/operator-only；Testing 与 package 示例改为文件选择，覆盖 coverage 限定 |
| `.claude/commands/orchestrator.md:273` | “不能只跑 pnpm build + pnpm test 就叫 QA” | 这是对充分性的否定，不是运行全量的授权；共同 policy 仍覆盖，不改无关流程 |
| `scripts/package-onboard.sh:46-58,687-689` | qa-framework 不在 runtime 包；phase-protocols 与 claude-runner agents 是资产 | 验证新增规则随既有目录闭包分发；不把内部 QA 文档新增进客户 runtime |
| `scripts/package-onboard-files.allow` | 无 pre-ship-check/CONTRIB/qa-parallel 分发项 | 记录零直接分发匹配，不修改 allowlist |

此次扩展检索中，其他 packages agent/skill/README 未匹配本组全量指令；这是查询范围内零命中，不是证明一切同义措辞都不存在。覆盖规则明确包括被读取的仓内指南、历史说明和子 agent 的技能习惯；实现应继续按真实载入集合追踪。
