# Exploration: CI/CD Pipeline Setup — GEO-175

**Issue**: GEO-175 (CI/CD Pipeline Setup — GitHub Actions + Deploy Gating)
**Date**: 2026-03-16
**Depth**: Standard
**Mode**: Technical
**Status**: final

## 1. 背景

Flywheel 目前没有任何 CI/CD 配置（无 `.github/workflows/`、无 Dockerfile、无部署自动化）。所有构建、测试、部署都是手动完成。需要建立正式的 CI/CD 流程，参考 GeoForge3D 的 testtube/queue 模式。

## 2. 现状

### 可部署组件

| 组件 | 类型 | 部署方式 |
|------|------|----------|
| Teamlead Bridge | Express 服务 (port 9876) | 本地 Mac Mini 运行 |
| 8 个 pnpm 包 | TypeScript 库 | 不需独立部署 |

### 构建工具链

- **Build**: `pnpm build` (tsc, 无 bundling)
- **Test**: `pnpm test` (vitest)
- **Lint**: `pnpm lint` (biome check)
- **Typecheck**: `pnpm typecheck` (tsc --noEmit)
- **Package Manager**: pnpm v10.13.1

### GeoForge3D 参考模型

GeoForge3D 使用 emoji-comment 触发部署（GitHub Actions + GCP Cloud Run）：

- `:test_tube:` → 部署到生产环境，**不 merge**（Testtube 预览模式）
- `:cool:` → 部署到生产环境 + **auto-merge**（Queue 生产模式）
- Push to main → 自动部署（跳过 auto-merge commit）
- 所有模式都要求：测试通过 → 部署成功 → 才能 merge

核心 workflow 文件：
- `ci.yml` — PR/push 触发，build + test + lint
- `deploy-on-comment.yml` — emoji comment 触发：检测变更类型 → 运行测试 → 部署 → 验证 → (auto-merge if `:cool:`)
- `deploy-on-merge.yml` — push to main 后自动部署（跳过 auto-merge commit 防循环）
- `deploy-services.yml` — 可复用的部署逻辑（Docker build → push to Artifact Registry → Cloud Run deploy）

关键设计模式：
- **Change detection**: 根据 PR 文件变化决定是否部署（只改 docs 则跳过）
- **Fail-closed**: 任何失败 → PR 不 merge
- **Reusable workflows**: 核心部署逻辑封装为 `workflow_call`
- **Auto-skip**: `deploy-on-merge` 检测 commit message 含 "Deployed and merged:" 则跳过（防循环）

## 3. Affected Files and Services

| File/Service | Impact | Notes |
|-------------|--------|-------|
| `.github/workflows/ci.yml` | add | CI pipeline — build, test, lint, typecheck |
| `.github/workflows/deploy-on-comment.yml` | add | Emoji-triggered deployment (Phase 2) |
| `.github/workflows/deploy-on-merge.yml` | add | Auto-deploy on push to main (Phase 2) |
| GitHub repo settings | modify | Branch protection rules |
| Mac Mini | configure | Self-hosted runner (Phase 2) |

## 4. Options Comparison

### Option A: 纯 CI 守门（最简单）

- **Core idea**: 只做 CI 检查（build/test/lint/typecheck），不做自动部署。部署仍手动。
- **Pros**: 最简单，快速落地；不需处理 Mac Mini runner 问题；覆盖最高价值场景（防 broken code merge）
- **Cons**: 部署仍手动；没有 testtube/queue 模式
- **Appetite**: Small (1-2h)
- **Affected files**: `.github/workflows/ci.yml`, GitHub branch protection
- **What gets cut**: 自动部署、emoji 触发、进程管理

### Option B: CI + Self-Hosted Runner 部署（推荐）

- **Core idea**: Mac Mini 作为 self-hosted GitHub Actions runner，支持完整 testtube/queue 模式。
- **Pros**: 完整的 testtube/queue，与 GeoForge3D 一致；部署自动化；self-hosted runner 零成本
- **Cons**: 需要配置 self-hosted runner；需要进程管理器（pm2/launchctl）；Runner 安全性
- **Appetite**: Medium (半天)
- **Affected files**: `.github/workflows/{ci,deploy-on-comment,deploy-on-merge}.yml`, runner 配置, 进程管理
- **What gets cut**: Docker 容器化

### Option C: CI + SSH 远程部署

- **Core idea**: 通过 SSH 从 GitHub Actions 部署到 Mac Mini，不用 self-hosted runner。
- **Pros**: 不需安装 runner agent；部署逻辑集中在 workflow
- **Cons**: 需要 SSH 隧道（安全风险 + 维护）；SSH key 管理；网络依赖
- **Appetite**: Medium
- **Affected files**: 同 B + SSH tunnel 配置
- **What gets cut**: 同 B

### Option D: CI + Docker 容器化（长期方向）

- **Core idea**: 容器化 Bridge，部署到云或本地 Docker。
- **Pros**: 最标准的生产部署；可迁移云端
- **Cons**: 需要 Dockerfile + Docker Compose；过度工程化（只有一个服务）
- **Appetite**: Large
- **What gets cut**: 无

### Recommendation: Option B（分两阶段）

**Phase 1**: 先落地 Option A（纯 CI），立即获得测试守门。
**Phase 2**: 加上 self-hosted runner + emoji 部署，实现完整 testtube/queue。

理由：Phase 1 价值密度最高（花 1-2h 就能防住 broken merge），Phase 2 在 Phase 1 基础上增量添加。

## 5. Clarifying Questions

（已在 issue 创建时列出，待 research 阶段深入）

1. **进程管理器选择**: pm2 vs launchctl？
2. **Branch protection**: 要求所有 CI check 通过才能 merge？
3. **部署目标**: 只部署 Bridge？还是也需要重启 OpenClaw Gateway？
4. **Testtube 行为**: 同端口替换 vs 不同端口预览？

## 6. User Decisions

- **Selected approach**: Option B (CI + Self-Hosted Runner)，分 Phase 1 + Phase 2 实施
- **Scope**: 参考 GeoForge3D 的 testtube/queue 模式
- **Remaining questions**: 待 research 阶段决定

## 7. Suggested Next Steps

- [ ] `/research` — 深入研究 GitHub Actions self-hosted runner 配置、pnpm CI 最佳实践、进程管理方案
- [ ] `/write-plan` — 产出实施计划
- [ ] `/implement` — 实施
