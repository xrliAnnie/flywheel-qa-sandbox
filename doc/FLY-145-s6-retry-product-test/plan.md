# Plan: S6 retry Product-Test — milestone record + evidence contract

**Version**: v1.21.0(sandbox docs-only,不 bump)
**Issue**: FLY-145
**Date**: 2026-08-29
**Source**: `doc/FLY-145-s6-retry-product-test/exploration.md`, `doc/FLY-145-s6-retry-product-test/research.md`
**Status**: draft

## 0. 范围声明

FLY-145 是 dummy sandbox issue:**零运行时代码改动**。本 plan 定义(a)已由前次
dispatch 完成的 implement 产物的验收基线,(b)本设计节点补齐的设计产物,(c)S6
证据契约与后续节点的交接边界。DAG 的 implement/QA 节点由 orchestrator 推进,本
plan 不派发它们。

## 1. 稳定标识(single source of truth)

| 标识 | 值 | 唯一来源 |
|------|-----|----------|
| Issue | `FLY-145` | Linear |
| 场景 | `S6 retry` | QA-FLY-127 campaign 矩阵 |
| 路由标签(display label 同名) | `Product-Test` | Linear label;DepartmentRegistry 以 label 名解析 dept,不另设镜像词表 |
| 期望 claim Lead | `flywheel-test-2`(product-lead-test) | test-slot config |
| 分支 | `project-slot-1-FLY-145` | git |
| PR | #56(OPEN) | GitHub flywheel-qa-sandbox |
| 设计文档目录 | `doc/FLY-145-s6-retry-product-test/` | 本 plan |
| implement ledger(只读) | `doc/qa/FLY-145/progress.md` | 前次 dispatch |
| 设计 ledger | `doc/FLY-145-s6-retry-product-test/progress.md` | 本节点 |

## 2. 工作项

### Chunk A — implement 产物验收基线(已完成,验证即可)
- [x] CLAUDE.md 里程碑表含 FLY-145 行(commit 4108252),格式镜像 FLY-138。
  注:该行 "✅ Merged" 状态为前置落档(PR #56 尚 OPEN),其兑现以 E4 的
  pipeline 结果(review gate 合入)为准;该行本身按 §6.3 只读不改。
- [x] PR #56 docs-only,body 引用 Linear issue,test plan 标注 docs-only waiver。
- 验证命令:`git log --oneline -5`、`gh pr view 56 --json state`。

### Chunk B — 设计产物(本节点)
1. exploration / research / plan 三件套落 `doc/FLY-145-s6-retry-product-test/`。
2. Codex design review 循环直至 APPROVED(见 §5 测试证据)。
3. Founder design HTML(Mermaid 经 mmdc 本地渲染为内联 SVG,零外部依赖,评论层
   + `【页面意见汇总】FLY-145` 汇总标记,`__CSP_NONCE__` 占位脚本)。
4. commit + push(fast-forward only)→ publish-report → `ask --report` 上报
   hosted URL → `complete --route phase_design_complete`。

### Chunk C — 交接契约(不在本节点执行)
- QA agent 按 research §2 证据表(E1–E5)采集 S6 证据;E2 观察窗口由 campaign
  owner 定义。
- S6 PASS 后 archive 归 campaign owner;merge 由 review gate / flywheel-land
  流程决定。**merge 与 deploy 分离**:sandbox 无部署面,独立 updater 规则不适用
  但不被绕过。

## 3. 迁移行为

无数据、无 schema、无配置迁移。唯一"迁移"形态的动作是**目录新增**
(`doc/FLY-145-s6-retry-product-test/`),向后兼容:不移动、不重命名既有文件。

## 4. 回滚边界

- 回滚单位 = 本节点新增的 commits(设计三件套 + HTML + 设计 ledger)。
- `git revert <shas>` 即可;不触碰 4108252(里程碑行)与 46cc7bc(implement
  ledger)。
- 无 feature flag 参与;`BRIDGE_DEPT_SCOPE_REJECT` 保持默认 ON,本 plan 不读不写。

## 5. 测试证据(docs-only waiver + 设计门禁)

- 运行时测试:**waiver** ——纯文档改动,无运行时面;与 FLY-133/134/135/138 先例
  一致,PR #56 test plan 已声明。
- 设计门禁:Codex design review 有效结论 APPROVED(记录轮次与 verdict 于本目录
  `design-review.md`)。
- HTML 门禁:mmdc 渲染成功(SVG 落盘、无远程渲染);publish-report 返回 hosted
  URL;失败则按契约上报 `DESIGN-HTML publish-failed` 而非隐藏。

## 6. 负向守卫

1. 不改 `packages/`、`scripts/`、`.github/` 下任何文件。
2. 不写断言脚本进 sandbox(QA 职责不泄漏进被测产物)。
3. 不改写 implement ledger 与里程碑行。
4. 不 force-push;push 失败非 fast-forward 时走 Lead ACK 流程。
5. 不派发后继节点、不请求 ship approval、不 merge PR #56。
6. HTML 中所有 issue/repo 派生文本经 HTML-escape;运行时 DOM 写入仅走
   `textContent`;无 innerHTML 注入派生数据。
