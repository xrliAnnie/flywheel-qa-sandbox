# FLY-1625 self-ship 修了又坏 × N 次 — 探索

Issue: FLY-1625 (https://linear.app/geoforge3d/issue/FLY-1625/founder-直令机理深究-self-ship-修了又坏-n-次-全链取证今晨三单-1609-claims-路径-按根因分层的修复方案)
日期: 2026-08-04
基于: 无

---

> ### ⚠️ 范围（三份文档统一口径）
>
> 本单只讲**一件事**：**「founder 批准之后，runner 自己把 PR 合掉」这一步，在 DAG 路径上不工作。**
> 流水线本身在跑 —— design → implement → qa → gate 全都跑了，PR 也产出了、也合进 main 了，
> 只是**每一次都得人手动点 merge**。任何把本文读成「DAG 没跑」的说法都是误读。

## 1. 这一单要回答什么

founder 直令原话：

> 「self ship 是需要修好的，已经修了很久了还没修好，那说明还需要深入研究一下到底问题在哪里」

所以本单**不是**再打一个补丁。要交付的是：把历次失败串成一条因果链的取证报告 + 按**根因**（不是症状）排的修复方案。诊断完成前不动实现代码。

## 2. 出发时的困惑（为什么"修了又坏"值得单独深究）

同一个功能已经被"修好"过至少四次，每次都有 QA、有 Codex review、有 Done：

| 单 | 修了什么 | 结果 |
| -- | -- | -- |
| FLY-921 | executor-merge 退役、规则化 | 规则生效，但 self-ship 本身没修 |
| FLY-799 / FLY-945 | founder Discord 批准 → 归属 founder → runner 自 ship（≤~75s 拾取、head 漂移自动 rebind） | 声称全链闭环 |
| FLY-1505 | ship 轮询窗口 10min → 跟 CI 真实耗时 | 修掉一个假报 blocked |
| FLY-1483 / FLY-533 | 两条已知死胡同 | 未修，2026-08-03 21:56 双双被 Canceled |

而 2026-08-03 当天，762 / 763 / 765 三单全部由 Lead 手动 merge；当晚 1609 的 founder 批准**完全正确落地**（gate approved、bound、head 零漂移），runner 的 `verify-approval` 仍然 fail-closed。

**「每次都修好了，每次都还是坏」这个模式本身就是最重要的线索**——它强烈提示：我们每次修的是**当时那条路径**，而不是"self-ship 这件事"；系统里同时存在多条 ship 授权路径，修 A 路的时候 B 路已经/正在被另一个增量建出来。

## 3. 候选假设（进场时列，逐条用证据证伪或坐实）

| # | 假设 | 结论 |
| -- | -- | -- |
| H1 | 偶发竞态/时序问题，重试就好 | **证伪**。失败面 100%，不是概率事件（见 research §2 全量对照） |
| H2 | founder 批准没被正确记账（消息没拾取 / 归属错） | **证伪**。1609 / 1605 的 `runner_ship_approved` 事件都正确写入 |
| H3 | head 漂移（FLY-945 Fix B 该管的那类） | **部分坐实，但归因错了**：漂移确实存在，但源头不是"外人推提交"，而是 Flywheel **自己强制的 progress ledger 自动提交** |
| H4 | 收尾链（外部 merge 后的收敛）坏了 | **证伪**。收尾链健康，外部 merge 后 1 秒内收敛——这恰恰反证了"坏的是放行那一环" |
| H5 | FLY-945 修的路径今天根本不走了 | **坐实**。945 的模型（单 session 的 `pr_head_sha` + `review_question_id`）早于 DAG gate-carrier 层 2.5 周 |
| H6 | 存在两套彼此不知道对方的 ship 授权机制 | **坐实，且这是主因**。见 research §4（RC-B） |
| H7 | carrier 的角色合同禁止 self-ship | **提出后又撤回**。「Never self-merge」是**直接 `gh pr merge` 的红线**，与 sanctioned 的 `verify-approval → :cool:` 不互斥。教训见 research §4b.3 |

## 4. 关键取证入口（怎么找到答案的）

不靠日志（1609 的 stderr 已丢失、run 已 completed 无法复现），改走**可回溯的持久状态**：

1. `~/.flywheel/teamlead.db` 的 `workflow_gate_holder` —— 卡死 / 健康的判别式在这张表里一眼可见
2. `workflow_run_event` —— 每个 run 的 ship 结局都有事件留档，可做全量普查
3. `workflow_claims` + `workflow_node_pr_binding` + `workflow_ship_target_binding` —— 三张表互相对照，可复原"三个 head 分别是什么、谁写的"
4. `git log` 真实提交 —— 把 DB 里的 sha 还原成人能读懂的提交信息（这一步是转折点）
5. 源码 —— 把统计相关性钉成因果：谓词在哪一行、谁写谁读、有没有重试

第 4 步是整个调查的转折：把 4 个卡死 gate 的 `head_sha` 丢进 `git log` 之后，4 条的提交信息**逐字都是** `chore(progress): FLY-XXXX implement N/6`。那一刻相关性变成了机理。

## 5. 深究问题清单与去向

| # | 问题 | 答在哪 |
| -- | -- | -- |
| 1 | 今晨 762/763/765 三次各自死在哪一步 | research §2、§6 |
| 2 | 1609 的 `head_authority_unavailable` 精确成因 | research §4（RC-B） |
| 3 | FLY-945 覆盖哪条路径、今天为什么全没走通 | research §5 |
| 4 | 1483/533 与今天失败的关系（同根？独立？） | research §7 |
| 5 | 修复方案分层 + 与 FLY-1624 的边界 | plan §2、§8.1 |

## 6. 本单的边界

- **只诊断 + 出方案**，不改实现代码（founder 直令）。
- 不动生产 Bridge、不动 `~/.flywheel/*.db`（全程 `mode=ro` 只读）。
- 排期：founder 原话「不需要马上做什么」，排今晚部署波之后。
- 与 FLY-1624 的 follow-up「1609 claims 路径事后取证」合并在本单完成。
