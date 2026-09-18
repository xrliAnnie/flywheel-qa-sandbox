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
