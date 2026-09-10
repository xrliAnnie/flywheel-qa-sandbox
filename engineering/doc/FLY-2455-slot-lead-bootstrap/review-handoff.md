# FLY-2455 529 房启动诊断 — 实施计划
Issue: FLY-2455 (https://linear.app/geoforge3d/issue/FLY-2455/529-房台架-test-deploysh-起不来-529-slot-lead卡在-qa-launchd-topology-校验)
日期: 2026-09-08
基于: plan.md

## 已批准的设计与接续入口

第三轮有效 `reviewVerdict=APPROVED`，reviewer 原始 vote 同为 APPROVED。question `bdd61544-2b56-4257-8e1d-a8399854c530`，request `33c78f8a-aba4-42d7-a70d-f53079416d77`。评审对象为提交 `136794572` 的 plan.md；该文件在通过后未改变，SHA-256 `e77c5d19d3933fc2e6e96a0f6822762ffb82aa416813ec4322056ccff6df0df3`。

实现节点从 plan.md C1/C2 开始；本目录所有 C1–C5 checkbox 仍是未执行项，不可作为测试已绿的证据。先诊断、后安全台架实证与 root-cause.md、再增量设计评审的顺序，来自 Lead question `c80a599e-0a9f-464b-80fe-d85c2fa17c75`。真实根因、完整起拆、消息消费、exact-head CI 均待后续节点完成。本 design 没有创建或停止真实 slot，也没有改实现程序。

## 非阻塞建议，交 Lead 与实现节点处理

已通过 `ask --report` 报告全部 advisories；它们不是未解除的 HIGH，也不改变已批准的生命周期方案。

1. `multilead-contract-suite-unlisted`（MEDIUM）：`scripts/__tests__/test-deploy-multilead.test.sh` 是 `qa_multilead_claim_one` 的合同测试，已经在 CI 收集。实现 C2 时将其纳入扩展范围，在现有 H1/H2 旁加 `diagnostic-evidence-pending` 拒绝、锁保持、stale callback 未调用断言；不只依赖源码扫描。C5 本地补跑 `bash scripts/__tests__/test-deploy-multilead.test.sh`。
2. `borrowed-lock-release-site-unnamed`（LOW）：已核对 `scripts/lib/qa-multilead.sh:475-488` 的 `qa_multilead_release_borrowed_locks`，由 `test-teardown.sh:771` 调用。证据始终在 host slot runtime；这一调用本身放掉 borrowed 锁不会遗弃证据，所以无须给库函数增加另一份独立 residue 判据。按已批准 C2 的共用检查，在 owner teardown 调用处确认 host 证据处置/保留责任，维持 host lock 与 owner 元数据；不能放宽 plan 已要求的失败部署 campaign 锁保留，也不能扩写隔离单的进程清理算法。
3. `evidence-pending-marker-lacks-recovery-hint`（LOW）：主/extra 两处拒绝日志应点名 owner slot，并说明只有该次运行的 owner、且已有对应 Lead/recorder 停止证据，才能处置原始输出。拟输出的恢复调用为 `python3 scripts/lib/qa-lead-diagnostics.py discard --runtime <validated-runtime>`，路径经既定验证并按 shell 参数正确引用；随后由 owner 执行 `bash scripts/test-teardown.sh <owner-slot>`。这些是待实现 helper 的使用合同，目前不可拿示例直接操作真机；FLY-2454 隔离前置照常适用。无法确认停止或文件删除时保留 pending，交 Lead 指定处置责任，不提示手删锁绕过保护。

## 最终展示与限制

可批注报告： https://fw-reports-a53de2.vercel.app/r/7b7f776d0d6f6188d951189c862b6693/

HTML 内容与最后批准的方案一致，报告清楚写明尚未完成真机修复。批注逻辑、HTML/CSP 静态与托管验证见 validation.md。两张 Mermaid 图在本地标准参数各尝试两次均被 Chromium 权限拒绝，按注入合同保留 `DIAGRAM PENDING LOCAL RENDER` 提示与源文件；不把该限制冒充已完成视觉渲染。
