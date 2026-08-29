# Research: 全局 Notion 集成机制 — FLY-510

**Issue**: FLY-510
**Date**: 2026-06-23
**Source**: `doc/engineer/exploration/new/FLY-510-global-notion-integration.md`

---

## 1. Token 投递机制（核心难点 + 解法）

### 难点：pane env 里放 token 不可靠

- **Claude Lead**：pane env 是严格 allowlist（`packages/teamlead/scripts/claude-lead.sh:983-1075`）。FLY-143 只对「最终 `.mcp.json` 里 env 占位符引用到的变量」做 `tmux -e` 透传（`claude-lead.sh:1064-1077` 的 `list_required_envs` 扫描）。方案 A 无 MCP，故 NOTION_TOKEN 不会进 Lead pane env。
- **Claude Runner**：`TmuxAdapter` 用显式 `-e` 注入一组固定变量（`packages/claude-runner/src/TmuxAdapter.ts`），不含 NOTION_TOKEN。
- **Codex companion Lead（Mufasa/Belle）**：`washActionSecretEnv()`（`packages/teamlead/src/lead-backends/codex/secret-broker.ts:35-54`）按 `/TOKEN|SECRET|KEY/i` 洗 app-server spawn env——`NOTION_TOKEN` 命中 `TOKEN` 被洗掉。

### 解法：skill 直接读 `~/.flywheel/.env` 文件

文件读不受 env allowlist / secret-wash 影响。任何有 Bash + 文件系统访问的 agent（Lead/Runner/Codex 都满足，HOME 一致）都能读到。这才是「所有 agent 零配置」的最普适投递方式。

### Token 解析算法（helper `notion.sh` 内）

```
resolve_token():
  1. 若 env $NOTION_TOKEN 非空 → 用它（为 phase-2 MCP / 显式 export 的 session 留口）
  2. 否则解析 ~/.flywheel/.env 中 NOTION_TOKEN= 行（grep 最后一条，去掉首尾引号/空白）
  3. 否则 legacy fallback: ~/.config/notion/api_key（现有本地文件，cat 取首行）
  4. 否则 → 报清晰错误，指向 setup 命令并退出非零（fail-closed，绝不静默）
```

- 解析 `.env` 行用 `grep -E '^[[:space:]]*NOTION_TOKEN=' | tail -1`，再 `sed` 去掉 `NOTION_TOKEN=` 前缀与可能的 `"`/`'`。不 `source` 整个文件（避免对任意 env 文件做副作用执行）。

## 2. Notion API 调用（从 `~/.claude/commands/notion.md` 移植）

- 鉴权头：`Authorization: Bearer <token>`，`Notion-Version: 2022-06-28`，`Content-Type: application/json`。
- helper `notion.sh` 子命令（薄封装，避免 agent 手搓易错 JSON）：
  - `notion.sh check`：`GET /v1/users/me` —— 验证 token + 列出 integration（preflight，setup 后自检用，像 kimi 的 auth 探针）。
  - `notion.sh search "<query>"`：`POST /v1/search`（找页面/库）。
  - `notion.sh databases`：`POST /v1/search` filter `object=database` —— **discover 兜底**：列出 integration 能访问的所有库（解决「日记/素材是哪个库」未定时的 fallback）。
  - `notion.sh query <db_id> [filter_json]`：`POST /v1/databases/<id>/query`。
  - `notion.sh new-note "<title>" [body]`：在 Notes 库（idea库）建页。
  - `notion.sh append <page_id> "<text>"`：`PATCH /v1/blocks/<id>/children` 追加段落（日记 append 用）。
  - `notion.sh raw <METHOD> <path> [json]`：逃生口，原样转发到 Notion API。
- 所有写操作 fail-closed：非 2xx 时打印 Notion 返回的 error body + 退出非零（符合项目「显式处理失败路径」非可协商项）。

## 3. Second Brain DB IDs / schema（移植 + 待确认）

现有 `notion.md` 的已知库（Annie 的单一 Second Brain workspace）：

