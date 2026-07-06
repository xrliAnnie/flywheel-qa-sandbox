# Research: Lead Workspace 统一 — GEO-196

**Issue**: GEO-196
**Date**: 2026-03-20
**Source**: `doc/engineer/exploration/new/GEO-196-lead-workspace-unification.md`

---

## 1. OpenClaw Workspace 机制（深度调查）

### 1.1 Config 结构

`~/.openclaw/openclaw.json` 中的 agent workspace 路径：

```json
{
  "agents": {
    "list": [
      {
        "id": "product-lead",
        "workspace": "/Users/xiaorongli/clawdbot-workspaces/product-lead",
        "model": "anthropic/claude-sonnet-4-6"
      }
    ]
  }
}
```

**修改点**: `agents.list[1].workspace` → `"/Users/xiaorongli/Dev/GeoForge3D/product/.lead/product-lead"`

### 1.2 Workspace 文件加载

| 文件 | 加载时机 | 必需? | 缺失行为 |
|------|---------|-------|---------|
| `AGENTS.md` | 每次 session start | Required | 注入 "missing file" marker |
| `SOUL.md` | 每次 session start | Required | 注入 marker |
| `USER.md` | 每次 session start | Required | 注入 marker |
| `IDENTITY.md` | 每次 session start | Required | 注入 marker |
| `TOOLS.md` | 每次 session start | Required | 注入 marker |
| `HEARTBEAT.md` | heartbeat 触发时 | Optional | 跳过 |
| `MEMORY.md` | 每次 session start | Optional | 跳过 |

大文件截断：`bootstrapMaxChars` 默认 20,000 字符。当前所有文件均远低于此限制（最大 SOUL.md ~5.5KB）。

### 1.3 Session 数据位置

- Sessions 存储在 `~/.openclaw/agents/<agentId>/sessions/`，**不在 workspace 内**
- `openclaw doctor` 输出确认: `Session store (clawd): /Users/xiaorongli/.openclaw/agents/clawd/sessions/sessions.json`
- **结论**: 迁移 workspace 不影响 session 历史

### 1.4 路径变更流程

1. 修改 `~/.openclaw/openclaw.json` 中的 workspace 路径
2. （可选）运行 `openclaw setup --workspace <path>` seed 缺失的默认文件
3. 重启 Gateway: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`
4. 验证: `openclaw doctor`

**不需要 re-onboard。** `workspace-state.json` 中只记录了 `setupCompletedAt`，会在新路径下自动重建。

### 1.5 Runtime 文件（需 gitignore）

| 路径 | 生成者 | 说明 |
|------|--------|------|
| `.openclaw/workspace-state.json` | Gateway | setup 完成标记，自动重建 |
| `sessions/` | Gateway | 理论上可能存在（实际在 `~/.openclaw/agents/` 下） |
| `*.bak.*` | 用户手动 | 旧版备份文件 |

---

## 2. Gateway 重启机制

### 2.1 当前服务配置

```
Label: ai.openclaw.gateway
Type: LaunchAgent (user-level)
Program: /opt/homebrew/opt/node/bin/node
Args: [...]/openclaw/dist/index.js gateway --port 18789
KeepAlive: true
Logs: ~/.openclaw/logs/gateway.{log,err.log}
```

### 2.2 重启命令

```bash
# 优雅重启（kill + auto-restart via KeepAlive）
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway

# 或者完整 stop + start
launchctl bootout gui/$(id -u)/ai.openclaw.gateway
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

### 2.3 Config 热加载

Gateway 从 `~/.openclaw/openclaw.json` 读取配置。**不支持热加载**——修改 config 后必须重启 Gateway。

### 2.4 重启影响

- 当前活跃 sessions（25 entries per doctor）不会丢失——session 数据在 disk 上
- Discord/Telegram 连接会短暂断开然后自动重连
- Flywheel Bridge 通过 HTTP 调用 Gateway，重启期间的请求会失败然后自动重试

---

## 3. GeoForge3D Repo 状态

### 3.1 Git 结构

- **Git root**: `~/Dev/GeoForge3D/`
- **当前分支**: main
- **最新 commit**: `e0461ae` (GCS lifecycle rules for artifact cleanup)
- **Product subdir**: `~/Dev/GeoForge3D/product/` (doc/, Backend/, Frontend/)

### 3.2 现有 .gitignore

```gitignore
# IDE
.idea/ .trae/ .windsurf/

# Agent/tool artifacts
.agent/ .agents/ .playwright-mcp/

# Sensitive files
gcp-sa-key.json

# Generated / temporary
nanobanana-output/ test-results/ test-screenshots/ ...

# Large binary artifacts
product/doc/qa/test-artifacts/
product/doc/designer/assets/
```

**已有 `.agent/` 和 `.agents/` 规则**——这是好兆头，说明 repo 已经有 agent artifact 排除的先例。

### 3.3 Product 子目录

```
product/
├── doc/              ← 产品文档（PRD, 架构, VERSION, 各部门文档）
├── GeoForge3D-Backend/
├── GeoForge3D-Frontend/
└── (无 .gitignore)
```

`product/` 没有自己的 `.gitignore`，所有规则在 repo root。

---

## 4. 跨 Issue 依赖分析

### 4.1 GEO-187 (Lead Agent Behavior Design)

- **Status**: codex-approved plan in `doc/engineer/plan/new/`
- **Workspace 引用**: Tasks 2.2 和 2.3 引用 "OpenClaw workspace `product-lead/SOUL.md`"
- **影响**: GEO-187 使用**相对路径**描述 workspace 文件，不硬编码绝对路径
- **实际情况**: SOUL.md (v1.5.0) 和 TOOLS.md 已经按 GEO-187 规范重写完成
- **结论**: GEO-196 不阻塞也不被 GEO-187 阻塞

