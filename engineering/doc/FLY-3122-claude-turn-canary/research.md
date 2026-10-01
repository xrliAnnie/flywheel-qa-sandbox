# FLY-3122 Claude 标签传输探针 — 调研
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: exploration.md

## 调研问题

Issue 要求“append requested marker lines to probe.txt, commit locally, and acknowledge native mail or TURN”，但正文没有 literal，当前 mailbox 也没有 marker instruction。需要区分：哪个 execution 收到了什么、TURN 授权了什么、以及哪个 phase 可以写交付物。

## 当前 execution 的权威事实

- `FLYWHEEL_EXEC_ID=25a9c143-167d-4bf0-ad1c-4c3a24c44ece`。
- `FLYWHEEL_RUNNER_VENDOR_ID=codex`；动态节点是 `eng_design`，不是 `claude-code` fixture。
- `flywheel-comm turn` 返回 `yours phase=design epoch=1 node=eng_design attempt=1`。
- Design onboarding 时 `flywheel-comm inbox --exec-id 25a9c143-167d-4bf0-ad1c-4c3a24c44ece` 返回 `No instructions.`；这只描述当前 design execution，当时也没有 native marker input。它不是下游 native-receive 证明，不能作为 implement 的 marker discovery 步骤。
- comm mailbox 没有送给本 execution 的 Claude BOOT / R4 literal；root `probe.txt` 当前不存在。

这些证据只支持“当前 Codex design execution 收到 TURN”，不支持“Claude execution 启动”或“Claude native teammate-message 被消费”。

## 外部 driver 证据及适用范围

FLY-2127 canary driver 不在本 sandbox repository 的当前树中。只读核验来源是：

- absolute path: `/Users/xiaorongli/Dev/flywheel-FLY-2127/scripts/qa-2127-codex-wake-canary.mjs`
- inspected repository HEAD: `980535c69a7c45a90c770cf1ef321ac0cbd55c21`
- relevant function: `claudeMail()`，约 lines 1386–1562

该函数创建自己的 `claude-code` execution。它在 initial prompt 中提供 `${owner.marker}-CLAUDE-BOOT` literal，再用 `flywheel-comm send` 把 `${owner.marker}-R4-CLAUDE` 投给同一 execution，并要求 transcript 中出现 native `<teammate-message>`。Driver 还要求 `probe.txt` 包含完整 marker 行、mailbox row 为 `ACKED`、Git worktree 干净，才记录 `R4-claude PASS`。

因此，driver literals 是那个 execution 的 receipt，不是从 issue title 可继承的普通值。把它们写入当前 design worktree 会绕过其 native-message、ACK 和 identity 证明，造成假阳性。

## Native carrier 与 inbox 的差异

当前 QA-room runtime 的 `runner-mailbox-lane.ts` 把 instruction 原生投递为 `[lead-instruction <id>]\n<content>`：Claude 看到 teammate-message，Codex 看到 durable phase-wake/user-turn input。原生投递完成后 mailbox row 已 ACK，`flywheel-comm inbox` 的查询只返回 `QUEUED` / `LEASED`，所以它会显示 `No instructions.`。

反过来，若 row 仍是 `QUEUED` / `LEASED`，`inbox` 会在同一 transaction 中 ACK，并把 consumption carrier 记为 `inbox`。因此对要求 native proof 的 canary 调 `inbox` 有两种错误结果：要么漏掉已原生投递的 instruction，要么抢先消费尚未原生投递的 instruction。下游必须从当前 user turn 的 native envelope 取 id 与 raw body；若 native input 不存在，只能记录 TURN 并 park，不能用 `inbox` 代替。

Marker 不是整句 instruction。Driver 的 canonical body 是 `Append the exact line <marker> to probe.txt ...`，所以 `<marker>` 是固定 prefix / suffix 中间的字节 substring。另一种允许形态是 `Exact marker lines:` 后唯一的 fenced `text` block。只删除这两种 grammar 的 framing；任何歧义都回问 Lead，不猜值。

## Phase ownership

