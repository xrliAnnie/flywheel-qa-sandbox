# FLY-3122 Claude 标签传输探针 — 调研
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: exploration.md

## 调研问题

Issue 要求“append requested marker lines to probe.txt, commit locally, and acknowledge native mail or TURN”，但正文没有 literal，当前 mailbox 也没有 marker instruction。必须回答三件事：哪个 execution 收到了什么、design 是否能写交付物、后续 DAG 是否符合 no-shipping 边界。

## 当前 execution 的权威事实

- `FLYWHEEL_EXEC_ID=4514c33a-ba5c-4eb3-a046-08bb14e6b209`。
- `FLYWHEEL_RUNNER_VENDOR_ID=codex`；动态节点是 `eng_design`，不是 `claude-code` fixture。
- `flywheel-comm turn --exec-id "$FLYWHEEL_EXEC_ID"` 返回 `yours phase=design epoch=1`。
- `flywheel-comm inbox --exec-id "$FLYWHEEL_EXEC_ID"` 返回 `No instructions.`。
- comm mailbox 没有送给本 execution 的 Claude BOOT / R4 literal；root `probe.txt` 当前不存在。

这些证据只支持“当前 Codex design execution 收到 TURN”，不支持“Claude execution 启动”或“Claude native teammate-message 被消费”。

## 外部 driver 证据及其适用范围

FLY-2127 canary driver 不在本 sandbox repository 的任何 ref 中。可审计来源是：

- absolute path: `/Users/xiaorongli/Dev/flywheel-FLY-2127/scripts/qa-2127-codex-wake-canary.mjs`
- source commit: `a6174863d1889d009ed3d635a8d633afdea55245` (`test: bind canary receipts to actual runner identities`)
- relevant function: `claudeMail()`，约 lines 1386–1555

该函数创建自己的 `claude-code` execution。它在 initial prompt 中提供 BOOT literal，再用 `flywheel-comm send` 把 R4 literal 投给同一 execution，并要求 transcript 中出现 native `<teammate-message>`。因此这些 literals 是那个 execution 的 receipt，不是从 issue title 可继承的普通值。

结论：外部 driver 可解释 issue title 的来源，但不能授权本 Codex execution 写它的 literals。

## Phase ownership

当前 DAG 把职责拆开：

| Phase | 允许的动作 | 禁止的动作 |
|---|---|---|
| design | exploration / research / plan / Founder HTML / review | 创建或修改 `probe.txt`；实现交付物 |
| implement | 先取得自己的 TURN；只消费明确送达本 execution 的 exact marker instruction | 推导、猜测或跨 execution 复制 marker |
| qa | 只验证实际 commit 与 provenance | 自己补 marker 或修 implementation |
| founder_gate / land | 必须服从 issue no-shipping 边界与 Lead resolution | 把 template capability 当作 ship authority |

## 下游 template 不匹配

本 run 选中的 `tpl_code` 包含 creates-PR implement、QA、founder gate 和可 land 节点；Issue 却明确写着 “No product implementation, shipping or deployment”。这是编排层不匹配，不是 design node 可以自行改写的授权。

已向 Lead 发出问题 `2add653c-7fb8-4cdd-ae4e-67651c476e39`，请求选择：

1. cancel / re-route 到 bounded transport fixture；或
2. 明确把 downstream 限制为 no-PR / no-ship，并在 founder gate 关闭该路径。

在 Lead resolution 前，计划必须明确禁止 downstream 创建 PR、请求 ship 或 land；design node 仍按自己的 phase contract 完成文档、审查和 Founder HTML，不擅自 dispatch 或 terminalize 整个 issue。

## 数据与结构模型

| 对象 | 字段 | 证明什么 |
|---|---|---|
| Current execution | exec id、vendor、phase | 谁正在执行、能做哪类动作 |
| TURN receipt | result、epoch、activation | 当前 phase 是否获得共享工作树写权 |
| Lead instruction（可选） | instruction id、to execution、exact line | marker 的唯一写入授权与 provenance |
| Probe commit（可选，下游） | branch、commit、exact-line evidence | implement node 实际追加了被请求的 line |
| Design evidence | docs commit、review request/verdict、hosted report | design phase 完成依据 |

## 负向守卫

- Design phase 的 allowed-path audit 必须证明没有 `probe.txt` 变更。
- TURN command 使用 `--exec-id "$FLYWHEEL_EXEC_ID"`；只判断输出 `yours`，不写死 phase。
- 若 `probe.txt` 存在，把 instruction 中的 exact line 保存为 `marker_line`，直接检查工作树文件：`grep -nxF -- "$marker_line" probe.txt`；不用只看 tracked files 的 `git grep`。
- 没有 exact Lead instruction 时不创建空 commit、不写占位 marker、不复用外部 driver literal。
- 收到 Lead instruction 后，把完整 id 保存为 `instruction_id`；只有当前 TURN holder 才能修改，并在完成后用 `ask --report "DONE: [lead-instruction ${instruction_id}] acted on the exact delivered marker | commits: ${commit_sha} | PR: n/a"` 回执。
- 不创建 PR、不请求 ship、不合并、不部署，除非 Lead 对模板不匹配给出新的明确 scope；该新 scope 也不能由 design node自行假设。

## 结论

本 phase 的真实完成状态是“TURN 已确认、设计产物已提交并经过审查”。`probe.txt` 是一个条件式下游交付物：只有本 execution 链路收到明确 literal 后才能出现。当前没有 marker instruction，所以 design 不写 probe。
