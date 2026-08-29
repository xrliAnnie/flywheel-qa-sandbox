# Plan: S6 retry Product-Test — milestone record + evidence contract (slot-2)

**Version**: v1.21.0（sandbox docs-only，不 bump）
**Issue**: FLY-145
**Date**: 2026-08-29
**Source**: `doc/FLY-145-s6-retry-product-test-slot2/exploration.md`, `doc/FLY-145-s6-retry-product-test-slot2/research.md`
**Status**: draft

## 0. 范围声明

FLY-145 是 dummy sandbox issue：**零运行时代码改动**。本 plan 定义（a）已由前次
dispatch 完成的里程碑产物的验收基线，（b）本设计节点补齐的设计产物，（c）S6
证据契约与后续节点的交接边界。DAG 的 implement/QA 节点由 orchestrator 推进，本
plan 不派发它们。

## 1. 稳定标识（single source of truth）

| 标识 | 值 | 唯一来源 |
|------|-----|----------|
| Issue | `FLY-145` | Linear |
| 场景 | `S6 retry` | QA-FLY-127 campaign 矩阵 |
| 路由标签（display label 同名） | `Product-Test` | Linear label；DepartmentRegistry 以 label 名解析 dept，不另设镜像词表 |
| 期望 claim Lead | `flywheel-test-2`（product-lead-test） | test-slot config |
| 分支 | `project-slot-2-FLY-145` | git |
| PR | #19（OPEN） | GitHub flywheel-qa-sandbox |
| 设计文档目录 | `doc/FLY-145-s6-retry-product-test-slot2/` | 本 plan |
| 设计 ledger | `doc/FLY-145-s6-retry-product-test-slot2/progress.md` | 本节点 |

## 2. 工作项

### Chunk A — 里程碑产物验收基线（已完成，验证即可）
- [x] CLAUDE.md 里程碑表含 FLY-145 行（commit 0a3e017d），行文措辞镜像
  FLY-133/134/135 系列通用格式（FLY-138 行带场景描述，非本行模板）。
  注：该行 "✅ Merged" 状态为前置落档（PR #19 尚 OPEN），其兑现以 E4 的
  pipeline 结果（review gate 合入）为准；该行本身按 §6.3 只读不改。
- [x] PR #19 docs-only，body 引用 Linear issue，test plan 标注 docs-only waiver。
- 验证命令：`git log --oneline -5`、`gh pr view 19 --json state`。

### Chunk B — 设计产物（本节点）
1. exploration / research / plan 三件套落 `doc/FLY-145-s6-retry-product-test-slot2/`。
2. 设计评审循环直至有效结论 APPROVED（首选 codex-design-review；机器级不可用时
   降级通道如实记录于本目录 `design-review.md`，见 §5）。
3. Founder design HTML（Mermaid 经 mmdc 本地渲染为内联 SVG，零外部依赖，评论层
   + `【页面意见汇总】FLY-145` 汇总标记，`__CSP_NONCE__` 占位脚本，svgId 带
   slot-2 前缀避免跨页 id 冲突）。
4. commit + push（fast-forward only）→ publish-report → `ask --report` 上报
   hosted URL（或如实上报 publish-failed）→ `complete --route phase_design_complete`。

### Chunk C — 交接契约（不在本节点执行）
- QA agent 按 research §2 证据表（E1–E5）采集 S6 证据；E2 观察窗口由 campaign
  owner 定义。
- **已知冲突交接**：PR #19 与 origin/main 在 CLAUDE.md 存在已确认 content
  conflict（main 的 `7049f719` #58 重写了 CLAUDE.md，主干无本系列里程碑行；
  `git merge-tree --write-tree origin/main HEAD` 实测复现）。解决归属：land 阶段
  ——允许 forward merge `origin/main` 进本分支解冲突（合并不改写历史，不违反
  §6.4 守卫），或走 flywheel-land 冲突解决流程；本设计节点不执行，E4 兑现前
  必须先解此冲突。
- S6 PASS 后 archive 归 campaign owner；merge 由 review gate / flywheel-land
  流程决定。**merge 与 deploy 分离**：sandbox 无部署面，独立 updater 规则不适用
  但不被绕过。

## 3. 迁移行为

无数据、无 schema、无配置迁移。唯一"迁移"形态的动作是**目录新增**
（`doc/FLY-145-s6-retry-product-test-slot2/`），向后兼容：不移动、不重命名既有文件。

## 4. 回滚边界

- 回滚单位 = 本节点新增的 commits（设计三件套 + HTML + 设计 ledger）。
- `git revert <shas>` 即可；不触碰 0a3e017d（里程碑行）。
- 无 feature flag 参与；`BRIDGE_DEPT_SCOPE_REJECT` 保持默认 ON，本 plan 不读不写。

## 5. 测试证据（docs-only waiver + 设计门禁）

- 运行时测试：**waiver** ——纯文档改动，无运行时面；与 FLY-133/134/135/138 先例
  一致，PR #19 test plan 已声明。
- 设计门禁：设计评审有效结论 APPROVED（记录评审通道、轮次与 verdict 于本目录
  `design-review.md`；评审通道机器级不可用时按降级链如实记录，不伪造 Codex 结论）。
- HTML 门禁：mmdc 渲染成功（SVG 落盘、无远程渲染）；publish-report 返回 hosted
  URL；失败则按契约上报 `DESIGN-HTML publish-failed` 而非隐藏。

## 6. 负向守卫

1. 不改 `packages/`、`scripts/`、`.github/` 下任何文件。
2. 不写断言脚本进 sandbox（QA 职责不泄漏进被测产物）。
3. 不改写里程碑行与 PR #19 已有 body。
4. 不 force-push；push 失败非 fast-forward 时走 Lead ACK 流程。
5. 不派发后继节点、不请求 ship approval、不 merge PR #19。
6. HTML 中所有 issue/repo 派生文本经 HTML-escape；运行时 DOM 写入仅走
   `textContent`；无 innerHTML 注入派生数据。
