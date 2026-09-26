# FLY-2778 收尾恢复 — 实施记录
Issue: FLY-2778 (https://linear.app/geoforge3d/issue/FLY-2778/收尾清理失效-ship-之后-worktree-没被删thread-没归档land-收尾-issue-closeout-incomplete)
日期: 2026-09-26
基于: plan.md

## 当前依赖边界

- 当前 `origin/main` 为 `fdd1b404d`。FLY-2919 尚未合入；远端头 `a84a07854` 的进度明确写着 A 组未完成、B–F 未实施、当前头未全绿。因此本单不把整条 WIP 分支当作已发布的共同生命 provider，也不复制第二套死亡判定。
- FLY-2754 远端头 `3f89b8a76` 尚未完成实现审查。本单只按已批准计划逐项重取其受信来源凭证设计，并重新做当前头红绿；不整分支 cherry-pick。

## C1：stock cleanup 的零信号删除原语

根因：`WorktreeManager.removeCleanWorktreeByPath` 在任何 `git worktree remove` 前都无条件调用 `reapPath`。该调用最终可向目录内进程发送 SIGTERM/SIGKILL，不满足存量清理“任意 CWD 进程都拒绝、绝不发信号”的边界。

本批新增显式 `processHandling: "refuse"`：在既有 repo lock 内执行只读 CWD census；目录内进程、无法解析的 CWD 或 census 异常全部拒绝；拒绝模式不调用 reaper、不允许 branch 删除，只执行无 `--force` 的 `git worktree remove`。默认路径仍保持原先 reap-first 行为。

### 红绿与选择

- RED：`WorktreeManager.reap.test.ts` 新增 5 个边界后为 3 fail / 4 pass（随后补入 branch 与 malformed-CWD 负控）；失败显示旧实现仍调用 reaper 并删除目录。
- GREEN：同一具体文件 9/9 pass。
- 保留的明确匹配：`WorktreeManager.test.ts` 58/58；`WorktreeManager.reap.e2e.test.ts` 1 pass / 8 platform-skipped；`test-worktree-removal-contract.test.sh` 7/7；FLY-2211 `kill-path-inventory.test.ts` 5/5。
- `vitest related src/WorktreeManager.ts src/__tests__/WorktreeManager.reap.test.ts --run` 意外展开到 30+ Blueprint/WorktreeManager 文件；已见部分均绿，但运行随后长时间无输出，手动终止且没有最终摘要，因此不计通过。最终验证必须使用受限配置重跑相关集合。
- `git grep -lF -- 'removeCleanWorktreeByPath'` 的可执行消费者为三个 edge-worker 文件、两个 teamlead 文件及 `scripts/qa-fly2616-closeout-replay.mjs`；其余命中均为历史/设计/报告文档，排除为非可执行测试。`WorktreeManager.ts` path/basename/parent 的宽匹配中保留 removal contract 与 kill-path inventory；其余文档、数据快照、无关 Blueprint/配置测试不因仅含路径文字而纳入本批显式集合。

### 构建

- `pnpm install --frozen-lockfile` 成功；首次测试因依赖 `dist` 缺失只算 preflight，不算 RED。
- `pnpm --filter "flywheel-edge-worker..." build` 在实现后成功。
