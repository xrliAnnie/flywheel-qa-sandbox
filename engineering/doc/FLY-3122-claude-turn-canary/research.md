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
- `flywheel-comm inbox --exec-id 25a9c143-167d-4bf0-ad1c-4c3a24c44ece` 返回 `No instructions.`。
- comm mailbox 没有送给本 execution 的 Claude BOOT / R4 literal；root `probe.txt` 当前不存在。

这些证据只支持“当前 Codex design execution 收到 TURN”，不支持“Claude execution 启动”或“Claude native teammate-message 被消费”。

## 外部 driver 证据及适用范围

FLY-2127 canary driver 不在本 sandbox repository 的当前树中。只读核验来源是：

- absolute path: `/Users/xiaorongli/Dev/flywheel-FLY-2127/scripts/qa-2127-codex-wake-canary.mjs`
- inspected repository HEAD: `980535c69a7c45a90c770cf1ef321ac0cbd55c21`
- relevant function: `claudeMail()`，约 lines 1386–1562

该函数创建自己的 `claude-code` execution。它在 initial prompt 中提供 `${owner.marker}-CLAUDE-BOOT` literal，再用 `flywheel-comm send` 把 `${owner.marker}-R4-CLAUDE` 投给同一 execution，并要求 transcript 中出现 native `<teammate-message>`。Driver 还要求 `probe.txt` 包含完整 marker 行、mailbox row 为 `ACKED`、Git worktree 干净，才记录 `R4-claude PASS`。

因此，driver literals 是那个 execution 的 receipt，不是从 issue title 可继承的普通值。把它们写入当前 design worktree 会绕过其 native-message、ACK 和 identity 证明，造成假阳性。

## Phase ownership

| Phase | 允许的动作 | 禁止的动作 |
|---|---|---|
| design | exploration / research / plan / Founder HTML / review | 创建或修改 `probe.txt`；实现交付物 |
| implement | 先取得自己的 TURN；只消费明确送达本 execution 的 exact marker instruction | 推导、猜测或跨 execution 复制 marker；创建 PR 或 ship |
| qa | 只验证实际 commit 与 provenance | 自己补 marker 或修 implementation |
| any later phase | 遵守本 issue 的 no product implementation / no shipping / no deployment 边界 | 把模板能力当作授权 |

## 数据与结构模型

| 对象 | 关键字段 | 证明什么 |
|---|---|---|
| Current execution | exec id、vendor、phase | 谁正在执行、能做哪类动作 |
| TURN receipt | result、epoch、activation | 当前 phase 是否获得共享工作树写权 |
| Lead instruction（可选） | instruction id、recipient、exact line | marker 的唯一写入授权与 provenance |
| Probe commit（可选，下游） | branch、commit、exact-line evidence | implement node 实际追加了被请求的 line |
| Design evidence | docs commit、review request/verdict、hosted report | design phase 完成依据 |

## 安全与负向守卫

- Design phase 的 allowed-path audit 必须证明没有 `probe.txt` 变更。
- 任何写入节点都先运行自己的 `flywheel-comm turn`；只有 `yours` 允许修改共享 worktree。
- 收到 marker 后保存其 raw literal，不把用户、issue、repo 或工具输出拼进 HTML 或脚本；HTML 内展示的固定 issue 数据也要转义。
- 若 `probe.txt` 存在，直接检查工作树文件：`grep -nxF -- "$marker_line" probe.txt`。这能看到 untracked recovery residue，不只依赖 Git index。
- zero match 才追加一次；one match 是幂等 no-op；multiple matches 是 integrity error，必须报告而不是再写。
- append 前验证 non-empty、单行、无 NUL/CR/LF，长度不超过 512 bytes，并保留现有内容；commit 前逐字完整行计数等于一。
- 没有 exact instruction 时不创建空 commit、不写占位 marker、不复用外部 driver literal。
- 收到 `[lead-instruction <id>]` 后必须在完成时通过 `ask --report` 引用完整 id；只有 TURN 回执而无 instruction 时，只报告 TURN 已确认和没有 marker，不声称有 probe commit。
- 不运行本地 test suite。纯文本 probe 的证据是 literal provenance、complete-line count、diff、commit tree 和结构化 receipt。

## 结论

当前 phase 的真实完成状态应是“TURN 已确认、设计产物已提交并经过审查”。`probe.txt` 是条件式下游交付物：只有其实际写入 execution 收到明确 literal 后才能出现。当前没有 marker instruction，所以 design 不写 probe。Lead 对问题 `861c3d24-e859-4352-bd91-93fc3e4af0c1` 的答复已经逐项确认这一边界与 no-PR / no-ship / no-deploy 限制。
