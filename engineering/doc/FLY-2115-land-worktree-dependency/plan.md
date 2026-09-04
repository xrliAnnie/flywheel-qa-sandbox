# FLY-2115 land 授权脱离临时 worktree — 实施计划
Issue: FLY-2115 (https://linear.app/geoforge3d/issue/FLY-2115/病根-ship-收尾删掉-worktree而-land-的授权核验正需要它merge-已成功但-run-永不收敛-2)
日期: 2026-09-03
基于: research.md

## 目标

让 engine land 的 founder-review 核验使用可跨 ship cleanup 存活的 canonical repository + 冻结 head，同时保留现有逐 blob digest 和 founder attribution 校验；把核验失败变成有原始原因日志的 fail-closed held，而不是耗尽默认重试预算后无声搁浅。

## 锁定范围

允许修改：

- `packages/teamlead/src/bridge/founder-review-authority.ts`
- `packages/teamlead/src/bridge/land-retry-policy.ts`
- 对应 `packages/teamlead/src/bridge/__tests__/*.test.ts`
- `engineering/doc/FLY-2115-land-worktree-dependency/`
- `engineering/doc/milestones/FLY-2115.md`，且必须是 PR 前最后一个 commit

明确不改：

- `post-ship-finalization.ts`
- `close-runner.ts`
- gate / claim / approval / authority 写路径
- `approve_to_ship` 判定
- nested repository land 能力

## 实施步骤

1. 在新 founder-review authority 测试中搭真实主仓、linked worktree、StateStore、CommDB、review card/response 和 exact-head binding。先删除 worktree，运行测试并确认当前代码以 `founder_review_authority_unavailable` 失败。
2. 在 `evaluateWorkflowFounderReviewPrecondition` 内，为 `__main__` binding 解析 canonical project root；用 canonical root + `exactHeadAuthority.authorityHead` 调用现有 resolver。保留 binding root 作为 worktree 尚存时的兼容回退。不得改 verdict 语义。
3. 将裸 catch 改为捕获 error，输出包含 error 类型、run/project、binding path、尝试 root 的诊断；最终仍只返回稳定的 `founder_review_authority_unavailable`。
4. 运行删除-worktree正例，确认 green；随后添加 founder 明确不通过与 stale artifact 阴性对照，确认都继续 fail-closed。
5. 先把 retry-policy 期望改为 terminal 并确认红；再将 `founder_review_authority_unavailable` 加入 `TERMINAL_REASONS`，断言 land decision 立即 held、retry count 不变、无 next attempt。
6. 做两类本地变异阳照并还原逐字节：中和 canonical-root 选择时删除-worktree正例红；中和非通过 verdict guard 时阴性对照红。
7. 运行目标测试、teamlead 全套、`pnpm lint`、`pnpm -r build`、`pnpm test:packages:run`，以及每个 `scripts/__tests__/*.test.sh`。检查 inbox 后提交代码。
8. 通过 `codex:rescue` 做代码 review，按 finding 修复并为每轮重新注册 review gate，直到 `reviewVerdict=APPROVED`。
9. 创建 `engineering/doc/milestones/FLY-2115.md` 作为字面最后 commit，push、开 PR，核 exact-head CI，并以 `complete --route needs_review --pr <number>` 交给 DAG。

## 验收矩阵

| 场景 | 预期 |
|---|---|
| founder pass + HTML 与冻结 head 一致 + worktree 已删 + canonical root 可读 | eligible=true；land 可继续收敛 |
| founder 明确 revisions requested，同一删除形状 | eligible=false / `founder_review_not_passed` |
| review 后 HTML blob 改变 | eligible=false / `founder_review_stale_artifact` |
| response 来源不可信或格式非法 | 继续由现有 resolver 判 not_passed，不放行 |
| canonical root 与 binding root 都不可读 | eligible=false / unavailable；日志含 error 类型与两个路径 |
| unavailable 进入 retry policy | terminal → held；不增加 retry count，不再排 next attempt；现有 alert/resume 路径接管 |
| 非 `__main__` binding | 路径选择保持现状 |

## 风险与守卫

- 风险：canonical checkout 不在 reviewed head。守卫：只用 `git ls-tree <冻结 head>`，不读取 working tree。
- 风险：registry root 指错仓。守卫：现有 resolver 要求 root 是 Git top-level、冻结 commit 存在、HTML blob digest 与 review round 一致；否则 fail-closed。
- 风险：fallback 变成绕过。守卫：fallback 只是换 repository object source，两条路径执行完全相同的 verdict resolver。
- 风险：terminal 误伤短暂错误。判断：该 reason 是本地 authority 读取失败，不是外部 founder 等待；现有 audited resume 能在修复后显式恢复，优于盲重试并最终同样 held。

## 完成证据

- 红→绿测试输出和两类变异红证据。
- full-repo 四类 gate 输出。
- code review 的 question id、structured verdict 与 finding 处置。
- PR URL、exact head、CI 结论。
- milestone 为分支最后 commit，工作树 clean。
