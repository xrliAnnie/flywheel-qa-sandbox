# Exploration: Lead Workspace 统一 — GEO-196

**Issue**: GEO-196 (Lead Workspace 统一：OpenClaw workspace 迁入产品 repo)
**Domain**: Infrastructure / DevOps
**Date**: 2026-03-20
**Depth**: Standard
**Mode**: Technical
**Status**: final
**Depends On**: GEO-187 (Lead Agent Behavior Design), GEO-152 (Multi-Lead)

---

## 0. Product Research

Product research skipped (Technical mode)

---

## 1. Affected Files and Services

| File/Service | Impact | Notes |
|-------------|--------|-------|
| `~/.openclaw/openclaw.json` | modify | 修改 product-lead workspace 路径 |
| `~/clawdbot-workspaces/product-lead/` | migrate → delete | 当前 workspace，迁移后清理 |
| `~/Dev/GeoForge3D/product/.lead/product-lead/` | create | 新 workspace 位置 |
| `~/Dev/GeoForge3D/.gitignore` | modify | 添加 `.lead` runtime 排除规则 |
| Flywheel Bridge | none | 不直接引用 workspace 路径，通过 OpenClaw Gateway 通信 |
| OpenClaw Gateway | restart | 需要 reload config 以识别新路径 |

### Workspace 文件清单（需迁移）

| 文件 | 类型 | Git Track? | 说明 |
|------|------|-----------|------|
| `SOUL.md` | Required | ✅ | Lead persona + 行为规范 (v1.5.0) |
| `TOOLS.md` | Required | ✅ | Bridge API 手册 |
| `AGENTS.md` | Required | ✅ | Agent startup 指令 |
| `IDENTITY.md` | Required | ✅ | Agent 身份（当前是空模板） |
| `USER.md` | Required | ✅ | 用户信息（当前是空模板） |
| `MEMORY.md` | Optional | ✅ | 持久化记忆（API 状态、项目信息） |
| `HEARTBEAT.md` | Optional | ✅ | 定时检查指令 |
| `.openclaw/` | Runtime | ❌ | `workspace-state.json` — 自动重建 |
| `*.bak.*` | Backup | ❌ | 旧版本备份，不需要 |

---

## 2. Architecture Constraints

### 2.1 OpenClaw Workspace 机制

- **Required files**: AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md（缺失会注入 marker）
- **Optional files**: HEARTBEAT.md, MEMORY.md, memory/, skills/, canvas/
- **Session 数据**: 存在 `~/.openclaw/agents/<agentId>/sessions/`，**不在 workspace 内**
- **路径变更**: 只需修改 `openclaw.json` → `openclaw setup --workspace <path>` seed defaults
- **无位置限制**: workspace 可以在任何位置，包括 git repo 内部
- **Startup 加载**: AGENTS.md, SOUL.md, USER.md 在每次 session start 时自动加载
- **大文件截断**: `bootstrapMaxChars` 默认 20,000 字符

### 2.2 Flywheel 与 Workspace 的关系

- Flywheel **不直接引用** workspace 路径
- 通过 `config.ts` 中的 `defaultLeadAgentId: "product-lead"` 识别 agent
- 通过 OpenClaw Gateway API（`localhost:18789`）与 Lead 通信
- Gateway 从 `openclaw.json` 读取 agent 配置（包括 workspace 路径）

### 2.3 产品 Repo 结构

```
~/Dev/GeoForge3D/                  ← git root
├── .gitignore                     ← 需要添加 .lead 排除规则
├── product/
│   ├── doc/                       ← 产品文档（PRD, 架构, 各部门文档）
│   ├── GeoForge3D-Backend/
│   ├── GeoForge3D-Frontend/
│   └── .lead/                     ← 新 workspace 位置（待创建）
│       └── product-lead/
└── ...
```

### 2.4 关键约束

1. **Session 数据安全**: Sessions 不在 workspace 内，迁移不会丢失对话历史
2. **无需 re-onboard**: 路径变更 + `openclaw setup` 即可，不需要重新配置 agent
3. **Gateway 需要 restart**: 修改 `openclaw.json` 后需要重启 Gateway 服务
4. **Git repo 内可用**: OpenClaw 没有限制 workspace 不能在 git repo 内

---

## 3. External Research

### Industry Practices

1. **Agent workspace colocation pattern** — 业界趋势是将 agent 配置放在代码仓库内（类似 `.github/copilot-instructions.md`），使 agent 天然获得项目 context
2. **Meta-repository pattern** — 独立的 "agent 知识库" repo，agent 可以自主 clone 和导航多 repo 代码库
3. **Git-tracked agent config** — Squad 等工具使用 `decisions.md` 等 markdown 文件作为 team 的 "shared brain"，提供持久性和审计追踪
4. **OpenClaw 官方建议**: workspace 是 "default cwd, not a hard sandbox"，可以在任何位置

### 风险

- 多 agent 共享目录可能导致 auth 和 session history 冲突（OpenClaw 官方警告）
- 需要正确配置 `.gitignore` 排除 runtime 数据

