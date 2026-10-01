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

只接受当前 execution 的已验证 instruction 中恰好一种无歧义 grammar：

1. `Append the exact line <marker> to probe.txt`；
2. authorized rework envelope 中的 `append the exact line <marker> to probe.txt`；
3. direct native driver kick 中的 `First append the exact line <marker>, then`，且该 kick 必须绑定同一 execution；
4. `Exact marker lines:` 后唯一 fenced `text` block，其中每个非空 interior line 是一个 marker。

固定 framing 之外的 marker bytes 不 trim、不 normalize。任何重复 delimiter、混合 grammar、损坏 fence、不支持的大小写或多义输入都必须 fail closed，并请求发送方以支持的唯一 grammar 重发。历史 driver source 本身永远不是 instruction。每条 marker 必须为 1..512 bytes printable ASCII，排除 NUL、CR、LF、TAB，以及首尾 ASCII 空格。

## 可执行 provenance 检查

**Managed snapshot** 是由 Flywheel helper 创建的只读数据库副本；它避免直接复制或持有 live `comm.db`。Mailbox instruction 分支必须先从当前 user turn 取得 `[lead-instruction <uuid>]`，再执行：

```bash
RUNTIME_ROOT=$(cd "$(dirname "$FLYWHEEL_COMM_CLI")/../../.." && pwd -P)
node "$RUNTIME_ROOT/scripts/flywheel-snapshot-control.mjs" runner \
  --source "$FLYWHEEL_COMM_DB" --kind comm --project "$FLYWHEEL_PROJECT_NAME"
```

从 JSON 结果取得 snapshot path，以 `$RUNTIME_ROOT/packages/flywheel-comm/node_modules/better-sqlite3` 只读打开，并用参数化 SQL 绑定 instruction id、`$FLYWHEEL_EXEC_ID`、`$FLYWHEEL_LEAD_ID`：

```sql
SELECT id, from_agent, to_agent, recipient_kind, type, content,
       delivery_content, delivery_disposition, state, carrier,
       delivered_at, acked_at
FROM mailbox
WHERE id = ? AND to_agent = ? AND from_agent = ?
  AND recipient_kind = 'runner' AND type = 'instruction'
  AND carrier = 'inbox' AND delivery_disposition = 'model'
```

必须恰好返回一行，`state` 为 `LEASED` 或 `ACKED`，且 `delivered_at` 非空。当前 envelope 必须逐字等于 `[lead-instruction ${row.id}]\n${row.content}`；用于证据摘要的 hash 只覆盖 `mailbox.content` 的 UTF-8 bytes。任一条件不符即拒绝写入。关闭数据库 handle 后执行 `node "$RUNTIME_ROOT/scripts/flywheel-snapshot-control.mjs" release`；禁止 `cp` live database。

Direct kick 分支没有 mailbox row，因此不得伪造 mailbox evidence。它只在当前 turn 本身包含 marker、当前 execution id 等于 `$FLYWHEEL_EXEC_ID`、并且 runtime 的 immutable `launchSnapshot.executionId` 与 `kickText` 分别逐字匹配该 execution 和当前 kick 时成立；同时记录 `kickText` 的 UTF-8 hash。若当前 `turn` 表明这是 DAG phase，则 DAG contract 胜出，不能仅凭 `launchSnapshot.phaseRole=null` 降级成 direct fixture。任一 snapshot 字段缺失或不一致即拒绝。

## 指令优先级与拒绝路径

当前注入的 execution / phase contract 最高优先。Direct native fixture（`phaseRole=null`）的同 execution kick 若明确要求不调用 comm，则走它的 native goal / fixture 回执；DAG node 则必须遵守注入的 `flywheel-comm` report 与 phase route。另一 execution 的 driver 文本、历史源码或相冲突的“不要 report”文案没有授权力。若 execution 类型、grammar 或回执要求无法同时证明，Writer 不猜测：不写文件、不创建 commit，向 Lead / workflow owner 报告冲突并 park 等待替换指令。

## Append、幂等与 commit 合同

- 写前再次执行当前 execution 的 `flywheel-comm turn`；只有 `yours` 可修改。
- Parser 把每条已验证 marker 作为 exact bytes 加一个 LF 写入独立 temp file；marker 从不进入 shell source 或 shell variable。
- 对既有 `probe.txt` 用单行 pattern file 执行 `grep -nxF -f "$marker_file" probe.txt` 与 `grep -cxF -f "$marker_file" probe.txt`：0 次才追加，1 次视为已完成，2+ 次是 integrity error。
- 既有非空文件若无 final newline，拒绝 append，避免两条记录粘连。
- 只用 `cat "$marker_file" >> probe.txt` 追加，因此 backtick、`$()`、引号和反斜杠始终只是 printable-ASCII 数据。
- append 后 staged diff 只能新增 expected marker lines；commit changed-path list 必须只有 `probe.txt`。
- marker commit 保持 local-only，不 push、不建 PR；回执必须引用 native instruction id 与 path-filtered commit SHA。

## 无 marker 时的 workflow 边界

当前 workflow template 是 `tpl_code`：标准 completion route 是 `needs_review`，能力要求 PR，且没有 `allow_no_code_completion`。因此无 exact marker 时不得假设存在 `no_code` exit，也不得制造空 commit 或 PR。Runner 必须 fail closed：用结构化 report 把“no marker + capability mismatch”交回 workflow owner，随后为该 question 启动 watcher 并 park。若已产生合规的 local-only marker commit，bounded task 仍禁止 push / PR，标准 route 同样不适用；报告精确 SHA 后 park，由 workflow owner 使用 server-authorized close、cancel 或 retemplate。Runner 不自行发明 completion route。

## 测试证据

本 task 不修改 TypeScript 或产品行为，不运行 package/repository tests。Design phase 的证据是文档 frontmatter、Mermaid 本地渲染、HTML CSP/comment contract、`git diff --check`、effective design review 和发布 URL。Conditional marker phase 的完整证据是 native input、TURN receipt、exact-line count、staged diff 与 local commit tree。

## 结论

当前 design node 已通过 TURN acknowledgement 满足 “acknowledge native mail or TURN” 的后半条，但没有 marker 内容可安全写入。`probe.txt` 必须保持不存在；这样不会把历史 driver evidence 伪装成本 execution 的传输结果。
