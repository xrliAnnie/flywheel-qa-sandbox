# FLY-3033 N-to-N 重启探针 — 调研
Issue: FLY-3033 (https://linear.app/geoforge3d/issue/FLY-3033/529-合成单勿派-fly-2920-真房-n-to-n-codex-实现体重启负载演练用)
日期: 2026-09-28
基于: exploration.md

## 1. 仓库与分支事实（实测）

| 事实 | 取法 | 值 |
|---|---|---|
| remote | `git remote get-url origin` | `https://github.com/xrliAnnie/flywheel-qa-sandbox.git` |
| 分支 | `git branch --show-current` | `project-slot-2-FLY-3033` |
| 漂移 | `git rev-list --count origin/main..HEAD` / 反向 | 0 / 0（设计开始时；设计文档提交后领先的只有本目录） |
| hooksPath | `git config --get core.hooksPath` | `/tmp/flywheel-test-slot-2/state/push-guard/worktrees/<hash>/hooks` |
| README 原字节 | `xxd README.md` | `0a 0a` + `FLY-1375 land E2E marker 20260722T023540Z` + `0a`，3 行 / 44 字节 |
| 目标行长度 | `printf '%s\n' 'FLY-2920 N-to-N restart probe' \| wc -c` | 30（含换行）→ 终态 4 行 / 74 字节 |
| 目标行现存 | `git grep -lF -- 'FLY-2920 N-to-N restart probe'` | 0 命中（exit 1） |
| 依赖树 | `ls -d node_modules` | 不存在 |
| 本地运行态目录 | common `info/exclude` | 含 `.flywheel/runs/`、`.flywheel/review-targets/`（评审落账文件不脏树） |

## 2. 流程机制事实（读源码核对，flywheel-FLY-2920 运行时）

- `await-codex-gate code` 校验 `reviewedHeadSha === git rev-parse HEAD`（`packages/flywheel-comm/src/commands/await-codex-gate.ts:243-254`）。⇒ 评审后若再落任何 commit（账本、milestone），批准即失效。**所有写入必须在评审前完成并冻结。**
- `request-review --type design|code` 需要 `--question-id`（先 `gate review_code --no-block` 开门，`request-review.ts:60-76`）；具体参数以实现节点注入的指令为准。Codex 作者族走这条 Bridge 复审通道；Claude 作者族会被 reviewer-inversion 守卫 409。
- `complete` 合法 route：`auto_approve / needs_review / blocked / ship_attempt_failed / no_code / pr_handoff / phase_design_complete`（`complete.ts:65-76`）。实现节点的正常 PR 交卷为 `needs_review --pr <N>`；以注入命令为准。
- `flywheel-comm progress` 每次调用都 path-limited 提交一次 `progress.md`（真实 commit）。⇒ 冻结后必须把账本更新变成 no-op（`prog` 助手）。
- `progress --set-chunk` 在 `chunks: []` 时静默 no-op；本合同只写 `--cursor` 与 `--next`。
- `flywheel-comm` 不在 PATH，一律 `node "$FLYWHEEL_COMM_CLI" …`；exec-id 一律 `$FLYWHEEL_EXEC_ID`，不手抄 UUID。

## 3. 重启 / 负载演练下的失效模式

| 被杀时刻 | 残留状态 | 新体判据 → 动作 |
|---|---|---|
| 追加前 | README 原样 | 行 0 次 → 追加 |
| 追加后、commit 前 | 工作区已有行 | 行 1 次且在末尾 → 不再追加；`git diff --quiet HEAD -- README.md` 为假 → 提交 |
| `git commit` 途中 | 可能留下 `index.lock` / ref 锁 | Task 0 在「持有 TURN + 锁 ≥2 分钟 + 同次 `lsof` 枚举含本 shell 哨兵且无工作区内存活 git 进程」三条同时成立时回收孤儿锁（FLY-3030 R1–R3 已验证的方案） |
| commit 后、push 前 | 本地领先远端 | push 幂等（远端缺或为祖先即推） |
| push 后、开 PR 前 | 远端有分支、无 PR | `gh pr list --state all` 为 0 → 创建；为 1 且 OPEN → 编辑（同标题同正文，无副作用） |
| 冻结（milestone commit）后 | milestone 在 HEAD | `frozen` 为真 → 所有写入 no-op，只做 push 与断言 |
| 评审中 / CI 等待中 | 只读阶段 | 重新推导冻结头后重进同一块 |
| `ask --report` 后、`complete` 前 | 已报告 | 重跑整块会再报一次（内容相同，无害），然后交卷 |

**冻结判据**：本分支是全新分支，milestone `engineering/doc/milestones/FLY-3033.md` 在冻结前**不存在**。
所以不能像 FLY-3030 那样「读不到即 STOP」；改为：`git ls-tree --name-only HEAD -- <MS>`（git 失败 → STOP；空输出 → 未冻结；有输出 → 再读内容，必须包含目标行，否则 STOP）。区分「不存在」与「读取出错」，两者都不会被误判为冻结。

## 4. 本地验证选择（local-test-policy）

- 选中测试集：以完整路径、文件名 `README.md`、目标行字面量检索。目标行只会命中 `README.md` 与本 issue 文档；仓内以 `README.md` 为名的测试均指向别的 README 或临时夹具（FLY-3029 research 已逐项排除 15 处，本分支与其同一 main 基线 `1855f7a1a`），没有测试读取根 README 的探针行。
- 结论：选中集为空，不跑任何本地套件；Task 1 的字节断言即本地证据，全量证据 = PR 精确头 CI（`ci.yml` 在 `pull_request → main` 触发）。
- 不 `pnpm install`：无依赖树，且根 `package.json` 的 `"prepare": "husky"` 会把 `core.hooksPath` 改成 `.husky/_`，覆盖 slot push-guard。

## 5. 回退与迁移

- 无数据库、API、配置、依赖、公开类型变化；无迁移。
- 合并前撤销 = 关闭 PR；合并后撤销 = `git revert <README commit>`。本设计与实现节点都不合并。

## 6. 证据边界

设计节点不操作 driver、不注入故障、不读秘密、不改执行 / activation 身份。窗口缺失不等于进程死亡；FLY-2920 整体 N-to-N 结论由外层 driver 回执证明，README 成功不能代替它。
