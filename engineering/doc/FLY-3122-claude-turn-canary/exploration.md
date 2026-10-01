# FLY-3122 Claude 标签传输探针 — 探索
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: 无

## 一句话结论

本 design node 只证明当前 Codex execution 收到了 server-authorized TURN，并产出经过审查的下游合同；它不创建 `probe.txt`，也不把属于另一条 Claude fixture 的 marker 冒充成本 execution 的回执。

## 已确认事实

- Issue title 末尾的 `claude` 是 canary case 标签，不是当前执行体 vendor。当前环境的 `FLYWHEEL_RUNNER_VENDOR_ID=codex`，当前节点是 `eng_design`。
- `flywheel-comm turn --exec-id "$FLYWHEEL_EXEC_ID"` 返回 `yours phase=design epoch=1`；这只授权当前 design node 写它自己的设计产物。
- 当前 mailbox 返回 `No instructions.`。没有 Lead message 为 execution `4514c33a-ba5c-4eb3-a046-08bb14e6b209` 指定任何 marker literal。
- root `probe.txt` 不存在，worktree 在文档提交后保持干净。
- FLY-2127 外部 driver 中的 Claude BOOT / R4 literals 绑定它自己用 `TmuxAdapter` 启动的 `claude-code` execution 和原生 teammate-message 回执，不能跨 execution 复用。

## 成功标准

1. Design phase 只提交 `exploration.md`、`research.md`、`plan.md`、Founder HTML、Mermaid sources 与 `progress.md`；不创建或修改 `probe.txt`。
2. 计划明确要求所有执行节点用自己的 `$FLYWHEEL_EXEC_ID` 取得 TURN，不硬编码 design execution 或 phase。
3. 只有当 Lead instruction 明确给出 exact marker line 时，下游 implement node 才能逐字追加该 line；没有指令就保持 `probe.txt` 不存在或不变。
4. Design review 必须在 design docs 已提交、index/worktree 干净时绑定；`CHANGES_REQUESTED` 修复后用新 gate 和新 request 重审。
5. 本 issue 明示 no shipping / no deployment；当前 `tpl_code` template 却包含 creates-PR、founder-gate 和 land。该不匹配必须报告 Lead，且不能由 design node 擅自扩权或假装不存在。

## 备选方案

### A. TURN receipt + 条件式 Lead marker（采用）

Design node 记录 TURN `yours`，并给下游节点一个明确条件：只有当前 execution 的 Lead message 提供 literal 才追加。这保留了真实 provenance，不会制造 canary 假阳性。

### B. 从外部 driver 推导 Claude BOOT / R4 marker（拒绝）

这些 literal 代表另一个 `claude-code` execution 的启动和原生 teammate-message 接收。当前 Codex design execution 没经历这两件事，写入等于伪造证据。

### C. Design node 直接写 probe（拒绝）

`eng_design` 的节点合同明确禁止实现。即使 marker 正确，也应由持有自己 TURN 的 implement node 执行；design review 必须先于交付物变更。

### D. 默认让 `tpl_code` 一路 PR → ship（拒绝）

Issue 明示 no shipping / deployment。Lead 尚未决定 re-route、cancel 或给 downstream 增加 no-PR/no-ship 限制，因此不能把 template capability 当作授权。

## 设计边界

本设计证明的是当前 design node 的 TURN 接收、身份判断、审查流程与诚实的下游合同。它不证明 Claude native mailbox 投递，不修改 FLY-2127 产品代码，不创建 probe marker，不创建 PR，不请求 ship，也不部署。
