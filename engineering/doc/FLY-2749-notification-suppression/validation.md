# FLY-2749 纯通知停止唤醒 — 调研
Issue: FLY-2749 (https://linear.app/geoforge3d/issue/FLY-2749/额度lead-成本-lead-会话占-fable-额度-92percent每个小事件都唤醒-lead每轮重读-50-60-万-token)
日期: 2026-09-18
基于: plan.md

## 已完成的设计验证
- 生产只读flag和event-disposition聚合，句柄均已关闭；没有生产写入或数据库拷贝。
- 46个JSONL文件冻结prefix长度与SHA256；同baseline manifest重放输出逐字节一致。全模型与Fable子集同源，message.id/requestId两种去重交叉核对一致。范围Sep17 00Z–Sep19 00Z，capture Sep18 21:38:41Z，Sep18明确partial。
- 测量器研究fixture验证：工具往返属于原turn，工具结果不增加外部turn；UUID去重；compaction摘要排除；重复usage、invalid JSON、partial tail、append后重放、prefix变化拒绝。实际生产证据错误/冲突计数见baseline。
- HTML结构/控制器：9 section均有评论，pathname隔离存储；localStorage抛错安全；长评论每段≤1800字符且首行marker准确；clipboard缺失和promise rejection都走execCommand fallback；派生文本不解释成markup。`evidence/html-verification.json`记录PASS。
- 两张Mermaid都本地运行并标准参数重试一次，均被macOS MachPortRendezvousServer bootstrap_check_in permission denied(1100)阻止。保留.mmd和错误logs；HTML显示DIAGRAM PENDING LOCAL RENDER。无远程render、无CSS伪图。

## 不能扩大声称的证据
控制器验证使用happy-dom，不是实际浏览器视觉/CSP执行验证。没有生产过滤实现、没有真机延迟探针、没有上线后24h下降证据。有效review与托管HTTP/CSP验证在完成后单独存receipt。

## 重放命令
```
python3 engineering/doc/FLY-2749-notification-suppression/measure-usage.py --manifest engineering/doc/FLY-2749-notification-suppression/evidence/baseline-usage.json --out /tmp/fly2749-replay.json
cmp engineering/doc/FLY-2749-notification-suppression/evidence/baseline-usage.json /tmp/fly2749-replay.json
node engineering/doc/FLY-2749-notification-suppression/verify-founder-html.mjs
```

## 接续核验（2026-09-18）
- 取回备份 `origin/backup/FLY-2749-wip-stash-20260918@9dd592a4b`：保留 monitoringByDay 统计扩展、routing-followup.json 与历史 review-wait.json；合并 HTML 术语解释。历史 wait 收据已被 review-receipt.json 的有效 APPROVED 替代。
- 原 baseline manifest 再次逐字节重放一致，SHA256：`392c744684d28bb11fecaf2c243384ca244664608af67c94450732aa2fc0f36b`。
- 9 个 section 的评论、长文本分块、剪贴板两种失败回退、存储失败安全定向检查再次 PASS；审计脚本语法检查 PASS。
- 评审通过并报告 11 条非阻断建议，逐项见 review-followups.md；没有声称建议已修复。

## 发布未完成
- 2026-09-18 接续发布与一次重试均返回 502 `report publishing failed`，url/reportId 为 null；收据见 evidence/publication-status.json。没有托管 HTTP/CSP 验证。
- Chrome DevTools list_pages 未返回，终止等待；不声称浏览器验证通过。
- 设计完成命令和 park 均未执行；等待托管恢复或 Lead 明确处置，目标仍保持 active。

## 交接门禁处置
Lead 已明确豁免本次交接前托管成功要求，准许记录 DESIGN-HTML publish-failed 后 phase_design_complete + park。见 handoff.md 与 evidence/lead-closeout-decisions.json。托管/浏览器验证仍未完成；此处仅记录交接授权，不改写验证结论。

## 实现阶段证据（2026-09-18）
- 代码根因修复沿用同一个 `lead_token_savings` 和 `audit_only`：可信普通阶段、已有 owner 的 review/PR 阶段、已注册 session start、REVIEW gate，以及具备 exact completion declaration 的 runner-stop `done` 不再进入 Lead model adapter。flag OFF/读取失败、非 REVIEW gate、普通 ASK、blocked stop、`session_failed` 和未知证据维持原 model 路径。
- CommDB canonical row 新增 additive notification decision 字段；旧行 migration 默认 `delivery_disposition='model'`。owner-fenced reclassification 仅发生在 adapter handoff 前，fresh mixed batch 中 quiet member 被移出而 urgent member照常投递。REVIEW row 保持 pending/answerable，reviewer response 后才终态化；抑制本身不写 response 或 `report_ack`。
- consumer sweep：两个 Lead claim 入口、queue head/window、in-flight limit 与 deliverable count 都过滤 `audit_only`；runner/bridge lane 不受影响。权威 pending-question projection仍保留 REVIEW，避免静默等于回答。schema/query-plan/混合批次的定向测试覆盖这些边界。
- 没有新建 notification relay。实现复用既有 lifecycle/disposition receipt 责任边界；`review-followups.md` 的 11 条 advisory 全部保留给 PR Follow-ups，未把未实施项写成已解决。

定向验证（代码头 `5adf49018`；后续仅允许文档、milestone 与 review 修订头时须重新核对）：
```
VITEST_MAX_FORKS=1 pnpm --filter flywheel-comm exec vitest run \
  src/__tests__/mailbox-queue.test.ts \
  src/__tests__/mailbox-queue-schema.test.ts \
  src/__tests__/mailbox-query-plans.fly2008.test.ts
# 3 files, 45 tests PASS

VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/EventFilter.test.ts \
  src/bridge/__tests__/question-admission.test.ts \
  src/bridge/__tests__/lead-inbox-loop.test.ts \
  src/bridge/__tests__/bootstrap-route.test.ts
# 4 files, 94 tests PASS

VITEST_MAX_FORKS=1 pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/event-route.test.ts \
  src/__tests__/gate-poller.test.ts \
  src/bridge/__tests__/lead-inbox-runtime.test.ts
# 3 files, 178 tests PASS
```
测试前按 locked workspace 依赖顺序构建了 config、core、agent-team-transport、token-usage、claude-runner、三个 event transport、edge-worker、voice-core 与 flywheel-comm。第一次 collection 失败均为 sibling `dist` 尚不存在，构建后相同命令通过；不是 assertion failure。

统计重放：
```
python3 engineering/doc/FLY-2749-notification-suppression/measure-usage.py \
  --manifest engineering/doc/FLY-2749-notification-suppression/evidence/baseline-usage.json \
  --out /tmp/fly2749-baseline-replay.json
cmp engineering/doc/FLY-2749-notification-suppression/evidence/baseline-usage.json \
  /tmp/fly2749-baseline-replay.json
# PASS, byte-identical
```
2026-09-19T05:02:16Z 的只读 live census 再确认生产 `lead_token_savings` effective=true，但生产 CommDB 尚无本分支新增 disposition columns；因此这是部署前证据。实现节点不部署、不发真机 founder/ASK/failure probe，也不伪造上线后连续 24h 输出。相同脚本的部署后 24h 对比、四类紧急事件时间戳、两 vendor model-call=0 与真实 receipt 联结由冻结 head 的 QA/上线后观察完成。

按 Lead handoff，未运行 `pnpm test:packages:run` 或全量 test suite；不能把上述定向绿色表述为 aggregate CI 或生产验收。
