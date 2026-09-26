# FLY-2901 Codex 设计复核 R6（重派，服务端指定 gpt-6-astra xhigh）
Issue: FLY-2901
日期: 2026-09-26
基于: plan.md（blob 4428ecb754224a0a270f480a14f208480288e67e，未改）；Bridge requestId 99c347e1-608a-413c-8a26-7808e937eb59

> 原文如下，复现脚本与结果见 repro-r6/（夹具目录与拷贝源文件未入库，脚本内绝对路径指向当时的临时目录）。

# Summary

**CHANGES REQUESTED — 0 BLOCKER / 1 HIGH / 0 MEDIUM / 0 LOW。**

审查对象为冻结的 plan blob `4428ecb754224a0a270f480a14f208480288e67e`；磁盘文件与 HEAD 中该文件的 blob 均完全匹配。源码核验固定在 `88d89e8927f56aef3da523ce8d58ca3445c2b263`。

已先读 CLAUDE.md，并核对 exploration/research、设计 R1–R5、design-review-record、code-review-round2 与 verification。此前关闭项保持关闭；本次仅发现一条有可执行反例的新 HIGH：计划将“清理前不可见的 ignored 内容”当作会原地保留，但 `reset --hard target → clean -fd` 可以删除或覆盖这些从未进入救援快照的内容，并正常返回成功。这直接违反零丢失合同，达到本次重新打开冻结计划的门槛。

仓库未修改。当前 checkout 无 node_modules，未重跑项目测试、构建或 full CI，也不把历史验证记录作为本轮执行结果。本轮执行了独立临时 Git 复现及固定提交事务源码的两个定向反例，后者退出码 0（断言成功证明缺陷），无未处理异常；Node 仅输出 experimental-transform-types 提示。

# What's Good

- **入口和关闭开关的边界明确。** plan L30–31、L41–52、L101–108 把孤儿目录、探针异常、unique branch 与 pending rescue 保护放在旧建树路径之前。实际入口见 `packages/edge-worker/src/Blueprint.ts:1433–1444`；能力门、pending 查询和分类见 `packages/edge-worker/src/worktree-takeover-transaction.ts:346–405`。[verified by reading code]
- **单锁事务及 generation 续用可实现。** `WorktreeManager.ts:1480–1511` 在一个 repo lock 内调用事务；`bridge/repo-mutation-lock.ts` 支持异步上下文重入。plan L68–70 对 missing 分支额外保全 L 的要求落实于事务 L541–594，覆盖既有 create rollback 删除分支的风险。[verified by reading code]
- **R4/R5 的 manifest 合同已闭合。** plan L148–151 复用递归排序的 `canonicalJsonString`，数组显式排序，哈希仅进入事件。`packages/config/src/canonical-json.ts:7–25`、`worktree-takeover-rescue.ts:182–223, 251–312` 与此一致；`StateStore.ts:68873–68934` 确实对 immutable fields 和 canonical payload 做 checked replay。[verified by reading code]
- **事件时序和读取能力已接通。** manifest → awaited rescue event → 破坏阶段 → cleaned 的实现分别在事务 L1487–1564、L1680–1749；`DirectEventSink.ts:1918–2030` 提供读取/写入，HTTP 两种事件在 `bridge/event-route.ts:1314–1340` 被拒绝。[verified by reading code]
- **外围接线具备对应落点。** dispatcher 的前任集合、活性三态及 head fallback（L401–565）、progress schema/CLI 两处 rescue 白名单、告警四处登记、flag registry、两条精确 exclude 与 nested target 提示均已找到；`complete.ts:943–961` 和 `resolveReviewTarget` 的包含校验仍成立。无需重开 Lead 已裁定的 FLY-2122 a/b 合同。[verified by reading code]

# Issues

