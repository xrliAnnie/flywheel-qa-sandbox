# Exploration: Linear 升级后 Team 重组 — GEO-298

**Issue**: GEO-298 (Linear 升级后 Team 重组 — 拆分 Flywheel / GeoForge3D / 新项目)
**Date**: 2026-03-28
**Status**: Draft

---

## 1. 现状分析

### Workspace: geoforge3d (Basic plan)

| Team | Prefix | Projects | Active Issues |
|------|--------|----------|---------------|
| Studio | GEO- | Flywheel, GeoForge3D, Infra | 79 backlog + 14 in-progress + 5 todo |
| Personal | LEARN- | ML/AI Learning, Clawdbot, Claude Code | 独立，不受影响 |

### Issue 分布 (Studio team, backlog only)

| Project | Count | 性质 |
|---------|-------|------|
| GeoForge3D | 46 | 产品开发 — 3D 模型生成、打印、电商 |
| Flywheel | 33 | 基础设施 — AI orchestrator、Lead、Runner |
| No Project | 0 | — |

### Labels (Studio team)

| Label | Count | 备注 |
|-------|-------|------|
| Product | 53 | 过于宽泛，什么都是 Product |
| Operations | 6 | 打印/运营 |
| backend | 4 | |
| Marketing | 3 | |
| backlog | 3 | 与 Linear 状态重复 |
| architecture | 2 | |
| frontend/complex/devops | 各 1 | |

### 关键约束

1. **Issue ID 不可逆**: Linear 移动 issue 到新 team 时，ID 会变（GEO-298 → FLY-1）。所有历史引用失效
2. **Flywheel 代码强依赖 GEO- 前缀**: CLAUDE.md、MEMORY.md、agent files、projects.json、doc 文件名全部包含 GEO-xxx
3. **已完成 issue 数量多**: 大量 Done 的 GEO-xxx issue 被 CLAUDE.md 和 MEMORY.md 引用

---

## 2. 方案对比

### 方案 A: 保持单 Team，用 Project 分组（维持现状 + 优化 Labels）

**做法**:
- Studio team 不拆分，保持 GEO- 前缀
- 继续用 Projects (Flywheel, GeoForge3D, Infra) 区分
- 优化 Labels: 去掉冗余 label (backlog)，加入 domain labels (infra, product-eng, ops, marketing)
- 新项目创建新 Project 而非新 Team

**优点**:
- ✅ 零迁移成本 — 所有 issue ID、代码引用、文档引用不变
- ✅ 跨项目 issue（如 Infra 同时影响 Flywheel 和 GeoForge3D）自然共存
- ✅ 单一 backlog view 方便全局优先级排序

**缺点**:
- ❌ Flywheel 和 GeoForge3D 共享 workflow states、cycle、triage
- ❌ GEO- 前缀对 Flywheel issue 不直观
- ❌ 没有利用 Basic plan 的 unlimited teams 能力

**适用场景**: 一个人做所有项目，不需要团队级别隔离

---

### 方案 B: 拆 Studio → GeoForge3D (GEO-) + Flywheel (FLY-)

**做法**:
- 将 Studio team rename 为 GeoForge3D（保留 GEO- 前缀和所有现有 issue）
- 创建新 Flywheel team (FLY-)
- 迁移 33 个 active Flywheel issue 到 FLY- team
- Done 的 Flywheel issue 留在 GEO- (无法避免的历史遗留)

**优点**:
- ✅ 清晰的 team 边界 — 基础设施 vs 产品
- ✅ 各 team 独立的 workflow、cycle、triage
- ✅ GeoForge3D 保留 GEO- 前缀（自然映射）
- ✅ 新 Flywheel issue 用 FLY-xxx 更直观

**缺点**:
- ❌ **高迁移成本** — 需要更新所有引用
  - Flywheel CLAUDE.md (~100+ GEO-xxx 引用)
  - MEMORY.md (~80+ GEO-xxx 引用)
  - doc/ 下的文件名 (GEO-xxx-slug.md → FLY-xxx-slug.md)
  - GeoForge3D agent files (agent.md, TOOLS.md 中的 issue 引用)
  - projects.json Linear 配置
