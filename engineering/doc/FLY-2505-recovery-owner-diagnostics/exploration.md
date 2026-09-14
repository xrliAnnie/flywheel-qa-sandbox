# FLY-2505 恢复失败留因与分类重试 — 探索
Issue: FLY-2505 (https://linear.app/geoforge3d/issue/FLY-2505/病根-重启后-reown-的-recovery-owner-在-commit-前失败且不留原因resulttext-空-只剩通用文案两次即)
日期: 2026-09-10
基于: 无

## 目标与事实边界

让重启后的认回负责人（recovery owner：接手原 execution/thread 的常驻执行器）在提交接管前失败时留下可分类、可追溯的原因；确定的启动准备瞬态不消耗两次失败预算。保留原任务、线程、TURN 和权限的所有校验。设计节点只提交文档，运行修复与真机验收由后续节点完成。

基线 `d964e9fca` 已包含 #1128 (`92532e22a`) 与 FLY-2456 演练工具 (`977660ab3`)。

- 注入 issue 记录 R2 B1 `3835df15` 在 17:40:10Z / 17:45:10Z 两次返回通用原因；`capabilityDriftEvents=0`。
- 仓库 FLY-2456 `host-runs/driver/FINDINGS.md` F4/F5：R1 B2 曾观测启动快照不匹配；R2 日志丢失，不能据此认定 R2 仍是同一个底层错误。
- 同文件区分了真实替身体与 `failed_exhausted_no_replacement`。本设计不得将所有失败概括为已经换体。
- 源码确认 `CodexTmuxAdapter.executeOwned` 计算了 `cls.failureReason` 但仅写 stderr；`resultText` 只复制 `cls.resultText`。reown 只读 `resultText ?? generic`，既忽略 `failure.failureReason`，也没有空白字符串归一化。
- `runCodexRecoveryOwner` 在提交前不发送终态，这是正确边界，必须保留。

## 方案比较

| 方案 | 得益 | 代价 / 决定 |
|---|---|---|
| 只补 resultText | 最小化补上已有错误文字 | 无稳定分类、无瞬态预算区别；不能满足任务 |
| 字符串匹配“socket / timeout”即无限免计数 | 修改少 | 会把权限、路径或未知错误误当瞬态，永久重试；拒绝 |
| 结构化错误 + 原子结算 + 独立启动序号 | 留因、分类、避免预算/凭据冲突 | 涉及 core/runner/StateStore/reown 接缝；选用 |
| 直接放宽快照一致性 | 可能绕过 R1 表象 | 未证实 R2 根因且削弱不可变权限合同；拒绝 |

## 设计决策

1. 错误类别在产生点确定；已有 `TerminalFailureInfo` 的 quota/blocked 语义保持独立，恢复诊断为 additive 字段。
2. 只有 daemon 创建/连接准备阶段的已知 readiness 错误，且本轮已确认无残留进程，才退回暂占的失败额度。未知错误、权限拒绝、快照不一致、排空失败均不可获免计。
3. 两次 chargeable failures 保留；每次 reservation 的单调序号不可回退，用作凭据轮换、事件和迟到回调身份。
4. 另设持久化 readiness 重试上限与时间边界；不得依赖内存计数或 Bridge 重启重置。
5. 必须把最后一条结构化失败及其身份带到 exhausted 终态，不能再被通用终态文字覆盖。
6. 复现证据若显示其他实质性根因，记录 `root-cause.md` 并增量评审修复；仅日志变清晰不等于同体恢复已验收。

## 向 Lead 提出的非阻塞问题

`0eee842b-eb25-429d-8c67-293e0aa629e2`：拟采用 3 次 readiness 失败 / 15 分钟的独立上限，到界用明确的 readiness_retry_exhausted 走已有失败收口；请指出是否应改为人工介入。继续审计，不将等待当阻塞。

## 交付与验收

交付 research.md、plan.md、Mermaid 源图、最终可评论 HTML、评审回执和 progress.md。设计门通过后发布 HTML，再报 Lead 并走 phase_design_complete/park。源文件、运行服务、slot 和后继调度均不在本节点修改范围。
