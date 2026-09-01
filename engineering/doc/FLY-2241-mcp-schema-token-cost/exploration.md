# FLY-2241 MCP 工具 schema 的 token 开销 — 探索

Issue: FLY-2241 (https://linear.app/geoforge3d/issue/FLY-2241/成本测量-量一次工具-schema-到底吃掉多少-token-静态可测不需要先建计量体系)
日期: 2026-09-01
基于: 无

## 1. 问题

Uber Engineering《Running a Software Factory Efficiently at Uber Scale》(2026-08-28) 实测:
1000+ MCP 工具的 schema 吃掉 **50–70K token**,每个请求都带着;某第三方 SaaS 一个 server
塞 49 个工具 = ~22K token。

这笔开销是**静态的** —— 工具定义是固定 JSON,不需要先建计量体系就能量。

要回答的:**Flywheel 有没有 50–70K 这个量级的浪费?**

## 2. 关键前置假设(issue 自己提出的)

Claude Code 有 deferred tools / `ToolSearch` 惰性加载;Codex 有 `tool_search`。
所以第一步不是去实现惰性加载,而是查**我们的会话到底有没有在用它**。

⇒ 如果已经在用,这一单量完就收,那也是有价值的结论(排除一个假设)。

## 3. 会话类型盘点(代码 + 在飞进程实测)

| 会话类型 | 启动方 | MCP 来源 |
|---|---|---|
| Claude Lead | `packages/teamlead/scripts/claude-lead.sh` | `~/.flywheel/lead-workspace/<lead>/.mcp.json`(由 `lib/mcp-inherit.sh` 合成:user-scope + terminal + inbox + gbrain) |
| Claude Runner | cmux/tmux 起 `claude`,无 `--mcp-config` | 继承 `~/.claude.json` 顶层 mcpServers + 已启用 plugin 自带的 MCP + claude-in-chrome |
| Codex Lead | `run-codex-*-tui.sh`,隔离 `CODEX_HOME` | `~/.codex-<lead>/config.toml` 的 `[mcp_servers.*]` |
| Codex exec runner | `codex-with-fallback exec`,账号 profile home | `~/.codex*/config.toml` |

实测各 Lead workspace 的 `.mcp.json`(14 个 Lead):除 anna(外部隔离,空)外
**13 个 Lead 挂的是同一套 5 个 server**:`flywheel-inbox, flywheel-terminal, gbrain,
linear-api, xiaohongshu-mcp`。

Codex 生产 Lead(`.codex-infra-bot` / `.codex-mufasa`)只有 **1 个** server:`lead_actions`。

Runner(本会话进程实测 `ps -o command=`)启动参数带
`--settings {"enabledPlugins":{"serena":false,"superpowers":false,"discord@flywheel-plugins":false,"discord@claude-plugins-official":false}}`
—— 即 serena(26 工具)等已被显式关掉。

## 4. 惰性加载现状(直接证据,非推断)

1. `~/.claude/settings.json` 的 `env` 段带 `"ENABLE_TOOL_SEARCH": "true"`。
   Lead 与 Runner 都走 `CLAUDE_CONFIG_DIR:-${HOME}/.claude`(`claude-lead.sh:966,1157`),
   生产上没有隔离 config dir ⇒ 两者都读到这条。
2. `claude --debug api` 日志直接打印:
   `[ToolSearch:optimistic] mode=tst, ENABLE_TOOL_SEARCH=true, result=true`
   以及 `Dynamic tool loading: 0/N deferred tools included`。
3. 在飞 Lead 会话 transcript:`~/.claude/projects/-Users-xiaorongli--flywheel-lead-workspace-*/*.jsonl`
   中有 **107 个文件**含真实的 `"name":"ToolSearch"` tool_use ⇒ 生产 Lead 确实在惰性拉 schema。
4. Codex 侧:`.codex-mufasa` 生产 rollout 里有真实的 `tool_search_call` / `tool_search_output`
   条目(2026-08-02 / 08-03 / 08-15),且系统提示含
   "An installed app's MCP tools are either provided to you already, or can be lazy-loaded
   through the `tool_search` tool"。codex 0.152.0 二进制含 feature flag
   `tool_search` / `tool_search_always_defer_mcp_tools` / `deferred_tool_world_state`。

⇒ **两个 vendor 的生产会话都已在用惰性加载。** 本单因此从「要不要做惰性加载」变成
「量一下现状,并量出万一惰性加载失效会有多贵」。

## 5. 测量方法选型

要求验收给「具体数字,不是估算」。三条路:

| 方案 | 判定 |
|---|---|
| 用 tokenizer 本地数 | ❌ Claude 的 tokenizer 不公开;`@anthropic-ai/tokenizer` 是 Claude 2 时代的,对 Claude 5 不准 ⇒ 只能得到估算 |
| Anthropic `/v1/messages/count_tokens` | ❌ 本机无 `ANTHROPIC_API_KEY`(订阅制) |
| **差分实测**:同一 prompt/cwd 跑两臂,读 API 回报的 `usage` | ✅ 厂商精确、可复跑、无需 tokenizer |

选**差分实测**。总输入 token = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`。

某 server 的 schema 成本 = `该臂(惰性关) − 基线臂(惰性关)`。
惰性加载下的实际成本 = `该臂(惰性开) − 基线臂(惰性开)`(此时付的是「工具名清单」而非 schema)。

坑(实测踩到并修正):`ENABLE_TOOL_SEARCH=false` 直接 export **无效** ——
`~/.claude/settings.json` 的 `env` 段优先级高于进程环境变量,会把它盖回 true。
必须用 `--settings '{"env":{"ENABLE_TOOL_SEARCH":"false"}}'` 注入,并用 debug 日志的
`ENABLE_TOOL_SEARCH=..., result=...` 行**逐臂回读确认**臂真的切换了。

## 6. 边界

- 本单**只测量 + 给建议**,不改任何运行行为(founder 边界)。
- 不碰模型选择;Uber 那条「subagent 降级到便宜模型」不在范围。
