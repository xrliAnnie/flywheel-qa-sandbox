# Research: Fork Sync & Plugin Cache Strategy — GEO-296

**Issue**: GEO-296
**Date**: 2026-03-28
**Source**: `doc/exploration/new/GEO-296-fork-claude-plugins.md`

## 1. GitHub Actions Auto-Rebase Workflow

### 推荐方案：自定义 Workflow

评估了 marketplace actions（`imba-tjd/rebase-upstream-action`, `aormsby/Fork-Sync-With-Upstream-action`），维护不积极且需求简单，推荐自定义 ~30 行 shell 脚本。

### Workflow YAML

```yaml
# .github/workflows/sync-upstream.yml
name: Sync Upstream

on:
  schedule:
    - cron: '0 8 * * *'   # 每日 08:00 UTC
  workflow_dispatch:        # 手动触发

permissions:
  contents: write
  issues: write

jobs:
  rebase:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: ${{ secrets.GITHUB_TOKEN }}

      - name: Configure git
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

      - name: Fetch upstream
        run: |
          git remote add upstream https://github.com/anthropics/claude-plugins-official.git
          git fetch upstream main

      - name: Check for new commits
        id: check
        run: |
          BEHIND=$(git rev-list HEAD..upstream/main --count)
          echo "behind=$BEHIND" >> "$GITHUB_OUTPUT"

      - name: Rebase
        if: steps.check.outputs.behind != '0'
        id: rebase
        run: |
          if git rebase upstream/main; then
            echo "status=success" >> "$GITHUB_OUTPUT"
          else
            git rebase --abort
            echo "status=conflict" >> "$GITHUB_OUTPUT"
          fi

      - name: Force push
        if: steps.rebase.outputs.status == 'success'
        run: git push origin main --force-with-lease

      - name: Detect discord changes
        if: steps.rebase.outputs.status == 'success'
        id: changes
        run: |
          CHANGED=$(git diff --name-only HEAD~${{ steps.check.outputs.behind }}..HEAD -- external_plugins/discord/ || true)
          if [ -n "$CHANGED" ]; then
            echo "discord_changed=true" >> "$GITHUB_OUTPUT"
            echo "files<<EOF" >> "$GITHUB_OUTPUT"
            echo "$CHANGED" >> "$GITHUB_OUTPUT"
            echo "EOF" >> "$GITHUB_OUTPUT"
          else
            echo "discord_changed=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Discord webhook — plugin updated
        if: steps.changes.outputs.discord_changed == 'true'
        run: |
          curl -H "Content-Type: application/json" -d '{
            "embeds": [{
              "title": "Discord Plugin Updated Upstream",
              "description": "fork rebase 后 external_plugins/discord/ 有变化，需要重新部署。",
              "color": 16750848,
              "footer": {"text": "Flywheel Fork Sync"}
            }]
          }' "${{ secrets.DISCORD_WEBHOOK_URL }}"

      - name: Discord webhook — conflict
        if: steps.rebase.outputs.status == 'conflict'
        run: |
          curl -H "Content-Type: application/json" -d '{
            "embeds": [{
              "title": "Upstream Rebase CONFLICT",
              "description": "Daily rebase 失败，需要手动解决冲突。",
              "color": 16711680,
              "footer": {"text": "Flywheel Fork Sync"}
            }]
          }' "${{ secrets.DISCORD_WEBHOOK_URL }}"

      - name: Create issue on conflict
        if: steps.rebase.outputs.status == 'conflict'
        run: |
          gh issue create \
            --title "Upstream rebase conflict — $(date +%Y-%m-%d)" \
            --body "Manual resolution needed. Our patch: single commit adding allowBots to server.ts." \
            --label "upstream-conflict"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 关键设计

- `fetch-depth: 0`：rebase 需要完整历史
- `--force-with-lease`：比 `--force` 安全，防止并发 push 覆盖
- 冲突时 `rebase --abort` + 创建 issue + Discord 通知，不会 push 损坏状态
- `workflow_dispatch` 允许手动触发测试

## 2. Plugin Cache 行为（关键发现）

### Cache 结构

> **实施修正**: 实际 MCP server 运行目录是 `~/.claude/plugins/marketplaces/.../external_plugins/discord/`，不是 cache。更新脚本需同时覆盖两处。

```
~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/   ← 安装元数据
~/.claude/plugins/marketplaces/.../external_plugins/discord/     ← MCP server 运行目录
├── .claude-plugin/plugin.json    # name, version, keywords
├── .mcp.json                     # MCP server 启动配置
├── server.ts                     # ← 要改的文件
├── package.json
├── bun.lock
├── node_modules/                 # bun install 已跑过
└── skills/
```

### installed_plugins.json 追踪

```json
"discord@claude-plugins-official": [{
  "scope": "user",
  "installPath": "...cache/claude-plugins-official/discord/0.0.4",
  "version": "0.0.4",
  "gitCommitSha": "d56d7b61f061c719514784919fb29712cbd0999d"
}]
```

### 关键风险：Claude Code 可能覆盖手动修改

官方文档明确说明：*cache path 在 plugin 更新时会变，写入的文件不会幸存。*

当 Claude Code 更新 plugin 时：
1. Pull marketplace repo
2. 检查 version 是否变化
3. 如果 version 变了 → 创建新 cache 目录，覆盖旧的
4. 如果 version 没变但 commit SHA 不同 → 行为不确定（已知有 bug）

**这意味着**：我们手动覆盖的 `server.ts` 可能在下次 Claude Code plugin 更新时被官方版本覆盖。

### 应对策略

**方案 1（推荐）：更新脚本 + 禁止自动更新 Discord plugin**

- 更新脚本 `update-discord-plugin.sh` 从 fork pull 最新代码 → 覆盖 cache
- 阻止 Claude Code 自动更新 Discord plugin（避免覆盖）
- 当 fork 的 GitHub Actions 检测到 upstream 变化 → 通知 → 手动跑脚本

**方案 2：每次 Lead 启动前检查并修复**

- `claude-lead.sh` 启动前比对 cache 中的 server.ts 和 fork 版本
- 不同则自动覆盖
- 更自动化，但给启动流程加了依赖

**推荐方案 1** — 简单、可控、不依赖 Lead 启动流程。

### bun install 是否需要重跑

- `server.ts` 是入口文件，不是 npm dependency
- 如果只改 `server.ts`（不加新 import）→ **不需要** `bun install`
- 如果 upstream 更新了 `package.json`（加了新依赖）→ 需要 `bun install`
- 更新脚本应无条件跑 `bun install`（安全起见，耗时很短）

## 3. server.ts Bot Filter 分析

### 精确位置（已确认 line 803）

```typescript
// Line 802-805
client.on('messageCreate', msg => {
  if (msg.author.bot) return    // ← LINE 803: THE FILTER
  handleInbound(msg).catch(e => process.stderr.write(`discord: handleInbound failed: ${e}\n`))
})
```

### 消息处理管线

```
messageCreate event
    │
    ▼ Line 803: if (msg.author.bot) return    ← BOT FILTER
    │
    ▼ handleInbound(msg)
    │
    ▼ gate(msg)                               ← ACCESS CONTROL
    ├── 'drop' → silent return
    ├── 'pair' → pairing code
    └── 'deliver' → continue
    │
    ▼ PERMISSION_REPLY_RE check               ← "yes/no XXXXX" 拦截
    │
    ▼ sendTyping() + ackReaction
    │
    ▼ mcp.notification(...)                   ← 投递到 Claude Code
