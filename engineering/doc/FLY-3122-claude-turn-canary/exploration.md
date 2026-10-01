# FLY-3122 Claude 标签传输探针 — 探索
Issue: FLY-3122 (https://linear.app/geoforge3d/issue/FLY-3122/529-canary-fly2127-canary-eeb549be-1af1-44c6-93d3-a0cb7f40022c-claude)
日期: 2026-10-01
基于: 无

## 一句话结论

本 design node 只证明当前 Codex execution 收到了 server-authorized TURN，并产出经过审查的下游合同；它不创建 `probe.txt`，也不把属于另一条 Claude fixture 的 marker 冒充成本 execution 的回执。

## 已确认事实

- Issue title 末尾的 `claude` 是 canary case 标签，不是当前执行体 vendor。当前环境的 `FLYWHEEL_RUNNER_VENDOR_ID` 是 `codex`，当前节点是 `eng_design`。
- `flywheel-comm turn` 返回 `yours phase=design epoch=1`，activation 为 `activation:25a9c143-167d-4bf0-ad1c-4c3a24c44ece:d70e3488-f6e3-41d4-a3ec-2f7dc2b906ec:eng_design:1`；这只授权当前 design node 写它自己的设计产物。
- 当前 design turn 没有 native marker input；onboarding 的 mailbox 检查也返回 `No instructions.`。后者只描述 design 现状，不是下游 native-receive 证据。
- root `probe.txt` 不存在，初始分支与 `origin/main` 同 head。
- FLY-2127 外部 driver 中的 Claude BOOT / R4 literals 绑定 driver 自己用 `TmuxAdapter` 启动的 `claude-code` execution 和原生 teammate-message 回执，不能跨 execution 复用。
- Lead 已通过问题 `861c3d24-e859-4352-bd91-93fc3e4af0c1` 确认条件式合同：当前没有可验证的 exact marker literal，design 不写 `probe.txt`；仅由后续实际收到明确 literal 的 execution 原样追加，并且不做 PR、ship 或 deploy。

## 成功标准

1. Design phase 只提交 `exploration.md`、`research.md`、`plan.md`、Founder HTML、Mermaid sources 与 `progress.md`；不创建或修改 `probe.txt`。
2. 计划明确要求所有执行节点用自己的 execution identity 取得 TURN，不硬编码 design execution 或 phase。
3. 只有当下游 implement node 在自己的 native user-turn input 中收到 `[lead-instruction <id>]`，并按唯一 grammar 提取出 exact marker line 时，才逐字追加；不得用 `flywheel-comm inbox` 抢占或替代 native proof。没有 native instruction 就保持 `probe.txt` 不存在或不变并 park。
4. Design review 必须绑定已提交的 plan bytes；`CHANGES_REQUESTED` 修复后使用新的 gate 和 review request。
5. 本 issue 明示 no product implementation / shipping / deployment，所有后续动作都必须保持这一边界。

## 备选方案

### A. TURN receipt + 条件式 Lead marker（采用）

Design node 记录 TURN `yours`，并给下游节点一个明确条件：只有当前 execution 的 native Lead envelope 提供 literal 才追加；本地 commit 后 report + park，由 Lead close/cancel no-PR workflow。这保留了真实 provenance，不会制造 canary 假阳性或留下无终态节点。

### B. 从外部 driver 推导 Claude BOOT / R4 marker（拒绝）

这些 literal 代表另一个 `claude-code` execution 的启动和原生 teammate-message 接收。当前 Codex design execution 没经历这两件事，写入等于伪造证据。

### C. Design node 直接写 probe（拒绝）

`eng_design` 的节点合同明确禁止实现。即使未来收到 marker，也应由持有自己 TURN 的 implement node 执行；设计审查必须先完成。

### D. 自定义 owner + TURN marker（拒绝）

自描述 marker 能记录当前执行体，但任务要求的是“requested marker”。没有上游 literal 时自行发明格式会把本地日志误作传输回执，也不会满足 driver 的逐字判据。

## 设计边界

本设计证明当前 design node 的 TURN 接收、身份判断、审查流程与诚实的下游合同。它不证明 Claude native mailbox 投递，不修改 FLY-2127 产品代码，不创建 probe marker，不创建 PR，不请求 ship，也不部署。
