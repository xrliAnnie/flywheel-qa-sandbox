# FLY-2901 Codex 设计复核 R6-2（gpt-6-astra xhigh，限定 v5.2 §4.7a；原账号额度耗尽，改用池快照 shopping 隔离 CODEX_HOME 全上下文重跑）
Issue: FLY-2901
日期: 2026-09-26
基于: plan.md（blob f28e685166841773c7d632a32aa38235d2fc7a08）

> 原文如下，复现脚本与结果见 repro-r6-2/。

# Summary

**CHANGES REQUESTED — 0 BLOCKER / 2 HIGH / 0 MEDIUM / 0 LOW。**

本轮只核验 v5.2 的 §4.7a 及对应时序、停手原因、测试增量。审查对象：commit `8e684a97df07d5fd8768e621fb5b06a7fd30c339`，plan blob `f28e685166841773c7d632a32aa38235d2fc7a08`；已读 CLAUDE.md。此前关闭项不重开。

原始 R6 两个反例在新判据下都会在破坏前拒绝；第一次门位于保全写入之前，第二次门位于所有原地破坏动作之前并覆盖 pending-rescue 重入，这些时序约定没有发现新的 BLOCKER/HIGH。但是，门把 H 的提交树当作当前忽略规则的基线，并把“某条规则仍存在”当作“仍有效”。这两个独立缺口仍允许未保全的 ignored 字节被删除，因此 R6 HIGH 尚未闭合。

执行证据：[repro.mjs](fly2901-r6-followup-lhgjf1md/repro.mjs)、[results.json](fly2901-r6-followup-lhgjf1md/results.json)、[source.json](fly2901-r6-followup-lhgjf1md/source.json)。最终运行 **11 个真 Git 用例，退出码 0**：原始 R6 两例及 `/paired/` 规则删除例均拒绝并保留字节，3 个正常对照成功并保留字节，另有 5 个数据丢失反例，分别支撑下面两条 HIGH。

验证边界：§4.7a 尚未实现，本轮在临时脚本中逐条建模其判据。首门在调用事务前执行，第二门在实际 reset 前执行；所有夹具的 `nestedMoves=[]`，因此 reset 就是首个破坏动作。放行后运行从上述 commit 提取的真实 transaction/rescue 源码，并用从 WorktreeManager 原样抽出的 `snapshotWorktreeState` 方法与 status parser 处理脏快照；只改模块 import 路径及快照方法的宿主包装，未改算法。使用隔离 bare origin、主仓和 linked worktree、单线程 host 与内存 recorder；没有运行完整 Blueprint/StateStore，也没有执行项目测试、构建或 full CI。崩溃重入时序按计划与现有调用链阅读核验，本轮未执行重启集成用例。仓库文件未修改。

重跑命令（仅在该临时证据目录中创建新 Git 夹具）：

```sh
node --experimental-transform-types /private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2901/17494d5c-1fa0-41f4-8991-3e04157b3751/scratchpad/fly2901-r6-followup-lhgjf1md/repro.mjs
```

# Issues

## 1. [HIGH] `target == H` 跳过及 `diff H target` 均漏掉工作区里的未提交忽略规则；两次门都可放行数据丢失

**位置：plan.md L179、L182；对应新增测试 L277。**

合法的 `dirty` 场景：H 跟踪的 `.gitignore` 内容是 `# base`；前任在工作区把它改成 `drafts/`，并留下唯一的 `drafts/unpublished.md`。取 `S=H=R`、前任 dead、许可证通过。status 只有 `.gitignore` 的修改，草稿被忽略，不进快照。目标是 H，所以两次门都按 L179 直接通过；`reset --hard H` 恢复 `.gitignore`，接着 `clean -fd` 删除草稿。快照保全了 `.gitignore` 的改动，却没有保全草稿字节。

仅删除早退也不够：令 `H ⊏ S`，S 只改普通 tracked 文件，H/S 的 `.gitignore` 完全一致，工作区仍有上述未提交忽略规则。这次 target=S；冲突一无 target 路径覆盖，冲突二的 `diff H target` 不含 `.gitignore`，所以两次门仍通过，reset/clean 仍删除草稿。

