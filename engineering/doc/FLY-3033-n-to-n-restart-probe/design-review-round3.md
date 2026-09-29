# FLY-3033 N-to-N 重启探针 — Codex 设计评审第 3 轮（原文存档）
Issue: FLY-3033 (https://linear.app/geoforge3d/issue/FLY-3033/529-合成单勿派-fly-2920-真房-n-to-n-codex-实现体重启负载演练用)
日期: 2026-09-28
基于: plan.md

> 评审者 gpt-6-astra / xhigh，线程 `01a0ea77-cf29-74b0-a114-1398c87830a5`。以下为评审者原文；文中 `./…` 与 `/private/tmp/…` 链接指评审者当时的临时脚本与结果文件，未入库。

# Design Review — plan.md (Round 3)

Date: 2026-09-28 / Author: Codex / Status: APPROVED

## Summary

R2 的 high 已解决。`pushbr` 去掉 `-u`，Task 0 不再触碰共享 `config.lock`；保留自动回收的 ref 锁则按 common Git directory 和全部关联工作树检查存活 Git 进程。重新执行 R2 的真实配置写者负例后，锁被保留，写者恢复并正常退出。本轮未发现需要修改的新问题。

审查固定在提交 `896dd4a5664a77f7f63829cdf452b6ed62a154cf`，plan blob `4d8baa8dac6773592c3578fdbe1f02bccc614714`；工作区 plan 与该 blob 逐字节一致。本轮范围为 `f153eea37..896dd4a56` 的推送、锁作用域及对应演练修改，已认可的其余合同不重开。

已执行验证：

- 常量块及九个 Task 块共 10 个 shell 块，全部通过 `/bin/sh -n`。
- 从提交的 harness 抽取 L、L2、S、S2、LC 五个场景，在仓库外执行；Task 代码保持原文，使用真实 Git、真实 lsof、本地 bare origin 和提交的 gh/comm 桩。逐项核对日志，不能仅凭 harness exit 0 判定通过。

| 场景 | 独立复核结果 |
|---|---|
| L：私有 index.lock，兄弟工作树有活 Git | 私有锁成功回收；全流程 `final: OK` |
| L2：新鲜私有锁 | Task 0 STOP，锁保留 |
| S：共享 remote ref 锁，兄弟工作树有活 Git | Task 0 STOP，锁保留；该进程退出后成功回收，全流程 `final: OK` |
| S2：共享 branch ref 孤儿锁 | 成功回收，全流程 `final: OK` |
| LC：共享 config.lock | Tasks 0–3 均成功，config.lock 未被删除 |

日志：[round3-targeted.log](./round3-targeted.log)。三个完成全流程的场景均只有一个 README commit，milestone 为最后提交，远端头等于 HEAD，工作区干净，PR 桩为 OPEN。

另外执行了两项针对性探针：

1. **真实共享配置写者**：在临时主仓启动真实 `git config --local --add`，取得 config.lock 后暂停该测试自有进程并调旧锁龄；在 linked worktree 执行原文 R3 Task 0。Task 0 exit 0，原写者仍存活且锁保留；恢复写者后 exit 0、无错误。与 R2 删除活锁导致 exit 4 的结果相反。证据：[脚本](./round3-shared-config-probe.py)、[结果](/private/tmp/fly3033-r3-config-rl85b101/results.json)。
2. **自动上游配置**：在临时 linked worktree 显式设置 `push.autoSetupRemote=true`，预置共享 config.lock，运行 `git push origin "HEAD:refs/heads/review"`。推送 exit 0，config 字节不变，锁内容不变，未新增 branch upstream。当前显式 refspec 不会因该配置重新引入 `-u` 的写配置行为。

验证边界：本轮没有重跑全部 31 个场景。作者补充的真实 ps/P-live 结果属于实现环境证据；评审沙箱此前禁止执行 ps，本轮没有独立复验账本恢复的 ps 路径，仍标为 **unverifiable（评审环境受限）**，不记作本轮 PASS。真实 GitHub PR/CI、Bridge 去重及重启恢复同样 **unverifiable（未执行，使用桩）**。这些边界与 R2 已认可的设计判断不冲突。

## What's Good (Keep)

- 保留“不回收 config.lock”的最小修复；显式推送目标分支，无需设置 upstream。
- 按锁实际位置区分私有与共享范围，避免本工作树的 TURN 被当成兄弟工作树已停止的证据。
- 保留锁龄、单次 lsof 枚举、shell 哨兵和活进程检查；发现活写者时保留锁。
- 演练采用主工作树加 linked worktree，覆盖共享锁保护和私有锁正常恢复两个方向，直接对应真实 slot 拓扑。
- 保留先冻结后评审、已提交账本游标、评审身份重用及证据边界说明。

## Issues & Recommendations

无新增发现或必改项。R2 的共享 config.lock 回收问题已关闭；新增共享 ref 锁作用域及其负例验证符合本轮修复目标。

## Verdict

**APPROVED**

Finding counts: critical=0, high=0, medium=0, low=0; total=0.

本轮未修改仓库文件，未向 GitHub 推送；写入仅为指定反馈文件、评审证据和仓库外临时测试产物。审查前后仓库工作区均干净。
