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
