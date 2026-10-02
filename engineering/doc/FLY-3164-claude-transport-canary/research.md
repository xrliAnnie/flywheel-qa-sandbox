# FLY-3164 Claude 传输探针 — 调研
Issue: FLY-3164 (https://linear.app/geoforge3d/issue/FLY-3164/529-canary-fly2127-canary-7b7c4e0e-f5ee-4fc2-ac0a-544468dfb145-claude)
日期: 2026-10-01
基于: exploration.md

## 调研问题

Issue 要求 “append requested marker lines to probe.txt, commit locally, and acknowledge native mail or TURN”。当前 design input 里没有任何 marker literal。设计必须把三件事拆开：

1. **谁可以写**——当前 phase 是否持有 TURN(共享 worktree 的写权令牌);
2. **写什么**——当前 execution 是否收到了一条发给它自己的原生指令(native instruction,即 Lead 经 Flywheel 邮箱送达本 execution 的消息);
3. **怎么证明**——哪组字节才算 “requested marker”,以及如何不经转抄地拿到它们。

## 当前 execution 的权威证据

| 证据 | 当前值 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| Execution | `d27c7945-fbe3-40f1-9144-99486f6fb84b` | 当前 design runner 身份 | — |
| Activation | `activation:d27c7945-…:b4d80259-…:eng_design:1` | TURN 与 DAG activation 的绑定 | — |
| TURN | `yours phase=design epoch=1` | 当前 phase 有共享 worktree 写权 | marker 内容 |
| Mailbox | `No instructions.`;comm DB 中与本 execution 相关的行 = 0(live / log / archive) | 本 execution 没收到 Lead 指令 | — |
| Native input | 无 exact marker literal | 没有可逐字追加的请求内容 | — |
| Repository | 根目录无 `probe.txt`;分支 = `origin/project-slot-5-FLY-3164` `b306fcf3a`(只含本文件夹的设计文档与 progress 提交，`origin/main` `7df383e6f` 为祖先) | 无既有 marker 或恢复残留 | — |

TURN 是写权限，不是 marker 内容。Issue 标题、owner nonce、execution metadata、另一条 execution 的历史证据都不能补齐缺失的 literal。

## FLY-2127 driver 的 Claude 通道边界

只读检查 `/Users/xiaorongli/Dev/flywheel-FLY-2127/scripts/qa-2127-codex-wake-canary.mjs`(HEAD `633d25e3c6bd96ec11025249ad1d717738bbb197`)中的 `claudeMail(c)`:

- `issueAndWorkspace(c, "claude")` 创建标题为 `[529 canary] <owner> claude` 的 issue,描述正是本 issue 的描述文字——**描述里没有 marker literal**;
- driver 用 `randomUUID()` 生成**它自己的** execution id,通过 `TmuxAdapter.execute(...)` 直接以 prompt 启动一个 Claude runner(`claude-fable-5-1`、`bypassPermissions`),工作目录是 driver 自建的 `canary-worktrees/qa-2127-…-claude`;
- 该 prompt 要求先追加 `<owner>-CLAUDE-BOOT`,再在 `sleep 45` 期间消费 Agent Team 原生消息、追加 `<owner>-R4-CLAUDE`,且明确 “Do not poll flywheel-comm inbox: prove the native Claude receive path”;
- 验收读取 driver 自己 worktree 里的 `probe.txt` 与 Claude 原生 teammate-message 收据。

本 execution(`d27c7945-…`)是 generalized workflow engine 为 `tpl_code` DAG 派发的 `eng_design` activation,工作目录是 slot-5 的 `project-slot-5-FLY-3164`,身份、prompt、工作区都不同。把 driver 的 literal 抄进本工作区，只能“复刻内容”,不能证明本 execution 收到原生投递。

## Claude runner 的原生指令投递路径

已核实(QA room runtime `b8c37fcfa1f1fe4395b1a79f50dc46f2970d838c`;本 execution `d27c7945-…` 重新逐行核对，runtime 与上一条 execution 相同，下面的行号均为本次实测值):

- `flywheel-comm send` 对 runner 收件人把 `to_agent` 解析为**目标 execution id**(`commands/send.js:17`,`resolvedTo = recipient.executionId`)。
- Bridge 的 runner mailbox lane 把 `instruction` row 渲染为 `content: "[lead-instruction <row.id>]\n<row.content>"`,`executionId = row.to_agent`(`teamlead/dist/bridge/runner-mailbox-lane.js:92-110` `renderRunnerMailboxEnvelope`);投递时 `vendor === "codex"` 走 Codex 原生通道，其他 backend 走 `wakeRunnerMailbox`(同文件 `:52-60`)。对 `claude-code` backend,这段信封进入 Claude Agent Team 原生收件箱，在 runner 对话中显示为一条 teammate message;注入的协议要求 runner 以 `[lead-instruction <id>]` 为幂等键。
- `flywheel-comm message-status <id> --json` 是 runner 可执行的只读收据(已实测：未知 id 返回 `location:"absent"` 并 exit 1)。
- `packages/flywheel-comm/dist/lib.js` 导出 `CommDB`;`CommDB.openReadonly(path)`、`getMessageById(id)`(读 `mailbox_message_projection`,只含 live 行)与 `inspectMailboxDeliveryContent(id)`(只读 `MailboxQueue`,live 行返回 `content`)均存在(`db.js:832 / 2367 / 677`;`inspectMailboxDeliveryContent` 委托 `MailboxQueue.inspectDeliveryContent`,`mailbox-queue.js:566`,live 行直接返回 `content`,只有归档行才回退到 `archivedMailboxJson`)。
- 行上还有 `content_ref` 字段：当正文过大时，发送方只在 `content` 存一个 `[content_ref: <path>]` 占位，真实字节在外部文件(`commands/gate.js:106-118`,目前只有 gate question 会这样做;`send` 不写 `content_ref`)。Lane 渲染信封时用的是 `row.content`,所以一旦 instruction 行带 `content_ref`,`content` 就不是 marker 原文。

因此 Claude 与 Codex 共用同一条**与厂商无关**的来源证据：信封里的 `[lead-instruction <id>]` 只是“指路牌”,真正的字节来源是 comm DB 中被核验过身份的那一行 `row.content`。Claude 对话里看到的 teammate-message 文本是渲染结果，可能被包装或截断，**绝不作为 parser 输入**。

## 可执行的来源核验(provenance)合同

1. 从当前 user turn 中定位**恰好一个**行首 sentinel `[lead-instruction <uuid>]`;0 个或多个都拒绝。只取 uuid,不取后面的显示文本。
2. 运行 `node "$FLYWHEEL_COMM_CLI" message-status "$instruction_id" --json`,要求 `message_id` 精确等于 uuid、`location = live`(writer 只接受 live 指令；只剩 archive 的旧指令要求重新投递)、`state ∈ {LEASED, ACKED}`、`stamps.delivered_at` 非空。
3. 在一个短生命周期 Node 进程里，从 `FLYWHEEL_COMM_CLI` 推导 runtime 根目录，动态 import `packages/flywheel-comm/dist/lib.js`,用**一个** `CommDB.openReadonly(FLYWHEEL_COMM_DB)` handle:
   - `row = getMessageById(id)`,要求 row 存在、`row.type === 'instruction'`、`row.to_agent === process.env.FLYWHEEL_EXEC_ID`、`row.from_agent === process.env.FLYWHEEL_LEAD_ID`,且 `row.content_ref` 为 `null`(带外部引用的行 fail closed,要求发送方用内联正文重发;不跟随文件路径读取);
   - `content = inspectMailboxDeliveryContent(id)`,要求 `content === row.content`(逐字节相等，任一为 undefined 即拒绝);
   - 把 `row.content` 以 UTF-8 写入 `mktemp -d` 私有目录下 mode `0600` 的 `source.bin`,`finally` 关闭 handle。
   内容不打印到终端、不进 shell 变量。由于 `getMessageById` 只看 live 行，只剩 archive 收据的旧指令会在这里失败，要求重新投递，而不是从 archive 复活一次陈旧写操作。
4. 对 `source.bin` 计算 sha256,随后 parser 只读这个文件。

身份绑定来自 DB 行断言，而不是消息正文里的自述文字。

## Marker 语法合同

`source.bin` 中只接受**恰好一种**无歧义格式：

1. 唯一一处 `Append the exact line ` 前缀与其后唯一一处 ` to probe.txt` 后缀之间的子串；
2. `Exact marker lines:` 之后唯一一个 ```` ```text ```` fenced block,其中每个非空内部行是一条 marker。

任何重复 delimiter、混用两种格式、fence 损坏、大小写不符或其他歧义都 fail closed,请发送方用支持的唯一格式重发；不做“猜测性规范化”。每条 marker 必须是 1..512 字节的可打印 ASCII(0x20–0x7E),不含 NUL/CR/LF/TAB,首尾不是空格；不 trim、不改写。marker 列表必须非空，并且按精确字节两两不同：fence 里出现两条相同的行时，在改动 `probe.txt` 或 index 之前整体拒绝、请求重发，不静默去重。否则“每条 marker 计数恰好为 1”的不变量会被输入本身打破，中断恢复时也会得到与一次跑完不同的结果。

(FLY-3125 还支持 Codex direct-kick 的 `First append the exact line …, then` 与 rework envelope 的小写形式；这两种只在 Codex direct-kick / rework 场景存在，本 DAG 的 Claude implement node 不会遇到，故不纳入，减少攻击面。)

## 追加、幂等与提交合同

- 写前再次运行 `flywheel-comm turn --exec-id "$FLYWHEEL_EXEC_ID"`;只有 `yours` 可写,`not-yours` 是正常等待态(每 60–90 秒轮询)。
- Parser 把每条 marker 以“精确字节 + 一个 LF”写进各自的临时文件，并校验该文件恰好一行。Marker 永远不进入 shell 源码、shell 变量、命令 argv、`eval`,也不经模型重新抄写。
- **文件计数 ≠ 已提交。**进程可能在 `cat` 之后、`commit` 之前中断，也可能在 commit 之后、回执之前中断。所以要同时看两个计数：工作区 `W`(`grep -cxF -f "$marker_file" probe.txt`)与 HEAD `H`(`git show HEAD:probe.txt | grep -cxF -f "$marker_file"`),再结合 `git status` / `git diff HEAD -- probe.txt` 判定状态：
  - `fresh`:全部 `W=0,H=0`,工作区与 HEAD 相同 → 追加 + 提交；
  - `appended_uncommitted`:全部 `H=0`、部分或全部 `W=1`,且未提交差异只新增本指令 marker → 补齐缺的行，再提交；
  - `already_committed`:全部 `W=1,H=1`,无未提交差异 → 不追加、不提交，按时间顺序遍历 `git log --reverse -- probe.txt` 找到第一个让计数从 0 变 1 的 commit,核验它只改 `probe.txt` 且只新增这些 marker,回报 `already_present` 并引用该 SHA;
  - 其他(计数 ≥2、`W=0,H=1`、混合或无法归属的差异、`probe.txt` 之外的未提交改动、非空文件无结尾 LF)→ 不写、不提交，报告 integrity error / 证据不足。
- 只用 `cat "$marker_file" >> probe.txt` 追加，所以反引号、`$()`、引号、反斜杠永远只是数据。
- 只有 staged delta 非空才 `git commit`;staged diff 只能新增预期的 marker 行、不删任何行；commit 的变更路径只能是 `probe.txt`。
- marker commit 只留在本地：不 push、不建 PR;本地分支含 marker commit 后，writer 不再 push 该分支(`flywheel-comm progress` 只做 `git commit --only -- progress.md`,不 push,不受影响)。回执引用 instruction id、writer exec id、Lead id、`source.bin` sha256、状态关键词与 marker commit SHA。

## 推送边界的来源

Issue 原文只对 marker 说 “commit locally”,并写明 “No product implementation, shipping or deployment”;它没有禁止推送设计文档。本 design node 的注入合同要求 “Commit and push the required artifacts” 与 “Commit and push the final HTML”,Bridge 的 review gate 也绑定已提交的 plan blob。因此：设计文档 commit + push 到 feature 分支(不碰 main、不建 PR);marker commit 只在本地。FLY-3122 / FLY-3125 的 design node 也是这样做的。

## 独立 QA 的审计合同

QA 是另一个 execution:它没有收到发给 writer 的指令，因此不能用自己的 `FLYWHEEL_EXEC_ID` 或当前 user turn 重跑 writer 的写入授权检查。QA 用**预期身份**核对：

- writer execution id 来自 workflow 记录(`workflow_run_node` 中 `implement` 节点的 `execution_id`),并与 writer DONE 回执的发送者一致；instruction id、Lead id、`source_sha256`、marker commit SHA 来自该回执。
- 归档快照同样要求 `content_ref` 为空(与 writer 规则一致)。
- `message-status` 允许 `location = archived`:writer 可能因路由不匹配长期 park,live 行会被归档。归档行的完整快照可用与 `MailboxQueue.archivedMailboxJson`(runtime `mailbox-queue.js:366`)相同的参数化只读查询取得(`mailbox_log` 中 `event='archived'` 的最新 `row_json`,否则 `mailbox_terminal_archive.mailbox_json`),其中包含 `type`、`from_agent`、`to_agent`、`content`。QA 断言这些字段与预期身份一致，且 `sha256(content)` 等于回执里的哈希。
- 用同一语法重新解析 `content`,核验 marker commit 只改 `probe.txt`、恰好新增这些 marker、无删除。
- “没有被 push”只能做**限定范围、当前时刻**的证明：用 `git ls-remote --heads origin refs/heads/project-slot-5-FLY-3164` 读取远端当前顶端 `T`(`git branch -r` 只看本地跟踪 ref,可能过期，不能作证据),要求 `T` 已在本地对象库，再用 `git merge-base --is-ancestor C T` 判断;网络失败或缺对象 → `unverifiable`。QA 不 fetch、不改 ref。“历史上从未推送”无法从 ref 状态证明，报告中标注为基于 writer 回执与守卫(receipt-based);其他分支 / 远端不在审计范围。
- 证据不可得 → `unverifiable`,绝不判 `pass`。审计历史结果不授予写权限;writer 对 archive-only 指令拒绝新写入的规则保持不变。
- **报告出口。**当前 runtime 给 QA 注入的收尾动作是 `qa-result --status pass|fail … && ask --report …`(`edge-worker/dist/Blueprint.js:1281-1298`)。`qa-result` 只接受 `pass|fail`(`flywheel-comm/dist/commands/qa-result.js:20,497-501`),在 `qa → founder_gate` 路径上 PASS 还要核验 PR 身份(`teamlead/dist/bridge/workflow-decision-routes.js`),遇到 `land_head_pr_not_at_tip` 还会执行授权推送。本 issue 没有 PR 且禁止 push,所以 QA 把三态结果写进 `ask --report` 正文，并注明它只是审计报告、不是已被接受的 workflow verdict;不运行通用 `qa-result` closeout,不把 `unverifiable` 硬映射为 `fail`,不补 PR。若注入协议坚持要求该动作，就与 implement 一样报告 capability mismatch 并 park,交给 workflow owner。

## Workflow 能力不匹配

本 run 的 `tpl_code` 快照(只读 `workflow_run`):

| Node | Dispatch | creates_pr | completion_route |
|---|---|---|---|
| `eng_design` | claude / `claude-opus-5-5` | 0 | `phase_design_complete` |
| `implement` | claude / `claude-opus-5-5` | 1 | `needs_review` |
| `qa` | codex / `gpt-5.6-sol` | 0 | `no_code` |
| `founder_gate` | — | 0 | `needs_review` |
| `land` | — | 0 | `no_code` |

`implement` 的正常完成路线要求 PR,而本 issue 禁止 PR / push / ship;各 node 都没有 `allow_no_code_completion`。所以下游不得假设存在 `no_code` 出口，也不得造空 commit 或 PR。无论是否追加成功,implement runner 都应把“结果 + 能力不匹配”用结构化回执交给 Lead / workflow owner,然后按注入的问题 watcher 停靠(park),由 owner 决定 server 授权的 close / cancel / retemplate。

这一点已由本 execution 以非阻塞问题 `58b9d751-487d-490d-a40d-e5a843b94edc` 告知 Lead(前两条 execution 的同类问题 `6a9a1905-…` / `e63f0895-…` 属于已重建的旧 comm DB,不再可查)。Lead 已回复(response `a76594d5-b9f6-4d6c-adf0-41809ffb6fe3`):确认按夹具原样执行——design 阶段不猜测、不写 marker;implement 只接受发给其自身 execution、来源可核验的 `[lead-instruction <id>]` 中的 inline marker;`creates_pr=true` / `needs_review` 与禁止 PR、push、ship 冲突时，明确报告 capability mismatch 后 park,不发明 `no_code` 路由，也不创建空 PR。

## 测试证据

本 issue 不修改 TypeScript 或任何产品行为，不跑 package / repository 测试套件。Design phase 的证据是：文档抬头、Mermaid 本地渲染、HTML 的 CSP / 评论层合同检查、`git diff --check`、有效 design review、发布 URL 的 HTTP 校验。下游 marker phase 的证据是：指令 id、`message-status` 收据、row 身份断言、`source.bin` 哈希、exact-line 计数、staged diff 与本地 commit tree。

## 结论

本 design node 通过 TURN 回执满足 “acknowledge … TURN”,但没有可安全写入的 marker 字节,`probe.txt` 在 design phase 保持不存在。这样既不会把 driver 的历史预期伪装成本 execution 的传输结果，也给下游留下一份能被独立 QA 复核的追加合同。
