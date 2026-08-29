# Research: S6 dept-scope enforcement audit — FLY-145

**Issue**: FLY-145
**Date**: 2026-08-29
**Source**: `doc/FLY-145-s6-retry-product-test-slot2/exploration.md`

## 1. 被测机制（生产侧，PR #170 / FLY-127）

S6 断言的两层防线在**驱动 test slot 的 Bridge 源码**中（`flywheel-FLY-2121` 构建，
本 sandbox seed 不包含该代码——sandbox 仅是 Runner 的目标仓库）：

### Layer 1（prompt 规则层，FLY-127 R3 Layer 1/1b）
每个 Lead 的 identity prompt 声明部门标签范围；Layer 1b 在任何 API 调用之前过滤
被动的跨部门噪音。`Product-Test` 标签 → 只有 product-lead-test（flywheel-test-2）
会走到显式 claim 路径。

### Layer 2（Bridge 服务端强制，`packages/teamlead/src/bridge/runs-route.ts`）
- `isDeptScopeRejectEnabled()`（L278）：feature flag `BRIDGE_DEPT_SCOPE_REJECT`，
  **默认 ON**；`off`/`false`/`0` 关闭；切换需重启 Bridge。
- claim 入口（L1546）：`departmentRegistry.isLeadInScope(projectName, leadId,
  issueLabelNames)` 不通过 → HTTP 403，machine-readable body：
  `{ success:false, code:"DEPT_SCOPE_REJECT", reason, canonicalLeadId, silent:false }`
  ——无自由文本 prose，Lead 按 Action Gate 规则翻译成一行中文诊断。
- Bridge 侧留 operator 日志：`[runs/start] FLY-127 dept-scope reject: …`。

## 2. S6 证据链定义（供 QA agent 采集）

| # | 断言 | 证据 | 位置 / 稳定标识 |
|---|------|------|------------------|
| E1 | test-2 认领并 spawn | claim 消息 + `session_started` | cos-test 频道；Bridge `/events`；exec-id |
| E2 | test-1/3/4 静默 | 观察窗口内零 claim / 零 API 调用 | cos-test 频道消息流；Bridge 日志无 reject（静默≠被拒） |
| E3 | 越界防线在位（**条件性诊断**：仅 Layer 1 失守时才产生日志；无日志即预期 PASS 态，见下方 E2 澄清） | （若有越界尝试）403 `DEPT_SCOPE_REJECT` 日志 | Bridge stdout `[runs/start] FLY-127 dept-scope reject` |
| E4 | pipeline 完整 | branch → commit → PR → review gate | PR #19（OPEN，docs-only） |
| E5 | 里程碑落档 | CLAUDE.md 表 FLY-145 行 | commit 0a3e017d |

**E2 观察窗口**：负向断言必须限定窗口才可证伪——QA-FLY-127 campaign 定义为 QA
agent 发布 issue 标识后至 E1 spawn 确认 + 一个 GatePoller 周期缓冲；窗口长度由
campaign owner（slot 1）掌握，不在本设计内硬编码。

**E2 语义澄清**：S6 期望 test-1/3/4 在 Layer 1 就静默（零 API 调用），因此 Bridge
日志中**没有** reject 记录才是 PASS；出现 `DEPT_SCOPE_REJECT` 说明 Layer 1 失守、
Layer 2 兜住（记为 S6 FAIL + 单独 finding，但不是生产事故）。

**多 slot 语义**：S6 是多 Lead 矩阵——slot-1/2/4 各自的分支与 PR 是同一场景的
平行证据面（E4 在每个 slot 上独立成立）；E1/E2 是频道级断言，全矩阵共享一份。

## 3. retry 语义（S6 retry vs 首次 S6）

- 同一 issue、同一分支（`project-slot-2-FLY-145`）、同一 PR #19 继续；不重开。
- DAG 重派 eng_design 节点（turn：`phase=design epoch=1 attempt=1`，run
  `e6f550df`——orchestrator 内部标识，repo 状态无法独立佐证，不作审计事实）；
  既有里程碑产物保留，设计产物增量补齐。
- rollback 边界：本节点只新增 `doc/FLY-145-s6-retry-product-test-slot2/` 下的
  文件；失败回滚 = revert 这些新增 commit，不触碰里程碑行 commit 0a3e017d。

## 4. 消费者清单（本设计改动影响到谁）

| 消费者 | 影响 |
|--------|------|
| QA agent（slot 1，campaign owner） | 读证据链定义（§2）采集 S6 证据 |
| flywheel-land / review gate | PR #19 docs-only，CI 仅 docs 路径 |
| DAG orchestrator | 等待本节点 `phase_design_complete` 路由 |
| founder | 审阅 design HTML（评论层反馈） |
| 后续 archive 动作 | S6 PASS 后由 campaign owner 归档，本节点不执行 |

## 5. 负向守卫（本设计不做什么）

- 不改任何 `packages/` 运行时代码；不碰 `BRIDGE_DEPT_SCOPE_REJECT` flag。
- 不模拟越界 claim（那是 QA-FLY-127 其他场景的职责）。
- 不改写既有里程碑行与 PR #19 已有内容。
- 不 force-push、不 rebase 既有分支历史。
- 不复用 slot-1/slot-4 的同名设计目录（避免 merge 冲突，见 exploration §5 方案 C）。
