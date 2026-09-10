# FLY-2389 私有下载与保留期 — 调研
Issue: FLY-2389 (https://linear.app/geoforge3d/issue/FLY-2389/1143b2-r2-payload-托管-端点私有-bucket-验-key-薄端点entitlement-分级-presigned-get)
日期: 2026-09-09
基于: plan.md

## 设计阶段完成审计

| 要求 | 当前可核证据 |
|---|---|
| onboarding / TURN / DOC-FLOW | 已读项目材料；TURN design epoch=1；文件均在复用规则确认后创建的本目录；progress 到交接前同步 |
| 探索、调研、实施计划 | exploration.md / research.md / plan.md，均有指定标题、Issue、日期、基于行；实现代码零改动 |
| 私有 R2 / entitlement / license issue-verify-revoke | plan §2–4、§6；消费者实核补充在 review-advisories.md；secret 注入与负向权限明示 |
| current 不按年龄过期 / supersede 14/28 天 / lifecycle | plan §5；唯一 manifest 时钟 + CAS 删除屏障自动清理，经 Lead 确认，不迁 key、不对完整对象设 native TTL |
| 通道唯一真相 / REQ-0 / 非目标 | plan §1–2、§6、§9；保留 B0/B1 tuple、独立 ship/release，不做 billing/accounts/seats/metering/B4/B5 |
| B1 联合验收 | plan §8，区分现有基线、确定性夹具、跨 origin HTTP、隔离真实 R2 + hash；实际新增实现/QA 尚未执行 |
| 有效审核 APPROVED | question 24197080-096a-4965-a57f-645a6fdd84f1；request 378ae9e4-5e7e-4160-8e11-2332862d8e84；R1 两个 verdict 均 APPROVED；10 项非阻塞建议已报 Lead，未伪装为已解决 |
| 批准内容绑定 | plan blob 94accef02c6b80f663285c8b0a620b09f78766f4；审核后未改 plan 字节；review-advisories.md 补足遗漏直接调用点并保存完整建议 keys |
| founder HTML | founder-design.html：摘要、流程源/合规占位、数据模型、取舍与边界、8 个评论框、单 nonce 脚本、pathname 隔离保存、分段 marker 与复制 fallback |
| 图与视觉验证诚实性 | 两个 .mmd 均两次本地 mmdc 失败，按任务 h 明示 DIAGRAM PENDING LOCAL RENDER；浏览器工具被 approval policy=never 拒绝；没有声称成功渲染或截图 QA |
| 页面验证 | validation.md 记录静态/Node DOM 模拟；已托管 HTTP/CSP 检查见下；不将 DOM 模拟等同浏览器实际运行 |
| commit / push / progress | 所有设计与审核记录已在 flywheel-FLY-2389 推送；当前 closeout/progress 最后一批提交后才发 completion |
| 角色学习收尾 | 按允许的更新途径保存 3 项 durable judgments 到 native memory extension `2026-09-10T05-45-25Z-fly2389-payload-boundaries.md`；未编辑 shared runner-memory；索引实测 58 行/14130 bytes，未超预算 |

## 托管与报告收据

- 发布命令：`node "$FLYWHEEL_COMM_CLI" publish-report --html engineering/doc/FLY-2389-payload-access-lifecycle/founder-design.html --project flywheel --publish-only`。
- reportId：`c8fdce3533dab9c3b7e645d58214b893`，publishOnly=true，messageId=null，未发频道消息。
- 页面：[FLY-2389 私有下载与保留期](https://fw-reports-a53de2.vercel.app/r/c8fdce3533dab9c3b7e645d58214b893/)。
- 真实 GET：HTTP 200；16516 bytes；nonce placeholder 剩余 0；1 个 script nonce 与注入 CSP 的 nonce 匹配；8 个评论输入；图占位明确保留。
- 托管 HTML SHA-256：`50960408dc9d1f5a090ea56b51a6d2931c2a96cafce60aa5dd4d9251ed074e6f`。托管注入 nonce/CSP 后的摘要与仓库 HTML 摘要不同是预期。
- DESIGN-HTML ready 报给实际 Lead 的 report question：`56278e39-a1f1-4be6-8dd3-f14976fa5e56`。
- 自包含 DONE/限制/角色学习报告：`27f15f35-f45d-4417-8f60-8a22a898c67e`。

下一动作是 `complete --route phase_design_complete`，其成功与是否需要 drain receipt 以 comm/控制器的真实返回为准；本文不预先捏造 completion 成功。成功后 park，阶段边界不结束整个 issue 的 resident goal，不自行启动 implement/QA。