| Phase | 允许的动作 | 禁止的动作 |
|---|---|---|
| design | exploration / research / plan / Founder HTML / review | 创建或修改 `probe.txt`；实现交付物 |
| implement | 先取得自己的 TURN；从 native input 消费明确送达本 execution 的 instruction；本地提交后 report + park 等 Lead close/cancel | 用 `inbox` 替代 native proof；推导、猜测或跨 execution 复制 marker；创建 PR 或 ship |
| qa | 正常不应被 dispatch；若已激活，只走 no-PR evidence report + park | 自己补 marker、发 PR-bound qa-result、开 approve gate 或修 implementation |
| any later phase | 遵守本 issue 的 no product implementation / no shipping / no deployment 边界 | 把模板能力当作授权 |

## 数据与结构模型

| 对象 | 关键字段 | 证明什么 |
|---|---|---|
| Current execution | exec id、vendor、phase | 谁正在执行、能做哪类动作 |
| TURN receipt | result、epoch、activation | 当前 phase 是否获得共享工作树写权 |
| Native Lead instruction（可选） | instruction id、recipient、raw body、carrier | marker 的唯一写入授权与 provenance |
| Progress receipt | instruction id、raw body、received/done、probe SHA | crash / at-least-once redelivery 去重 |
| Probe commit（可选，下游） | branch、commit、exact-line evidence | implement node 实际追加了被请求的 line |
| Design evidence | docs commit、review request/verdict、hosted report | design phase 完成依据 |

## 安全与负向守卫

- Design phase 的 allowed-path audit 必须证明没有 `probe.txt` 变更。
- 任何写入节点都先运行自己的 `flywheel-comm turn`；只有 `yours` 允许修改共享 worktree。
- 从 native envelope 取得 instruction id 与完整 raw body，并在任何 probe mutation 前通过 progress ledger 持久化；同 id 已为 `done` 时不重复写、不重复 DONE report。
- 只按两种 grammar 提取 marker：canonical `Append the exact line ` … ` to probe.txt` substring，或 `Exact marker lines:` 后唯一的 fenced `text` block。提取只去掉 framing，不 trim / normalize 内容；歧义时回问 Lead。
- 每条 marker 必须是 1..512 bytes、只含 printable ASCII `0x20..0x7e`，因此 NUL / CR / LF / TAB 都被拒绝。该规则与实施计划一致。
- 不把用户、issue、repo 或工具输出拼进 HTML 或 nonced script；HTML 内展示的固定 issue 数据也要转义。
- 若 `probe.txt` 存在，直接检查工作树文件：`grep -nxF -- "$marker_line" probe.txt`。这能看到 untracked recovery residue，不只依赖 Git index。
- zero match 才追加一次；one match 是幂等 no-op；multiple matches 是 integrity error，必须报告而不是再写。
- append 前保留现有内容；commit 前逐字完整行计数等于一。新建 untracked `probe.txt` 时必须在 `git add` 后检查 cached diff，证明只增加 extracted marker 行、零删除。
- one match 是幂等 no-op：用 `git log -S "$marker_line" -- probe.txt` 找实际 introducing commit，绝不创建空 commit，也不把更晚的 progress/docs HEAD 当 probe SHA。
- 没有 exact instruction 时不创建空 commit、不写占位 marker、不复用外部 driver literal。
- 收到 `[lead-instruction <id>]` 后必须在完成时通过 `ask --report` 引用完整 id；只有 TURN 回执而无 native instruction 时，只报告 TURN 已确认和没有 marker，不声称有 probe commit。
- 当前 DAG 的 implement route 是 PR-bound `needs_review`，与 no-PR scope 冲突；probe commit 后不伪造 complete route，而是 DONE report、请求 Lead close/cancel、park 并结束当前 turn。QA 若被误激活，同样只做 no-PR report + park。
- 不运行本地 test suite。纯文本 probe 的证据是 literal provenance、complete-line count、diff、commit tree 和结构化 receipt。

## 结论

当前 phase 的真实完成状态应是“TURN 已确认、设计产物已提交并经过审查”。`probe.txt` 是条件式下游交付物：只有其实际写入 execution 收到明确 literal 后才能出现。当前没有 marker instruction，所以 design 不写 probe。Lead 对问题 `861c3d24-e859-4352-bd91-93fc3e4af0c1` 的答复已经逐项确认这一边界与 no-PR / no-ship / no-deploy 限制。
