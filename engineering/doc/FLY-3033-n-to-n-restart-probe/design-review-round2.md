# FLY-3033 N-to-N 重启探针 — Codex 设计评审第 2 轮（原文存档）
Issue: FLY-3033 (https://linear.app/geoforge3d/issue/FLY-3033/529-合成单勿派-fly-2920-真房-n-to-n-codex-实现体重启负载演练用)
日期: 2026-09-28
基于: plan.md

> 评审者 gpt-6-astra / xhigh，线程 `01a0ea77-cf29-74b0-a114-1398c87830a5`。以下为评审者原文；文中 `./…` 与 `/private/tmp/…` 链接指评审者当时的临时脚本与结果文件，未入库。

# Design Review — plan.md (Round 2)

Date: 2026-09-28 / Author: Codex / Status: CHANGES REQUESTED

## Summary

R2 对两项 R1 反馈的主要修改方向正确，但新增的 `config.lock` 自动回收越过了当前工作树的所有权边界。已在临时 linked worktree 中复现：Task 0 删除兄弟工作树中仍存活的 Git 写者持有的共享锁，导致该写者恢复后失败。本轮新增发现 1 项 high。

本轮仅审查 `e9590fd15..f153eea37` 中的 plan、dry-run 文档及 harness 修改和直接运行时合同；R1 已成立的 README 字节合同、冻结顺序和其余范围不重开。固定提交 `f153eea3704c0e9fbef9d06c82d97ceed8680fe9`，plan blob `9323771c204ed9d352cbfc7864767c2b563effc4`。相关运行时仍为 `/Users/xiaorongli/Dev/flywheel-FLY-2920` 的 `df10f07c6c74df7c416cfbb15d417592e3930ceb`。

R1 项目复核：

- **账本恢复**：`prog` 已改读 `HEAD:$LEDGER`，Task 0 也覆盖锁、临时文件和未提交账本，静态上处理了 R1 指出的残留类型。真实崩溃切点演练已补入。不过本评审沙箱禁止执行 `ps`，因此无法独立确认新的存活写者检查及随后恢复路径实际成功；这部分标为 **unverifiable（环境受限）**，不记 PASS，也不将评审环境的限制推断为实现体必然失败。
- **评审身份重用**：R1 medium 在设计层面已解决。execution 隔离的记录、先记录 requestId 再请求、已有 questionId 不开新门、未知开门结果交 Lead 核对，以及 retired/held/operator-required 分支与当前运行时合同相符。记录缺失的开门窗口仍需人工核对，是本版明确保留的恢复边界。Bridge 真实重复注册及重启恢复仍为 **unverifiable（未执行）**。

本轮验证：

- 常量及九个 Task 块全部通过 `/bin/sh -n`。
- 指定原文 harness 完整跑完 29 个场景、进程 exit 0；日志有 13 次 `final: OK`、6 次 `final: BAD`。六次 BAD 分别为四个 progress 崩溃恢复、P-live 恢复和冻结后残留恢复，均停在 `STOP: ps 枚举失败`。因此不能将整体 exit 0 当成全通过。完整日志：[round2-dry-run.log](./round2-dry-run.log)。
- V1 沿用原 gate/request；V2 不重复开门；V3 两次调用只有一个 requestId；V4 拒绝头不匹配。V5 只演练打印裁决，后续 STOP 仍依赖执行体遵守文字合同，不算自动门禁验证。
- 新增共享锁缺陷使用真实 Git、真实 lsof 和两个关联工作树复现；只删除 `config.lock` 回收项的临时对照版本则保留活锁、写者正常完成，见下文。
- 未修改仓库文件、未推送、未安装依赖、未跑产品测试套件或调用真实 Bridge 写接口。开始时已有的两项 HTML 工作区修改不在审查范围内。

## What's Good (Keep)

- 保留以已提交账本游标作为幂等依据，避免未提交的 rename 结果被误判为完成。
- 保留残留过新、进程枚举失败或发现活写者时停止且保留残留的行为；冻结后清理不能产生新 commit。
- 保留 execution 隔离的评审记录和原 requestId/questionId；不确定开门结果时拒绝再开门，比猜测已有问题不存在更可靠。
- 保留 Task 5b 对 `reviewVerdict` 和恢复状态的区分，以及真实 Bridge 去重尚未验证的明确说明。

## Issues & Recommendations

1. **[high] 新增 config.lock 回收会删除其他工作树中活写者持有的共享锁。**

   **位置**：[plan.md:124](/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-3033/engineering/doc/FLY-3033-n-to-n-restart-probe/plan.md:124)，关联 137 行的 cwd 过滤和 144 行的删除。

   **原因**：当前仓确实是 linked worktree。只读执行 `git rev-parse --git-path config.lock` 得到 `/private/tmp/flywheel-test-slot-2/project-slot-2/.git/config.lock`，它属于所有关联工作树共享的 common Git directory。当前 TURN 和 `cwd == $ROOT` 的进程检查只覆盖 FLY-3033 工作树，不能证明兄弟工作树里的 Git 配置写者已经退出。新增共享锁以后，原先针对本工作树的删除授权不再充分。

   **已执行复现**：在临时主仓及其 linked worktree 中，主仓启动真实 `git config --local --add review.probe kept`；观察到它创建共享 `config.lock` 后，SIGSTOP 这个测试自有子进程，并将测试锁 mtime 调旧至五分钟前。真实 lsof 确认该写者 cwd 在主仓，随后在 linked worktree 执行未修改的 R2 Task 0。

   | 检查 | R2 原文 | 对照：仅移除 config.lock 回收项 |
   |---|---|---|
   | Task 0 退出码 | 0 | 0 |
   | Task 0 结束时原写者仍存活 | 是 | 是 |
   | 共享锁是否保留 | 否，打印“已回收…孤儿锁” | 是 |
   | 写者 SIGCONT 后退出码 | 4 | 0 |
   | 写者错误 | `chmod ... config.lock failed: No such file or directory` | 无 |

   这不是陈旧孤儿锁：活写者仍持有它。重启/负载演练中的暂停或调度延迟不能转化为删除兄弟工作树锁的权限。该逻辑会破坏另一个工作树的配置操作；当前孤立单仓 LC 场景无法发现这一点。

   **建议**：最小修复是从此工作树级回收列表中移除 `config.lock`，遇到共享配置锁问题交给 Lead 或拥有 common Git directory 的恢复机制。若确实要自动回收，必须具备覆盖该 common Git directory 的独占授权及所有相关写者已退出的证据，不能只扩大文件列表而继续使用当前 cwd 过滤。增加上述兄弟工作树活写者负例，要求锁保留、对方写者可以正常完成。

   证据：[复现脚本](./round2-shared-config-probe.py)、[R2 原文结果](/private/tmp/fly3033-r2-config-1x4yd90i/results.json)、[单项移除对照结果](/private/tmp/fly3033-r2-config-6bh8iepx/results.json)。对照通过 `REVIEW_DROP_CONFIG=1` 只改临时抽出的 Task 0，不修改仓库 plan。测试进程均已退出，未暂停或删除真实工作树的任何进程/锁。

   补充澄清：R1 留存的 config.lock 探针是人工放置锁；Task 3 实际 exit 0，仅打印 upstream 配置写入警告，并非一次真实 push 中途被杀的复现。R1 反馈也没有要求新增共享锁回收，不应把该探针视为此扩大授权的安全依据。

## Verdict

**CHANGES REQUESTED**

Finding counts: critical=0, high=1, medium=0, low=0; total=1.

修正共享 config.lock 的回收边界后复审。账本恢复的真实 ps 路径还需在具备相应能力的实现环境补齐执行证据；本轮不能将其报告为已通过。
