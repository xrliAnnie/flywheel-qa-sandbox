# FLY-3030 N-to-N Codex 体探针 — 探索
Issue: FLY-3030 (https://linear.app/geoforge3d/issue/FLY-3030/529-合成单勿派-fly-2919-真房-n-to-n-codex-体)
日期: 2026-09-28
基于: 无

## 1. 这张单是什么

FLY-3030 是 **FLY-2919 QA 专用的合成单**：只在 529 测试房（slot 2 `--codex-runner`，精确头 `bfdea677`）由 `/tmp/fly2919-driver` 派单。⛔ 生产不派单、不动它。

给房内 runner 的任务只有一件事：

> 在沙箱仓 `xrliAnnie/flywheel-qa-sandbox` 的 `README.md` 末尾追加一行 `FLY-2919 N-to-N codex-body probe`，提交推送并按正常流程交卷。

真正被验收的不是这行字，而是 **驱动器（driver）观测到的执行体生命周期**（由 FLY-2919 QA 按 driver receipt 判定）：

| 验收点 | 含义 | 本设计的责任 |
|---|---|---|
| 死体当场终结并换体 | 执行体（body，= 跑这个节点的那个 Codex/Claude 进程）死掉后，引擎立刻判终结并起新体 | 不归设计节点控制；但要求 **新体能从任意中间状态安全续干**（幂等） |
| 活体丢窗口不判死 | 进程活着、只是 tmux/cmux 窗口丢了，不能被误判为死体 | 不归设计节点控制；plan 不引入任何「靠窗口存在」判断的步骤 |
| 同一 thread 续干 | 换体后在同一个 Codex thread 里接着干 | 不归设计节点控制；plan 以 git + 账本为唯一真相，任何体接手都能读出进度 |
| 交卷回 thread | 完成回执落回同一 thread | plan 只用注入的 `flywheel-comm` 回执命令，不另发消息 |

结论：设计节点能贡献的核心价值 = **把一个一行字的改动写成「可被随时杀掉、随时换体续干」的幂等合同**。

## 2. 仓库现状（实测）

- 工作区：`/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-3030`，分支 `project-slot-2-FLY-3030`，remote `origin = xrliAnnie/flywheel-qa-sandbox`。
- `git rev-list --left-right --count origin/main...HEAD` = `0 0` → 分支与 `origin/main`（`1855f7a1a`）齐平，无漂移。
- 远端尚无 `*3030*` 分支，沙箱仓也没有 FLY-3030 的 PR。
- `README.md` 当前字节（`od -c`）：`\n \n FLY-1375 land E2E marker 20260722T023540Z \n`，共 3 行（前两行空行），**末尾已有换行**，追加不需要补换行。
- 仓内零处出现 `FLY-2919` / `N-to-N` 字样（`grep` 零命中）→ 目标行尚未存在。
- `core.hooksPath` 指向 slot push-guard（`/tmp/flywheel-test-slot-2/state/push-guard/.../hooks`），实现时不得改动。

## 3. 工作流图（本 run 的 DAG）

模板 `tpl_code` rev 1：`eng_design → implement → qa → founder_gate → land`。

- `eng_design`（本节点）：只出设计，不实现、不开 PR，完成路由 `phase_design_complete`。
- `implement`：`creates_pr=true`，完成路由 `needs_review`；按协议要求 PR 最后一个 commit 是 `engineering/doc/milestones/FLY-3030.md`，受 `local-test-policy/v1` 约束。
- `qa`：独立核验 + `qa-result`。
- `founder_gate` / `land`：founder 批准后才合并。设计与实现都不碰。

## 4. 方案候选

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 幂等状态机（采用）** | 每一步先判「已完成？」再动手：行是否已在、commit 是否已在、远端是否已推、PR 是否已开、milestone 是否已写 | 任意体在任意步骤被杀，新体重跑同一脚本都收敛到同一结果；不会出现两行、两个 commit、两个 PR |
| B. 直接追加 + commit + push | 一次性顺序执行 | 换体后重跑会 **追加第二行**、产生第二个 commit；正好破坏 FLY-2919 要验的「续干」 |
| C. 用 sed 改写整个 README | 重写文件 | 改动面更大、diff 不止一行，无收益 |

否决 B：它在「死体换体」场景下不幂等，会污染验收证据。否决 C：违反最小改动。

## 5. 待确认 / 假设

1. 「按正常流程交卷」= 走本 DAG 的 implement 合同（PR → 代码评审门 → milestone 末提交 → `complete --route needs_review`），以实现节点注入的命令为准。
2. 目标行逐字为 `FLY-2919 N-to-N codex-body probe`（ASCII，无前后空格），作为 README 的新最后一行（第 4 行）。
3. 这是纯文档改动：不改任何 `packages/` 代码、不跑本地测试套件；全量 CI 由 PR 精确头 CI 负责。
