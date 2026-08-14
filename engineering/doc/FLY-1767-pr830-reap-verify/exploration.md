# FLY-1767 独立验证 PR #830 worktree 进程回收 — 探索

Issue: FLY-1767 (https://linear.app/geoforge3d/issue/FLY-1767/qafly-1759-独立验证-pr-830-worktree-进程回收最终-head-无-qa-verdict补验)
日期: 2026-08-14
基于: 无

## 1. 为什么会有这一单

PR #830(FLY-1759,worktree 拆除前回收进程组)的历史是断的:

| 时间 | 事件 | head |
| -- | -- | -- |
| 8-14 04:33 | Codex code review APPROVED | `1671a3f2` |
| 8-14 04:47 | 独立 QA 判 **FAIL**(一个阻塞项) | `1671a3f2` |
| 8-14 05:xx | 返工撞 `state_not_revivable`(= FLY-1765 的 bug),原体已 completed 收不回 | — |
| 8-14 06:12 | 手工恢复,generic 载体收账,产出 `f416435f`+`36f036ef` | → `0aa43410` |
| 现在 | 卡在 ship 卡等 founder | `0aa43410` |

**最终 head `0aa43410` 上没有任何独立 QA verdict。** 判 FAIL 的那一轮测的是 `1671a3f2`;
修完之后接手的是 generic 载体,没有再走一次独立 QA。这与 FLY-1560 是同型缺口,按 founder
今晨(2026-08-14)确立的「需要 QA 测试」标准补验。

## 2. 被测物的性质决定了验证方式

改动是**进程级副作用**:在删目录/`git worktree remove` 之前,按 cwd 普查
(`lsof -a -d cwd`)+ ppid 后代闭包找出所有扎根在 worktree 里的进程,TERM→KILL 收掉,
再动文件系统。

由此推出三条验证原则:

1. **不能只看返回值。** `summary.verified === true` 是被测代码自己的说法。必须用
   独立的 `kill(pid, 0)` 逐 PID 复验 ESRCH —— 「工具说成了不是证据」。
2. **必须有变更前基线。** 一个「进程都没了」的绿测,如果没有「旧行为下进程还活着」的
   对照,证明不了任何因果。所以第一组用例是**故意跑旧拆除形态复现 bug**。
3. **爆炸半径与杀干净同等重要。** 一个把全机进程都杀掉的实现也能让「目标进程全没了」
   变绿。所以阴性对照(仓库内、兄弟 worktree、前缀混淆路径、跨组成员、自身进程链)
   与正向断言必须成对。

## 3. 验证面盘点

| 面 | 做法 | 为什么必须做 |
| -- | -- | -- |
| 四个生产拆除原语 | 逐个真机走一遍 | 上一轮 QA 只覆盖 3 个,`removeIfExists()` 的 orphan 分支(Blueprint FLY-99 预清理路径)没测过 |
| 原 QA 的 FAIL 项 | 复现旧写法 + 核实新写法 | 「修好了」需要证据,不是 diff 好看 |
| 空过绿检验 | 突变(reaper 换空实现)看测试变不变红 | 上一轮 QA 的 real-tmux 覆盖就是**零覆盖却显示绿**,同一个陷阱不能再踩 |
| 爆炸半径 | 7 类拒绝路径 + 4 类阴性对照 | 这段代码有 `kill(-pgid)` 的能力,误杀 = 比泄漏更严重的事故 |
| 事故形态重放 | 4 个泄漏家族一次拆除 | 产品级判据:8-13 那台机器上的东西,现在会不会被收掉 |
| fail-open | 普查坏掉时目录还删不删 | 设计取舍是 fail-open,要证明它真的开着(既不卡流水线,也不误杀) |

## 4. 边界(诚实声明)

**做**:macOS 26 / tmux 3.5a / 本机(load ~16,1023 进程)上的真进程级 E2E;
frozen head `0aa43410` 只读复测;GitHub CI 结果作为 Linux 侧证据。

**不做**:
- 不在 Linux 主机上真跑 —— 本机没有;Ubuntu 行为以 CI 为准。
- 不做 24h 浸泡观察 —— 属 ship 后自然观察项。
- 不改被测分支任何字节(head 已绑 ship 卡),不提交任何东西到 `flywheel-FLY-1759`。
- 不发 qa-result verdict 进引擎 —— 本节点合同:结论交 Lead。

## 5. 相关

- [[research.md]] — PR 审计 + 原 FAIL 项还原
- [[plan.md]] — 五组测试的具体设计
- [[qa-report.md]] — 结果
