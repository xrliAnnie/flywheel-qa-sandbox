# FLY-2638 Discord 附件内容可达 — 审查交接
Issue: FLY-2638 (https://linear.app/geoforge3d/issue/FLY-2638/raya附件收件-discord-图片文本仅到达yuan数据lead-无法读取内容)
日期: 2026-09-18
基于: plan.md

后续 Lead 裁定见 design-correction.md：坏图加入最小 magic/header宽高守卫，不做next-turn health；其他两条保留Follow-up不开单。

R2 effective reviewVerdict=APPROVED；reviewerVerdict=APPROVED；request 3b87bf50-42a7-4c68-a8b8-2693b0c6c969；question 3b2d7921-f4bd-4286-92aa-582718f104f8；round=2；deliveryNonce=525dd0bd-5973-484b-8b55-47a7b22c1518。评审读取计划内容 commit 7d58acbe0；此后只更新批准状态与机械术语，没有重开架构。

| findingKey | severity | disposition |
|---|---|---|
| corrupt-image-thread-poisoning | MEDIUM | Follow-up 交 Lead。child 发送 image 后不能直接观察/重写下游解码失败，plan 的 invalid_content 期望不等于已有机制；实施不得声称该路径已实现。建议发送前结构完整性/像素上限校验，损坏图后下一回合健康检查，并让 Lead 决定恢复范围。 |
| codex-tool-output-truncation-txt | MEDIUM | Follow-up 交 Lead。32 KiB 编码可通过本地 frame limit，不证明 Codex 模型看到完整正文；建议真实 near-cap TXT 在末尾放随机标记，若截断需明确调整支持边界或方案，不能以部分内容冒充成功。 |
| acceptance-v2-vocabulary-residue | LOW | 已机械更正 E1/E5 为 carrier instanceDigest/代际，E8 删除文件落盘术语；无权限/接口变更。 |
| receipt-retention-misreported-as-scope-denied | LOW | Follow-up 交 Lead。本 Lead 的过期/DEAD回执也会scope_denied；工具描述应说明此限制或后续细化已验证自身回执的expired reason。不得为改善文案扩大其他Lead探测。 |

非阻塞意见不冒充已修复；effective APPROVED 允许设计交接。原 E1–E8 的真实内容可读/失败边界验收不因本次批准而缩减。实现/QA遇到上述风险导致验收不通过时必须如实记录并修复/报Lead，不能用设计批准替代通过。

外部 Claude 插件传附件ID、提高5MiB上限仍是此前声明的非阻塞Follow-ups；本单不写插件缓存或Raya persona。


## Re-dispatch review (current execution)
Question ff755f51-d740-4792-855d-91d88d85307b; request 652bc294-46ab-4af4-bd7b-efe8b8e1a050; effective reviewVerdict=APPROVED / reviewerVerdict=APPROVED. All seven findings are non-blocking advisories. Per Lead design-handoff-only ruling, preserve approved plan and appendix; record these for Lead/implementation disposition without reopening design or implementing changes.

| findingKey | Severity | Advisory / disposition |
|---|---|---|
| codex-rollout-persists-attachment-content | MEDIUM | Reviewer reports Codex session rollouts can retain image/text tool results. “No copies/cache” should be scoped to Flywheel-owned attachment storage, not a claim of zero host/session persistence. Lead follow-up; no new retention system authorized. |
| codex-tool-output-truncation-txt | MEDIUM | Repeats existing TXT budget advisory: model consumption near 32 KiB needs tail-marker evidence or a justified bound. Existing Lead follow-up disposition remains; no silent claim of full-content delivery. |
| near-cap-image-missing-from-live-acceptance | MEDIUM | Plan §2 already requires a near-cap real screenshot; reviewer recommends explicit E1/E7 evidence and an ordinary subsequent turn, plus an isolated early MCP image spike. Relay to Lead/implementation; do not invent a next-turn-health subsystem or send live tests independently. |
| mcp-structured-content-drops-image | MEDIUM | Reviewer reports Codex prefers structuredContent over content; recommends omitting structuredContent/outputSchema and asserting their absence for this image/text tool. WIP reportedly already omits them. Lead/implementation follow-up, not verified by this design node. |
| animated-webp-not-rejected | LOW | Suggest rejecting VP8X animation flag, optionally APNG, within the existing minimal header guard. Advisory only; no expanded decoder implementation here. |
| attachment-context-must-not-fail-server-startup | LOW | Missing attachment context during mixed-version startup should disable only this tool, preserving send/ack. Reviewer reports WIP config is optional already; implementation should verify targeted startup behavior. |
| review-targeted-tests-not-executed | LOW | Reviewer could not run Vitest because node_modules/vitest config dependency was unavailable; performed source/design review only. This approval is not A/B/C test or live acceptance evidence. |

No HIGH findings, no blocking changes requested. Review observed only docs/progress/HTML commits after inherited 9a4912dc0; plan.md and design-correction.md remained unchanged.

## Implementation code review R1

Question `57f07f7c-077d-49fb-a9a9-bc8f6e9ac9e7`; request `352308aa-3d27-45cc-b203-fa20c4e43e9f`; reviewer session `6ec84746-c0f3-4f64-b56f-bade80e8d08b`; frozen head `f071a846d4410f2f276c8821d0b5d00e87f43aa9`. Effective `reviewVerdict=CHANGES_REQUESTED` / `reviewerVerdict=CHANGES_REQUESTED`.

| findingKey | Severity | Resolution |
|---|---|---|
| raya-cos-role-excluded | HIGH | `428a50857` 让 canonical v1 predicate 接受 `dept` 与生产 Raya 的 `cos` role，同时保留 Bridge、Codex app-server、full-access、bundle 字段缺省、identity digest 和 carrier/receipt 约束；加入 production-shaped Raya fixture。 |
| per-chunk-sync-revalidation-cost | MEDIUM | 将同步 registry / carrier / receipt 复核放在 metadata fetch 与 CDN body 完成边界，不再逐 chunk 重读；64 个单字节 chunk 的回归测试把复核次数约束在 6 次以内。 |
| express-text-plain-charset-rewrite | MEDIUM | MCP reader 将裸 `text/plain` 与允许的 UTF-8 charset 规范化到同一 canonical MIME；新增真实 Express router → MCP reader 测试，证明正文可读。 |
| empty-projects-file-env-startup-throw | LOW | 可选 `projectsFile` 先 trim，空值视为缺省，padding 后再与 canonical context 比较；两种启动 fixture 均保留 canonical projects path。 |

四项都在批准方案既有 predicate、读取边界和 fail-closed 合同内修正，没有新增 role、transport、凭据或生产动作。R1 修正后定向回归为 7 files / 92 tests；最终完整相关面重跑见 acceptance.md。新的 literal-last head 必须重新走独立 code review，R1 不批准后续提交。
