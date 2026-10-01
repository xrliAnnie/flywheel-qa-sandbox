# FLY-3124 Claude 传输探针 — 探索
Issue: FLY-3124 (https://linear.app/geoforge3d/issue/FLY-3124/529-canary-fly2127-canary-606b50d9-b7a4-44bf-b80b-6e932dd2421c-claude)
日期: 2026-10-01
基于: 无

## 一句话结论

本 design node 证明当前 Codex execution 已取得 server-authorized TURN，并为后续 exact-marker 追加定义可审计合同；它不在缺少明确 marker literal 时创建 `probe.txt`，也不把属于另一条 Claude execution 的 marker 冒充成本 execution 的回执。

## 已确认事实

- `flywheel-comm turn` 返回 `yours phase=design epoch=1 node=eng_design attempt=1`，execution 是 `28d5173f-35a0-4e4f-a7b5-28454f97c122`，activation 是 `activation:28d5173f-35a0-4e4f-a7b5-28454f97c122:92fd90c9-4c18-4de8-9b49-4d37c8f5efe8:eng_design:1`。
- 当前 runtime vendor 是 `codex`；issue title 末尾的 `claude` 是 canary case 标签，不是当前执行体身份。
- 当前 user-turn 没有 `[lead-instruction <id>]` 或 exact marker literal；onboarding mailbox 检查返回 `No instructions.`。
- root `probe.txt` 不存在，初始分支与 `origin/main` 同 head。
- 外部 FLY-2127 driver 的 `CLAUDE-BOOT` 与 `R4-CLAUDE` literals 绑定 driver 自己创建的 `claude-code` execution，不能跨 execution 复用。
- Lead 已通过问题 `05d33699-e084-4c26-84f1-f24b6093888b` 确认条件式合同：design 只记录 TURN、不猜 marker、不改 root `probe.txt`；只有后续实际收到 native exact marker literal 的 execution 才可按原字节本地追加；本 bounded canary 不做 PR、ship 或 deploy。

## 成功标准

1. Design phase 产出 `exploration.md`、`research.md`、`plan.md`、Founder HTML、Mermaid sources 与 `progress.md`，并取得 effective `APPROVED` design-review verdict。
2. 当前 design node 以 TURN receipt 完成题目要求的 “acknowledge native mail or TURN”；没有 native marker input 时不声称收到 marker。
3. 只有实际收到明确 literal 的 downstream execution 才能在自己的 TURN 下逐字追加 `probe.txt` 并本地提交。
4. 不修改产品代码，不创建 PR，不请求 ship，不 merge 或 deploy，也不派发后继节点。

## 方案比较

### A. TURN receipt + 条件式 exact marker（采用）

Design 记录真实 TURN，并把 append 约束为“当前写入 execution 收到明确 literal”。优点是 provenance（来源证据）完整，不会制造 canary 假阳性；代价是 marker 未送达时 `probe.txt` 保持不存在。

### B. 从 owner 或外部 driver 推导 marker（拒绝）

Owner nonce 只标识演练，外部 driver literal 则证明另一个 execution 的启动或 native mailbox 收件。复制它们会绕过真实传输，破坏 canary 的判据。

### C. Design node 自定义一行 owner/TURN marker（拒绝）

自描述 marker 能记录本地事实，但不是“requested marker”。它会把设计节点的日志当成上游请求内容，并越过 design-only phase 边界。

## 诚实边界

本设计证明当前 design execution 的身份、TURN 与审查流程。它不证明 Claude native teammate-message 已投递，不修改 FLY-2127 产品代码，不创建 probe marker，也不进行 PR、ship 或 deploy。
