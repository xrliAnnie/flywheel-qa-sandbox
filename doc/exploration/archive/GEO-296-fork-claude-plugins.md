# Exploration: Fork claude-plugins-official — GEO-296

**Issue**: GEO-296 ([Infra] Fork claude-plugins-official — 保持 upstream 同步的 thin fork 策略)
**Date**: 2026-03-28
**Status**: Complete

## 问题

Claude Code Discord plugin (`anthropics/claude-plugins-official`) 的 `server.ts:803` 硬编码 `if (msg.author.bot) return`，导致所有 bot 消息被丢弃。Lead 间通过 Discord core channel 通信不可用（如 Simba @Peter → Peter 收不到）。

GEO-276 E2E 验证中发现此限制。

## 目标

用最小改动 fork 该 plugin，支持 bot-to-bot 消息（通过 allowBots 配置），同时保持能持续吸收 upstream 更新，且本地更新流程尽量自动化。

## 决策记录

### 1. Fork 策略：Thin Fork（一个 commit）

- Fork `anthropics/claude-plugins-official` → `xrliAnnie/claude-plugins-official`
- 只在 upstream/main 上加 **一个 commit**：`server.ts` 的 `if (msg.author.bot) return` → 检查 `allowBots` allowlist
- Upstream 更新时通过 rebase 保持同步
- 一个 commit = rebase 几乎不会冲突（改动集中在 server.ts 的一个 if 分支）

### 2. Upstream 同步：GitHub Actions Cron

**选择**: GitHub Actions cron（每日自动 rebase）

| 方案 | 结论 |
|------|------|
| 手动检查 | ❌ 容易忘记 |
| **GitHub Actions cron** | ✅ 选择。每日 fetch + rebase，零人工 |
| GitHub Watch + 手动 | ❌ 仍需人工 |
| Dependabot-style | ❌ 过度复杂 |

Cron 流程：
1. `git fetch upstream`
2. `git rebase upstream/main`（一个 commit，冲突概率极低）
3. 如果 `external_plugins/discord/` 有变化 → 发 Discord webhook 通知

### 3. 本地 Plugin 管理：手动覆盖 Cache（方案 B2）

**核心约束**: 不能简单地把 marketplace 源改指向 fork，因为：
- 方案 A（改 marketplace 源）：所有 plugin 都走 fork，不干净
- 方案 B1（独立 marketplace）：需要改 `marketplace.json` 的 `"name"` 字段，而该文件有 119 个 plugin 条目、频繁更新，每次 rebase 都会冲突
- **方案 B2（手动覆盖 cache）**：✅ 选择。不碰 marketplace 系统，真正保持一个 commit thin fork

Plugin 安装机制调研结果：
```
known_marketplaces.json  → 定义 marketplace 源 (GitHub repo)
       ↓ (git clone/pull)
~/.claude/plugins/marketplaces/claude-plugins-official/  → 本地 repo 副本 + MCP server 运行目录
       ↓ (按 plugin 名 copy)
~/.claude/plugins/cache/claude-plugins-official/discord/0.0.4/  → 安装元数据缓存
```

> **实施修正**: MCP server 实际从 marketplace 目录运行（`bun --cwd ~/.claude/plugins/marketplaces/.../discord`），不是 cache 目录。更新脚本需同时覆盖两处。详见 plan addendum。

**策略**:
- 其他 plugin（linear, playwright, context7…）→ 正常走官方 marketplace，自动更新
- 只有 Discord → 从 fork repo 手动覆盖到 marketplace + cache 目录
- 更新脚本：`~/.flywheel/bin/update-discord-plugin.sh`

### 4. 自动化更新通知：GitHub Actions → Discord Webhook → Simba

完整链路：
```
GitHub Actions Cron (每日 rebase)
  → 检测 external_plugins/discord/ 有变化
  → Discord Webhook → core channel / cos-lead-control
  → Simba 收到通知
  → 自动跑 update-discord-plugin.sh
  → 报告 Annie："已更新，Lead 需重启生效"
```

**鸡生蛋问题**: Simba 收 webhook 通知的前提是 Discord plugin 已支持 bot/webhook 消息。所以：
- **首次部署**: 必须手动（fork → 改 server.ts → 手动覆盖 cache → 重启 Lead）
- **之后的更新**: 全自动

**热更新限制**: 更新脚本只替换文件，正在运行的 Lead 的 MCP server 已加载旧代码。更新后需重启 Lead 才生效。

### 5. 退出策略

以下任一条件满足时可退出：
- Anthropic 官方 Discord plugin 支持 `allowBots` 或类似配置
- Lead 通信方案改为不依赖 Discord bot-to-bot 消息

退出操作：删 fork repo → 恢复官方 plugin → 移除 cron + 更新脚本

### 6. 冲突处理

- Rebase 冲突（极小概率）：CI 发通知，人工解决
- Anthropic 自己加了 bot filtering 逻辑：评估是否兼容，可能直接切回 upstream

## 组件总览

| 组件 | 描述 |
|------|------|
| Fork repo | `xrliAnnie/claude-plugins-official`，upstream + 1 commit |
| GitHub Actions | 每日 cron rebase + Discord webhook 通知 |
| 更新脚本 | `~/.flywheel/bin/update-discord-plugin.sh` |
| Simba agent.md | 收到通知 → 跑脚本 → 报告 Annie |
| access.json | 各 Lead 的 allowBots 配置 |

## 与 GEO-297 的关系

- GEO-296（本 issue）：Fork 策略 + 基础设施（repo, CI, 更新脚本）
- GEO-297：Bot allowlist 实现（server.ts 代码改动 + access.json 配置 + E2E 验证）

GEO-296 可独立完成（fork + CI + 脚本），GEO-297 依赖 GEO-296 的 fork repo。