```

### Access 类型定义（Line 105-121）

```typescript
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  replyToMode?: 'off' | 'first' | 'all'
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}
```

### GEO-297 代码改动预估（~8 行）

```typescript
// 1. Access type 加字段
allowBots?: string[]

// 2. Line 803 改为
if (msg.author.bot) {
  const access = loadAccess()
  if (!access.allowBots?.includes(msg.author.id)) return
}
```

**Whitelist 设计**：只有 `allowBots` 里列出的 bot ID 能通过，不是放行所有 bot。安全。

### gate() 交互注意事项

Bot 消息通过 line 803 后仍需通过 `gate()` 的 access control：
- Guild channel：bot 的消息所在 channel 必须在 `access.groups` 中
- `requireMention: false` 或 bot 消息必须 @mention
- DM：bot 的 user ID 需要在 `allowFrom` 中

**当前 access.json 已配置**：core channel 在各 Lead 的 `access.groups` 中，且 `requireMention: false`。只需加 `allowBots` 字段。

## 4. 更新脚本设计

```bash
#!/bin/bash
# ~/.flywheel/bin/update-discord-plugin.sh
set -euo pipefail

FORK_REPO="https://github.com/xrliAnnie/claude-plugins-official.git"
FORK_DIR="$HOME/.flywheel/repos/claude-plugins-official"
CACHE_DIR="$HOME/.claude/plugins/cache/claude-plugins-official/discord/0.0.4"

# 1. Clone or pull fork
if [ -d "$FORK_DIR" ]; then
  git -C "$FORK_DIR" pull --ff-only
else
  git clone "$FORK_REPO" "$FORK_DIR"
fi

# 2. 覆盖 cache（保留 node_modules）
rsync -a --exclude='node_modules' \
  "$FORK_DIR/external_plugins/discord/" \
  "$CACHE_DIR/"

# 3. 安装依赖（安全起见）
cd "$CACHE_DIR" && bun install --no-summary

echo "Discord plugin updated from fork ($(git -C "$FORK_DIR" rev-parse --short HEAD))"
```

### 版本号硬编码问题

Cache 路径包含版本号 `0.0.4`。如果 upstream 发布新版本（如 `0.0.5`），cache 路径会变。

**解决方案**：脚本自动检测当前版本：
```bash
CACHE_DIR=$(find "$HOME/.claude/plugins/cache/claude-plugins-official/discord" -maxdepth 1 -type d | sort -V | tail -1)
```

## 5. 总结

| 维度 | 结论 |
|------|------|
| Fork 策略 | 一个 commit，每日 cron rebase |
| 本地更新 | 手动脚本覆盖 cache，不碰 marketplace 系统 |
| 自动通知 | GitHub Actions → Discord webhook → Simba |
| Cache 覆盖风险 | 存在，需要阻止 Claude Code 自动更新 Discord plugin 或启动前检查 |
| 代码改动量 | ~8 行（GEO-297），真正的 thin fork |
| 退出复杂度 | 低，删 fork + 恢复官方 plugin |
