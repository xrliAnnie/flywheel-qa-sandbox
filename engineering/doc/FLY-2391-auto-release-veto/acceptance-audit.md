# FLY-2391 自动发布 — 实施验收核对
Issue: FLY-2391 (https://linear.app/geoforge3d/issue/FLY-2391/1143b4-auto-ship-on-silenceopt-out-fail-closed-状态机-否决窗口绑不可变候选delivery)
日期: 2026-09-15
基于: plan.md、implementation.md、runbook.md

## 范围与证据口径

核对依据为 PRD §5.1–5.5/§6.2 和批准计划 I1–I6、T01–T20、交错矩阵。本单实现对外发布，不改 merge/ship 授权。下表的实现与可执行证据不等于真实环境 A0–A7 已通过；生产 flag 未打开，QA 未由 implement 派发。

## 功能核对

| 要求 | 当前实现与关键证明 | 状态 |
|---|---|---|
| §5.1 green 到期且无 veto 才默认发布 | advance 请求准备/执行；store/decisions 在实际 ready attempt 时同步重查；deadline 前、hold/unknown、未启用零 permit | 源代码与 notice/decisions/advance/runtime 测试具备；全功能套件先前 393/393 |
| §5.2 同周一次窗口、固定候选 | project/week UNIQUE、write-once binding/deadline、一次发送意图；新 beta 不替换当周候选；错过 slot 的 no_candidate/unknown 耐久留账 | store/scheduler/notice/advance 测试及跨进程 reservation root 测试 |
| §5.2 新负面证据取消后不可复活 | B3 源写点同一 SQLite 事务记录失效并锁住周期；来源恢复不清 latch；重启/clock 回退/tick gap 取消未 claim 周期 | invalidation 测试含 source+cancel 回滚、瞬时故障后恢复、deployment 切换 |
| §5.2 delivery receipt 后才算沉默 | 固定 Discord app/bot/channel/founder、内容摘要、权限探测和 Gateway 健康；POST 模糊只恢复同消息，晚到不足窗口拒绝 | delivery/discord/access/actions/notice 测试含二次 POST 为零、变更/删消息/不新鲜拒绝 |
| §5.2 身份校验、耐久、幂等 veto/go | canonical founder 与冻结候选验证；动作和状态同事务，落盘在 ACK 前；claim 后只记录 intervention，不说已拦下 | interaction-gateway/actions/notice/controls 测试；T08、T20 |
| §5.2 hold/unknown 后人工 go 仅覆盖 readiness | 独立 prepare/rebind/new releaseId/new go；manual claim 仍检查 reviewed code、artifact/hash、beta 活性、来源、CAS 等技术门 | decisions T18 及 manual preparation/intake/executor 测试；手动 workflow 隔离 root 测试 |
| §5.3 早上到下午可配窗口 | timezone/weekday/notice/deadline/claim cutoff/minimum window 配置；不补开短窗口 | config/policy/scheduler/notice 测试；日报显示 UTC 截止和候选卡否决提示 |
| §6.2 窗口前实际 clean artifact 绑定 | 冻结 beta 后 prepare、等价验证、immutable 上传/完整读取 SHA；窗口绑定最终 release hash；执行阶段零重建 | source/advance/notice 测试；payload prepare/rebind/auto-release 与 shell pipeline |
| claim、CAS、unknown、fence 安全性 | decision 唯一、短 permit、原 nonce/epoch/audience/ETag；started 唯一；失联/过期不当 no_write；exact fence 关闭未决 | decisions/executor/fence 测试；endpoint 211/211；CAS/重放 shell pipeline 44/44 |
| §5.4 who/when/trigger 与三本账 | 原 source 事件、冻结投影内容/实际摘要回读、同 marker 恢复；activation 固定现有两条目标；与 PR approval API 分离 | accounting/pump/transport 测试；此次核对补齐人工 decision fullBinding/ETag/manifest digest，以及 enable/disable actor |
| 记账失败不改发布事实、不重发 commit | 独立后台投影，create intent 在网络前；回包丢失先查回，更新后独立读；待补队列按 retry_at 保证公平 | transport 丢失 create 回包仅一次 POST、错误 readback 留 pending、后台网络不阻塞 supervisor 测试 |
| 日报只读、不能重开周期 | deferred read transaction；未捕获投影也计 pending；不增加 deployment 计数；无候选/unknown 周显示未发布原因 | report/digest 36/36；此次修正后审计/报告相关 24/24 |
| §5.5 最后灰度 | 默认 flag false；真实 A0–A5 bundle 身份/哈希/期限校验；canonical founder 新 enable 收据独立于 PR/design/ship | activation/evidence/authority/controls/host 测试；真实 A0–A7 留给受权部署/QA，不在本节点执行 |
| 迁移、保留与回退 | additive 表/重复迁移；protectedAuthority 登记；关闭新 claim 后保留原 unresolved 恢复；endpoint strict policy 保持 | migration/retention 与 runbook；未设置 active R2 age-only cleanup |

本次核对确认并修正了两个审计数据缺口：人工 go 的新 artifact 不应被原周期 binding 遮住；activation enable/disable 的 actor 不应只剩 payload 摘要。新回归先红后绿。未把这些旧的缺失字段描述成先前已满足。

## 视觉检查的明确交接缺口

- 当前生成器：`engineering/doc/FLY-2391-auto-release-veto/render-fixture.ts`。
- 在本工作树根目录生成：`pnpm --filter flywheel-teamlead exec tsx "$PWD/engineering/doc/FLY-2391-auto-release-veto/render-fixture.ts"`。
- 静态 HTML：`/private/tmp/fly2391-visual/digest.html`，带“本地测试夹具 · 非发布收据”标记；包含窗口开启、未确认提交、人工验收取消和无候选 unknown 周。
- 原生 Chrome DevTools list_pages 最终报 tools/call 300s 超时；隔离 Chrome CLI exit 134；安装的 Playwright Chromium 因 macOS `bootstrap_check_in ... Permission denied (1100)` SIGTRAP 退出。未生成 screenshot，视觉检查没有通过；没有重启浏览器/Bridge 服务或改 sandbox 权限。
- Lead question `9f4b7d7a-f616-4aba-b62b-1bd1fcdbd4ed` 明确答复没有授权 Codex-native 端点，要求停止追查、如实交接给 QA（Claude、unsandboxed host）打开验证。Implement 不派发 QA，也不把 markup assertions 当成浏览器证明。

## 尚待正式交付的门禁

最终 package gate、有效 code-review verdict、最终 head CI、milestone 最后一提交、非 draft PR、needs_review 结构化回执仍须实际获得。当前验收只支持“实现已进入最终验证”，不支持“已批准上线”。全部 receipt 的 SHA/执行结果以 implementation.md 与最终交接为准。
