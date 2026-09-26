# FLY-2901 接管失败自动重建 — 探索
Issue: FLY-2901 (https://linear.app/geoforge3d/issue/FLY-2901/codex接管-替身接管工作目录失败worktree-takeover-failed-worktree-not-found)
日期: 2026-09-25
基于: 无（上游证据：FLY-2893 普查分支 `origin/flywheel-FLY-2893` 的 `engineering/doc/FLY-2893-codex-failure-census/`）

## 1. 问题一句话

DAG 工作流里，后一阶段的执行体（「替身」，例如 implement / QA，或额度撞墙后换上来的新体）要**原地接管**共享的 branch-B 工作目录；
只要目录不干净、HEAD 不是期望值、或目录本身坏了，`Blueprint` 就 fail-closed 返回 `worktree_takeover_failed`，
随后 admission 回滚、run 被打成 held（`unlaunched_admission_rolled_back`），**一直等到 Lead 手工 stash / push、补 `sessions.worktree_path`、再 hold resume**。

## 2. 证据（FLY-2893 普查，14 天窗口，只读冻结数据）

K6「worktree 接管失败」：Codex 40 次（30 张单、浪费 137.8 单×节点小时，其中等人手 133.3 h），Claude 5 次（12.3 h）。
普查报告的根因句：「前任死前在共享 branch-B worktree 里留了未提交的改动……21/40 次前任死于额度墙」。

我把 45 条 K6 明细按失败原文再拆了一遍（`incidents.csv` 的 `reason_excerpt`，按 `clean=` / `head=` / `expected=` 前缀比对）：

| 形状 | 次数 | 节点 |
|---|---|---|
| clean=false，head == 期望 | 34 | implement 29 · qa 3 · eng_design 2 |
| clean=false，head ≠ 期望（分叉或落后） | 9 | implement |
| clean=false，head=?（取不到 HEAD） | 1 | implement |
| clean=true，head=? | 1 | implement |

结论：
- **绝大多数（34/45）只是「脏」**：HEAD 正确，只多了未提交改动。只要能无损存档这些改动，就能直接接管。
- 9 次同时 head 不符，这就是 FLY-2463（rework base 不再是现 head 的祖先）的形状。
- 2 次目录层面坏了（HEAD 读不到），对应 issue 里的「worktree 已被删」。

现场抽样：今天机器上仍在的 `~/Dev/flywheel-FLY-*` 目录中，脏的内容全部是**真实工作**（未提交的 doc、代码改动、HTML 报告、mermaid 源），不是运行时产物。
所以「直接 `git clean` 掉」绝对不行，必须先保全。

## 3. 现状代码路径

- `packages/edge-worker/src/Blueprint.ts` ~L1399–1560：`takeover` 判定（`shareParentBranch` + 角色 + `startPoint` + 目录已登记）→
  `assertCleanTree` + `captureBaseline` + `isAncestorOf(startPoint, head)` → 任一不过就返回 `failureKind: "worktree_takeover_failed"`。
- 目录**未登记**时不走 takeover，走老路 `removeIfExists` + `create(startPoint)`。注意这条老路对「未登记但磁盘上还有目录」会直接 `rm -rf`，
  对本地分支会 `branch -D`——如果本地分支上有没推的提交，也会一起丢（见 §5 风险）。
- `packages/edge-worker/src/WorktreeManager.ts` `quarantineAndRebuild()`（FLY-1707，只服务 `workflowResume`）：
  已经实现了「用临时 index 把工作区状态做成提交、不碰真实 index 与工作区 → 写 `refs/flywheel/quarantine/<run>/<admission>` → 删目录 → 在锚点重建」。
  这是本单最重要的可复用件，但它：只写本地 ref、不推远端；遇到嵌套仓（目录型未跟踪项）直接 `unsupported_file_type` 拒绝；重建一律删目录再建。
- `packages/teamlead/src/bridge/head-authority.ts`：唯一可信 head = `sessions.worktree_path` 处的 `git rev-parse HEAD`；
  `worktree_path` 为空抛 `worktree_not_found`。这就是 issue 标题里的第二个错误词。
- `GitResultChecker.assertCleanTree` 用 `git status --porcelain`，只忽略 `.gitignore` / `info/exclude`（Blueprint 会先把 `.flywheel/runs/` 写进 exclude）。

## 4. 失败分类（issue 列的五类 + 证据映射）

| 类 | 判据 | 证据里的形状 | 丢工作风险 |
|---|---|---|---|
| A 未提交改动 | `status --porcelain` 非空，且没有嵌套仓 | clean=false, head==期望（34） | 高：直接清理即丢 |
| B 嵌套仓 | 未跟踪项里有目录本身是 git 仓（FLY-2122 评审 checkout） | 混在 A 里，原文分不出 | 中：嵌套仓自己可能有未推内容 |
| C head 不是期望 | HEAD 既不等于 `startPoint`，也不是它的后代 | clean=false, head≠期望（9） | 高：本地可能有未推提交 |
| D 目录已删 / 坏 | 已登记但目录不存在或 `rev-parse HEAD` 失败 | head=?（2） | 低（目录内容已没），但本地分支上的提交仍可能丢 |
| E 路径未登记 | 前任 `sessions.worktree_path` 为空 → `worktree_not_found`；或目录在但 git 不认 | 普查里记在别的类（派发前就失败） | 中：老路会 `rm -rf` 孤儿目录 |

## 5. 已看到的风险 / 约束

1. **活体抢写**：FLY-2572 / FLY-2814 说明「被判死的体」可能还在写。自动存档 + 清理必须建立在「前任已停（停驻或被证明死亡）」之上，
   并且存档前后两次采样工作区指纹必须一致，否则停手。
2. **不能碰分支 head**：替身之后要 complete / 过评审 / QA 要测评审过的那个 head。自动处置**不能在分支上加提交**（包括把证据写进受控的 progress.md 再提交），
   否则 QA 测的 head 与评审绑定的 head 不一致。证据要放在 git 看不见的位置 + 事件里。
3. **远端是唯一离机保全**：普查建议「救援引用必须推送到远端，不能只留在本地」。推送失败 = 保全不成立 = 停手。
4. **停驻体的 cwd**：FLY-887 刻意不删目录（删了会把停驻体的 cwd 从脚下抽走）。能原地清理就原地清理，只有目录本身坏了才重建。
5. **共享 stash 栈**：真实 `git stash` 在所有 worktree 间共享、别的会话可能并发 pop。用带名字的 ref 装「stash 式提交」，不用 stash 栈。

## 6. 本单不做

- 不修前任为什么会死（额度墙 = FLY-2521 等）。
- 不改 FLY-1707 `workflowResume` 的语义（只抽共用的存档函数）。
- 不做真 Codex 替身演练（等 Codex 服务恢复，另起验证）。