1. **[HIGH] ignored 内容不在快照内，却可能被 target 的 reset/clean 删除或覆盖；事务仍报告零丢失成功。**

   **Plan 行号：** L60–73（head_behind 目标及仅基于 H/T/S 的零丢失不变式）、L111–123（按 status 快照/指纹）、L130（ignored 内容原地保留）、**L167（无条件 `reset --hard target → clean -fd`）**、L228–230（验证也只枚举 `--exclude-standard` 可见的未跟踪文件）。

   **触发条件与结果：** 取合法 `head_behind`：`H ⊏ S`，远端 branch tip `R=H`，前任已 dead，许可证通过；H 的 `.gitignore` 排除 `drafts/`，工作树有唯一、从未提交的 `drafts/unpublished.md`。清理前 status 为空，三次指纹稳定，T=H，H/S 均在 target=S 中，所以没有快照和 rescue ref。以下任一 target 均可静默丢工作：

   | target=S 的变化 | 实际丢失点 | 最终事务结果 |
   |---|---|---|
   | S 移除 `.gitignore` 的 `drafts/` 规则 | reset 更新忽略规则后，`clean -fd` 删除原文件 | `rescued`；`rescued` 与 `cleaned` 事件均记录；最终 status 为空 |
   | S 开始跟踪同一路径（忽略规则可以不变） | `reset --hard S` 直接将原字节覆盖为 S 的内容 | 同上；原字节不在任何 rescue ref 中 |

   **源码证据：** `worktree-takeover-transaction.ts:417–419, 471–499` 只在当前 status 有普通脏项时调用 snapshot；`:830–843` 的 status 不含 ignored 文件；`:501–515` 允许上述空 rescue 集合通过；`:1550–1564` 先 reset，再按切换后的规则执行全树 clean；`:1565–1569` 只检查 HEAD/status，不能发现原字节已消失。此处没有覆盖/删除集合的保全检查。[verified by reading code]

   **执行证据：** [repro.mjs](fly2901-review-repro/repro.mjs) 和 [results.json](fly2901-review-repro/results.json)。从上述固定 commit 提取 transaction、rescue、worktree-paths 和 canonical-json 四个源文件，仅修改 import 路径以便 Node 直接加载 TypeScript；事务代码逻辑未改。使用真实 bare origin、主仓及 linked worktree，提供单线程 host/内存 recorder，未运行完整 Blueprint/StateStore。两例均实际返回 `class=head_behind, kind=rescued, snapshot=null, rescueRefs=[]`，snapshot 调用次数为 0，分别在 `clean_done` 和 `reset_done` 观察到原内容消失/被覆盖，并继续记录 cleaned。没有并发、网络失败或伪造事件前提。[verified by executing]

   重跑命令（只在该临时证据目录内新建隔离 Git 夹具）：

   ```sh
   node --experimental-transform-types /private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2901/17494d5c-1fa0-41f4-8991-3e04157b3751/scratchpad/fly2901-review-repro/repro.mjs
   ```

   **最小修复：** 在 §4.7 增加破坏前的路径级保全门：必须证明 target reset 将覆盖的内容，以及随后 clean 将删除的内容，都已被本次保全；对未保全 ignored 内容的覆盖、或 ignore 变化导致的新增清理路径，直接 fail closed，并列具体路径。不要仅以“不带 -x”作为保留证明。清理只能作用于已证明可丢弃的集合；补上述两个真 Git 回归，验证拒绝发生于破坏前且原字节不变。仅补清理后的检查不能修复，因为此时原字节已经没有可恢复副本。

   **为何本轮必须提出：** R1–R5 没有验证这个反例；它不是要求重做架构或追加永久 QA 加固，而是冻结文本明确允许、现有实现可复现的实际数据丢失。现有零丢失测试的 `--exclude-standard` 枚举也会漏掉被删除的原文件。

# Verdict

此前已关闭的设计问题继续关闭；本次仅上述 HIGH 阻止批准。需要补齐破坏前的 ignored 内容保护合同及两条回归，再对这一项做定向复核。

VERDICT: CHANGES REQUESTED