| 执行用例 | 两次门 | 实际事务结果 | 草稿保全情况 |
|---|---|---|---|
| `dirty-ignore-target-H` | 通过 / 通过（均早退） | `class=dirty, kind=rescued`；rescued、cleaned 均记录 | 快照调用 1 次，但草稿未入救援 ref；`clean_done` 时消失 |
| `dirty-ignore-target-S` | 通过 / 通过（commit 间无 ignore diff） | `class=head_behind, kind=rescued`；rescued、cleaned 均记录 | 同上 |

两例最终 `HEAD==target`、status 为空；原始字节的 blob 在对象库中也不存在。没有并发写入或异常前提。[verified by executing]

根因：reset 的输入是**当前 index / 工作区**，不是 H 的干净检出。`target == H` 并不能证明忽略规则或当前未跟踪集合不受 reset 影响。L277 的普通 node_modules 对照不能证明这个更强的早退条件。

**最小修正：** 不因 `target == H` 跳过保全门，所有原地清理都检查 I 与 target 路径冲突。忽略规则的变化检测必须覆盖当前实际工作区规则到 reset/clean 后规则的变化，包含 staged / unstaged 改动，不能只比较 H 与 target 两个提交。保守拒绝即可；补上述两条真 Git 回归，断言破坏前拒绝且草稿字节不变。

## 2. [HIGH] “安全根”例外只检查忽略规则存在，没有证明其仍生效；target 的否定规则能绕过冲突二

**位置：plan.md L183–184；对应新增测试 L277–278。**

无脏状态的合法 `head_behind` 就能触发：H 的 `.gitignore` 为 `/paired/`，工作区有从未提交的 `paired/unpublished.md`；S 将文件改为：

```gitignore
/paired/
!/paired/
```

S 仍含精确行 `/paired/`，所以 L184 把 `paired/` 从 I 剔除，得到 `I'=[]`；S 也没有跟踪 `paired/` 下任何路径，冲突一为空。两次门均通过。reset 后最后匹配的否定规则生效，`clean -fd` 删除草稿。

同一问题影响两个 info/exclude 根：即使 §6 的两条精确行已经写入并复读验证，S 的根 `.gitignore` 新增 `!/.flywheel/runs/` 或 `!/.flywheel/review-targets/`，仍会解除相应忽略。`.gitignore` 的优先级高于 info/exclude；同级规则则由最后一个匹配决定。“来源不随 reset 改变”不等于“有效忽略结果不变”。[Git 官方规则说明](https://git-scm.com/docs/gitignore#_description)、[否定规则说明](https://git-scm.com/docs/gitignore#_pattern_format)。

执行的 `paired-negation`、`runs-negation`、`review-targets-negation` 三例均满足 `I'=[]`、无 target 路径冲突，两次门均通过，真实事务返回 `class=head_behind, kind=rescued` 并记录 rescued、cleaned；snapshot 调用 0 次、`rescues=[]`，原文件在 `clean_done` 消失，原字节未进入对象库。[verified by executing]

其中 paired 与 review-targets 两例最终 status 为空。runs 例在 clean 后为空，随后镜像证据写回已被解除忽略的 runs 目录，最终出现 `? .flywheel/runs/`；即便后续 Blueprint 因此拒绝，原文件也已丢失，不能修复零丢失合同。

**最小修正：** 在没有证明 target 下仍然有效忽略前，不把这些根从 I 剔除；保守保留冲突二拒绝即可。若保留安全根豁免，需要另外保证随后 clean 不会删除这些路径，不能只验一行文本存在。补“`/paired/` 行保留但后续否定”和“target `.gitignore` 否定 info/exclude 根”的回归，断言原字节保留。

# Verdict

新增调用顺序及原始 R6 两例的拦截成立；上述两个判定缺口仍可实际丢失未保全的 ignored 字节，均达到 HIGH。只需继续修订 §4.7a 的基线与安全根例外及其定向回归，不要求重开其他已关闭设计合同。

VERDICT: CHANGES REQUESTED