| 库 | ID | FLY-510 用途映射（plan 暂定） |
|----|-----|------|
| Notes | `f9def38f-...` | **idea库**（Status: Inbox/Draft/Final；Topics relation） |
| Resources | `159bd098-...` | **素材**（暂定） |
| Tasks / Projects / Areas / Topics / Notebook | 见 notion.md | 参考/relation |
| 日记 / daily journal | **未知** | 待 Annie 给 DB ID；未给则用 `databases` discover |

→ 已发非阻塞 ask 给 Tadashi 让 Annie 确认。skill 内置 `databases` discover，映射未定也能用（agent 自己找库），Annie 给了 ID 再补进 skill 的速查表。

## 4. 分发链路（skills-sync）

- skill 进 flywheel-skills repo `skills/generic/notion/`（generic tier：任何 session 都可能用，非仅 Flywheel 编排）。
- 走该 repo 的 PR + `scripts/skill-guard.sh` 5 道门 CI，merge 到 main。
- `skills-sync.sh`（launchd 每日 + RunAtLoad）`npx skills add xrliAnnie/flywheel-skills --all -g -y` → `~/.agents/skills/notion/` → symlink 到 `~/.claude/skills/notion/` + `~/.codex/skills/notion/`。
- Claude Code 启动扫 `~/.claude/skills/`，运行中 session 热加载（无需重启）。

### 5 道门对照（skill 必须满足）

1. frontmatter：`name: notion`（kebab-case ✅，== 目录名）、`description` ≤350 字符。
2. 触发词 guard：description **不得**含 `always use|any task|every task|all requests|use this first`。
3. shellcheck 零豁免：`scripts/notion.sh` 必须 shellcheck 干净。
4. blocklist：`notion` 不在 blocklist.txt（已确认 ✅）。
5. founder-html-delivery contract fixture：不碰该 skill 即不受影响。

## 5. 命名与现有 local command 的关系

- 现有 `~/.claude/commands/notion.md` 是**本地单机 command**（不分发）。skill 命名 `notion`（slash/Skill 都可触发）会与该 command 在本机共存。
- 决策（plan 定）：新 skill `notion` 作为权威全局版；现有 local command 可保留（不冲突，命令在 `~/.claude/commands/`、skill 在 `~/.claude/skills/`，不同命名空间）或后续由 Annie 自行删除。**本 issue 不动 Annie 本地 command**（scope discipline）。

## 6. 安全（红线）

- **Runner 绝不接触 Annie 的真实密钥**：不 `cat`/`cp`/打印 `~/.config/notion/api_key` 或写真 token 进 `.env`。
- setup「一条命令、像 kimi」由 Annie/Tadashi 执行，密钥经 Annie 手：
  - 提供 `notion.sh setup`（或独立 `setup-notion.sh`）：接受 token 作参数（经 Annie 手），先 `check` 验证（GET /v1/users/me），通过后 upsert `NOTION_TOKEN=` 进 `~/.flywheel/.env`（替换已有行，避免重复），全程不回显 token。
- token 是 internal integration token，仅能访问 Annie **显式 share 的库/页**——这是天然的爆炸半径收口（integration 拿不到没 share 的内容）。

## 7. Phase-2（deferred，不在本 issue）

- 官方 `@notionhq/notion-mcp-server`（stdio，读 token env）给结构化工具，覆盖 Claude Lead（`~/.claude.json` mcpServers，FLY-143 自动透传 token）+ Claude Runner（`EdgeWorker.buildMcpConfig` + `TmuxAdapter` 注入）。Codex Lead 因 allowlist + secret-wash 仍走 curl。→ 独立 follow-up issue。

## 8. TDD 思路（helper 可测）

- 用 bats / 纯 shell 测试 `notion.sh`，把 curl 抽成可注入的函数（`NOTION_CURL` 环境钩子或 `--dry-run` 打印将发的请求），**不打真网络、不碰真 token**：
  - token 解析：env 优先 / `.env` 解析（含引号、含空格、多行取最后一条）/ legacy fallback / 全缺失 fail-closed。
  - 子命令 → 正确的 METHOD + URL + headers + body（dry-run 断言）。
  - 缺 token 时退出非零 + 错误信息指向 setup。
- shellcheck 作为门禁（CI 门③）。
- SKILL.md 由 frontmatter lint（门①②）+ 一个本地 contract 断言（描述含触发词、body 含 setup 命令 + token 解析顺序）守护。
