# FLY-3125 原生传输探针 — 探索
Issue: FLY-3125 (https://linear.app/geoforge3d/issue/FLY-3125/529-canary-fly2127-canary-23c3c581-a0f6-45a5-af84-804d707f1ed5-native)
日期: 2026-10-01
基于: 无

## 一句话结论

本 design node 记录当前 Codex execution 的真实 TURN，并为精确 marker 追加定义来源可审计的合同；它不会把另一条 native canary execution 的历史 marker 冒充为本 execution 新收到的指令。

## 已确认事实

- 当前 execution 是 `551042d5-fe33-493d-b344-602864297c35`，`flywheel-comm turn` 返回 `yours phase=design epoch=1`。
- 当前 activation 是 `activation:551042d5-fe33-493d-b344-602864297c35:271654a5-6362-471e-bed5-f47c3ee7c486:eng_design:1`。
- onboarding 时 runner mailbox 返回 `No instructions.`；当前 user turn 没有给出 `Append the exact line … to probe.txt` 形式的 literal。
- 当前分支起点与 `origin/main` 相同，root `probe.txt` 不存在，也没有既有 `FLY-3125-*` doc folder。
- FLY-2127 driver source 定义 native fixture 的 boot marker 为 `${owner.marker}-native-BOOT`，但该 literal 属于 driver 创建的 execution，不等价于本 design execution 收到 native mail。
- FLY-2127 已有 QA evidence 显示另一条 execution `dfea80f2-03f5-4950-9b7d-902b7a927669` 完成了 FLY-3125 native fixture；当前 execution 的身份不同。

## 成功标准

1. 产出 `exploration.md`、`research.md`、`plan.md`、Founder HTML、两份 Mermaid source/render 与 restart-resilient `progress.md`。
2. 取得有效 `APPROVED` design-review verdict，并提交、推送 design artifacts。
3. 发布并结构化报告 Founder HTML。
4. 对 `probe.txt` 只做有来源证据的 bounded append：TURN 证明谁可写，当前 execution 的明确 input 决定写哪些字节。
5. 不修改产品代码，不创建 PR，不请求 ship，不 merge、deploy 或派发后继节点。

## 方案比较

### A. TURN receipt + 当前 execution 的 exact input（采用）

Design 记录真实 TURN；只有当前 execution 收到明确 marker literal 时才追加。优点是 provenance（来源证据）完整、不会制造 canary 假阳性；代价是 exact input 未送达时 `probe.txt` 保持不存在。

### B. 从 owner 与 driver 模板推导 `${owner}-native-BOOT`（待 Lead 明确授权）

该 literal 与 driver 预期一致，也能形成 bounded local commit。但它证明的是“按模板重建 marker”，不是“本 execution 收到 native mail”。只有 Lead 明确要求当前 design execution 重放该 literal 时才安全。

### C. 自定义 owner/TURN 诊断行（拒绝）

自描述行可以记录本地事实，但不是 requested marker，会把设计节点日志冒充上游传输内容。TURN receipt 已经由 `flywheel-comm turn` 原生提供，无需再造一条近似证据。

## 诚实边界

本设计证明当前 design execution 的身份、TURN、审查与报告流程。它不证明本 execution 收到 native mailbox marker，不重新实现 FLY-2127，不创建 PR，也不进行 ship、merge 或 deploy。
