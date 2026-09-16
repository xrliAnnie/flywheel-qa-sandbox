# FLY-2608 Raya 线程双向对话 — 调研
Issue: FLY-2608 (https://linear.app/geoforge3d/issue/FLY-2608/raya工程修复-discord-thread-中的-founder-提问必须送达-raya并在原线程回复)
日期: 2026-09-15
基于: plan.md

## 设计阶段实际执行的验证
- 源码基线 557d2b00e；Bridge /health buildSha 同值。仅健康/身份观察，不代表会话验收。
- by-thread 查询两次401；跨 raya 受管快照 runner_snapshot_context_invalid；未借用Lead凭据、未复制live数据库。
- Lead问题 f65445d7-a479-4cd5-8a6c-5ae6c79a54ad 已答，定位两条源问题。补充精确登记/归档证据问题 ee3d76ac-8f88-40d9-aaf7-858808009f2c。
- HTML script 经 `node --check` 通过。Node VM DOM替身检查通过：单 nonce script、无外部资源/inline handler、pathname隔离存储、超长意见每段<=1800字符且都有精确marker、派生文字仅textContent/value、剪贴板缺失/拒绝均fallback、存储失败仍可汇总。
- 以上是静态与脚本控制器验证，不是浏览器视觉或真实CSP执行验证；发布后还需托管HTTP/CSP/source验证。
- 产品代码和生产运行未修改；没有执行受控提问、补投或回帖，QA矩阵均为下游要求。

## Mermaid 本地渲染失败
初次与一次标准参数重试均失败。命令：
```
mmdc -i engineering/doc/FLY-2608-raya-thread-replies/flow.mmd -o engineering/doc/FLY-2608-raya-thread-replies/flow.svg -w 1000 -b white --svgId FLY-2608-d1
```
两次关键错误均为 Chromium `MachPortRendezvousServer` / `bootstrap_check_in ... Permission denied (1100)`。无SVG产物；保留flow.mmd，HTML明确显示 `DIAGRAM PENDING LOCAL RENDER`。没有远程渲染或伪造图形。此为任务明确允许的本地渲染失败交付降级。
