# FLY-2696 人设投影 — 设计审查处置
Issue: FLY-2696 (https://linear.app/geoforge3d/issue/FLY-2696/raya-并仓s4-persona-投影p1人设留-raya-仓显式-opt-in-contract-启动屏障fail-open)
日期: 2026-09-17
基于: plan.md

R2 question: c8bb3a2f-55ae-4106-8965-d6b4eb073a43；request: 87415d51-084a-40ad-93d4-c1140d305411；effective reviewVerdict=CHANGES_REQUESTED。

| findingKey | 处置 | 位置与证据 |
|---|---|---|
| legacy-m0-without-window (HIGH) | 修复 | §4.2/§4.4 legacy-managed 不受 dormant S4 影响；adopted-legacy 在新围栏内签发而非伪造原迁移前的 fence。实读 updater :700–738、:994–1002，保留 FLY-2657 独立推进 |
| resume-ignored-on-loaded-thread | 修复 | §6 强制 cold daemon proof；stop 失败/PID 未换拒绝，T4 增负例；核对 FLY-2168 research 和 ensure_daemon 的 best-effort stop |
| private-repo-fetch-auth-unspecified | 修复 | §5 指定临时 gh token/header、Git config 隔离；T3 要求真实 authenticated exact-SHA fetch，不写生产 workspace |
| no-on-disk-target-fast-path | 修复 | §5 已验证 target 命中即零网络；T3 断言 fetch=0 |
| permanent-restart-dependencies | Follow-up，非阻断 | §4.5 明示 enrolled 启动可用性代价，dormant 无此依赖；不在本单新造长期授权记录。由 Lead 决定后续 |
| legacy-updater-second-writer | 修复 | §4.4 原锁内 ownership guard + 受权 handoff + A0 再冻结；不删除旧 M0 路径 |
| non-raya-blast-radius | 修复 | §3 按行隔离坏合同，§4.2 shell exact identity guard；T1 覆盖坏 Raya 配置下另 16 个完整启动 |
| projector-lock-handoff | 修复 | §5 锁只属 projector 生命周期，runtime 独立校验，不移交失效 PID/token |
| validation-doc-header | 修复 | validation.md 改为设计验证记录 |

上述为计划修订，尚无实现测试证据。提交后重新登记新审查，不把这份处置表当通过证明。

## R3 有效通过与收尾

- effective reviewVerdict=APPROVED；reviewerVerdict=APPROVED。
- requestId: 5cc6efab-1234-4b00-aacb-7d5947a323b9；questionId: 3b4cda52-3af0-498d-a193-a9615bd60234。
- reviewed head: 44a40cfa6；deliveryNonce: 164202d9-5b40-4232-8891-fbc19189ae51。
- HIGH legacy-m0-without-window 已关闭。

R3 四项边界文字收尾（未另开 R4，不冒称再次机器复核）：updater-guard-vs-fly2657-sequencing 按母方案 §9.4 优先移出 S4，独立 activation-prep 排在 2657 收口后；cold-proof-scope 明确仅 exact opted-in Raya 严格处理，proven-absent 合法，非 Raya full-access 原行为；enrollment-path-resolution 明确唯一 state root resolver + 跨语言 parity；enrollment-before-fence-gap 明确 enrollment 是连续窗口第一步并披露拒绝间隔。

permanent-restart-dependencies 保留 §4.5 Follow-up。所有 advisories 已通过 ask --report 交 Lead（报告 receipt 72463d7b-40e2-4049-8024-f7fb8f51a4ed）。未实施代码，未获取或使用任何生产激活授权。