Sources:
- [Agent Workspace - OpenClaw](https://docs.openclaw.ai/concepts/agent-workspace)
- [Multi-Agent Coding Workspace (Augment Code)](https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace)
- [Meta-Repository Pattern](https://seylox.github.io/2026/03/05/blog-agents-meta-repo-pattern.html)

---

## 4. Options Comparison

### Option A: 迁入产品 Repo（`product/.lead/`）

- **Core idea**: 将 workspace 移到 `~/Dev/GeoForge3D/product/.lead/product-lead/`，agent config 文件 git tracked
- **Pros**:
  - Lead 天然看到产品 context（代码、PRD、架构文档在 parent 目录）
  - SOUL.md/TOOLS.md 变更可追溯（git history + PR review）
  - 不需要手动同步 flywheel repo ↔ OpenClaw workspace
  - 多 Lead 支持自然扩展（`.lead/ops-lead/` 等）
- **Cons**:
  - 产品 repo 需要维护 `.gitignore` 规则
  - Lead workspace 文件变更需要在产品 repo commit（额外 git 操作）
  - 如果产品 repo 很大，agent workspace 作为子目录可能在 `git status` 等操作中增加噪音
- **Effort**: Small（~30 分钟手动操作 + 验证）
- **Affected files**: `openclaw.json`, GeoForge3D `.gitignore`, 新建 `.lead/` 目录
- **What gets cut**: Flywheel repo 不再维护 reference copy of SOUL.md/TOOLS.md

### Option B: 迁入 GeoForge3D Root（`.lead/` 在 repo root）

- **Core idea**: 将 workspace 放在 `~/Dev/GeoForge3D/.lead/product-lead/`（repo root 而非 `product/` 子目录）
- **Pros**:
  - Lead 能看到整个 monorepo（product + 其他可能的项目）
  - `.gitignore` 在 repo root 已有，添加规则更自然
  - 如果以后有非 product 的 Lead（如 ops-lead），位置更对称
- **Cons**:
  - Agent 的 cwd 是 repo root，离产品代码稍远（需要 `cd product/` 才能到产品文件）
  - repo root 层级可能有更多无关目录干扰 agent context
- **Effort**: Small（同 Option A）
- **Affected files**: 同 Option A，位置不同

### Option C: Symlink 方案（workspace 保持独立，symlink 到产品 repo）

- **Core idea**: 保持 workspace 在原位，在产品 repo 创建 symlink 指向 workspace
- **Pros**:
  - 最小变更——不需要移动文件或改 OpenClaw config
  - 可以 git track symlink 本身
- **Cons**:
  - Agent 的 cwd 仍然是独立目录，**看不到产品 context**（核心目标未达成）
  - Symlink 在 Windows/跨平台场景有兼容问题
  - 并没有解决根本问题——只是建立了引用
- **Effort**: Tiny
- **What gets cut**: 核心收益（agent 天然看到产品 context）

### Recommendation: Option A（Product 子目录） ← **User Selected**

**Rationale**:
1. Product Lead 服务产品——workspace 应该和产品代码在一起
2. Agent cwd 是 `product/`，`doc/`, `GeoForge3D-Backend/`, `GeoForge3D-Frontend/` 是直接 children，context 更聚焦
3. Lead 的 config 文件（SOUL.md 等）本身就是产品"大脑"的一部分，应该 git tracked
4. 未来非 product agent 可以放在各自合适的位置，不需要强求对称
5. Option C 没有解决核心问题，排除

---

## 5. Clarifying Questions

### Scope

- Q1: `.lead/` 放在哪一层？ `~/Dev/GeoForge3D/.lead/`（repo root）还是 `~/Dev/GeoForge3D/product/.lead/`（product 子目录）？我推荐 repo root。

### Data Model

- Q2: `MEMORY.md` 当前内容很少（API 状态 + 项目信息）。要 git track 还是 `.gitignore`？Git track 的好处是变更可追溯，但如果 agent 频繁更新会产生很多小 commit。

### Integration

- Q3: 迁移后是否需要更新 Flywheel repo 中的任何引用？（当前检查发现 Flywheel 不直接引用 workspace 路径，但 GEO-187 plan 可能有相关假设。）

---

## 6. User Decisions

| Question | Decision |
|----------|----------|
| Q1: `.lead/` 位置 | **Product 子目录** (`~/Dev/GeoForge3D/product/.lead/product-lead/`) — Lead 是产品的一部分 |
| Q2: `MEMORY.md` git track | **Yes** — 所有 agent config 文件 git tracked，只排除 runtime 数据 |
| Q3: Flywheel 引用 | 不需要更新 — Flywheel 通过 agent ID 通信，不引用 workspace 路径 |
| 旧 workspace 清理 | 验证新路径工作后**删除** |

### Selected Approach: Option A (Product 子目录)

```
~/Dev/GeoForge3D/product/
├── doc/
├── GeoForge3D-Backend/
├── GeoForge3D-Frontend/
└── .lead/
    └── product-lead/
        ├── SOUL.md          ← git tracked
        ├── TOOLS.md         ← git tracked
        ├── AGENTS.md        ← git tracked
        ├── IDENTITY.md      ← git tracked
        ├── USER.md          ← git tracked
        ├── MEMORY.md        ← git tracked
        ├── HEARTBEAT.md     ← git tracked
        └── .openclaw/       ← .gitignore (runtime)
```

### .gitignore 规则（添加到 GeoForge3D root `.gitignore`）

```gitignore
# OpenClaw agent runtime data
product/.lead/*/.openclaw/
product/.lead/*/sessions/
product/.lead/*/*.bak.*
```

---

## 7. Suggested Next Steps

- [ ] 基于 Option A 写实施 plan (`/write-plan`)
- [ ] 创建 worktree + branch 执行迁移（在 GeoForge3D repo）
- [ ] 修改 `~/.openclaw/openclaw.json` workspace 路径
- [ ] 重启 OpenClaw Gateway
- [ ] 验证 agent 正常加载 + Discord 通信正常
- [ ] 删除旧 workspace
