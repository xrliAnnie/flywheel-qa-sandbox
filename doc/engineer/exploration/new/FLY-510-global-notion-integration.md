# Exploration: 全局 Notion 集成（Annie 第二大脑）— FLY-510

**Issue**: FLY-510（[infra] 全局 Notion 集成 — 一次配置、所有 agent 零配置读写 Notion）
**Date**: 2026-06-23
**Status**: Complete（brainstorm gate 已过，Tadashi 批准方案 A）

---

## 1. 问题（What）

tidal-echo（Ariel）要给 Annie 搭一个 Notion **第二大脑**：idea 库 + 日记 + 素材，让 agent 在讨论中把成形的想法直接写进 Notion。Annie 的要求是把它做成 **global setup**——**每个 agent 开箱即用、不用自己配**。

受众：tidal-echo + **所有项目的所有 agent**（Lead + Runner）。

## 2. 现状审计（非从零 — 重要）

| 现状 | 证据 | 含义 |
|------|------|------|
| 这台机器已有 Notion integration token | `~/.config/notion/api_key`（51 字符）存在 | 已有可用密钥；token 移进全局 env 是搬运不是重建 |
| 已有本地 command `~/.claude/commands/notion.md` | 带完整 Second Brain DB IDs（Notes/Tasks/Projects/Areas/Resources/Topics/Notebook）+ Notes schema + curl 速查 | 现成的 DB 结构知识可移植；但**仅本地单机、非分发**，runner/其他项目拿不到 |
| 全局 env `~/.flywheel/.env` 已被所有 lead/bridge wrapper 经 `set -a; source; set +a` 载入 | `scripts/flywheel-lead-wrapper.sh:51-56`、`scripts/flywheel-bridge-wrapper.sh:28-31` | 全局 env 是放共享密钥的现成位置 |
| flywheel-skills repo **没有 agy skill** | repo 只有 `founder-html-delivery`/`video-watch`（generic）+ `flywheel-land`（flywheel） | issue 说的「全局 agy skill 一个模式」= **generic skill 分发模式**，precedent 实为 founder-html-delivery / video-watch |
| 全局 skill 分发链路已成熟 | `skills-sync.sh`（launchd 每日 + RunAtLoad）→ `npx skills add xrliAnnie/flywheel-skills --all -g -y` → `~/.agents/skills/` → symlink 到 `~/.claude/skills/` + `~/.codex/skills/`；5 道 CI gate；热加载无需重启 | 新增一个 generic skill 即可零配置触达所有 agent |
| 三个 agent「面」拿密钥的难度不同 | 见下 | 决定能力层方案选型 |

### 三个 agent 面的 env/MCP 触达难度

1. **Claude Lead**（最易）：pane env 是**严格 allowlist**（`claude-lead.sh:983-1075`），但 FLY-143 会扫描最终 `.mcp.json` 的 env 占位符并用 `tmux -e` 自动透传。**注意**：NOTION_TOKEN 既不在 allowlist 也（方案 A 无 MCP）不在任何 `.mcp.json`，所以**不会**被透传进 Lead pane 的 env。
2. **Claude Runner**（中）：MCP 来自 working-dir `.mcp.json` / `EdgeWorker.buildMcpConfig` / inline；env 经 `TmuxAdapter` 的 `-e` 注入，同样不含 NOTION_TOKEN。
3. **Codex companion Lead（Mufasa/Belle）**（最难）：严格 MCP allowlist（write-capable 只许 gateway、full-access 只许 lead_actions），且 app-server spawn env 被 `washActionSecretEnv()` 按 `/TOKEN|SECRET|KEY/i` **洗掉**——NOTION_TOKEN 会被名字匹配洗掉。装 MCP 或靠 env 透传都很别扭。

**关键推论**：无论选哪个能力层，靠「pane env 里有 NOTION_TOKEN」都不可靠（Lead allowlist、Codex secret-wash 都会拦）。**最稳的是让 skill 直接从 `~/.flywheel/.env` 文件读 token**（文件读不受 env allowlist / secret-wash 影响），任何有 Bash + 文件系统的 agent 都能拿到。

## 3. 方案选型（How）

### 能力层 fork

**方案 A（选定）= 全局 skill + curl，token 从 `~/.flywheel/.env` 文件读**
- skill 进 flywheel-skills repo `skills/generic/notion/`，经 skills-sync 分发到所有 agent。
- skill 携带 Second Brain DB IDs/schema（从 `notion.md` 移植）+ 触发词（idea库/日记/素材/写Notion → 用本 skill）+ curl 速查 + 一个 helper 脚本 `notion.sh`（token 解析 + 薄封装常用操作）。
- token 解析顺序：`$NOTION_TOKEN` env → `~/.flywheel/.env` 里的 `NOTION_TOKEN=` → legacy `~/.config/notion/api_key` → 失败时报清晰错误指向 setup。
- **覆盖**：Claude Lead / Claude Runner / Codex companion Lead 全部零新增 wiring（不碰 allowlist、不碰 MCP config、不碰 secret-wash）。

**方案 B（留 phase-2）= skill + 官方 `@notionhq/notion-mcp-server`（stdio）**
- 结构化工具更顺手，但只能覆盖 Claude 面（Lead 的 `~/.claude.json` mcpServers + Runner MCP config），需改 3 处；Codex Lead 仍只能 curl（allowlist + secret-wash 拦 MCP）。
- wiring 重、覆盖不齐，不符合「所有 agent 零配置」的最普适目标。

### 决策

**Tadashi 在 brainstorm gate 拍板：**
1. **能力层 = A**（最普适、所有 agent 零新增 wiring、绕开 Codex allowlist + secret-wash）。MCP（B）留 phase-2 follow-up。
2. **v1 含 Codex companion Lead（Mufasa/Belle）= YES**（A 天然覆盖）。
3. **token 复用现有 integration**（已有 Second Brain schema、不重建）—— Tadashi 去跟 Annie 确认（复用 + token 放全局 env OK 不）；plan 先按「A + 复用 + 全 agent」写，万一她要新建再调（不阻塞）。
4. ⚠️ **安全红线**：token 移进全局 env 那一步，**密钥经 Annie 手**（一条命令、像 kimi）。**Runner 绝不直接 `cp` Annie 的 `~/.config/notion/api_key` 进 `.env`**——由 Annie 执行 / Tadashi 给她命令。

## 4. 预期结果（Expected Outcome）

Annie 一次性建/共享 integration + 一条命令把 NOTION_TOKEN 放进 `~/.flywheel/.env` 之后：任何 agent（任何项目、Lead 或 Runner）在讨论中决定「记个 idea / 写日记 / 存素材」时，**直接写进对应 Notion DB，无需任何 per-agent 配置**。skill 经 skills-sync 当日（或重启时）分发，热加载即生效。

## 5. 待确认（非阻塞，Tadashi 跟 Annie 确认中）

- token：复用现有 integration vs Annie 新建专用（Tadashi 确认中）。
- 产品映射：idea库/日记/素材 → 具体哪些 Notion DB？现有 schema 有 Notes（可作 idea库）/Resources（可作素材）但**无显式「日记」库**。plan 先按 idea→Notes、素材→Resources、日记→待 Annie 给 DB ID，skill 内置 discover/search 兜底（已发非阻塞 ask）。

## 6. 下一步

research（机制细节）→ plan（draft）→ Codex design review → Tadashi 过目 → TDD 实现 + PR。
