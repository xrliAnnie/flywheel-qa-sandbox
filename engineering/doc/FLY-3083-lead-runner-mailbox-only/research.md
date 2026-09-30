# FLY-3083 Lead→Runner 消息只走 Mailbox — 调研

Issue: FLY-3083 (https://linear.app/geoforge3d/issue/FLY-3083/规矩机制leadrunner-消息-所有-lead-的共用规矩还在教日常聊天用-sendmessage5-月-fly-142-的旧版和-7)
日期: 2026-09-29
基于: exploration.md

本文档 = 代码库审计事实 + hook 协议核实,全部一手验证(读源码 / 本机工具 schema / 官方文档),供 plan.md 直接引用。

## 1. Claude Code PreToolUse hook 协议(官方文档 code.claude.com/docs/en/hooks + 本机 SendMessage schema)

| 项 | 事实 | 来源 |
|---|---|---|
| `tool_name` | 恰为 `"SendMessage"`;settings 里 `matcher: "SendMessage"` 精确匹配 | tools-reference / hooks Matcher 段 |
| `tool_input` | `{ to: string(必填), message: string \| 协议对象, summary?: string, notify_when_idle?: boolean }` | 本机加载的 SendMessage 工具 schema(`required: ["to","message"]`)。注:文档里 PreToolUse 示例只画了 `message`,子代理据此误报「没有 `to`」;以本机 schema 为准 |
| stdin 字段 | `session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id, permission_mode`;agent team 场景另有 `agent_id, agent_type` | hooks 参考 + agent-teams 文档 |
| deny | stdout JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` + exit 0;reason 原文展示给模型 | hooks Decision Control(与 `flywheel-restart-guard.py:deny()` 现行做法一致) |
| `updatedInput` | 支持改写同一工具的输入并 `allow`;**不能换成别的工具** | hooks Input Rewriting |
| 作用域 | `~/.claude/settings.json` 的 PreToolUse 对本会话与 agent-team 队友的调用都生效 | agent-teams 文档 |

结论:deny-only 方案在协议上完全可行,和 FLY-913 同形。

## 2. Runner 的名字与团队成员登记

- `packages/agent-team-transport/src/path-helpers.ts:163` `deriveRunnerMailboxIdentity(execId, leadId)` → `{ agentName: "runner-" + execId.slice(0,8), teamName: leadId }`。这是 Runner 在 Lead 团队里的**唯一**命名来源(本 runner 自己的队名 `runner-42afa86c` 印证)。
- 团队文件 `<CLAUDE_CONFIG_DIR>/teams/<leadId>/config.json`,`addMember` 写 `{name, agentId: "<name>@<team>", …}`(`path-helpers.ts:250-283`)。
- 全仓 grep:没有任何 Runner→Runner 或 founder→Runner 的 `SendMessage to:"runner-*"` 用法;Runner 提示词只有「不要 `SendMessage to:"team-lead"`」(`.flywheel/agents/*.md`)。→ 拦 `to` 匹配 `^runner-[0-9a-f]{8}$` 不会误伤任何现有流程。
- `to` 的其他合法值(`team-lead`、`main`、其他 Lead 名、`worker [ref]`)都不匹配该正则 → 放行。

## 3. `flywheel-comm send` 契约(`packages/flywheel-comm/src/commands/send.ts` + `index.ts:runSend`)

- 参数:`--from <leadId>`(必填)`--to <execId 全长>`(必填)`[--db|--project]` `[--json]` + 正文位置参数。DB 解析顺序 `--db` → env `FLYWHEEL_COMM_DB` → `--project`(`resolve-db-path.ts`)。
- 行为:`insertInstruction` → `clearDeclaredState` → 按 `sessions.vendor` 路由唤醒(`none` = 只留底不唤醒,loud stderr)→ 唤醒 ok 才 `markInstructionDelivered`。
- 输出:`--json` → `{"instruction_id": id}`;否则 stdout 一行 id。唤醒失败/跳过只走 stderr(`console.error/warn`),exit 0。`send()` 返回 `Promise<string>`,唯一调用方是 `index.ts:runSend`(测试直接调 `send()`)。
- **`--to` 不接受 `runner-xxxxxxxx` 短名**;Lead 必须给全长 execId。hook 的 deny reason 只能拿到短名,所以要么 hook 自己查 CommDB 解析,要么让 `send --to` 接受短名。见 §7 决策。

Lead 进程 env(`claude-lead.sh`):`FLYWHEEL_COMM_DB`(:434)、`FLYWHEEL_COMM_CLI`(:439,dist/index.js 绝对路径)、`FLYWHEEL_LEAD_ID`(:935)、`FLYWHEEL_ROOT`(:203)均 export → hook 子进程可读。

## 4. 现有 hook 安装/测试模式(FLY-913,可整套复用)

| 文件 | 作用 |
|---|---|
| `scripts/hooks/flywheel-restart-guard.py` | hook 本体:python3 stdlib;judgment 路径 fail-open(stdin 坏 / 非目标工具 → exit 0 无输出);命中 → `deny()` JSON |
| `scripts/hooks/install-restart-guard.sh` | cp 到 `~/.flywheel/bin/` + jq-merge `~/.claude/settings.json` 的 `hooks.PreToolUse`(matcher `Bash`);jq 1.6 输出非空判有效;只删自己的 command、保留兄弟 hook、空组丢弃;mktemp+mv 原子写;`--uninstall` |
| `claude-lead.sh:842-868 install_restart_guard_hook` + `:919-926` | 每次 Lead 启动收敛(所有角色);DRY_RUN 跳过;失败非致命 WARN |
| `scripts/hooks/test-flywheel-restart-guard.py` | 喂 stdin JSON fixture 跑 hook,断言 exit/stdout schema |
| `scripts/hooks/test-restart-guard-install.sh` | jq filter 矩阵 + fake HOME 端到端 install/converge/uninstall/bad-JSON |
| `.github/workflows/ci.yml:241-244` | CI 直接跑上面两条测试(需 jq/python3) |

本单新 hook 只需把 matcher 换成 `SendMessage`、判定换成 `to` 正则,安装/测试骨架逐字复用。

## 5. 需要改写的文本清单(全仓 grep `SendMessage`,只列 Lead→Runner 方向)

| 文件:行 | 现文 | 处理 |
|---|---|---|
| `lead-rules-base/runner-messaging-rules.md` §「Ordinary chat → SendMessage」(:5-16) | 整段推荐 SendMessage | 删,换成「唯一入口 = `flywheel-comm send`」一段 + 「SendMessage 给 runner-* 会被 hook 拦」一句 |
| 同文件 §wake 段(:54-76)wake matrix 首行 `SendMessage / flywheel-comm send` | 并列 | 只留 `flywheel-comm send`(矩阵其余行不动:`respond` 各行是 FLY-369 RC-2 的权威内容,`fly369-patrol-rule.test.ts:92` 断言 `parked/respond/wake/marker` 关键字) |
| 同文件 决策表(:80-86) | 4 行 `SendMessage` | 改 `flywheel-comm send` |
| 同文件 「Sentinel safety net」(:89-95)「switch to SendMessage and try again」 | 兜底教旁路 | 改为「换 `flywheel-comm send`;若 send 报 delivered=false 走 §通道故障」 |
| `stuck-runner-remanage.md:40` | `(SendMessage — see runner-messaging rules)` | `(flywheel-comm send — see runner-messaging rules)` |
| `runner-reengage-rules.md:25` | `(SendMessage / flywheel-comm send)` | `(flywheel-comm send)` |
| `runner-patrol-rules.md:93` | `SendMessage (MCP teammate API) or flywheel-comm send` | `flywheel-comm send`(RC-2 测试 `:67` 用 `/SendMessage\|flywheel-comm send/` 正则,保留 `flywheel-comm send` 即过;`:78-82` 的 commdb 自足性断言不受影响) |
| `claude-lead.sh:1821-1830` 注释 | 「MUST be told to use SendMessage … rather than flywheel-comm send (suppressed by sentinel …)」 | 改为「must be told the ONLY Runner path is flywheel-comm send/respond (FLY-3083); SendMessage to runner-* is denied by the runner-msg-guard hook」。**保留** commdb 回滚分支的条件加载(`lead-rules-bundle.test.ts:214` 断言 `commdb…runner-messaging-rules.md` 共现) |
| `hook-payload.ts:335` | 「via `flywheel-comm send` (NOT SendMessage)」 | 已正确;措辞统一为「the only Lead→Runner path」但保留原句片段(`misroute-render.test.ts:32/48` 逐字断言该句)——**不改**,零风险 |
| `doc/engineer/implementation/v1.27.0-FLY-142-spike-results.md` | 历史 spike 记录 | 不动(历史文档) |

Codex Lead 侧:`lead-rules-bundle.sh:60-66` 按同一份 `runner-messaging-rules.md` 注入 → 文本改一处两端生效,无需额外改动。

## 6. 通道故障可见性(Tadashi 补充)现状与最小改动

- 现状:`send` 的唤醒失败仅 stderr;Lead 在 Bash 工具里能看到 stderr,但 `--json` 消费方(以及未来脚本)拿不到。
- 最小改动:`send()` 返回 `{ instructionId, delivered: boolean, wakeError?: string, skippedReason?: string }`;`runSend` 非 JSON 模式 stdout **仍只打 id**(字节兼容),`--json` 输出增加三个字段;stderr 行不变。
- 本沙箱没有 v2 Mailbox 的 QUEUED 状态查询;真正的投递状态可观测性属 FLY-1547/FLY-3071,本单只保证 `send` 不吞失败 + 规矩/deny reason 明确写「通道故障 → 报 infra + re-manage 阶梯,不换旁路」。

## 7. 短名 → execId 的解析放哪

| 选项 | 说明 | 判定 |
|---|---|---|
| hook 用 python sqlite3 查 `sessions WHERE execution_id LIKE '<8hex>%' AND lead_id=?` | hook 自足 | 拒:第二份 CommDB 读逻辑,且 CommDB 通过 `better-sqlite3` 可能有 WAL/锁细节 |
| **`flywheel-comm send --to` 接受 `runner-<8hex>` 短名**,CommDB 新增 `resolveExecutionId(prefixOrName, leadId?)`,0 或 >1 命中 fail-closed 报错 | 单一真相;hook 的 deny reason 直接把 `to` 原样放进命令 | **采纳** |

## 8. 测试接线事实

- python/shell hook 测试:CI `ci.yml:241-244` 显式列出;新增两条测试加到同一步。
- vitest:根 `pnpm test:packages:run`(`ci.yml:65`);`packages/flywheel-comm` 现有 `src/__tests__/send-mailbox.test.ts` 用 temp `CLAUDE_CONFIG_DIR` + temp CommDB 直接调 `send()`,可扩展断言 `delivered` 字段。
- 规矩文本守卫:`fly369-patrol-rule.test.ts`、`lead-rules-bundle.test.ts` 已在;新增一个 grep-zero 断言「lead-rules-base 里不再出现推荐 `SendMessage` 给 Runner 的句子」(允许唯一一句「…will be denied」)。
- 本机只跑相关测试(Lead 派单红线):`python3 scripts/hooks/test-runner-msg-guard.py`、`bash scripts/hooks/test-runner-msg-guard-install.sh`、`pnpm --filter flywheel-comm test -- send`、`pnpm --filter flywheel-teamlead test -- fly369-patrol-rule lead-rules-bundle`(package 名以 package.json 为准)。

## 9. mmdc

`/opt/homebrew/bin/mmdc` 11.12.0 可用 → founder HTML 的图本地渲染成 SVG 内联。
