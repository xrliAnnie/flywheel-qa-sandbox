# FLY-3125 原生传输探针 — 调研
Issue: FLY-3125 (https://linear.app/geoforge3d/issue/FLY-3125/529-canary-fly2127-canary-23c3c581-a0f6-45a5-af84-804d707f1ed5-native)
日期: 2026-10-01
基于: exploration.md

## 调研问题

Issue 要求“append requested marker lines to probe.txt, commit locally, and acknowledge native mail or TURN”，但当前 design input 没有 marker literal。设计必须区分三个事实：当前 phase 是否持有 TURN、当前 execution 是否收到 native instruction、以及哪组字节才是可追加的 requested marker。

## 当前 execution 的权威证据

| 证据 | 当前值 | 能证明什么 |
|---|---|---|
| Execution | `551042d5-fe33-493d-b344-602864297c35` | 当前 design runner 身份 |
| TURN | `yours phase=design epoch=1` | 当前 phase 有共享 worktree 写权 |
| Activation | `activation:551042d5-fe33-493d-b344-602864297c35:271654a5-6362-471e-bed5-f47c3ee7c486:eng_design:1` | TURN 与 DAG activation 的绑定 |
| Native input | 无 exact marker literal | 当前没有可逐字追加的请求内容 |
| Mailbox onboarding check | `No instructions.` | 检查时没有待消费 Lead instruction |
| Repository | root `probe.txt` 不存在 | 无既有 marker 或恢复残留 |

TURN 是写权限，不是 marker 内容。Issue title、owner nonce、execution metadata、另一条 execution 的历史 evidence 都不能补齐缺失 literal。

## Driver 与历史 evidence 的边界

只读检查 `/Users/xiaorongli/Dev/flywheel-FLY-2127/scripts/qa-2127-codex-wake-canary.mjs`（head `980535c69a7c45a90c770cf1ef321ac0cbd55c21`）显示：

- driver 创建 issue 时只写通用描述，没有把 boot literal 放入 issue description；
- `launchCodex(c, "native")` 会把 `${owner.marker}-native-BOOT` 放入它启动的 native execution kick text；
- 后续 `nativeMail()` 为同一 execution 发送 `${owner.marker}-R1-*` / `R2-*` markers；
- acceptance 同时核验 native delivery ledger、mailbox ACK、Codex userMessage 与 `probe.txt` exact line。

同一 driver 的 `owner.json` 表明历史 native execution 是 `dfea80f2-03f5-4950-9b7d-902b7a927669`，与本 execution 不同。复制它的 boot marker只能复刻内容，不能证明当前 execution 收到 native delivery。

## Lead 决策

问题 `0b3a68be-66db-44eb-b0de-631568aa6ae4` 的答复明确要求：本 execution 不追加外部 driver 中的 expected boot literal；保持 `probe.txt` 不变，只完成 docs / review / HTML。只有后续 execution 收到绑定自身、来源可核验的 native exact-marker instruction 后才可按字节追加。

## Phase ownership

| Phase | 允许 | 禁止 |
|---|---|---|
| design | 文档、Mermaid、Founder HTML、review、TURN receipt | 创建或修改 `probe.txt`；产品实现；PR/ship/deploy |
| downstream execution | 先取得自己的 TURN；只按绑定自身的 native exact-marker instruction append + local commit | 猜 marker；跨 execution 复制；push/PR/ship/deploy |
| QA（若激活） | 只读核验 provenance、exact-line count、commit paths | 补写 marker；代替 writer 制造 evidence |

## Marker 输入合同

接受两种无歧义输入：

1. `Append the exact line <marker> to probe.txt`：只去掉固定 framing，中间字节不 trim、不 normalize。
2. `Exact marker lines:` 后唯一 fenced `text` block：每个非空 interior line 是一个 marker。

任何重复 delimiter、混合 grammar、损坏 fence 或多义输入都必须 fail closed。每条 marker 必须为 1..512 bytes printable ASCII，排除 NUL、CR、LF、TAB，以及首尾 ASCII 空格。

## Append、幂等与 commit 合同

- 写前再次执行当前 execution 的 `flywheel-comm turn`；只有 `yours` 可修改。
- 对既有 `probe.txt` 做 complete-line fixed-string count：0 次才追加，1 次视为已完成，2+ 次是 integrity error。
- 既有非空文件若无 final newline，拒绝 append，避免两条记录粘连。
- append 后 staged diff 只能新增 expected marker lines；commit changed-path list 必须只有 `probe.txt`。
- marker commit 保持 local-only，不 push、不建 PR；回执必须引用 native instruction id 与 path-filtered commit SHA。

## 测试证据

本 task 不修改 TypeScript 或产品行为，不运行 package/repository tests。Design phase 的证据是文档 frontmatter、Mermaid 本地渲染、HTML CSP/comment contract、`git diff --check`、effective design review 和发布 URL。Conditional marker phase 的完整证据是 native input、TURN receipt、exact-line count、staged diff 与 local commit tree。

## 结论

当前 design node 已通过 TURN acknowledgement 满足 “acknowledge native mail or TURN” 的后半条，但没有 marker 内容可安全写入。`probe.txt` 必须保持不存在；这样不会把历史 driver evidence 伪装成本 execution 的传输结果。
