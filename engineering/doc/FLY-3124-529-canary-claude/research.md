# FLY-3124 Claude 传输探针 — 调研
Issue: FLY-3124 (https://linear.app/geoforge3d/issue/FLY-3124/529-canary-fly2127-canary-606b50d9-b7a4-44bf-b80b-6e932dd2421c-claude)
日期: 2026-10-01
基于: exploration.md

## 调研问题

Issue 要求“append requested marker lines to probe.txt, commit locally, and acknowledge native mail or TURN”，但当前输入没有 marker literal。设计必须区分：谁获得了 TURN、谁收到了 marker、哪个 phase 可以修改 `probe.txt`，以及本地-only 演练如何避免误入 PR/ship 流程。

## 当前 execution 的权威证据

| 证据 | 当前值 | 能证明什么 |
|---|---|---|
| Execution | `28d5173f-35a0-4e4f-a7b5-28454f97c122` | 当前运行身份 |
| Vendor | `codex` | 当前不是 driver 创建的 Claude execution |
| TURN | `yours phase=design epoch=1` | 当前 design node 有共享 worktree 写权 |
| Activation | `activation:28d5173f-35a0-4e4f-a7b5-28454f97c122:92fd90c9-4c18-4de8-9b49-4d37c8f5efe8:eng_design:1` | TURN 与 DAG activation 的稳定绑定 |
| Native input | 无 marker instruction | 目前没有可逐字追加的内容 |
| Mailbox onboarding check | `No instructions.` | 检查时没有待消费 Lead 指令 |
| Repository | root `probe.txt` 不存在 | 没有既有 marker 或恢复残留 |

TURN 是写权限，不是 marker 内容。Issue title、owner nonce、execution metadata 都不能补齐缺失 literal。

## 外部 driver 边界

只读检查 `/Users/xiaorongli/Dev/flywheel-FLY-2127/scripts/qa-2127-codex-wake-canary.mjs`（仓库 head `980535c69a7c45a90c770cf1ef321ac0cbd55c21`）显示：

- `claudeMail()` 自己创建 vendor=`claude-code` 的 execution；
- boot marker 是 `${owner.marker}-CLAUDE-BOOT`；
- mailbox marker 是 `${owner.marker}-R4-CLAUDE`；
- driver 还核验 native delivery、ACK、exact line 与 clean worktree。

因此这两个 literal 的含义是“那个 driver execution 实际启动/收件”。当前 design execution 若直接写入，会得到文本相似但 provenance 错误的假阳性。

## Phase ownership

| Phase | 允许 | 禁止 |
|---|---|---|
| design | 文档、Mermaid、Founder HTML、review、TURN 回执 | 创建/修改 `probe.txt`；产品实现；PR/ship/deploy |
| implement | 先取得自己的 TURN；只在当前 native input 含明确 literal 时 append + local commit + structured report | 猜 marker；跨 execution 复制；push/PR/ship/deploy |
| qa（若误激活） | 只读核验 literal provenance、exact-line count、commit path | 补写 marker；打开 PR-bound approve/ship flow |

## Marker 提取与验证合同

接受两种无歧义输入：

1. `Append the exact line <marker> to probe.txt`：仅去掉固定前后 framing，中间字节不 trim、不 normalize。
2. `Exact marker lines:` 后唯一 fenced `text` block：fence 与换行是 framing，每个非空 interior line 是一个 marker。

任何重复 delimiter、混合 grammar、损坏 fence 或多义输入都必须回问 Lead。每条 marker 必须为 1..512 bytes 的 printable ASCII，排除 NUL、CR、LF 与 TAB。

## Append、幂等与 commit 合同

- 修改前再次运行当前 execution 的 `flywheel-comm turn`；非 `yours` 零写入。
- 直接检查 worktree 文件的 complete-line count：0 次才追加，1 次为幂等完成，2+ 次为 integrity error。
- 若现有非空文件末尾缺换行，拒绝 append，避免拼接两条记录。
- append 后每个 literal 必须恰好出现一次；staged diff 只能增加 expected marker lines，不能删除旧内容。
- local commit 的 changed-path list 必须只有 `probe.txt`；不 push，不建 PR。
- 对 `[lead-instruction <id>]` 的完成回执必须通过 `ask --report` 引用完整 instruction id；只有 TURN 时只报告 TURN，不声称 marker commit。

## 测试证据

该任务是纯文本传输探针，无需运行 package 或 repository test suite。完整证据集是：native instruction 原文、TURN receipt、complete-line count、staged diff、local commit tree 与结构化 report receipt。

## 结论

当前 design node 已满足 TURN acknowledgement，但没有 marker 内容可安全写入。Lead 已在问题 `05d33699-e084-4c26-84f1-f24b6093888b` 中确认：`probe.txt` 保持条件式下游交付物，只有后续实际收到 native exact literal 的 execution 才能按原字节本地追加；这样既符合 bounded transport 目标，也保持 no-product/no-PR/no-ship/no-deploy 边界。