### 4.2 GEO-198 (Fix mem0 Memory Layer)

- **Active docs**: `doc/engineer/research/new/GEO-198-*`, `doc/engineer/plan/draft/v1.5.0-GEO-198-*`
- **引用旧路径**: `~/clawdbot-workspaces/product-lead/TOOLS.md`（2 处）
- **影响**: 文档中的路径在迁移后会过时，但不影响代码
- **建议**: GEO-198 实施时使用新路径即可

### 4.3 已归档文档中的旧路径

以下归档文档引用了旧路径（仅供参考，**不需要更新**）：
- `doc/engineer/exploration/archive/GEO-167-*`
- `doc/engineer/plan/archive/v1.0-phase1-lead-mvp.md`
- `doc/engineer/plan/archive/v1.3.0-GEO-167-*`
- `doc/engineer/plan/archive/v0.5-step1-openclaw-bridge.md`
- `doc/engineer/plan/archive/v1.2.0-GEO-163-*`
- `doc/engineer/research/archive/v0.5-openclaw-pivot-codebase-research.md`

归档文档是历史记录，不需要更新路径。

---

## 5. 验证方案

### 5.1 迁移前检查

```bash
# 确认当前 workspace 文件完整
ls ~/clawdbot-workspaces/product-lead/{SOUL,TOOLS,AGENTS,IDENTITY,USER,MEMORY,HEARTBEAT}.md

# 确认 Gateway 健康
openclaw doctor
```

### 5.2 迁移后验证

```bash
# 1. Config 验证
cat ~/.openclaw/openclaw.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d['agents']['list']:
    if a['id']=='product-lead':
        print(f\"product-lead workspace: {a['workspace']}\")
"

# 2. Gateway 健康
openclaw doctor

# 3. 文件可达
ls ~/Dev/GeoForge3D/product/.lead/product-lead/{SOUL,TOOLS,AGENTS,IDENTITY,USER,MEMORY,HEARTBEAT}.md

# 4. Agent session 测试（通过 Discord 发消息或 Bridge hook 触发）
curl -s http://localhost:18789/api/v1/agents | python3 -c "
import json,sys
for a in json.load(sys.stdin).get('agents',[]):
    if a.get('id')=='product-lead':
        print(f\"Agent: {a['id']}, workspace: {a.get('workspace','N/A')}\")
"

# 5. Bridge 连通性
curl -s -H 'Authorization: Bearer $TEAMLEAD_API_TOKEN' http://localhost:9876/health
```

### 5.3 端到端验证

向 Discord Product Chat channel 发一条测试消息（如 "GEO-196 workspace migration test"），确认 Lead agent 正常响应。

---

## 6. 实施步骤（技术细节）

### Step 1: 创建目标目录

```bash
mkdir -p ~/Dev/GeoForge3D/product/.lead/product-lead
```

### Step 2: 复制 workspace 文件

```bash
cp ~/clawdbot-workspaces/product-lead/{SOUL,TOOLS,AGENTS,IDENTITY,USER,MEMORY,HEARTBEAT}.md \
   ~/Dev/GeoForge3D/product/.lead/product-lead/
```

不复制: `.openclaw/`, `*.bak.*`

### Step 3: 更新 .gitignore

在 `~/Dev/GeoForge3D/.gitignore` 添加：

```gitignore
# OpenClaw agent runtime data
product/.lead/*/.openclaw/
product/.lead/*/sessions/
product/.lead/*/*.bak.*
```

### Step 4: 修改 OpenClaw config

```bash
# 使用 python3 安全修改 JSON
python3 -c "
import json
with open('$HOME/.openclaw/openclaw.json') as f:
    config = json.load(f)
for agent in config['agents']['list']:
    if agent['id'] == 'product-lead':
        agent['workspace'] = '$HOME/Dev/GeoForge3D/product/.lead/product-lead'
with open('$HOME/.openclaw/openclaw.json', 'w') as f:
    json.dump(config, f, indent=2)
print('Updated product-lead workspace path')
"
```

### Step 5: 重启 Gateway

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
sleep 2
openclaw doctor
```

### Step 6: Git commit (在 GeoForge3D repo)

```bash
cd ~/Dev/GeoForge3D
git checkout -b feat/GEO-196-lead-workspace
git add product/.lead/product-lead/
git add .gitignore
git commit -m "feat: migrate product-lead workspace into product repo (GEO-196)"
```

### Step 7: 验证 + 清理

运行 5.2 和 5.3 的验证步骤。成功后：

```bash
rm -rf ~/clawdbot-workspaces/product-lead
```

---

## 7. 风险评估

| 风险 | 严重度 | 缓解措施 |
|------|--------|---------|
| Gateway 重启期间 Discord 通知丢失 | Low | 重启只需 2-3 秒，KeepAlive 自动恢复 |
| 旧 workspace 删除后发现遗漏文件 | Low | 迁移前做 diff 确认文件完整 |
| Git tracked 的 MEMORY.md 产生频繁小 commit | Low | Agent 更新 MEMORY.md 不自动 commit，需要手动 add |
| GEO-198 plan 中的旧路径引用 | Info | 实施 GEO-198 时使用新路径，不需要额外更新 |

---

## 8. 结论

GEO-196 是一个低风险、高收益的 infra 变更：

- **技术上简单**: 7 个文件复制 + 1 个 JSON 修改 + 1 行 gitignore
- **Session 安全**: 迁移不影响对话历史
- **无代码变更**: Flywheel 和 Bridge 不需要任何代码修改
- **即时收益**: Lead agent 的 cwd 变为 `product/`，天然看到产品代码和文档
- **可逆**: 如果出问题，改回 config 路径 + restart Gateway 即可恢复