- ❌ 历史 Done issue 仍在 GEO- 下，形成割裂
- ❌ 迁移后 GEO-xxx → FLY-xxx 映射需要维护
- ❌ Git history 中的 commit message、PR body 永远引用旧 GEO-xxx

**工作量估算**: 高（2-4 小时纯文本替换 + 验证 + 回归测试）

---

### 方案 C: 拆 Team 但不迁移历史 — 新 issue 分流

**做法**:
- 将 Studio rename 为 GeoForge3D (GEO-)
- 创建 Flywheel team (FLY-)
- **不迁移现有 issue** — 所有 GEO-xxx 保持原位
- 从今天起，新的 Flywheel issue 创建在 FLY- team
- 现有 GEO-xxx 的 Flywheel issue 完成后自然归档

**优点**:
- ✅ 零迁移成本 — 不移动任何 issue
- ✅ 不需要更新代码引用（现有 GEO-xxx 引用仍有效）
- ✅ 渐进切换 — 随着旧 issue 完成，自然过渡到 FLY-
- ✅ 新 Flywheel issue 立即享受独立 team 好处

**缺点**:
- ❌ 过渡期 Flywheel issue 分散在两个 team (GEO- 旧 + FLY- 新)
- ❌ 需要在两个 team 查看 Flywheel backlog
- ❌ 过渡期可能持续数月（直到所有旧 GEO- Flywheel issue 完成或手动迁移）

**适用场景**: 想要 team 隔离但不想承受迁移成本的折中方案

---

### 方案 D: 用 Team 做顶层分类 + Initiative 串联

**做法**:
- GeoForge3D team (GEO-) — 产品 + 运营
- Flywheel team (FLY-) — 基础设施
- Infra team (INF-) — 跨项目共享基础设施（可选）
- 用 Linear Initiative 串联跨 team 的大目标（如 "v2.0 Autonomous Dev"）

**优点**:
- ✅ 最彻底的组织分离
- ✅ Initiative 提供跨 team 视图
- ✅ 每个 team 完全独立的 workflow

**缺点**:
- ❌ 迁移成本同方案 B
- ❌ 过度分割 — 目前只有一个人，3 个 team 的管理开销大于收益
- ❌ Infra project 的 issue 很少（当前 1 个），不值得单独 team

---

## 3. 推荐

### 短期推荐: 方案 C（拆 Team + 新 issue 分流，不迁移历史）

理由:
1. **利益最大化**: 新 Flywheel issue 立即用 FLY- 前缀，清晰直观
2. **风险最小化**: 不迁移任何 issue，不需要更新代码引用
3. **渐进过渡**: 随着 backlog 消耗，GEO- 的 Flywheel issue 自然减少
4. **可回退**: 如果体验不好，新 team 删掉就行

### 实施步骤

1. **Rename Studio → GeoForge3D** (保留 GEO- prefix)
2. **Create Flywheel team** (FLY- prefix)
3. **创建 Flywheel project** in FLY- team (迁移 project description)
4. **Optional**: 创建 Infra project in FLY- team
5. **更新 Label 体系**:
   - 清理冗余 labels (backlog)
   - 两个 team 共享核心 labels (Product, Operations, Marketing)
   - 按需添加 team-specific labels
6. **更新 Flywheel 代码** (minimal):
   - CLAUDE.md: 添加说明 "历史 issue 用 GEO-，新 issue 用 FLY-"
   - projects.json: 添加 FLY team 配置
   - agent files: 更新 team key 为 FLY-（对新 issue）
7. **通知 Lead agents**: Peter/Oliver 识别 FLY- 前缀

### 长期（可选）: 批量迁移旧 issue

当旧 GEO-xxx Flywheel issue 减少到 <10 个时，可以一次性迁移并更新所有引用。

---

## 4. 需要 Annie 确认的问题

1. **Team 命名**: Flywheel team 前缀用 `FLY-` 还是其他？
2. **Infra project**: 放在 Flywheel team 下还是 GeoForge3D team 下？还是两边都有？
3. **新项目 team**: 未来的新项目（如 deep-live-cam 相关）创建独立 team 还是放在现有 team 下？
4. **迁移优先级**: 是否现在就迁移部分高活跃的 Flywheel issue（如 GEO-291, GEO-296, GEO-297），还是完全不迁移？
