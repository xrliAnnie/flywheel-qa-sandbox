# FLY-2799 设计评审与实施交接 — 实施计划
Issue: FLY-2799 (https://linear.app/geoforge3d/issue/FLY-2799/语音v5-引擎-bcodex-语音容器-每次开一个新-codex-实时语音-session装进当前-lead-的-memory)
日期: 2026-09-23
基于: plan.md

## 有效设计结论：APPROVED

R2 question `188d04c6-1f0f-46a0-808c-9fdf2043b4f2`，request `8627c264-3e69-4f55-bf40-8013bc12656b`；`reviewVerdict=APPROVED`，`reviewerVerdict=APPROVED`。完整结构化结果保存在 `evidence/design-review-r2.json`。评审对象是 `91b5a2367` 的 plan.md；此后未修改该计划正文，保留其原评审修订轨迹。计划开头的“待重新评审”是送审时状态，以本回执为有效结论。

R1 两项 HIGH 与四项建议的逐条修正见 plan.md §9；R2 没有阻塞项。以下两项为非阻塞实施 Follow-ups，随正式报告交给 Lead 决定落实安排；不以它们重开设计或额外派单。

## Follow-ups

| findingKey | 实施交接内容 | 验证要求 |
|---|---|---|
| utterance-endpoint-lands-in-wrong-route-module | `/:sessionId/utterances` 实际应落 `packages/teamlead/src/bridge/voice-session-routes.ts`，复用 `voiceSessionAuthMiddleware`、masterOnly 与有效 lease 校验。计划清单写的扁平 `voice-routes.ts` 不是这一 URL 的挂载模块；不要把 session 路径接到其 apiToken 缺省可放行的挂载面 | 补 apiToken 未配置、ingest/不相关 token、过期/错误 lease、跨 session 的拒绝测试。补 T2/T6 文件清单的实际路由落点 |
| new-voice-tables-not-in-retention-registry | 新 `voice_utterances` / `voice_handoffs` 当前不在 `RETENTION_TARGET_POLICIES`，不能沿用计划“按现有保留机制”一句就宣称覆盖。需要明确登记策略或具名后续保留工作；由 Lead 安排责任。保护所有未决 handoff 引用的原话与对账证据 | `ambiguous` / `needs_human` 不按普通超时删除；仅考虑超期且已证明 committed/rejected 的动作，原话清理还须会话终态、时间窗及无未决引用。具体保留时长和迁移由实施责任方明确，不能擅自写生产清理任务 |

这两项不改变 `reviewVerdict=APPROVED`，也不代表本轮已经实现修复。G1/G2 继续是未关闭的集成准入依赖；真实双人格房间 QA、生产切换与所有代码实施仍未执行。

## Founder HTML

正式待发布文件为 `founder-design.html`，三个本机渲染 SVG 已逐项核对与 Mermaid 源相符（`evidence/diagram-handoff.json`），没有外部资源或空图占位。发布器本地预检、评论分段与复制降级脚本检查通过；未做浏览器 QA。`founder-design-cdn-draft.html` 是被拒路径的历史草稿，不能发布。
